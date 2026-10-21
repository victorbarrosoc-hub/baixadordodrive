// Fila de transferências: agenda, persiste e conta tudo (contrato em docs/ARCHITECTURE.md, "engine/manager.js").
//
// Por que é assim:
//  - Cada registro tem no máximo UMA tarefa viva (this.entries). Pausar/cancelar só pede o abort; o status final
//    é decidido quando a tarefa termina de verdade, então nunca existem duas tarefas escrevendo no mesmo arquivo.
//  - A fila vai para queue.json com gravação atômica agrupada (saveSoon). Duas mudanças gravam NA HORA:
//    uma URI de sessão nova (sem ela, o upload recomeça do zero) e um download que voltou para trás
//    (o temporário vai ser recriado e o registro antigo diria que há bytes que não existem mais).
//  - A interface recebe só o que mudou, no máximo 4×/s, e nunca a URI da sessão (é uma credencial).
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { dataPaths } from '../config.js'
import { JsonFile } from '../util/store.js'
import { SpeedMeter, eta } from '../util/meter.js'
import { BandwidthLimiter } from '../util/limiter.js'
import { isAbortError } from '../util/backoff.js'
import { PART_SUFFIX, toNFC, uniqueName } from '../util/paths.js'
import { classifyError } from '../google/errors.js'
import { DriveClient } from '../google/drive.js'
import { httpRequest, drain } from '../net/http.js'
import { DownloadTask, DOWNLOAD_DEFAULTS } from './download.js'
import { UploadTask } from './upload.js'
import { FolderListings } from './folder-listings.js'
import { KeepAwake } from './power.js'
import { RawThumbnailer } from '../media/raw-thumb.js'
import { GeradorPrevias, PREVIA_PENDENTE } from '../media/previa-fila.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const STATUSES = new Set(['queued', 'running', 'verifying', 'paused', 'waiting', 'completed', 'skipped', 'failed', 'canceled'])
const FINISHED = new Set(['completed', 'skipped', 'canceled'])
const TYPES = ['download', 'upload']

const TRANSFERS_MS = 250 // 'transfers' no máximo 4×/s
const STATS_MS = 500 // 'stats' 2×/s
const HISTORY_MS = 1000 // um ponto por segundo no gráfico
const HISTORY_LEN = 120
const QUEUE_SAVE_MS = 1000
const USAGE_SAVE_MS = 5000
const USAGE_KEEP_MS = 25 * HOUR
const MAX_SEGMENTS = 32
const ACTION_WAIT_MS = 5000 // pausar/cancelar espera a tarefa parar por até isso antes de responder
const SHUTDOWN_WAIT_MS = 8000 // o app precisa sair em até 10 s
const DELETE_TIMEOUT_MS = 10_000
const MAX_TIMER_MS = 2 ** 31 - 1
const MiB = 1024 * 1024
const DAILY_UPLOAD_BYTES = 750 * 1e9 // limite de envio do Google por conta, em 24 h
const FEED_WAKE_MS = 100 // celular mandou mais para um envio em fluxo parado: reagenda no máximo 10×/s
// Downloads pequenos (1 ou 2 conexões cada) andam em mais arquivos ao mesmo tempo, até o orçamento de conexões
// (maxConcurrentDownloads × connectionsPerDownload) e no máximo isso de arquivos.
const MAX_SMALL_DOWNLOADS = 16
const MAX_CONNECTIONS = 32

/** Cota de download do arquivo: esperas crescentes (repetir logo não adianta). */
export const QUOTA_DELAYS = Object.freeze([15 * MINUTE, HOUR, 4 * HOUR, 24 * HOUR])
const QUOTA_FALLBACK_MS = HOUR
// Falhas 'retry' que a própria tarefa anuncia como "vou tentar de novo": a fila tenta mais algumas vezes sozinha.
const AUTO_RETRY = new Set(['remoteChanged', 'tempMissing', 'verifyFailed'])
const MAX_AUTO_RETRIES = 3
// Rede/Google fora do ar depois de todas as tentativas da tarefa: em vez de "Com problema" (a pessoa volta de manhã e
// acha a fila inteira parada por 10 minutos sem Wi-Fi), espera e tenta de novo sozinha, com intervalos crescentes.
// Desiste (failed) só depois de umas 3 horas seguidas sem nenhum avanço.
export const NETWORK_DELAYS = Object.freeze([MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE])
const MAX_NETWORK_WAITS = 16

const noop = () => {}

function pathKey(p) {
  return toNFC(path.resolve(String(p))).toLowerCase()
}

