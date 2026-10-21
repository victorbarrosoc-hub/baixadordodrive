// Servidor HTTP local do SOBEDESCE: segurança, arquivos da interface, SSE e o despacho para as rotas da API.
//
// Por que é assim:
//  - Escuta só em 127.0.0.1. Mesmo assim, uma página qualquer aberta no navegador consegue mandar requisições
//    para cá; por isso: Host fora da lista = 403 (DNS rebinding), métodos que mudam estado exigem
//    Content-Type: application/json (um <form> de outro site não consegue mandar isso sem CORS) e Origin do app.
//  - Erros chegam à interface como { ok: false, error: 'mensagem em português' }; pilha de erro nunca sai daqui.
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createApi, HttpProblem, baseHeaders, sendJSON } from './routes.js'
import { MediaService } from './media.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const PUBLIC_DIR = path.join(ROOT, 'public')
export const DEFAULT_PORT = 4317
const PORT_TRIES = 21 // a porta pedida + as 20 seguintes
const PING_MS = 15_000
const SSE_MAX_BUFFER = 8 * 1024 * 1024 // cliente que não lê (aba congelada) não pode acumular memória sem fim

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
}

// A interface não tem script inline; estilos inline (atributo style) e fotos de perfil do Google, sim.
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/** Arquivo do Preact + htm (sem build): node_modules/htm/preact/standalone.module.js. */
function vendorFile() {
  try {
    // 'htm' resolve para dist/htm.js; o pacote fica dois níveis acima (funciona também empacotado).
    const main = createRequire(import.meta.url).resolve('htm')
    return path.join(path.dirname(path.dirname(main)), 'preact', 'standalone.module.js')
  } catch {
    return path.join(ROOT, 'node_modules', 'htm', 'preact', 'standalone.module.js')
  }
}

function isJsonType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase() === 'application/json'
}

// ─────────── SSE ───────────

/** Clientes de /api/events. `send` escreve um evento para todos. */
export class EventHub {
  constructor({ onFirst, onEmpty } = {}) {
    this.clients = new Set()
    this.onFirst = onFirst
    this.onEmpty = onEmpty
    this.ping = setInterval(() => this.#write(': ping\n\n'), PING_MS)
    this.ping.unref?.()
  }

  get size() {
    return this.clients.size
  }

  /** Registra a resposta como cliente SSE e manda o `hello`. */
  attach(req, res, hello) {
    req.socket.setTimeout(0)
    req.socket.setNoDelay(true)
    req.socket.setKeepAlive(true)
    res.writeHead(200, baseHeaders({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    }))
    res.write('retry: 3000\n\n')
    res.write(frame('hello', hello))
    const wasEmpty = this.clients.size === 0
    this.clients.add(res)
    const drop = () => {
      if (!this.clients.delete(res)) return
      if (this.clients.size === 0) this.#call(this.onEmpty)
    }
    res.on('close', drop)
    res.on('error', drop)
    if (wasEmpty) this.#call(this.onFirst)
  }

  send(event, data) {
    if (!this.clients.size) return
    this.#write(frame(event, data))
  }

  #write(payload) {
    for (const res of this.clients) {
      if (res.writableLength > SSE_MAX_BUFFER) {
        res.destroy()
        continue
      }
      try {
        res.write(payload)
      } catch {
        res.destroy()
      }
    }
  }

  #call(fn) {
    try {
      fn?.()
    } catch {}
  }

  close() {
    clearInterval(this.ping)
    for (const res of this.clients) {
      try {
        res.end()
      } catch {}
    }
    this.clients.clear()
  }
}

