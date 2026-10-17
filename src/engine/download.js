// Download segmentado e retomável de UM arquivo do Drive (contrato em docs/ARCHITECTURE.md, "engine/download.js").
//
// Por que é assim:
//  - Várias conexões HTTP/1.1 com Range enchem o link (uma conexão só raramente enche). O arquivo é dividido em
//    BLOCOS EM ORDEM (minSegmentSize, 64 MiB por padrão): cada conexão pega o próximo bloco livre. Só quando não
//    sobra bloco livre (o fim do arquivo) quem termina "rouba" a metade do maior que falta, então todas trabalham
//    até o último byte.
//  - Cada byte vai direto para a posição certa de um arquivo temporário esparso já do tamanho final.
//    Nada é gravado sem conferir o Content-Range: byte no lugar errado é o pior defeito possível.
//  - MD5 junto com a gravação: como os blocos vão em ordem, existe uma "frente contínua" (tudo antes dela já foi
//    gravado e não é mais reescrito nesta rodada). Um worker (Hasher.stream) lê do DISCO o que fica atrás dessa
//    frente, logo depois da gravação (ainda no cache do sistema), e alimenta o MD5. No fim só falta o último trecho.
//    O MD5 cobre os bytes que estão no arquivo, não os que vieram da rede. Retomada depois de fechar o app: o estado
//    do MD5 não é guardado; o worker relê o prefixo já baixado em segundo plano enquanto o resto baixa.
//  - O registro só guarda posições que já passaram por fdatasync, a cada 10 s ou a cada 1 GiB gravado (o que vier
//    primeiro). Uma queda de energia pode perder ~10 s de progresso (baixa de novo esse trecho), mas o registro
//    nunca diz que tem no disco um byte que não está lá: o temporário nunca fica errado.
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { httpRequest, HttpError } from '../net/http.js'
import { classifyError, SobeDesceError, stalledError } from '../google/errors.js'
import { resourceKeyHeader } from '../google/drive.js'
import { abortError, backoffDelay, isAbortError, sleep } from '../util/backoff.js'
import { SpeedMeter } from '../util/meter.js'
import { PART_SUFFIX, uniqueName } from '../util/paths.js'

const MiB = 1024 * 1024
const WRITE_CHUNK = MiB // agrupa o que chega da rede em gravações de até 1 MiB
const MAX_CONNECTIONS = 32
const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e'
const MAX_REMOTE_RESTARTS = 3
const MIN_STEAL = 256 * 1024
const GiB = 1024 * MiB
// Plano recém-feito (metadados lidos do Drive há menos disso, com md5 e revisão): a primeira rodada não pergunta de
// novo ao Drive. Se o arquivo mudou nesse meio-tempo, o Content-Range (tamanho) ou o MD5 do fim denunciam.
export const FRESH_PLAN_MS = 30 * 60_000

/** Ajustes finos (os testes encurtam alguns). Os valores padrão são os do contrato. */
export const DOWNLOAD_DEFAULTS = Object.freeze({
  stealMinBytes: 32 * MiB, // só rouba metade de um pedaço se restarem mais que isso nele
  retryBaseMs: 1000, // base do recuo exponencial entre tentativas
  maxRetryWaitMs: 120_000,
  maxFailures: 10, // falhas seguidas sem progresso (por conexão) antes de desistir do arquivo
  // Posições viram duráveis (fdatasync + registro) a cada checkpointMs OU a cada checkpointBytes gravados, o que vier
  // primeiro. Era a cada 2 s; no macOS o fdatasync vira F_FULLFSYNC (esvazia o cache do disco) e, em HD externo,
  // segura as gravações. Custo: numa queda de energia se perdem até ~10 s de progresso (nunca bytes errados).
  checkpointMs: 10_000,
  checkpointBytes: 1 * GiB,
  // Bloco em ordem: no mínimo minSegmentSize; em conexão rápida cresce para durar ~blockSeconds (até maxBlockBytes),
  // para a espera de cada requisição nova (TTFB) não pesar. 0 = sempre minSegmentSize.
  blockSeconds: 4,
  maxBlockBytes: 256 * MiB,
  tickMs: 250, // relógio do vigia (travamento, conexão lenta, checkpoint)
  slowAfterMs: 15_000, // conexão lenta: só julga depois desse tempo de vida...
  slowForMs: 10_000, // ...se ficar abaixo de slowRatio × mediana das outras por esse tempo seguido
  slowRatio: 0.25,
  slowCooldownMs: 30_000, // no máximo uma reabertura por conexão lenta a cada 30 s (por worker)
})

const noop = () => {}

function reasonError(message) {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}

