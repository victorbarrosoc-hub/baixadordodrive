// Navegar no Drive (aba Drive): listar pastas e arquivos com miniatura, buscar por nome e ordenar.
// Só leitura: nada aqui muda o Drive. Usa o mesmo token da conta (lib/auth.js) e o mesmo `call` do envio.
import { FOLDER_MIME, driveCall, q } from './drive.js'
import { extOf, fileKind } from './format.js'
import { local } from './config.js'
import { FolderSizes, pageLister, walkFolderSize } from './tamanho.js'

const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'
const GAPPS = 'application/vnd.google-apps.'
const PAGE = 60

// O que a grade e a prévia precisam de cada arquivo (sem isto o Google devolve só id, nome e tipo).
const FILE_FIELDS = [
  'id',
  'name',
  'mimeType',
  'size',
  'modifiedTime',
  'thumbnailLink',
  'iconLink',
  'hasThumbnail',
  'videoMediaMetadata',
  'imageMediaMetadata',
  'webViewLink',
  'driveId',
  'parents',
  'shortcutDetails',
  'capabilities(canDownload,canAddChildren)',
  'appProperties',
].join(',')

/** Escopos da raiz: Meu Drive, Compartilhados comigo e Drives compartilhados. */
export const SCOPES = [
  { id: 'mine', label: 'Meu Drive', aria: 'Meu Drive' },
  { id: 'shared', label: 'Comigo', aria: 'Compartilhados comigo' },
  { id: 'drives', label: 'Drives', aria: 'Drives compartilhados' },
]

export const SORTS = {
  name: { label: 'Nome', order: 'folder,name_natural', desc: 'folder,name_natural desc' },
  date: { label: 'Data', order: 'folder,modifiedTime desc', desc: 'folder,modifiedTime' },
  size: { label: 'Tamanho', order: 'folder,quotaBytesUsed desc', desc: 'folder,quotaBytesUsed' },
}

// ───── preferências do aparelho (grade/lista e ordem) ─────

const PREFS_KEY = 'sobedesce.browse'
export function getPrefs() {
  const p = local.get(PREFS_KEY) || {}
  return {
    view: p.view === 'list' ? 'list' : 'grid',
    sort: SORTS[p.sort] ? p.sort : 'name',
    flip: p.flip === true,
  }
}
export function savePrefs(p) {
  local.set(PREFS_KEY, { view: p.view, sort: p.sort, flip: !!p.flip })
}

// ───── tipos ─────

export function isFolder(f) {
  return f?.mimeType === FOLDER_MIME || (f?.mimeType === SHORTCUT_MIME && f.shortcutDetails?.targetMimeType === FOLDER_MIME)
}

/** Documento do Google (Docs, Planilhas…): não tem bytes para baixar, só abrir no Drive. */
export function isGoogleDoc(f) {
  const m = f?.mimeType === SHORTCUT_MIME ? f.shortcutDetails?.targetMimeType : f?.mimeType
  return Boolean(m && m.startsWith(GAPPS) && m !== FOLDER_MIME)
}

/** O arquivo de verdade por trás de um atalho (id e tipo do alvo). */
export function target(f) {
  if (f?.mimeType !== SHORTCUT_MIME || !f.shortcutDetails?.targetId) return f
  return { ...f, id: f.shortcutDetails.targetId, mimeType: f.shortcutDetails.targetMimeType || 'application/octet-stream', shortcut: f.id }
}

// Formatos que o navegador não toca, mesmo com o tipo certo (brutos de câmera e contêineres profissionais).
const NO_PLAY = new Set(['mxf', 'braw', 'r3d', 'ari', 'arx', 'crm', 'avi', 'mts', 'm2ts', 'mpg', 'mpeg', 'wmv', 'flv', 'dv', 'hevc', 'h264', '264', 'vob'])
const NO_PLAY_AUDIO = new Set(['aif', 'aiff', 'bwf', 'wma', 'ape', 'dsf'])
const SHOW_IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'heic', 'heif'])

