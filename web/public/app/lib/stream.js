// Prévia e download pelo service worker, e miniaturas do Drive.
//
// <video>, <audio>, <img> e links de download não mandam o cabeçalho Authorization. Por isso a página aponta para
// /app/stream/<id> e o service worker (sw.js) busca no Google com o token, repassando o Range (o Safari só toca
// vídeo com resposta 206). O token não fica guardado em lugar nenhum: o SW pede para a página quando precisa
// (postMessage com MessageChannel) e guarda só na memória dele, que some quando ele dorme.
//
// Chave da aba (k): cada abertura do app sorteia uma chave e põe em todo endereço de stream. O SW manda a chave junto
// do pedido de token, e a página só entrega o token se a chave for a dela (devolvendo a chave na resposta). Assim um
// link /app/stream/<id> vindo de fora (WhatsApp, e-mail, outro site) não usa o token de ninguém.
import { ENDPOINTS, LAN } from './config.js'
import { expiresAt, getToken, invalidate } from './auth.js'
import { sizedThumb } from './browse.js'

const STREAM_BASE = new URL('../stream/', import.meta.url).pathname // "/app/stream/"

function newKey() {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}
const KEY = newKey() // só desta aba, só na memória

/** Endereço servido pelo SW. `download` = salvar (Content-Disposition: attachment). */
export function streamUrl(file, { download = false } = {}) {
  const p = new URLSearchParams()
  if (file.size != null) p.set('s', String(file.size))
  if (file.mimeType) p.set('t', file.mimeType)
  p.set('n', file.name || 'arquivo')
  if (download) p.set('download', '1')
  p.set('k', KEY)
  return `${STREAM_BASE}${encodeURIComponent(file.id)}?${p}`
}

const swOk = () => !LAN && typeof navigator !== 'undefined' && 'serviceWorker' in navigator

/** O SW está cuidando desta página? (sem ele não há streaming: o servidor do site não conhece /app/stream/). */
export function streamReady(timeout = 4000) {
  if (!swOk()) return Promise.resolve(false)
  if (navigator.serviceWorker.controller) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = (v) => {
      clearTimeout(t)
      navigator.serviceWorker.removeEventListener('controllerchange', onChange)
      resolve(v)
    }
    const onChange = () => done(Boolean(navigator.serviceWorker.controller))
    const t = setTimeout(() => done(Boolean(navigator.serviceWorker.controller)), timeout)
    navigator.serviceWorker.addEventListener('controllerchange', onChange)
  })
}

let bridged = false
/** Responde aos pedidos de token do SW. Só o SW desta origem consegue mandar mensagem para cá, e só com a chave desta aba. */
export function startBridge() {
  if (bridged || !swOk()) return
  bridged = true
  navigator.serviceWorker.addEventListener('message', async (e) => {
    const d = e.data
    const port = e.ports?.[0]
    if (!d || d.type !== 'sd-token' || !port) return
    if (d.k !== KEY) return port.postMessage({ ok: false, reason: 'chave' })
    try {
      if (d.stale) invalidate(d.stale)
      const token = await getToken()
      port.postMessage({ ok: true, k: KEY, token, api: ENDPOINTS.api, expiresAt: expiresAt() })
    } catch (err) {
      port.postMessage({ ok: false, reason: err?.reconnect ? 'reconectar' : err?.signedOut ? 'sessao' : 'erro' })
    }
  })
  try {
    navigator.serviceWorker.startMessages()
  } catch {
    // navegador antigo: as mensagens começam sozinhas ao carregar
  }
}

// ───── miniaturas ─────
//
// O thumbnailLink do Drive é temporário (horas) e às vezes só abre com sessão do Google. Ordem:
//  1. <img> direto no tamanho certo (=sNNN), sem Referer;
//  2. se falhar, fetch com Authorization → blob (vale quando o Google aceita o token e libera CORS);
//  3. senão, ícone do tipo.
// Fica tudo em memória (enquanto a página está aberta), no máximo MAX_LOADS ao mesmo tempo.

const MAX_LOADS = 6
const MAX_CACHE = 600
const cache = new Map() // chave → Promise<string|null>
const ready = new Map() // chave → string|null (já resolvidas)
const blobs = [] // URLs blob: criadas, para liberar as mais antigas
let active = 0
const queue = []
let mode = 'img' // 'img' | 'auth' (o direto falhou e o com token funcionou) | 'noauth' (o com token não funciona)

function slot(fn) {
  return new Promise((resolve) => {
    queue.push(() =>
      fn()
        .then(resolve, () => resolve(null))
        .finally(() => {
          active--
          next()
        }),
    )
    next()
  })
}

function next() {
  while (active < MAX_LOADS && queue.length) {
    active++
    queue.shift()()
  }
}

function viaImg(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const t = setTimeout(() => {
      img.src = ''
      reject(new Error('timeout'))
    }, 20_000)
    img.referrerPolicy = 'no-referrer'
    img.decoding = 'async'
    img.onload = () => {
      clearTimeout(t)
      img.naturalWidth > 1 ? resolve(url) : reject(new Error('vazia'))
    }
    img.onerror = () => {
      clearTimeout(t)
      reject(new Error('img'))
    }
    img.src = url
  })
}

async function viaAuth(url) {
  const token = await getToken()
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, referrerPolicy: 'no-referrer', credentials: 'omit' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const blob = await res.blob()
  if (!blob.size || (blob.type && !blob.type.startsWith('image/'))) throw new Error('não é imagem')
  const obj = URL.createObjectURL(blob)
  blobs.push(obj)
  if (blobs.length > MAX_CACHE) URL.revokeObjectURL(blobs.shift())
  return obj
}

async function fetchThumb(link) {
  if (mode !== 'auth') {
    try {
      return await viaImg(link)
    } catch {
      // segue para o com token
    }
  }
  if (mode === 'noauth') return null
  try {
    const url = await viaAuth(link)
    mode = 'auth'
    return url
  } catch (err) {
    if (err instanceof TypeError && mode !== 'auth') mode = 'noauth' // CORS/rede: não adianta tentar de novo
    return null
  }
}

/** URL pronta para <img> (http(s) ou blob:), ou null quando não há miniatura. `px` = largura em pixels de tela. */
export function loadThumb(file, px) {
  if (!file?.thumbnailLink || LAN) return Promise.resolve(null)
  const size = Math.round(px)
  const key = `${file.id}:${file.modifiedTime || ''}:${size}`
  let p = cache.get(key)
  if (!p) {
    p = slot(() => fetchThumb(sizedThumb(file.thumbnailLink, size)))
    p.then((v) => ready.set(key, v))
    cache.set(key, p)
    if (cache.size > MAX_CACHE) {
      const old = cache.keys().next().value
      cache.delete(old)
      ready.delete(old)
    }
  }
  return p
}

/** Já carregada? (para desenhar sem piscar ao voltar para uma pasta). undefined = ainda não se sabe. */
export function thumbNow(file, px) {
  if (!file?.thumbnailLink || LAN) return null
  return ready.get(`${file.id}:${file.modifiedTime || ''}:${Math.round(px)}`)
}
