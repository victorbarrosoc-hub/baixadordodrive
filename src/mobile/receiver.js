// Recepção pelo Wi-Fi ("Receber do celular"): um SEGUNDO servidor HTTP, aberto na rede local (0.0.0.0:mobilePort),
// que só existe enquanto o ajuste mobileReceive está ligado (liga e desliga na hora).
//
// Por que é assim:
//  - O servidor principal (127.0.0.1) mexe em tudo (contas, disco, fila) e nunca fica visível na rede. Este aqui só
//    entende /m/*: a interface do celular, navegar pastas do Drive e receber arquivos. A API principal não passa
//    por aqui de jeito nenhum.
//  - Toda requisição precisa do código de acesso (32 bytes aleatórios em <dataDir>/mobile.json), em ?t= ou no
//    header x-sobedesce-code. Os arquivos da interface (js/css/ícones) não têm como levar o código na URL, então a
//    página aberta com ?t= grava um cookie (HttpOnly, SameSite=Strict) com o MESMO código, aceito só nesses GETs.
//    Gerar um código novo derruba o antigo na hora, inclusive envios em andamento.
//  - O arquivo chega em pedaços (PUT com Upload-Offset, no espírito do tus): se o Wi-Fi cair ou a página recarregar,
//    o celular pergunta quanto chegou e continua dali. Os bytes vão para um .sobedesce-part numa pasta oculta dentro
//    da pasta de recebidos; completo, ganha um nome seguro e sem colisão e entra na fila de envio pro Drive
//    (planUploads + manager.add), para a pasta escolhida no celular ou a padrão dos Ajustes.
//  - Em fluxo (arquivo de 32 MiB ou mais, destino já decidido e vaga de envio livre agora): o envio pro Drive entra na
//    fila logo no começo do recebimento e sobe o que já foi gravado no .part enquanto o resto chega (ReceiveFeed);
//    tempo total ≈ a perna mais lenta, não a soma. Sem vaga, perto do limite diário ou arquivo pequeno: como antes.
//  - fdatasync a cada SYNC_EVERY gravados e no fim do arquivo (não a cada pedaço: no macOS ele vira F_FULLFSYNC). O
//    ponto que o celular ouve (rec.offset) é o gravado; o que vai para mobile-uploads.json é o sincronizado
//    (rec.synced). Se o computador desligar, o celular continua do ponto sincronizado e manda de novo o resto: nunca
//    fica um buraco de zeros no arquivo. Fechar o app sincroniza tudo antes de gravar a lista.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dataPaths } from '../config.js'
import { JsonFile, readJSON, writeJSONAtomic } from '../util/store.js'
import { newId } from '../util/ids.js'
import { PART_SUFFIX, isJunkFile, safeLocalName, toNFC, uniqueName } from '../util/paths.js'
import { MAX_UPLOAD_SIZE, planUploads } from '../engine/planner.js'
import { formatBytes } from '../engine/download.js'
import { classifyError } from '../google/errors.js'
import { abortError, sleep } from '../util/backoff.js'
import { HttpProblem, baseHeaders, sendJSON, toProblem } from '../server/routes.js'
import { hostInfo, lanAddresses } from './net.js'

// A mesma casca do app do celular publicado em /app/ (web/public/app), servida aqui em /m/.
export const MOBILE_DIR = fileURLToPath(new URL('../../web/public/app/', import.meta.url))
export const PARTS_DIR = '.sobedesce-recebendo' // oculta dentro da pasta de recebidos (mesmo disco: renomear é instantâneo)

const MiB = 1024 * 1024
const CODE_RE = /^[A-Za-z0-9_-]{43}$/ // 32 bytes em base64url
const ID_RE = /^rx[a-z0-9]{8,40}$/
const GOOGLE_ID_RE = /^[\w.-]{1,200}$/
const COOKIE = 'sbd_m'
const JSON_LIMIT = 64 * 1024
const WRITE_GROUP = 1 * MiB // junta os pedacinhos da rede antes de gravar
const IDLE_MS = 60_000 // conexão parada esse tempo (nem um byte) = celular sumiu
const HEADERS_MS = 20_000
const WRITER_WAIT_MS = 5000
const KEEP_MS = 7 * 24 * 3600 * 1000 // recebimentos parados/terminados há uma semana saem da lista
const MAX_RECORDS = 2000
const BATCH_WINDOW_MS = 30 * 60_000 // arquivos do celular em sequência entram no mesmo lote "Do celular"
const FOLDER_CACHE_MS = 60_000
const FREE_MARGIN = 64 * MiB
const DRIVE_ACTIVE = new Set(['queued', 'running', 'verifying', 'paused', 'waiting'])
const SYNC_EVERY = 64 * MiB // fdatasync do .part a cada tanto gravado (e sempre no fim do arquivo)
const STREAM_MIN = 32 * MiB // abaixo disso, recebe tudo e depois sobe (o ganho não paga a sessão aberta antes)
const STREAM_RETRY_MS = 2000 // perguntar de novo se dá para subir em fluxo, no máximo a cada tanto
const STREAM_LOOKUP_MS = 15_000 // consulta da pasta de destino antes do fluxo: sem resposta, segue o caminho de sempre

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
}
// Só a casca do app: nada de dev-server, README, vercel.json, service worker ou manifesto.
const STATIC_TOP = new Set(['index.html', 'app.css', 'app.js', 'lib', 'components', 'vendor', 'icons'])

// Mesma CSP do site publicado, sem o Google (no modo Wi-Fi o celular só fala com este computador).
const LAN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

const EXT_BY_TYPE = {
  'video/quicktime': '.mov',
  'video/mp4': '.mp4',
  'video/x-m4v': '.m4v',
  'image/jpeg': '.jpg',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/x-adobe-dng': '.dng',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/aac': '.aac',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'text/plain': '.txt',
}

const MSG = {
  noCode: 'Falta o código de acesso. Escaneie de novo o QR code em Ajustes → Celular, no computador.',
  badCode: 'Código de acesso inválido. Ele muda quando alguém gera um código novo: escaneie o QR code de novo no computador.',
  tooMany: 'Muitas requisições seguidas. Espere um pouco e tente de novo.',
  tooManyBad: 'Muitas tentativas com código errado. Espere alguns minutos.',
  noAccount: 'Conecte uma conta do Google no SOBEDESCE do computador primeiro.',
  tooBig: 'Arquivo maior que 5 TB: o Google Drive não aceita.',
  overflow: 'Chegou mais do que o tamanho informado do arquivo. Envie de novo.',
  noSpace: (need, free) => `O computador está sem espaço para receber este arquivo (precisa de ${formatBytes(need)}, tem ${formatBytes(free)} livres).`,
}

// ─────────── apoio ───────────

/** Código de acesso: 32 bytes aleatórios em base64url, guardado em <dataDir>/mobile.json (modo 0600). */
class AccessCode {
  constructor(file) {
    this.file = file
    this.value = null
    this.createdAt = null
  }

  async load() {
    const raw = await readJSON(this.file, null).catch(() => null)
    if (typeof raw?.code === 'string' && CODE_RE.test(raw.code)) {
      this.value = raw.code
      this.createdAt = Number(raw.createdAt) || null
    } else {
      await this.rotate()
    }
  }

  async rotate() {
    const code = crypto.randomBytes(32).toString('base64url')
    const createdAt = Date.now()
    await writeJSONAtomic(this.file, { code, createdAt })
    this.value = code
    this.createdAt = createdAt
  }

  /** Comparação em tempo constante (resumos SHA-256 têm o mesmo tamanho, então o tamanho do palpite não vaza). */
  check(given) {
    if (!this.value || typeof given !== 'string' || !given || given.length > 512) return false
    const a = crypto.createHash('sha256').update(given).digest()
    const b = crypto.createHash('sha256').update(this.value).digest()
    return crypto.timingSafeEqual(a, b)
  }
}

/** Balde de fichas por IP (limite simples de requisições). */
class Buckets {
  constructor({ capacity, perSec }) {
    this.capacity = capacity
    this.perSec = perSec
    this.map = new Map()
  }

  #get(ip, now = Date.now()) {
    let b = this.map.get(ip)
    if (!b) {
      b = { tokens: this.capacity, at: now }
      this.map.set(ip, b)
    } else {
      b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.perSec)
      b.at = now
    }
    return b
  }

  take(ip, n = 1) {
    const b = this.#get(ip)
    if (b.tokens < n) return false
    b.tokens -= n
    return true
  }

  empty(ip) {
    if (!this.map.has(ip)) return false
    return this.#get(ip).tokens < 1
  }

  prune() {
    const now = Date.now()
    for (const [ip, b] of this.map) if (b.tokens + ((now - b.at) / 1000) * this.perSec >= this.capacity) this.map.delete(ip)
  }
}