/** 'folder' | 'video' | 'audio' | 'image' | 'pdf' | 'gdoc' | 'archive' | 'doc' | 'generic' */
export function kindOf(f) {
  if (isFolder(f)) return 'folder'
  if (isGoogleDoc(f)) return 'gdoc'
  if (f.mimeType === 'application/pdf' || extOf(f.name) === 'pdf') return 'pdf'
  if (NO_PLAY.has(extOf(f.name))) return 'video'
  return fileKind(f.name, f.mimeType)
}

/** O navegador deve conseguir tocar? (a última palavra é do próprio <video>: se der erro, mostra o aviso). */
export function mayPlay(f, el) {
  const ext = extOf(f.name)
  const kind = kindOf(f)
  if (kind === 'video') return !NO_PLAY.has(ext) && canPlay(el, f.mimeType, ext)
  if (kind === 'audio') return !NO_PLAY_AUDIO.has(ext) && canPlay(el, f.mimeType, ext)
  return false
}

function canPlay(el, mime, ext) {
  try {
    const probe = el || document.createElement('video')
    const types = [mime, ext === 'mov' ? 'video/quicktime' : null, ext === 'mov' ? 'video/mp4' : null, ext === 'm4a' ? 'audio/mp4' : null, ext === 'wav' ? 'audio/wav' : null]
    return types.some((t) => t && probe.canPlayType(t) !== '')
  } catch {
    return true
  }
}

/** Foto que o navegador mostra direto (sem conversão): serve de reserva quando a miniatura não vem. */
export function showsAsImage(f) {
  const ext = extOf(f.name)
  if (!SHOW_IMAGE.has(ext)) return false
  if (ext === 'heic' || ext === 'heif') return /iP(hone|ad|od)|Macintosh/.test(navigator.userAgent) && /Safari\//.test(navigator.userAgent) && !/Chrome\//.test(navigator.userAgent)
  return true
}

export function canDownload(f) {
  return !isFolder(f) && !isGoogleDoc(f) && f.capabilities?.canDownload !== false
}

export function driveUrl(f) {
  if (f.webViewLink) return f.webViewLink
  return isFolder(f) ? `https://drive.google.com/drive/folders/${encodeURIComponent(f.id)}` : `https://drive.google.com/file/d/${encodeURIComponent(f.id)}/view`
}

/** Miniatura do Google no tamanho pedido: troca o "=s220" do fim pelo tamanho certo (em pixels de tela). */
export function sizedThumb(link, px) {
  if (!link) return null
  const n = Math.max(64, Math.min(2400, Math.round(px)))
  if (/=s\d+(-[\w-]+)?$/.test(link)) return link.replace(/=s\d+(-[\w-]+)?$/, `=s${n}`)
  if (/[?&]sz=w\d+/.test(link)) return link.replace(/([?&]sz=)w\d+/, `$1w${n}`)
  return link
}

// ───── listagem ─────

/**
 * Uma página de um lugar do Drive.
 * where = { scope: 'mine'|'shared'|'drives', folder: { id, name } | null, driveId, search }
 * Devolve { files, next } (next = pageToken ou null).
 */
