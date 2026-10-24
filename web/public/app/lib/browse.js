// Navegar no Drive (aba Drive): listar pastas e arquivos com miniatura, buscar por nome, ordenar e filtrar por tipo.
// Quase tudo é só leitura. A única escrita é macJunkTrash (arquivos ._ do Mac para a lixeira), e só depois da
// confirmação na tela. Usa o mesmo token da conta (lib/auth.js) e o mesmo `call` do envio.
import { FOLDER_MIME, driveCall, q, trashFile } from './drive.js'
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
  'capabilities(canDownload,canAddChildren,canTrash,canRename,canEdit,canMoveItemWithinDrive)',
  'appProperties',
].join(',')

/** Escopos da raiz: Meu Drive, Compartilhados comigo e Drives compartilhados. */
export const SCOPES = [
  { id: 'mine', label: 'Meu Drive', aria: 'Meu Drive' },
  { id: 'shared', label: 'Comigo', aria: 'Compartilhados comigo' },
  { id: 'drives', label: 'Drives', aria: 'Drives compartilhados' },
]

// Ordens. Pastas sempre primeiro ('folder' no orderBy do Drive; sortLocal faz o mesmo). `hint` e `chip`: [padrão,
// invertida]. O Drive não ordena por tipo/extensão no servidor: 'type' pede por nome e agrupa aqui, no aparelho, e a
// tela carrega a pasta toda antes (senão a ordem mudaria a cada página que chega). Ver needsAll.
export const SORTS = {
  name: { label: 'Nome', order: 'folder,name_natural', desc: 'folder,name_natural desc', hint: ['A → Z', 'Z → A'], chip: ['Nome A→Z', 'Nome Z→A'] },
  date: { label: 'Modificado', order: 'folder,modifiedTime desc', desc: 'folder,modifiedTime', hint: ['Mais recentes', 'Mais antigos'], chip: ['Mais recentes', 'Mais antigos'] },
  size: { label: 'Tamanho', order: 'folder,quotaBytesUsed desc', desc: 'folder,quotaBytesUsed', hint: ['Maiores', 'Menores'], chip: ['Maiores', 'Menores'] },
  type: { label: 'Tipo', order: null, desc: null, hint: ['Por extensão, A → Z', 'Por extensão, Z → A'], chip: ['Tipo A→Z', 'Tipo Z→A'] },
}

/** Rótulo curto da ordem atual, para o chip ("Nome A→Z", "Mais recentes", "Maiores"…). */
export function sortChip(sort, flip) {
  return (SORTS[sort] || SORTS.name).chip[flip ? 1 : 0]
}

/** Ordem que vai para o Drive: 'type' não existe lá, então pede por nome (e a tela agrupa). */
export function serverSort(sort, flip) {
  return SORTS[sort]?.order ? { sort, flip: !!flip } : { sort: 'name', flip: false }
}

/** A ordem só fica certa com a pasta toda carregada? (ordenada no aparelho, não no Drive). */
export const needsAll = (sort) => Boolean(SORTS[sort]) && !SORTS[sort].order

// ───── preferências do aparelho (grade/lista e ordem) ─────
//
// view: 'grid' | 'list' quando a pessoa escolheu no botão; null = automático (autoView): lista numa pasta só de
// pastas, grade quando há foto ou vídeo. Antes da 2.6 a grade era o padrão e o app guardava 'grid' junto com a ordem,
// mesmo sem ninguém escolher; por isso só vale o que veio com viewSet (ou 'list', que só existia escolhendo).

const PREFS_KEY = 'sobedesce.browse'
export function getPrefs() {
  const p = local.get(PREFS_KEY) || {}
  const chosen = p.view === 'list' || (p.viewSet === true && p.view === 'grid')
  return {
    view: chosen ? p.view : null,
    sort: SORTS[p.sort] ? p.sort : 'name',
    flip: p.flip === true,
  }
}
export function savePrefs(p) {
  local.set(PREFS_KEY, { view: p.view || null, viewSet: Boolean(p.view), sort: p.sort, flip: !!p.flip })
}

