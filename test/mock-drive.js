// Google Drive v3 + OAuth 2.0 falsos, para os testes e para o modo demo.
//
// A ideia é ser fiel ao Google (docs/GOOGLE-NOTES.md), inclusive nas partes chatas, porque os motores são
// validados contra ele:
//  - OAuth loopback com PKCE S256, código de uso único, client_secret exigido, refresh sem refresh_token novo.
//  - Drive: formato de erro do Google, `fields` (resposta parcial; sem `fields` vem só kind/id/name/mimeType/resourceKey;
//    about EXIGE fields), paginação, `q` com and/or/not/parênteses, itens de drives compartilhados escondidos sem
//    supportsAllDrives/includeItemsFromAllDrives, resourceKey, lixeira incluída por padrão na listagem.
//  - Miniaturas: addFile(…, { thumbnail }) liga hasThumbnail/thumbnailLink; o link (`/drive-storage/<chave>=s<N>`) só
//    abre com Bearer válido, como no Google, e expireThumbnailLinks() faz os links atuais darem 404.
//  - Download com Range (206/416) e falhas: conexão que cai, conexão que trava, 5xx/429/403, Content-Range errado,
//    Range ignorado (200 com tudo).
//  - Upload retomável: 308 + Range, pedaços múltiplos de 256 KiB, sobreposição, perda dos bytes ainda não
//    "assentados" quando a conexão cai, sessão que expira, limite diário (750 GB/dia em escala), cancelamento (499).
//  - Banda limitada POR CONEXÃO: é o que prova que várias conexões ganham de uma.
//  - Compartilhamento: permissions.list/create, `permissions` só fora de drive compartilhado (como no Google), `shared`,
//    herança das pastas de cima, recusa da política do Workspace (`anyoneSharingBlocked`) e do drive compartilhado
//    (`addSharedDrive(nome, { domainUsersOnly: true })`). share()/permissionsOf() montam e conferem cenários.
//  - "Compartilhados comigo": addShared(nome, { folder, role }) cria o item de outra pessoa, fora do Meu Drive, que
//    aparece em `sharedWithMe`; leitor (role 'reader' ou canEdit: false) não renomeia nem move (403), e mover pede
//    edição também na pasta de destino (files.update addParents/removeParents, como no Google).
// Arquivos "virtuais" têm qualquer tamanho e são gerados na hora a partir de uma semente (sem memória nem disco).
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { performance } from 'node:perf_hooks'
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads'
import zlib from 'node:zlib'
import { DRIVE_SCOPE } from '../src/config.js'

const KiB = 1024
const MiB = 1024 * KiB
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'
const GAPPS = 'application/vnd.google-apps.'
const UPLOAD_ALIGN = 256 * KiB
const EXPORT_LIMIT = 10 * MiB
const MAX_FILE_SIZE = 5 * 1024 ** 4 // 5 TB
const DRAIN_LIMIT = 8 * MiB // corpo de requisição recusada: lê até isso antes de responder (mantém a conexão viva)
const INLINE_MD5_LIMIT = 8 * MiB // acima disso o MD5 do conteúdo virtual vai para uma worker thread
const CODE_TTL_MS = 10 * 60_000

const DEFAULT_OPTIONS = {
  seed: 1,
  perConnectionBps: 0,
  latencyMs: 0,
  failures: {},
  ignoreRange: false,
  uploadRetainGranularity: UPLOAD_ALIGN,
  sessionTtlMs: 7 * 24 * 3600 * 1000,
  uploadDailyLimitBytes: 0,
  downloadQuotaExceededIds: null,
  // { [fileId]: offset }: o GET de mídia desse arquivo manda o byte `offset` trocado (bit flip), com Content-Range e
  // tamanho certos. Simula um byte corrompido no caminho; quem baixa só percebe pelo MD5.
  corruptMediaBytes: null,
  storageLimitBytes: null,
  tokenTtlSec: 3600,
  requireClientSecret: true,
  grantedScope: null,
  authDeny: false,
  omitRefreshToken: false,
  nameQueryCaseSensitive: false,
  // true = o Workspace não deixa compartilhar com "qualquer pessoa com o link" (permissions.create anyone → 403).
  anyoneSharingBlocked: false,
  // Arquivos virtuais maiores que isso informam um md5Checksum "de mentirinha" (determinístico) para a listagem
  // não esperar minutos calculando o MD5 de 200 GB. contentMd5() continua calculando o verdadeiro.
  virtualMd5Limit: 4 * 1024 ** 3,
  // true = fala com navegadores (app do celular em teste): responde preflight OPTIONS e põe os headers de CORS
  // em toda resposta, expondo os que o upload retomável precisa ler (Location, Range…). Desligado por padrão.
  cors: false,
}

// Headers de CORS do modo `cors`. "Authorization" vai explícito porque o curinga "*" não cobre esse header.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, *',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-expose-headers': 'Location, Range, Content-Range, X-Upload-Content-Length',
}

const DEFAULT_USER = {
  permissionId: '04613957823150648291',
  emailAddress: 'ana.montadora@example.com',
  displayName: 'Ana Montadora',
  photoLink: 'https://lh3.googleusercontent.com/a/mock-ana=s64',
}

// Campos que existem no recurso File da API v3 (pedir outro dá 400 "Invalid field selection", como no Google).
const FILE_FIELDS = new Set([
  'kind', 'id', 'name', 'mimeType', 'description', 'starred', 'trashed', 'explicitlyTrashed', 'trashingUser', 'trashedTime',
  'parents', 'properties', 'appProperties', 'spaces', 'version', 'webContentLink', 'webViewLink', 'iconLink', 'hasThumbnail',
  'thumbnailLink', 'thumbnailVersion', 'viewedByMe', 'viewedByMeTime', 'createdTime', 'modifiedTime', 'modifiedByMeTime',
  'modifiedByMe', 'sharedWithMeTime', 'sharingUser', 'owners', 'teamDriveId', 'driveId', 'lastModifyingUser', 'shared',
  'ownedByMe', 'capabilities', 'viewersCanCopyContent', 'copyRequiresWriterPermission', 'writersCanShare', 'permissions',
  'permissionIds', 'hasAugmentedPermissions', 'folderColorRgb', 'originalFilename', 'fullFileExtension', 'fileExtension',
  'md5Checksum', 'sha1Checksum', 'sha256Checksum', 'size', 'quotaBytesUsed', 'headRevisionId', 'contentHints',
  'imageMediaMetadata', 'videoMediaMetadata', 'isAppAuthorized', 'exportLinks', 'shortcutDetails', 'contentRestrictions',
  'resourceKey', 'linkShareMetadata', 'labelInfo', 'inheritedPermissionsDisabled', 'downloadRestrictions',
])
const FILE_LIST_FIELDS = new Set(['kind', 'nextPageToken', 'incompleteSearch', 'files'])
const ABOUT_FIELDS = new Set([
  'kind', 'user', 'storageQuota', 'importFormats', 'exportFormats', 'maxImportSizes', 'maxUploadSize', 'appInstalled',
  'folderColorPalette', 'driveThemes', 'canCreateDrives', 'canCreateTeamDrives', 'teamDriveThemes',
])
const DRIVE_FIELDS = new Set([
  'kind', 'id', 'name', 'colorRgb', 'backgroundImageLink', 'capabilities', 'createdTime', 'hidden', 'restrictions',
  'themeId', 'orgUnitId', 'backgroundImageFile', 'copyRequiresWriterPermission',
])
const DRIVE_LIST_FIELDS = new Set(['kind', 'nextPageToken', 'drives'])
const PERMISSION_FIELDS = new Set([
  'kind', 'id', 'type', 'role', 'emailAddress', 'domain', 'displayName', 'allowFileDiscovery', 'expirationTime',
  'deleted', 'photoLink', 'pendingOwner', 'permissionDetails', 'view', 'inheritedPermissionsDisabled',
])
const PERMISSION_LIST_FIELDS = new Set(['kind', 'nextPageToken', 'permissions'])
const DEFAULT_PERMISSION_MASK = { kind: true, id: true, type: true, role: true }
const PERMISSION_TYPES = new Set(['user', 'group', 'domain', 'anyone'])
const PERMISSION_ROLES = new Set(['owner', 'organizer', 'fileOrganizer', 'writer', 'commenter', 'reader'])

// Sem `fields`, o Google devolve só isto (pegadinha clássica: sem pedir, não vem size nem md5Checksum).
const DEFAULT_FILE_MASK = { kind: true, id: true, name: true, mimeType: true, resourceKey: true }
const DEFAULT_LIST_MASK = { kind: true, nextPageToken: true, incompleteSearch: true, files: DEFAULT_FILE_MASK }
const DEFAULT_DRIVE_MASK = { kind: true, id: true, name: true }
const DEFAULT_DRIVE_LIST_MASK = { kind: true, nextPageToken: true, drives: DEFAULT_DRIVE_MASK }

const EXPORT_FORMATS = {
  document: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/pdf', 'text/plain',
    'application/rtf', 'application/vnd.oasis.opendocument.text', 'text/html', 'application/zip',
    'application/epub+zip', 'text/markdown',
  ],
  spreadsheet: [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/pdf', 'text/csv',
    'text/tab-separated-values', 'application/vnd.oasis.opendocument.spreadsheet',
    'application/x-vnd.oasis.opendocument.spreadsheet', 'application/zip',
  ],
  presentation: [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/pdf', 'text/plain',
    'application/vnd.oasis.opendocument.presentation',
  ],
  drawing: ['image/png', 'image/jpeg', 'image/svg+xml', 'application/pdf'],
  script: ['application/vnd.google-apps.script+json'],
}

const MIME_BY_EXT = {
  mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v', mxf: 'application/mxf', avi: 'video/x-msvideo',
  mkv: 'video/x-matroska', wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', mp3: 'audio/mpeg', m4a: 'audio/mp4',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', tif: 'image/tiff', tiff: 'image/tiff', exr: 'image/x-exr',
  txt: 'text/plain', csv: 'text/csv', json: 'application/json', pdf: 'application/pdf', zip: 'application/zip',
  srt: 'application/x-subrip', xml: 'text/xml',
}

// ───────────────────────────── conteúdo virtual ─────────────────────────────
//
// Cada semente tem um "poço" de 1 MiB de bytes pseudoaleatórios (xorshift). O bloco b (64 KiB) do arquivo é uma
// fatia desse poço num deslocamento sorteado por (semente, b), com o número do bloco carimbado nos 8 primeiros
// bytes. Gerar = memcpy (vários GB/s), e qualquer pedaço gravado no lugar errado muda o MD5.

const BLOCK = 64 * KiB
const POOL = 1 * MiB
const pools = new Map()

function fmix32(h) {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/** Semente (número ou texto) → inteiro de 32 bits. */
function seed32(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    const n = Math.trunc(Math.abs(seed))
    return fmix32((n >>> 0) ^ fmix32(Math.floor(n / 4294967296) + 0x9e3779b9))
  }
  let h = 0x811c9dc5
  for (const ch of String(seed)) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 0x01000193)
  }
  return fmix32(h)
}

function poolFor(s) {
  let pool = pools.get(s)
  if (pool) return pool
  const words = new Uint32Array((POOL + BLOCK) / 4)
  let x = s || 0x9e3779b9
  for (let i = 0; i < words.length; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    words[i] = x
  }
  pool = Buffer.from(words.buffer)
  if (pools.size >= 16) pools.delete(pools.keys().next().value)
  pools.set(s, pool)
  return pool
}

function fillVirtual(s, start, target, offset, length) {
  const pool = poolFor(s)
  let pos = start
  let out = offset
  let left = length
  while (left > 0) {
    const b = Math.floor(pos / BLOCK)
    const inBlock = pos - b * BLOCK
    const n = Math.min(BLOCK - inBlock, left)
    const lo = b >>> 0
    const h = fmix32(s ^ fmix32(lo ^ Math.imul(Math.floor(b / 4294967296), 0x27d4eb2f) ^ 0x165667b1))
    const src = (h & (POOL - 1)) + inBlock
    pool.copy(target, out, src, src + n)
    if (inBlock < 8) {
      const stop = Math.min(8, inBlock + n)
      for (let k = inBlock; k < stop; k++) {
        target[out + k - inBlock] = k < 4 ? (lo >>> (8 * k)) & 255 : (h >>> (8 * (k - 4))) & 255
      }
    }
    pos += n
    out += n
    left -= n
  }
  return target
}

function md5VirtualSync(s, size) {
  const hash = crypto.createHash('md5')
  const buf = Buffer.allocUnsafe(Math.max(1, Math.min(size, 4 * MiB)))
  for (let pos = 0; pos < size;) {
    const n = Math.min(buf.length, size - pos)
    fillVirtual(s, pos, buf, 0, n)
    hash.update(n === buf.length ? buf : buf.subarray(0, n))
    pos += n
  }
  return hash.digest('hex')
}

function md5InWorker(s, size, registry) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { __sobedesceMockMd5: { s, size } } })
    registry?.add(worker)
    let settled = false
    worker.once('message', md5 => {
      settled = true
      resolve(md5)
    })
    worker.once('error', err => {
      settled = true
      reject(err)
    })
    worker.once('exit', code => {
      registry?.delete(worker)
      if (!settled) reject(new Error(`cálculo de MD5 interrompido (worker saiu com ${code})`))
    })
  })
}

/** Bytes [start, end) do conteúdo virtual de `seed` (end exclusivo, como Buffer.subarray). */
export function virtualBytes(seed, start, end) {
  const len = Math.max(0, end - start)
  return fillVirtual(seed32(seed), start, Buffer.allocUnsafe(len), 0, len)
}

/** MD5 (hex) do conteúdo virtual com essa semente e esse tamanho. Tamanhos grandes rodam numa worker thread. */
export async function virtualMd5(seed, size) {
  const s = seed32(seed)
  return size <= INLINE_MD5_LIMIT ? md5VirtualSync(s, size) : md5InWorker(s, size, null)
}

/** Stream com os bytes [start, end) do conteúdo virtual. */
export function virtualStream(seed, start = 0, end = 0) {
  const s = seed32(seed)
  return Readable.from((function* () {
    for (let pos = start; pos < end;) {
      const n = Math.min(MiB, end - pos)
      yield fillVirtual(s, pos, Buffer.allocUnsafe(n), 0, n)
      pos += n
    }
  })())
}

/** Grava no disco um arquivo com o mesmo conteúdo de um arquivo virtual do mock (para testes de upload/comparação). */
export async function writeVirtualFile(filePath, { size, seed }) {
  const s = seed32(seed)
  const fh = await fsp.open(filePath, 'w')
  try {
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(size, 4 * MiB)))
    for (let pos = 0; pos < size;) {
      const n = Math.min(buf.length, size - pos)
      fillVirtual(s, pos, buf, 0, n)
      await fh.write(buf, 0, n, pos)
      pos += n
    }
  } finally {
    await fh.close()
  }
  return filePath
}

// ───────────────────────────── utilidades ─────────────────────────────

function mulberry32(a) {
  return function rand() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomId(len) {
  return crypto.randomBytes(Math.ceil((len * 3) / 4) + 3).toString('base64url').slice(0, len)
}
const newFileId = () => `1${randomId(32)}`
const newDriveId = () => `0A${randomId(12)}Uk9PVA`
const newRevisionId = () => `0B${randomId(42)}`
const newResourceKey = () => `0-${randomId(22)}`
const newPermissionId = () => String(10n ** 19n + BigInt(crypto.randomInt(2 ** 47)) * 1000n + BigInt(crypto.randomInt(1000)))
const isoNow = () => new Date().toISOString()
const noop = () => {}
const md5Hex = buf => crypto.createHash('md5').update(buf).digest('hex')
const s256 = verifier => crypto.createHash('sha256').update(verifier).digest('base64url')

function toIso(value) {
  if (value == null) return null
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) throw new Error(`data inválida: ${value}`)
  return d.toISOString()
}

function isIsoDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function extOf(name) {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : ''
}

function guessMime(name) {
  return MIME_BY_EXT[extOf(name).toLowerCase()] || 'application/octet-stream'
}

function flag(url, ...names) {
  return names.some(n => url.searchParams.get(n) === 'true')
}