export async function listPage(where, { sort = 'name', flip = false, pageToken, signal } = {}) {
  const { scope, folder, driveId, search } = where
  const clean = (search || '').trim()
  const parts = ['trashed = false']
  const query = { supportsAllDrives: true, includeItemsFromAllDrives: true, pageSize: PAGE, pageToken, fields: `nextPageToken,files(${FILE_FIELDS})` }
  if (clean) parts.push(`name contains '${q(clean)}'`)
  if (folder) {
    if (!clean) parts.push(`'${q(folder.id)}' in parents`)
  } else if (scope === 'mine') {
    if (!clean) parts.push(`'root' in parents`)
  } else if (scope === 'shared') {
    parts.push('sharedWithMe = true')
  }
  if (driveId) Object.assign(query, { corpora: 'drive', driveId })
  else if (scope === 'drives' && clean) query.corpora = 'allDrives'
  query.q = parts.join(' and ')
  const s = SORTS[sort] || SORTS.name
  query.orderBy = flip ? s.desc : s.order
  let r
  try {
    r = await driveCall('/files', { query, signal })
  } catch (err) {
    // Alguns lugares (busca em todos os Drives, Compartilhados comigo) recusam certas ordens: ordena aqui.
    if (err?.status !== 400 || !query.orderBy) throw err
    delete query.orderBy
    r = await driveCall('/files', { query, signal })
    r.files = sortLocal(r.files || [], sort, flip)
  }
  return { files: r.files || [], next: r.nextPageToken || null }
}

export function sortLocal(files, sort, flip) {
  const coll = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true })
  const by = {
    name: (a, b) => coll.compare(a.name, b.name),
    date: (a, b) => String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')),
    size: (a, b) => (Number(b.size) || 0) - (Number(a.size) || 0),
  }[sort] || ((a, b) => coll.compare(a.name, b.name))
  const dir = flip ? -1 : 1
  return [...files].sort((a, b) => Number(isFolder(b)) - Number(isFolder(a)) || dir * by(a, b))
}

/** Drives compartilhados da conta, como "pastas" da raiz. */
export async function listDrives(signal) {
  const out = []
  let pageToken
  do {
    const r = await driveCall('/drives', { query: { pageSize: 100, pageToken, fields: 'nextPageToken,drives(id,name)' }, signal })
    for (const d of r.drives || []) out.push({ id: d.id, name: d.name, mimeType: FOLDER_MIME, isDrive: true, driveId: d.id })
    pageToken = r.nextPageToken
  } while (pageToken)
  return out
}

/** Metadados de um arquivo só (alvo de atalho, por exemplo). */
export function getFile(id, signal) {
  return driveCall(`/files/${encodeURIComponent(id)}`, { query: { supportsAllDrives: true, fields: FILE_FIELDS }, signal })
}

// ───── tamanho das pastas ─────

/**
 * Tamanho de uma pasta (o Drive não guarda): soma a árvore com listagens mínimas, 4 de cada vez (lib/tamanho.js).
 * folder = { id }; `driveId` = drive compartilhado onde ela mora (corpora=drive). Atalhos não são seguidos.
 * Devolve { bytes, files, folders, docs, shortcuts }; cancelada, rejeita com AbortError e `err.partial`.
 */
export function folderSize(folder, { driveId = null, signal, onProgress } = {}) {
  return walkFolderSize({ listPage: pageLister(driveCall, driveId || folder.driveId || null), rootId: folder.id, signal, onProgress, concurrency: 4 })
}

/** Contas desta sessão (uma por pasta, guardadas enquanto a página está aberta). */
export const folderSizes = new FolderSizes({ walk: (folder, opts) => folderSize(folder, opts) })

// ───── proxy de câmera ─────
//
// Bruto que o navegador não toca (BRAW, R3D, ARRI, MXF, ProRes que falhou): procura um proxy com o mesmo nome-base
// em .mp4/.mov/.m4v na mesma pasta ou numa subpasta irmã "Proxy"/"Proxies" (como as câmeras Blackmagic gravam:
// A001_08221425_C001.braw + Proxy/A001_08221425_C001.mp4). Só ao abrir a prévia; cache por pasta e por arquivo.

const PROXY_EXT = ['mp4', 'mov', 'm4v']
const PROXY_DIRS = ['proxy', 'proxies']
const proxyDirs = new Map() // pasta → Promise<[ids das subpastas Proxy]>
const proxies = new Map() // arquivo → Promise<proxy|null>
const proxyDone = new Map() // arquivo → proxy|null (já resolvido)