/** Grade ou lista para o que está na tela: grade se tem foto ou vídeo (as miniaturas ajudam), lista se não. */
export function autoView(files) {
  return (files || []).some((f) => {
    const k = kindOf(f)
    return k === 'video' || k === 'image'
  })
    ? 'grid'
    : 'list'
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

// ───── filtro por tipo (chips Tudo · Vídeos · Fotos · Áudio · Pastas · Outros) ─────
//
// Em duas partes. No Drive, o `q` por mimeType já tira o grosso (uma pasta de BRAW filtrada em Fotos nem baixa os
// BRAW). Mas o Drive marca BRAW, R3D, ARRI e cia. como application/octet-stream: esses passam no `q` de vídeo, foto e
// áudio, e quem decide é a extensão, aqui no aparelho (categoryOf). Por isso o `q` é sempre um SUPERCONJUNTO do que
// categoryOf aceita, e a tela segue carregando páginas enquanto o filtro daqui esconde quase tudo.

export const FILTERS = [
  { id: 'all', label: 'Tudo' },
  { id: 'video', label: 'Vídeos', one: 'vídeo', many: 'vídeos', none: 'Nenhum vídeo aqui' },
  { id: 'image', label: 'Fotos', one: 'foto', many: 'fotos', none: 'Nenhuma foto aqui' },
  { id: 'audio', label: 'Áudio', one: 'áudio', many: 'áudios', none: 'Nenhum áudio aqui' },
  { id: 'folder', label: 'Pastas', one: 'pasta', many: 'pastas', none: 'Nenhuma pasta aqui' },
  { id: 'other', label: 'Outros', one: 'outro arquivo', many: 'outros arquivos', none: 'Nenhum outro arquivo aqui' },
]
export const filterById = (id) => FILTERS.find((x) => x.id === id) || FILTERS[0]

// Tipos "sem tipo" (o Drive não reconheceu): aí vale a extensão. Os de mídia (video/, image/, audio/) valem pelo tipo.
const BINARY = ['application/octet-stream', 'binary/octet-stream', 'application/mxf', 'application/x-mxf']
const MEDIA = ['video', 'audio', 'image']

/** 'folder' | 'video' | 'image' | 'audio' | 'other': em que chip o item aparece. */
export function categoryOf(f) {
  if (isFolder(f)) return 'folder'
  const mime = (f?.mimeType === SHORTCUT_MIME ? f.shortcutDetails?.targetMimeType : f?.mimeType) || ''
  const byMime = MEDIA.find((k) => mime.startsWith(`${k}/`))
  if (byMime) return byMime
  if (mime && !BINARY.includes(mime)) return 'other'
  const k = kindOf({ ...f, mimeType: mime })
  return MEDIA.includes(k) ? k : 'other'
}

export const matchesFilter = (f, id) => !id || id === 'all' || categoryOf(f) === id

/** O pedaço do `q` do Drive para o filtro (superconjunto de categoryOf; '' = sem filtro no servidor). */
export function filterQuery(id) {
  const loose = [...BINARY, SHORTCUT_MIME].map((m) => `mimeType = '${m}'`)
  if (MEDIA.includes(id)) return `(mimeType contains '${id}/' or ${loose.join(' or ')})`
  if (id === 'folder') return `(mimeType = '${FOLDER_MIME}' or mimeType = '${SHORTCUT_MIME}')`
  if (id === 'other') return `mimeType != '${FOLDER_MIME}' and ${MEDIA.map((k) => `not mimeType contains '${k}/'`).join(' and ')}`
  return ''
}

// ───── arquivos do Mac (._* e .DS_Store) ─────
//
// O Finder grava, em discos que não são do Mac, um "._nome" (AppleDouble: ícone, etiquetas, metadados) ao lado de cada
// arquivo, e um .DS_Store por pasta. Quem copia o cartão inteiro para o Drive leva junto. Ficam ocultos por padrão.
// Para a lixeira só vão os ._ pequenos (MAC_JUNK_MAX): um ._ de verdade tem de 4 KB a algumas centenas de KB; um
// arquivo grande com nome começando em "._" pode ser outra coisa e fica onde está.

export const MAC_JUNK_MAX = 4e6 // 4 MB (decimal, como o resto do app)

/** ._qualquer-coisa ou .DS_Store (só arquivos; pastas nunca). */
export function isMacJunk(f) {
  if (!f || isFolder(f) || isGoogleDoc(f)) return false
  const n = String(f.name || '')
  return n.startsWith('._') || n === '.DS_Store'
}

/** Pode ir para a lixeira pelo botão: começa com "._", tem tamanho conhecido e menor que 4 MB. */
export function isTrashableJunk(f) {
  if (!f || isFolder(f) || isGoogleDoc(f) || f.mimeType === SHORTCUT_MIME) return false
  const size = Number(f.size)
  return String(f.name || '').startsWith('._') && f.size != null && Number.isFinite(size) && size < MAC_JUNK_MAX
}

/**
 * Os ._ de uma pasta (só os filhos diretos), para a folha de confirmação: lista a pasta toda com o mínimo de campos,
 * em páginas de 1000. Devolve [{ id, name, size, canTrash }].
 */
export async function macJunkIn(folder, { driveId = null, signal } = {}) {
  const out = []
  let pageToken
  do {
    const query = {
      q: `'${q(folder.id)}' in parents and trashed = false`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 1000,
      pageToken,
      fields: 'nextPageToken,files(id,name,size,mimeType,parents,capabilities(canTrash))',
    }
    const d = driveId || folder.driveId || null
    if (d) Object.assign(query, { corpora: 'drive', driveId: d })
    const r = await driveCall('/files', { query, signal })
    for (const f of r.files || []) {
      if (!isTrashableJunk(f) || (f.parents && !f.parents.includes(folder.id))) continue
      out.push({ id: f.id, name: f.name, size: Number(f.size), canTrash: f.capabilities?.canTrash !== false })
    }
    pageToken = r.nextPageToken
  } while (pageToken)
  return out
}

/**
 * Move para a lixeira (files.update trashed=true, recuperável por 30 dias), 3 de cada vez. Confere de novo cada item
 * (nome ._ e < 4 MB) antes de mexer. onProgress({ done, moved, refused, failed }). Cancelado (signal), para de pedir
 * novos e devolve o que já foi. Devolve { moved: [ids], refused, failed, reason }.
 */
export async function macJunkTrash(items, { signal, onProgress } = {}) {
  const list = items.filter((f) => isTrashableJunk(f))
  const res = { moved: [], refused: 0, failed: 0, reason: null, skipped: items.length - list.length }
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < list.length && !signal?.aborted) {
      const f = list[next++]
      try {
        await trashFile(f.id, signal)
        res.moved.push(f.id)
      } catch (err) {
        if (signal?.aborted) break
        if (err?.status === 403 || err?.status === 404) {
          res.refused++
          res.reason = res.reason || err.reason || 'forbidden'
        } else res.failed++
      }
      done++
      onProgress?.({ done, total: list.length, moved: res.moved.length, refused: res.refused, failed: res.failed })
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker))
  return res
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
// O Drive aceitou o filtro por tipo no `q`? (se recusar uma vez, os próximos pedidos já vão sem ele).
let kindQueryOk = true