/** Erro no formato do Google: {"error":{"code","message","errors":[{domain,reason,message}]}} */
function gError(code, reason, message, { domain = 'global', location, locationType = 'parameter' } = {}) {
  const item = { message, domain, reason }
  if (location) Object.assign(item, { location, locationType })
  return { error: { code, message, errors: [item] } }
}

const notFoundFile = id => gError(404, 'notFound', `File not found: ${id}.`, { location: 'fileId' })

const AUTH_ERROR_BODY = {
  error: {
    code: 401,
    message: 'Request had invalid authentication credentials.',
    errors: [{ message: 'Invalid Credentials', domain: 'global', reason: 'authError', location: 'Authorization', locationType: 'header' }],
    status: 'UNAUTHENTICATED',
  },
}
const AUTH_ERROR_HEADERS = { 'www-authenticate': 'Bearer realm="https://accounts.google.com/", error="invalid_token"' }

/** Espera `ms`; resolve antes se o sinal abortar (nunca rejeita). */
function delay(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

function connectionGone(req, res) {
  return Boolean(res.destroyed || req.destroyed || res.socket?.destroyed)
}

/** Resolve quando o cliente desiste (conexão fecha) ou o mock fecha. */
function waitClosed(req, res, signal) {
  return new Promise(resolve => {
    if (connectionGone(req, res) || signal.aborted) return resolve()
    const done = () => {
      req.off('close', done)
      res.off('close', done)
      signal.removeEventListener('abort', done)
      resolve()
    }
    req.once('close', done)
    res.once('close', done)
    signal.addEventListener('abort', done, { once: true })
  })
}

function waitDrain(res, signal) {
  return new Promise(resolve => {
    if (res.destroyed || signal.aborted) return resolve()
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      signal.removeEventListener('abort', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Espera `promise` por no máximo `ms` (sem deixar timer pendurado). */
async function withTimeout(promise, ms) {
  let timer
  try {
    return await Promise.race([promise, new Promise(resolve => (timer = setTimeout(resolve, ms)))])
  } finally {
    clearTimeout(timer)
  }
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const THUMBNAIL_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif'])
const THUMBNAIL_MAX = 2 * MiB

/**
 * appProperties como o Google: chaves e valores texto (até 124 bytes juntos); null apaga a chave. Mescla em `cur`.
 * Devolve o objeto novo, ou { error } se o formato for inválido.
 */
function mergeAppProperties(cur, patch) {
  if (patch == null) return cur ?? null
  if (typeof patch !== 'object' || Array.isArray(patch)) return { error: 'Invalid value for: appProperties' }
  const out = { ...(cur || {}) }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k]
      continue
    }
    if (typeof v !== 'string' || Buffer.byteLength(k) + Buffer.byteLength(v) > 124) return { error: `Invalid value for: appProperties.${k}` }
    out[k] = v
  }
  return Object.keys(out).length ? out : null
}

/** contentHints.thumbnail como o Google valida: base64 "URL-safe" (RFC 4648 §5), PNG/JPEG/GIF, até 2 MB. */
function parseThumbnailHint(t) {
  if (!t || typeof t !== 'object' || typeof t.image !== 'string' || !t.image) return { error: 'Invalid value for: contentHints.thumbnail.image' }
  if (!THUMBNAIL_MIMES.has(t.mimeType)) return { error: 'Invalid value for: contentHints.thumbnail.mimeType' }
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(t.image)) return { error: 'Invalid value for: contentHints.thumbnail.image (expected URL-safe base64)' }
  const data = Buffer.from(t.image, 'base64url')
  if (!data.length) return { error: 'Invalid value for: contentHints.thumbnail.image' }
  if (data.length > THUMBNAIL_MAX) return { error: 'The thumbnail is too large.' }
  return { mimeType: t.mimeType, data }
}

async function readBody(req, limit = MiB) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('corpo grande demais'), { tooLarge: true })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Lê e descarta o corpo até `limit` bytes. true = leu tudo (a conexão pode continuar viva). */
function drainRequest(req, limit, onBytes) {
  return new Promise(resolve => {
    if (req.complete || req.readableEnded) return resolve(true)
    if (req.destroyed) return resolve(false)
    let total = 0
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('close', onClose)
    }
    const onData = chunk => {
      total += chunk.length
      onBytes?.(chunk.length)
      if (total > limit) {
        cleanup()
        req.pause()
        resolve(false)
      }
    }
    const onEnd = () => {
      cleanup()
      resolve(true)
    }
    const onClose = () => {
      cleanup()
      resolve(req.complete)
    }
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('close', onClose)
    req.resume()
  })
}

async function md5File(file) {
  const hash = crypto.createHash('md5')
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * MiB })) hash.update(chunk)
  return hash.digest('hex')
}

/** Ritmo de UMA conexão (bytes/s lido ao vivo das opções). */
class Pacer {
  constructor(getBps, signal) {
    this.getBps = getBps
    this.signal = signal
    this.bps = 0
    this.start = 0
    this.sent = 0
  }

  async pace(n) {
    const bps = this.getBps()
    if (!bps || bps <= 0) {
      this.bps = 0
      return
    }
    if (bps !== this.bps) {
      this.bps = bps
      this.start = performance.now()
      this.sent = 0
    }
    this.sent += n
    const now = performance.now()
    let due = this.start + (this.sent * 1000) / bps
    // Depois de uma pausa (backpressure), não deixa "tirar o atraso" com rajada maior que 250 ms de banda.
    if (due < now - 250) {
      this.start += now - 250 - due
      due = now - 250
    }
    const wait = due - now
    if (wait > 1) await delay(wait, this.signal)
  }
}

function chunkSizeFor(bps) {
  if (!bps || bps <= 0) return MiB
  return Math.max(4 * KiB, Math.min(256 * KiB, Math.floor(bps / 32)))
}

// ───────────────────────────── `fields` (resposta parcial) ─────────────────────────────

function mergeMask(a, b) {
  if (!a) return b
  if (a === true || b === true) return true
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = mergeMask(out[k], v)
  return out
}

/** "nextPageToken,files(id,name,capabilities(canDownload))" → { nextPageToken: true, files: { id: true, ... } } */
export function parseFieldMask(str) {
  const s = String(str)
  let i = 0
  const fail = () => {
    throw Object.assign(new Error(`Invalid field selection ${s}`), { badField: s })
  }
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++
  }
  const name = () => {
    const m = /^[A-Za-z0-9_*.-]+/.exec(s.slice(i))
    if (!m) fail()
    i += m[0].length
    return m[0]
  }
  function list() {
    const node = {}
    for (;;) {
      ws()
      const segs = [name()]
      while (s[i] === '/') {
        i++
        segs.push(name())
      }
      ws()
      let sub = true
      if (s[i] === '(') {
        i++
        sub = list()
        ws()
        if (s[i] !== ')') fail()
        i++
      }
      let target = node
      for (let k = 0; k < segs.length - 1 && target; k++) {
        if (target[segs[k]] === true) target = null
        else target = target[segs[k]] ??= {}
      }
      if (target) target[segs.at(-1)] = mergeMask(target[segs.at(-1)], sub)
      ws()
      if (s[i] !== ',') return node
      i++
    }
  }
  const tree = list()
  ws()
  if (i !== s.length) fail()
  return tree
}

function applyMask(value, mask) {
  if (mask === true || mask == null || value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(v => applyMask(v, mask))
  const out = {}
  if (mask['*']) {
    for (const [k, v] of Object.entries(value)) out[k] = k in mask && k !== '*' ? applyMask(v, mask[k]) : v
    return out
  }
  for (const k of Object.keys(mask)) if (value[k] !== undefined) out[k] = applyMask(value[k], mask[k])
  return out
}

function maskWants(mask, field) {
  return mask === true || Boolean(mask && (mask['*'] || mask[field]))
}

function checkMaskKeys(mask, allowed) {
  if (mask === true || !mask) return
  for (const key of Object.keys(mask)) {
    if (key !== '*' && !allowed.has(key)) throw Object.assign(new Error(`Invalid field selection ${key}`), { badField: key })
  }
}

// ───────────────────────────── `q` (consulta de arquivos) ─────────────────────────────

function queryError(message = 'Invalid Value') {
  return Object.assign(new Error(message), { badQuery: true })
}

function tokenizeQuery(q) {
  const toks = []
  const s = String(q)
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) {
      i++
    } else if (c === '(' || c === ')') {
      toks.push({ type: c })
      i++
    } else if (c === "'" || c === '"') {
      let out = ''
      i++
      for (;;) {
        if (i >= s.length) throw queryError()
        const d = s[i]
        if (d === '\\' && i + 1 < s.length) {
          out += s[i + 1]
          i += 2
        } else if (d === c) {
          i++
          break
        } else {
          out += d
          i++
        }
      }
      toks.push({ type: 'string', value: out })
    } else {
      const rest = s.slice(i)
      const op = /^(!=|<=|>=|=|<|>)/.exec(rest)
      const word = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest)
      const num = /^-?\d+(\.\d+)?/.exec(rest)
      if (op) toks.push({ type: 'op', value: op[1] })
      else if (word) toks.push({ type: 'word', value: word[0] })
      else if (num) toks.push({ type: 'number', value: Number(num[0]) })
      else throw queryError()
      i += (op || word || num)[0].length
    }
  }
  return toks
}

const QUERY_FIELDS = {
  name: { ops: ['=', '!=', 'contains'], type: 'string' },
  mimeType: { ops: ['=', '!=', 'contains'], type: 'string' },
  fullText: { ops: ['contains'], type: 'string' },
  trashed: { ops: ['=', '!='], type: 'boolean' },
  starred: { ops: ['=', '!='], type: 'boolean' },
  modifiedTime: { ops: ['=', '!=', '<', '<=', '>', '>='], type: 'date' },
  createdTime: { ops: ['=', '!=', '<', '<=', '>', '>='], type: 'date' },
  viewedByMeTime: { ops: ['=', '!=', '<', '<=', '>', '>='], type: 'date' },
}

/** Subconjunto da linguagem de busca do Drive: termos combinados com and/or/not e parênteses. */
export function parseQuery(q) {
  const toks = tokenizeQuery(q)
  let i = 0
  const isWord = (t, w) => t?.type === 'word' && t.value.toLowerCase() === w
  function or() {
    let left = and()
    while (isWord(toks[i], 'or')) {
      i++
      left = { op: 'or', a: left, b: and() }
    }
    return left
  }
  function and() {
    let left = not()
    while (isWord(toks[i], 'and')) {
      i++
      left = { op: 'and', a: left, b: not() }
    }
    return left
  }
  function not() {
    if (isWord(toks[i], 'not')) {
      i++
      return { op: 'not', a: not() }
    }
    return primary()
  }
  function primary() {
    const t = toks[i++]
    if (!t) throw queryError()
    if (t.type === '(') {
      const e = or()
      if (toks[i++]?.type !== ')') throw queryError()
      return e
    }
    if (t.type === 'string') {
      if (!isWord(toks[i], 'in')) throw queryError()
      i++
      const field = toks[i++]
      if (field?.type !== 'word' || !['parents', 'owners', 'writers', 'readers'].includes(field.value)) throw queryError()
      return { op: 'in', field: field.value, value: t.value }
    }
    if (t.type !== 'word') throw queryError()
    if (t.value === 'sharedWithMe') {
      // `sharedWithMe` sozinho ou `sharedWithMe = true|false` (como o Google aceita).
      if (toks[i]?.type === 'op' && (toks[i].value === '=' || toks[i].value === '!=')) {
        const o = toks[i++].value
        const v = toks[i++]
        if (!isWord(v, 'true') && !isWord(v, 'false')) throw queryError()
        return { op: 'shared', value: isWord(v, 'true') === (o === '=') }
      }
      return { op: 'shared', value: true }
    }
    const spec = QUERY_FIELDS[t.value]
    if (!spec) throw queryError()
    const o = toks[i++]
    const operator = o?.type === 'op' ? o.value : isWord(o, 'contains') ? 'contains' : null
    if (!operator || !spec.ops.includes(operator)) throw queryError()
    const v = toks[i++]
    let value
    if (spec.type === 'boolean') {
      if (!isWord(v, 'true') && !isWord(v, 'false')) throw queryError()
      value = isWord(v, 'true')
    } else {
      if (v?.type !== 'string') throw queryError()
      value = v.value
      if (spec.type === 'date' && !isIsoDate(value)) throw queryError()
    }
    return { op: 'cmp', field: t.value, operator, value }
  }
  const ast = or()
  if (i !== toks.length) throw queryError()
  return ast
}

/** Se a consulta exige `'X' in parents` no nível do "and", devolve X (para varrer só os filhos de X). */
function parentConstraint(ast) {
  if (ast.op === 'in' && ast.field === 'parents') return ast.value
  if (ast.op === 'and') return parentConstraint(ast.a) ?? parentConstraint(ast.b)
  return null
}

/** `name contains`: o Google só casa PREFIXO de palavra ("Hello" acha "HelloWorld", "World" não), sem maiúsculas. */
function nameContains(name, term) {
  const n = name.toLowerCase()
  const t = term.toLowerCase()
  if (!t) return true
  for (let at = n.indexOf(t); at !== -1; at = n.indexOf(t, at + 1)) {
    if (at === 0 || !/[\p{L}\p{N}]/u.test(n[at - 1])) return true
  }
  return false
}

function compareOp(a, b, op) {
  switch (op) {
    case '=': return a === b
    case '!=': return a !== b
    case '<': return a < b
    case '<=': return a <= b
    case '>': return a > b
    case '>=': return a >= b
    default: return false
  }
}

const ORDER_KEYS = new Set([
  'createdTime', 'folder', 'modifiedByMeTime', 'modifiedTime', 'name', 'name_natural', 'quotaBytesUsed', 'recency',
  'sharedWithMeTime', 'starred', 'viewedByMeTime',
])

function parseOrderBy(str) {
  if (!str) return []
  return str.split(',').map(part => {
    const [key, dir, extra] = part.trim().split(/\s+/)
    if (!ORDER_KEYS.has(key) || extra || (dir && dir.toLowerCase() !== 'desc')) throw queryError()
    return { key, desc: Boolean(dir) }
  })
}

const collator = new Intl.Collator('en', { sensitivity: 'base' })
const naturalCollator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

function encodePageToken(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

function decodePageToken(token) {
  try {
    const obj = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
    if (!obj || !Number.isInteger(obj.o) || obj.o < 0) return null
    return obj
  } catch {
    return null
  }
}

function parsePageSize(raw, def, max) {
  if (raw == null || raw === '') return def
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > max) return null
  return n
}

/** Range: bytes=a-b | a- | -n. null = ignorar (200 com tudo); 'unsatisfiable' = 416. */
function parseRange(header, size) {
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] === '') {
    const n = Number(m[2])
    if (n === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const a = Number(m[1])
  if (m[2] !== '' && Number(m[2]) < a) return null
  if (a >= size) return 'unsatisfiable'
  return { start: a, end: m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) }
}

/** Content-Range de upload: "bytes A-B/T", "bytes A-B/*", "bytes *\/T". null = ausente; undefined = inválido. */
function parseContentRange(header) {
  if (header == null) return null
  let m = /^\s*bytes\s+\*\/(\d+|\*)\s*$/i.exec(header)
  if (m) return { query: true, total: m[1] === '*' ? null : Number(m[1]) }
  m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(header)
  if (m) return { query: false, start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) }
  return undefined
}

function scopeLevel(scope) {
  const parts = String(scope || '').split(/\s+/)
  const has = s => parts.includes(`https://www.googleapis.com/auth/${s}`)
  if (parts.includes(DRIVE_SCOPE) || has('drive.file') || has('drive.appdata')) return 'full'
  if (has('drive.readonly') || has('drive.metadata.readonly') || has('drive.metadata') || has('drive.photos.readonly')) return 'read'
  return 'none'
}

function isLoopbackRedirect(uri) {
  try {
    const u = new URL(uri)
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !u.username && !u.password && !u.hash
  } catch {
    return false
  }
}

// ───────────────────────────── o servidor ─────────────────────────────

/**
 * Sobe o Drive falso em 127.0.0.1 (porta livre).
 * @param {object} options ver DEFAULT_OPTIONS; `user` e `client` sobrescrevem a identidade/cliente OAuth.
 */
// ───────────────────────────── imagens (miniaturas) ─────────────────────────────