function clientIp(req) {
  const ip = String(req.socket?.remoteAddress || '')
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip
}

function header(req, name) {
  const v = req.headers[name]
  return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : null
}

function cookieValue(req, name) {
  const raw = header(req, 'cookie')
  if (!raw) return null
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

/** Inteiro >= 0 de um header/parâmetro; null se ausente; NaN se inválido. */
function intOf(v) {
  if (v == null || v === '') return null
  const s = String(v).trim()
  if (!/^\d{1,16}$/.test(s)) return NaN
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : NaN
}

function googleId(v) {
  return typeof v === 'string' && GOOGLE_ID_RE.test(v) ? v : null
}

/** Nome para o Drive: o original (NFC), sem caracteres de controle nem '/', no máximo 240 bytes. */
function driveName(name) {
  return safeLocalName(name, 'linux')
}

/** Nome para o disco local: seguro para a plataforma e que não pareça lixo de sistema (o planejador ignoraria). */
function localName(name) {
  let n = safeLocalName(name)
  for (let i = 0; i < 4 && isJunkFile(n); i++) {
    n = n.toLowerCase().endsWith(PART_SUFFIX) ? n.slice(0, -PART_SUFFIX.length) || '_' : `_${n}`
  }
  return n
}

function cleanName(v) {
  if (typeof v !== 'string') return null
  const n = toNFC(v).replace(/[\u0000-\u001f\u007f]/g, '')
  if (!n.trim() || n.length > 1024) return null
  return n
}

function extOf(name) {
  const dot = name.lastIndexOf('.')
  return dot > 0 && name.length - dot <= 8 ? name.slice(dot) : ''
}

/** Nome do arquivo que o Atalho mandou (o "Nome" do iOS vem sem extensão: completa com ?ext= ou o Content-Type). */
function dropName(query, req) {
  let name = cleanName(query.get('name'))
  if (!name) {
    const cd = header(req, 'content-disposition') || ''
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd)
    const plain = /filename\s*=\s*"?([^";]+)"?/.exec(cd)
    try {
      name = cleanName(star ? decodeURIComponent(star[1]) : plain ? plain[1] : null)
    } catch {
      name = null
    }
  }
  if (!name) {
    const d = new Date()
    const p = n => String(n).padStart(2, '0')
    name = `Do celular ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`
  }
  if (!extOf(name)) {
    const ext = String(query.get('ext') || '').replace(/^\.+/, '')
    const type = String(header(req, 'content-type') || '').split(';')[0].trim().toLowerCase()
    if (/^[A-Za-z0-9]{1,8}$/.test(ext)) name += `.${ext.toLowerCase()}`
    else if (EXT_BY_TYPE[type]) name += EXT_BY_TYPE[type]
  }
  return name
}

async function freeSpace(dir) {
  try {
    const st = await fsp.statfs(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return null
  }
}

async function writeAll(fh, buf, pos) {
  let off = 0
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off, pos + off)
    off += bytesWritten
  }
}

/** Move o .part para a pasta de recebidos com um nome livre. link() falha se o nome existe (rename sobrescreveria). */
async function placeFile(src, dir, name) {
  const taken = new Set(await fsp.readdir(dir).catch(() => []))
  for (let i = 0; i < 200; i++) {
    const candidate = uniqueName(name, taken)
    const dest = path.join(dir, candidate)
    try {
      await fsp.link(src, dest)
      await fsp.unlink(src).catch(() => {})
      return dest
    } catch (err) {
      if (err.code === 'EEXIST') {
        taken.add(candidate)
        continue
      }
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK', 'EXDEV', 'EACCES'].includes(err.code)) throw err
      // Disco sem hard link (exFAT, alguns volumes de rede) ou pasta trocada para outro disco.
      if (await fsp.stat(dest).then(() => true, () => false)) {
        taken.add(candidate)
        continue
      }
      if (err.code === 'EXDEV') {
        await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL)
        await fsp.unlink(src).catch(() => {})
      } else {
        await fsp.rename(src, dest)
      }
      return dest
    }
  }
  throw new Error('Não achei um nome livre na pasta de recebidos.')
}