function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`
}

// ─────────── arquivos da interface ───────────

async function serveStatic(req, res, pathname, { publicDir, vendor }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJSON(res, 405, { ok: false, error: 'Método não permitido.' })
  let file
  if (pathname === '/vendor/preact-htm.js') file = vendor
  else {
    let rel
    try {
      rel = decodeURIComponent(pathname)
    } catch {
      return notFound(res)
    }
    if (rel.includes('\0') || rel.includes('\\')) return notFound(res)
    rel = path.posix.normalize(rel === '/' ? '/index.html' : rel)
    // Nada de arquivos ocultos nem de sair da pasta public/.
    if (rel.split('/').some(seg => seg.startsWith('.'))) return notFound(res)
    file = path.join(publicDir, rel)
    if (!file.startsWith(publicDir + path.sep)) return notFound(res)
  }
  let st
  try {
    st = await fs.stat(file)
    if (!st.isFile()) throw new Error('não é arquivo')
  } catch {
    // Rotas da interface (sem extensão) caem no index.html.
    if (!path.extname(pathname) && file !== vendor && pathname !== '/') return serveStatic(req, res, '/', { publicDir, vendor })
    return notFound(res)
  }
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
  const headers = baseHeaders({ 'content-type': type, 'cache-control': 'no-cache', etag })
  if (type.startsWith('text/html')) headers['content-security-policy'] = APP_CSP
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    return res.end()
  }
  let data
  try {
    data = await fs.readFile(file)
  } catch {
    return notFound(res)
  }
  headers['content-length'] = data.length
  res.writeHead(200, headers)
  res.end(req.method === 'HEAD' ? undefined : data)
}

function notFound(res) {
  res.writeHead(404, baseHeaders({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }))
  res.end('Não encontrado.')
}

// ─────────── servidor ───────────

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = err => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(server.address().port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/**
 * Sobe o servidor em 127.0.0.1 (porta pedida; se ocupada, as 20 seguintes; 0 = qualquer livre).
 * @param {object} opts { port, settings, auth, manager, hasher, paths, desktop, mobile, versao, spawn, publicDir, log }
 * @returns {Promise<{ server, port: number, url: string, hub: EventHub, close(): Promise<void> }>}
 */
export async function startServer({ port = DEFAULT_PORT, host = '127.0.0.1', publicDir = PUBLIC_DIR, ...opts } = {}) {
  const ctx = {
    ...opts,
    port: null,
    log: opts.log || ((...args) => console.error('[servidor]', ...args)),
  }
  const statsListener = s => hub.send('stats', s)
  const hub = new EventHub({
    // 'stats' custa uma passada pela fila: só calcula enquanto alguém está olhando.
    onFirst: () => ctx.manager?.on('stats', statsListener),
    onEmpty: () => ctx.manager?.off('stats', statsListener),
  })
  ctx.hub = hub
  ctx.media = opts.media === false ? null : new MediaService(ctx, opts.mediaOptions || {})
  const api = createApi(ctx)
  const vendor = vendorFile()
  const allowed = () => new Set([`127.0.0.1:${ctx.port}`, `localhost:${ctx.port}`])
  const origins = () => new Set([`http://127.0.0.1:${ctx.port}`, `http://localhost:${ctx.port}`])

  const server = http.createServer(async (req, res) => {
    try {
      const host = String(req.headers.host || '').toLowerCase()
      if (!allowed().has(host)) return sendJSON(res, 403, { ok: false, error: 'Endereço não permitido. Abra o SOBEDESCE pelo endereço 127.0.0.1.' })
      let url
      try {
        url = new URL(req.url, `http://${host}`)
      } catch {
        return sendJSON(res, 400, { ok: false, error: 'Endereço inválido.' })
      }
      const method = req.method
      if (method !== 'GET' && method !== 'HEAD') {
        // Post do Frames: a imagem vai crua (PNG/JPEG), o que também pede a checagem prévia do navegador (CORS).
        const imagemDoFrames = method === 'POST' && /^\/api\/frames\/frm_[\w-]+\/post$/.test(url.pathname) && /^image\/(png|jpeg)$/i.test(String(req.headers['content-type'] || '').split(';')[0].trim())
        // Celular pelo Wi-Fi: a janela oculta grava os pedaços que chegam do celular crus (mesmo motivo: tipo não simples).
        const pedacoDoCelular = method === 'PUT' && /^\/api\/celular\/receber\/[\w-]+\/\d+$/.test(url.pathname) && String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() === 'application/octet-stream'
        if (!imagemDoFrames && !pedacoDoCelular && !isJsonType(req.headers['content-type'])) return sendJSON(res, 415, { ok: false, error: 'Requisição recusada: falta Content-Type: application/json.' })
        const origin = req.headers.origin
        if (origin && !origins().has(String(origin).toLowerCase())) return sendJSON(res, 403, { ok: false, error: 'Origem não permitida.' })
      }
      if (url.pathname.startsWith('/api/') || url.pathname === '/oauth/callback') {
        if (await api.dispatch(req, res, url)) return
        return sendJSON(res, 404, { ok: false, error: 'Rota não encontrada.' })
      }
      return await serveStatic(req, res, url.pathname, { publicDir, vendor })
    } catch (err) {
      const p = err instanceof HttpProblem ? err : null
      if (!p) ctx.log('erro inesperado:', err?.stack || err)
      if (!res.headersSent) sendJSON(res, p?.status || 500, { ok: false, error: p?.message || 'Algo deu errado aqui dentro. Tente de novo.' })
      else res.destroy()
    }
  })
  server.keepAliveTimeout = 30_000
  server.headersTimeout = 60_000
  server.requestTimeout = 0 // planejar uma pasta gigante do Drive pode levar minutos

  // Porta: a pedida ou as próximas 20 (0 = o sistema escolhe).
  let bound = null
  const first = Number(port) || 0
  let lastErr = null
  for (let i = 0; i < (first === 0 ? 1 : PORT_TRIES); i++) {
    try {
      bound = await listen(server, first === 0 ? 0 : first + i, host)
      break
    } catch (err) {
      lastErr = err
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') break
    }
  }
  // A faixa inteira bloqueada (no Windows, Hyper-V/WSL reservam faixas de portas e dão EACCES): o sistema escolhe uma.
  if (bound == null && first !== 0 && (lastErr?.code === 'EACCES' || lastErr?.code === 'EADDRINUSE')) {
    try {
      bound = await listen(server, 0, host)
    } catch (err) {
      lastErr = err
    }
  }
  if (bound == null) {
    const err = new Error(`Não consegui abrir a porta ${first}${first ? `–${first + PORT_TRIES - 1}` : ''}: ${lastErr?.code || lastErr?.message}`)
    err.code = lastErr?.code
    throw err
  }
  ctx.port = bound
  const url = `http://127.0.0.1:${bound}`

  // Eventos do motor para a interface.
  const forward = []
  const on = (emitter, event, fn) => {
    if (!emitter?.on) return
    emitter.on(event, fn)
    forward.push(() => emitter.off(event, fn))
  }
  on(ctx.manager, 'transfers', list => hub.send('transfers', list))
  on(ctx.manager, 'removed', ids => hub.send('removed', ids))
  on(ctx.manager, 'batches', list => hub.send('batches', list))
  on(ctx.manager, 'toast', t => hub.send('toast', { kind: t.kind, message: t.message }))
  on(ctx.auth, 'accounts', list => hub.send('accounts', list))
  on(ctx.auth?.cloud, 'status', st => hub.send('cloud', st))
  on(ctx.auth?.cloud, 'signedOut', ev => hub.send('toast', { kind: 'error', message: ev.message }))
  on(ctx.settings, 'change', s => hub.send('settings', s))
  on(ctx.versao, 'status', st => hub.send('versao', st))
  on(ctx.referencias, 'status', st => hub.send('referencias', st))
  on(ctx.referencias, 'toast', t => hub.send('toast', { kind: t.kind, message: t.message }))
  on(ctx.referencias?.updater, 'status', () => hub.send('referencias', ctx.referencias.status()))

  let closing = null
  const close = () => {
    closing ??= (async () => {
      for (const off of forward) off()
      ctx.manager?.off('stats', statsListener)
      api.close()
      hub.close()
      await new Promise(resolve => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    })()
    return closing
  }
  return { server, port: bound, url, hub, ctx, close }
}