/**
 * PNG RGB de verdade (para miniaturas no Drive falso). `pixel(x, y)` devolve [r, g, b] (0–255).
 * Padrão: degradê suave.
 */
export function makePng(width, height, pixel = (x, y) => [40 + ((x * 180) / width) | 0, 60 + ((y * 140) / height) | 0, 150]) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      raw[row + 1 + x * 3] = r
      raw[row + 2 + x * 3] = g
      raw[row + 3 + x * 3] = b
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 8 bits por canal
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function imageType(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return 'application/octet-stream'
}

export async function startMockDrive(options = {}) {
  const mock = new MockDrive(options)
  await mock._listen()
  return mock
}

class MockDrive {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, failures: {}, downloadQuotaExceededIds: new Set() }
    this._rand = null
    this._applyOptions(options)
    this.client = {
      clientId: `${100000000000 + crypto.randomInt(899999999999)}-mock${randomId(20).toLowerCase().replace(/[^a-z0-9]/g, 'x')}.apps.googleusercontent.com`,
      clientSecret: `GOCSPX-${randomId(28)}`,
      ...(options.client || {}),
    }
    this.user = { ...DEFAULT_USER, ...(options.user || {}) }
    this.items = new Map()
    this.children = new Map()
    this.drives = new Map()
    this.sessions = new Map()
    this.codes = new Map()
    this.usedCodes = new Set()
    this.accessTokens = new Map()
    this.refreshTokens = new Map()
    this.thumbKeys = new Map() // chave do thumbnailLink -> id do arquivo
    this.dailyUploaded = 0
    this._seq = 0
    this._autoSeed = 0
    this._handlers = new Set()
    this._workers = new Set()
    this._md5Running = 0
    this._md5Queue = []
    this._virtualMd5 = new Map()
    this._closing = new AbortController()
    this._closed = false
    this._stats = null
    this.resetStats()
    // A raiz do Meu Drive tem id com cara de drive ("0A…"); o apelido 'root' vale em todo lugar.
    this.rootId = newDriveId()
    const now = isoNow()
    this._insert({ id: this.rootId, name: 'My Drive', mimeType: FOLDER_MIME, parentId: null, createdTime: now, modifiedTime: now })
    this.url = null
    this.env = null
  }

  // ─────────── ciclo de vida ───────────

  async _listen() {
    this.tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sobedesce-mockdrive-'))
    const server = http.createServer((req, res) => this._onRequest(req, res))
    server.requestTimeout = 0 // uploads enormes e lentos não podem ser cortados pelo Node
    server.headersTimeout = 60_000
    server.keepAliveTimeout = 30_000
    server.on('connection', socket => socket.setNoDelay(true))
    server.on('clientError', (err, socket) => {
      if (err.code !== 'ECONNRESET' && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      else socket.destroy()
    })
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch (err) {
      await fsp.rm(this.tmpDir, { recursive: true, force: true }).catch(noop)
      throw err
    }
    this.server = server
    this.url = `http://127.0.0.1:${server.address().port}`
    this.env = {
      SOBEDESCE_DRIVE_API: `${this.url}/drive/v3`,
      SOBEDESCE_DRIVE_UPLOAD: `${this.url}/upload/drive/v3`,
      SOBEDESCE_OAUTH_AUTH: `${this.url}/o/oauth2/v2/auth`,
      SOBEDESCE_OAUTH_TOKEN: `${this.url}/token`,
      SOBEDESCE_OAUTH_REVOKE: `${this.url}/revoke`,
    }
  }

  /** Aponta os endpoints do app (config.endpoints()) para este mock. */
  applyEnv() {
    Object.assign(process.env, this.env)
    return this.env
  }

  async close() {
    if (this._closed) return
    this._closed = true
    this._closing.abort()
    const closed = new Promise(resolve => this.server.close(() => resolve()))
    this.server.closeAllConnections()
    await Promise.allSettled([...this._workers].map(w => w.terminate()))
    for (const wake of this._md5Queue.splice(0)) wake()
    await withTimeout(Promise.allSettled([...this._handlers]), 5000)
    await withTimeout(closed, 5000)
    await fsp.rm(this.tmpDir, { recursive: true, force: true }).catch(noop)
  }

  // ─────────── opções e estatísticas ───────────

  _applyOptions(partial = {}) {
    for (const [key, value] of Object.entries(partial)) {
      if (key === 'user' || key === 'client') continue
      if (key === 'failures') this.options.failures = { ...(value || {}) }
      else if (key === 'downloadQuotaExceededIds') this.options.downloadQuotaExceededIds = value instanceof Set ? value : new Set(value || [])
      else this.options[key] = value
    }
    if (!this._rand || 'seed' in partial) this._rand = mulberry32(seed32(this.options.seed ?? 1))
  }

  /** Muda opções ao vivo. `failures` é substituído por inteiro ({} desliga todas as falhas). */
  setOptions(partial = {}) {
    this._applyOptions(partial)
    return this.options
  }

  stats() {
    return structuredClone(this._stats)
  }

  resetStats() {
    const active = this._stats?.activeMediaConnections ?? 0
    this._stats = {
      requests: {},
      mediaGets: 0,
      rangeGets: 0,
      activeMediaConnections: active,
      maxActiveMediaConnections: active,
      bytesServed: 0,
      bytesReceived: 0,
      uploadSessionsCreated: 0,
      uploadPuts: 0,
      statusQueries: 0,
      thumbGets: 0,
      thumbSizes: [],
      thumbnailsSet: 0,
      dailyUploadBytes: this.dailyUploaded ?? 0,
      faults: { error5xx: 0, error429: 0, rateLimit403: 0, wrongRange: 0, ignoredRange: 0, downloadDrops: 0, downloadStalls: 0, uploadDrops: 0, uploadStalls: 0, shortPages: 0 },
    }
  }

  /** Zera o contador do limite diário de upload (como se tivessem passado 24 h). */
  resetDailyUsage() {
    this.dailyUploaded = 0
    this._stats.dailyUploadBytes = 0
    for (const s of this.sessions.values()) s.crossedCap = false
  }

  // ─────────── OAuth: atalhos para testes ───────────

  _grantScope(requested) {
    return this.options.grantedScope ?? (requested || DRIVE_SCOPE)
  }

  _issueAccess(scope, refreshToken) {
    const token = `ya29.mock-${randomId(40)}`
    this.accessTokens.set(token, { scope, refreshToken, expiresAt: Date.now() + this.options.tokenTtlSec * 1000, revoked: false })
    return token
  }

  /** Tokens válidos sem passar pelo fluxo (para testar outros módulos). */
  issueTokens({ scope } = {}) {
    const granted = scope ?? this._grantScope(DRIVE_SCOPE)
    const refreshToken = `1//mock-${randomId(40)}`
    this.refreshTokens.set(refreshToken, { scope: granted, clientId: this.client.clientId, revoked: false })
    return { accessToken: this._issueAccess(granted, refreshToken), refreshToken }
  }

  /** Todos os access tokens atuais passam a dar 401 (o refresh continua funcionando). */
  expireAccessTokens() {
    for (const info of this.accessTokens.values()) info.expiresAt = 0
  }

  /** Todos os refresh tokens passam a dar invalid_grant (como o modo Teste depois de 7 dias). */
  revokeRefreshTokens() {
    for (const info of this.refreshTokens.values()) info.revoked = true
  }

  _tokenInfo(authorization) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization || '')
    const info = m && this.accessTokens.get(m[1])
    if (!info || info.revoked || info.expiresAt <= Date.now()) return null
    return info
  }

  // ─────────── árvore de arquivos ───────────

  _resolve(id) {
    return id === 'root' ? this.rootId : id
  }

  _insert({ id, name, mimeType, parentId, driveId = null, content = null, createdTime, modifiedTime, resourceKey = null, canDownload = true, trashed = false, shortcutDetails = null, docSize = null, md5Override, description = null, thumbnail = null, videoMediaMetadata = null, imageMediaMetadata = null, appProperties = null, canShare = true, canTrash = true, canEdit = true, shared = null }) {
    const parent = parentId ? this.items.get(parentId) : null
    const now = isoNow()
    const item = {
      id: id ?? newFileId(),
      name: String(name),
      mimeType,
      parents: parent ? [parent.id] : [],
      driveId: parent ? parent.driveId : driveId,
      content,
      createdTime: createdTime ?? now,
      modifiedTime: modifiedTime ?? now,
      headRevisionId: content ? newRevisionId() : null,
      resourceKey,
      canDownload,
      trashed: Boolean(trashed || parent?.trashed),
      explicitlyTrashed: Boolean(trashed),
      shortcutDetails,
      docSize,
      md5Override,
      description,
      thumbnail: null,
      videoMediaMetadata,
      imageMediaMetadata,
      appProperties: appProperties && Object.keys(appProperties).length ? { ...appProperties } : null,
      permissions: [], // só as deste item; as herdadas vêm das pastas de cima (_permissions)
      canShare: canShare !== false,
      // false = a conta só lê (ou é colaboradora num drive compartilhado): files.update trashed → 403.
      canTrash: canTrash !== false,
      // false = só lê: renomear e mover (o item ou para dentro dele) dão 403.
      canEdit: canEdit !== false,
      // "Compartilhados comigo": { time, by: { displayName, emailAddress }, role: 'reader'|'writer' } (addShared).
      shared,
      version: 1,
      seq: this._seq++,
    }
    if (this.items.has(item.id)) throw new Error(`id repetido: ${item.id}`)
    if (thumbnail) this._setThumbnail(item, thumbnail)
    this.items.set(item.id, item)
    if (parent) this._childrenOf(parent.id).add(item.id)
    return item
  }

  _childrenOf(id) {
    let set = this.children.get(id)
    if (!set) this.children.set(id, (set = new Set()))
    return set
  }

  _remove(id) {
    const item = this.items.get(id)
    if (!item) return false
    for (const child of [...(this.children.get(id) || [])]) this._remove(child)
    this.children.delete(id)
    for (const p of item.parents) this.children.get(p)?.delete(id)
    this.items.delete(id)
    if (this.drives.has(id)) this.drives.delete(id)
    if (item.content?.kind === 'disk') fsp.unlink(item.content.path).catch(noop)
    return true
  }

  _parentFolder(parentId) {
    const parent = this.items.get(this._resolve(parentId ?? 'root'))
    if (!parent) throw new Error(`pasta não existe: ${parentId}`)
    if (parent.mimeType !== FOLDER_MIME) throw new Error(`não é pasta: ${parentId}`)
    return parent
  }

  _setTrashed(item, trashed) {
    item.trashed = trashed
    item.explicitlyTrashed = trashed
    // Itens dentro de uma pasta na lixeira também estão na lixeira (sem terem sido jogados lá um a um).
    const walk = id => {
      for (const childId of this.children.get(id) || []) {
        const child = this.items.get(childId)
        if (!child) continue
        if (!child.explicitlyTrashed) child.trashed = trashed
        walk(childId)
      }
    }
    walk(item.id)
  }

  _setDriveId(item, driveId) {
    item.driveId = driveId
    for (const childId of this.children.get(item.id) || []) {
      const child = this.items.get(childId)
      if (child) this._setDriveId(child, driveId)
    }
  }

  _view(item) {
    if (!item) return null
    const c = item.content
    return {
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      parents: [...item.parents],
      driveId: item.driveId,
      trashed: item.trashed,
      size: c ? c.size : null,
      md5: this._reportedMd5Sync(item),
      seed: c?.kind === 'virtual' ? c.seed : null,
      modifiedTime: item.modifiedTime,
      createdTime: item.createdTime,
      headRevisionId: item.headRevisionId,
      resourceKey: item.resourceKey,
      canDownload: item.canDownload,
      isFolder: item.mimeType === FOLDER_MIME,
      shortcutDetails: item.shortcutDetails ? { ...item.shortcutDetails } : null,
      description: item.description ?? null,
      appProperties: item.appProperties ? { ...item.appProperties } : null,
    }
  }

  /** md5Checksum que o Drive informa, se já dá para saber sem calcular nada. */
  _reportedMd5Sync(item) {
    const c = item.content
    if (!c) return null
    if (item.md5Override !== undefined) return item.md5Override
    if (c.kind === 'virtual' && c.size > this.options.virtualMd5Limit) return md5Hex(`sobedesce-mock-virtual:${c.s}:${c.size}`)
    return c.md5 ?? null
  }

  _makeContent({ size, seed, content }) {
    if (content != null) {
      const buf = Buffer.from(content)
      return { kind: 'buffer', buf, size: buf.length, md5: null }
    }
    const n = Number(size ?? 0)
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`tamanho inválido: ${size}`)
    const s = seed ?? fmix32(seed32(this.options.seed ?? 1) + ++this._autoSeed * 0x9e3779b9)
    return { kind: 'virtual', seed: s, s: seed32(s), size: n, md5: null }
  }

  _setThumbnail(item, thumbnail, mimeType = 'image/png') {
    if (item.thumbnail) this.thumbKeys.delete(item.thumbnail.key)
    if (!thumbnail) {
      item.thumbnail = null
      return
    }
    const buf = Buffer.isBuffer(thumbnail) ? thumbnail : makePng(64, 36)
    const key = `AJQWtB${randomId(40)}`
    // buf/key: o thumbnailLink (só abre com token); mimeType/data/version: a miniatura gravada por contentHints.
    item.thumbnail = { buf, key, mimeType, data: buf, version: (item.thumbnail?.version ?? 0) + 1 }
    this.thumbKeys.set(key, item.id)
  }

  /** Troca a miniatura (Buffer de imagem, true = PNG de exemplo, null = sem miniatura). */
  setThumbnail(id, thumbnail) {
    const item = this.items.get(this._resolve(id))
    if (!item) throw new Error(`não existe: ${id}`)
    this._setThumbnail(item, thumbnail)
  }

  /** Os thumbnailLink atuais passam a dar 404 (como os links do Google, que vencem em algumas horas). */
  expireThumbnailLinks() {
    for (const item of this.items.values()) if (item.thumbnail) this._setThumbnail(item, item.thumbnail.buf)
  }

  // ─────────── API JS (para montar cenários) ───────────

  addFolder(name, parentId = 'root', extra = {}) {
    const parent = this._parentFolder(parentId)
    const item = this._insert({
      id: extra.id,
      name,
      mimeType: FOLDER_MIME,
      parentId: parent.id,
      createdTime: toIso(extra.createdTime) ?? undefined,
      modifiedTime: toIso(extra.modifiedTime) ?? undefined,
      resourceKey: extra.resourceKey === true ? newResourceKey() : extra.resourceKey ?? null,
      trashed: extra.trashed,
      canShare: extra.canShare,
      canTrash: extra.canTrash,
      canEdit: extra.canEdit,
    })
    return this._view(item)
  }

  /**
   * size+seed → conteúdo virtual (gerado na hora); content → bytes reais (Buffer/string).
   * md5: string = "mentira" no md5Checksum (o conteúdo continua o mesmo); null = sem md5Checksum.
   */
  addFile(name, parentId = 'root', opts = {}) {
    const parent = this._parentFolder(parentId)
    const item = this._insert({
      id: opts.id,
      name,
      mimeType: opts.mimeType || guessMime(String(name)),
      parentId: parent.id,
      content: this._makeContent(opts),
      createdTime: toIso(opts.createdTime) ?? undefined,
      modifiedTime: toIso(opts.modifiedTime) ?? undefined,
      resourceKey: opts.resourceKey === true ? newResourceKey() : opts.resourceKey ?? null,
      canDownload: opts.canDownload !== false,
      trashed: opts.trashed,
      md5Override: 'md5' in opts ? opts.md5 : undefined,
      description: opts.description ?? null,
      thumbnail: opts.thumbnail ?? null,
      videoMediaMetadata: opts.videoMediaMetadata ?? null,
      imageMediaMetadata: opts.imageMediaMetadata ?? null,
      appProperties: opts.appProperties ?? null,
      canShare: opts.canShare,
      canTrash: opts.canTrash,
      canEdit: opts.canEdit,
    })
    return this._view(item)
  }

  /**
   * Item que OUTRA pessoa compartilhou com a conta ("Compartilhados comigo"): fica fora do Meu Drive (sem pai que a
   * conta enxergue) e aparece em `sharedWithMe`. opts: folder (pasta), role ('writer' padrão | 'reader'), by (nome),
   * email, sharedTime, trashed, e para arquivo os mesmos de addFile (size, seed, content, mimeType…). O que vai dentro de uma
   * pasta compartilhada entra com addFile/addFolder de sempre e herda o papel.
   */
  addShared(name, opts = {}) {
    const folder = Boolean(opts.folder)
    const item = this._insert({
      id: opts.id,
      name,
      mimeType: folder ? FOLDER_MIME : opts.mimeType || guessMime(String(name)),
      parentId: null,
      content: folder ? null : this._makeContent(opts),
      createdTime: toIso(opts.createdTime) ?? undefined,
      modifiedTime: toIso(opts.modifiedTime) ?? undefined,
      trashed: opts.trashed,
      canShare: false,
      canTrash: false,
      shared: {
        time: toIso(opts.sharedTime) ?? isoNow(),
        by: { displayName: opts.by || 'Bia Produtora', emailAddress: opts.email || 'bia@produtora.example' },
        role: opts.role === 'reader' ? 'reader' : 'writer',
      },
    })
    return this._view(item)
  }

  /** A pasta (ou o item) compartilhada comigo de onde este item vem, ou null (é meu ou de drive compartilhado). */
  _sharedRoot(item) {
    for (let p = item, i = 0; p && i < 200; p = this.items.get(p.parents[0]), i++) if (p.shared) return p
    return null
  }

  /** A conta pode editar (renomear, mover, pôr coisas dentro)? Leitor de uma pasta compartilhada não pode. */
  _writable(item) {
    if (!item || item.canEdit === false) return false
    const root = this._sharedRoot(item)
    return !root || root.shared.role !== 'reader'
  }

  /** Documento nativo (document, spreadsheet, presentation, drawing, form…). `size` só serve para o limite de exportação. */
  addGoogleDoc(name, parentId = 'root', kind = 'document', opts = {}) {
    const parent = this._parentFolder(parentId)
    const item = this._insert({
      id: opts.id,
      name,
      mimeType: `${GAPPS}${kind}`,
      parentId: parent.id,
      modifiedTime: toIso(opts.modifiedTime) ?? undefined,
      docSize: opts.size ?? null,
      canDownload: opts.canDownload !== false,
      trashed: opts.trashed,
      thumbnail: opts.thumbnail ?? null,
    })
    return this._view(item)
  }

  addShortcut(name, parentId = 'root', targetId) {
    const parent = this._parentFolder(parentId)
    const target = this.items.get(this._resolve(targetId))
    if (!target) throw new Error(`alvo do atalho não existe: ${targetId}`)
    const details = { targetId: target.id, targetMimeType: target.mimeType }
    if (target.resourceKey) details.targetResourceKey = target.resourceKey
    const item = this._insert({ name, mimeType: SHORTCUT_MIME, parentId: parent.id, shortcutDetails: details })
    return this._view(item)
  }

  /** Drive compartilhado: a pasta raiz tem id = id do drive; tudo dentro dele carrega driveId. */
  addSharedDrive(name, { domainUsersOnly = false } = {}) {
    const id = newDriveId()
    const now = isoNow()
    this._insert({ id, name, mimeType: FOLDER_MIME, parentId: null, driveId: id, createdTime: now, modifiedTime: now })
    this.drives.set(id, { id, name, createdTime: now, restrictions: { domainUsersOnly: Boolean(domainUsersOnly) } })
    return { id, name }
  }

  /**
   * Compartilha o item como alguém faria pelo Drive: { type, role, emailAddress?, domain?, allowFileDiscovery? }.
   * Vale para o item e, numa pasta, para tudo dentro dela (herança). Devolve a permissão (com id).
   */
  share(id, perm) {
    const item = this.items.get(this._resolve(id))
    if (!item) throw new Error(`não existe: ${id}`)
    return { ...this._addPermission(item, perm) }
  }

  /** Permissões que valem para o item: dono (ou organizador do drive compartilhado), as dele e as herdadas. */
  permissionsOf(id) {
    const item = this.items.get(this._resolve(id))
    if (!item) throw new Error(`não existe: ${id}`)
    return this._permissions(item).map(p => ({ ...p }))
  }

  getItem(id) {
    return this._view(this.items.get(this._resolve(id)))
  }

  _addPermission(item, perm) {
    const type = perm.type
    let id
    if (type === 'anyone') id = perm.allowFileDiscovery ? 'anyone' : 'anyoneWithLink'
    else if (type === 'domain') id = `domain:${perm.domain}`
    else id = item.permissions.find(p => p.type === type && p.emailAddress === perm.emailAddress)?.id ?? newPermissionId()
    const out = { id, type, role: perm.role }
    if (perm.emailAddress) out.emailAddress = perm.emailAddress
    if (type === 'domain') out.domain = perm.domain
    if (type === 'anyone' || type === 'domain') out.allowFileDiscovery = Boolean(perm.allowFileDiscovery)
    // Mesmo tipo de novo (ex.: "qualquer pessoa" duas vezes): troca o papel, não duplica.
    const i = item.permissions.findIndex(p => p.id === id)
    if (i >= 0) item.permissions[i] = out
    else item.permissions.push(out)
    return out
  }

  _permissions(item) {
    const u = this.user
    const out = [{ id: u.permissionId, type: 'user', role: item.driveId ? 'organizer' : 'owner', emailAddress: u.emailAddress, displayName: u.displayName }]
    const seen = new Set([u.permissionId])
    let cur = item
    for (let depth = 0; cur && depth < 200; depth++) {
      for (const p of cur.permissions || []) {
        if (seen.has(p.id)) continue
        seen.add(p.id)
        out.push({ ...p })
      }
      cur = cur.parents.length ? this.items.get(cur.parents[0]) : null
    }
    return out
  }

  /** Todos os itens (sem as raízes do Meu Drive e dos drives compartilhados). */
  listAll() {
    return [...this.items.values()].filter(it => it.parents.length > 0).map(it => this._view(it))
  }

  deleteItem(id) {
    const rid = this._resolve(id)
    if (rid === this.rootId) throw new Error('não dá para apagar a raiz do Meu Drive')
    return this._remove(rid)
  }

  /** Troca o conteúdo (novo md5, novo headRevisionId, novo modifiedTime), como uma nova versão no Drive. */
  updateContent(id, spec = {}) {
    const item = this.items.get(this._resolve(id))
    if (!item?.content) throw new Error(`não é arquivo binário: ${id}`)
    const old = item.content
    item.content = this._makeContent(spec)
    item.headRevisionId = newRevisionId()
    item.modifiedTime = toIso(spec.modifiedTime) ?? isoNow()
    item.md5Override = undefined
    item.thumbnail = null
    item.version++
    if (old.kind === 'disk') fsp.unlink(old.path).catch(noop)
    return this._view(item)
  }

  /** Miniatura gravada por contentHints.thumbnail: { mimeType, data: Buffer, version } ou null. */
  getThumbnail(id) {
    const t = this.items.get(this._resolve(id))?.thumbnail
    return t ? { mimeType: t.mimeType, data: Buffer.from(t.data), version: t.version } : null
  }

  /** Bytes [start, end) do arquivo (end exclusivo; padrão = até o fim). Para conferências em testes. */
  readContent(id, start = 0, end) {
    const item = this.items.get(this._resolve(id))
    if (!item?.content) throw new Error(`não é arquivo binário: ${id}`)
    const c = item.content
    const stop = Math.min(end ?? c.size, c.size)
    const from = Math.min(Math.max(0, start), stop)
    const len = stop - from
    if (c.kind === 'virtual') return fillVirtual(c.s, from, Buffer.allocUnsafe(len), 0, len)
    if (c.kind === 'buffer') return Buffer.from(c.buf.subarray(from, stop))
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(c.path, 'r')
    try {
      let done = 0
      while (done < len) {
        const n = fs.readSync(fd, buf, done, len - done, from + done)
        if (n === 0) break
        done += n
      }
    } finally {
      fs.closeSync(fd)
    }
    return buf
  }

  /** MD5 VERDADEIRO do conteúdo (ignora o md5 "mentiroso" de addFile). */
  async contentMd5(id) {
    const item = this.items.get(this._resolve(id))
    if (!item?.content) throw new Error(`não é arquivo binário: ${id}`)
    return this._md5(item.content)
  }

  /** Sessões de upload (sem a URI): { id, kind, fileId, committed, total, declaredLength, completed, createdAt }. */
  listUploadSessions() {
    return [...this.sessions.values()].map(s => ({
      id: s.id,
      kind: s.kind,
      fileId: s.fileId,
      committed: s.committed,
      total: s.total,
      declaredLength: s.declaredLength,
      completed: s.completed,
      createdAt: s.createdAt,
    }))
  }

  /** Faz todas as sessões de upload expirarem (como se tivesse passado uma semana). */
  expireUploadSessions() {
    for (const s of this.sessions.values()) s.createdAt = -Infinity
  }

  // ─────────── MD5 ───────────

  _md5(content) {
    if (content.md5) return Promise.resolve(content.md5)
    if (!content.md5Promise) {
      content.md5Promise = this._computeMd5(content).then(
        md5 => (content.md5 = md5),
        err => {
          content.md5Promise = null
          throw err
        },
      )
    }
    return content.md5Promise
  }

  async _computeMd5(content) {
    if (content.kind === 'buffer') return md5Hex(content.buf)
    if (content.kind === 'disk') return md5File(content.path)
    const key = `${content.s}:${content.size}`
    let p = this._virtualMd5.get(key)
    if (!p) {
      p = content.size <= INLINE_MD5_LIMIT ? Promise.resolve(md5VirtualSync(content.s, content.size)) : this._md5Worker(content.s, content.size)
      this._virtualMd5.set(key, p)
      p.catch(() => this._virtualMd5.delete(key))
    }
    return p
  }

  async _md5Worker(s, size) {
    while (this._md5Running >= 2 && !this._closed) await new Promise(resolve => this._md5Queue.push(resolve))
    if (this._closed) throw new Error('mock fechado')
    this._md5Running++
    try {
      return await md5InWorker(s, size, this._workers)
    } finally {
      this._md5Running--
      this._md5Queue.shift()?.()
    }
  }

  // ─────────── JSON no formato do Google ───────────

  async _fileJson(item, mask) {
    const isFolder = item.mimeType === FOLDER_MIME
    const c = item.content
    const j = { kind: 'drive#file', id: item.id, name: item.name, mimeType: item.mimeType }
    if (item.description) j.description = item.description
    j.starred = false
    j.trashed = item.trashed
    j.explicitlyTrashed = item.explicitlyTrashed
    if (item.parents.length) j.parents = [...item.parents]
    j.spaces = ['drive']
    j.version = String(item.version)
    j.webViewLink = isFolder ? `https://drive.google.com/drive/folders/${item.id}` : `https://drive.google.com/file/d/${item.id}/view?usp=drivesdk`
    j.iconLink = `https://drive-thirdparty.googleusercontent.com/16/type/${item.mimeType}`
    j.hasThumbnail = Boolean(item.thumbnail)
    if (item.thumbnail) {
      j.thumbnailLink = `${this.url}/drive-storage/${item.thumbnail.key}=s220`
      j.thumbnailVersion = String(item.version)
    }
    if (item.videoMediaMetadata) {
      const v = item.videoMediaMetadata
      j.videoMediaMetadata = { width: v.width, height: v.height, durationMillis: v.durationMillis != null ? String(v.durationMillis) : undefined }
    }
    if (item.imageMediaMetadata) j.imageMediaMetadata = { ...item.imageMediaMetadata }
    if (item.appProperties) j.appProperties = { ...item.appProperties }
    const sharedRoot = this._sharedRoot(item)
    if (sharedRoot) {
      const by = sharedRoot.shared.by
      j.owners = [{ kind: 'drive#user', displayName: by.displayName, emailAddress: by.emailAddress, me: false }]
      if (item.shared) {
        j.sharedWithMeTime = item.shared.time
        j.sharingUser = { kind: 'drive#user', displayName: by.displayName, emailAddress: by.emailAddress, me: false }
      }
    } else if (!item.driveId) j.owners = [{ kind: 'drive#user', displayName: this.user.displayName, emailAddress: this.user.emailAddress, permissionId: this.user.permissionId, me: true }]
    j.viewedByMe = true
    j.createdTime = item.createdTime
    j.modifiedTime = item.modifiedTime
    j.modifiedByMe = true
    j.modifiedByMeTime = item.modifiedTime
    j.ownedByMe = !item.driveId && !sharedRoot
    const perms = this._permissions(item)
    j.shared = perms.length > 1
    j.permissionIds = perms.map(p => p.id)
    // Como no Google: `permissions` não vem para itens de drive compartilhado nem para quem não pode compartilhar.
    if (!item.driveId && item.canShare) j.permissions = perms.map(p => ({ kind: 'drive#permission', ...p }))
    if (item.driveId) {
      j.driveId = item.driveId
      j.teamDriveId = item.driveId
    }
    if (item.resourceKey) j.resourceKey = item.resourceKey
    if (c) {
      j.originalFilename = item.name
      const ext = extOf(item.name)
      if (ext) {
        j.fullFileExtension = ext
        j.fileExtension = ext
      }
      if (!mask || maskWants(mask, 'md5Checksum')) {
        const known = this._reportedMd5Sync(item)
        const md5 = known ?? (item.md5Override === undefined ? await this._md5(c) : null)
        if (md5) j.md5Checksum = md5
      }
      j.headRevisionId = item.headRevisionId
      j.size = String(c.size)
      j.quotaBytesUsed = String(c.size)
    } else {
      j.quotaBytesUsed = '0'
    }
    if (item.shortcutDetails) j.shortcutDetails = { ...item.shortcutDetails }
    const kind = item.mimeType.startsWith(GAPPS) ? item.mimeType.slice(GAPPS.length) : null
    if (kind && EXPORT_FORMATS[kind]) {
      j.exportLinks = Object.fromEntries(EXPORT_FORMATS[kind].map(m => [m, `https://docs.google.com/feeds/download/${kind}s/Export?id=${item.id}&exportFormat=${encodeURIComponent(m)}`]))
    }
    const writable = this._writable(item)
    j.capabilities = {
      canDownload: item.canDownload,
      canCopy: Boolean(c) && item.canDownload,
      canEdit: writable,
      canRename: writable,
      canDelete: true,
      canTrash: item.canTrash,
      canAddChildren: isFolder && writable,
      canListChildren: isFolder,
      canModifyContent: !isFolder,
      canReadRevisions: Boolean(c),
      canShare: item.canShare,
      canMoveItemWithinDrive: writable && item.parents.length > 0,
    }
    return mask ? applyMask(j, mask) : j
  }

  _driveJson(d) {
    return {
      kind: 'drive#drive',
      id: d.id,
      name: d.name,
      createdTime: d.createdTime,
      hidden: false,
      colorRgb: '#4986e7',
      capabilities: { canAddChildren: true, canListChildren: true, canDownload: true, canEdit: true, canManageMembers: true },
      restrictions: { adminManagedRestrictions: false, copyRequiresWriterPermission: false, domainUsersOnly: Boolean(d.restrictions?.domainUsersOnly), driveMembersOnly: false },
    }
  }

  _usage() {
    let inDrive = 0
    let inTrash = 0
    for (const it of this.items.values()) {
      if (it.driveId || !it.content) continue
      if (it.trashed) inTrash += it.content.size
      else inDrive += it.content.size
    }
    return { inDrive, inTrash, total: inDrive + inTrash }
  }

  // ─────────── HTTP: base ───────────

  _onRequest(req, res) {
    req.on('error', noop)
    res.on('error', noop)
    if (this.options.cors) {
      // setHeader + writeHead: os headers daqui se juntam aos de cada resposta (writeHead/_send/_stream).
      for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-max-age': '600', 'content-length': 0 })
        res.end()
        return
      }
    }
    const p = this._dispatch(req, res).catch(err => {
      if (process.env.MOCK_DRIVE_DEBUG) console.error('[mock-drive]', err)
      this._send(res, 500, gError(500, 'internalError', 'Internal Error'))
    })
    this._handlers.add(p)
    p.finally(() => this._handlers.delete(p))
  }

  _send(res, status, body, headers = {}, statusMessage) {
    if (res.headersSent) {
      if (!res.writableEnded) res.destroy()
      return
    }
    if (res.destroyed || res.socket?.destroyed) return
    let text = ''
    let type = 'application/json; charset=UTF-8'
    if (typeof body === 'string') {
      text = body
      type = 'text/html; charset=UTF-8'
    } else if (body != null) {
      text = JSON.stringify(body)
    }
    const h = { 'content-type': type, 'content-length': Buffer.byteLength(text), ...headers }
    if (statusMessage) res.writeHead(status, statusMessage, h)
    else res.writeHead(status, h)
    res.end(text)
  }

  /** Responde sem ter lido o corpo: descarta até DRAIN_LIMIT; acima disso responde e fecha (como o Google). */
  async _reject(req, res, status, body, headers = {}) {
    const drained = await drainRequest(req, DRAIN_LIMIT, n => (this._stats.bytesReceived += n))
    this._send(res, status, body, drained ? headers : { ...headers, connection: 'close' })
  }

  _injectFault() {
    const f = this.options.failures || {}
    const r = this._rand
    if (f.error5xxProb && r() < f.error5xxProb) {
      this._stats.faults.error5xx++
      return r() < 0.5
        ? { status: 503, body: gError(503, 'backendError', 'Backend Error') }
        : { status: 500, body: gError(500, 'internalError', 'Internal Error') }
    }
    if (f.error429Prob && r() < f.error429Prob) {
      this._stats.faults.error429++
      return { status: 429, body: gError(429, 'rateLimitExceeded', 'Rate Limit Exceeded', { domain: 'usageLimits' }) }
    }
    if (f.rateLimit403Prob && r() < f.rateLimit403Prob) {
      this._stats.faults.rateLimit403++
      return r() < 0.5
        ? { status: 403, body: gError(403, 'userRateLimitExceeded', 'User rate limit exceeded.', { domain: 'usageLimits' }) }
        : { status: 403, body: gError(403, 'rateLimitExceeded', 'Rate limit exceeded.', { domain: 'usageLimits' }) }
    }
    return null
  }

  _checkAuth(req, res, write) {
    const info = this._tokenInfo(req.headers.authorization)
    if (!info) {
      this._send(res, 401, AUTH_ERROR_BODY, AUTH_ERROR_HEADERS)
      return false
    }
    const level = scopeLevel(info.scope)
    if (level === 'none' || (write && level !== 'full')) {
      this._send(res, 403, gError(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.'))
      return false
    }
    return true
  }

  /** Item acessível por id: drives compartilhados exigem supportsAllDrives; resourceKey exige o header. */
  _accessible(rawId, url, req) {
    const item = this.items.get(this._resolve(rawId))
    if (!item) return null
    if (item.driveId && !flag(url, 'supportsAllDrives', 'supportsTeamDrives')) return null
    if (item.resourceKey) {
      const header = String(req.headers['x-goog-drive-resource-keys'] || '')
      const ok = header.split(',').some(pair => pair.trim() === `${item.id}/${item.resourceKey}`)
      if (!ok) return null
    }
    return item
  }

  _parseMask(url, allowed, nested) {
    const fields = url.searchParams.get('fields')
    if (!fields) return { mask: null }
    try {
      const mask = parseFieldMask(fields)
      checkMaskKeys(mask, allowed)
      if (nested) for (const [key, set] of Object.entries(nested)) if (mask[key] && mask[key] !== true) checkMaskKeys(mask[key], set)
      return { mask }
    } catch (err) {
      const msg = `Invalid field selection ${err.badField ?? fields}`
      return { error: gError(400, 'invalidParameter', msg, { location: 'fields' }) }
    }
  }

  async _dispatch(req, res) {
    const url = new URL(req.url, this.url)
    const route = this._route(req.method === 'HEAD' ? 'GET' : req.method, url)
    this._stats.requests[route.name] = (this._stats.requests[route.name] || 0) + 1
    if (this.options.latencyMs > 0) {
      await delay(this.options.latencyMs, this._closing.signal)
      if (this._closed) return void res.destroy()
    }
    await route.run(req, res, url)
  }

  _route(method, url) {
    const p = url.pathname
    const drive = (name, fn, { write = false } = {}) => ({
      name,
      run: async (req, res, url) => {
        if (!this._checkAuth(req, res, write)) return
        const fault = this._injectFault()
        if (fault) return this._send(res, fault.status, fault.body)
        return fn(req, res, url)
      },
    })
    const notFound = { name: 'unknown', run: (req, res) => this._reject(req, res, 404, gError(404, 'notFound', 'Not Found')) }

    if (p === '/o/oauth2/v2/auth' && method === 'GET') return { name: 'oauth.auth', run: (q, s, u) => this._oauthAuth(q, s, u) }
    if (p === '/token' && method === 'POST') return { name: 'oauth.token', run: (q, s) => this._oauthToken(q, s) }
    if (p === '/revoke' && (method === 'POST' || method === 'GET')) return { name: 'oauth.revoke', run: (q, s, u) => this._oauthRevoke(q, s, u) }

    // thumbnailLink: como o lh3.googleusercontent.com/drive-storage/…=s220, só abre com o token da conta.
    const tm = /^\/drive-storage\/([A-Za-z0-9_-]+)=s(\d+)$/.exec(p)
    if (tm && method === 'GET') {
      return {
        name: 'thumbnail',
        run: (req, res) => {
          if (!this._checkAuth(req, res, false)) return
          const id = this.thumbKeys.get(tm[1])
          const item = id && this.items.get(id)
          if (!item?.thumbnail || item.thumbnail.key !== tm[1]) return this._send(res, 404, '<!doctype html><title>Error 404 (Not Found)</title>')
          this._stats.thumbGets++
          this._stats.thumbSizes.push(Number(tm[2]))
          const buf = item.thumbnail.buf
          res.writeHead(200, { 'content-type': imageType(buf), 'content-length': buf.length, 'cache-control': 'private, max-age=86400' })
          res.end(req.method === 'HEAD' ? undefined : buf)
        },
      }
    }

    const UP = '/upload/drive/v3/files'
    if (p === UP || p.startsWith(`${UP}/`)) {
      const rest = p.slice(UP.length)
      const uploadId = url.searchParams.get('upload_id')
      if (uploadId) {
        if (method === 'PUT') return { name: 'upload.put', run: (q, s, u) => this._sessionPut(q, s, u, uploadId) }
        if (method === 'DELETE') return { name: 'upload.cancel', run: (q, s) => this._sessionDelete(q, s, uploadId) }
        return notFound
      }
      if (rest === '' && method === 'POST') return drive('upload.create', (q, s, u) => this._uploadInit(q, s, u, null), { write: true })
      const m = /^\/([^/]+)$/.exec(rest)
      if (m && method === 'PATCH') return drive('upload.update', (q, s, u) => this._uploadInit(q, s, u, safeDecode(m[1])), { write: true })
      return notFound
    }

    const thumb = /^\/thumbnails\/([^/]+)$/.exec(p)
    if (thumb && method === 'GET') return { name: 'thumbnail', run: (q, s) => this._thumbnailGet(q, s, safeDecode(thumb[1])) }

    if (!p.startsWith('/drive/v3/')) return notFound
    const segs = p.slice('/drive/v3/'.length).split('/').map(safeDecode)
    if (segs[0] === 'about' && segs.length === 1 && method === 'GET') return drive('about.get', (q, s, u) => this._about(q, s, u))
    if (segs[0] === 'drives') {
      if (segs.length === 1 && method === 'GET') return drive('drives.list', (q, s, u) => this._drivesList(q, s, u))
      if (segs.length === 2 && method === 'GET') return drive('drives.get', (q, s, u) => this._drivesGet(q, s, u, segs[1]))
      return notFound
    }
    if (segs[0] === 'files') {
      if (segs.length === 1 && method === 'GET') return drive('files.list', (q, s, u) => this._filesList(q, s, u))
      if (segs.length === 1 && method === 'POST') return drive('files.create', (q, s, u) => this._filesCreate(q, s, u), { write: true })
      if (segs.length === 2 && segs[1]) {
        const id = segs[1]
        if (method === 'GET') {
          const media = url.searchParams.get('alt') === 'media'
          return drive(media ? 'files.media' : 'files.get', (q, s, u) => this._filesGet(q, s, u, id))
        }
        if (method === 'PATCH') return drive('files.update', (q, s, u) => this._filesUpdate(q, s, u, id), { write: true })
        if (method === 'DELETE') return drive('files.delete', (q, s, u) => this._filesDelete(q, s, u, id), { write: true })
      }
      if (segs.length === 3 && segs[2] === 'export' && method === 'GET') return drive('files.export', (q, s, u) => this._filesExport(q, s, u, segs[1]))
      if (segs.length === 3 && segs[2] === 'copy' && method === 'POST') return drive('files.copy', (q, s, u) => this._filesCopy(q, s, u, segs[1]), { write: true })
      if (segs.length === 3 && segs[1] && segs[2] === 'permissions') {
        if (method === 'GET') return drive('permissions.list', (q, s, u) => this._permissionsList(q, s, u, segs[1]))
        if (method === 'POST') return drive('permissions.create', (q, s, u) => this._permissionsCreate(q, s, u, segs[1]), { write: true })
      }
    }
    return notFound
  }

  // ─────────── OAuth ───────────

  _oauthPage(res, status, error, description) {
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
    this._send(res, status, `<!doctype html><title>Error ${status}: ${esc(error)}</title><h1>Error ${status}: ${esc(error)}</h1><p>${esc(description)}</p>`)
  }

  _oauthAuth(req, res, url) {
    const p = url.searchParams
    const clientId = p.get('client_id')
    if (!clientId) return this._oauthPage(res, 400, 'invalid_request', 'Missing required parameter: client_id')
    if (clientId !== this.client.clientId) return this._oauthPage(res, 401, 'invalid_client', 'The OAuth client was not found.')
    const redirectUri = p.get('redirect_uri')
    if (!redirectUri) return this._oauthPage(res, 400, 'invalid_request', 'Missing required parameter: redirect_uri')
    if (!isLoopbackRedirect(redirectUri)) return this._oauthPage(res, 400, 'redirect_uri_mismatch', `Invalid redirect_uri for a desktop app: ${redirectUri}`)
    if (p.get('response_type') !== 'code') return this._oauthPage(res, 400, 'unsupported_response_type', `Invalid response_type: ${p.get('response_type')}`)
    const scope = (p.get('scope') || '').trim()
    if (!scope) return this._oauthPage(res, 400, 'invalid_request', 'Missing required parameter: scope')
    const challenge = p.get('code_challenge')
    const method = p.get('code_challenge_method')
    if (!challenge) return this._oauthPage(res, 400, 'invalid_request', 'Missing required parameter: code_challenge')
    if (method !== 'S256') return this._oauthPage(res, 400, 'invalid_request', `Invalid code_challenge_method: ${method}`)
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return this._oauthPage(res, 400, 'invalid_request', 'Invalid code_challenge.')
    const state = p.get('state')
    const target = new URL(redirectUri)
    if (this.options.authDeny) {
      target.searchParams.set('error', 'access_denied')
    } else {
      const code = `4/0A${randomId(60)}`
      const granted = this._grantScope(scope)
      this.codes.set(code, { clientId, redirectUri, challenge, scope: granted, expiresAt: Date.now() + CODE_TTL_MS })
      target.searchParams.set('code', code)
      target.searchParams.set('scope', granted)
    }
    if (state != null) target.searchParams.set('state', state)
    this._send(res, 302, null, { location: target.toString() })
  }

  async _oauthToken(req, res) {
    let params
    try {
      const raw = (await readBody(req, 64 * KiB)).toString('utf8')
      const type = String(req.headers['content-type'] || '')
      params = type.includes('application/json') ? new URLSearchParams(Object.entries(JSON.parse(raw || '{}')).map(([k, v]) => [k, String(v)])) : new URLSearchParams(raw)
    } catch {
      return this._send(res, 400, { error: 'invalid_request', error_description: 'Invalid request body.' })
    }
    const get = k => params.get(k)
    const fail = (status, error, description) => this._send(res, status, { error, error_description: description })
    const clientId = get('client_id')
    const secret = get('client_secret')
    if (!clientId) return fail(400, 'invalid_request', 'Could not determine client ID from request.')
    if (clientId !== this.client.clientId) return fail(401, 'invalid_client', 'The OAuth client was not found.')
    if (!secret) {
      if (this.options.requireClientSecret) return fail(400, 'invalid_request', 'client_secret is missing.')
    } else if (secret !== this.client.clientSecret) {
      return fail(401, 'invalid_client', 'Unauthorized')
    }
    const grant = get('grant_type')
    const ttl = this.options.tokenTtlSec

    if (grant === 'authorization_code') {
      const code = get('code')
      if (!code) return fail(400, 'invalid_request', 'Missing required parameter: code')
      const rec = this.codes.get(code)
      this.codes.delete(code) // uso único, mesmo que a troca falhe adiante
      if (!rec) return fail(400, 'invalid_grant', this.usedCodes.has(code) ? 'Bad Request' : 'Malformed auth code.')
      this.usedCodes.add(code)
      if (rec.expiresAt < Date.now()) return fail(400, 'invalid_grant', 'Bad Request')
      if (rec.clientId !== clientId) return fail(400, 'invalid_grant', 'Bad Request')
      if (get('redirect_uri') !== rec.redirectUri) return fail(400, 'redirect_uri_mismatch', 'Bad Request')
      const verifier = get('code_verifier')
      if (!verifier) return fail(400, 'invalid_grant', 'Missing code verifier.')
      if (s256(verifier) !== rec.challenge) return fail(400, 'invalid_grant', 'Invalid code verifier.')
      const refreshToken = `1//mock-${randomId(40)}`
      this.refreshTokens.set(refreshToken, { scope: rec.scope, clientId, revoked: false })
      const body = { access_token: this._issueAccess(rec.scope, refreshToken), expires_in: ttl, scope: rec.scope, token_type: 'Bearer' }
      if (!this.options.omitRefreshToken) body.refresh_token = refreshToken
      return this._send(res, 200, body, { 'cache-control': 'no-store' })
    }

    if (grant === 'refresh_token') {
      const token = get('refresh_token')
      if (!token) return fail(400, 'invalid_request', 'Missing required parameter: refresh_token')
      const rec = this.refreshTokens.get(token)
      if (!rec || rec.revoked) return fail(400, 'invalid_grant', 'Token has been expired or revoked.')
      if (rec.clientId !== clientId) return fail(401, 'unauthorized_client', 'Unauthorized')
      const body = { access_token: this._issueAccess(rec.scope, token), expires_in: ttl, scope: rec.scope, token_type: 'Bearer' }
      return this._send(res, 200, body, { 'cache-control': 'no-store' })
    }

    return fail(400, 'unsupported_grant_type', `Invalid grant_type: ${grant ?? ''}`)
  }

  async _oauthRevoke(req, res, url) {
    let token = url.searchParams.get('token')
    if (!token && req.method === 'POST') {
      try {
        token = new URLSearchParams((await readBody(req, 64 * KiB)).toString('utf8')).get('token')
      } catch {
        token = null
      }
    }
    const refresh = token && this.refreshTokens.get(token)
    const access = token && this.accessTokens.get(token)
    // Revogar qualquer um dos dois derruba a concessão inteira (refresh + access derivados), como no Google.
    const grantToken = refresh ? token : access?.refreshToken
    const live = (refresh && !refresh.revoked) || (access && !access.revoked && access.expiresAt > Date.now())
    if (!live) return this._send(res, 400, { error: 'invalid_token', error_description: 'Token expired or revoked' })
    if (access) access.revoked = true
    if (grantToken) {
      const rec = this.refreshTokens.get(grantToken)
      if (rec) rec.revoked = true
      for (const info of this.accessTokens.values()) if (info.refreshToken === grantToken) info.revoked = true
    }
    this._send(res, 200, {})
  }

  // ─────────── Drive: about e drives ───────────

  _about(req, res, url) {
    if (!url.searchParams.get('fields')) {
      return this._send(res, 400, gError(400, 'required', "The 'fields' parameter is required for this method.", { location: 'fields' }))
    }
    const { mask, error } = this._parseMask(url, ABOUT_FIELDS)
    if (error) return this._send(res, 400, error)
    const u = this._usage()
    const quota = { usage: String(u.total), usageInDrive: String(u.inDrive), usageInDriveTrash: String(u.inTrash) }
    if (this.options.storageLimitBytes != null) quota.limit = String(this.options.storageLimitBytes)
    const about = {
      kind: 'drive#about',
      user: { kind: 'drive#user', displayName: this.user.displayName, photoLink: this.user.photoLink, me: true, permissionId: this.user.permissionId, emailAddress: this.user.emailAddress },
      storageQuota: quota,
      maxUploadSize: String(MAX_FILE_SIZE),
      appInstalled: false,
      canCreateDrives: true,
      canCreateTeamDrives: true,
    }
    this._send(res, 200, applyMask(about, mask))
  }

  _drivesList(req, res, url) {
    const pageSize = parsePageSize(url.searchParams.get('pageSize'), 10, 100)
    if (pageSize == null) {
      const v = url.searchParams.get('pageSize')
      return this._send(res, 400, gError(400, 'invalid', `Invalid value '${v}'. Values must be within the range: [1, 100]`, { location: 'pageSize' }))
    }
    const { mask, error } = this._parseMask(url, DRIVE_LIST_FIELDS, { drives: DRIVE_FIELDS })
    if (error) return this._send(res, 400, error)
    let offset = 0
    const token = url.searchParams.get('pageToken')
    if (token) {
      const t = decodePageToken(token)
      if (!t || t.k !== 'drives') return this._send(res, 400, gError(400, 'invalid', 'Invalid Value', { location: 'pageToken' }))
      offset = t.o
    }
    const all = [...this.drives.values()]
    const page = all.slice(offset, offset + pageSize)
    const body = { kind: 'drive#driveList', drives: page.map(d => this._driveJson(d)) }
    if (offset + pageSize < all.length) body.nextPageToken = encodePageToken({ k: 'drives', o: offset + pageSize })
    this._send(res, 200, applyMask(body, mask ?? DEFAULT_DRIVE_LIST_MASK))
  }

  _drivesGet(req, res, url, id) {
    const d = this.drives.get(id)
    if (!d) return this._send(res, 404, gError(404, 'notFound', `Shared drive not found: ${id}`, { location: 'driveId' }))
    const { mask, error } = this._parseMask(url, DRIVE_FIELDS)
    if (error) return this._send(res, 400, error)
    this._send(res, 200, applyMask(this._driveJson(d), mask ?? DEFAULT_DRIVE_MASK))
  }

  // ─────────── Drive: arquivos ───────────

  _evalQuery(node, item) {
    switch (node.op) {
      case 'or': return this._evalQuery(node.a, item) || this._evalQuery(node.b, item)
      case 'and': return this._evalQuery(node.a, item) && this._evalQuery(node.b, item)
      case 'not': return !this._evalQuery(node.a, item)
      case 'const': return node.value
      case 'shared': return Boolean(item.shared) === node.value
      case 'in':
        if (node.field === 'parents') return item.parents.includes(this._resolve(node.value))
        if (node.value !== 'me' && node.value !== this.user.emailAddress) return false
        return node.field === 'owners' ? !item.driveId && !this._sharedRoot(item) : true
      case 'cmp': {
        const { field, operator, value } = node
        if (field === 'name') {
          if (operator === 'contains') return nameContains(item.name, value)
          // `name =` no Drive não diferencia maiúsculas (quem busca precisa conferir o nome exato do lado de cá).
          const eq = this.options.nameQueryCaseSensitive ? item.name === value : item.name.toLowerCase() === value.toLowerCase()
          return operator === '=' ? eq : !eq
        }
        if (field === 'fullText') return item.name.toLowerCase().includes(value.toLowerCase())
        if (field === 'mimeType') {
          if (operator === 'contains') return item.mimeType.includes(value)
          return operator === '=' ? item.mimeType === value : item.mimeType !== value
        }
        if (field === 'trashed') return operator === '=' ? item.trashed === value : item.trashed !== value
        if (field === 'starred') return operator === '=' ? value === false : value !== false
        const mine = Date.parse(field === 'createdTime' ? item.createdTime : item.modifiedTime)
        return compareOp(mine, Date.parse(value), operator)
      }
      default:
        return false
    }
  }

  async _filesList(req, res, url) {
    const sp = url.searchParams
    const pageSize = parsePageSize(sp.get('pageSize'), 100, 1000)
    if (pageSize == null) {
      return this._send(res, 400, gError(400, 'invalid', `Invalid value '${sp.get('pageSize')}'. Values must be within the range: [1, 1000]`, { location: 'pageSize' }))
    }
    const { mask, error } = this._parseMask(url, FILE_LIST_FIELDS, { files: FILE_FIELDS })
    if (error) return this._send(res, 400, error)
    const supportsAll = flag(url, 'supportsAllDrives', 'supportsTeamDrives')
    const includeAll = flag(url, 'includeItemsFromAllDrives', 'includeTeamDriveItems')
    const corpora = sp.get('corpora') || 'user'
    const driveId = sp.get('driveId') || sp.get('teamDriveId')
    if (!['user', 'drive', 'allDrives', 'domain'].includes(corpora)) {
      return this._send(res, 400, gError(400, 'invalid', 'Invalid Value', { location: 'corpora' }))
    }
    if ((corpora === 'drive') !== Boolean(driveId)) {
      return this._send(res, 400, gError(400, 'invalid', 'The driveId parameter must be specified if and only if corpora is set to drive.', { location: 'driveId' }))
    }
    if ((corpora === 'drive' || corpora === 'allDrives') && !(includeAll && supportsAll)) {
      return this._send(res, 400, gError(400, 'invalid', 'includeItemsFromAllDrives and supportsAllDrives must be true when corpora is drive or allDrives.', { location: 'includeItemsFromAllDrives' }))
    }
    if (driveId && !this.drives.has(driveId)) {
      return this._send(res, 404, gError(404, 'notFound', `Shared drive not found: ${driveId}`, { location: 'driveId' }))
    }
    let ast = null
    let orderBy
    try {
      if (sp.get('q')) ast = parseQuery(sp.get('q'))
      orderBy = parseOrderBy(sp.get('orderBy'))
    } catch {
      return this._send(res, 400, gError(400, 'invalid', 'Invalid Value', { location: sp.get('q') && !ast ? 'q' : 'orderBy' }))
    }
    const queryKey = crypto.createHash('sha1').update(JSON.stringify([sp.get('q'), sp.get('orderBy'), corpora, driveId, includeAll, supportsAll])).digest('base64url').slice(0, 12)
    let offset = 0
    if (sp.get('pageToken')) {
      const t = decodePageToken(sp.get('pageToken'))
      if (!t || t.k !== queryKey) return this._send(res, 400, gError(400, 'invalid', 'Invalid Value', { location: 'pageToken' }))
      offset = t.o
    }

    const hint = ast ? parentConstraint(ast) : null
    const pool = hint != null ? [...(this.children.get(this._resolve(hint)) || [])].map(id => this.items.get(id)) : [...this.items.values()]
    // Itens de drives compartilhados só aparecem com includeItemsFromAllDrives=true E supportsAllDrives=true.
    const showShared = includeAll && supportsAll
    const matches = pool.filter(it =>
      it &&
      (it.parents.length > 0 || Boolean(it.shared)) &&
      (it.driveId ? showShared && (corpora !== 'drive' || it.driveId === driveId) : corpora !== 'drive') &&
      (!ast || this._evalQuery(ast, it)),
    )
    matches.sort((a, b) => {
      for (const { key, desc } of orderBy) {
        let c = 0
        if (key === 'folder') c = Number(b.mimeType === FOLDER_MIME) - Number(a.mimeType === FOLDER_MIME)
        else if (key === 'name') c = collator.compare(a.name, b.name)
        else if (key === 'name_natural') c = naturalCollator.compare(a.name, b.name)
        else if (key === 'modifiedTime' || key === 'recency' || key === 'modifiedByMeTime') c = a.modifiedTime.localeCompare(b.modifiedTime)
        else if (key === 'createdTime') c = a.createdTime.localeCompare(b.createdTime)
        else if (key === 'sharedWithMeTime') c = (a.shared?.time || '').localeCompare(b.shared?.time || '')
        else if (key === 'quotaBytesUsed') c = (a.content?.size ?? 0) - (b.content?.size ?? 0)
        if (c) return desc ? -c : c
      }
      return a.seq - b.seq
    })

    let end = Math.min(matches.length, offset + pageSize)
    // Páginas curtas (até vazias) com nextPageToken acontecem no Google: quem lista precisa seguir o token.
    const f = this.options.failures || {}
    if (end < matches.length && f.shortPageProb && this._rand() < f.shortPageProb) {
      this._stats.faults.shortPages++
      end = offset + Math.floor(this._rand() * (end - offset))
    }
    const page = matches.slice(offset, end)
    const effective = mask ?? DEFAULT_LIST_MASK
    const filesMask = effective === true || effective['*'] ? true : effective.files ?? null
    const files = await Promise.all(page.map(it => this._fileJson(it, filesMask === true ? null : filesMask ?? { id: true })))
    const body = { kind: 'drive#fileList', incompleteSearch: false, files }
    if (end < matches.length) body.nextPageToken = encodePageToken({ k: queryKey, o: end })
    this._send(res, 200, applyMask(body, effective))
  }

  async _filesGet(req, res, url, rawId) {
    const item = this._accessible(rawId, url, req)
    if (!item) return this._send(res, 404, notFoundFile(rawId))
    if (url.searchParams.get('alt') === 'media') return this._media(req, res, url, item)
    const { mask, error } = this._parseMask(url, FILE_FIELDS)
    if (error) return this._send(res, 400, error)
    this._send(res, 200, await this._fileJson(item, mask ?? DEFAULT_FILE_MASK))
  }

  async _media(req, res, url, item) {
    this._stats.mediaGets++
    const hasRange = req.headers.range != null
    if (hasRange) this._stats.rangeGets++
    if (!item.content) {
      return this._send(res, 403, gError(403, 'fileNotDownloadable', 'Only files with binary content can be downloaded. Use Export with Docs Editors files.', { location: 'alt' }))
    }
    if (!item.canDownload) return this._send(res, 403, gError(403, 'cannotDownloadFile', 'The user does not have permission to download this file.'))
    if (this.options.downloadQuotaExceededIds?.has(item.id)) {
      return this._send(res, 403, gError(403, 'downloadQuotaExceeded', 'The download quota for this file has been exceeded.', { domain: 'usageLimits' }))
    }
    const content = item.content
    const size = content.size
    const f = this.options.failures || {}
    let start = 0
    let end = size - 1
    let partial = false
    if (hasRange && this.options.ignoreRange) this._stats.faults.ignoredRange++
    if (hasRange && !this.options.ignoreRange) {
      const r = parseRange(String(req.headers.range), size)
      if (r === 'unsatisfiable') {
        return this._send(res, 416, gError(416, 'requestedRangeNotSatisfiable', 'Request range not satisfiable'), { 'content-range': `bytes */${size}` })
      }
      if (r) {
        ;({ start, end } = r)
        partial = true
      }
    }
    if (partial && f.wrongRangeProb && this._rand() < f.wrongRangeProb && size > 1) {
      // 206 "certinho" mas de outro trecho: o Content-Range diz a verdade, quem baixa precisa conferir.
      const len = end - start + 1
      const maxShift = Math.max(1, Math.min(MiB, size - 1))
      let wrong = start
      while (wrong === start) {
        const shift = 1 + Math.floor(this._rand() * maxShift)
        wrong = this._rand() < 0.5 && start - shift >= 0 ? start - shift : Math.min(size - 1, start + shift)
        if (wrong === start) wrong = start > 0 ? start - 1 : start + 1
      }
      this._stats.faults.wrongRange++
      start = wrong
      end = Math.min(size - 1, wrong + len - 1)
    }
    const headers = {
      'content-type': item.mimeType,
      'content-length': partial ? end - start + 1 : size,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=0',
    }
    if (partial) headers['content-range'] = `bytes ${start}-${end}/${size}`
    const len = partial ? end - start + 1 : size
    let dropAt = null
    let stallAt = null
    if (len > 0 && f.dropDownloadProb && this._rand() < f.dropDownloadProb) {
      this._stats.faults.downloadDrops++
      dropAt = start + Math.floor(this._rand() * len)
    } else if (len > 0 && f.stallDownloadProb && this._rand() < f.stallDownloadProb) {
      this._stats.faults.downloadStalls++
      stallAt = start + Math.floor(this._rand() * len)
    }
    const corruptAt = this.options.corruptMediaBytes?.[item.id] ?? null
    await this._stream(req, res, partial ? 206 : 200, headers, content, start, start + len, { dropAt, stallAt, corruptAt })
  }

  /** Manda [start, endExcl) do conteúdo respeitando backpressure, banda por conexão e falhas sorteadas. */
  async _stream(req, res, status, headers, content, start, endExcl, { dropAt = null, stallAt = null, corruptAt = null } = {}) {
    const st = this._stats
    st.activeMediaConnections++
    st.maxActiveMediaConnections = Math.max(st.maxActiveMediaConnections, st.activeMediaConnections)
    let fh = null
    try {
      if (connectionGone(req, res)) return
      res.writeHead(status, headers)
      if (req.method === 'HEAD') return void res.end()
      if (content.kind === 'disk') fh = await fsp.open(content.path, 'r')
      const signal = this._closing.signal
      const pacer = new Pacer(() => this.options.perConnectionBps, signal)
      let pos = start
      while (pos < endExcl) {
        if (connectionGone(req, res) || this._closed) return
        if (stallAt != null && pos >= stallAt) {
          // Trava: cabeçalhos e parte do corpo já foram, e não vem mais nada até o cliente desistir.
          await waitClosed(req, res, signal)
          return
        }
        if (dropAt != null && pos >= dropAt) {
          res.destroy()
          return
        }
        let n = Math.min(endExcl - pos, chunkSizeFor(this.options.perConnectionBps))
        const limit = stallAt ?? dropAt
        if (limit != null && limit > pos) n = Math.min(n, limit - pos)
        let buf
        if (content.kind === 'virtual') buf = fillVirtual(content.s, pos, Buffer.allocUnsafe(n), 0, n)
        else if (content.kind === 'buffer') buf = content.buf.subarray(pos, pos + n)
        else {
          buf = Buffer.allocUnsafe(n)
          const { bytesRead } = await fh.read(buf, 0, n, pos)
          if (bytesRead !== n) throw new Error('arquivo do mock encolheu')
        }
        if (corruptAt != null && corruptAt >= pos && corruptAt < pos + n) {
          buf = Buffer.from(buf) // cópia: o conteúdo guardado não muda
          buf[corruptAt - pos] ^= 0xff
          st.faults.corruptedBytes = (st.faults.corruptedBytes || 0) + 1
        }
        pos += n
        st.bytesServed += n
        if (pos >= endExcl) {
          // Último pedaço junto com o fim: o contador de conexões ativas cai antes de o cliente ver o último byte.
          res.end(buf)
          return
        }
        if (!res.write(buf)) await waitDrain(res, signal)
        await pacer.pace(n)
      }
      if (!connectionGone(req, res)) res.end()
    } finally {
      st.activeMediaConnections--
      await fh?.close().catch(noop)
    }
  }

  async _filesExport(req, res, url, rawId) {
    const item = this._accessible(rawId, url, req)
    if (!item) return this._send(res, 404, notFoundFile(rawId))
    const mime = url.searchParams.get('mimeType')
    if (!mime) return this._send(res, 400, gError(400, 'required', 'Required parameter: mimeType', { location: 'mimeType' }))
    const kind = item.mimeType.startsWith(GAPPS) ? item.mimeType.slice(GAPPS.length) : null
    if (!kind || item.mimeType === FOLDER_MIME || item.mimeType === SHORTCUT_MIME) {
      return this._send(res, 403, gError(403, 'fileNotExportable', 'Export only supports Docs Editors files.'))
    }
    if (!(EXPORT_FORMATS[kind] || []).includes(mime)) {
      return this._send(res, 400, gError(400, 'badRequest', 'The requested conversion is not supported.', { location: 'mimeType' }))
    }
    if (!item.canDownload) return this._send(res, 403, gError(403, 'cannotDownloadFile', 'The user does not have permission to download this file.'))
    if ((item.docSize ?? 0) > EXPORT_LIMIT) {
      return this._send(res, 403, gError(403, 'exportSizeLimitExceeded', 'This file is too large to be exported.'))
    }
    // Exportação: sem Range, sem Content-Length (chunked), sem md5 — igual ao Google.
    const size = item.docSize ?? 2048
    const content = { kind: 'virtual', s: seed32(`${item.id}|${mime}|${item.version}`), size }
    await this._stream(req, res, 200, { 'content-type': mime, 'cache-control': 'private, max-age=0' }, content, 0, size)
  }

  // ─────────── Drive: compartilhamento ───────────

  _permissionsList(req, res, url, rawId) {
    const item = this._accessible(rawId, url, req)
    if (!item) return this._send(res, 404, notFoundFile(rawId))
    const { mask, error } = this._parseMask(url, PERMISSION_LIST_FIELDS, { permissions: PERMISSION_FIELDS })
    if (error) return this._send(res, 400, error)
    const pageSize = parsePageSize(url.searchParams.get('pageSize'), 100, 100)
    if (pageSize == null) return this._send(res, 400, gError(400, 'invalid', 'Invalid value for pageSize.', { location: 'pageSize' }))
    // Fora de drive compartilhado, só quem pode compartilhar enxerga a lista.
    if (!item.driveId && !item.canShare) return this._send(res, 403, gError(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.'))
    const all = this._permissions(item)
    let offset = 0
    const token = url.searchParams.get('pageToken')
    if (token) {
      const t = decodePageToken(token)
      if (!t || t.k !== `perm:${item.id}`) return this._send(res, 400, gError(400, 'invalid', 'Invalid Value', { location: 'pageToken' }))
      offset = t.o
    }
    const page = all.slice(offset, offset + pageSize).map(p => ({ kind: 'drive#permission', ...p }))
    const body = { kind: 'drive#permissionList', permissions: page }
    if (offset + pageSize < all.length) body.nextPageToken = encodePageToken({ k: `perm:${item.id}`, o: offset + pageSize })
    this._send(res, 200, applyMask(body, mask ?? { kind: true, nextPageToken: true, permissions: DEFAULT_PERMISSION_MASK }))
  }

  async _permissionsCreate(req, res, url, rawId) {
    let perm
    try {
      perm = await this._jsonBody(req)
    } catch {
      return this._send(res, 400, gError(400, 'parseError', 'Parse Error'))
    }
    const item = this._accessible(rawId, url, req)
    if (!item) return this._send(res, 404, notFoundFile(rawId))
    const { mask, error } = this._parseMask(url, PERMISSION_FIELDS)
    if (error) return this._send(res, 400, error)
    const bad = (msg, location) => this._send(res, 400, gError(400, 'invalid', msg, { location }))
    if (!PERMISSION_TYPES.has(perm.type)) return bad('The permission type field is required.', 'permission.type')
    if (!PERMISSION_ROLES.has(perm.role)) return bad('The permission role field is required.', 'permission.role')
    if ((perm.type === 'user' || perm.type === 'group') && !perm.emailAddress) return bad('The permission emailAddress field is required.', 'permission.emailAddress')
    if (perm.type === 'domain' && !perm.domain) return bad('The permission domain field is required.', 'permission.domain')
    const forbidden = (reason, msg) => this._send(res, 403, gError(403, reason, msg))
    const wide = perm.type === 'anyone' || perm.type === 'domain'
    if (!item.parents.length) {
      if (item.driveId && wide) return forbidden('cannotShareTeamDriveTopFolderWithAnyoneOrDomains', 'The top-level folder of a shared drive cannot be shared with anyone or domains.')
      return forbidden('insufficientFilePermissions', 'The user does not have sufficient permissions for this file.')
    }
    if (!item.canShare) return forbidden('insufficientFilePermissions', 'The user does not have sufficient permissions for this file.')
    if (perm.type === 'anyone' && this.options.anyoneSharingBlocked) {
      return forbidden('publishOutNotPermitted', 'Bad Request. User message: "Sharing with anyone is not allowed by your organization."')
    }
    if (wide && item.driveId && this.drives.get(item.driveId)?.restrictions?.domainUsersOnly) {
      return forbidden('teamDriveDomainUsersOnlyRestriction', "The request was not completed because the shared drive's restrictions do not permit this action.")
    }
    const created = this._addPermission(item, perm)
    this._send(res, 200, applyMask({ kind: 'drive#permission', ...created }, mask ?? DEFAULT_PERMISSION_MASK))
  }

  async _jsonBody(req, limit = MiB) {
    const raw = await readBody(req, limit)
    if (!raw.length) return {}
    const meta = JSON.parse(raw.toString('utf8'))
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new SyntaxError('metadados inválidos')
    if (meta.name != null && typeof meta.name !== 'string') throw new SyntaxError('name precisa ser texto')
    return meta
  }

  async _filesCreate(req, res, url) {
    let meta
    try {
      meta = await this._jsonBody(req)
    } catch {
      return this._send(res, 400, gError(400, 'parseError', 'Parse Error'))
    }
    const { mask, error } = this._parseMask(url, FILE_FIELDS)
    if (error) return this._send(res, 400, error)
    const parent = this._metaParent(meta, url, res)
    if (!parent) return
    if (meta.modifiedTime != null && !isIsoDate(meta.modifiedTime)) {
      return this._send(res, 400, gError(400, 'invalid', 'Invalid value for: modifiedTime', { location: 'modifiedTime' }))
    }
    const mimeType = meta.mimeType || 'application/octet-stream'
    let shortcutDetails = null
    if (mimeType === SHORTCUT_MIME) {
      const target = this.items.get(this._resolve(meta.shortcutDetails?.targetId ?? ''))
      if (!target) return this._send(res, 400, gError(400, 'invalid', 'A shortcut must have a valid target.', { location: 'shortcutDetails.targetId' }))
      shortcutDetails = { targetId: target.id, targetMimeType: target.mimeType }
    }
    const binary = !mimeType.startsWith(GAPPS)
    const props = mergeAppProperties(null, meta.appProperties)
    if (props?.error) return this._send(res, 400, gError(400, 'invalid', props.error, { location: 'appProperties' }))
    const item = this._insert({
      name: meta.name ?? 'Untitled',
      mimeType,
      parentId: parent.id,
      content: binary ? { kind: 'buffer', buf: Buffer.alloc(0), size: 0, md5: null } : null,
      modifiedTime: meta.modifiedTime ? toIso(meta.modifiedTime) : undefined,
      description: meta.description ?? null,
      shortcutDetails,
      appProperties: props,
    })
    this._send(res, 200, await this._fileJson(item, mask ?? DEFAULT_FILE_MASK))
  }

  /** files.copy: só arquivo (pasta dá 403), respeita o bloqueio de download/cópia do dono e o resourceKey. */
  async _filesCopy(req, res, url, rawId) {
    let meta
    try {
      meta = await this._jsonBody(req)
    } catch {
      return this._send(res, 400, gError(400, 'parseError', 'Parse Error'))
    }
    const { mask, error } = this._parseMask(url, FILE_FIELDS)
    if (error) return this._send(res, 400, error)
    const src = this._accessible(rawId, url, req)
    if (!src || src.trashed) return this._send(res, 404, notFoundFile(rawId))
    if (src.mimeType === FOLDER_MIME) return this._send(res, 403, gError(403, 'fileNotCopyable', 'This file cannot be copied by the user.'))
    if (!src.canDownload) return this._send(res, 403, gError(403, 'cannotCopyFile', 'This file cannot be copied by the user.'))
    const parent = this._metaParent(meta || {}, url, res)
    if (!parent) return
    this._stats.copies = (this._stats.copies || 0) + 1
    const item = this._insert({
      name: meta?.name ?? `Copy of ${src.name}`,
      mimeType: src.mimeType,
      parentId: parent.id,
      content: src.content,
      docSize: src.docSize,
      videoMediaMetadata: src.videoMediaMetadata,
      imageMediaMetadata: src.imageMediaMetadata,
    })
    this._send(res, 200, await this._fileJson(item, mask ?? DEFAULT_FILE_MASK))
  }

  /** Pasta de destino em metadados de criação: exatamente um pai (padrão: raiz), que precisa ser pasta. */
  _metaParent(meta, url, res) {
    if (meta.parents != null && !Array.isArray(meta.parents)) {
      this._send(res, 400, gError(400, 'invalid', 'Invalid value for: parents', { location: 'parents' }))
      return null
    }
    if ((meta.parents || []).length > 1) {
      this._send(res, 403, gError(403, 'cannotAddParent', 'Increasing the number of parents is not allowed.'))
      return null
    }
    const raw = meta.parents?.[0] ?? 'root'
    const parent = this.items.get(this._resolve(raw))
    if (!parent || (parent.driveId && !flag(url, 'supportsAllDrives', 'supportsTeamDrives'))) {
      this._send(res, 404, notFoundFile(raw))
      return null
    }
    if (parent.mimeType !== FOLDER_MIME) {
      this._send(res, 404, notFoundFile(raw))
      return null
    }
    return parent
  }

  async _filesUpdate(req, res, url, rawId) {
    let meta
    try {
      meta = await this._jsonBody(req, 4 * MiB)
    } catch {
      return this._send(res, 400, gError(400, 'parseError', 'Parse Error'))
    }
    const item = this._accessible(rawId, url, req)
    if (!item) return this._send(res, 404, notFoundFile(rawId))
    const { mask, error } = this._parseMask(url, FILE_FIELDS)
    if (error) return this._send(res, 400, error)
    if (item.parents.length === 0 && !item.shared) return this._send(res, 403, gError(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.'))
    const noPerm = () => this._send(res, 403, gError(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.'))
    if (meta.parents != null) {
      return this._send(res, 403, gError(403, 'fieldNotWritable', 'The resource body includes fields which are not directly writable.'))
    }
    if (meta.modifiedTime != null && !isIsoDate(meta.modifiedTime)) {
      return this._send(res, 400, gError(400, 'invalid', 'Invalid value for: modifiedTime', { location: 'modifiedTime' }))
    }
    const props = mergeAppProperties(item.appProperties, meta.appProperties)
    if (props?.error) return this._send(res, 400, gError(400, 'invalid', props.error, { location: 'appProperties' }))
    let thumbnail = null
    if (meta.contentHints?.thumbnail != null) {
      thumbnail = parseThumbnailHint(meta.contentHints.thumbnail)
      if (thumbnail.error) return this._send(res, 400, gError(400, 'invalid', thumbnail.error, { location: 'contentHints.thumbnail' }))
    }
    const add = (url.searchParams.get('addParents') || '').split(',').filter(Boolean).map(id => this._resolve(id))
    const remove = (url.searchParams.get('removeParents') || '').split(',').filter(Boolean).map(id => this._resolve(id))
    // Renomear ou mover pede edição no item; mover também na pasta de destino. O que veio compartilhado sem pai à
    // vista (a raiz do que foi compartilhado) só quem é dono move.
    if ((meta.name != null || add.length || remove.length) && !this._writable(item)) return noPerm()
    if (add.length && item.parents.length === 0) return noPerm()
    if (add.length && this.items.get(add[0]) && !this._writable(this.items.get(add[0]))) return noPerm()
    if (add.length) {
      const keepsOld = item.parents.some(p => !remove.includes(p))
      if (add.length > 1 || keepsOld) return this._send(res, 403, gError(403, 'cannotAddParent', 'Increasing the number of parents is not allowed.'))
      const target = this.items.get(add[0])
      if (!target || (target.driveId && !flag(url, 'supportsAllDrives', 'supportsTeamDrives'))) return this._send(res, 404, notFoundFile(add[0]))
      if (target.mimeType !== FOLDER_MIME) return this._send(res, 400, gError(400, 'invalid', 'The specified parent is not a folder.', { location: 'addParents' }))
      for (let p = target; p; p = this.items.get(p.parents[0])) {
        if (p.id === item.id) return this._send(res, 403, gError(403, 'cannotMoveItemIntoItself', 'An item cannot be moved into itself or its descendants.'))
      }
      for (const old of item.parents) this.children.get(old)?.delete(item.id)
      item.parents = [target.id]
      this._childrenOf(target.id).add(item.id)
      if (item.driveId !== target.driveId) this._setDriveId(item, target.driveId)
    } else if (remove.length) {
      return this._send(res, 403, gError(403, 'cannotRemoveParent', 'An item must have a parent.'))
    }
    if (meta.trashed != null && typeof meta.trashed !== 'boolean') {
      return this._send(res, 400, gError(400, 'invalid', 'Invalid value for: trashed', { location: 'trashed' }))
    }
    if (meta.trashed === true && !item.trashed && !item.canTrash) return this._send(res, 403, gError(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.'))
    if (meta.name != null) item.name = String(meta.name)
    if (meta.description !== undefined) item.description = meta.description
    // Renomear/mover não mexe em modifiedTime (só quando vem explícito).
    if (meta.modifiedTime != null) item.modifiedTime = toIso(meta.modifiedTime)
    if (typeof meta.trashed === 'boolean' && meta.trashed !== item.trashed) this._setTrashed(item, meta.trashed)
    item.appProperties = props
    if (thumbnail) {
      // Como no Google: a miniatura nossa só vale para arquivo com conteúdo e cai quando o conteúdo muda.
      if (item.content) this._setThumbnail(item, thumbnail.data, thumbnail.mimeType)
      this._stats.thumbnailsSet++
    }
    item.version++
    this._send(res, 200, await this._fileJson(item, mask ?? DEFAULT_FILE_MASK))
  }

  /** thumbnailLink: a imagem gravada (no Google é um endereço temporário do googleusercontent). */
  _thumbnailGet(req, res, id) {
    const t = this.items.get(id)?.thumbnail
    if (!t) return this._reject(req, res, 404, gError(404, 'notFound', 'Not Found'))
    res.writeHead(200, { 'content-type': t.mimeType, 'content-length': t.data.length, 'cache-control': 'private, max-age=60' })
    res.end(t.data)
  }

  _filesDelete(req, res, url, rawId) {
    const item = this._accessible(rawId, url, req)
    if (!item) return this._send(res, 404, notFoundFile(rawId))
    if (item.parents.length === 0) return this._send(res, 403, gError(403, 'insufficientFilePermissions', 'The user does not have sufficient permissions for this file.'))
    this._remove(item.id)
    res.writeHead(204)
    res.end()
  }

  // ─────────── upload retomável ───────────

  _capCrossed() {
    const limit = this.options.uploadDailyLimitBytes
    return limit > 0 && this.dailyUploaded > limit
  }

  _countUploaded(session, n) {
    const before = this._capCrossed()
    this.dailyUploaded += n
    this._stats.dailyUploadBytes = this.dailyUploaded
    // A sessão que cruza o limite pode terminar; as outras levam 403 (o Google faz assim com os 750 GB/dia).
    if (!before && this._capCrossed()) session.crossedCap = true
  }

  _expired(session) {
    return Date.now() - session.createdAt > this.options.sessionTtlMs
  }

  async _dropSession(session) {
    session.gone = true
    this.sessions.delete(session.id)
    if (!session.completed) await fsp.unlink(session.path).catch(noop)
  }

  async _uploadInit(req, res, url, rawFileId) {
    const uploadType = url.searchParams.get('uploadType')
    if (uploadType !== 'resumable') {
      return this._reject(req, res, 400, gError(400, 'badRequest', `Unsupported uploadType '${uploadType ?? ''}' (this mock only implements resumable uploads).`, { location: 'uploadType' }))
    }
    let meta
    try {
      meta = await this._jsonBody(req)
    } catch {
      return this._send(res, 400, gError(400, 'parseError', 'Parse Error'))
    }
    const { error: fieldsError } = this._parseMask(url, FILE_FIELDS)
    if (fieldsError) return this._send(res, 400, fieldsError)
    const lengthHeader = req.headers['x-upload-content-length']
    let declared = null
    if (lengthHeader != null) {
      if (!/^\d+$/.test(String(lengthHeader).trim())) {
        return this._send(res, 400, gError(400, 'invalid', 'Invalid X-Upload-Content-Length header.', { location: 'X-Upload-Content-Length', locationType: 'header' }))
      }
      declared = Number(lengthHeader)
    }
    if (declared != null && declared > MAX_FILE_SIZE) {
      return this._send(res, 403, gError(403, 'fileSizeLimitExceeded', 'The file size exceeds the maximum allowed size.'))
    }
    if (meta.modifiedTime != null && !isIsoDate(meta.modifiedTime)) {
      return this._send(res, 400, gError(400, 'invalid', 'Invalid value for: modifiedTime', { location: 'modifiedTime' }))
    }
    if (mergeAppProperties(null, meta.appProperties)?.error) {
      return this._send(res, 400, gError(400, 'invalid', 'Invalid value for: appProperties', { location: 'appProperties' }))
    }
    let parent = null
    let target = null
    if (rawFileId == null) {
      parent = this._metaParent(meta, url, res)
      if (!parent) return
    } else {
      target = this._accessible(rawFileId, url, req)
      if (!target) return this._send(res, 404, notFoundFile(rawFileId))
      if (meta.parents != null) {
        return this._send(res, 403, gError(403, 'fieldNotWritable', 'The resource body includes fields which are not directly writable.'))
      }
      if (!target.content) return this._send(res, 400, gError(400, 'badRequest', 'Only files with binary content can be updated with media.'))
    }
    const driveId = target ? target.driveId : parent.driveId
    const limit = this.options.storageLimitBytes
    if (!driveId && limit != null) {
      const used = this._usage().total - (target?.content?.size ?? 0)
      if (used + (declared ?? 0) > limit || (declared == null && used >= limit)) {
        return this._send(res, 403, gError(403, 'storageQuotaExceeded', "The user's Drive storage quota has been exceeded.", { domain: 'usageLimits' }))
      }
    }
    if (this._capCrossed()) {
      return this._send(res, 403, gError(403, 'userRateLimitExceeded', 'User rate limit exceeded.', { domain: 'usageLimits' }))
    }
    const id = `ABdmock${randomId(64)}`
    const session = {
      id,
      kind: target ? 'update' : 'create',
      fileId: target?.id ?? null,
      parentId: parent?.id ?? null,
      meta,
      mimeType: meta.mimeType || req.headers['x-upload-content-type'] || target?.mimeType || guessMime(String(meta.name ?? '')),
      declaredLength: declared,
      total: declared,
      committed: 0,
      hash: crypto.createHash('md5'),
      path: path.join(this.tmpDir, `${id}.bin`),
      createdAt: Date.now(),
      fields: url.searchParams.get('fields') || null,
      crossedCap: false,
      active: null,
      chain: Promise.resolve(),
      completed: false,
      resultJson: null,
      gone: false,
    }
    await fsp.writeFile(session.path, '')
    this.sessions.set(id, session)
    this._stats.uploadSessionsCreated++
    const location = `${this.url}/upload/drive/v3/files${target ? `/${encodeURIComponent(target.id)}` : ''}?uploadType=resumable&upload_id=${id}`
    this._send(res, 200, null, { location, 'x-guploader-uploadid': id })
  }

  /** Uma requisição por vez por sessão: a nova derruba a anterior (que guarda o que deu) e espera ela fechar. */
  async _withSession(session, fn) {
    session.active?.interrupt()
    const prev = session.chain
    let release
    session.chain = new Promise(resolve => (release = resolve))
    try {
      await prev
      return await fn()
    } finally {
      release()
    }
  }

  async _sessionPut(req, res, url, uploadId) {
    // A URI da sessão é a credencial: Authorization ausente vale, mas inválida dá 401.
    if (req.headers.authorization != null && !this._tokenInfo(req.headers.authorization)) {
      return this._reject(req, res, 401, AUTH_ERROR_BODY, AUTH_ERROR_HEADERS)
    }
    const session = this.sessions.get(uploadId)
    if (!session) return this._reject(req, res, 404, gError(404, 'notFound', 'Upload session not found or expired.'))
    const cr = parseContentRange(req.headers['content-range'])
    if (cr === undefined) return this._reject(req, res, 400, gError(400, 'badRequest', 'Failed to parse Content-Range header.'))
    const cl = req.headers['content-length'] != null ? Number(req.headers['content-length']) : null
    return this._withSession(session, async () => {
      // Expiração conferida dentro da trava: nunca apaga o arquivo debaixo de um PUT em andamento.
      if (!session.gone && this._expired(session)) await this._dropSession(session)
      if (session.gone) return this._reject(req, res, 404, gError(404, 'notFound', 'Upload session not found or expired.'))
      if (cr === null) {
        // Sem Content-Range: o corpo é o arquivo inteiro numa requisição só.
        if (!cl) return this._statusQuery(req, res, session, { total: session.declaredLength ?? 0 })
        return this._dataPut(req, res, session, { start: 0, end: cl - 1, total: cl }, cl)
      }
      if (cr.query) return this._statusQuery(req, res, session, cr)
      return this._dataPut(req, res, session, cr, cl)
    })
  }

  _send308(res, session) {
    const headers = { 'x-guploader-uploadid': session.id }
    if (session.committed > 0) headers.range = `bytes=0-${session.committed - 1}`
    this._send(res, 308, null, headers, 'Resume Incomplete')
  }

  _sendUploadResult(res, session) {
    let body = session.resultJson
    if (session.fields) {
      try {
        body = applyMask(body, parseFieldMask(session.fields))
      } catch {
        // `fields` ruim já teria falhado no Google ao iniciar; aqui devolvemos tudo.
      }
    }
    this._send(res, 200, body)
  }

  async _statusQuery(req, res, session, cr) {
    this._stats.statusQueries++
    await drainRequest(req, DRAIN_LIMIT, n => (this._stats.bytesReceived += n))
    if (session.completed) return this._sendUploadResult(res, session)
    const expected = session.declaredLength ?? session.total
    if (cr.total != null && expected != null && cr.total !== expected) {
      return this._send(res, 400, gError(400, 'badRequest', `Invalid Content-Range: total ${cr.total} doesn't match the declared length ${expected}.`))
    }
    const fault = this._injectFault()
    if (fault) return this._send(res, fault.status, fault.body)
    if (cr.total === 0 && session.committed === 0) {
      // Arquivo vazio: "bytes */0" sem corpo encerra a sessão.
      session.total = 0
      const err = await this._finalize(session)
      if (err) return this._send(res, err.status, err.body)
      return this._sendUploadResult(res, session)
    }
    this._send308(res, session)
  }

  async _dataPut(req, res, session, cr, cl) {
    this._stats.uploadPuts++
    const { start: A, end: B, total: T } = cr
    if (B < A) return this._reject(req, res, 400, gError(400, 'badRequest', 'Failed to parse Content-Range header.'))
    const len = B - A + 1
    if (cl != null && cl !== len) {
      return this._reject(req, res, 400, gError(400, 'badRequest', `Content-Range length (${len}) doesn't match Content-Length (${cl}).`))
    }
    if (session.completed) {
      await drainRequest(req, DRAIN_LIMIT, n => (this._stats.bytesReceived += n))
      return this._sendUploadResult(res, session)
    }
    if (T != null) {
      const expected = session.declaredLength ?? session.total
      if (expected != null && T !== expected) {
        return this._reject(req, res, 400, gError(400, 'badRequest', `Invalid Content-Range: total ${T} doesn't match the declared length ${expected}.`))
      }
      if (B >= T) return this._reject(req, res, 400, gError(400, 'badRequest', 'Invalid Content-Range: the last byte is beyond the total size.'))
    }
    const isFinal = T != null && B + 1 === T
    if (!isFinal && len % UPLOAD_ALIGN !== 0) {
      const msg = `Invalid request.  The number of bytes uploaded is required to be equal or greater than 262144, except for the final request (it's recommended to be the exact multiple of 262144).  The received request contained ${len} bytes, which does not meet this requirement.`
      return this._reject(req, res, 400, gError(400, 'badRequest', msg))
    }
    if (A > session.committed) {
      const msg = `Invalid request.  According to the Content-Range header, the upload offset is ${A} byte(s), which exceeds already uploaded size of ${session.committed} byte(s).`
      return this._reject(req, res, 400, gError(400, 'badRequest', msg))
    }
    if (this._capCrossed() && !session.crossedCap) {
      return this._reject(req, res, 403, gError(403, 'userRateLimitExceeded', 'User rate limit exceeded.', { domain: 'usageLimits' }))
    }
    if (T != null && session.total == null) session.total = T

    const got = await this._receive(req, res, session, A, B)
    if (got.writeError) {
      if (!connectionGone(req, res)) this._send(res, 500, gError(500, 'internalError', 'Internal Error'), { connection: 'close' })
      return
    }
    if (!got.full) {
      // Conexão caiu/travou: só fica o que já estava "assentado" (múltiplo da granularidade).
      this._commit(session, got.snapPos, got.snapHash)
      if (!connectionGone(req, res)) this._send(res, 400, gError(400, 'badRequest', 'Incomplete request body.'), { connection: 'close' })
      return
    }
    const fault = this._injectFault()
    if (fault) {
      // Erro depois de receber tudo: parte pode ter ficado (ou tudo — aí o arquivo existe mesmo com o erro).
      // Quem envia precisa perguntar o status.
      this._commit(session, got.snapPos, got.snapHash)
      if (session.total != null && session.committed === session.total) await this._finalize(session)
      return this._send(res, fault.status, fault.body)
    }
    this._commit(session, B + 1, got.hash)
    if (session.total != null && session.committed === session.total) {
      const err = await this._finalize(session)
      if (err) return this._send(res, err.status, err.body)
      return this._sendUploadResult(res, session)
    }
    this._send308(res, session)
  }

  _commit(session, pos, hash) {
    if (pos <= session.committed || !hash) return
    this._countUploaded(session, pos - session.committed)
    session.committed = pos
    session.hash = hash
  }

  /**
   * Lê o corpo de um PUT de dados e grava a partir de session.committed (pulando a sobreposição).
   * Guarda "fotos" do MD5 em cada múltiplo da granularidade para poder voltar a ele se a conexão cair.
   */
  async _receive(req, res, session, A, B) {
    const c0 = session.committed
    const G = Math.max(1, Math.floor(this.options.uploadRetainGranularity || UPLOAD_ALIGN))
    const len = B - A + 1
    const f = this.options.failures || {}
    let dropAt = null
    let stallAt = null
    if (len > 0 && f.dropUploadProb && this._rand() < f.dropUploadProb) {
      this._stats.faults.uploadDrops++
      dropAt = Math.floor(this._rand() * len)
    } else if (len > 0 && f.stallUploadProb && this._rand() < f.stallUploadProb) {
      this._stats.faults.uploadStalls++
      stallAt = Math.floor(this._rand() * len)
    }
    const hash = session.hash.copy()
    let snapPos = c0
    let snapHash = null
    let pos = A // posição absoluta do próximo byte do corpo
    let received = 0
    let interrupted = false
    let writeError = null
    const pending = []
    let pendingLen = 0
    let writePos = c0
    let fh = null
    const flush = async () => {
      if (!pendingLen || writeError) return
      const bufs = pending.splice(0)
      const total = pendingLen
      pendingLen = 0
      try {
        // writev pode gravar menos que o pedido: completa o resto antes de seguir.
        let { bytesWritten } = await fh.writev(bufs, writePos)
        while (bytesWritten < total) {
          const rest = Buffer.concat(bufs, total).subarray(bytesWritten)
          const r = await fh.write(rest, 0, rest.length, writePos + bytesWritten)
          bytesWritten += r.bytesWritten
        }
        writePos += total
      } catch (err) {
        writeError = err
      }
    }
    const absorb = chunk => {
      let start = pos
      pos += chunk.length
      if (pos <= c0 || start > B) return
      let b = chunk
      if (start < c0) {
        b = b.subarray(c0 - start)
        start = c0
      }
      if (start + b.length > B + 1) b = b.subarray(0, B + 1 - start)
      for (let off = 0; off < b.length;) {
        const abs = start + off
        const boundary = (Math.floor(abs / G) + 1) * G
        const n = Math.min(b.length - off, boundary - abs)
        hash.update(b.subarray(off, off + n))
        off += n
        if (abs + n === boundary) {
          snapPos = boundary
          snapHash = hash.copy()
        }
      }
      pending.push(b)
      pendingLen += b.length
    }
    const pacer = new Pacer(() => this.options.perConnectionBps, this._closing.signal)
    // Registrado antes de qualquer await: uma requisição nova na mesma sessão sempre consegue derrubar esta.
    session.active = {
      interrupt: () => {
        interrupted = true
        req.destroy()
      },
    }
    try {
      fh = await fsp.open(session.path, 'r+')
      for await (let chunk of req) {
        this._stats.bytesReceived += chunk.length
        const limit = dropAt ?? stallAt
        const cut = limit != null && received + chunk.length >= limit
        if (cut) chunk = chunk.subarray(0, limit - received)
        received += chunk.length
        if (chunk.length) absorb(chunk)
        if (pendingLen >= MiB) await flush()
        if (cut) {
          interrupted = true
          if (dropAt != null) req.destroy()
          else await waitClosed(req, res, this._closing.signal) // para de ler e espera o cliente desistir
          break
        }
        await pacer.pace(chunk.length)
        if (this._closed || writeError) {
          interrupted = true
          break
        }
      }
    } catch (err) {
      if (fh) interrupted = true
      else writeError = err
    } finally {
      session.active = null
      if (fh) {
        await flush()
        await fh.close().catch(noop)
      }
    }
    if (writeError) return { writeError }
    // Cortado de propósito ou não: o que não chegou inteiro não conta (snapPos ≤ bytes realmente gravados).
    const full = !interrupted && pos >= B + 1
    return { full, hash, snapPos, snapHash }
  }

  /** Fecha a sessão: cria o arquivo (ou troca o conteúdo, no PATCH) com md5/size do que foi gravado. */
  async _finalize(session) {
    const size = session.total
    await fsp.truncate(session.path, size).catch(noop)
    const content = { kind: 'disk', path: session.path, size, md5: session.hash.digest('hex') }
    const meta = session.meta
    let item
    if (session.kind === 'create') {
      const parent = this.items.get(session.parentId)
      if (!parent) {
        await this._dropSession(session)
        return { status: 404, body: notFoundFile(session.parentId) }
      }
      item = this._insert({
        name: meta.name ?? 'Untitled',
        mimeType: session.mimeType,
        parentId: parent.id,
        content,
        modifiedTime: meta.modifiedTime ? toIso(meta.modifiedTime) : undefined,
        description: meta.description ?? null,
        appProperties: mergeAppProperties(null, meta.appProperties),
      })
    } else {
      item = this.items.get(session.fileId)
      if (!item) {
        await this._dropSession(session)
        return { status: 404, body: notFoundFile(session.fileId) }
      }
      const old = item.content
      item.content = content
      item.headRevisionId = newRevisionId()
      item.modifiedTime = meta.modifiedTime ? toIso(meta.modifiedTime) : isoNow()
      if (meta.name != null) item.name = String(meta.name)
      if (meta.mimeType) item.mimeType = meta.mimeType
      if (meta.description !== undefined) item.description = meta.description
      if (meta.appProperties != null) item.appProperties = mergeAppProperties(item.appProperties, meta.appProperties)
      item.md5Override = undefined
      item.thumbnail = null
      item.version++
      if (old?.kind === 'disk' && old.path !== content.path) fsp.unlink(old.path).catch(noop)
    }
    session.completed = true
    session.fileId = item.id
    session.resultJson = await this._fileJson(item, null)
    return null
  }

  async _sessionDelete(req, res, uploadId) {
    if (req.headers.authorization != null && !this._tokenInfo(req.headers.authorization)) {
      return this._reject(req, res, 401, AUTH_ERROR_BODY, AUTH_ERROR_HEADERS)
    }
    const session = this.sessions.get(uploadId)
    if (!session) return this._reject(req, res, 404, gError(404, 'notFound', 'Upload session not found or expired.'))
    const existed = await this._withSession(session, async () => {
      const alive = !session.gone && !this._expired(session)
      if (!session.gone) await this._dropSession(session)
      return alive
    })
    if (!existed) return this._reject(req, res, 404, gError(404, 'notFound', 'Upload session not found or expired.'))
    await drainRequest(req, DRAIN_LIMIT)
    // 499 é o código que o Google usa para "upload cancelado".
    this._send(res, 499, null, {}, 'Client Closed Request')
  }
}

// Worker de MD5: o mesmo arquivo, carregado numa worker thread, só calcula e devolve.
if (!isMainThread && workerData?.__sobedesceMockMd5) {
  const { s, size } = workerData.__sobedesceMockMd5
  parentPort.postMessage(md5VirtualSync(s, size))
}
