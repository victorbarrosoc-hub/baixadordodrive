// Formatação em pt-BR. Tamanhos em unidades DECIMAIS, como o Finder do macOS (1 GB = 1e9 bytes).

const nf = (min, max) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: max })
const NF0 = nf(0, 0)
const NF1 = nf(1, 1)
const NF01 = nf(0, 1)
const NF2 = nf(2, 2)

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/** Divide um número de bytes em { value, unit } (decimal). */
function scale(n) {
  let i = 0
  let v = Math.abs(n)
  while (v >= 999.95 && i < UNITS.length - 1) {
    v /= 1000
    i++
  }
  return { v: n < 0 ? -v : v, unit: UNITS[i], i }
}

/** "48,2 GB", "812 MB", "212 GB". `fixed` mantém sempre uma casa (bom para números que mudam ao vivo). */
export function bytes(n, { fixed = false, precise = false } = {}) {
  if (n == null || !Number.isFinite(n)) return '—'
  if (Math.abs(n) < 1000) return `${NF0.format(n)} B`
  const { v, unit } = scale(n)
  // `precise`: uma casa até nos números grandes ("412,3 GB"), para totais que já pararam de mudar.
  const f = precise ? NF01 : Math.abs(v) >= 100 ? NF0 : fixed ? NF1 : NF01
  return `${f.format(v)} ${unit}`
}

/** Velocidade em partes, para leituras grandes: { value: '142,3', unit: 'MB/s' }. */
export function speedParts(bps) {
  const n = Number(bps) || 0
  if (n < 1e6) return { value: n < 1000 ? '0' : NF0.format(n / 1000), unit: n < 1000 ? 'MB/s' : 'KB/s' }
  if (n >= 1e9) return { value: NF2.format(n / 1e9), unit: 'GB/s' }
  return { value: NF1.format(n / 1e6), unit: 'MB/s' }
}

export function speed(bps) {
  const { value, unit } = speedParts(bps)
  return `${value} ${unit}`
}

/** Equivalente em bits ("≈ 1,1 Gbps"), para comparar com o plano de internet. */
export function bits(bps) {
  const b = (Number(bps) || 0) * 8
  if (b < 1e6) return `≈ ${NF0.format(b / 1e3)} kbps`
  if (b < 1e9) return `≈ ${(b >= 1e8 ? NF0 : NF01).format(b / 1e6)} Mbps`
  return `≈ ${NF1.format(b / 1e9)} Gbps`
}

/** Tempo restante como timecode "00:12:41". Mais de 99 h vira "> 99 h". */
export function timecode(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '--:--:--'
  const s = Math.round(sec)
  if (s > 99 * 3600) return '> 99 h'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

/** Contagem com separador de milhar: 3.000 */
/** Tempo que falta, em palavras (o mesmo texto do celular): "menos de 1 min", "~14 min", "~2 h 5 min". */
export function aprox(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return null
  if (sec < 60) return 'menos de 1 min'
  const min = Math.round(sec / 60)
  if (min < 60) return `~${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `~${h} h ${m} min` : `~${h} h`
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

function toMs(t) {
  if (t == null) return null
  if (typeof t === 'number') return t
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? ms : null
}

/** "agora", "há 5 min", "há 2 h", "ontem", "há 3 dias", "12 de out." */
export function relTime(t, ref = Date.now()) {
  const ms = toMs(t)
  if (ms == null) return '—'
  const diff = Math.max(0, ref - ms)
  const min = Math.floor(diff / 60e3)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h} h`
  const d = new Date(ms)
  const today = new Date(ref)
  const yesterday = new Date(ref - 86400e3)
  if (d.toDateString() === yesterday.toDateString()) return 'ontem'
  // dias de calendário (30 h atrás pode ser anteontem: "há 2 dias", nunca "há 1 dias")
  const days = Math.max(2, Math.round((new Date(today).setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86400e3))
  if (days < 7) return `há ${days} dias`
  return d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) })
}

/** Data completa para dicas (title). */
export function fullDate(t) {
  const ms = toMs(t)
  if (ms == null) return ''
  return new Date(ms).toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' })
}