/** fdatasync de um arquivo já gravado (por outro descritor: o fdatasync vale para o arquivo inteiro). */
async function syncFile(file) {
  let fh = null
  try {
    fh = await fsp.open(file, 'r+')
    await fh.datasync()
    return true
  } catch {
    return false
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** Registro como vai para mobile-uploads.json: o ponto é o sincronizado, nunca o só gravado. */
function persisted(r) {
  const { synced, ...rest } = r
  if (r.status === 'receiving' || r.status === 'finishing') rest.offset = Math.min(r.offset, synced ?? r.offset)
  return rest
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = err => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(server.address().port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function diskMessage(err) {
  if (err?.code === 'ENOSPC') return 'O computador ficou sem espaço para receber. Libere espaço lá e tente de novo.'
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return 'O computador não deixou gravar na pasta de recebidos. Confira a pasta em Ajustes → Celular.'
  return `O computador não conseguiu gravar o arquivo (${err?.code || 'erro de disco'}). Tente de novo.`
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function messagePage(title, text) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)} · SOBEDESCE</title></head>
<body style="font:17px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:48px 24px;text-align:center">
<h1 style="font-size:22px;margin:0 0 10px">${escapeHtml(title)}</h1><p style="margin:0 auto;max-width:420px;opacity:.75">${escapeHtml(text)}</p></body></html>`
}

// ─────────── arquivo que ainda está chegando (envio em fluxo) ───────────

/**
 * O que o envio pro Drive (UploadTask, ctx.feed) enxerga de um recebimento em andamento.
 *  path      o .part enquanto chega; o nome final na pasta de recebidos depois de finish()
 *  size      tamanho declarado pelo celular
 *  ready     bytes contíguos desde o início já GRAVADOS no arquivo (write concluído; podem ainda não ter fdatasync).
 *            Ler até aqui lê exatamente o que está no arquivo. Pode voltar (o .part recomeçou): o envio espera.
 *  complete  chegou inteiro, sincronizado e com o nome final; failed: o celular desistiu de vez (ou deu erro ao guardar)
 *  mark      até onde o envio já esperou sem sucesso (ele só volta a abrir um PUT com algo além disso)
 * wait(pos, { signal, idleMs }) resolve quando ready ≥ pos, complete ou failed; rejeita com { feedIdle: true } se ficar
 * idleMs sem nenhuma mudança. open() abre para leitura esperando a troca de nome em andamento.
 */
export class ReceiveFeed {
  constructor({ path: p, size, ready = 0 }) {
    this.path = p
    this.size = size
    this.ready = ready
    this.complete = false
    this.failed = null
    this.mark = 0
    this.moving = null
    this.endMove = null
    this.onAdvance = null
    this.waiters = new Set()
  }

  update(ready) {
    if (this.complete || ready === this.ready) return
    this.ready = ready
    this.#changed()
  }

  /** Começa a trocar o nome: quem for abrir espera até finish()/fail(). */
  beginMove() {
    let done
    this.moving = new Promise(resolve => (done = resolve))
    this.endMove = () => {
      this.moving = null
      this.endMove = null
      done()
    }
  }

  finish(finalPath) {
    this.path = finalPath
    this.ready = this.size
    this.complete = true
    this.endMove?.()
    this.#changed()
  }

  fail(err) {
    if (this.complete || this.failed) return
    this.failed = err instanceof Error ? err : new Error(String(err || 'O arquivo não chegou inteiro do celular.'))
    this.endMove?.()
    this.#changed()
  }

  /** Vale a pena começar um envio que já confirmou `offset` no Google? (há algo novo, terminou ou falhou) */
  startable(offset = 0) {
    return this.complete || !!this.failed || this.ready > Math.max(this.mark, offset)
  }

  wait(pos, { signal, idleMs = 0 } = {}) {
    if (this.complete || this.failed || this.ready >= pos) return Promise.resolve()
    if (signal?.aborted) return Promise.reject(abortError(signal))
    return new Promise((resolve, reject) => {
      let timer = null
      const arm = () => {
        if (!(idleMs > 0)) return
        clearTimeout(timer)
        timer = setTimeout(() => finish(() => reject(Object.assign(new Error('O celular parou de mandar o arquivo.'), { feedIdle: true }))), idleMs)
        timer.unref?.()
      }
      const onAbort = () => finish(() => reject(abortError(signal)))
      const w = { pos, done: () => finish(resolve), progress: arm }
      const finish = fn => {
        clearTimeout(timer)
        this.waiters.delete(w)
        signal?.removeEventListener('abort', onAbort)
        fn()
      }
      this.waiters.add(w)
      signal?.addEventListener('abort', onAbort, { once: true })
      arm()
    })
  }

  async open() {
    for (let i = 0; ; i++) {
      if (this.moving) await this.moving
      try {
        return await fsp.open(this.path, 'r')
      } catch (err) {
        if (err?.code !== 'ENOENT' || i >= 20) throw err
        await sleep(25) // entre o link do nome final e o unlink do .part
      }
    }
  }

  #changed() {
    for (const w of [...this.waiters]) {
      if (this.complete || this.failed || this.ready >= w.pos) w.done()
      else w.progress()
    }
    try {
      this.onAdvance?.()
    } catch {
      // só avisa a fila
    }
  }
}

// ─────────── o receptor ───────────

/**
 * new MobileReceiver({ settings, auth, manager, hasher, paths, port?, host?, mobileDir?, log? })
 *   port: força a porta (testes usam 0); sem isso vale o ajuste mobilePort.
 *   streamMinBytes: menor arquivo que sobe em fluxo (padrão 32 MiB; Infinity desliga o fluxo).
 * init() carrega código e recebimentos e liga/desliga conforme o ajuste (e segue o ajuste ao vivo).
 * status() → estado público (endereços com o código), rotateCode(), close().
 * Eventos: 'status' (ligou, desligou, erro, código novo).
 */
export class MobileReceiver extends EventEmitter {
  constructor({ settings, auth, manager, hasher = null, paths = dataPaths(), port = null, host = '0.0.0.0', mobileDir = MOBILE_DIR, streamMinBytes = STREAM_MIN, log } = {}) {
    super()
    if (!settings?.get) throw new Error('MobileReceiver: settings é obrigatório')
    this.settings = settings
    this.auth = auth
    this.manager = manager
    this.hasher = hasher
    this.paths = paths
    this.portOverride = port
    this.host = host
    this.mobileDir = path.resolve(mobileDir)
    this.log = log || ((...args) => {
      if (process.env.SOBEDESCE_DEBUG) console.error('[celular]', ...args)
    })
    this.access = new AccessCode(paths.mobile || path.join(paths.root, 'mobile.json'))
    this.file = new JsonFile(paths.mobileUploads || path.join(paths.root, 'mobile-uploads.json'), { version: 1, uploads: [] })
    // No disco vai o ponto SINCRONIZADO (rec.synced); o celular ouve o gravado (rec.offset).
    this.file.serialize = () => ({ version: 1, uploads: [...this.records.values()].map(persisted) })
    this.file.onError = err => this.log('não consegui gravar os recebimentos:', err?.message)
    /** @type {Map<string, object>} id -> recebimento */
    this.records = new Map()
    this.byTransfer = new Map() // id da transferência -> id do recebimento
    this.writers = new Map() // id do recebimento -> { req, done }
    this.live = new Map() // id do recebimento -> bytes gravados ao vivo, no meio de um PUT
    this.streamMin = streamMinBytes
    this.feeds = new Map() // id do recebimento -> ReceiveFeed (envio pro Drive em fluxo)
    this.streamSetups = new Map() // id do recebimento -> preparação do envio em fluxo em andamento (inclui a consulta da pasta)
    this.streamCommits = new Map() // id do recebimento -> envio em fluxo entrando na fila agora (o #complete espera)
    this.streamTried = new Map() // id do recebimento -> última vez que perguntou se dava para subir em fluxo
    this.deleting = new Set()
    this.folderCache = new Map()
    this.server = null
    this.port = null
    this.error = null
    this.transition = Promise.resolve()
    this.finishing = Promise.resolve() // dar nome e enfileirar, um por vez (nomes sem colisão)
    this.batch = null
    this.reqLimit = new Buckets({ capacity: 400, perSec: 40 })
    this.failLimit = new Buckets({ capacity: 20, perSec: 1 / 30 })
    this.timer = null
    this.closed = false

    this.onSettings = (next, changed = []) => {
      if (changed.includes('mobileReceive') || changed.includes('mobilePort')) this.#sync()
      else if (changed.includes('mobileStagingDir') && this.server) fsp.mkdir(this.#stagingDir(), { recursive: true }).catch(() => {})
      if (changed.includes('mobileFolderId') || changed.includes('mobileAccountId')) this.folderCache.clear()
    }
    this.onTransfers = list => {
      for (const t of Array.isArray(list) ? list : []) {
        const rec = this.records.get(this.byTransfer.get(t?.id))
        if (rec) this.#updateDrive(rec, t)
      }
    }
    this.onRemoved = ids => {
      for (const id of Array.isArray(ids) ? ids : []) {
        const rec = this.records.get(this.byTransfer.get(id))
        if (rec && (!rec.drive || DRIVE_ACTIVE.has(rec.drive.status))) {
          rec.drive = { ...(rec.drive || {}), status: 'canceled', error: 'Tirado da fila no computador.' }
          this.#saveSoon()
        }
      }
    }
  }

  // ─────────── ciclo de vida ───────────

  async init() {
    await this.access.load()
    await this.#loadRecords()
    this.settings.on?.('change', this.onSettings)
    this.manager?.on?.('transfers', this.onTransfers)
    this.manager?.on?.('removed', this.onRemoved)
    this.timer = setInterval(() => {
      this.reqLimit.prune()
      this.failLimit.prune()
      this.#prune().catch(() => {})
    }, 60_000)
    this.timer.unref?.()
    await this.#sync()
  }

  async close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    this.settings.off?.('change', this.onSettings)
    this.manager?.off?.('transfers', this.onTransfers)
    this.manager?.off?.('removed', this.onRemoved)
    await this.#sync()
    await Promise.allSettled([...this.streamCommits.values()])
    await this.finishing.catch(() => {})
    await this.#syncAll()
    await this.file.flush().catch(() => {})
  }

  get code() {
    return this.access.value
  }

  /** Gera um código novo: o antigo para de valer na hora (envios em andamento caem e precisam do QR novo). */
  async rotateCode() {
    await this.access.rotate()
    for (const w of this.writers.values()) w.req.destroy()
    this.emit('status')
  }

  #wantedPort() {
    return this.portOverride ?? this.settings.get().mobilePort
  }

  #stagingDir() {
    return path.resolve(this.settings.get().mobileStagingDir)
  }

  /** Liga, desliga ou troca de porta (uma transição por vez). */
  #sync() {
    this.transition = this.transition.then(() => this.#apply()).catch(err => this.log('transição falhou:', err?.message))
    return this.transition
  }

  async #apply() {
    const st = this.settings.get()
    const want = !this.closed && st.mobileReceive ? this.#wantedPort() : null
    if (want == null) {
      const was = !!this.server
      await this.#stopServer()
      this.error = null
      if (was) this.emit('status')
      return
    }
    if (this.server && (want === 0 || want === this.port)) return
    await this.#stopServer()
    try {
      await this.#listen(want)
      this.error = null
      this.log(`recebendo do celular na porta ${this.port}`)
      // A pasta já existe desde o início (o botão "Mostrar no Finder" funciona antes do primeiro arquivo).
      await fsp.mkdir(this.#stagingDir(), { recursive: true }).catch(err => this.log('não consegui criar a pasta de recebidos:', err?.message))
    } catch (err) {
      this.error =
        err?.code === 'EADDRINUSE'
          ? `A porta ${want} já está em uso por outro programa. Escolha outra porta para o celular.`
          : err?.code === 'EACCES'
            ? `O sistema não deixou abrir a porta ${want}. Escolha outra porta para o celular.`
            : `Não consegui abrir a recepção do celular (${err?.code || err?.message}).`
      this.log('não consegui escutar:', err?.code || err?.message)
    }
    this.emit('status')
  }

  async #listen(port) {
    const server = http.createServer((req, res) => {
      this.#handle(req, res).catch(err => {
        this.log('erro inesperado:', err?.stack || err)
        if (!res.headersSent) sendJSON(res, 500, { ok: false, error: 'Algo deu errado no computador. Tente de novo.' })
        else res.destroy()
      })
    })
    server.headersTimeout = HEADERS_MS
    server.requestTimeout = 0 // um arquivo inteiro pelo Atalho pode levar muitos minutos; quem corta é o tempo parado
    server.keepAliveTimeout = 10_000
    server.maxHeadersCount = 60
    server.setTimeout(IDLE_MS) // sem nenhum byte nesse tempo, a conexão é derrubada
    server.on('clientError', (err, socket) => socket.destroy())
    const bound = await listen(server, port, this.host)
    this.server = server
    this.port = bound
  }

  async #stopServer() {
    const server = this.server
    if (!server) return
    this.server = null
    this.port = null
    const writers = [...this.writers.values()]
    for (const w of writers) w.req.destroy()
    await new Promise(resolve => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
    let timer
    await Promise.race([Promise.allSettled(writers.map(w => w.done)), new Promise(r => (timer = setTimeout(r, WRITER_WAIT_MS)))])
    clearTimeout(timer)
    await this.#syncAll()
    await this.file.flush().catch(() => {})
  }

  /** Fecha sincronizando: o que já foi gravado vira o ponto guardado (o celular não precisa mandar de novo). */
  async #syncAll() {
    for (const r of this.records.values()) {
      if (r.status !== 'receiving' || this.writers.has(r.id) || !(r.offset > (r.synced ?? 0))) continue
      const at = r.offset
      if (await syncFile(r.partPath)) r.synced = Math.max(r.synced ?? 0, Math.min(at, r.offset))
      else this.log('não consegui sincronizar o recebimento ao fechar:', r.id)
    }
    this.#saveSoon()
  }

  /** Estado para a tela de Ajustes (espera a transição em andamento terminar). */
  async status() {
    await this.transition
    const st = this.settings.get()
    const host = await hostInfo()
    const running = !!this.server
    const port = running ? this.port : this.#wantedPort()
    const ips = lanAddresses()
    const code = this.access.value
    const page = h => `http://${h}:${port}/m/?t=${code}`
    const urls = running ? [host.local && page(host.local), ...ips.map(page)].filter(Boolean) : []
    const dropHost = host.local || ips[0] || null
    const receiving = [...this.records.values()]
      .filter(r => (r.status === 'receiving' || r.status === 'finishing') && Date.now() - r.updatedAt < 5 * 60_000 && (r.offset > 0 || this.live.get(r.id) > 0))
      .map(r => ({ id: r.id, name: r.name, size: r.size, offset: Math.max(r.offset, this.live.get(r.id) || 0) }))
    return {
      enabled: !!st.mobileReceive,
      running,
      port,
      error: this.error,
      macName: host.name,
      urls,
      // O QR leva o IP (funciona em qualquer Wi-Fi); o Atalho guarda o nome .local (sobrevive à troca de IP).
      qrUrl: running ? (ips[0] ? page(ips[0]) : host.local ? page(host.local) : null) : null,
      dropUrl: running && dropHost ? `http://${dropHost}:${port}/m/api/drop?t=${code}&name=` : null,
      dropUrlIp: running && ips[0] ? `http://${ips[0]}:${port}/m/api/drop?t=${code}&name=` : null,
      stagingDir: this.#stagingDir(),
      receiving,
    }
  }

  // ─────────── recebimentos guardados ───────────

  async #loadRecords() {
    let raw = null
    try {
      raw = await this.file.load()
    } catch (err) {
      this.log('não consegui ler os recebimentos:', err?.message)
    }
    for (const r of Array.isArray(raw?.uploads) ? raw.uploads : []) {
      if (!r || typeof r.id !== 'string' || !ID_RE.test(r.id) || this.records.has(r.id)) continue
      if (!Number.isSafeInteger(r.offset) || (r.size != null && !Number.isSafeInteger(r.size))) continue
      r.synced = r.offset // no disco só vai o ponto sincronizado
      this.records.set(r.id, r)
      if (r.transferId) this.byTransfer.set(r.transferId, r.id)
    }
    for (const r of this.records.values()) {
      if (r.status === 'finishing') r.status = 'receiving' // o app fechou no meio de dar o nome: refaz
      if (r.status === 'receiving') {
        // Vale o menor entre o que foi confirmado (gravado depois de sincronizar) e o que existe no disco.
        const st = await fsp.stat(r.partPath).catch(() => null)
        r.offset = st ? Math.min(r.offset, st.size) : 0
        r.synced = r.offset
        if (r.via === 'drop' || r.size == null) {
          // Envio do Atalho não tem como continuar: o iPhone manda tudo de novo.
          await this.#forget(r)
          continue
        }
        this.#reattachFeed(r)
        if (r.offset === r.size && st) this.#complete(r)
      } else if (r.stream) {
        this.#reattachFeed(r)
      }
    }
    // Envio em fluxo sem recebimento por trás (a lista do celular sumiu): não tem de onde vir o resto.
    const orphans = (this.manager?.snapshot?.().transfers || []).filter(t => t.type === 'upload' && t.local?.growing && !this.byTransfer.has(t.id)).map(t => t.id)
    if (orphans.length) await this.manager.remove(orphans).catch(() => {})
    // Recebido mas sem ter entrado na fila (o app fechou no meio): enfileira agora.
    for (const r of this.records.values()) {
      if (r.status === 'received' && !r.transferId && !r.drive) this.#queueLater(r)
      else if (r.transferId) {
        const t = this.manager?.get?.(r.transferId)
        if (t) this.#updateDrive(r, t)
      }
    }
    await this.#prune()
    this.#saveSoon()
  }

  #saveSoon() {
    this.file.saveSoon(500)
  }

  /** Reabriu o app com um envio em fluxo na fila: liga de novo o arquivo (chegando, inteiro ou perdido). */
  #reattachFeed(r) {
    if (!r.stream || !r.transferId || !this.manager?.attachFeed) return
    const t = this.manager.get?.(r.transferId)
    if (!t?.local?.growing) return
    const feed = new ReceiveFeed({ path: r.partPath, size: r.size, ready: r.offset })
    if (r.status === 'received' && r.finalPath) feed.finish(r.finalPath)
    else if (r.status !== 'receiving') feed.fail(new Error(r.error || 'O arquivo não chegou inteiro do celular.'))
    if (r.status === 'receiving') this.feeds.set(r.id, feed)
    this.manager.attachFeed(r.transferId, feed)
  }

  async #forget(rec) {
    this.records.delete(rec.id)
    if (rec.transferId) this.byTransfer.delete(rec.transferId)
    const receiving = rec.status === 'receiving' || rec.status === 'finishing' || rec.status === 'failed'
    const feed = this.feeds.get(rec.id)
    this.feeds.delete(rec.id)
    this.streamTried.delete(rec.id)
    if (receiving && rec.stream && rec.transferId) {
      // O celular desistiu de vez: o envio em fluxo sai da fila e a sessão no Google é encerrada (antes de apagar o .part).
      feed?.fail(new Error('O celular cancelou o envio.'))
      await this.manager?.remove?.([rec.transferId]).catch(err => this.log('não consegui tirar o envio da fila:', err?.message))
    }
    if (receiving) {
      if (rec.partPath) await fsp.rm(rec.partPath, { force: true }).catch(() => {})
    }
    this.#saveSoon()
  }

  async #prune() {
    const now = Date.now()
    const finished = []
    for (const r of [...this.records.values()]) {
      if (this.writers.has(r.id)) continue
      const old = now - (r.updatedAt || r.createdAt || 0) > KEEP_MS
      const active = r.status === 'receiving' || r.status === 'finishing' || (r.drive && DRIVE_ACTIVE.has(r.drive.status))
      if (old && (r.status === 'receiving' || !active)) await this.#forget(r)
      else if (!active) finished.push(r)
    }
    for (const r of finished.slice(0, Math.max(0, this.records.size - MAX_RECORDS))) await this.#forget(r)
  }

  // ─────────── HTTP ───────────

  async #handle(req, res) {
    const ip = clientIp(req)
    if (!this.reqLimit.take(ip)) return this.#fail(res, 429, MSG.tooMany)
    if (this.failLimit.empty(ip)) return this.#fail(res, 429, MSG.tooManyBad)
    let url
    try {
      url = new URL(req.url, 'http://celular')
    } catch {
      return this.#fail(res, 400, 'Endereço inválido.')
    }
    const p = url.pathname
    if (p !== '/m' && !p.startsWith('/m/')) return this.#notFound(res)
    const isApi = p.startsWith('/m/api/')
    const isGet = req.method === 'GET' || req.method === 'HEAD'
    const fromCookie = !isApi && isGet ? cookieValue(req, COOKIE) : null
    const given = url.searchParams.get('t') || header(req, 'x-sobedesce-code') || fromCookie
    const page = !isApi && isGet && (p === '/m' || p === '/m/' || p === '/m/index.html')
    if (!given) return page ? this.#html(res, 401, 'Falta o código', MSG.noCode) : this.#fail(res, 401, MSG.noCode)
    if (!this.access.check(given)) {
      this.failLimit.take(ip)
      return page ? this.#html(res, 401, 'Código inválido', MSG.badCode) : this.#fail(res, 401, MSG.badCode)
    }
    if (p === '/m') {
      res.writeHead(302, baseHeaders({ location: `/m/${url.search}`, 'cache-control': 'no-store', 'content-length': 0 }))
      return res.end()
    }
    if (isApi) return this.#api(req, res, url)
    return this.#static(req, res, url, { setCookie: page && given !== fromCookie })
  }

  #fail(res, status, error, extra = {}) {
    sendJSON(res, status, { ok: false, error, ...extra })
  }

  #html(res, status, title, text) {
    const body = Buffer.from(messagePage(title, text), 'utf8')
    res.writeHead(status, baseHeaders({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'content-length': body.length }))
    res.end(body)
  }

  #notFound(res) {
    res.writeHead(404, baseHeaders({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }))
    res.end('Não encontrado.')
  }

  // ─────────── interface do celular ───────────

  async #static(req, res, url, { setCookie }) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.#fail(res, 405, 'Método não permitido.')
    let rel
    try {
      rel = decodeURIComponent(url.pathname.slice('/m/'.length))
    } catch {
      return this.#notFound(res)
    }
    if (rel === '') rel = 'index.html'
    if (rel === 'lan-config.js') return this.#lanConfig(req, res)
    if (rel.includes('\0') || rel.includes('\\')) return this.#notFound(res)
    rel = path.posix.normalize(rel)
    const segs = rel.split('/')
    if (!STATIC_TOP.has(segs[0]) || segs.some(s => !s || s.startsWith('.'))) return this.#notFound(res)
    const file = path.join(this.mobileDir, ...segs)
    if (!file.startsWith(this.mobileDir + path.sep)) return this.#notFound(res)
    const type = TYPES[path.extname(file).toLowerCase()]
    if (!type) return this.#notFound(res)
    let data
    try {
      const st = await fsp.stat(file)
      if (!st.isFile()) return this.#notFound(res)
      data = await fsp.readFile(file)
    } catch {
      return this.#notFound(res)
    }
    const index = rel === 'index.html'
    if (index) data = Buffer.from(lanIndex(data.toString('utf8')), 'utf8')
    const headers = baseHeaders({ 'content-type': type, 'cache-control': index ? 'no-store' : 'no-cache', 'referrer-policy': 'no-referrer', 'content-length': data.length })
    if (type.startsWith('text/html')) headers['content-security-policy'] = LAN_CSP
    // O cookie leva o mesmo código para os arquivos da interface (que não têm como mandar ?t=).
    if (index && setCookie) headers['set-cookie'] = `${COOKIE}=${this.access.value}; Path=/m/; HttpOnly; SameSite=Strict; Max-Age=2592000`
    res.writeHead(200, headers)
    res.end(req.method === 'HEAD' ? undefined : data)
  }

  async #lanConfig(req, res) {
    const host = await hostInfo()
    const cfg = { mode: 'lan', code: this.access.value, mac: host.name, platform: process.platform, maxSize: MAX_UPLOAD_SIZE }
    const body = Buffer.from(`window.__SOBEDESCE_LAN__ = Object.freeze(${JSON.stringify(cfg)});\n`, 'utf8')
    res.writeHead(200, baseHeaders({ 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'content-length': body.length }))
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  // ─────────── API do celular ───────────

  async #api(req, res, url) {
    const segs = url.pathname.split('/').filter(Boolean).slice(2) // depois de /m/api
    const m = req.method
    const ac = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) ac.abort()
    })
    try {
      if (segs.length === 1 && segs[0] === 'info' && m === 'GET') return sendJSON(res, 200, { ok: true, ...(await this.#info(ac.signal)) })
      if (segs.length === 1 && segs[0] === 'folders' && m === 'GET') return sendJSON(res, 200, { ok: true, ...(await this.#folders(url.searchParams, ac.signal)) })
      if (segs.length === 1 && segs[0] === 'uploads' && m === 'POST') return sendJSON(res, 200, { ok: true, ...(await this.#create(await readJson(req))) })
      if (segs.length === 1 && segs[0] === 'drop' && m === 'POST') return await this.#drop(req, res, url)
      if (segs.length === 2 && segs[0] === 'uploads') {
        const rec = ID_RE.test(segs[1]) ? this.records.get(segs[1]) : null
        if (!rec) throw new HttpProblem(404, 'Esse envio não existe mais no computador. Escolha o arquivo de novo.')
        if (m === 'GET') return sendJSON(res, 200, { ok: true, ...this.#view(rec) })
        if (m === 'PUT') return await this.#put(req, res, rec)
        if (m === 'DELETE') return sendJSON(res, 200, { ok: true, ...(await this.#discard(rec)) })
        throw new HttpProblem(405, 'Método não permitido.')
      }
      throw new HttpProblem(404, 'Rota não encontrada.')
    } catch (err) {
      if (res.headersSent || res.destroyed) return void res.destroy()
      const p = toProblem(err)
      if (p?.status === 499) return void res.destroy()
      if (!p) this.log(`erro em ${m} ${url.pathname}:`, err?.stack || err)
      this.#fail(res, p?.status || 500, p?.message || 'Algo deu errado no computador. Tente de novo.')
    }
  }

  #account(id) {
    const list = this.auth?.listAccounts?.() || []
    if (id) return list.find(a => a.id === id) || null
    const want = this.settings.get().mobileAccountId
    return list.find(a => a.id === want) || list[0] || null
  }

  async #info(signal) {
    const acc = this.#account()
    const host = await hostInfo()
    const st = this.settings.get()
    return {
      mac: { name: host.name },
      account: acc ? { email: acc.email, name: acc.name || null } : null,
      folder: await this.#defaultFolder(acc, signal),
      maxSize: MAX_UPLOAD_SIZE,
      deleteAfterUpload: !!st.mobileDeleteAfterUpload,
    }
  }

  /** Pasta padrão (Ajustes → Celular) com o caminho de verdade, para o celular conseguir navegar a partir dela. */
  async #defaultFolder(acc, signal) {
    const st = this.settings.get()
    const id = googleId(st.mobileFolderId) || 'root'
    const label = String(st.mobileFolderName || '').split(' / ').filter(Boolean).pop()
    const fallback = { id, name: label || (id === 'root' ? 'Meu Drive' : 'Pasta do Drive'), driveId: null }
    fallback.path = [{ id, name: fallback.name }]
    if (!acc || !this.manager) return fallback
    const key = `${acc.id}:${id}`
    const hit = this.folderCache.get(key)
    if (hit && Date.now() - hit.at < FOLDER_CACHE_MS) return hit.folder
    try {
      const drive = this.manager.driveFor(acc.id)
      const [item, crumbs] = await Promise.all([id === 'root' ? null : drive.getItem(id, { signal }), drive.getPath(id, { signal })])
      const path = crumbs.length ? crumbs.map(c => ({ id: c.id, name: c.name })) : fallback.path
      const folder = { id, name: path[path.length - 1].name, driveId: item?.driveId || null, path }
      this.folderCache.set(key, { at: Date.now(), folder })
      return folder
    } catch (err) {
      if (signal?.aborted) throw err
      return fallback // sem internet no computador agora: o nome guardado já serve
    }
  }

  async #folders(query, signal) {
    const acc = this.#account()
    if (!acc) throw new HttpProblem(409, MSG.noAccount)
    const drive = this.manager.driveFor(acc.id)
    if (query.get('drives') === '1') return { drives: await drive.listSharedDrives({ signal }) }
    const folderId = googleId(query.get('folderId')) || 'root'
    const items = await drive.listChildren(folderId, { signal })
    return { folders: items.filter(it => it.isFolder).map(it => ({ id: it.id, name: it.name, driveId: it.driveId || null })) }
  }

  #driveView(rec) {
    const t = rec.transferId ? this.manager?.get?.(rec.transferId) : null
    if (t) return { status: t.status, bytesDone: t.bytesDone || 0, size: t.size ?? rec.size, speed: t.speed || 0, error: t.error?.message || null, fileId: t.target?.fileId || null }
    return rec.drive || null
  }

  #view(rec) {
    const status = rec.status === 'finishing' ? 'received' : rec.status
    return {
      id: rec.id,
      name: rec.name,
      size: rec.size,
      offset: rec.offset,
      status,
      error: rec.error || null,
      drive: status === 'received' ? this.#driveView(rec) : null,
      localDeleted: !!rec.localDeleted,
    }
  }

  /** POST /m/api/uploads: começa (ou retoma) um recebimento. */
  async #create(body) {
    const name = cleanName(body.name)
    if (!name) throw new HttpProblem(400, 'Nome de arquivo inválido.')
    const size = body.size
    if (!Number.isSafeInteger(size) || size < 0) throw new HttpProblem(400, 'Tamanho de arquivo inválido.')
    if (size > MAX_UPLOAD_SIZE) throw new HttpProblem(413, MSG.tooBig)
    const acc = this.#account()
    if (!acc) throw new HttpProblem(409, MSG.noAccount)
    const st = this.settings.get()
    const folderId = googleId(body.folderId) || googleId(st.mobileFolderId) || 'root'
    const key = [acc.id, folderId, name, size].join('\u0000')

    // Mesmo nome + tamanho + destino: continua o que já estava chegando, ou acompanha o que já está subindo.
    let found = null
    for (const r of this.records.values()) {
      if (r.key !== key) continue
      if (r.status === 'receiving' || r.status === 'finishing') found = r
      else if (r.status === 'received' && !found && (!r.drive || DRIVE_ACTIVE.has(r.drive.status) || r.drive.status === 'failed')) found = r
    }
    if (found) {
      if (found.status === 'receiving') {
        await this.#ensurePart(found)
        found.updatedAt = Date.now()
        if (Number.isFinite(body.lastModified)) found.lastModified = body.lastModified
        this.#maybeStream(found, { now: true })
      } else if (found.status === 'received') {
        const t = found.transferId ? this.manager?.get?.(found.transferId) : null
        if (t?.status === 'failed') await this.manager.retry([found.transferId])
        else if (!t && (!found.drive || found.drive.status === 'failed')) await this.#requeue(found)
      }
      this.#saveSoon()
      return this.#view(found)
    }

    const dir = this.#stagingDir()
    const partsDir = path.join(dir, PARTS_DIR)
    try {
      await fsp.mkdir(partsDir, { recursive: true })
    } catch (err) {
      throw new HttpProblem(500, `Não consegui criar a pasta de recebidos (${err.code || err.message}). Confira em Ajustes → Celular, no computador.`)
    }
    const free = await freeSpace(partsDir)
    if (free != null && size + FREE_MARGIN > free) throw new HttpProblem(507, MSG.noSpace(size, free))
    const now = Date.now()
    const rec = {
      id: newId('rx'),
      key,
      via: 'app',
      name,
      size,
      lastModified: Number.isFinite(body.lastModified) ? body.lastModified : null,
      accountId: acc.id,
      folderId,
      folderName: typeof body.folderName === 'string' ? body.folderName.slice(0, 1024) : null,
      driveId: googleId(body.driveId),
      offset: 0,
      synced: 0,
      status: 'receiving',
      partPath: null,
      finalPath: null,
      transferId: null,
      drive: null,
      error: null,
      localDeleted: false,
      createdAt: now,
      updatedAt: now,
    }
    rec.partPath = path.join(partsDir, `${rec.id}${PART_SUFFIX}`)
    await fsp.writeFile(rec.partPath, '', { flag: 'wx', mode: 0o600 })
    this.records.set(rec.id, rec)
    if (size === 0) await this.#complete(rec)
    else this.#maybeStream(rec, { now: true })
    this.#saveSoon()
    return this.#view(rec)
  }

  /** O .part sumiu (alguém limpou a pasta)? Recomeça do zero, sem fingir que os bytes estão lá. */
  async #ensurePart(rec) {
    const st = await fsp.stat(rec.partPath).catch(() => null)
    if (st && st.size >= rec.offset) return
    rec.offset = st ? Math.min(rec.offset, st.size) : 0
    rec.synced = Math.min(rec.synced ?? 0, rec.offset)
    if (!st) {
      await fsp.mkdir(path.dirname(rec.partPath), { recursive: true })
      await fsp.writeFile(rec.partPath, '', { mode: 0o600 })
    }
    this.feeds.get(rec.id)?.update(rec.offset)
  }

  /** Derruba o envio anterior do mesmo arquivo (conexão que o Wi-Fi matou sem avisar) e espera ele gravar o que tinha. */
  async #takeOver(rec) {
    for (let i = 0; i < 10 && this.writers.has(rec.id); i++) {
      const w = this.writers.get(rec.id)
      w.req.destroy()
      await w.done.catch(() => {})
    }
  }

  /** PUT /m/api/uploads/:id — um pedaço, gravado na posição Upload-Offset do .part. */
  async #put(req, res, rec) {
    const want = intOf(header(req, 'upload-offset'))
    if (want == null || Number.isNaN(want)) throw new HttpProblem(400, 'Falta o cabeçalho Upload-Offset.')
    const declared = intOf(header(req, 'content-length'))
    if (Number.isNaN(declared)) throw new HttpProblem(400, 'Content-Length inválido.')
    await this.#takeOver(rec)
    if (rec.status !== 'receiving') return this.#fail(res, 409, 'Este arquivo já chegou inteiro no computador.', { offset: rec.size, status: this.#view(rec).status })
    await this.#ensurePart(rec)
    if (this.writers.has(rec.id)) return this.#fail(res, 409, 'Outro envio deste arquivo começou agora.', { offset: rec.offset })
    if (want !== rec.offset) return this.#fail(res, 409, 'O ponto de continuação mudou.', { offset: rec.offset })
    const remaining = rec.size - rec.offset
    if (declared != null && declared > remaining) return this.#reject(res, req, 413, MSG.overflow, { offset: rec.offset })

    this.#maybeStream(rec) // uma vaga de envio pode ter aberto desde o começo do recebimento
    const out = await this.#receive(rec, req, remaining)
    if (out.overflow) return this.#reject(res, req, 413, MSG.overflow, { offset: rec.offset })
    if (out.diskError) {
      this.log('não consegui gravar o pedaço:', out.diskError.code || out.diskError.message)
      return this.#reject(res, req, 507, diskMessage(out.diskError), { offset: rec.offset })
    }
    if (out.error) return void res.destroy() // o celular já desistiu desta conexão; ele pergunta o ponto e continua
    if (rec.offset === rec.size) await this.#complete(rec)
    sendJSON(res, 200, { ok: true, ...this.#view(rec) })
  }

  /** Recusa sem ler o resto do corpo: responde e fecha a conexão. */
  #reject(res, req, status, error, extra) {
    if (res.headersSent || res.destroyed) return void req.destroy()
    res.setHeader('connection', 'close')
    res.on('finish', () => req.destroy())
    this.#fail(res, status, error, extra)
  }

  /**
   * Grava o corpo a partir de rec.offset, no máximo `limit` bytes. O que já foi gravado vale mesmo se a conexão cair
   * no meio: rec.offset (o que o celular ouve) avança no fim da requisição, com tudo que foi gravado. O que vai para
   * mobile-uploads.json é rec.synced, que só avança DEPOIS do fdatasync (a cada SYNC_EVERY e no fim do arquivo, em
   * #complete): se o computador desligar, o registro nunca diz que tem no disco um byte que não está lá (o arquivo
   * subiria com um buraco de zeros, e a conferência de MD5 com o Drive não pegaria: os dois lados teriam o mesmo
   * buraco). O envio em fluxo (feed) lê só até o ponto gravado, que é exatamente o que está no arquivo.
   * @returns {Promise<{ overflow: boolean, error: Error|null }>}
   */
  #receive(rec, req, limit) {
    const writer = { req, done: null }
    this.writers.set(rec.id, writer)
    writer.done = (async () => {
      let fh = null
      let pos = rec.offset
      let received = 0
      let parts = []
      let buffered = 0
      let overflow = false
      let error = null
      let diskError = null // falha ao GRAVAR (disco cheio, sem permissão): o celular precisa saber, não é queda de Wi-Fi
      let synced = null // até onde o fdatasync desta requisição já garantiu
      const flush = async () => {
        if (!buffered) return
        const data = parts.length === 1 ? parts[0] : Buffer.concat(parts, buffered)
        parts = []
        buffered = 0
        try {
          await writeAll(fh, data, pos)
        } catch (err) {
          diskError ??= err
          throw err
        }
        pos += data.length
        this.live.set(rec.id, pos)
        rec.updatedAt = Date.now()
        this.feeds.get(rec.id)?.update(pos)
        if (pos - Math.max(rec.synced ?? 0, synced ?? 0) >= SYNC_EVERY) {
          try {
            await fh.datasync()
            // O ponto guardado só avança no fim da requisição (junto com rec.offset); aqui fica anotado.
            synced = pos
          } catch (err) {
            this.log('não consegui sincronizar o recebimento:', err?.code || err?.message)
          }
        }
      }
      try {
        try {
          fh = await fsp.open(rec.partPath, 'r+')
        } catch (err) {
          diskError = err
          throw err
        }
        // destroyOnReturn: false — ao recusar no meio, a resposta ainda precisa sair pela mesma conexão.
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          if (received + chunk.length > limit) {
            overflow = true
            break
          }
          received += chunk.length
          parts.push(chunk)
          buffered += chunk.length
          if (buffered >= WRITE_GROUP) await flush()
        }
        if (!overflow) await flush()
      } catch (err) {
        error = err
        // O que chegou antes da queda são bytes bons, na ordem certa: grava também.
        if (fh) await flush().catch(() => {})
      } finally {
        if (fh) {
          await fh.close().catch(() => {})
          // Gravado (write concluído) é ponto bom para o celular continuar; no disco, só o sincronizado.
          if (pos > rec.offset) rec.offset = pos
          if (synced != null && synced > (rec.synced ?? 0)) rec.synced = synced
        }
        this.live.delete(rec.id)
        if (this.writers.get(rec.id) === writer) this.writers.delete(rec.id)
        this.#saveSoon()
      }
      return { overflow, error, diskError }
    })()
    return writer.done
  }

  /**
   * Chegou tudo: fdatasync (o fim do arquivo sempre sincroniza), nome seguro sem colisão na pasta de recebidos e fila
   * de envio pro Drive. Em fluxo o envio já está na fila: só passa a usar o arquivo final.
   */
  async #complete(rec) {
    if (rec.status !== 'receiving') return
    rec.status = 'finishing'
    rec.updatedAt = Date.now()
    const job = this.finishing.then(async () => {
      // Envio em fluxo entrando na fila agora: espera, para nunca enfileirar duas vezes. (Quem ainda está consultando
      // a pasta desiste sozinho: confere rec.status, que já não é 'receiving'.)
      await this.streamCommits.get(rec.id)
      if ((rec.synced ?? 0) < rec.size && !(await syncFile(rec.partPath))) {
        // Sem fdatasync o arquivo não é dado como recebido: o celular manda de novo a partir do ponto sincronizado.
        rec.status = 'receiving'
        rec.offset = Math.min(rec.offset, rec.synced ?? 0)
        this.feeds.get(rec.id)?.update(rec.offset)
        this.log('não consegui sincronizar o fim do arquivo recebido:', rec.id)
        return
      }
      rec.synced = rec.size
      const feed = this.feeds.get(rec.id)
      try {
        const dir = this.#stagingDir()
        await fsp.mkdir(dir, { recursive: true })
        await fsp.truncate(rec.partPath, rec.size)
        feed?.beginMove()
        rec.finalPath = await placeFile(rec.partPath, dir, localName(rec.name))
        rec.status = 'received'
        rec.receivedAt = Date.now()
        rec.updatedAt = rec.receivedAt
        this.log('recebido:', path.basename(rec.finalPath))
      } catch (err) {
        rec.status = 'failed'
        rec.error = `Chegou inteiro, mas não consegui guardar no computador (${err.code || err.message}).`
        this.log('não consegui guardar:', err?.message)
        feed?.fail(new Error(rec.error))
        this.feeds.delete(rec.id)
        return
      }
      if (feed) {
        feed.finish(rec.finalPath)
        this.feeds.delete(rec.id)
        return
      }
      // Em fluxo, mas o envio saiu da fila no meio (cancelado/tirado no computador): não sobe sozinho de novo.
      if (rec.stream && rec.transferId) return
      await this.#requeue(rec)
    })
    this.finishing = job.catch(() => {})
    await job
    this.#saveSoon()
  }

  #queueLater(rec) {
    this.finishing = this.finishing.then(() => this.#requeue(rec)).catch(() => {})
  }

  /**
   * Sobe em fluxo, se der: arquivo grande do app (com tamanho e nome), destino decidido e um envio desta conta
   * começaria agora (vaga livre, fora do limite diário). Senão fica como sempre: recebe tudo e depois enfileira.
   * Não espera (a resposta ao celular não atrasa); #complete espera a decisão antes de enfileirar.
   */
  #maybeStream(rec, { now = false } = {}) {
    if (this.closed || !this.manager?.attachFeed || !this.manager.canStartUpload) return
    if (rec.via !== 'app' || rec.status !== 'receiving' || rec.transferId || rec.size == null || !(rec.size >= this.streamMin)) return
    if (this.streamSetups.has(rec.id)) return
    const at = Date.now()
    if (!now && at - (this.streamTried.get(rec.id) || 0) < STREAM_RETRY_MS) return
    this.streamTried.set(rec.id, at)
    const p = this.#startStream(rec)
      .catch(err => this.log('não consegui subir em fluxo:', err?.message))
      .finally(() => this.streamSetups.delete(rec.id))
    this.streamSetups.set(rec.id, p)
  }

  async #startStream(rec) {
    const acc = this.#account(rec.accountId)
    if (!acc || !this.manager.canStartUpload(acc.id, rec.size) || this.#sameNameBusy(rec)) return
    let driveId = rec.driveId || null
    if (!driveId && rec.folderId !== 'root') {
      // Sem saber se a pasta é de um drive compartilhado, o destino não está decidido: fica para depois.
      driveId = (await this.manager.driveFor(acc.id).getItem(rec.folderId, { signal: AbortSignal.timeout(STREAM_LOOKUP_MS) })).driveId || null
      rec.driveId = driveId
    }
    // A decisão vale para AGORA: depois da consulta, confere tudo de novo (daqui até entrar na fila não há espera).
    if (this.closed || this.records.get(rec.id) !== rec || rec.status !== 'receiving' || rec.transferId) return
    if (!this.manager.canStartUpload(acc.id, rec.size) || this.#sameNameBusy(rec)) return
    const commit = this.#commitStream(rec, acc, driveId)
    this.streamCommits.set(rec.id, commit)
    try {
      await commit
    } finally {
      this.streamCommits.delete(rec.id)
    }
  }

  async #commitStream(rec, acc, driveId) {
    const now = Date.now()
    const name = driveName(rec.name)
    const folderId = rec.folderId || 'root'
    const batchId = this.#batchId(acc.id)
    const t = {
      id: newId('t'),
      type: 'upload',
      accountId: acc.id,
      batchId,
      status: 'queued',
      name,
      relPath: name,
      size: rec.size,
      bytesDone: 0,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
      error: null,
      retryAt: null,
      attempts: 0,
      verify: null,
      note: 'Veio do celular',
      // growing: ainda chegando (o envio lê pelo feed); stream: veio em fluxo (MD5 sempre conferido no fim).
      local: { path: rec.partPath, size: rec.size, mtimeMs: null, growing: true, stream: true },
      target: { rootId: folderId === 'root' && driveId ? driveId : folderId, relDir: '', parentId: null, driveId, replaceFileId: null, fileId: null },
      session: null,
    }
    const feed = new ReceiveFeed({ path: rec.partPath, size: rec.size, ready: Math.max(rec.offset, this.live.get(rec.id) || 0) })
    this.feeds.set(rec.id, feed)
    rec.transferId = t.id
    rec.stream = true
    rec.drive = { status: 'queued', bytesDone: 0, size: rec.size, error: null, fileId: null }
    this.byTransfer.set(t.id, rec.id)
    this.manager.attachFeed(t.id, feed)
    const added = await this.manager.add({ batch: { id: batchId, type: 'upload', label: 'Do celular', createdAt: now, accountId: acc.id }, records: [t] })
    if (!added.records[0]) {
      this.manager.detachFeed(t.id)
      this.feeds.delete(rec.id)
      this.byTransfer.delete(t.id)
      rec.transferId = null
      rec.stream = false
      rec.drive = null
      return
    }
    this.log('subindo em fluxo enquanto chega:', name)
    this.#saveSoon()
  }

  /** Outro arquivo com o mesmo nome indo para a mesma pasta agora: em fluxo os dois criariam nomes repetidos no Drive. */
  #sameNameBusy(rec) {
    const name = toNFC(driveName(rec.name)).toLowerCase()
    for (const r of this.records.values()) {
      if (r === rec || r.accountId !== rec.accountId || (r.folderId || 'root') !== (rec.folderId || 'root')) continue
      if (toNFC(driveName(r.name)).toLowerCase() !== name) continue
      if (r.status === 'receiving' || r.status === 'finishing') return true
      const t = r.transferId ? this.manager?.get?.(r.transferId) : null
      if (t && DRIVE_ACTIVE.has(t.status)) return true
    }
    return false
  }

  /** Lote "Do celular": arquivos que chegam em sequência ficam juntos na tela de Transferências. */
  #batchId(accountId) {
    const b = this.batch
    const now = Date.now()
    if (b && b.accountId === accountId && now - b.at < BATCH_WINDOW_MS && this.manager?.batches?.has?.(b.id)) {
      b.at = now
      return b.id
    }
    this.batch = { id: newId('b'), accountId, at: now }
    return this.batch.id
  }

  /** Põe (ou põe de novo) o arquivo recebido na fila de envio pro Drive. Erros ficam em rec.drive para o celular ver. */
  async #requeue(rec) {
    if (this.closed || !this.manager) return
    try {
      const acc = this.#account(rec.accountId)
      if (!acc) throw new HttpProblem(409, 'A conta do Google deste envio não está mais conectada no computador.')
      const drive = this.manager.driveFor(acc.id)
      let driveId = rec.driveId || null
      if (!driveId && rec.folderId !== 'root') {
        try {
          driveId = (await drive.getItem(rec.folderId)).driveId || null
          rec.driveId = driveId
        } catch (err) {
          if (classifyError(err).kind === 'notfound') throw new HttpProblem(404, 'A pasta de destino não existe mais no Drive (ou a conta perdeu o acesso).')
          // Sem internet agora: segue sem o driveId (a tarefa de envio acha a pasta mesmo assim).
        }
      }
      const plan = await planUploads({ drive, accountId: acc.id, paths: [rec.finalPath], destFolderId: rec.folderId || 'root', driveId, batchId: this.#batchId(acc.id) })
      const r = plan.records[0]
      if (!r) throw new Error(plan.skipped?.[0]?.reason || 'Não consegui pôr o arquivo na fila de envio.')
      const name = driveName(rec.name)
      r.name = name
      r.relPath = name
      r.note = 'Veio do celular'
      plan.batch.label = 'Do celular'
      const added = await this.manager.add({ batch: plan.batch, records: [r] })
      const got = added.records[0]
      if (!got) throw new Error('Esse arquivo já está na fila de envio.')
      if (rec.transferId) this.byTransfer.delete(rec.transferId)
      rec.transferId = got.id
      rec.drive = { status: got.status, bytesDone: 0, size: rec.size, error: null, fileId: null }
      this.byTransfer.set(got.id, rec.id)
    } catch (err) {
      const p = toProblem(err)
      const message = p?.message || err?.message || 'Não consegui pôr o arquivo na fila de envio.'
      rec.drive = { status: 'failed', bytesDone: 0, size: rec.size, error: message, fileId: null }
      this.log('não consegui enfileirar:', message)
    } finally {
      rec.updatedAt = Date.now()
      this.#saveSoon()
    }
  }

  #updateDrive(rec, t) {
    const prev = rec.drive?.status
    rec.drive = { status: t.status, bytesDone: t.bytesDone || 0, size: t.size ?? rec.size, error: t.error?.message || null, fileId: t.target?.fileId || null }
    if (prev !== t.status) {
      rec.updatedAt = Date.now()
      this.#saveSoon()
    }
    if (t.status === 'completed' || t.status === 'skipped') this.#maybeDelete(rec, t)
  }

  /** Apaga a cópia do computador só depois de o Drive confirmar o MESMO conteúdo (MD5 conferido). */
  async #maybeDelete(rec, t) {
    if (!this.settings.get().mobileDeleteAfterUpload || rec.localDeleted || !rec.finalPath || this.deleting.has(rec.id)) return
    this.deleting.add(rec.id)
    try {
      let ok = t.verify?.state === 'ok' && (!t.verify.expected || !t.verify.actual || t.verify.expected === t.verify.actual)
      if (!ok && t.status === 'completed' && t.target?.fileId && this.hasher) {
        // Conferência desligada nos Ajustes: confere aqui mesmo antes de apagar.
        const drive = this.manager.driveFor(t.accountId || rec.accountId)
        const [local, item] = await Promise.all([this.hasher.hash(rec.finalPath), drive.getItem(t.target.fileId)])
        ok = Boolean(item.md5) && item.md5 === local && item.size === rec.size
      }
      if (!ok) return void this.log('mantive no computador (sem conferência de MD5):', rec.finalPath)
      await fsp.unlink(rec.finalPath)
      rec.localDeleted = true
      this.log('apagado do computador depois de subir:', path.basename(rec.finalPath))
    } catch (err) {
      if (err?.code === 'ENOENT') rec.localDeleted = true
      else this.log('não consegui apagar depois de subir:', err?.message)
    } finally {
      this.deleting.delete(rec.id)
      this.#saveSoon()
    }
  }

  /** DELETE /m/api/uploads/:id — o celular desistiu: apaga o pedaço recebido. Depois de chegar inteiro, não mexe. */
  async #discard(rec) {
    if (rec.status !== 'receiving') return { removed: false }
    await this.#takeOver(rec)
    if (rec.status !== 'receiving') return { removed: false }
    await this.#forget(rec)
    return { removed: true }
  }

  /** POST /m/api/drop?name=&folderId= — o arquivo inteiro no corpo (Atalho do iPhone). Responde em texto. */
  async #drop(req, res, url) {
    const wantsJson = /application\/json/i.test(header(req, 'accept') || '')
    const reply = (status, text, extra = {}) => {
      if (wantsJson) return sendJSON(res, status, { ok: status < 300, ...(status < 300 ? { message: text } : { error: text }), ...extra })
      const body = Buffer.from(text, 'utf8')
      res.writeHead(status, baseHeaders({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': body.length }))
      res.end(body)
    }
    const declared = intOf(header(req, 'content-length'))
    if (Number.isNaN(declared)) return reply(400, 'Content-Length inválido.')
    if (/^multipart\//i.test(header(req, 'content-type') || '')) {
      // Corpo "Formulário" do Atalho embrulha o arquivo: gravar isso estragaria o arquivo.
      res.setHeader('connection', 'close')
      res.on('finish', () => req.destroy())
      return reply(400, 'No Atalho, em Corpo da Requisição, escolha Arquivo (não Formulário).')
    }
    if (declared != null && declared > MAX_UPLOAD_SIZE) {
      res.setHeader('connection', 'close')
      res.on('finish', () => req.destroy())
      return reply(413, MSG.tooBig)
    }
    const acc = this.#account()
    if (!acc) return reply(409, MSG.noAccount)
    const name = dropName(url.searchParams, req)
    const st = this.settings.get()
    const folderId = googleId(url.searchParams.get('folderId')) || googleId(st.mobileFolderId) || 'root'
    const partsDir = path.join(this.#stagingDir(), PARTS_DIR)
    await fsp.mkdir(partsDir, { recursive: true })
    if (declared != null) {
      const free = await freeSpace(partsDir)
      if (free != null && declared + FREE_MARGIN > free) {
        res.setHeader('connection', 'close')
        res.on('finish', () => req.destroy())
        return reply(507, MSG.noSpace(declared, free))
      }
    }
    const now = Date.now()
    const rec = {
      id: newId('rx'),
      key: null,
      via: 'drop',
      name,
      size: declared, // null = corpo sem tamanho (chunked): vira o que chegar
      lastModified: null,
      accountId: acc.id,
      folderId,
      folderName: null,
      driveId: null,
      offset: 0,
      status: 'receiving',
      partPath: null,
      finalPath: null,
      transferId: null,
      drive: null,
      error: null,
      localDeleted: false,
      createdAt: now,
      updatedAt: now,
    }
    rec.partPath = path.join(partsDir, `${rec.id}${PART_SUFFIX}`)
    await fsp.writeFile(rec.partPath, '', { flag: 'wx', mode: 0o600 })
    this.records.set(rec.id, rec)
    const out = await this.#receive(rec, req, declared ?? MAX_UPLOAD_SIZE)
    if (out.overflow) {
      await this.#forget(rec)
      return this.#reject(res, req, 413, MSG.tooBig)
    }
    if (out.diskError) {
      await this.#forget(rec)
      res.setHeader('connection', 'close')
      res.on('finish', () => req.destroy())
      return reply(507, diskMessage(out.diskError))
    }
    if (out.error || (declared != null && rec.offset !== declared)) {
      // O Atalho não continua de onde parou: descarta o pedaço.
      await this.#forget(rec)
      if (!res.headersSent && !res.destroyed) return reply(400, 'O envio foi interrompido. Tente de novo.')
      return
    }
    rec.size = rec.offset
    await this.#complete(rec)
    if (rec.status !== 'received') {
      const text = rec.error || 'Chegou, mas não consegui guardar no computador.'
      if (rec.status === 'receiving') await this.#forget(rec) // não sincronizou: o Atalho manda de novo
      return reply(500, text)
    }
    const queued = rec.drive?.status !== 'failed'
    const text = queued ? `Recebido no computador: ${name} (${formatBytes(rec.size)}). Subindo pro Drive.` : `Recebido no computador: ${name}, mas não entrou na fila do Drive: ${rec.drive.error}`
    reply(200, text, { id: rec.id, name, size: rec.size })
  }
}

/** POST com JSON pequeno (o corpo do envio de verdade vai nos PUTs). */
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (Number(header(req, 'content-length')) > JSON_LIMIT) {
      req.resume()
      return reject(new HttpProblem(413, 'Pedido grande demais.'))
    }
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > JSON_LIMIT) {
        req.destroy()
        return reject(new HttpProblem(413, 'Pedido grande demais.'))
      }
      chunks.push(c)
    })
    req.on('error', reject)
    req.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('objeto')
        resolve(data)
      } catch {
        reject(new HttpProblem(400, 'JSON inválido.'))
      }
    })
  })
}

/** index.html do site com a configuração do modo Wi-Fi: sem manifesto, sem Referer e com lan-config.js antes do app. */
export function lanIndex(html) {
  let out = html.replace(/\s*<link rel="manifest"[^>]*>/i, '').replace(/<meta name="referrer"[^>]*>/i, '<meta name="referrer" content="no-referrer" />')
  const tag = '<script src="lan-config.js"></script>'
  out = /<script type="module"/i.test(out) ? out.replace(/<script type="module"/i, `${tag}\n    <script type="module"`) : out.replace(/<\/head>/i, `  ${tag}\n  </head>`)
  return out
}