function plural(n, one, many) {
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`
}

function errorInfo(err) {
  const info = classifyError(err)
  let message = info.message || 'Algo deu errado nesta transferência.'
  // Mensagens de "tentando de novo" não valem para uma falha que já é final.
  if (info.kind === 'retry' && /Tentando de novo…|Reconectando…|Retomo assim/.test(message)) {
    message = 'A conexão com o Google falhou várias vezes. Tente de novo daqui a pouco.'
  }
  if (info.kind === 'auth') message = 'O Google recusou o acesso desta conta. Tente de novo; se continuar, conecte a conta de novo.'
  if (info.kind === 'abort') message = 'A transferência foi interrompida. Tente de novo.'
  return { info, error: { message, reason: info.reason ?? null, kind: info.kind, at: Date.now() } }
}

/** Até `max` segmentos para a interface: os vizinhos são somados (o preenchimento continua proporcional). */
function capSegments(list, max = MAX_SEGMENTS) {
  const segs = list
    .filter(s => s && Number.isFinite(s.start) && Number.isFinite(s.end))
    .map(s => ({ start: s.start, end: s.end, pos: Math.max(s.start, Math.min(Number(s.pos) || s.start, s.end + 1)), active: !!s.active, speed: Math.round(s.speed || 0) }))
    .sort((a, b) => a.start - b.start)
  if (segs.length <= max) return segs
  const out = []
  const per = Math.ceil(segs.length / max)
  for (let i = 0; i < segs.length; i += per) {
    const g = segs.slice(i, i + per)
    let done = 0
    let speed = 0
    let active = false
    for (const s of g) {
      done += s.pos - s.start
      speed += s.speed
      active ||= s.active
    }
    out.push({ start: g[0].start, end: g[g.length - 1].end, pos: g[0].start + done, active, speed })
  }
  return out
}

function validRecord(r) {
  return r && typeof r === 'object' && typeof r.id === 'string' && r.id && TYPES.includes(r.type)
}

/**
 * Fila de transferências.
 * Eventos: 'transfers' (PublicTransfer[] alterados, ≤ 4×/s), 'removed' (ids), 'batches' (Batch[]), 'stats' (Stats, 2×/s),
 * 'toast' ({ kind, message }).
 */
export class TransferManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('../config.js').Settings} opts.settings
   * @param {import('../google/oauth.js').AuthManager} [opts.auth]
   * @param {import('./hasher.js').Hasher} [opts.hasher]
   * @param {ReturnType<typeof dataPaths>} [opts.paths]
   * @param {(accountId: string) => object} [opts.driveFactory] DriveClient da conta (um por conta, em cache)
   * Opções finas (testes): keepAwake, createTask(record, ctx), taskOptions { download, upload },
   * quotaDelays (ms, cota de download do arquivo), quotaFallbackMs, quotaMaxMs, networkDelays (ms, rede fora do ar), log,
   * thumbnailer (miniatura de .braw: RawThumbnailer; null desliga), previas (prévia leve dos vídeos: GeradorPrevias;
   * null desliga).
   */
  constructor({ settings, auth = null, hasher = null, paths = dataPaths(), driveFactory, keepAwake, createTask, taskOptions = {}, quotaDelays = QUOTA_DELAYS, quotaFallbackMs = QUOTA_FALLBACK_MS, quotaMaxMs = 24 * HOUR, networkDelays = NETWORK_DELAYS, log, thumbnailer, previas } = {}) {
    super()
    if (!settings?.get) throw new Error('TransferManager: settings é obrigatório')
    this.settings = settings
    this.auth = auth
    this.hasher = hasher
    this.paths = paths
    this.driveFactory = driveFactory || (accountId => new DriveClient(this.auth, accountId))
    this.keepAwake = keepAwake || new KeepAwake()
    this.taskOptions = taskOptions
    this.createTask = createTask || ((record, ctx) => (record.type === 'download' ? new DownloadTask(record, ctx, this.taskOptions.download) : new UploadTask(record, ctx, this.taskOptions.upload)))
    this.quotaDelays = quotaDelays.length ? [...quotaDelays] : [...QUOTA_DELAYS]
    this.quotaFallbackMs = quotaFallbackMs
    this.quotaMaxMs = quotaMaxMs
    this.networkDelays = networkDelays.length ? [...networkDelays] : [...NETWORK_DELAYS]
    this.log = log || ((...args) => {
      if (process.env.SOBEDESCE_DEBUG) console.error('[motor]', ...args)
    })
    // Miniatura de .braw: o frame sai em paralelo ao envio e vai para o Drive depois que ele termina, em segundo
    // plano. Nunca muda o status da transferência; quando grava, marca `thumbnail: true` no registro.
    this.thumbnailer =
      thumbnailer === undefined ? new RawThumbnailer({ settings, log: (...a) => this.log(...a), onResult: (rec, ok) => this.#thumbResult(rec, ok) }) : thumbnailer
    if (this.thumbnailer && !this.thumbnailer.onResult) this.thumbnailer.onResult = (rec, ok) => this.#thumbResult(rec, ok)
    // Prévia leve dos vídeos: depois do envio, uma cópia H.264 720p (a qualidade de reprodução do Drive) em Proxy/ (media/previa-fila.js). Também nunca
    // muda o status da transferência; o andamento fica em `record.previa`.
    this.previas =
      previas === undefined
        ? new GeradorPrevias({ settings, log: (...a) => this.log(...a), onChange: (rec, o) => this.#previaChanged(rec, o) })
        : previas
    if (this.previas && !this.previas.onChange) this.previas.onChange = (rec, o) => this.#previaChanged(rec, o)

    /** @type {Map<string, object>} id -> TransferRecord (ordem de inserção = ordem da fila) */
    this.records = new Map()
    /** @type {Map<string, object>} id -> Batch */
    this.batches = new Map()
    /** @type {Map<string, object>} id -> tarefa viva { record, type, task, ac, after, cleanup, reauthError, promise } */
    this.entries = new Map()
    this.busy = new Map() // id -> { promise, record } limpeza em andamento (fora da fila até terminar)
    this.waitTimers = new Map() // id -> timer da cota
    this.persisted = new Map() // id -> { uri, bytes } da última vez que pediu gravação
    this.drives = new Map()
    this.folderCaches = new Map()
    this.folderListings = new Map() // conta -> FolderListings (nomes já no Drive, por pasta de destino do envio)
    this.feeds = new Map() // id -> arquivo ainda chegando do celular (envio em fluxo, src/mobile/receiver.js)
    this.feedWake = null
    this.dirty = new Set()
    this.removedQueue = []
    this.batchesDirty = false
    this.doneBatches = new Set()
    this.reauthNotified = new Set()
    this.prioritySeq = 0
    this.meters = { download: new SpeedMeter(), upload: new SpeedMeter() }
    const st = settings.get()
    this.limiters = { download: new BandwidthLimiter(st.bandwidthLimitDown), upload: new BandwidthLimiter(st.bandwidthLimitUp) }
    if (this.previas && !this.previas.limiter) this.previas.limiter = this.limiters.upload
    if (this.previas && !this.previas.downloadLimiter) this.previas.downloadLimiter = this.limiters.download
    this.history = []
    this.timers = []
    this.started = false
    this.closing = false
    this.closed = false
    this.ready = null
    this.shutdownP = null

    this.queueFile = new JsonFile(paths.queue, { version: 1, transfers: [], batches: [] })
    this.queueFile.serialize = () => ({ version: 1, transfers: [...this.records.values()], batches: [...this.batches.values()] })
    // Fila de milhares de itens passa de 10 MB: sem recuo, a gravação fica ~25% menor e mais rápida.
    this.queueFile.space = 0
    this.urgentSave = null // gravação "logo" já marcada (várias sessões novas juntas viram uma gravação só)
    this.usageFile = new JsonFile(path.join(paths.root, 'usage.json'), { version: 1, accounts: {} })
    this.usageFile.serialize = data => this.#pruneUsage(data)
    let lastWarn = 0
    const warn = what => err => {
      if (Date.now() - lastWarn < MINUTE) return
      lastWarn = Date.now()
      console.warn(`[motor] não consegui gravar ${what}:`, err?.message)
    }
    this.queueFile.onError = warn('a fila')
    this.usageFile.onError = warn('o uso diário')

    this.onSettingsChange = (next, changed = []) => {
      if (changed.includes('bandwidthLimitDown')) this.limiters.download.setRate(next.bandwidthLimitDown)
      if (changed.includes('bandwidthLimitUp')) this.limiters.upload.setRate(next.bandwidthLimitUp)
      this.#schedule()
    }
    this.onAccounts = list => this.#accountsChanged(Array.isArray(list) ? list : [])
  }

  // ─────────── ciclo de vida ───────────

  /** Carrega queue.json: 'running'/'verifying' viram 'queued' (autoResume) ou 'paused'; 'waiting' mantém o retryAt. */
  init() {
    this.ready ??= (async () => {
      let raw = null
      try {
        raw = await this.queueFile.load()
      } catch (err) {
        console.warn('[motor] não consegui ler a fila:', err?.message)
      }
      const autoResume = !!this.settings.get().autoResume
      let changed = false
      for (const r of Array.isArray(raw?.transfers) ? raw.transfers : []) {
        if (!validRecord(r) || this.records.has(r.id)) continue
        if (!STATUSES.has(r.status)) {
          r.status = 'paused'
          changed = true
        }
        if (r.status === 'running' || r.status === 'verifying') {
          r.status = autoResume ? 'queued' : 'paused'
          changed = true
        }
        if (r.status === 'waiting' && !Number.isFinite(r.retryAt)) {
          r.status = 'queued'
          changed = true
        }
        this.records.set(r.id, r)
        this.persisted.set(r.id, { uri: r.session?.uri ?? null, bytes: r.bytesDone || 0 })
        if (Number(r.priority) > this.prioritySeq) this.prioritySeq = Number(r.priority)
      }
      for (const b of Array.isArray(raw?.batches) ? raw.batches : []) {
        if (b && typeof b.id === 'string' && !this.batches.has(b.id)) this.batches.set(b.id, b)
      }
      // Lote sumido do arquivo (versão antiga): cria um genérico para as linhas não ficarem soltas.
      for (const r of this.records.values()) {
        if (r.batchId && !this.batches.has(r.batchId)) {
          this.batches.set(r.batchId, { id: r.batchId, type: r.type, label: r.type === 'upload' ? 'Envios' : 'Downloads', createdAt: r.createdAt || Date.now(), accountId: r.accountId })
        }
      }
      this.#pruneBatches()
      try {
        await this.usageFile.load()
      } catch {
        this.usageFile.data = { version: 1, accounts: {} }
      }
      if (!this.usageFile.data || typeof this.usageFile.data.accounts !== 'object' || !this.usageFile.data.accounts) this.usageFile.data = { version: 1, accounts: {} }

      this.settings.on?.('change', this.onSettingsChange)
      this.auth?.on?.('accounts', this.onAccounts)
      for (const r of this.records.values()) if (r.status === 'waiting') this.#armWait(r)
      const every = (fn, ms) => {
        const t = setInterval(() => {
          try {
            fn()
          } catch (err) {
            this.log('erro no relógio da fila:', err?.message)
          }
        }, ms)
        t.unref?.()
        this.timers.push(t)
      }
      every(() => this.#flushEvents(), TRANSFERS_MS)
      every(() => {
        if (this.listenerCount('stats')) this.emit('stats', this.stats())
      }, STATS_MS)
      every(() => this.#sampleHistory(), HISTORY_MS)
      this.started = true
      if (changed) this.#saveSoon()
      this.#schedule()
      this.#restorePrevias()
    })()
    return this.ready
  }

  /** Pausa tudo (o status gravado continua 'running' para a próxima abertura retomar), espera as tarefas e grava. */
  shutdown() {
    this.shutdownP ??= (async () => {
      this.closing = true
      clearTimeout(this.feedWake)
      for (const t of this.timers) clearInterval(t)
      this.timers = []
      for (const t of this.waitTimers.values()) clearTimeout(t)
      this.waitTimers.clear()
      const waits = []
      for (const e of this.entries.values()) {
        if (!e.after) e.after = 'shutdown'
        e.ac.abort()
        waits.push(e.promise)
      }
      for (const b of this.busy.values()) waits.push(b.promise)
      await this.#waitFor(waits, SHUTDOWN_WAIT_MS)
      await this.thumbnailer?.close().catch(noop)
      await this.previas?.close().catch(noop)
      this.settings.off?.('change', this.onSettingsChange)
      this.auth?.off?.('accounts', this.onAccounts)
      try {
        this.keepAwake.stop()
      } catch {}
      await this.queueFile.save().catch(err => console.warn('[motor] não consegui gravar a fila:', err?.message))
      await this.usageFile.save().catch(noop)
      this.closed = true
    })()
    return this.shutdownP
  }

  // ─────────── consulta ───────────

  snapshot() {
    return {
      transfers: [...this.records.values()].map(r => this.#public(r)),
      batches: [...this.batches.values()],
      stats: this.stats(),
    }
  }

  /** PublicTransfer de um registro (ou null). */
  get(id) {
    const r = this.records.get(id)
    return r ? this.#public(r) : null
  }

  /** DriveClient da conta (um por conta: o limitador de metadados e os caches são compartilhados). */
  driveFor(accountId) {
    let d = this.drives.get(accountId)
    if (!d) {
      d = this.driveFactory(accountId)
      this.drives.set(accountId, d)
    }
    return d
  }

  // ─────────── recepção do celular em fluxo ───────────

  /**
   * Um envio desta conta começaria agora? Vaga de envio livre, ninguém da fila na frente e a conta fora do limite
   * diário (nenhum envio dela esperando a cota e o uso de 24 h + `size` dentro dos 750 GB). É o que a recepção do
   * celular pergunta antes de subir enquanto o arquivo chega; com "não", recebe tudo e só depois enfileira.
   */
  canStartUpload(accountId, size = 0) {
    if (!this.started || this.closing) return false
    let busy = 0
    for (const e of this.entries.values()) if (e.type === 'upload') busy++
    if (busy >= this.#limit('upload') || this.#pickNext('upload')) return false
    for (const r of this.records.values()) {
      if (r.type === 'upload' && r.accountId === accountId && r.status === 'waiting' && r.error?.reason === 'uploadLimitExceeded') return false
    }
    const used = this.#usageSummary(Date.now())[accountId]?.up24h || 0
    return used + (Number(size) || 0) <= DAILY_UPLOAD_BYTES
  }

  /**
   * Liga ao envio `id` (record.local.growing) o arquivo que ainda está chegando. Sem feed, o envio não começa; com
   * feed, só começa quando há algo novo para mandar (ou o arquivo terminou de chegar).
   */
  attachFeed(id, feed) {
    this.feeds.set(id, feed)
    feed.onAdvance = () => this.#feedAdvanced(id)
    this.#schedule()
  }

  detachFeed(id) {
    const feed = this.feeds.get(id)
    if (feed && feed.onAdvance) feed.onAdvance = null
    this.feeds.delete(id)
  }

  #feedAdvanced(id) {
    const rec = this.records.get(id)
    if (!rec) return
    this.dirty.add(id) // o "chegando do celular" da linha
    if (rec.status !== 'queued' || this.entries.has(id) || this.feedWake) return
    this.feedWake = setTimeout(() => {
      this.feedWake = null
      this.#schedule()
    }, FEED_WAKE_MS)
    this.feedWake.unref?.()
  }

  /** Envio em fluxo parado (celular sem mandar nada novo depois do ponto confirmado) espera fora da vaga. */
  #feedBlocked(r) {
    if (!r.local?.growing) return false
    const feed = this.feeds.get(r.id)
    return !feed || !feed.startable(r.session?.offset ?? 0)
  }

  /** Destinos já reservados por downloads da fila (para o planejador não repetir). */
  reservedPaths() {
    return [...this.#downloadClaims().values()].map(r => r.dest.path)
  }

  /** Destinos em uso: downloads não terminados, tarefas ainda parando e limpezas em andamento (cancelado/removido). */
  #downloadClaims() {
    const claimed = new Map()
    const claim = r => {
      if (r?.type === 'download' && r.dest?.path) claimed.set(pathKey(r.dest.path), r)
    }
    for (const r of this.records.values()) if (!FINISHED.has(r.status)) claim(r)
    for (const e of this.entries.values()) claim(e.record)
    for (const b of this.busy.values()) claim(b.record)
    return claimed
  }

  idsOfBatch(batchId) {
    const out = []
    for (const r of this.records.values()) if (r.batchId === batchId) out.push(r.id)
    return out
  }

  /** Transferências andando ou na fila (as que fechar o app pausa). Mesmo critério do ACTIVE da interface. */
  activeCount() {
    let n = 0
    for (const r of this.records.values()) if (r.status === 'running' || r.status === 'verifying' || r.status === 'queued' || r.status === 'waiting') n++
    return n
  }

  stats() {
    const now = Date.now()
    const dirs = {
      download: { speed: this.meters.download.rate(now), active: 0, queued: 0, remaining: 0 },
      upload: { speed: this.meters.upload.rate(now), active: 0, queued: 0, remaining: 0 },
    }
    let count = 0
    let bytes = 0
    let doneBytes = 0
    // "Restantes" e ETA com a mesma conta: só o que anda sozinho (na fila, andando, conferindo, esperando a rede ou a
    // cota). Pausado e com problema ficam à parte, em `parked`: não andam até alguém mexer.
    let parked = 0
    let parkedCount = 0
    let problems = 0
    for (const r of this.records.values()) {
      const d = dirs[r.type]
      if (!d) continue
      if (r.status === 'running' || r.status === 'verifying') d.active++
      else if (r.status === 'queued') d.queued++
      if (r.status === 'canceled') continue
      count++
      const size = r.size || 0
      bytes += size
      const done = r.status === 'completed' || r.status === 'skipped' ? size : Math.min(size, this.#liveBytes(r))
      doneBytes += done
      if (r.status === 'queued' || r.status === 'running' || r.status === 'verifying' || r.status === 'waiting') d.remaining += Math.max(0, size - done)
      else if (r.status === 'paused' || r.status === 'failed') {
        parked += Math.max(0, size - done)
        parkedCount++
        if (r.status === 'failed' || r.error) problems++
      }
    }
    // ETA geral: a direção que vai demorar mais (cada uma tem a sua velocidade).
    let total = null
    for (const d of Object.values(dirs)) {
      if (d.remaining <= 0) continue
      const e = eta(d.remaining, d.speed)
      if (e != null) total = Math.max(total ?? 0, e)
    }
    const pub = d => ({ speed: d.speed, active: d.active, queued: d.queued })
    return {
      down: pub(dirs.download),
      up: pub(dirs.upload),
      totals: { count, bytes, doneBytes, remaining: dirs.download.remaining + dirs.upload.remaining, parked, parkedCount, problems },
      eta: total,
      history: this.history.slice(),
      keepAwake: !!this.keepAwake.active,
      usage: this.#usageSummary(now),
    }
  }

  // ─────────── mudanças ───────────

  /**
   * Põe registros na fila (grava e agenda). Devolve uma promessa (nunca rejeita) com o que entrou de fato:
   * download repetido (mesmo arquivo para o mesmo destino) ou envio repetido ainda em andamento fica de fora,
   * e dois downloads nunca dividem o mesmo arquivo temporário (o segundo vira "nome (2)").
   * @returns {Promise<{ records: object[], dropped: object[] }>}
   */
  add({ batch, records = [] } = {}) {
    if (this.closing) return Promise.resolve({ records: [], dropped: [...records] })
    const now = Date.now()
    const accepted = []
    const dropped = []
    // Um temporário ainda sendo apagado (cancelado/removido) também conta: o novo download não pode nascer nele.
    const claimed = this.#downloadClaims()
    const uploads = new Set()
    for (const r of this.records.values()) {
      if (r.type === 'upload' && !FINISHED.has(r.status) && r.status !== 'failed') uploads.add(this.#uploadKey(r))
    }
    for (const r of records) {
      if (!validRecord(r) || this.records.has(r.id)) {
        dropped.push(r)
        continue
      }
      if (r.type === 'download' && r.dest?.path) {
        const key = pathKey(r.dest.path)
        const other = claimed.get(key)
        const alive = other && this.records.get(other.id) === other && !FINISHED.has(other.status)
        if (other) {
          if (alive && other.source?.fileId && other.source.fileId === r.source?.fileId) {
            // O mesmo arquivo para o mesmo lugar já está na fila; se tinha falhado, pedir de novo = tentar de novo.
            if (other.status === 'failed' && !this.entries.has(other.id)) {
              other.status = 'queued'
              other.error = null
              other.attempts = 0
              other.finishedAt = null
              if (other.verify?.state === 'mismatch') other.verify = null
              this.#touch(other)
            }
            dropped.push(r)
            continue
          }
          this.#renameDownload(r, claimed)
        }
        claimed.set(pathKey(r.dest.path), r)
      } else if (r.type === 'upload' && r.local?.path) {
        const key = this.#uploadKey(r)
        if (uploads.has(key)) {
          dropped.push(r)
          continue
        }
        uploads.add(key)
      }
      if (!STATUSES.has(r.status) || r.status === 'running' || r.status === 'verifying') r.status = 'queued'
      r.bytesDone ??= 0
      r.attempts ??= 0
      r.error ??= null
      r.retryAt ??= null
      r.verify ??= null
      r.note ??= null
      r.createdAt ??= now
      r.updatedAt = now
      r.batchId ??= batch?.id ?? null
      this.records.set(r.id, r)
      this.persisted.set(r.id, { uri: r.session?.uri ?? null, bytes: r.bytesDone || 0 })
      if (r.status === 'waiting') this.#armWait(r)
      this.dirty.add(r.id)
      accepted.push(r)
    }
    if (accepted.length && batch?.id && !this.batches.has(batch.id)) {
      this.batches.set(batch.id, { ...batch })
      this.batchesDirty = true
    }
    this.#schedule()
    return this.#saveNow().then(() => ({ records: accepted, dropped }))
  }

  /**
   * Proxy (prévia leve) por arquivo. Na fila ou subindo: só muda a escolha (vale quando o envio terminar). Já enviado:
   * ligar = gerar agora (mesmo que o vídeo seja leve: foi pedido); desligar = para a que está na fila/gerando.
   * Devolve quantos registros mudaram (só envios de vídeo contam).
   */
  setProxy(ids, on) {
    let n = 0
    const want = !!on
    for (const r of this.#select(ids)) {
      if (!this.previas?.elegivel(r)) continue
      n++
      r.proxy = want
      if (!want) {
        this.#previaCall(p => p.cancel([r.id]))
      } else if ((r.status === 'completed' || r.status === 'skipped') && r.target?.fileId) {
        const st = r.previa?.estado
        if (st !== 'pronta' && !PREVIA_PENDENTE.includes(st)) this.#previaCall(p => p.enqueue(r, this.driveFor(r.accountId), { forcar: true }))
      }
      this.#touch(r)
    }
    if (n) this.#saveSoon()
    return n
  }

  /** Pausa (ids ou 'all'). Espera as tarefas pararem (até 5 s). */
  async pause(ids) {
    if (ids === 'all') this.#previaCall(p => p.pause())
    const waits = []
    for (const r of this.#select(ids)) {
      const e = this.entries.get(r.id)
      if (e) {
        if (!e.after || e.after === 'queued') {
          e.after = 'paused'
          e.reauthError = null
          e.ac.abort()
        }
        if (e.after === 'paused') {
          r.status = 'paused'
          r.error = null
          waits.push(e.promise)
        }
      } else if (r.status === 'queued' || r.status === 'waiting') {
        this.#clearWait(r.id)
        r.status = 'paused'
        r.retryAt = null
        r.error = null
      } else continue
      this.#touch(r)
    }
    this.#saveSoon()
    await this.#waitFor(waits)
  }

  /** Retoma (ids ou 'all'). 'all' só mexe no que está pausado; ids explícitos também tiram da espera da cota. */
  async resume(ids) {
    const all = ids === 'all'
    if (all) this.#previaCall(p => p.resume())
    for (const r of this.#select(ids)) {
      if (r.status !== 'paused' && (all || r.status !== 'waiting')) continue
      const e = this.entries.get(r.id)
      if (e && e.after === 'paused') e.after = 'queued'
      else if (e) continue
      this.#clearWait(r.id)
      r.status = 'queued'
      r.error = null
      r.retryAt = null
      this.#touch(r)
    }
    this.#saveSoon()
    this.#schedule()
  }

  /** Cancela: download apaga o temporário; upload encerra a sessão no Google (melhor esforço). */
  async cancel(ids) {
    const waits = []
    for (const r of this.#select(ids)) {
      if (FINISHED.has(r.status)) continue
      const e = this.entries.get(r.id)
      this.#clearWait(r.id)
      if (e) {
        if (e.after === 'removed') continue
        e.after = 'canceled'
        e.cleanup = true
        e.ac.abort()
        waits.push(e.promise)
      } else {
        waits.push(this.#cleanupLater(r))
      }
      r.status = 'canceled'
      r.finishedAt = Date.now()
      r.error = null
      r.retryAt = null
      this.#touch(r)
    }
    this.#saveSoon()
    await this.#waitFor(waits)
  }

  /** Tenta de novo o que falhou, foi cancelado, está esperando a cota ou pausado. */
  async retry(ids) {
    for (const r of this.#select(ids)) {
      if (!['failed', 'canceled', 'waiting', 'paused'].includes(r.status)) continue
      const e = this.entries.get(r.id)
      if (e) {
        if (e.after === 'removed') continue
        e.after = 'queued'
      }
      this.#clearWait(r.id)
      r.status = 'queued'
      r.error = null
      r.retryAt = null
      r.attempts = 0
      r.finishedAt = null
      delete r.netWaits
      if (r.verify?.state === 'mismatch') r.verify = null
      this.#touch(r)
    }
    this.#saveSoon()
    this.#schedule()
  }

  /** Tira da lista (abortando se estiver rodando). O que não terminou é limpo como num cancelamento. */
  async remove(ids) {
    const waits = []
    const list = this.#select(ids)
    for (const r of list) {
      const e = this.entries.get(r.id)
      this.#clearWait(r.id)
      if (e) {
        e.after = 'removed'
        e.cleanup = true
        e.ac.abort()
        waits.push(e.promise)
      } else if (!FINISHED.has(r.status)) {
        waits.push(this.#cleanupLater(r))
      }
      this.#forget(r.id)
    }
    if (list.length) {
      this.#pruneBatches()
      this.#saveSoon()
    }
    await this.#waitFor(waits)
  }

  /** Passa na frente: ganha a maior prioridade da fila (o primeiro id fica na frente dos outros). */
  async prioritize(ids) {
    const list = this.#select(ids).filter(r => r.status === 'queued' || r.status === 'paused')
    if (!list.length) return
    const base = Math.max(Date.now(), this.prioritySeq + list.length)
    this.prioritySeq = base
    list.forEach((r, i) => {
      r.priority = base - i
      if (r.status === 'paused') {
        const e = this.entries.get(r.id)
        if (e && e.after !== 'paused') return
        if (e) e.after = 'queued'
        r.status = 'queued'
        r.error = null
      }
      this.#touch(r)
    })
    this.#saveSoon()
    this.#schedule()
  }

  pauseBatch(batchId) {
    return this.pause(this.idsOfBatch(batchId))
  }

  resumeBatch(batchId) {
    return this.resume(this.idsOfBatch(batchId))
  }

  cancelBatch(batchId) {
    return this.cancel(this.idsOfBatch(batchId))
  }

  /** Tira da lista o que terminou (concluído, pulado, cancelado). Os arquivos continuam onde estão. */
  clearFinished() {
    let n = 0
    for (const r of [...this.records.values()]) {
      if (!FINISHED.has(r.status) || this.entries.has(r.id) || this.busy.has(r.id)) continue
      this.#forget(r.id)
      n++
    }
    if (n) {
      this.#pruneBatches()
      this.#saveSoon()
    }
  }

  // ─────────── agendamento ───────────

  #limit(type) {
    const st = this.settings.get()
    const n = type === 'download' ? st.maxConcurrentDownloads : st.maxConcurrentUploads
    return Math.max(1, Math.floor(Number(n) || 1))
  }

  /**
   * a vem antes de b na fila? Prioridade maior ("passar na frente"), depois o lote mais antigo. Dentro do mesmo lote
   * de envio, o MAIOR arquivo primeiro: o gigante não fica sozinho num fluxo só no fim do lote. Empate = ordem do plano.
   */
  #before(a, b) {
    const pa = Number(a.priority) || 0
    const pb = Number(b.priority) || 0
    if (pa !== pb) return pa > pb
    if (a.type === 'upload' && b.type === 'upload' && a.batchId && a.batchId === b.batchId) {
      const sa = Number(a.size) || 0
      const sb = Number(b.size) || 0
      if (sa !== sb) return sa > sb
    }
    return (a.createdAt || 0) < (b.createdAt || 0)
  }

  #pickNext(type) {
    let best = null
    for (const r of this.records.values()) {
      if (r.type !== type || r.status !== 'queued' || this.entries.has(r.id) || this.busy.has(r.id)) continue
      if (type === 'upload' && this.#feedBlocked(r)) continue
      if (!best || this.#before(r, best)) best = r
    }
    return best
  }

  /** Ordem de quem fica quando o limite diminui: conferindo o MD5 primeiro, depois a ordem da fila. */
  #keepOrder(a, b) {
    const va = a.record.status === 'verifying' ? 0 : 1
    const vb = b.record.status === 'verifying' ? 0 : 1
    if (va !== vb) return va - vb
    return this.#before(a.record, b.record) ? -1 : this.#before(b.record, a.record) ? 1 : 0
  }

  /** Limite reduzido: volta para 'queued' na hora (o progresso fica gravado). */
  #requeue(e) {
    e.after = 'queued'
    e.record.status = 'queued'
    e.ac.abort()
    this.#touch(e.record)
  }

  #schedule() {
    if (!this.started || this.closing) return
    this.#scheduleUploads()
    this.#scheduleDownloads()
    this.#updateKeepAwake()
  }

  #scheduleUploads() {
    const limit = this.#limit('upload')
    const live = [...this.entries.values()].filter(e => e.type === 'upload' && !e.after)
    if (live.length > limit) {
      live.sort((a, b) => this.#keepOrder(a, b))
      for (const e of live.slice(limit)) this.#requeue(e)
    }
    let busy = 0
    for (const e of this.entries.values()) if (e.type === 'upload') busy++
    while (busy < limit) {
      const next = this.#pickNext('upload')
      if (!next) break
      this.#start(next)
      busy++
    }
  }

  /**
   * Quantas conexões um download vai usar, pelo tamanho (mesma conta do DownloadTask: segmentos iniciais de
   * `minSegmentSize` e roubo só acima de `stealMinBytes`). `big` = 3 ou mais segmentos: conta no limite de arquivos.
   */
  #downloadCost(rec, st) {
    const conns = Math.min(MAX_CONNECTIONS, Math.max(1, Math.floor(Number(st.connectionsPerDownload) || 1)))
    const minSeg = Math.max(1, Number(st.minSegmentSize) || 64 * MiB)
    const size = Number(rec.size)
    // Doc do Google (exportação) e tamanho desconhecido: como sempre, um arquivo por vaga.
    if (rec.source?.export || rec.size == null || !Number.isFinite(size) || size < 0 || size >= 2 * minSeg) return { big: true, conns }
    const stealMin = Math.max(256 * 1024, Number(this.taskOptions.download?.stealMinBytes) || DOWNLOAD_DEFAULTS.stealMinBytes)
    return { big: false, conns: Math.min(conns, Math.max(1, Math.ceil(size / minSeg), Math.ceil(size / stealMin))) }
  }

  /**
   * Download por orçamento de conexões: arquivos grandes continuam limitados a `maxConcurrentDownloads`; os pequenos
   * (1 ou 2 conexões cada) enchem o resto do orçamento (`maxConcurrentDownloads × connectionsPerDownload`), até 16
   * arquivos. A ordem da fila manda: se o próximo não cabe, ninguém passa na frente dele. O limite de banda é global
   * (o mesmo limitador para todos) e as chamadas de metadados passam pelo limitador da conta.
   */
  #scheduleDownloads() {
    const st = this.settings.get()
    const maxFiles = this.#limit('download')
    const conns = Math.min(MAX_CONNECTIONS, Math.max(1, Math.floor(Number(st.connectionsPerDownload) || 1)))
    const budget = maxFiles * conns
    const fileCap = Math.max(maxFiles, MAX_SMALL_DOWNLOADS)
    const fits = (use, c) => use.files < fileCap && use.conns + c.conns <= budget && (!c.big || use.big < maxFiles)
    const take = (use, c) => {
      use.files++
      use.conns += c.conns
      if (c.big) use.big++
    }

    // Ajuste reduzido: fica quem cabe, na ordem da fila (o primeiro sempre fica).
    const live = [...this.entries.values()].filter(e => e.type === 'download' && !e.after)
    live.sort((a, b) => this.#keepOrder(a, b))
    const kept = { files: 0, conns: 0, big: 0 }
    for (const e of live) {
      const c = this.#downloadCost(e.record, st)
      if (kept.files === 0 || fits(kept, c)) take(kept, c)
      else this.#requeue(e)
    }

    // Vagas: conta também quem ainda está parando (a vaga só abre quando a tarefa solta o arquivo).
    const used = { files: 0, conns: 0, big: 0 }
    for (const e of this.entries.values()) if (e.type === 'download') take(used, this.#downloadCost(e.record, st))
    for (;;) {
      const next = this.#pickNext('download')
      if (!next) break
      const c = this.#downloadCost(next, st)
      if (used.files > 0 && !fits(used, c)) break
      this.#start(next)
      take(used, c)
    }
  }

  #start(rec) {
    const ac = new AbortController()
    const entry = { id: rec.id, record: rec, type: rec.type, task: null, ac, after: null, cleanup: false, reauthError: null, promise: null }
    this.entries.set(rec.id, entry)
    const now = Date.now()
    rec.status = 'running'
    rec.startedAt ??= now
    rec.finishedAt = null
    rec.error = null
    rec.retryAt = null
    this.#touch(rec)
    this.#saveSoon()
    // Ainda chegando do celular: o frame sai do arquivo final, quando o envio terminar.
    if (rec.type === 'upload' && !rec.local?.growing) this.#thumb('prepare', rec)
    entry.promise = (async () => {
      let failure = null
      try {
        entry.task = this.createTask(rec, this.#ctxFor(rec))
        if (ac.signal.aborted) throw Object.assign(new Error('Interrompido.'), { name: 'AbortError' })
        await entry.task.run(ac.signal)
      } catch (err) {
        failure = err ?? new Error('Falha desconhecida.')
      }
      await this.#settle(entry, failure)
    })()
  }

  #ctxFor(rec) {
    const ctx = {
      drive: this.driveFor(rec.accountId),
      settings: this.settings,
      limiter: this.limiters[rec.type],
      hasher: this.hasher,
      persist: () => this.#persistRecord(rec),
      onBytes: n => this.#onBytes(rec, n),
      log: this.log,
    }
    if (rec.type === 'upload') {
      ctx.feed = this.feeds.get(rec.id) || null
      let cache = this.folderCaches.get(rec.accountId)
      if (!cache) this.folderCaches.set(rec.accountId, (cache = new Map()))
      ctx.folderCache = cache
      let listings = this.folderListings.get(rec.accountId)
      if (!listings) this.folderListings.set(rec.accountId, (listings = new FolderListings()))
      ctx.folderListings = listings
      if (this.taskOptions.upload?.retryBaseMs != null) ctx.retryBaseMs = this.taskOptions.upload.retryBaseMs
    }
    return ctx
  }

  /** Decide o status final quando a tarefa termina de verdade. Nunca rejeita. */
  async #settle(entry, err) {
    const rec = entry.record
    try {
      // Limpeza (cancelar/remover) só depois de a tarefa soltar o arquivo; e nunca de algo que terminou bem.
      if (err && entry.cleanup) await this.#cleanup(rec)
      const live = this.records.get(rec.id) === rec
      if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id)
      if (!live) return
      const now = Date.now()
      if (!err) {
        if (rec.status !== 'skipped') rec.status = 'completed'
        if (rec.size != null && rec.status === 'completed') rec.bytesDone = rec.size
        rec.finishedAt = now
        rec.error = null
        rec.retryAt = null
        delete rec.quotaHits
        delete rec.autoRetries
        delete rec.netWaits
        delete rec.netWaitBytes
        if (rec.type === 'upload' && rec.status === 'completed' && rec.target?.fileId) this.#thumb('attach', rec)
        // "Já estava no Drive" também ganha a prévia leve (se ainda não tem): reenviar a pasta gera as que faltam.
        // Referências já chegam leves (até 1080p): nada de Proxy/ dentro da coleção.
        if (rec.type === 'upload' && rec.target?.fileId && !rec.referencia) this.#previa(rec)
      } else if (entry.after === 'shutdown') {
        // Fica como estava: na próxima abertura vira 'queued' (autoResume) ou 'paused'.
        if (!isAbortError(err)) this.#fail(rec, err)
        else if (rec.status !== 'verifying') rec.status = 'running'
      } else if (entry.after) {
        // Pausa/cancelamento pedidos vencem qualquer erro que tenha acontecido junto.
        if (entry.after === 'paused') {
          rec.status = 'paused'
          rec.error = entry.reauthError ?? null
        } else if (entry.after === 'queued') {
          rec.status = 'queued'
        } else if (entry.after === 'canceled') {
          rec.status = 'canceled'
          rec.finishedAt ??= now
        }
      } else {
        this.#fail(rec, err)
      }
      this.#touch(rec)
      this.#saveSoon()
      if (rec.batchId) this.#checkBatch(rec.batchId)
    } catch (e) {
      this.log('erro ao fechar a tarefa', rec?.id, e?.message)
    } finally {
      if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id)
      this.#schedule()
      this.#updateKeepAwake()
    }
  }

  #fail(rec, err) {
    const { info, error } = errorInfo(err)
    if (info.reason === 'waitingPhone') {
      // Celular parado no meio do arquivo: solta a vaga; volta sozinho quando chegar mais (#feedBlocked).
      rec.status = 'queued'
      rec.error = null
      rec.retryAt = null
      return
    }
    if (info.kind === 'quota') return this.#wait(rec, info, error)
    if (info.kind === 'reauth') {
      rec.status = 'paused'
      rec.error = error
      this.#reauthAccount(rec.accountId, error)
      return
    }
    // "Vou tentar de novo" da tarefa (arquivo mudou no Drive, temporário sumiu, MD5 não conferido): volta para a fila.
    if (info.kind === 'retry' && AUTO_RETRY.has(info.reason)) {
      const n = Math.max(0, Number(rec.autoRetries) || 0)
      if (n < MAX_AUTO_RETRIES) {
        this.log('tentando de novo sozinho', rec.id, info.reason)
        rec.autoRetries = n + 1
        rec.status = 'queued'
        rec.error = null
        rec.retryAt = null
        return
      }
      error.message = info.reason === 'remoteChanged' ? 'O arquivo continua mudando no Drive. Tente de novo quando ele parar de ser alterado.' : 'Não deu certo depois de várias tentativas. Tente de novo daqui a pouco.'
    } else if (info.kind === 'retry' && this.#networkWait(rec, error)) {
      return
    }
    this.log('falhou', rec.id, info.kind, info.reason, err?.message)
    rec.status = 'failed'
    rec.error = error
    rec.retryAt = null
  }

  /**
   * Internet/Google fora do ar mesmo depois das tentativas da própria tarefa: espera (1, 2, 5, 10, 15 min…) e volta
   * sozinho. Avançou desde a última espera? A contagem recomeça. false = já esperou demais, vira 'failed'.
   */
  #networkWait(rec, error) {
    const done = Number(rec.bytesDone) || 0
    let n = Math.max(0, Number(rec.netWaits) || 0)
    if (done > (Number(rec.netWaitBytes) || 0)) n = 0
    if (n >= MAX_NETWORK_WAITS) return false
    const delay = this.networkDelays[Math.min(n, this.networkDelays.length - 1)]
    rec.netWaits = n + 1
    rec.netWaitBytes = done
    rec.status = 'waiting'
    rec.retryAt = Date.now() + delay
    rec.error = { ...error, message: 'Sem conexão com o Google por enquanto. Tento de novo sozinho.' }
    this.log('rede fora do ar: espera', rec.id, delay, error.reason)
    this.#armWait(rec)
    return true
  }

  /** Cota do Google: espera e volta sozinho para a fila. */
  #wait(rec, info, error) {
    let delay
    if (info.reason === 'downloadQuotaExceeded') {
      const hits = Math.max(0, Number(rec.quotaHits) || 0)
      delay = this.quotaDelays[Math.min(hits, this.quotaDelays.length - 1)]
      rec.quotaHits = hits + 1
    } else {
      delay = info.retryAfterMs ?? this.quotaFallbackMs
    }
    delay = Math.max(0, Math.min(delay, this.quotaMaxMs))
    rec.status = 'waiting'
    rec.retryAt = Date.now() + delay
    rec.error = error
    this.#armWait(rec)
    // Limite de 750 GB/dia: vale para a conta inteira; os próximos envios dela esperam junto.
    if (rec.type === 'upload' && info.reason === 'uploadLimitExceeded') {
      for (const r of this.records.values()) {
        if (r === rec || r.type !== 'upload' || r.accountId !== rec.accountId || r.status !== 'queued' || this.entries.has(r.id)) continue
        r.status = 'waiting'
        r.retryAt = rec.retryAt
        r.error = { ...error }
        this.#armWait(r)
        this.#touch(r)
      }
    }
  }

  #armWait(rec) {
    this.#clearWait(rec.id)
    const ms = Math.max(0, (Number(rec.retryAt) || 0) - Date.now())
    const timer = setTimeout(() => {
      this.waitTimers.delete(rec.id)
      if (this.closing || this.records.get(rec.id) !== rec || rec.status !== 'waiting') return
      if (Number(rec.retryAt) > Date.now()) return this.#armWait(rec) // espera maior que o teto do setTimeout
      // Volta junto todo mundo que já passou da hora (o limite diário põe a conta inteira com a mesma hora): cada um
      // tem o seu timer e eles disparam em qualquer ordem; liberando todos antes de escolher, a fila segue a ordem.
      const agora = Date.now()
      for (const r of this.records.values()) {
        if (r !== rec && r.status === 'waiting' && r.retryAt != null && Number(r.retryAt) <= agora) {
          this.#clearWait(r.id)
          r.status = 'queued'
          r.retryAt = null
          this.#touch(r)
        }
      }
      rec.status = 'queued'
      rec.retryAt = null
      this.#touch(rec)
      this.#saveSoon()
      this.#schedule()
    }, Math.min(ms, MAX_TIMER_MS))
    timer.unref?.()
    this.waitTimers.set(rec.id, timer)
  }

  #clearWait(id) {
    const t = this.waitTimers.get(id)
    if (t) clearTimeout(t)
    this.waitTimers.delete(id)
  }

  /** Conta precisa reconectar: pausa tudo dela com o aviso (uma vez). */
  #reauthAccount(accountId, error, { toast = true } = {}) {
    for (const r of this.records.values()) {
      if (String(r.accountId) !== String(accountId)) continue
      const e = this.entries.get(r.id)
      if (e) {
        if (e.after) continue
        e.after = 'paused'
        e.reauthError = { ...error }
        e.ac.abort()
      } else if (r.status === 'queued' || r.status === 'waiting') {
        this.#clearWait(r.id)
        r.retryAt = null
      } else continue // pausado à mão continua como o usuário deixou
      r.status = 'paused'
      r.error = { ...error }
      this.#touch(r)
    }
    this.#saveSoon()
    if (!this.reauthNotified.has(accountId)) {
      this.reauthNotified.add(accountId)
      if (toast) this.emit('toast', { kind: 'error', message: error.message })
    }
  }

  #accountsChanged(list) {
    const ok = new Set(list.filter(a => a?.status === 'ok').map(a => String(a.id)))
    const known = new Set(list.map(a => String(a?.id)))
    for (const id of [...this.drives.keys()]) {
      if (!known.has(id)) {
        this.drives.delete(id)
        this.folderCaches.delete(id)
        this.folderListings.delete(id)
      }
    }
    // Conta removida do app: o que é dela para já (e volta sozinho se a mesma conta for conectada de novo).
    const gone = new Set()
    for (const r of this.records.values()) {
      if (!known.has(String(r.accountId)) && ['running', 'verifying', 'queued', 'waiting'].includes(r.status)) gone.add(String(r.accountId))
    }
    for (const id of gone) {
      const message = id.startsWith('nuvem:')
        ? 'Este Drive da conta SOBEDESCE não está mais neste computador. Entre na conta (ou reconecte o Drive no site) para continuar.'
        : 'Esta conta foi removida do SOBEDESCE. Conecte a conta de novo para continuar.'
      const error = { message, reason: 'accountNotFound', kind: 'reauth', at: Date.now() }
      this.#reauthAccount(id, error, { toast: false })
    }
    for (const id of [...this.reauthNotified]) if (ok.has(id)) this.reauthNotified.delete(id)
    let changed = false
    for (const r of this.records.values()) {
      if (r.status !== 'paused' || r.error?.kind !== 'reauth' || !ok.has(String(r.accountId)) || this.entries.has(r.id)) continue
      r.status = 'queued'
      r.error = null
      this.#touch(r)
      changed = true
    }
    if (changed) {
      this.#saveSoon()
      this.#schedule()
    }
  }

  // ─────────── limpeza ───────────

  /** Limpeza de um registro que não está rodando: fica fora da fila até terminar. */
  #cleanupLater(rec) {
    const prev = this.busy.get(rec.id)?.promise
    const slot = { record: rec, promise: null }
    slot.promise = (async () => {
      if (prev) await prev
      await this.#cleanup(rec)
    })()
      .catch(err => this.log('limpeza falhou', rec.id, err?.message))
      .finally(() => {
        if (this.busy.get(rec.id) === slot) this.busy.delete(rec.id)
        this.#schedule()
      })
    this.busy.set(rec.id, slot)
    return slot.promise
  }

  async #cleanup(rec) {
    if (rec.type === 'download') {
      const temp = rec.dest?.tempPath || (rec.dest?.path ? rec.dest.path + PART_SUFFIX : null)
      // Só apaga o nosso temporário (nunca um arquivo do usuário, nem com registro estranho).
      if (temp && String(temp).endsWith(PART_SUFFIX)) await fs.rm(temp, { force: true }).catch(err => this.log('não apaguei o temporário', err?.code))
      rec.segments = null
      rec.bytesDone = 0
      if (rec.verify?.state !== 'ok') rec.verify = null
      if (this.records.get(rec.id) === rec) this.#persistRecord(rec)
    } else if (rec.type === 'upload') {
      const uri = rec.session?.uri
      rec.session = null
      rec.bytesDone = 0
      // Tira a URI do disco já (é credencial), antes de falar com o Google.
      if (this.records.get(rec.id) === rec) this.#persistRecord(rec)
      if (uri) await this.#deleteSession(rec, uri)
    }
  }

  /** DELETE na sessão de upload (o Google responde 499). Melhor esforço: a sessão expira sozinha em 1 semana. */
  async #deleteSession(rec, uri) {
    try {
      let headers = {}
      try {
        headers = await this.driveFor(rec.accountId).authHeader()
      } catch {
        // sem token dá para encerrar assim mesmo (o Google aceita sem Authorization)
      }
      const res = await httpRequest(uri, { method: 'DELETE', headers: { ...headers, 'content-length': '0' }, expect: [200, 204, 404, 410, 499], signal: AbortSignal.timeout(DELETE_TIMEOUT_MS) })
      await drain(res.body)
    } catch (err) {
      this.log('não consegui encerrar a sessão de upload:', err?.status || err?.code || err?.name)
    }
  }

  // ─────────── persistência, eventos, contadores ───────────

  #persistRecord(rec) {
    if (this.closed || this.records.get(rec.id) !== rec) return undefined
    this.dirty.add(rec.id)
    const uri = rec.session?.uri ?? null
    const bytes = Number(rec.bytesDone) || 0
    const prev = this.persisted.get(rec.id) || { uri: null, bytes: 0 }
    this.persisted.set(rec.id, { uri, bytes })
    // URI nova = credencial para retomar; download que voltou para trás = o temporário vai ser recriado.
    // (Sessão que terminou — URI virou null — não tem pressa: na retomada a consulta ao Google resolve.)
    if ((uri && uri !== prev.uri) || (rec.type === 'download' && bytes < prev.bytes)) return this.#saveUrgent()
    this.#saveSoon()
    return undefined
  }

  /**
   * Gravação "logo": em instantes, agrupando os pedidos que chegarem até lá. Antes era uma gravação da fila inteira
   * por pedido — com milhares de arquivos pequenos subindo, isso reescrevia megabytes (com fsync) várias vezes por
   * segundo e travava o motor. A promessa resolve quando o pedido já está no disco.
   */
  #saveUrgent() {
    if (this.closed) return Promise.resolve()
    if (!this.urgentSave) {
      const delay = Math.min(1000, Math.max(50, Math.round(this.records.size / 20)))
      // Sem unref: quem espera esta promessa (ex.: download recriando o temporário) precisa dela resolvida.
      this.urgentSave = new Promise(resolve => {
        setTimeout(() => {
          this.urgentSave = null
          this.#saveNow().then(resolve)
        }, delay)
      })
    }
    return this.urgentSave
  }

  #saveSoon() {
    if (this.closed) return
    // Filas enormes (dezenas de milhares de itens) gravam com menos frequência.
    this.queueFile.saveSoon(Math.max(QUEUE_SAVE_MS, Math.min(10_000, Math.round(this.records.size / 10))))
  }

  /** Grava agora. A promessa nunca rejeita (o erro vai para o log). */
  #saveNow() {
    if (this.closed) return Promise.resolve()
    return this.queueFile.save().catch(err => this.queueFile.onError?.(err))
  }

  #touch(rec) {
    rec.updatedAt = Date.now()
    if (this.records.get(rec.id) === rec) this.dirty.add(rec.id)
  }

  /** Miniatura de RAW: nada daqui pode atrapalhar a fila. */
  #thumb(step, rec) {
    try {
      if (step === 'prepare') this.thumbnailer?.prepare(rec)
      else this.thumbnailer?.attach(rec, this.driveFor(rec.accountId))
    } catch (err) {
      this.log('miniatura:', err?.message)
    }
  }

  #thumbResult(rec, ok) {
    if (!ok || this.records.get(rec.id) !== rec) return
    rec.thumbnail = true
    this.#touch(rec)
    this.#saveSoon()
  }

  /** Prévia leve: nada daqui pode atrapalhar a fila. */
  #previaCall(fn) {
    try {
      if (this.previas) fn(this.previas)
    } catch (err) {
      this.log('prévia leve:', err?.message)
    }
  }

  #previa(rec) {
    this.#previaCall(p => p.enqueue(rec, this.driveFor(rec.accountId)))
  }

  /** Reabriu o app: o que estava na fila da prévia (ou no meio) volta. */
  #restorePrevias() {
    if (!this.previas) return
    for (const r of this.records.values()) {
      if (r.type !== 'upload' || !PREVIA_PENDENTE.includes(r.previa?.estado)) continue
      let ok = false
      this.#previaCall(p => (ok = p.enqueue(r, this.driveFor(r.accountId), { restore: true })))
      // Desligaram a prévia (ou o registro não serve mais): a linha não fica "na fila" para sempre.
      if (!ok) {
        delete r.previa
        this.#saveSoon()
      }
    }
  }

  #previaChanged(rec, { estado = true } = {}) {
    if (this.records.get(rec.id) !== rec) return
    this.#touch(rec)
    // Progresso só vai para a tela; mudança de fase também vai para o disco.
    if (estado) this.#saveSoon()
  }

  #forget(id) {
    this.detachFeed(id)
    if (!this.records.delete(id)) return
    this.persisted.delete(id)
    this.dirty.delete(id)
    this.removedQueue.push(id)
  }

  #pruneBatches() {
    const used = new Set()
    for (const r of this.records.values()) used.add(r.batchId)
    for (const id of [...this.batches.keys()]) {
      if (!used.has(id)) {
        this.batches.delete(id)
        this.doneBatches.delete(id)
        this.batchesDirty = true
      }
    }
  }

  #checkBatch(batchId) {
    let n = 0
    let ok = 0
    let size = 0
    for (const r of this.records.values()) {
      if (r.batchId !== batchId || r.status === 'canceled') continue
      n++
      if (r.status === 'completed' || r.status === 'skipped') {
        ok++
        size += r.size || 0
      }
    }
    const done = n > 0 && ok === n
    if (!done) {
      this.doneBatches.delete(batchId)
      return
    }
    if (this.doneBatches.has(batchId)) return
    this.doneBatches.add(batchId)
    const b = this.batches.get(batchId)
    // Lote "quieto": quem criou avisa do jeito dele (Referências: "Salvo em <Coleção>").
    if (b?.quiet) return
    const label = b?.label || (b?.type === 'upload' ? 'Envio' : 'Download')
    this.emit('toast', { kind: 'success', message: `${label} terminou: ${plural(n, 'arquivo', 'arquivos')}.`, batchId, bytes: size })
  }

  #flushEvents() {
    if (this.batchesDirty) {
      this.batchesDirty = false
      this.emit('batches', [...this.batches.values()])
    }
    if (this.removedQueue.length) this.emit('removed', this.removedQueue.splice(0))
    // O progresso dos que estão rodando muda o tempo todo (bytes ao vivo, velocidade, segmentos).
    for (const e of this.entries.values()) if (this.records.get(e.id) === e.record) this.dirty.add(e.id)
    if (!this.dirty.size) return
    const list = []
    for (const id of this.dirty) {
      const r = this.records.get(id)
      if (r) list.push(this.#public(r))
    }
    this.dirty.clear()
    if (list.length) this.emit('transfers', list)
  }

  #sampleHistory() {
    const now = Date.now()
    this.history.push({ t: now, down: this.meters.download.rate(now), up: this.meters.upload.rate(now) })
    if (this.history.length > HISTORY_LEN) this.history.splice(0, this.history.length - HISTORY_LEN)
    this.#updateKeepAwake()
  }

  #updateKeepAwake() {
    try {
      this.keepAwake.setActive(!this.closing && !!this.settings.get().keepAwake && this.entries.size > 0)
    } catch {
      // nunca derruba a fila
    }
  }

  #onBytes(rec, n) {
    if (!(n > 0)) return
    const now = Date.now()
    this.meters[rec.type]?.add(n, now)
    const acc = (this.usageFile.data.accounts[rec.accountId] ??= {})
    const hour = String(now - (now % HOUR))
    const b = (acc[hour] ??= { up: 0, down: 0 })
    if (rec.type === 'upload') b.up += n
    else b.down += n
    this.usageFile.saveSoon(USAGE_SAVE_MS)
  }

  #pruneUsage(data) {
    const cutoff = Date.now() - USAGE_KEEP_MS
    for (const [acc, buckets] of Object.entries(data.accounts || {})) {
      for (const k of Object.keys(buckets)) if (Number(k) + HOUR < cutoff) delete buckets[k]
      if (!Object.keys(buckets).length) delete data.accounts[acc]
    }
    return data
  }

  #usageSummary(now) {
    const out = {}
    const from = now - 24 * HOUR
    for (const [acc, buckets] of Object.entries(this.usageFile.data?.accounts || {})) {
      let up = 0
      let down = 0
      for (const [k, b] of Object.entries(buckets)) {
        if (Number(k) + HOUR <= from) continue
        up += b.up || 0
        down += b.down || 0
      }
      out[acc] = { up24h: up, down24h: down }
    }
    return out
  }

  #liveBytes(rec) {
    const e = this.entries.get(rec.id)
    if (e?.task && !e.after && typeof e.task.liveBytes === 'function') {
      try {
        return Number(e.task.liveBytes()) || 0
      } catch {}
    }
    return Number(rec.bytesDone) || 0
  }

  /** Registro → PublicTransfer: sem a sessão (credencial), com velocidade, ETA e segmentos ao vivo. */
  #public(rec) {
    const out = {}
    for (const [k, v] of Object.entries(rec)) {
      if (k === 'session' || k === 'segments') continue
      out[k] = v && typeof v === 'object' ? (Array.isArray(v) ? v.slice() : { ...v }) : v
    }
    const e = this.entries.get(rec.id)
    const live = e?.task && !e.after ? e.task : null
    let speed = 0
    if (live) {
      try {
        speed = Math.round(Number(live.speed()) || 0)
      } catch {}
    }
    const bytesDone = this.#liveBytes(rec)
    out.bytesDone = rec.size != null ? Math.min(rec.size, bytesDone) : bytesDone
    out.speed = speed
    out.eta = speed > 0 && rec.size != null ? eta(rec.size - out.bytesDone, speed) : null
    // Chegando do celular e subindo ao mesmo tempo: quanto já chegou (a linha mostra os dois progressos).
    if (rec.type === 'upload' && rec.local?.growing) {
      const feed = this.feeds.get(rec.id)
      if (feed && !feed.complete) out.receive = { bytes: Math.max(0, Math.min(rec.size ?? feed.size, Number(feed.ready) || 0)), size: feed.size }
    }
    if (rec.type === 'download') {
      let segs = null
      if (live && typeof live.liveSegments === 'function') {
        try {
          segs = live.liveSegments()
        } catch {}
      }
      if (!segs) segs = (rec.segments || []).map(s => ({ ...s, active: false, speed: 0 }))
      out.segments = segs.length ? capSegments(segs) : null
      if (rec.status === 'verifying' && live && Number.isFinite(live.verifyBytes)) out.verifyBytes = live.verifyBytes
    }
    return out
  }

  // ─────────── apoio ───────────

  #select(ids) {
    if (ids === 'all') return [...this.records.values()]
    const list = Array.isArray(ids) ? ids : ids != null ? [ids] : []
    const out = []
    const seen = new Set()
    for (const id of list) {
      if (typeof id !== 'string' || seen.has(id)) continue
      seen.add(id)
      const r = this.records.get(id)
      if (r) out.push(r)
    }
    return out
  }

  #uploadKey(r) {
    const t = r.target || {}
    return [r.accountId, pathKey(r.local?.path || ''), t.rootId || 'root', toNFC(t.relDir || '').toLowerCase(), toNFC(r.name || '').toLowerCase()].join('\u0000')
  }

  /** Dois downloads nunca escrevem no mesmo lugar: o novo vira "nome (2).ext" na mesma pasta. */
  #renameDownload(r, claimed) {
    const dir = path.dirname(r.dest.path)
    const dirKey = pathKey(dir)
    const taken = new Set()
    for (const k of claimed.keys()) if (path.dirname(k) === dirKey) taken.add(path.basename(k))
    const from = path.basename(r.dest.path)
    const name = uniqueName(from, taken)
    r.dest.path = path.join(dir, name)
    r.dest.tempPath = r.dest.path + PART_SUFFIX
    r.name = name
    if (typeof r.relPath === 'string' && r.relPath) {
      const i = r.relPath.lastIndexOf('/')
      r.relPath = i < 0 ? name : `${r.relPath.slice(0, i)}/${name}`
    }
    const note = `Outra transferência já vai gravar "${from}": esta vai como "${name}".`
    r.note = r.note ? `${r.note} · ${note}` : note
  }

  async #waitFor(promises, ms = ACTION_WAIT_MS) {
    const list = promises.filter(Boolean)
    if (!list.length) return
    let timer
    await Promise.race([
      Promise.allSettled(list),
      new Promise(resolve => {
        timer = setTimeout(resolve, ms)
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)
  }
}
