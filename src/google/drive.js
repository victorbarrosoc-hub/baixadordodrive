// Cliente do Google Drive v3 para metadados: listar, varrer árvores, criar pastas, caminhos.
// O conteúdo (download/upload) passa pelos motores; daqui saem só as URLs e o cabeçalho de autorização.
// Detalhes do Google que mordem (docs/GOOGLE-NOTES.md): `fields` sempre explícito, supportsAllDrives em todo
// files.*, includeItemsFromAllDrives na listagem, lixeira incluída por padrão, `name =` sem diferenciar maiúsculas.
import { endpoints } from '../config.js'
import { requestJSON } from '../net/http.js'
import { abortError, backoffDelay, sleep } from '../util/backoff.js'
import { joinRel, splitRel, toNFC } from '../util/paths.js'
import { classifyError } from './errors.js'

export const FOLDER_MIME = 'application/vnd.google-apps.folder'
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'
const GAPPS_PREFIX = 'application/vnd.google-apps.'

export const FILE_FIELDS =
  'id,name,mimeType,size,md5Checksum,modifiedTime,headRevisionId,resourceKey,parents,driveId,' +
  'shortcutDetails(targetId,targetMimeType,targetResourceKey),capabilities(canDownload)'

/** Docs nativos do Google viram arquivos do Office (ou PNG) ao baixar. Os outros google-apps não são baixáveis. */
export const GOOGLE_EXPORTS = Object.freeze({
  'application/vnd.google-apps.document': Object.freeze({ mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' }),
  'application/vnd.google-apps.spreadsheet': Object.freeze({ mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' }),
  'application/vnd.google-apps.presentation': Object.freeze({ mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' }),
  'application/vnd.google-apps.drawing': Object.freeze({ mime: 'image/png', ext: '.png' }),
})

/** Campos extras para navegar e ver a prévia (miniatura, dimensões, dono). Não entram nas varreduras grandes. */
export const MEDIA_FIELDS =
  'hasThumbnail,thumbnailLink,iconLink,webViewLink,owners(displayName,emailAddress),' +
  'videoMediaMetadata(width,height,durationMillis),' +
  'imageMediaMetadata(width,height,rotation,time,cameraMake,cameraModel,exposureTime,aperture,isoSpeed,focalLength)'
export const BROWSE_FIELDS = `${FILE_FIELDS},${MEDIA_FIELDS}`

const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`
const BROWSE_LIST_FIELDS = `nextPageToken,files(${BROWSE_FIELDS})`
const ABOUT_FIELDS = 'user(displayName,emailAddress,permissionId,photoLink),storageQuota(limit,usage,usageInDrive)'
const PAGE_SIZE = 1000
const SEARCH_LIMIT = 200
const MAX_RETRY_WAIT_MS = 120_000
const FOLDER_CACHE_TTL_MS = 5 * 60_000
const MAX_CACHED_FOLDERS = 20_000
const PROGRESS_MS = 200 // walk: no máximo 5 avisos de progresso por segundo
const ENSURE_TRIES = 6
const MY_DRIVE_NAME = 'Meu Drive'
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024 // limite do Drive para contentHints.thumbnail
const THUMBNAIL_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif'])
// Sem conexão nenhuma (sem DNS, sem rota, conexão recusada): recuo longo não ajuda e deixava a tela do Drive
// girando ~45 s antes de dizer "confira a internet". Repete a cada ~1 s só por uma janela curta (pega o Wi-Fi que
// pisca); quem roda em segundo plano (download/upload) já tem a própria espera longa.
const OFFLINE_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'ECONNREFUSED'])
const OFFLINE_WINDOW_MS = 8000

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' })

/** Escapa um valor para ir entre aspas simples no `q` do Drive (\ e '). */
export function escapeQueryValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/** Normaliza o File JSON do Google no formato DriveItem do app. */
export function toDriveItem(f) {
  const mimeType = f?.mimeType || 'application/octet-stream'
  const isFolder = mimeType === FOLDER_MIME
  const isShortcut = mimeType === SHORTCUT_MIME
  const isGoogleDoc = !isFolder && !isShortcut && mimeType.startsWith(GAPPS_PREFIX)
  const n = f?.size != null && f.size !== '' ? Number(f.size) : NaN
  return {
    id: f.id,
    name: f.name ?? '',
    mimeType,
    // Docs nativos informam o espaço que ocupam, não o tamanho do arquivo exportado: melhor null.
    size: isFolder || isShortcut || isGoogleDoc || !Number.isFinite(n) ? null : n,
    md5: f.md5Checksum ?? null,
    modifiedTime: f.modifiedTime ?? null,
    headRevisionId: f.headRevisionId ?? null,
    resourceKey: f.resourceKey ?? null,
    canDownload: f.capabilities?.canDownload !== false,
    parents: Array.isArray(f.parents) ? [...f.parents] : [],
    driveId: f.driveId ?? null,
    isFolder,
    isGoogleDoc,
    isShortcut,
    shortcutTargetId: f.shortcutDetails?.targetId ?? null,
    shortcutTargetMimeType: f.shortcutDetails?.targetMimeType ?? null,
    shortcutTargetResourceKey: f.shortcutDetails?.targetResourceKey ?? null,
    ...mediaInfo(f),
  }
}

const num = v => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null)

/** Campos de prévia (só quando a resposta trouxe: as varreduras não pedem e o DriveItem fica como era). */
function mediaInfo(f) {
  if (!f || (f.hasThumbnail === undefined && f.thumbnailLink === undefined && !f.videoMediaMetadata && !f.imageMediaMetadata && !f.owners && !f.webViewLink)) return {}
  const out = { hasThumbnail: Boolean(f.hasThumbnail && f.thumbnailLink), thumbnailLink: f.thumbnailLink ?? null }
  if (f.iconLink) out.iconLink = f.iconLink
  if (f.webViewLink) out.webViewLink = f.webViewLink
  const owner = Array.isArray(f.owners) ? f.owners[0] : null
  if (owner) out.owner = { name: owner.displayName ?? null, email: owner.emailAddress ?? null }
  const v = f.videoMediaMetadata
  const i = f.imageMediaMetadata
  if (v) out.video = { width: num(v.width), height: num(v.height), durationMs: num(v.durationMillis) }
  if (i) {
    const image = { width: num(i.width), height: num(i.height) }
    if (num(i.rotation)) image.rotation = num(i.rotation)
    if (i.time) image.time = String(i.time)
    const camera = [i.cameraMake, i.cameraModel].filter(Boolean).join(' ').trim()
    if (camera) image.camera = camera
    for (const k of ['exposureTime', 'aperture', 'isoSpeed', 'focalLength']) if (num(i[k]) != null) image[k] = num(i[k])
    out.image = image
  }
  return out
}

/** Itens antigos compartilhados por link exigem o resourceKey num cabeçalho, senão o Google responde 404. */
export function resourceKeyHeader(item) {
  return item?.resourceKey && item?.id ? { 'x-goog-drive-resource-keys': `${item.id}/${item.resourceKey}` } : {}
}

function sortItems(items) {
  return items.sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Nome de um nível do relPath: '/' dentro do nome viraria outro nível (e '..' sairia da pasta). */
function relSegment(name) {
  const s = toNFC(name).replace(/\//g, '_')
  return s === '' || s === '.' || s === '..' ? '_' : s
}

/** Espera `promise`, mas desiste (AbortError) se `signal` abortar. A promessa original segue sozinha. */
function abortable(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(abortError(signal))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      err => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

function isRateLimit(info) {
  return info.kind === 'retry' && (info.status === 429 || info.status === 403)
}

/**
 * Limitador das chamadas de metadados: no máximo N simultâneas e um balde de fichas (~20 req/s).
 * Em 403/429 de limite, corta pela metade (vagas e taxa) e volta a subir devagar depois de um resfriamento.
 */
export class MetadataLimiter {
  constructor({ maxConcurrent = 8, ratePerSec = 20, cooldownMs = 2000, recoverMs = 10_000 } = {}) {
    this.maxConcurrent = Math.max(1, Math.floor(maxConcurrent))
    this.maxRate = Math.max(0.1, ratePerSec)
    this.cooldownMs = cooldownMs
    this.recoverMs = Math.max(1, recoverMs) // tempo para ir de quase zero ao máximo
    this.minRate = Math.max(0.5, this.maxRate / 10) // nem o pior recuo deixa a navegação parada
    this.limitF = this.maxConcurrent
    this.limit = this.maxConcurrent
    this.rate = this.maxRate
    this.tokens = Math.max(1, this.maxRate) // começa com o balde cheio (1 s de rajada)
    this.active = 0
    this.cuts = 0
    this.lastCut = -Infinity
    this.lastTick = Date.now()
    this.waiters = []
  }

  #tick() {
    const now = Date.now()
    // Recuperação só conta depois do resfriamento do último corte.
    const from = Math.max(this.lastTick, this.lastCut + this.cooldownMs)
    if (now > from) {
      const dt = now - from
      if (this.rate < this.maxRate) this.rate = Math.min(this.maxRate, this.rate + (this.maxRate * dt) / this.recoverMs)
      if (this.limitF < this.maxConcurrent) {
        this.limitF = Math.min(this.maxConcurrent, this.limitF + (this.maxConcurrent * dt) / this.recoverMs)
        this.limit = Math.max(1, Math.floor(this.limitF))
      }
    }
    const elapsed = Math.max(0, now - this.lastTick)
    this.tokens = Math.min(Math.max(1, this.rate), this.tokens + (this.rate * elapsed) / 1000)
    this.lastTick = now
  }

  #pump() {
    while (this.waiters.length && this.active < this.limit) {
      const w = this.waiters.shift()
      w.cleanup()
      this.active++ // a vaga já sai reservada para quem foi acordado
      w.resolve()
    }
  }

  #enqueue(signal) {
    return new Promise((resolve, reject) => {
      const w = { resolve, cleanup: () => {} }
      if (signal) {
        const onAbort = () => {
          const i = this.waiters.indexOf(w)
          if (i >= 0) this.waiters.splice(i, 1)
          reject(abortError(signal))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        w.cleanup = () => signal.removeEventListener('abort', onAbort)
      }
      this.waiters.push(w)
    })
  }

  /** Espera vaga + ficha. Quem recebe precisa chamar release() exatamente uma vez. */
  async acquire(signal) {
    if (signal?.aborted) throw abortError(signal)
    this.#tick()
    if (this.active < this.limit && this.waiters.length === 0) this.active++
    else await this.#enqueue(signal)
    try {
      for (;;) {
        this.#tick()
        if (this.tokens >= 1) {
          this.tokens -= 1
          return
        }
        await sleep(Math.max(5, Math.ceil(((1 - this.tokens) * 1000) / this.rate)), signal)
      }
    } catch (err) {
      this.release()
      throw err
    }
  }

  release() {
    this.active = Math.max(0, this.active - 1)
    this.#tick()
    this.#pump()
  }

  /** O Google pediu calma (403/429 de limite). Erros dentro do mesmo resfriamento contam como um corte só. */
  penalize() {
    this.#tick()
    const now = Date.now()
    if (now - this.lastCut < this.cooldownMs) return
    this.lastCut = now
    this.cuts++
    this.rate = Math.max(this.minRate, this.rate / 2)
    this.limitF = Math.max(1, this.limitF / 2)
    this.limit = Math.max(1, Math.floor(this.limitF))
    this.tokens = Math.min(this.tokens, 0)
  }

  /** Estado atual (para testes e diagnóstico). */
  stats() {
    this.#tick()
    return { active: this.active, waiting: this.waiters.length, limit: this.limit, rate: this.rate, cuts: this.cuts }
  }
}

// Criações de pasta em andamento (promessa guardada no cache de ensureFolderPath) -> { controller, waiters, settled }.
const sharedLevels = new WeakMap()

// Um limitador por conta (e por AuthManager), compartilhado por todos os DriveClient dela: a cota do Google é por usuário.
const limiters = new WeakMap()

function limiterFor(auth, accountId, opts) {
  let byAccount = limiters.get(auth)
  if (!byAccount) limiters.set(auth, (byAccount = new Map()))
  const key = `${accountId}|${opts.maxConcurrent}|${opts.ratePerSec}`
  let limiter = byAccount.get(key)
  if (!limiter) byAccount.set(key, (limiter = new MetadataLimiter(opts)))
  return limiter
}

export class DriveClient {
  /**
   * @param {import('./oauth.js').AuthManager} auth
   * @param {string} accountId
   * @param {{ maxConcurrent?: number, ratePerSec?: number, retryBaseMs?: number, offlineWindowMs?: number }} [opts] ajustes finos (testes)
   */
  constructor(auth, accountId, { maxConcurrent = 8, ratePerSec = 20, retryBaseMs = 1000, offlineWindowMs = OFFLINE_WINDOW_MS } = {}) {
    this.auth = auth
    this.accountId = accountId
    this.retryBaseMs = retryBaseMs
    this.offlineWindowMs = offlineWindowMs
    this.limiter = limiterFor(auth, accountId, { maxConcurrent, ratePerSec })
    this.folderCache = new Map() // cache de ensureFolderPath quando quem chama não passa o seu
    this.folders = new Map() // id -> { id, name, parents, driveId, at } (caminhos e driveId para listar)
    this.driveNames = new Map() // driveId -> nome do drive compartilhado
    this.myDriveRootId = null
  }

  // ─────────── base ───────────

  #url(pathOrUrl, query) {
    const raw = String(pathOrUrl)
    const url = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(`${endpoints().driveApi.replace(/\/+$/, '')}/${raw.replace(/^\/+/, '')}`)
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    // Sem supportsAllDrives, itens de drives compartilhados "não existem" (404). URIs de sessão de upload não levam.
    if (/\/files(\/|$)/.test(url.pathname) && !url.searchParams.has('upload_id') && !url.searchParams.has('supportsAllDrives')) {
      url.searchParams.set('supportsAllDrives', 'true')
    }
    return url
  }

  /**
   * Chamada à API com JSON de volta. 401 → renova o token uma vez; 'retry' → recuo e repete até `retries` vezes.
   * Outros erros sobem como vieram (HttpError/SobeDesceError): quem chama classifica com classifyError.
   */
  async api(method, pathOrUrl, { query, body, headers, signal, expect = [200, 201, 204], retries = 6 } = {}) {
    const url = this.#url(pathOrUrl, query)
    let authRetried = false
    let rejected = null
    let offlineSince = 0
    for (let attempt = 0; ; ) {
      if (signal?.aborted) throw abortError(signal)
      const tokenPromise = rejected
        ? this.auth.getAccessToken(this.accountId, { forceRefresh: true, rejectedToken: rejected })
        : this.auth.getAccessToken(this.accountId)
      const token = await abortable(tokenPromise, signal)
      rejected = null
      await this.limiter.acquire(signal)
      let failure
      try {
        return await requestJSON(url, { method, body, signal, expect, headers: { ...(headers || {}), authorization: `Bearer ${token}` } })
      } catch (err) {
        failure = err
      } finally {
        this.limiter.release()
      }
      const info = classifyError(failure)
      if (info.kind === 'abort') throw failure
      if (info.kind === 'auth' && !authRetried) {
        authRetried = true
        rejected = token
        continue
      }
      if (info.kind !== 'retry' || attempt >= retries) throw failure
      if (isRateLimit(info)) this.limiter.penalize()
      const offline = OFFLINE_CODES.has(info.reason)
      if (offline) {
        offlineSince ||= Date.now()
        if (Date.now() - offlineSince >= this.offlineWindowMs) throw failure
      } else offlineSince = 0
      const backoff = offline ? Math.min(1000, this.retryBaseMs) : backoffDelay(attempt, { base: this.retryBaseMs })
      const wait = Math.min(MAX_RETRY_WAIT_MS, Math.max(backoff, info.retryAfterMs ?? 0))
      attempt++
      await sleep(wait, signal)
    }
  }

  /** Cabeçalho de autorização atual (para download/upload feitos pelos motores). */
  async authHeader({ forceRefresh = false } = {}) {
    const token = await this.auth.getAccessToken(this.accountId, { forceRefresh })
    return { authorization: `Bearer ${token}` }
  }

  mediaUrl(fileId) {
    const url = new URL(`${endpoints().driveApi.replace(/\/+$/, '')}/files/${encodeURIComponent(fileId)}`)
    url.searchParams.set('alt', 'media')
    url.searchParams.set('supportsAllDrives', 'true')
    url.searchParams.set('acknowledgeAbuse', 'false')
    return url.toString()
  }

  exportUrl(fileId, mimeType) {
    const url = new URL(`${endpoints().driveApi.replace(/\/+$/, '')}/files/${encodeURIComponent(fileId)}/export`)
    url.searchParams.set('mimeType', mimeType)
    url.searchParams.set('supportsAllDrives', 'true')
    return url.toString()
  }

  uploadInitUrl() {
    const url = new URL(`${endpoints().driveUpload.replace(/\/+$/, '')}/files`)
    url.searchParams.set('uploadType', 'resumable')
    url.searchParams.set('supportsAllDrives', 'true')
    url.searchParams.set('fields', FILE_FIELDS)
    return url.toString()
  }

  uploadUpdateUrl(fileId) {
    const url = new URL(`${endpoints().driveUpload.replace(/\/+$/, '')}/files/${encodeURIComponent(fileId)}`)
    url.searchParams.set('uploadType', 'resumable')
    url.searchParams.set('supportsAllDrives', 'true')
    url.searchParams.set('fields', FILE_FIELDS)
    return url.toString()
  }

  // ─────────── conta e drives ───────────

  async about({ signal } = {}) {
    const r = await this.api('GET', 'about', { query: { fields: ABOUT_FIELDS }, signal })
    const u = r.user || {}
    const q = r.storageQuota || {}
    return {
      user: { email: u.emailAddress ?? null, name: u.displayName ?? null, photoUrl: u.photoLink ?? null, permissionId: u.permissionId ?? null },
      quota: { limit: num(q.limit), usage: num(q.usage) ?? 0, usageInDrive: num(q.usageInDrive) ?? 0 },
    }
  }

  async listSharedDrives({ signal } = {}) {
    const out = []
    let pageToken
    do {
      const r = await this.api('GET', 'drives', { query: { pageSize: 100, fields: 'nextPageToken,drives(id,name)', pageToken }, signal })
      for (const d of r.drives || []) {
        out.push({ id: d.id, name: d.name })
        this.driveNames.set(d.id, d.name)
      }
      pageToken = r.nextPageToken
    } while (pageToken)
    return out
  }

  // ─────────── itens ───────────

  /** `resourceKey` (opcional) é a do próprio item, para itens antigos compartilhados por link. */
  /** `media: true` também traz miniatura, dimensões e dono (prévia). */
  async getItem(fileId, { signal, resourceKey, media = false } = {}) {
    const headers = resourceKey ? { 'x-goog-drive-resource-keys': `${fileId}/${resourceKey}` } : undefined
    const f = await this.api('GET', `files/${encodeURIComponent(fileId)}`, { query: { fields: media ? BROWSE_FIELDS : FILE_FIELDS }, headers, signal })
    const item = toDriveItem(f)
    this.#remember(item)
    if (fileId === 'root' && item.isFolder) this.myDriveRootId = item.id
    return item
  }

  #remember(item) {
    if (!item?.isFolder) return
    // Varreduras enormes passam por aqui: o cache tem teto (saem os mais antigos).
    if (this.folders.size >= MAX_CACHED_FOLDERS) {
      let drop = MAX_CACHED_FOLDERS / 4
      for (const key of this.folders.keys()) {
        if (drop-- <= 0) break
        this.folders.delete(key)
      }
    }
    this.folders.delete(item.id)
    this.folders.set(item.id, { id: item.id, name: item.name, parents: item.parents, driveId: item.driveId, at: Date.now() })
  }

  #cachedFolder(id) {
    const f = this.folders.get(id)
    if (!f) return null
    if (Date.now() - f.at > FOLDER_CACHE_TTL_MS) {
      this.folders.delete(id)
      return null
    }
    return f
  }

  /** driveId da pasta (null = Meu Drive). Busca o item se ainda não conhece. */
  async #driveIdOf(folderId, signal) {
    if (folderId === 'root' || folderId === this.myDriveRootId) return null
    if (this.driveNames.has(folderId)) return folderId
    const cached = this.#cachedFolder(folderId)
    if (cached) return cached.driveId
    return (await this.getItem(folderId, { signal })).driveId
  }

  /** files.list com todas as páginas (páginas curtas, até vazias, podem vir com nextPageToken). */
  async #list(q, { driveId = null, signal, limit = Infinity, pageSize = PAGE_SIZE, media = false } = {}) {
    const out = []
    let pageToken
    do {
      const query = {
        q,
        fields: media ? BROWSE_LIST_FIELDS : LIST_FIELDS,
        pageSize: Math.min(pageSize, PAGE_SIZE),
        includeItemsFromAllDrives: 'true',
        supportsAllDrives: 'true',
        pageToken,
      }
      if (driveId) {
        query.corpora = 'drive'
        query.driveId = driveId
      }
      const r = await this.api('GET', 'files', { query, signal })
      for (const f of r.files || []) {
        const item = toDriveItem(f)
        this.#remember(item)
        out.push(item)
        if (out.length >= limit) return out
      }
      pageToken = r.nextPageToken
    } while (pageToken)
    return out
  }

  #childrenQuery(folderId) {
    return `'${escapeQueryValue(folderId)}' in parents and trashed = false`
  }

  /** Filhos diretos (sem lixeira), pastas primeiro e depois por nome. `media: true` = campos da prévia (tela Drive). */
  async listChildren(folderId, { signal, media = false } = {}) {
    const driveId = await this.#driveIdOf(folderId, signal)
    const items = await this.#list(this.#childrenQuery(folderId), { driveId, signal, media })
    return sortItems(items)
  }

  async search(text, { signal, media = false } = {}) {
    const term = String(text ?? '').trim()
    if (!term) return []
    const q = `name contains '${escapeQueryValue(term)}' and trashed = false`
    const items = await this.#list(q, { signal, limit: SEARCH_LIMIT, pageSize: SEARCH_LIMIT, media })
    return sortItems(items)
  }

  /**
   * Filho com exatamente esse nome (o `name =` do Drive não diferencia maiúsculas: a conferência final é aqui).
   * `folder`: true = só pastas, false = só arquivos, null = qualquer um.
   */
  async findChild(parentId, name, { folder = null, signal, driveId } = {}) {
    const wanted = toNFC(name)
    let q = `'${escapeQueryValue(parentId)}' in parents and name = '${escapeQueryValue(wanted)}' and trashed = false`
    if (folder === true) q += ` and mimeType = '${FOLDER_MIME}'`
    else if (folder === false) q += ` and mimeType != '${FOLDER_MIME}'`
    const did = driveId !== undefined ? driveId : await this.#driveIdOf(parentId, signal)
    const items = await this.#list(q, { driveId: did, signal })
    return items.find(it => toNFC(it.name) === wanted) ?? null
  }

  /** `retries` (opcional): criar não é idempotente; ensureFolderPath usa 0 e confere antes de repetir. */
  async createFolder(name, parentId, { signal, retries } = {}) {
    const f = await this.api('POST', 'files', {
      query: { fields: FILE_FIELDS },
      body: { name: toNFC(name), mimeType: FOLDER_MIME, parents: [parentId] },
      signal,
      retries,
    })
    const item = toDriveItem(f)
    this.#remember(item)
    return item
  }

  /**
   * Grava uma miniatura nossa no arquivo (`contentHints.thumbnail`, files.update). O Drive só mostra quando não
   * consegue gerar a dele (ex.: .braw) e descarta quando o conteúdo do arquivo muda. Imagem PNG/JPEG/GIF até 2 MB,
   * em base64 "URL-safe" (RFC 4648 §5). Repete como as outras chamadas (`api`).
   */
  async setThumbnail(fileId, image, mimeType = 'image/jpeg', { signal, retries } = {}) {
    if (!Buffer.isBuffer(image) || !image.length) throw new Error('Miniatura vazia.')
    if (image.length > MAX_THUMBNAIL_BYTES) throw new Error('Miniatura maior que 2 MB.')
    if (!THUMBNAIL_MIMES.has(mimeType)) throw new Error(`Tipo de miniatura não aceito: ${mimeType}`)
    const b64 = image.toString('base64url')
    const r = await this.api('PATCH', `files/${encodeURIComponent(fileId)}`, {
      query: { fields: 'id,hasThumbnail' },
      body: { contentHints: { thumbnail: { image: b64 + '='.repeat((4 - (b64.length % 4)) % 4), mimeType } } },
      signal,
      retries,
    })
    return { id: r.id ?? fileId, hasThumbnail: r.hasThumbnail === true }
  }

  /**
   * Garante cada nível de `relDir` dentro de `rootId` e devolve o id da última pasta.
   * `cache` (Map) guarda uma promessa por `${rootId}/${prefixo}`: 50 uploads na mesma pasta nova criam a pasta uma vez só.
   */
  async ensureFolderPath(rootId, relDir, { signal, cache = this.folderCache, driveId } = {}) {
    if (signal?.aborted) throw abortError(signal)
    const parts = splitRel(toNFC(relDir))
    let parentId = rootId
    let prefix = ''
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part
      const key = `${rootId}/${prefix}`
      let p = cache.get(key)
      let entry = p ? sharedLevels.get(p) : null
      if (!p || entry?.controller.signal.aborted) {
        // A criação é compartilhada: não usa o signal de quem pediu primeiro (a pausa dele não pode
        // derrubar os outros). Ela só é cancelada quando TODOS que esperavam por ela desistiram.
        const controller = new AbortController()
        const level = this.#ensureLevel(parentId, part, driveId, controller.signal)
        entry = { controller, waiters: 0, settled: false }
        sharedLevels.set(level, entry)
        cache.set(key, level)
        level.then(
          () => {
            entry.settled = true
          },
          () => {
            entry.settled = true
            if (cache.get(key) === level) cache.delete(key) // a próxima chamada tenta de novo
          },
        )
        p = level
      }
      parentId = await this.#joinLevel(p, entry, signal, () => {
        if (cache.get(key) === p) cache.delete(key)
      })
    }
    return parentId
  }

  async #joinLevel(p, entry, signal, forget) {
    if (!entry) return abortable(p, signal) // promessa posta no cache por outra pessoa: só espera
    entry.waiters++
    try {
      return await abortable(p, signal)
    } finally {
      entry.waiters--
      if (entry.waiters === 0 && !entry.settled) {
        // Ninguém mais espera (todos pausaram): sai do cache já, para quem chegar depois não pegar a promessa cancelada.
        forget()
        entry.controller.abort()
      }
    }
  }

  async #ensureLevel(parentId, name, driveId, signal) {
    for (let attempt = 0; ; attempt++) {
      try {
        // Sempre procura antes de criar: se um "criar" anterior deu erro mas chegou ao Google, a pasta já está lá.
        const found = await this.findChild(parentId, name, { folder: true, driveId, signal })
        if (found) return found.id
        return (await this.createFolder(name, parentId, { retries: 0, signal })).id
      } catch (err) {
        const info = classifyError(err)
        if (info.kind !== 'retry' || attempt + 1 >= ENSURE_TRIES) throw err
        if (isRateLimit(info)) this.limiter.penalize()
        await sleep(Math.min(MAX_RETRY_WAIT_MS, Math.max(backoffDelay(attempt, { base: this.retryBaseMs }), info.retryAfterMs ?? 0)), signal)
      }
    }
  }

  // ─────────── caminho (breadcrumb) ───────────

  async #folderInfo(id, signal) {
    const cached = this.#cachedFolder(id)
    if (cached) return cached
    const item = await this.getItem(id, { signal })
    return { id: item.id, name: item.name, parents: item.parents, driveId: item.driveId }
  }

  async #driveName(driveId, signal) {
    if (this.driveNames.has(driveId)) return this.driveNames.get(driveId)
    try {
      const d = await this.api('GET', `drives/${encodeURIComponent(driveId)}`, { query: { fields: 'id,name' }, signal })
      if (d?.name) this.driveNames.set(driveId, d.name)
      return d?.name ?? null
    } catch (err) {
      if (classifyError(err).kind === 'abort') throw err
      return null
    }
  }

  async #myDriveRoot(signal) {
    if (!this.myDriveRootId) await this.getItem('root', { signal })
    return this.myDriveRootId
  }

  /** Da raiz até a pasta (inclusive): [{ id, name }]. Meu Drive vira { id: 'root', name: 'Meu Drive' }. */
  async getPath(folderId, { signal } = {}) {
    const crumbs = []
    const seen = new Set()
    let id = folderId
    for (let depth = 0; depth < 100; depth++) {
      if (id === 'root') {
        crumbs.push({ id: 'root', name: MY_DRIVE_NAME })
        break
      }
      let info
      try {
        info = await this.#folderInfo(id, signal)
      } catch (err) {
        // Pai que a conta não enxerga (pasta compartilhada comigo): o caminho começa onde dá para ver.
        const kind = classifyError(err).kind
        if (depth > 0 && (kind === 'notfound' || kind === 'fatal')) break
        throw err
      }
      if (seen.has(info.id)) break
      seen.add(info.id)
      if (!info.parents.length) {
        if (info.driveId && info.driveId === info.id) {
          crumbs.push({ id: info.id, name: (await this.#driveName(info.id, signal)) ?? info.name })
        } else if (info.id === (await this.#myDriveRoot(signal))) {
          crumbs.push({ id: 'root', name: MY_DRIVE_NAME })
        } else {
          crumbs.push({ id: info.id, name: info.name })
        }
        break
      }
      crumbs.push({ id: info.id, name: info.name })
      id = info.parents[0]
    }
    return crumbs.reverse()
  }

  // ─────────── árvore inteira ───────────

  /**
   * Varre a árvore de `folderId` com `concurrency` listagens simultâneas (BFS).
   * Cada item ganha relPath/relDir (NFC, '/') relativos à pasta varrida. Atalhos para arquivo ganham
   * `target` (DriveItem, ou null se o alvo sumiu); atalhos para pasta não são seguidos (evita ciclos).
   * `media: true` traz também os campos da prévia (hasThumbnail…): usado pelo "Gerar miniaturas".
   */
  async walk(folderId, { signal, onProgress, concurrency = 8, media = false } = {}) {
    if (signal?.aborted) throw abortError(signal)
    let root = await this.getItem(folderId, { signal })
    if (root.isShortcut && root.shortcutTargetId && root.shortcutTargetMimeType === FOLDER_MIME) {
      // Atalho escolhido diretamente como raiz: aí sim segue (não há ciclo possível no topo).
      root = await this.getItem(root.shortcutTargetId, { signal, resourceKey: root.shortcutTargetResourceKey })
    }
    if (!root.isFolder) return { root, items: [] }

    const inner = new AbortController()
    const sig = signal ? AbortSignal.any([signal, inner.signal]) : inner.signal
    const items = []
    const resolving = []
    const counters = { folders: 0, files: 0, bytes: 0 }
    const queue = [{ id: root.id, relDir: '', driveId: root.driveId }]
    const seen = new Set([root.id])
    let head = 0
    let active = 0
    let failure = null
    let waiters = []
    let lastEmit = 0

    const fail = err => {
      failure ??= err
      inner.abort()
      wake()
    }
    const wake = () => {
      const list = waiters
      waiters = []
      for (const resolve of list) resolve()
    }
    const emit = (force = false) => {
      if (!onProgress) return
      const now = Date.now()
      if (!force && now - lastEmit < PROGRESS_MS) return
      lastEmit = now
      try {
        onProgress({ ...counters })
      } catch {
        // progresso é só informativo
      }
    }

    const lister = async () => {
      for (;;) {
        if (failure || sig.aborted) return
        if (head < queue.length) {
          const job = queue[head++]
          active++
          try {
            const children = await this.#list(this.#childrenQuery(job.id), { driveId: job.driveId, signal: sig, media })
            for (const child of children) {
              child.relDir = job.relDir
              child.relPath = joinRel(job.relDir, relSegment(child.name))
              items.push(child)
              if (child.isFolder) {
                counters.folders++
                if (!seen.has(child.id)) {
                  seen.add(child.id)
                  queue.push({ id: child.id, relDir: child.relPath, driveId: child.driveId })
                }
              } else {
                counters.files++
                counters.bytes += child.size || 0
              }
              if (child.isShortcut && child.shortcutTargetId && child.shortcutTargetMimeType !== FOLDER_MIME) {
                // catch já aqui: uma rejeição sem dono até o fim da varredura derrubaria o processo.
                resolving.push(this.#resolveShortcut(child, sig).catch(fail))
              }
            }
            emit()
          } catch (err) {
            fail(err)
          } finally {
            active--
            wake()
          }
        } else if (active === 0) {
          wake()
          return
        } else {
          await new Promise(resolve => waiters.push(resolve))
        }
      }
    }

    const n = Math.max(1, Math.floor(concurrency) || 1)
    await Promise.all(Array.from({ length: n }, lister))
    await Promise.all(resolving)
    if (signal?.aborted) throw abortError(signal)
    if (failure) throw failure
    emit(true)
    items.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
    return { root, items }
  }

  async #resolveShortcut(item, signal) {
    try {
      const target = await this.getItem(item.shortcutTargetId, { signal, resourceKey: item.shortcutTargetResourceKey })
      if (!target.isFolder) item.target = target
    } catch (err) {
      const info = classifyError(err)
      // Alvo apagado ou sem acesso: atalho "pendurado".
      if (info.kind === 'notfound' || (info.kind === 'fatal' && info.status === 403)) item.target = null
      else throw err
    }
  }
}
