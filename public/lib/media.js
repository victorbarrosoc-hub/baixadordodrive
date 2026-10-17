// Miniaturas e prévia: URLs das rotas de mídia do servidor local (com a chave de /api/state), o que dá para tocar
// no Chromium e o proxy de câmera (BRAW/R3D/MXF… com um .mp4 leve do lado).
import { getState } from './store.js'
import { api, enc, withQuery } from './api.js'
import { CAMERA_EXT, extOf, fileKind } from './format.js'

const mediaKey = () => getState().media?.key || ''

// Miniaturas regravadas agora há pouco ("Gerar miniaturas"): a versão na URL muda e nenhum cache (do navegador ou do
// servidor) devolve a imagem antiga.
const busted = new Map() // `${acc}:${id}` -> marca

export function bustThumbs(accountId, ids) {
  const mark = Date.now().toString(36)
  for (const id of ids || []) busted.set(`${accountId}:${id}`, mark)
}

export function thumbUrl(accountId, item, size = 220) {
  if (!accountId || !item?.hasThumbnail || !mediaKey()) return null
  const bust = busted.get(`${accountId}:${item.id}`)
  const v = `${item.modifiedTime || ''}${bust ? `~${bust}` : ''}`
  return withQuery('/api/drive/thumb', { account: accountId, id: item.id, s: size, v, rk: item.resourceKey || '', k: mediaKey() })
}

export function streamUrl(accountId, item) {
  if (!accountId || !item?.id || !mediaKey()) return null
  return withQuery('/api/drive/stream', { account: accountId, id: item.id, rk: item.resourceKey || '', k: mediaKey() })
}

// Formatos de câmera e de finalização que o Chromium não abre: nem tenta, vai direto atrás do proxy.
const NO_PLAY = new Set(['braw', 'r3d', 'ari', 'arx', 'crm', 'mxf', 'mts', 'm2ts', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'vob', 'dv', 'mkv', 'cine', 'nev', 'exr', 'dpx'])
// Vale procurar proxy quando a prévia não toca (.mov ProRes/HEVC só se o Chromium falhar).
const PROXY_WORTH = new Set(['braw', 'r3d', 'ari', 'arx', 'crm', 'mxf', 'mov', 'mp4', 'm4v', 'mts', 'm2ts', 'avi', 'cine', 'nev', 'dv'])
const PROXY_EXT = new Set(['mp4', 'mov', 'm4v'])
const IMG_FULL = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'])
const AUDIO_OK = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba'])

/** 'video' | 'audio' | 'image' | 'other' */
export function previewKind(item) {
  if (!item || item.isFolder || item.isGoogleDoc) return 'other'
  const ext = extOf(item.name)
  if (CAMERA_EXT.has(ext)) return 'video'
  const kind = fileKind(item.name, item.mimeType)
  if (kind === 'video' || kind === 'audio' || kind === 'image') return kind
  return 'other'
}

export const tryPlayVideo = (item) => !NO_PLAY.has(extOf(item.name))
export const tryPlayAudio = (item) => AUDIO_OK.has(extOf(item.name)) || /^audio\/(mpeg|wav|x-wav|mp4|aac|ogg|flac|webm)$/.test(item.mimeType || '')
export const fullImage = (item) => IMG_FULL.has(extOf(item.name)) && (item.size == null || item.size < 60e6)
export const proxyWorth = (item) => PROXY_WORTH.has(extOf(item.name))

// ───── proxy de câmera ─────

const proxies = new Map() // `${acc}:${id}` -> DriveItem | null
const pending = new Map()
const subs = new Set()

export function onProxies(fn) {
  subs.add(fn)
  return () => subs.delete(fn)
}

export function knownProxy(accountId, id) {
  return proxies.get(`${accountId}:${id}`)
}

/** Pergunta ao motor (uma vez por arquivo; a resposta fica guardada). */
export function findProxy(accountId, item) {
  const key = `${accountId}:${item.id}`
  if (proxies.has(key)) return Promise.resolve(proxies.get(key))
  let p = pending.get(key)
  if (!p) {
    p = api
      .get(withQuery(`/api/drive/${enc(accountId)}/proxy`, { id: item.id, rk: item.resourceKey || '' }))
      .then((res) => {
        proxies.set(key, res.proxy || null)
        for (const fn of subs) fn()
        return res.proxy || null
      })
      .catch(() => null)
      .finally(() => pending.delete(key))
    pending.set(key, p)
  }
  return p
}

const base = (name) => {
  const i = name.lastIndexOf('.')
  return (i > 0 ? name.slice(0, i) : name).normalize('NFC').toLowerCase()
}

/**
 * Proxies que já estão na lista da pasta (mesmo nome-base, .mp4/.mov/.m4v) para os arquivos de câmera sem miniatura.
 * Sem consulta nenhuma: serve só para a grade mostrar a miniatura do proxy.
 */
export function siblingProxies(items) {
  const out = new Map()
  if (!items?.length) return out
  const byBase = new Map()
  for (const it of items) if (!it.isFolder && it.hasThumbnail && PROXY_EXT.has(extOf(it.name))) byBase.set(base(it.name), it)
  for (const it of items) {
    if (it.isFolder || it.hasThumbnail || !CAMERA_EXT.has(extOf(it.name))) continue
    const p = byBase.get(base(it.name))
    if (p && p.id !== it.id) out.set(it.id, p)
  }
  return out
}

/** Duração curta para selos: 0:12, 4:05, 1:02:33. */
export function clipTime(sec) {
  if (sec == null || !Number.isFinite(sec)) return ''
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
