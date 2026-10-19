// Formatação em pt-BR. Tamanhos em unidades DECIMAIS (1 GB = 1e9 bytes), como o app do computador.

const nf = (min, max) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: max })
const NF0 = nf(0, 0)
const NF1 = nf(1, 1)
const NF01 = nf(0, 1)
const NF2 = nf(2, 2)

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

function scale(n) {
  let i = 0
  let v = Math.abs(n)
  while (v >= 999.95 && i < UNITS.length - 1) {
    v /= 1000
    i++
  }
  return { v: n < 0 ? -v : v, unit: UNITS[i] }
}

/** "1,5 GB", "812 MB". `fixed` mantém sempre uma casa (bom para números que mudam ao vivo). */
export function bytes(n, { fixed = false, precise = false } = {}) {
  if (n == null || !Number.isFinite(n)) return '—'
  if (Math.abs(n) < 1000) return `${NF0.format(n)} B`
  const { v, unit } = scale(n)
  // `precise`: uma casa até nos números grandes ("412,3 GB"), para totais que já pararam de mudar.
  const f = precise ? NF01 : Math.abs(v) >= 100 ? NF0 : fixed ? NF1 : NF01
  return `${f.format(v)} ${unit}`
}

/** "18,4 MB/s" */
export function speed(bps) {
  const n = Number(bps) || 0
  if (n < 1e6) return n < 1000 ? '0 KB/s' : `${NF0.format(n / 1000)} KB/s`
  if (n >= 1e9) return `${NF2.format(n / 1e9)} GB/s`
  return `${NF1.format(n / 1e6)} MB/s`
}

/** Tempo restante como timecode "00:12:41". */
export function timecode(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '--:--:--'
  const s = Math.round(sec)
  if (s > 99 * 3600) return '> 99 h'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

export function count(n) {
  return NF0.format(Number(n) || 0)
}

export function plural(n, one, many) {
  return `${count(n)} ${n === 1 ? one : many}`
}

export function percent(frac) {
  if (!Number.isFinite(frac)) return '0%'
  const p = Math.max(0, Math.min(1, frac)) * 100
  return `${p > 0 && p < 1 ? '<1' : NF0.format(Math.floor(p))}%`
}

const KINDS = {
  video: ['mov', 'mp4', 'mxf', 'braw', 'r3d', 'avi', 'mkv', 'm4v', 'mts', 'm2ts', 'webm', '3gp', 'hevc'],
  audio: ['wav', 'aif', 'aiff', 'mp3', 'flac', 'm4a', 'aac', 'bwf', 'ogg', 'opus', 'caf'],
  image: ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'dng', 'cr3', 'cr2', 'arw', 'nef', 'raf', 'psd', 'psb', 'heic', 'heif', 'gif', 'webp', 'avif', 'svg'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'dmg', 'iso'],
  doc: ['pdf', 'doc', 'docx', 'txt', 'rtf', 'pages', 'xls', 'xlsx', 'csv', 'numbers', 'ppt', 'pptx', 'key', 'srt', 'vtt', 'md', 'json'],
}
const EXT_KIND = new Map()
for (const [kind, exts] of Object.entries(KINDS)) for (const e of exts) EXT_KIND.set(e, kind)

export function extOf(name = '') {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** 'video' | 'audio' | 'image' | 'archive' | 'doc' | 'generic' */
export function fileKind(name, mimeType) {
  const k = EXT_KIND.get(extOf(name))
  if (k) return k
  if (mimeType) {
    if (mimeType.startsWith('video/')) return 'video'
    if (mimeType.startsWith('audio/')) return 'audio'
    if (mimeType.startsWith('image/')) return 'image'
  }
  return 'generic'
}

export const KIND_ICON = { video: 'film', audio: 'music', image: 'photo', archive: 'archive', doc: 'doc', generic: 'doc' }

export function initials(name = '', email = '') {
  const src = (name || email.split('@')[0] || '?').trim()
  const parts = src.split(/[\s._-]+/).filter(Boolean)
  const s = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : src.slice(0, 1)
  return s.toUpperCase()
}

/** Duração de mídia: "0:42", "12:05", "1:02:03". */
export function duration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}

/** Tempo do player em segundos (com décimos fora): "0:07", "1:02:03". */
export function clock(sec) {
  return Number.isFinite(sec) ? duration(Math.floor(sec) * 1000) : '0:00'
}

const DATE_SHORT = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' })
const DATE_YEAR = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' })
const DATE_FULL = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })

/** "12 de out." (este ano) ou "3 de mar. de 2024". */
export function shortDate(iso) {
  const d = new Date(iso)
  if (!iso || Number.isNaN(d.getTime())) return ''
  return (d.getFullYear() === new Date().getFullYear() ? DATE_SHORT : DATE_YEAR).format(d)
}

/** "12 de outubro de 2026 às 14:32". */
export function fullDate(iso) {
  const d = new Date(iso)
  if (!iso || Number.isNaN(d.getTime())) return ''
  return DATE_FULL.format(d)
}