/** Tamanho legível em unidades decimais (como a interface mostra). */
export function formatBytes(n) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = Math.max(0, Number(n) || 0)
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${v.toLocaleString('pt-BR', { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`
}

const DISK_MESSAGES = {
  ENOSPC: 'Disco cheio. Libere espaço e retome.',
  EDQUOT: 'Cota de disco atingida. Libere espaço e retome.',
  EACCES: 'Sem permissão para gravar na pasta de destino.',
  EPERM: 'Sem permissão para gravar na pasta de destino.',
  EROFS: 'O disco de destino é somente leitura.',
  EFBIG: 'O disco de destino não aceita arquivos tão grandes (FAT32 aceita no máximo 4 GB). Use um disco em exFAT, APFS ou NTFS.',
  ENAMETOOLONG: 'Nome ou caminho longo demais para o sistema.',
  ENOENT: 'A pasta de destino sumiu (o disco foi desconectado?). Confira e retome.',
  ENOTDIR: 'O caminho de destino não é uma pasta.',
  EISDIR: 'Já existe uma pasta com o nome deste arquivo no destino.',
  EIO: 'Erro de gravação no disco de destino. Confira se ele está bem conectado e retome.',
  EMFILE: 'Arquivos abertos demais no sistema. Feche outros programas e retome.',
}

/** Erro de disco vira SobeDesceError fatal com mensagem em PT-BR (o progresso já gravado fica). */
function diskError(err) {
  if (err instanceof SobeDesceError || isAbortError(err)) return err
  const code = err?.code || null
  const message = DISK_MESSAGES[code] || `Não consegui gravar no disco${code ? ` (${code})` : ''}. Confira o destino e retome.`
  const e = new SobeDesceError('fatal', message, { reason: code || 'diskError' })
  e.cause = err
  return e
}

function cannotDownloadError() {
  return new SobeDesceError('fatal', 'O dono deste arquivo bloqueou downloads.', { reason: 'cannotDownloadFile', status: 403 })
}

/** Erros do Google cuja mensagem padrão sairia em inglês ganham uma em PT-BR. */
function friendly(err) {
  if (err instanceof HttpError && err.reason === 'cannotDownloadFile') return cannotDownloadError()
  return err
}

/** Corpo que acabou antes do que o servidor prometeu: conta como queda de conexão. */
function cutError() {
  const err = new Error('A conexão caiu antes do fim. Reconectando…')
  err.code = 'ECONNRESET'
  return err
}

/** Desistência depois de muitas falhas seguidas: a mensagem original diria "tentando de novo", o que não é mais verdade. */
function exhaustedError(err) {
  const info = classifyError(err)
  const e = new SobeDesceError('retry', 'A conexão com o Google falhou muitas vezes seguidas. Tente de novo daqui a pouco.', {
    reason: info.reason || 'tooManyFailures',
    status: info.status,
    retryAfterMs: info.retryAfterMs,
  })
  e.cause = err
  return e
}

function rangeMismatchError() {
  return new SobeDesceError('retry', 'O Google mandou um trecho diferente do pedido. Tentando de novo…', { reason: 'rangeMismatch' })
}

/** "bytes 10-19/100" → { start: 10, end: 19, total: 100 } (total null se '*'). */
function parseContentRange(value) {
  const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(String(value ?? ''))
  if (!m) return null
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) }
}

/** Espera `promise`, mas desiste (AbortError) se `signal` abortar. A promessa original segue sozinha. */
function abortable(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) {
    promise.catch(noop)
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

async function statOrNull(file) {
  try {
    return await fs.stat(file)
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
    throw diskError(err)
  }
}

async function exists(file) {
  try {
    await fs.lstat(file)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

/** No Windows, antivírus/indexador seguram o arquivo recém-fechado por um instante: o rename falha e passa sozinho. */
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to)
    } catch (err) {
      const transient = err.code === 'EBUSY' || (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES'))
      if (!transient || attempt >= 5) throw err
      await sleep(100 * 2 ** attempt)
    }
  }
}

async function openFile(file, flags) {
  try {
    return await fs.open(file, flags)
  } catch (err) {
    throw diskError(err)
  }
}

function doneOf(segs) {
  let sum = 0
  for (const s of segs) sum += Math.min(s.pos, s.end + 1) - s.start
  return sum
}

function plain(segs) {
  return segs.map(s => ({ start: s.start, end: s.end, pos: Math.min(s.pos, s.end + 1) }))
}

function liveSeg({ start, end, pos }) {
  return { start, end, pos, claimed: pos, active: false, owner: null, meter: new SpeedMeter() }
}

/**
 * Segmentos persistidos → lista válida (ordenada, cobrindo [0, size-1] sem buracos nem sobreposição), ou null.
 * Pedaço completo absorve o vizinho seguinte (a lista cresce a cada roubo; assim ela volta a ficar curta).
 */
export function loadSegments(raw, size) {
  if (!Array.isArray(raw) || !raw.length || !(size > 0)) return null
  const list = raw
    .map(s => ({ start: Number(s?.start), end: Number(s?.end), pos: Number(s?.pos) }))
    .sort((a, b) => a.start - b.start)
  let next = 0
  for (const s of list) {
    if (!Number.isSafeInteger(s.start) || !Number.isSafeInteger(s.end) || !Number.isSafeInteger(s.pos)) return null
    if (s.start !== next || s.end < s.start || s.pos < s.start || s.pos > s.end + 1) return null
    next = s.end + 1
  }
  if (next !== size) return null
  const out = []
  for (const s of list) {
    const prev = out[out.length - 1]
    if (prev && prev.pos > prev.end) {
      prev.end = s.end
      prev.pos = s.pos
    } else {
      out.push(s)
    }
  }
  return out
}

export class DownloadTask extends EventEmitter {
  /**
   * @param {object} record TransferRecord de download (alterado no lugar: segments, bytesDone, verify, size, dest.path…)
   * @param {object} ctx TaskContext { drive, settings, limiter, hasher, persist, onBytes, log }
   * @param {Partial<typeof DOWNLOAD_DEFAULTS>} [opts] ajustes finos (testes)
   */
  constructor(record, ctx, opts = {}) {
    super()
    this.record = record
    this.ctx = ctx
    this.opts = { ...DOWNLOAD_DEFAULTS, ...opts }
    this.log = typeof ctx?.log === 'function' ? ctx.log : noop
    this.meter = new SpeedMeter()
    /** Contadores para diagnóstico (e testes). */
    this.counters = { requests: 0, failures: 0, steals: 0, stalls: 0, slowRestarts: 0, authRefreshes: 0, rangeMismatches: 0, resets: 0, singleStream: 0, revalidateSkipped: 0, streamHashes: 0, hashFallbacks: 0, hashConfirms: 0, checkpoints: 0 }
    this.running = false
    this.segs = null // segmentos vivos durante a execução
    this.conns = new Set() // requisições em andamento (o vigia confere cada uma)
    this.workers = new Map() // índice -> worker
    this.phase = null // AbortController da rodada atual de workers
    this.fh = null
    this.single = false // servidor ignorou Range: o arquivo vai numa conexão só
    this.failure = null
    this.remoteChanged = false
    this.forceReset = false
    this.switchSingle = false
    this.badAuth = null // header Authorization que levou 401 (os próximos pedem token novo)
    this.ckChain = null
    this.ckBusy = false
    this.lastCheckpoint = 0
    this.ckBytes = 0 // gravados desde o último checkpoint
    this.hs = null // MD5 que acompanha a gravação (Hasher.stream), só durante uma rodada que pode terminar em 'done'
    this.exportBytes = 0
    this.verifyBytes = 0
    this.trustedPlan = false // esta execução baixou sem revalidar (plano recém-feito)
  }

  // ─────────── para a interface ───────────

  /** Posições ao vivo de cada segmento (as do registro só mudam a cada checkpoint). */
  liveSegments() {
    const list = this.segs ?? this.record.segments ?? []
    const now = Date.now()
    return list.map(s => ({
      start: s.start,
      end: s.end,
      pos: Math.min(s.pos, s.end + 1),
      active: !!s.active,
      speed: s.active && s.meter ? s.meter.rate(now) : 0,
    }))
  }

  /** Bytes já gravados (ao vivo; inclui o que ainda não passou por checkpoint). */
  liveBytes() {
    if (this.record.source?.export) return this.running ? this.exportBytes : this.record.bytesDone || 0
    return this.segs ? doneOf(this.segs) : this.record.bytesDone || 0
  }

  speed() {
    return this.meter.rate()
  }

  // ─────────── execução ───────────

  /**
   * Baixa até o fim (ou até `signal` abortar). Resolve quando o arquivo está no lugar final.
   * Abort => grava as posições duráveis, fecha o arquivo e rejeita com AbortError.
   * Erro fatal/cota/não encontrado/reconectar => rejeita com o erro (o manager classifica).
   */
  async run(signal) {
    if (this.running) throw new Error('Este download já está em andamento.')
    this.running = true
    try {
      if (signal?.aborted) throw abortError(signal)
      const rec = this.record
      if (!rec?.dest?.path || !rec?.source?.fileId) {
        throw new SobeDesceError('fatal', 'Registro de download incompleto (sem origem ou destino).', { reason: 'badRecord' })
      }
      rec.dest.tempPath ||= rec.dest.path + PART_SUFFIX
      if (rec.source.export) return await this.#runExport(signal)
      if (rec.size === 0) return await this.#runEmpty(signal)
      if (await this.#alreadyPlaced(signal)) return
      for (let round = 0; ; round++) {
        const result = await this.#runSegmented(signal)
        if (result === 'empty') return await this.#runEmpty(signal)
        if (result === 'done') break
        if (round + 1 >= MAX_REMOTE_RESTARTS) {
          throw new SobeDesceError('retry', 'O arquivo mudou no Drive durante o download. Vou tentar de novo.', { reason: 'remoteChanged' })
        }
      }
      await this.#finish(signal)
    } catch (err) {
      // Pausa vence qualquer outro erro que tenha acontecido junto: o manager só precisa saber que foi pausa.
      if (signal?.aborted && !isAbortError(err)) throw abortError(signal)
      throw err
    } finally {
      this.running = false
      this.meter.reset()
      if (this.segs) for (const s of this.segs) s.active = false
      await this.#closeHash()
    }
  }

  #resetRunState() {
    this.failure = null
    this.remoteChanged = false
    this.switchSingle = false
    this.single = false
    this.workers.clear()
    this.conns.clear()
    this.phase = null
  }

  /**
   * Uma passada completa. 'done' = todos os bytes estão no disco; 'changed' = o arquivo mudou no Drive (recomeçar);
   * 'empty' = o Drive diz que o arquivo agora tem 0 byte.
   */
  async #runSegmented(signal) {
    const rec = this.record
    this.#resetRunState()
    if (this.#freshPlan()) {
      this.trustedPlan = true
      this.counters.revalidateSkipped++
    } else {
      await this.#revalidate(signal)
    }
    if (signal?.aborted) throw abortError(signal)
    if (rec.size === 0) return 'empty'
    const size = rec.size
    const temp = rec.dest.tempPath
    await this.#mkdirFor(temp)

    let segs = loadSegments(rec.segments, size)
    let stat = null
    if (segs && segs.some(s => s.pos > s.start)) {
      stat = await statOrNull(temp)
      // Temporário sumiu ou encolheu: as posições do registro não valem mais nada.
      if (!stat || !stat.isFile() || stat.size < size) {
        segs = null
        this.#noteReset('tempMissing')
      }
    } else {
      segs = null
    }

    let fh
    if (segs) {
      // Arquivo esparso ocupa só o que já foi gravado; em disco sem esparsos (exFAT) já ocupa tudo.
      const allocated = Number(stat.blocks) > 0 ? Number(stat.blocks) * 512 : 0
      await this.#checkSpace(path.dirname(temp), size - Math.max(doneOf(segs), allocated))
      fh = await openFile(temp, 'r+')
      if (stat.size > size) {
        try {
          await fh.truncate(size)
        } catch (err) {
          await fh.close().catch(noop)
          throw diskError(err)
        }
      }
      this.#commit(segs)
    } else {
      segs = this.#initialSegments(size)
      // Ordem importa: apaga o temporário antigo, grava "zero progresso" e só então cria o novo.
      // Assim um registro antigo (gravação atrasada) nunca aponta para um arquivo recém-criado cheio de zeros.
      await fs.rm(temp, { force: true }).catch(noop)
      await this.#commit(segs, { wait: true })
      await this.#checkSpace(path.dirname(temp), size)
      fh = await openFile(temp, 'w')
      try {
        await fh.truncate(size) // arquivo esparso do tamanho final: cada conexão grava na sua posição
      } catch (err) {
        await fh.close().catch(noop)
        throw diskError(err)
      }
    }
    this.fh = fh
    this.segs = segs.map(liveSeg)
    this.#openHash(temp)

    let err = null
    const timer = setInterval(() => this.#tick(), this.opts.tickMs)
    timer.unref?.()
    this.lastCheckpoint = Date.now()
    this.ckBytes = 0
    try {
      await this.#phases(signal)
    } catch (e) {
      err = e
    } finally {
      clearInterval(timer)
    }
    // Todos os workers pararam: nenhuma gravação em voo. Checkpoint final e fecha.
    try {
      await this.#checkpoint()
    } catch (e) {
      if (!err) err = diskError(e)
      else this.log('download: checkpoint final falhou', e?.message)
    }
    await fh.close().catch(noop)
    this.fh = null
    for (const s of this.segs) s.active = false
    // O MD5 da gravação só segue para a conferência se esta rodada terminou com tudo no disco.
    // (fecha esperando o worker soltar o arquivo: a próxima rodada pode apagar e recriar o temporário)
    if (signal?.aborted || err || this.remoteChanged) await this.#closeHash()
    else this.#feedHash()
    if (signal?.aborted) throw abortError(signal)
    if (err) throw err
    return this.remoteChanged ? 'changed' : 'done'
  }

  /** Rodadas de workers até completar. Uma rodada nova só nasce para trocar para conexão única ou cobrir sobras. */
  async #phases(signal) {
    let idle = 0
    for (;;) {
      const phase = new AbortController()
      this.phase = phase
      const onAbort = () => phase.abort(signal.reason)
      if (signal?.aborted) phase.abort(signal.reason)
      else signal?.addEventListener('abort', onAbort, { once: true })
      const before = doneOf(this.segs)
      try {
        this.#spawnUpTo()
        await this.#drain()
      } finally {
        signal?.removeEventListener('abort', onAbort)
        if (!phase.signal.aborted) phase.abort(reasonError('Rodada encerrada.'))
        await this.#drain()
      }
      if (signal?.aborted) throw abortError(signal)
      if (this.failure) throw this.failure
      if (this.remoteChanged) return
      if (this.switchSingle) {
        this.switchSingle = false
        this.#collapse()
        continue
      }
      if (this.segs.every(s => s.pos > s.end)) return
      // Sobrou pedaço sem dono (ex.: menos conexões nos ajustes). Rodadas sem nenhum progresso indicam defeito.
      idle = doneOf(this.segs) > before ? 0 : idle + 1
      if (idle > 5) throw new SobeDesceError('retry', 'O download parou sem motivo aparente. Vou tentar de novo.', { reason: 'noProgress' })
    }
  }

  async #drain() {
    while (this.workers.size) await Promise.allSettled([...this.workers.values()].map(w => w.promise))
  }

  #desired() {
    if (this.single) return 1
    const n = Math.floor(Number(this.ctx.settings?.get?.().connectionsPerDownload) || 1)
    return Math.min(MAX_CONNECTIONS, Math.max(1, n))
  }

  /** Um pedaço só, o arquivo inteiro: os blocos saem dele em ordem, um por vez, conforme as conexões pedem (#pick). */
  #initialSegments(size) {
    return [{ start: 0, end: size - 1, pos: 0 }]
  }

  /** Menor bloco em ordem: o minSegmentSize (o mesmo que o manager usa para contar as conexões de cada arquivo). */
  #minBlock() {
    const st = this.ctx.settings?.get?.() ?? {}
    return Math.max(MIN_STEAL, Math.floor(Number(st.minSegmentSize) || 64 * MiB))
  }

  /**
   * Bloco da próxima requisição: minSegmentSize, ou o que uma conexão baixa em ~blockSeconds se isso for maior
   * (cada requisição nova espera o primeiro byte; em conexão rápida, bloco pequeno deixaria a conexão parada à toa).
   * Teto: maxBlockBytes, porque o MD5 só lê até o começo do bloco mais antigo ainda incompleto.
   */
  #blockSize() {
    const min = this.#minBlock()
    const secs = Number(this.opts.blockSeconds) || 0
    if (!(secs > 0)) return min
    const perConn = this.meter.rawRate() / Math.max(1, this.conns.size)
    const want = Math.floor((perConn * secs) / MiB) * MiB
    return Math.max(min, Math.min(Number(this.opts.maxBlockBytes) || min, want))
  }

  /** Servidor ignorou o Range: junta tudo num segmento só, a partir do maior prefixo já completo. */
  #collapse() {
    let prefix = 0
    for (const s of this.segs) {
      if (s.start !== prefix) break
      if (s.pos > s.end) {
        prefix = s.end + 1
        continue
      }
      prefix = s.pos
      break
    }
    this.single = true
    this.counters.singleStream++
    this.segs = [liveSeg({ start: 0, end: this.record.size - 1, pos: Math.min(prefix, this.record.size) })]
  }

  /** Nunca rouba pedaços minúsculos (cada metade precisa valer uma requisição nova). */
  #stealMin() {
    return Math.max(MIN_STEAL, Number(this.opts.stealMinBytes) || 0)
  }

  #hasWork() {
    for (const s of this.segs) {
      if (s.pos > s.end) continue
      if (!s.active) return true
      if (!this.single && s.end - Math.max(s.pos, s.claimed) + 1 > this.#stealMin()) return true
    }
    return false
  }

  #spawnUpTo() {
    const phase = this.phase
    if (!phase || phase.signal.aborted || !this.segs || !this.fh) return
    const want = this.#desired()
    for (let i = 0; i < want; i++) {
      if (this.workers.has(i)) continue
      if (!this.#hasWork()) return
      const w = { index: i, fails: 0, conn: null, lastSlowRestart: -Infinity, promise: null }
      this.workers.set(i, w)
      w.promise = this.#worker(w, phase)
        .catch(err => this.#fail(err))
        .finally(() => {
          if (this.workers.get(i) === w) this.workers.delete(i)
        })
    }
  }

  /**
   * Pega o PRIMEIRO pedaço livre (em ordem), cortado no tamanho de um bloco; sem pedaço livre (fim do arquivo),
   * rouba a metade do maior que falta.
   */
  #pick(w) {
    const segs = this.segs
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]
      if (s.active || s.pos > s.end) continue
      // Uma conexão só (ou servidor sem Range): não corta, para não pagar uma requisição nova a cada bloco.
      if (!this.single && this.#desired() > 1) {
        const block = this.#blockSize()
        const cut = s.pos + block
        // Sobra pequena (até meio bloco) vai junto: não vale uma requisição a mais.
        if (s.end + 1 - cut > block / 2) {
          segs.splice(i + 1, 0, liveSeg({ start: cut, end: s.end, pos: cut }))
          s.end = cut - 1
        }
      }
      return this.#own(s, w)
    }
    if (this.single) return null
    let best = null
    let bestFrom = 0
    let bestRem = 0
    for (const s of segs) {
      if (!s.active) continue
      // `claimed` inclui o que o dono já recebeu e ainda não gravou: o corte fica depois disso.
      const from = Math.max(s.pos, s.claimed)
      const rem = s.end - from + 1
      if (rem > bestRem) {
        best = s
        bestRem = rem
        bestFrom = from
      }
    }
    if (!best || bestRem <= this.#stealMin()) return null
    const mid = bestFrom + Math.ceil(bestRem / 2)
    const seg = liveSeg({ start: mid, end: best.end, pos: mid })
    best.end = mid - 1 // o dono para sozinho ao passar do novo fim (conferido a cada pedaço recebido)
    segs.splice(segs.indexOf(best) + 1, 0, seg)
    this.counters.steals++
    return this.#own(seg, w)
  }

  #own(seg, w) {
    seg.active = true
    seg.owner = w
    return seg
  }

  async #worker(w, phase) {
    while (!phase.signal.aborted) {
      if (w.index >= this.#desired()) return
      const seg = this.#pick(w)
      if (!seg) return
      try {
        await this.#runSegment(w, seg, phase)
      } finally {
        seg.active = false
        seg.owner = null
        seg.claimed = seg.pos
        if (seg.pos > seg.end) {
          this.#compact()
          this.#feedHash()
        }
      }
    }
  }

  /** Junta pedaços completos vizinhos (sem dono): com blocos em ordem a lista cresceria um item por bloco. */
  #compact() {
    const out = []
    for (const s of this.segs) {
      const prev = out[out.length - 1]
      if (prev && !prev.active && !s.active && prev.pos > prev.end && s.pos > s.end && prev.end + 1 === s.start) {
        prev.end = s.end
        prev.pos = s.end + 1
        prev.claimed = prev.pos
        continue
      }
      out.push(s)
    }
    this.segs = out
  }

  // ─────────── MD5 junto com a gravação ───────────

  /** Abre o MD5 que acompanha esta rodada, se a conferência vai acontecer e o arquivo passa de um bloco. */
  #openHash(temp) {
    this.#closeHash()
    const rec = this.record
    const hasher = this.ctx.hasher
    if (!this.ctx.settings?.get?.().verifyChecksums || !rec.source.md5 || typeof hasher?.stream !== 'function') return
    // Até um bloco a conferência no fim é rápida (e um worker a mais por arquivo pequeno não compensa).
    if (!(rec.size > this.#minBlock())) return
    try {
      this.hs = hasher.stream(temp)
    } catch (err) {
      this.hs = null
      this.log('download: MD5 junto com a gravação indisponível; confere no fim', err?.message)
      return
    }
    this.#feedHash() // retomada: o prefixo já baixado é relido em segundo plano
  }

  /** Encerra o MD5 da gravação; a promessa resolve quando o worker já fechou o arquivo (nunca rejeita). */
  #closeHash() {
    const hs = this.hs
    this.hs = null
    return hs ? hs.close() : Promise.resolve()
  }

  /**
   * Frente contínua: tudo em [0, frente) já foi gravado (a gravação terminou antes de `pos` andar) e não é mais
   * reescrito nesta rodada (cada conexão só grava para a frente da sua posição; roubo e conexão única começam depois
   * dela). Só existe com a lista em ordem e sem buracos; qualquer coisa estranha para de avançar.
   */
  #front() {
    let front = 0
    for (const s of this.segs ?? []) {
      if (s.start !== front) break
      if (s.pos > s.end) {
        front = s.end + 1
        continue
      }
      front = s.pos
      break
    }
    return front
  }

  #feedHash() {
    const hs = this.hs
    if (!hs || !this.segs) return
    hs.advance(this.#front())
    if (hs.failed) {
      this.log('download: MD5 junto com a gravação falhou; confere no fim', hs.failed?.message)
      this.#closeHash()
    }
  }

  async #runSegment(w, seg, phase) {
    while (seg.pos <= seg.end && !phase.signal.aborted) {
      if (w.index >= this.#desired()) return // menos conexões nos ajustes: devolve o pedaço
      const before = seg.pos
      const conn = this.#openConn(phase.signal, seg, w)
      let err = null
      try {
        await this.#fetch(conn, seg, phase)
      } catch (e) {
        err = e
      } finally {
        this.#closeConn(conn)
      }
      if (seg.pos > before) this.#progressed(w)
      if (phase.signal.aborted) return
      if (!err) continue
      if (!(await this.#handleFailure(w, seg, conn, err, phase))) return
    }
  }

  #progressed(w) {
    w.fails = 0
    let max = 0
    for (const x of this.workers.values()) max = Math.max(max, x.fails)
    this.record.attempts = max
  }

  /** Decide o que fazer depois de uma requisição que falhou. false = o worker para. */
  async #handleFailure(w, seg, conn, err, phase) {
    if (conn.why === 'slow') return true // reabre já, do ponto onde parou (não conta como falha)
    if (conn.why === 'stall') err = stalledError()
    if (err instanceof HttpError && err.status === 416) {
      if (seg.pos > seg.end) return true
      this.#markRemoteChanged(phase) // pedaço incompleto fora do arquivo: ele mudou de tamanho
      return false
    }
    let info = classifyError(err)
    // Abort que não veio da pausa nem do fim da rodada (ex.: conexão cancelada por baixo): trata como queda.
    if (info.kind === 'abort') info = { kind: 'retry', retryAfterMs: null }
    if (info.kind !== 'retry' && info.kind !== 'auth') {
      this.#fail(friendly(err))
      return false
    }
    w.fails++
    this.counters.failures++
    this.record.attempts = Math.max(this.record.attempts || 0, w.fails)
    if (info.kind === 'auth') this.badAuth = conn.auth
    if (w.fails > this.opts.maxFailures) {
      this.#fail(exhaustedError(err))
      return false
    }
    this.log('download: tentando de novo', this.record.name, `(${w.fails})`, err?.message)
    if (info.kind === 'auth') return true // token novo na próxima requisição, sem esperar
    const wait = Math.min(this.opts.maxRetryWaitMs, Math.max(backoffDelay(w.fails - 1, { base: this.opts.retryBaseMs }), info.retryAfterMs ?? 0))
    try {
      await sleep(wait, phase.signal)
    } catch {
      return false
    }
    return true
  }

  #fail(err) {
    if (!this.failure) this.failure = err
    this.phase?.abort(reasonError('Download interrompido por erro.'))
  }

  #markRemoteChanged(phase) {
    this.remoteChanged = true
    this.forceReset = true
    phase.abort(reasonError('O arquivo mudou no Drive.'))
  }

  #toSingle(phase) {
    this.switchSingle = true
    phase.abort(reasonError('O servidor ignorou o Range.'))
  }

  // ─────────── uma requisição ───────────

  #openConn(parent, seg = null, worker = null) {
    const ac = new AbortController()
    const onAbort = () => ac.abort(parent.reason)
    if (parent.aborted) ac.abort(parent.reason)
    else parent.addEventListener('abort', onAbort, { once: true })
    const now = Date.now()
    const conn = { ac, parent, onAbort, seg, worker, startedAt: now, waitSince: now, slowSince: 0, why: null, done: false, auth: null, meter: new SpeedMeter({ windowMs: 5000 }) }
    if (seg) seg.claimed = seg.pos
    if (worker) worker.conn = conn
    this.conns.add(conn)
    return conn
  }

  #closeConn(conn) {
    conn.parent.removeEventListener('abort', conn.onAbort)
    this.conns.delete(conn)
    if (conn.worker?.conn === conn) conn.worker.conn = null
    // Corpo não lido até o fim: aborta para o undici fechar a conexão (corpo precisa ser consumido ou destruído).
    if (!conn.done && !conn.ac.signal.aborted) conn.ac.abort(reasonError('Requisição encerrada.'))
  }

  async #headers(signal, conn) {
    const drive = this.ctx.drive
    let h = await abortable(Promise.resolve(drive.authHeader()), signal)
    if (this.badAuth && h?.authorization === this.badAuth) {
      // 401: pede token novo. Com rejectedToken, várias conexões que levaram 401 juntas causam uma renovação só.
      this.counters.authRefreshes++
      const rejected = this.badAuth.replace(/^Bearer\s+/i, '')
      if (typeof drive.auth?.getAccessToken === 'function' && drive.accountId) {
        const token = await abortable(drive.auth.getAccessToken(drive.accountId, { forceRefresh: true, rejectedToken: rejected }), signal)
        h = { authorization: `Bearer ${token}` }
      } else {
        h = await abortable(Promise.resolve(drive.authHeader({ forceRefresh: true })), signal)
      }
    }
    if (conn) conn.auth = h.authorization
    const src = this.record.source
    return { ...h, ...resourceKeyHeader({ id: src.fileId, resourceKey: src.resourceKey }) }
  }

  async #fetch(conn, seg, phase) {
    const rec = this.record
    const size = rec.size
    const signal = conn.ac.signal
    const headers = await this.#headers(signal, conn)
    headers.range = `bytes=${seg.pos}-${seg.end}`
    this.counters.requests++
    const res = await httpRequest(this.ctx.drive.mediaUrl(rec.source.fileId), { headers, signal, expect: [200, 206] })
    res.body.on('error', noop) // destroy() sem ouvinte de 'error' derruba o processo (undici)
    conn.waitSince = Date.now()
    let skip = 0
    let lastByte
    if (res.status === 206) {
      const cr = parseContentRange(res.headers['content-range'])
      if (!cr || cr.start !== seg.pos || cr.end < cr.start) {
        this.counters.rangeMismatches++
        throw rangeMismatchError() // NUNCA grava bytes de outro trecho
      }
      if (cr.total != null && cr.total !== size) return this.#markRemoteChanged(phase)
      lastByte = cr.end
    } else {
      // 200 num pedido com Range: o servidor mandou o arquivo inteiro desde o byte 0.
      const len = res.headers['content-length']
      if (len != null && Number(len) !== size) return this.#markRemoteChanged(phase)
      if (!(seg.start === 0 && seg.end === size - 1)) return this.#toSingle(phase)
      skip = seg.pos // conexão única: descarta o que já temos e grava daí em diante
      lastByte = size - 1
    }
    const ended = await this.#consume(conn, res.body, {
      skip,
      room: buffered => seg.end + 1 - seg.pos - buffered,
      claim: upto => {
        seg.claimed = seg.pos + upto
      },
      shouldStop: () => conn.worker != null && conn.worker.index >= this.#desired(),
      write: async (buf, n) => {
        const at = seg.pos
        const k = Math.min(n, seg.end + 1 - at) // o fim pode ter encolhido (roubo) enquanto bufferizava
        if (k <= 0) return
        await this.#writeAt(buf, k, at)
        seg.pos = at + k
        this.ckBytes += k
      },
    })
    conn.done = ended
    if (ended && seg.pos <= Math.min(lastByte, seg.end)) throw cutError()
  }

  /**
   * Lê o corpo, agrupa até 1 MiB e grava. Respeita o limitador de banda e a velocidade do disco (só pede o próximo
   * pedaço depois de gravar). Bytes válidos já recebidos são gravados mesmo se a conexão cair.
   * @returns {Promise<boolean>} true se o corpo terminou normalmente
   */
  async #consume(conn, body, { skip = 0, room = () => Infinity, claim = null, shouldStop = null, write }) {
    const it = body[Symbol.asyncIterator]()
    const limiter = this.ctx.limiter
    let bufs = []
    let len = 0
    let ended = false
    const flush = async () => {
      if (!len) return
      const buf = bufs.length === 1 ? bufs[0] : Buffer.concat(bufs, len)
      const n = len
      bufs = []
      len = 0
      await write(buf, n)
    }
    try {
      for (;;) {
        conn.waitSince = Date.now()
        const r = await it.next()
        conn.waitSince = 0 // daqui até o próximo next() o tempo é nosso (disco/limitador), não travamento da rede
        if (r.done) {
          ended = true
          break
        }
        let c = r.value
        this.#account(conn, c.length)
        if (skip > 0) {
          if (c.length <= skip) {
            skip -= c.length
            continue
          }
          c = c.subarray(skip)
          skip = 0
        }
        const free = room(len)
        if (free <= 0) break
        const cut = c.length > free
        if (cut) c = c.subarray(0, free)
        claim?.(len + c.length)
        if (limiter && !limiter.unlimited) await limiter.take(c.length, conn.ac.signal)
        bufs.push(c)
        len += c.length
        if (len >= WRITE_CHUNK) await flush()
        if (cut || shouldStop?.()) break
      }
    } finally {
      conn.waitSince = 0
      await flush()
    }
    return ended
  }

  #account(conn, n) {
    this.meter.add(n)
    conn.meter.add(n)
    conn.seg?.meter.add(n)
    try {
      this.ctx.onBytes?.(n)
    } catch {
      // contador de quem chama não pode derrubar o download
    }
  }

  async #writeAt(buf, n, position) {
    let off = 0
    while (off < n) {
      let r
      try {
        r = await this.fh.write(buf, off, n - off, position + off)
      } catch (err) {
        throw diskError(err)
      }
      if (!r.bytesWritten) throw diskError(Object.assign(new Error('gravação vazia'), { code: 'EIO' }))
      off += r.bytesWritten
    }
  }

  // ─────────── vigia: travamento, conexão lenta, checkpoint ───────────

  #tick() {
    try {
      const now = Date.now()
      const st = this.ctx.settings?.get?.() ?? {}
      const stallMs = Math.max(1000, Number(st.stallTimeoutMs) || 30_000)
      const conns = [...this.conns]
      for (const c of conns) {
        if (c.why || c.ac.signal.aborted) continue
        if (c.waitSince && now - c.waitSince >= stallMs) {
          c.why = 'stall'
          this.counters.stalls++
          c.ac.abort(stalledError())
        }
      }
      // Com limite de banda ligado, a lentidão é nossa (o limitador reparte as fichas): reabrir não adianta.
      const limited = this.ctx.limiter && !this.ctx.limiter.unlimited
      if (st.restartSlowConnections && !limited) this.#checkSlow(conns, now)
      if (this.fh && this.segs && !this.ckBusy && (now - this.lastCheckpoint >= this.opts.checkpointMs || this.ckBytes >= this.opts.checkpointBytes)) {
        this.#checkpoint().catch(err => this.#fail(diskError(err)))
      }
      if (this.fh) this.#feedHash()
      this.#spawnUpTo()
    } catch (err) {
      this.#fail(err)
    }
  }

  /** Reabre conexões que ficaram muito mais lentas que as outras (o Google às vezes estrangula uma). */
  #checkSlow(conns, now) {
    const live = conns.filter(c => c.seg && !c.why && !c.ac.signal.aborted)
    if (live.length < 2) {
      for (const c of live) c.slowSince = 0
      return
    }
    const rates = new Map(live.map(c => [c, c.meter.rawRate(now)]))
    for (const c of live) {
      if (now - c.startedAt < this.opts.slowAfterMs) {
        c.slowSince = 0
        continue
      }
      const others = live.filter(o => o !== c).map(o => rates.get(o)).sort((a, b) => a - b)
      const mid = others.length >> 1
      const median = others.length % 2 ? others[mid] : (others[mid - 1] + others[mid]) / 2
      if (median > 0 && rates.get(c) < median * this.opts.slowRatio) {
        if (!c.slowSince) c.slowSince = now
        const w = c.worker
        if (now - c.slowSince >= this.opts.slowForMs && now - (w?.lastSlowRestart ?? -Infinity) >= this.opts.slowCooldownMs) {
          c.why = 'slow'
          if (w) w.lastSlowRestart = now
          this.counters.slowRestarts++
          c.ac.abort(reasonError('Conexão lenta: reabrindo.'))
        }
      } else {
        c.slowSince = 0
      }
    }
  }

  /**
   * Torna o progresso durável: guarda as posições ATUAIS (tudo antes delas já foi gravado), faz fdatasync e só
   * então copia para o registro e pede para persistir. Bytes que chegarem durante o sync ficam para o próximo.
   */
  #checkpoint() {
    const run = async () => {
      const fh = this.fh
      if (!fh || !this.segs) return
      const snap = plain(this.segs)
      try {
        await fh.datasync()
      } catch (err) {
        throw diskError(err)
      }
      this.#commit(snap)
    }
    this.lastCheckpoint = Date.now()
    this.ckBytes = 0
    this.counters.checkpoints++
    const p = (this.ckChain || Promise.resolve()).catch(noop).then(run)
    this.ckChain = p
    this.ckBusy = true
    p.catch(noop).finally(() => {
      if (this.ckChain === p) this.ckBusy = false
    })
    return p
  }

  /** Copia posições (já duráveis) para o registro e pede gravação. `wait`: espera a gravação se persist() devolver promessa. */
  #commit(segs, { wait = false } = {}) {
    const rec = this.record
    const snap = plain(segs)
    const done = doneOf(snap)
    if (done > (rec.bytesDone || 0)) rec.attempts = 0
    rec.segments = snap
    rec.bytesDone = done
    rec.updatedAt = Date.now()
    const r = this.#persist()
    return wait ? Promise.resolve(r).catch(err => this.log('download: falha ao gravar a fila', err?.message)) : undefined
  }

  #persist() {
    try {
      const r = this.ctx.persist?.()
      if (r && typeof r.then === 'function') r.then(noop, err => this.log('download: falha ao gravar a fila', err?.message))
      return r
    } catch (err) {
      this.log('download: falha ao gravar a fila', err?.message)
      return undefined
    }
  }

  // ─────────── antes de baixar ───────────

  /**
   * Dá para começar sem o files.get? Só na PRIMEIRA execução de um plano recém-feito: `source.checkedAt` é de uso
   * único (sai do registro aqui), então retomada, nova tentativa, troca de tamanho e MD5 diferente revalidam como sempre.
   */
  #freshPlan() {
    const rec = this.record
    const src = rec.source
    const at = Number(src.checkedAt)
    if (src.checkedAt !== undefined) {
      delete src.checkedAt
      this.#persist()
    }
    if (!(at > 0) || this.forceReset) return false
    const age = Date.now() - at
    if (!(age >= 0 && age < FRESH_PLAN_MS)) return false
    if (!src.md5 || !src.headRevisionId || !(rec.size > 0)) return false
    // Progresso de uma rodada anterior: a retomada sempre confere se o arquivo continua o mesmo.
    if (Array.isArray(rec.segments) && rec.segments.some(s => Number(s?.pos) > Number(s?.start))) return false
    if (rec.verify) return false
    return true
  }

  /**
   * MD5 não conferiu numa execução que não revalidou: o arquivo pode ter mudado no Drive depois do plano (mesmo
   * tamanho). Pergunta agora; se mudou, é "arquivo mudou" (volta para a fila e baixa a versão nova), não defeito.
   */
  async #changedSincePlan(signal, expected) {
    if (!this.trustedPlan) return false
    const rec = this.record
    const src = rec.source
    try {
      const item = await this.ctx.drive.getItem(src.fileId, { signal, resourceKey: src.resourceKey || undefined })
      return (
        (item.size != null && item.size !== rec.size) ||
        (!!item.md5 && String(item.md5).toLowerCase() !== expected) ||
        (!!src.headRevisionId && !!item.headRevisionId && item.headRevisionId !== src.headRevisionId)
      )
    } catch (err) {
      if (isAbortError(err)) throw err
      this.log('download: não consegui conferir se o arquivo mudou no Drive', err?.message)
      return false
    }
  }

  /** Confere o arquivo no Drive: se mudou (tamanho, md5 ou revisão), joga fora o que já foi baixado. */
  async #revalidate(signal) {
    const rec = this.record
    const src = rec.source
    const item = await this.ctx.drive.getItem(src.fileId, { signal, resourceKey: src.resourceKey || undefined })
    if (item.canDownload === false) throw cannotDownloadError()
    if (item.isFolder || item.isShortcut || item.isGoogleDoc || item.size == null) {
      throw new SobeDesceError('fatal', 'Este item do Drive não é um arquivo que dá para baixar.', { reason: 'fileNotDownloadable' })
    }
    const changed =
      this.forceReset ||
      (rec.size != null && item.size !== rec.size) ||
      (!!src.md5 && !!item.md5 && src.md5 !== item.md5) ||
      (!!src.headRevisionId && !!item.headRevisionId && src.headRevisionId !== item.headRevisionId)
    if (changed) {
      src.md5 = item.md5
      src.headRevisionId = item.headRevisionId
    } else {
      src.md5 ||= item.md5
      src.headRevisionId ||= item.headRevisionId
    }
    if (item.modifiedTime) src.modifiedTime = item.modifiedTime
    if (item.resourceKey) src.resourceKey = item.resourceKey
    rec.size = item.size
    this.forceReset = false
    if (changed) await this.#discard('remoteChanged')
    else this.#persist()
  }

  /**
   * Queda logo depois do rename final (antes de o registro "concluído" ir para o disco): o registro diz que está
   * tudo baixado, o temporário sumiu e o arquivo final existe. Se o MD5 dele confere, já terminou — sem baixar de novo
   * nem criar uma cópia "(2)".
   */
  async #alreadyPlaced(signal) {
    const rec = this.record
    const segs = loadSegments(rec.segments, rec.size)
    const expected = rec.source.md5 ? String(rec.source.md5).toLowerCase() : null
    if (!segs || !segs.every(s => s.pos > s.end) || !expected || !this.ctx.hasher) return false
    if (await statOrNull(rec.dest.tempPath)) return false
    const st = await statOrNull(rec.dest.path)
    if (!st?.isFile() || st.size !== rec.size) return false
    let actual
    try {
      actual = String(await this.ctx.hasher.hash(rec.dest.path, { signal })).toLowerCase()
    } catch (err) {
      if (isAbortError(err)) throw err
      return false
    }
    if (actual !== expected) return false
    rec.verify = { state: 'ok', expected, actual }
    rec.bytesDone = rec.size
    rec.updatedAt = Date.now()
    this.#persist()
    return true
  }

  /** Recomeça do zero: registro sem progresso e temporário apagado. */
  async #discard(reason) {
    const rec = this.record
    rec.segments = []
    rec.bytesDone = 0
    rec.verify = null
    rec.updatedAt = Date.now()
    this.#persist()
    await fs.rm(rec.dest.tempPath, { force: true }).catch(noop)
    this.#noteReset(reason)
  }

  #noteReset(reason) {
    this.counters.resets++
    this.log('download: recomeçando do zero', this.record.name, reason)
    this.emit('reset', { reason })
  }

  async #checkSpace(dir, needed) {
    if (!(needed > 0)) return
    let st
    try {
      st = await fs.statfs(dir)
    } catch {
      return // sistema/disco que não informa: se faltar espaço, o ENOSPC aparece na gravação
    }
    const free = Number(st.bavail) * Number(st.bsize)
    if (Number.isFinite(free) && free < needed) {
      throw new SobeDesceError(
        'fatal',
        `Falta espaço no disco: este arquivo precisa de mais ${formatBytes(needed)} e só há ${formatBytes(free)} livres. Libere espaço e retome.`,
        { reason: 'ENOSPC' },
      )
    }
  }

  async #mkdirFor(file) {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
    } catch (err) {
      throw diskError(err)
    }
  }

  // ─────────── depois de baixar ───────────

  async #finish(signal) {
    const rec = this.record
    const expected = rec.source.md5 ? String(rec.source.md5).toLowerCase() : null
    const verify = Boolean(this.ctx.settings?.get?.().verifyChecksums && expected && this.ctx.hasher)
    if (verify) {
      rec.status = 'verifying'
      rec.verify = { state: 'running', expected, actual: null }
      this.verifyBytes = this.hs ? this.hs.bytes : 0 // o MD5 da gravação já vem andando
      this.#persist()
      this.emit('status', 'verifying')
      const onProgress = p => {
        this.verifyBytes = p.bytes
      }
      let actual = await this.#streamResult(signal, expected, onProgress)
      // MD5 da gravação diferente do Drive: antes de jogar o arquivo fora, confirma lendo o arquivo inteiro (raro, e
      // assim um defeito no caminho novo nunca vira "veio diferente" à toa).
      if (actual != null && actual !== expected) {
        this.counters.hashConfirms++
        this.log('download: MD5 da gravação não confere; confirmando com o arquivo inteiro', rec.name)
        actual = null
      }
      try {
        // Sem o MD5 da gravação (arquivo pequeno, falhou ou nem começou): lê o arquivo inteiro, como sempre.
        actual ??= await this.ctx.hasher.hash(rec.dest.tempPath, { signal, onProgress })
      } catch (err) {
        if (isAbortError(err)) {
          rec.verify = { state: 'pending', expected, actual: null }
          this.#persist()
          throw signal?.aborted ? abortError(signal) : err
        }
        if (err?.code === 'ENOENT') {
          await this.#discard('tempMissing')
          throw new SobeDesceError('retry', 'O arquivo temporário sumiu antes da conferência. Vou baixar de novo.', { reason: 'tempMissing' })
        }
        if (!err?.code) {
          // Ex.: o worker do MD5 caiu. O arquivo continua inteiro: tentar de novo só refaz a conferência.
          const e = new SobeDesceError('retry', 'Não consegui conferir o MD5 do arquivo baixado. Vou tentar de novo.', { reason: 'verifyFailed' })
          e.cause = err
          throw e
        }
        throw diskError(err)
      }
      actual = String(actual).toLowerCase()
      if (actual !== expected) {
        await fs.rm(rec.dest.tempPath, { force: true }).catch(noop)
        rec.segments = []
        rec.bytesDone = 0
        rec.verify = null
        rec.updatedAt = Date.now()
        if (await this.#changedSincePlan(signal, expected)) {
          this.#persist()
          this.#noteReset('remoteChanged')
          throw new SobeDesceError('retry', 'O arquivo mudou no Drive durante o download. Vou tentar de novo.', { reason: 'remoteChanged' })
        }
        rec.verify = { state: 'mismatch', expected, actual }
        this.#persist()
        throw new SobeDesceError('fatal', 'O arquivo baixado veio diferente do original (MD5 não confere). Tente de novo.', { reason: 'checksumMismatch' })
      }
      rec.verify = { state: 'ok', expected, actual }
    } else {
      await this.#closeHash()
      rec.verify = { state: 'skipped', expected, actual: null }
    }
    await this.#place()
    if (rec.verify.state === 'ok') await this.#rememberHash(rec.verify.actual)
  }

  /**
   * Termina o MD5 que acompanhou a gravação (só falta o fim; numa retomada, o que ainda não foi relido).
   * null = não há MD5 da gravação ou ele falhou (quem chama confere lendo o arquivo inteiro). Pausa = AbortError.
   */
  async #streamResult(signal, expected, onProgress) {
    const hs = this.hs
    this.hs = null
    if (!hs) return null
    try {
      const md5 = String(await hs.finish(this.record.size, { signal, onProgress })).toLowerCase()
      this.counters.streamHashes++
      return md5
    } catch (err) {
      if (signal?.aborted) {
        this.record.verify = { state: 'pending', expected, actual: null }
        this.#persist()
        throw abortError(signal)
      }
      this.counters.hashFallbacks++
      this.log('download: MD5 junto com a gravação falhou; conferindo o arquivo inteiro', err?.message)
      return null
    } finally {
      await hs.close() // o worker solta o temporário antes do rename (ou do rm, se não conferir)
    }
  }

  /**
   * 4.14: o arquivo final (nome e data definitivos) entra no cache de MD5, então o Comparar profundo não relê.
   * stat DEPOIS do utimes: o cache só vale para este tamanho e esta data.
   */
  async #rememberHash(md5) {
    const hasher = this.ctx.hasher
    if (!md5 || typeof hasher?.remember !== 'function') return
    try {
      const st = await fs.stat(this.record.dest.path)
      if (st.isFile() && st.size === this.record.size) await hasher.remember(this.record.dest.path, st.size, st.mtimeMs, md5)
    } catch (err) {
      this.log('download: não consegui guardar o MD5 no cache', err?.message)
    }
  }

  /** Renomeia o temporário para o nome final (sem sobrescrever nada que apareceu no caminho) e aplica a data do Drive. */
  async #place() {
    const rec = this.record
    let target = rec.dest.path
    try {
      if (!rec.dest.overwrite && (await exists(target))) {
        const dir = path.dirname(target)
        const names = await fs.readdir(dir)
        target = path.join(dir, uniqueName(path.basename(target), new Set(names)))
      }
      await renameWithRetry(rec.dest.tempPath, target)
    } catch (err) {
      throw diskError(err)
    }
    rec.dest.path = target
    const t = Date.parse(rec.source?.modifiedTime ?? '')
    if (Number.isFinite(t)) {
      await fs.utimes(target, new Date(t), new Date(t)).catch(err => this.log('download: não consegui ajustar a data', err?.message))
    }
    rec.updatedAt = Date.now()
    this.#persist()
  }

  // ─────────── casos especiais ───────────

  /** Arquivo de 0 byte: Range em arquivo vazio falha no Google, então cria sem nenhuma requisição. */
  async #runEmpty(signal) {
    const rec = this.record
    await this.#mkdirFor(rec.dest.tempPath)
    try {
      await fs.writeFile(rec.dest.tempPath, '')
    } catch (err) {
      throw diskError(err)
    }
    if (signal?.aborted) throw abortError(signal)
    rec.segments = []
    rec.bytesDone = 0
    const expected = rec.source.md5 ? String(rec.source.md5).toLowerCase() : null
    if (this.ctx.settings?.get?.().verifyChecksums && expected) {
      if (expected !== EMPTY_MD5) {
        await fs.rm(rec.dest.tempPath, { force: true }).catch(noop)
        rec.verify = { state: 'mismatch', expected, actual: EMPTY_MD5 }
        this.#persist()
        throw new SobeDesceError('fatal', 'O arquivo baixado veio diferente do original (MD5 não confere). Tente de novo.', { reason: 'checksumMismatch' })
      }
      rec.verify = { state: 'ok', expected, actual: EMPTY_MD5 }
    } else {
      rec.verify = { state: 'skipped', expected, actual: null }
    }
    await this.#place()
  }

  /** Doc nativo do Google: exportação numa conexão só, sem Range e sem checksum. Falhou? Recomeça do zero. */
  async #runExport(signal) {
    const rec = this.record
    const temp = rec.dest.tempPath
    const parent = signal ?? new AbortController().signal
    await this.#mkdirFor(temp)
    this.#resetRunState()
    const timer = setInterval(() => this.#tick(), this.opts.tickMs)
    timer.unref?.()
    let total = 0
    let fails = 0
    try {
      for (;;) {
        if (signal?.aborted) throw abortError(signal)
        this.exportBytes = 0
        const fh = await openFile(temp, 'w')
        this.fh = fh
        const conn = this.#openConn(parent)
        let err = null
        try {
          total = await this.#fetchExport(conn)
          await fh.datasync().catch(e => {
            throw diskError(e)
          })
        } catch (e) {
          err = e
        } finally {
          this.#closeConn(conn)
          this.fh = null
          await fh.close().catch(noop)
        }
        if (!err) break
        if (signal?.aborted) throw abortError(signal)
        if (conn.why === 'stall') err = stalledError()
        let info = classifyError(err)
        if (info.kind === 'abort') info = { kind: 'retry', retryAfterMs: null }
        if (info.kind !== 'retry' && info.kind !== 'auth') throw friendly(err)
        if (++fails > this.opts.maxFailures) throw exhaustedError(err)
        this.counters.failures++
        if (info.kind === 'auth') {
          this.badAuth = conn.auth
          continue
        }
        const wait = Math.min(this.opts.maxRetryWaitMs, Math.max(backoffDelay(fails - 1, { base: this.opts.retryBaseMs }), info.retryAfterMs ?? 0))
        await sleep(wait, signal)
      }
    } finally {
      clearInterval(timer)
    }
    rec.size = total
    rec.bytesDone = total
    rec.segments = []
    rec.verify = { state: 'skipped', expected: null, actual: null }
    await this.#place()
  }

  async #fetchExport(conn) {
    const rec = this.record
    const signal = conn.ac.signal
    const headers = await this.#headers(signal, conn)
    this.counters.requests++
    const res = await httpRequest(this.ctx.drive.exportUrl(rec.source.fileId, rec.source.export.mime), { headers, signal, expect: [200] })
    res.body.on('error', noop)
    conn.waitSince = Date.now()
    let at = 0
    conn.done = await this.#consume(conn, res.body, {
      write: async (buf, n) => {
        await this.#writeAt(buf, n, at)
        at += n
        this.exportBytes = at
      },
    })
    if (!conn.done) throw cutError()
    return at
  }
}
