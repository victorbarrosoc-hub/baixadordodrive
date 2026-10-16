// Cliente HTTP do app, sobre undici.
//
// Por que undici direto e não o fetch do navegador/HTTP2: queremos VÁRIAS conexões TCP de verdade
// para o mesmo servidor. Com HTTP/1.1, cada requisição simultânea usa a sua própria conexão (e a sua
// própria janela de congestionamento), que é o que faz o download segmentado encher a banda.
// Com HTTP/2 tudo seria multiplexado numa conexão só e o ganho some.
import { Agent, EnvHttpProxyAgent, request } from 'undici'

const MAX_ERROR_BODY = 64 * 1024

function makeAgent(Kind, extra = {}) {
  return new Kind({
    connections: 256, // por origem; o motor controla quantas usa de fato
    pipelining: 1, // nunca enfileira requisições na mesma conexão
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 120_000,
    headersTimeout: 120_000,
    bodyTimeout: 0, // corpos enormes: quem detecta travamento é o motor (stallTimeoutMs)
    connect: { timeout: 30_000 },
    allowH2: false,
    ...extra,
  })
}

const directAgent = makeAgent(Agent)
let proxyAgent = null

function isLoopback(url) {
  const host = url.hostname
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
}

/** Escolhe o dispatcher: loopback sempre direto; resto usa HTTPS_PROXY se o usuário tiver um. */
export function dispatcherFor(url) {
  const u = url instanceof URL ? url : new URL(url)
  if (isLoopback(u)) return directAgent
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
    proxyAgent ??= makeAgent(EnvHttpProxyAgent)
    return proxyAgent
  }
  return directAgent
}

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {object} info { body, headers, url, method }
   */
  constructor(status, { body = null, headers = {}, url = '', method = 'GET' } = {}) {
    const g = googleError(body)
    super(g?.message || `HTTP ${status} em ${method} ${redact(url)}`)
    this.name = 'HttpError'
    this.status = status
    this.body = body
    this.headers = headers
    // A URI da sessão de upload é credencial: o erro pode ir parar num log (util.inspect mostra as propriedades).
    this.url = redact(url)
    this.method = method
    /** Motivo do Google (ex.: 'userRateLimitExceeded', 'storageQuotaExceeded'), se houver. */
    this.reason = g?.reason || null
    this.retryAfterMs = parseRetryAfter(headers['retry-after'])
  }
}

export function redact(url) {
  return String(url).replace(/(upload_id|access_token|key)=[^&]+/g, '$1=…')
}

/** Extrai {reason, message} do formato de erro do Google, ou de erros OAuth ({error, error_description}). */
export function googleError(body) {
  if (!body || typeof body !== 'object') return null
  const e = body.error
  if (e && typeof e === 'object') {
    const first = Array.isArray(e.errors) && e.errors[0]
    return {
      reason: first?.reason || e.status || null,
      message: e.message || first?.message || null,
    }
  }
  if (typeof e === 'string') return { reason: e, message: body.error_description || e }
  return null
}

function parseRetryAfter(value) {
  if (!value) return null
  const secs = Number(value)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

async function readBody(body, limit = MAX_ERROR_BODY) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of body) {
      if (size < limit) chunks.push(chunk)
      size += chunk.length
      if (size >= limit) break
    }
  } catch {
    // corpo cortado: devolve o que deu
  } finally {
    body.destroy?.()
  }
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Requisição crua. Devolve { status, headers, body } com `body` como stream (undici BodyReadable).
 * Quem chama PRECISA consumir ou destruir o body.
 * Lança HttpError se status não estiver em `expect` (o corpo do erro já vem lido e parseado).
 *
 * @param {string|URL} url
 * @param {object} opts { method, headers, body, signal, expect: number[], maxRedirections }
 */
export async function httpRequest(url, opts = {}) {
  const { method = 'GET', body, signal, expect = [200], maxRedirects = 5 } = opts
  let headers = opts.headers || {}
  let target = url instanceof URL ? url : new URL(url)
  for (let hop = 0; ; hop++) {
    const res = await request(target, {
      method,
      headers,
      body,
      signal,
      dispatcher: dispatcherFor(target),
    })
    const status = res.statusCode
    if (expect.includes(status)) return { status, headers: res.headers, body: res.body }
    // 308 NÃO é redirecionamento aqui: no upload retomável do Google significa "continue daqui".
    if ([301, 302, 303, 307].includes(status) && res.headers.location && hop < maxRedirects && (method === 'GET' || method === 'HEAD')) {
      res.body.destroy()
      const next = new URL(res.headers.location, target)
      // Só manda o token para hosts do Google (ou o mesmo host, p/ o servidor falso dos testes).
      if (next.host !== target.host && !/(^|\.)(googleapis|googleusercontent)\.com$/i.test(next.hostname)) {
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'authorization'))
      }
      target = next
      continue
    }
    const errBody = await readBody(res.body)
    throw new HttpError(status, { body: errBody, headers: res.headers, url: String(target), method })
  }
}

/** Requisição que espera JSON de volta. Corpo objeto vira JSON automaticamente. */
export async function requestJSON(url, opts = {}) {
  const headers = { accept: 'application/json', ...(opts.headers || {}) }
  let body = opts.body
  if (body && typeof body === 'object' && !(body instanceof Uint8Array) && typeof body.pipe !== 'function' && !(body instanceof URLSearchParams)) {
    body = JSON.stringify(body)
    headers['content-type'] ??= 'application/json; charset=utf-8'
  } else if (body instanceof URLSearchParams) {
    body = body.toString()
    headers['content-type'] ??= 'application/x-www-form-urlencoded'
  }
  const res = await httpRequest(url, { ...opts, headers, body, expect: opts.expect || [200, 201] })
  const text = await res.body.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(res.status, { body: text, headers: res.headers, url: String(url), method: opts.method || 'GET' })
  }
}

/** Lê e descarta o corpo (para liberar a conexão). */
export async function drain(body) {
  try {
    await body.dump?.({ limit: 1024 * 1024 })
  } catch {
    body.destroy?.()
  }
}

/** Fecha conexões abertas (para encerrar o app/testes sem ficar pendurado). */
export async function closeHttp() {
  await Promise.allSettled([directAgent.close(), proxyAgent?.close()])
}
