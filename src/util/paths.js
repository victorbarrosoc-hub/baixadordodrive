// Nomes e caminhos: o Drive aceita quase qualquer nome; o disco local, não.

export const PART_SUFFIX = '.sobedesce-part'

export function toNFC(s) {
  return String(s ?? '').normalize('NFC')
}

/** Junta partes de caminho relativo com '/', ignorando vazias. */
export function joinRel(...parts) {
  return parts
    .flatMap(p => String(p ?? '').split('/'))
    .filter(Boolean)
    .join('/')
}

export function splitRel(rel) {
  return String(rel ?? '').split('/').filter(Boolean)
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
const MAX_NAME_BYTES = 240

function truncateUtf8(name, maxBytes) {
  if (Buffer.byteLength(name) <= maxBytes) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : ''
  let base = ext ? name.slice(0, dot) : name
  while (Buffer.byteLength(base + ext) > maxBytes && base.length) base = [...base].slice(0, -1).join('')
  return base + ext
}

/** Nome seguro para gravar no disco local da plataforma. */
export function safeLocalName(name, platform = process.platform) {
  let out = toNFC(name).replace(/[\u0000-\u001f\u007f]/g, '_')
  if (platform === 'win32') {
    out = out.replace(/[<>:"/\\|?*]/g, '_').replace(/[ .]+$/g, '')
    if (WIN_RESERVED.test(out)) out = `${out}_`
  } else {
    out = out.replace(/[/]/g, '_')
    if (platform === 'darwin') out = out.replace(/:/g, '_')
  }
  out = truncateUtf8(out.trim() === '' ? '' : out, MAX_NAME_BYTES)
  if (out === '' || out === '.' || out === '..') out = '_'
  return out
}

/** 'a.mov' -> 'a (2).mov' (e assim por diante) se o nome já estiver em `taken` (sem diferenciar maiúsculas). */
export function uniqueName(name, taken) {
  const lower = new Set([...taken].map(n => n.toLowerCase()))
  if (!lower.has(name.toLowerCase())) return name
  const dot = name.lastIndexOf('.')
  const hasExt = dot > 0
  const base = hasExt ? name.slice(0, dot) : name
  const ext = hasExt ? name.slice(dot) : ''
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
}

const JUNK_EXACT = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.spotlight-v100', '.trashes', '.fseventsd', '.temporaryitems', 'icon\r', '.localized'])

/** Arquivos de sistema que não devem subir nem contar na comparação. */
export function isJunkFile(name) {
  const n = String(name)
  const lower = n.toLowerCase()
  return JUNK_EXACT.has(lower) || n.startsWith('._') || lower.endsWith(PART_SUFFIX)
}