export async function listPage(where, { sort = 'name', flip = false, filter = 'all', pageToken, pageSize = PAGE, signal } = {}) {
  const { scope, folder, driveId, search } = where
  const clean = (search || '').trim()
  const parts = ['trashed = false']
  const query = { supportsAllDrives: true, includeItemsFromAllDrives: true, pageSize, pageToken, fields: `nextPageToken,files(${FILE_FIELDS})` }
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
  const fq = kindQueryOk ? filterQuery(filter) : ''
  query.q = [...parts, fq].filter(Boolean).join(' and ')
  const srv = serverSort(sort, flip)
  const s = SORTS[srv.sort] || SORTS.name
  query.orderBy = srv.flip ? s.desc : s.order
  // Recusas (400) que dá para contornar, uma de cada vez: o filtro por tipo no `q` (a tela filtra do mesmo jeito,
  // só carrega mais) e a ordem (alguns lugares, como a busca em todos os Drives e Compartilhados comigo, recusam
  // certas ordens: ordena aqui).
  for (;;) {
    try {
      const r = await driveCall('/files', { query, signal })
      // A tira de quadros do segurar-e-arrastar (Proxy/<nome>.quadros.jpg) é peça interna do app: fica fora da lista.
      const files = (r.files || []).filter((f) => f.appProperties?.sobedesce !== 'quadros')
      return { files: query.orderBy ? files : sortLocal(files, srv.sort, srv.flip), next: r.nextPageToken || null }
    } catch (err) {
      if (err?.status !== 400) throw err
      if (fq && query.q.includes(fq)) {
        kindQueryOk = false
        query.q = parts.join(' and ')
      } else if (query.orderBy) delete query.orderBy
      else throw err
    }
  }
}

const extKey = (f) => (isFolder(f) ? '' : extOf(f.name) || '\uffff')

export function sortLocal(files, sort, flip) {
  const coll = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true })
  const byName = (a, b) => coll.compare(a.name, b.name)
  const dir = flip ? -1 : 1
  const by = {
    name: (a, b) => dir * byName(a, b),
    date: (a, b) => dir * String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')),
    size: (a, b) => dir * ((Number(b.size) || 0) - (Number(a.size) || 0)),
    // Por tipo: agrupa pela extensão (sem extensão vai para o fim); dentro do grupo, sempre por nome, A → Z.
    type: (a, b) => dir * extKey(a).localeCompare(extKey(b)) || byName(a, b),
  }[sort] || ((a, b) => dir * byName(a, b))
  return [...files].sort((a, b) => Number(isFolder(b)) - Number(isFolder(a)) || by(a, b))
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