export function baseName(name = '') {
  const i = name.lastIndexOf('.')
  return (i > 0 ? name.slice(0, i) : name).normalize('NFC').toLowerCase()
}

/** Este arquivo serve de proxy de `orig`? (mesmo nome-base, outro arquivo, extensão de vídeo comum). */
export function isProxyOf(cand, orig) {
  return cand.id !== orig.id && !isFolder(cand) && PROXY_EXT.includes(extOf(cand.name)) && baseName(cand.name) === baseName(orig.name)
}

/** Cópia leve gerada pelo app de computador (Proxy/<nome>.mp4, appProperties.sobedesce = 'previa'). */
export const isPrevia = (f) => f?.appProperties?.sobedesce === 'previa'

/** Vídeo grande (qualquer codec): a prévia procura antes a cópia leve e toca ela, fluida como no Drive. */
export const LITE_MIN = 30e6
export function wantsLite(f) {
  return kindOf(f) === 'video' && Number(f.size || 0) > LITE_MIN && !isPrevia(f)
}

/** Vale procurar proxy? (vídeo que o navegador não toca; `failed` = tocou e deu erro de formato). */
export function wantsProxy(f, failed = false) {
  return kindOf(f) === 'video' && (failed || !mayPlay(f))
}

const sameFolder = (a, b) => (a.parents?.[0] || null) === (b.parents?.[0] || null)

function dirsOf(parentId, driveId, signal) {
  const key = `${driveId || ''}:${parentId}`
  if (!proxyDirs.has(key)) {
    const query = {
      q: `'${q(parentId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false and (${PROXY_DIRS.map((n) => `name = '${n}'`).join(' or ')})`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 10,
      fields: 'files(id,name)',
    }
    if (driveId) Object.assign(query, { corpora: 'drive', driveId })
    const p = driveCall('/files', { query, signal }).then(
      (r) => (r.files || []).filter((d) => PROXY_DIRS.includes(d.name.toLowerCase())).map((d) => d.id),
      (err) => {
        proxyDirs.delete(key)
        throw err
      },
    )
    proxyDirs.set(key, p)
  }
  return proxyDirs.get(key)
}

/** O proxy de `f` (ou null). `siblings` = arquivos da mesma pasta já carregados na tela (evita uma consulta). */
export function findProxy(f, siblings = [], signal) {
  const key = `${f.id}:${f.modifiedTime || ''}`
  if (proxies.has(key)) return proxies.get(key)
  const parent = f.parents?.[0]
  const local = siblings.filter((c) => isProxyOf(c, f) && sameFolder(c, f))
  const pick = (list) => list.sort((a, b) => PROXY_EXT.indexOf(extOf(a.name)) - PROXY_EXT.indexOf(extOf(b.name)))[0] || null
  const p = (async () => {
    if (local.length) return pick(local)
    if (!parent) return null
    const dirs = await dirsOf(parent, f.driveId, signal)
    const where = [parent, ...dirs].map((id) => `'${q(id)}' in parents`).join(' or ')
    const query = {
      q: `name contains '${q(baseName(f.name))}' and trashed = false and (${where})`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 50,
      fields: `files(${FILE_FIELDS})`,
    }
    if (f.driveId) Object.assign(query, { corpora: 'drive', driveId: f.driveId })
    const r = await driveCall('/files', { query, signal })
    return pick((r.files || []).filter((c) => isProxyOf(c, f)))
  })().then(
    (v) => (proxyDone.set(key, v), v),
    (err) => {
      proxies.delete(key)
      throw err
    },
  )
  proxies.set(key, p)
  return p
}

/** Proxy já conhecido (sem consultar): da prévia aberta antes ou da mesma pasta na tela. */
export function knownProxy(f, siblings = []) {
  const key = `${f.id}:${f.modifiedTime || ''}`
  if (proxyDone.has(key)) return proxyDone.get(key)
  return siblings.find((c) => isProxyOf(c, f) && sameFolder(c, f)) || null
}
