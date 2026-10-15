// Chamadas à API local. Toda requisição que altera estado manda Content-Type: application/json
// (o servidor recusa sem isso, inclusive DELETE). Respostas: { ok: true, ... } ou { ok: false, error }.
import { toast } from './toasts.js'

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function request(method, url, body) {
  const opts = { method, headers: { accept: 'application/json' }, cache: 'no-store' }
  if (method !== 'GET' && method !== 'HEAD') {
    opts.headers['content-type'] = 'application/json'
    opts.body = JSON.stringify(body ?? {})
  }
  let res
  try {
    res = await fetch(url, opts)
  } catch {
    throw new ApiError('Não consegui falar com o SOBEDESCE. Ele ainda está aberto?')
  }
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok || !data || data.ok === false) {
    throw new ApiError(data?.error || `Algo deu errado (erro ${res.status}).`, res.status)
  }
  return data
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body),
  patch: (url, body) => request('PATCH', url, body),
  del: (url, body) => request('DELETE', url, body),
}

/** Monta uma URL com query string, ignorando valores vazios. */
export function withQuery(url, params) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  const s = q.toString()
  return s ? `${url}?${s}` : url
}

/** Executa uma chamada e mostra o erro num aviso. Devolve null se falhar. */
export async function attempt(promiseOrFn) {
  try {
    return await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn)
  } catch (err) {
    toast('error', err?.message || 'Algo deu errado.')
    return null
  }
}

export const enc = encodeURIComponent