/** "14:32" — ou "amanhã às 09:10" se for outro dia. */
export function clock(t) {
  const ms = toMs(t)
  if (ms == null) return ''
  const d = new Date(ms)
  const hhmm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return hhmm
  const tomorrow = new Date(Date.now() + 86400e3)
  if (d.toDateString() === tomorrow.toDateString()) return `amanhã às ${hhmm}`
  return `${d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' })} às ${hhmm}`
}

// ───── tipos de arquivo ─────

const KINDS = {
  video: ['mov', 'mp4', 'mxf', 'braw', 'r3d', 'ari', 'avi', 'mkv', 'm4v', 'mts', 'm2ts', 'webm', 'crm', 'prores'],
  audio: ['wav', 'aif', 'aiff', 'mp3', 'flac', 'm4a', 'aac', 'bwf', 'ogg'],
  image: ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'dng', 'cr3', 'cr2', 'arw', 'nef', 'raf', 'psd', 'exr', 'heic', 'gif', 'webp', 'dpx', 'svg'],
  project: ['prproj', 'drp', 'aep', 'fcpbundle', 'fcpxml', 'veg', 'ppj', 'xml', 'edl', 'aaf', 'omf', 'otio', 'cube', 'drt'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'dmg', 'iso'],
  doc: ['pdf', 'doc', 'docx', 'txt', 'rtf', 'pages', 'xls', 'xlsx', 'csv', 'numbers', 'ppt', 'pptx', 'key', 'srt', 'vtt', 'md', 'json'],
}
// Formatos de câmera (BRAW, R3D, ARRI, Canon RAW, MXF, Phantom…): sempre vídeo, mesmo quando o Drive diz
// application/octet-stream. A prévia (lib/media.js) e o filtro da tela Drive (lib/ordenar.js) usam o mesmo conjunto.
export const CAMERA_EXT = new Set(['braw', 'r3d', 'ari', 'arx', 'crm', 'mxf', 'cine', 'nev'])

const EXT_KIND = new Map()
for (const [kind, exts] of Object.entries(KINDS)) for (const e of exts) EXT_KIND.set(e, kind)

export function extOf(name = '') {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** 'video' | 'audio' | 'image' | 'project' | 'archive' | 'doc' | 'generic' */
export function fileKind(name, mimeType) {
  if (mimeType && mimeType.startsWith('application/vnd.google-apps.')) return 'doc'
  const k = EXT_KIND.get(extOf(name))
  if (k) return k
  if (mimeType) {
    if (mimeType.startsWith('video/')) return 'video'
    if (mimeType.startsWith('audio/')) return 'audio'
    if (mimeType.startsWith('image/')) return 'image'
  }
  return 'generic'
}

/** Pasta de um relPath ('Brutos/Dia 01/x.mov' → 'Brutos/Dia 01'). */
export function dirOf(relPath = '') {
  const i = relPath.lastIndexOf('/')
  return i > 0 ? relPath.slice(0, i) : ''
}

/** Último componente de um caminho local (aceita / e \). */
export function baseName(p = '') {
  const s = String(p).replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i >= 0 ? s.slice(i + 1) || s : s
}

/** Abrevia a pasta pessoal: /Users/victor/Downloads → ~/Downloads */
export function tildify(p, home) {
  if (!p) return ''
  if (home && (p === home || p.startsWith(home + '/') || p.startsWith(home + '\\'))) return '~' + p.slice(home.length)
  return p
}

export function initials(name = '', email = '') {
  const src = (name || email.split('@')[0] || '?').trim()
  const parts = src.split(/[\s._-]+/).filter(Boolean)
  const s = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : src.slice(0, 1)
  return s.toUpperCase()
}

/** Caminho curto para chips: ~/Downloads, …/Brutos/Dia 01 */
export function shortPath(p, home) {
  const t = tildify(p || '', home)
  const sep = t.includes('\\') && !t.includes('/') ? '\\' : '/'
  const parts = t.split(sep).filter(Boolean)
  if (parts.length <= 3) return t
  return `…${sep}${parts.slice(-2).join(sep)}`
}

/** Busca sem acento e sem caixa. */
export function fold(s = '') {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}
