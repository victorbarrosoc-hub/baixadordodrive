// Envio de UM arquivo para o Drive com sessão retomável (upload "resumable" do Google).
//
// Regras que protegem os dados (docs/GOOGLE-NOTES.md):
//  - A URI da sessão é gravada assim que nasce; depois de qualquer interrupção, o ponto de partida é SEMPRE
//    o que o Google diz no `Range` (consulta de status), nunca o que achamos que enviamos.
//  - Por padrão vai tudo numa requisição só (do ponto confirmado até o fim), como o Google recomenda.
//    Com `uploadChunkSize` > 0, pedaços múltiplos de 256 KiB (só o último pode ser menor).
//  - A URI da sessão é uma credencial: nunca vai para logs nem para a UI.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { Transform, pipeline } from 'node:stream'
import { httpRequest, drain, HttpError } from '../net/http.js'
import { classifyError, SobeDesceError, stalledError } from '../google/errors.js'
import { toDriveItem } from '../google/drive.js'
import { abortError, backoffDelay, isAbortError, sleep } from '../util/backoff.js'
import { SpeedMeter } from '../util/meter.js'
import { splitRel, toNFC, uniqueName } from '../util/paths.js'

const KiB = 1024
const MiB = 1024 * KiB
const CHUNK_ALIGN = 256 * KiB
// Depois de uma falha sem avanço, o próximo PUT é pequeno: se o Google recusar (ex.: 403 do limite diário),
// a resposta chega inteira. Com um corpo enorme ainda saindo, a recusa muitas vezes vira só "EPIPE".
const PROBE_SIZE = CHUNK_ALIGN
/** Maior arquivo que o Drive aceita (5 TB). */
export const MAX_UPLOAD_SIZE = 5 * 1024 ** 4
const SESSION_MAX_AGE_MS = 6 * 24 * 3600_000 // a URI vale 1 semana: com folga, abre outra
const MAX_FAILURES = 10 // falhas seguidas sem avanço antes de desistir
const USER_LIMIT_HITS = 5 // 403 userRateLimitExceeded seguidos sem avanço = limite de 750 GB/dia
const USER_LIMIT_HITS_INIT = 3 // ... ou isso ao abrir sessão
const QUOTA_RETRY_MS = 60 * 60_000
const MAX_RETRY_WAIT_MS = 120_000
const READ_HWM = 1 * MiB
const DEFAULT_STALL_MS = 30_000

const MSG = {
  missing: p => `O arquivo local não existe mais: ${p}`,
  noAccess: p => `Sem permissão para ler o arquivo: ${p}`,
  notFile: p => `Não é um arquivo comum: ${p}`,
  readError: (code, p) => `Não consegui ler o arquivo${code ? ` (${code})` : ''}: ${p}`,
  tooBig: 'Arquivo maior que o limite do Google Drive (5 TB).',
  changedDuring: 'O arquivo mudou enquanto era enviado. Envie de novo quando ele terminar de ser gravado.',
  sizeMismatch: 'O Drive recebeu um tamanho diferente do arquivo local. Envie de novo.',
  md5Mismatch: 'O arquivo chegou diferente no Drive (o MD5 não confere). Ele ficou lá; envie de novo para substituir.',
  folderGone: 'A pasta de destino não existe mais no Drive.',
  gaveUp: 'O envio falhou várias vezes seguidas sem avançar. Confira a internet e tente de novo.',
  badResponse: 'O Google respondeu de um jeito inesperado. Tentando de novo…',
  quota: 'Você atingiu o limite de upload do Google (750 GB por dia). Retomo sozinho mais tarde.',
  verifyLater: 'Não deu para conferir o arquivo agora. Tente de novo.',
}

const NOTE = {
  skipped: 'Já estava no Drive',
  replaced: 'Substituiu o arquivo que já estava no Drive (nova versão).',
  renamed: (from, to) => `Já existia "${from}" no Drive: enviado como "${to}".`,
  keptBoth: (from, to) => `Já existia um "${from}" diferente no Drive: enviado como "${to}".`,
  sessionLost: 'A sessão de envio expirou: recomecei do início.',
  localChanged: 'O arquivo mudou desde a última vez: recomecei do início.',
  replaceGone: 'O arquivo que seria substituído não existe mais no Drive: enviei como novo.',
  localGone: 'O arquivo local foi apagado durante o envio, mas o Drive recebeu tudo.',
}

// Tipo pelo nome (o Drive usa para ícone/prévia). Desconhecido = application/octet-stream.
const MIME_BY_EXT = {
  mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v', mxf: 'application/mxf', avi: 'video/x-msvideo',
  mkv: 'video/x-matroska', webm: 'video/webm', mts: 'video/mp2t', m2ts: 'video/mp2t', mpg: 'video/mpeg', mpeg: 'video/mpeg',
  wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', ogg: 'audio/ogg', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', webp: 'image/webp', psd: 'image/vnd.adobe.photoshop',
  pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain', srt: 'application/x-subrip', xml: 'application/xml',
  json: 'application/json',
}

export function mimeFor(name) {
  const m = /\.([^./\\]+)$/.exec(String(name ?? ''))
  return (m && MIME_BY_EXT[m[1].toLowerCase()]) || 'application/octet-stream'
}

/** Tamanho de pedaço válido para o Google (múltiplo de 256 KiB); 0 = contínuo. */
export function chunkLength(setting) {
  const n = Math.floor(Number(setting) || 0)
  if (n <= 0) return 0
  return Math.max(CHUNK_ALIGN, Math.floor(n / CHUNK_ALIGN) * CHUNK_ALIGN)
}

/** `Range: bytes=0-N` do 308 → próximo byte (N+1). Sem Range = nada gravado. undefined = resposta estranha. */
export function committedFromRange(header) {
  if (header == null || header === '') return 0
  const m = /^\s*bytes\s*=\s*0\s*-\s*(\d+)\s*$/i.exec(String(header))
  return m ? Number(m[1]) + 1 : undefined
}

// Erros "finais": já decididos aqui dentro, sobem sem nova classificação/tentativa.
const FINAL = Symbol('final')

function finalError(kind, message, opts = {}, cause) {
  const err = new SobeDesceError(kind, message, opts)
  if (cause) err.cause = cause
  err[FINAL] = true
  return err
}

function localError(err, filePath) {
  if (err?.[FINAL]) return err
  const code = err?.code || null
  if (code === 'ENOENT' || code === 'ENOTDIR') return finalError('fatal', MSG.missing(filePath), { reason: 'localMissing' }, err)
  if (code === 'EACCES' || code === 'EPERM') return finalError('fatal', MSG.noAccess(filePath), { reason: code }, err)
  if (code === 'EISDIR' || code === 'EINVAL') return finalError('fatal', MSG.notFile(filePath), { reason: code }, err)
  return finalError('fatal', MSG.readError(code, filePath), { reason: code || 'readError' }, err)
}

function badResponse(detail) {
  return new SobeDesceError('retry', MSG.badResponse, { reason: detail || 'badResponse' })
}

/** Espera `promise`, mas desiste (AbortError) se `signal` abortar. A promessa original segue sozinha. */
function abortable(promise, signal) {
  if (!signal) return promise
  promise.catch(() => {})
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      v => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      e => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

function sameStat(local, st) {
  if (local.size != null && local.size !== st.size) return false
  // Tolerância < 1 ms: o plano pode ter arredondado; o JSON guarda o double exato.
  if (local.mtimeMs != null && Math.abs(local.mtimeMs - st.mtimeMs) >= 1) return false
  return true
}

export class UploadTask extends EventEmitter {
  /**
   * @param {object} record TransferRecord (type 'upload'); é alterado no lugar.
   * @param {object} ctx TaskContext { drive, settings, limiter, hasher, folderCache, persist, onBytes, log }
   * @param {{ retryBaseMs?: number }} [opts] recuo base entre tentativas (os testes usam poucos ms).
   *   Também aceito em `ctx.retryBaseMs`.
   */
  constructor(record, ctx, { retryBaseMs } = {}) {
    super()
    this.record = record
    this.ctx = ctx
    this.retryBaseMs = retryBaseMs ?? ctx?.retryBaseMs ?? 1000
    this.meter = new SpeedMeter()
    this.running = false
    this.token = null // último token usado: no 401, renova só se ainda for ele
    this.forceRefresh = false
    this.phase = null
    this.hashP = null
    this.hashAc = null
  }

  speed() {
    return this.running ? this.meter.rate() : 0
  }

  /**
   * Resolve quando o arquivo está no Drive (target.fileId, bytesDone === size) ou foi pulado (status 'skipped').
   * Pausa (signal) => grava sessão/offset e rejeita com AbortError. Outros erros => rejeita com SobeDesceError.
   */
  async run(signal) {
    if (this.running) throw new Error('Este envio já está em andamento.')
    const sig = signal ?? new AbortController().signal
    this.running = true
    this.hashAc = new AbortController()
    const stopHash = () => this.hashAc.abort()
    sig.addEventListener('abort', stopHash, { once: true })
    try {
      if (sig.aborted) throw abortError(sig)
      await this.#run(sig)
    } catch (err) {
      this.#persist()
      if (sig.aborted) throw abortError(sig)
      if (isAbortError(err)) throw finalError('retry', 'O envio foi interrompido. Tente de novo.', { reason: 'interrupted' }, err)
      throw err
    } finally {
      sig.removeEventListener('abort', stopHash)
      this.hashAc.abort()
      this.hashP = null
      this.meter.reset()
      this.running = false
    }
  }

  // ─────────── fluxo principal ───────────

  async #run(signal) {
    const r = this.record
    if (!r.local?.path) throw finalError('fatal', 'Registro de envio sem arquivo local.', { reason: 'badRecord' })
    r.target ??= {}
    r.target.rootId ??= 'root'
    r.session ??= null
    r.attempts = 0
    this.userLimitHits = 0
    this.initLimitHits = 0
    this.parentRetried = false
    this.authStreak = 0
    this.probe = false // próximo PUT de dados pequeno (depois de um PUT de dados que falhou sem avanço)

    // 1. Arquivo local: sumiu → fatal; grande demais → fatal antes de qualquer requisição; mudou → recomeça.
    const st = await this.#statLocal()
    if (st.size > MAX_UPLOAD_SIZE) throw finalError('fatal', MSG.tooBig, { reason: 'fileSizeLimitExceeded' })
    if (!sameStat(r.local, st)) {
      this.#log('upload: o arquivo local mudou desde o plano; recomeçando do zero')
      if (r.session) r.note = NOTE.localChanged
      this.#dropSession()
      // Um envio anterior já criou o arquivo: o conteúdo novo vira nova versão dele (sem duplicar).
      if (r.target.fileId) {
        r.target.replaceFileId ??= r.target.fileId
        r.target.fileId = null
      }
      r.verify = null
      r.bytesDone = 0
    }
    r.local = { ...r.local, size: st.size, mtimeMs: st.mtimeMs }
    r.size = st.size
    this.size = st.size
    this.#persist()

    if (this.#settings().verifyChecksums) this.#startHash()
    await this.#transfer(signal)
  }

  async #transfer(signal) {
    const r = this.record
    let mustQuery = false
    let conflictDone = false
    if (r.session) {
      if (!r.session.uri || !(Date.now() - (r.session.createdAt ?? 0) < SESSION_MAX_AGE_MS)) {
        // Perto de 1 semana a URI expira: melhor abrir outra do que arriscar no meio do envio.
        this.#dropSession()
        r.note = NOTE.sessionLost
      } else {
        mustQuery = true
      }
    }

    for (;;) {
      if (signal.aborted) throw abortError(signal)
      try {
        // 2. Pasta de destino (compartilhada entre tarefas pelo folderCache).
        if (!r.target.parentId) {
          this.phase = 'folder'
          r.target.parentId = await this.ctx.drive.ensureFolderPath(r.target.rootId, r.target.relDir || '', {
            cache: this.#folderCache(),
            signal,
            driveId: r.target.driveId,
          })
          this.#persist()
        }
        // 3. Conflito com arquivo de mesmo nome (só antes de existir sessão).
        if (!conflictDone && !r.session && !r.target.replaceFileId) {
          this.phase = 'conflict'
          if (await this.#resolveConflict(signal)) return
          conflictDone = true
        }
        // 4. Sessão.
        if (!r.session) {
          await this.#openSession(signal)
          mustQuery = false
        }
        // 5. Consulta de status (retomada, depois de erro, arquivo vazio ou tudo já confirmado).
        if (mustQuery || this.size === 0 || r.session.offset >= this.size) {
          mustQuery = false
          const res = await this.#queryStatus(signal)
          if (res.done) return await this.#finish(res.json, signal)
          const progressed = this.#commit(res.offset)
          // Google confirmou tudo mas não fechou o arquivo: pergunta de novo com recuo.
          if (!progressed && res.offset >= this.size) {
            mustQuery = true
            await this.#failure({ kind: 'retry', reason: 'incomplete', message: MSG.badResponse }, signal)
          }
          continue
        }
        // 6. Envio do ponto confirmado em diante.
        const res = await this.#sendData(signal)
        if (res.done) return await this.#finish(res.json, signal)
        if (!this.#commit(res.offset)) {
          this.probe = true
          await this.#failure({ kind: 'retry', reason: 'noProgress', message: MSG.badResponse }, signal)
        }
      } catch (err) {
        if (signal.aborted) throw abortError(signal)
        await this.#onError(err, signal)
        if (r.session) mustQuery = true
      }
    }
  }

  /** Decide o que fazer com um erro: tenta de novo (retorna) ou desiste (lança). */
  async #onError(err, signal) {
    if (err?.[FINAL]) throw err
    const r = this.record
    let info = classifyError(err)
    // Abort sem pausa pedida = algo derrubou a requisição por dentro: trata como queda de conexão.
    if (info.kind === 'abort') info = { kind: 'retry', reason: 'network', message: 'A conexão caiu. Reconectando…', retryAfterMs: null, status: null }
    const http = err instanceof HttpError
    const phase = this.phase
    if (info.kind !== 'auth') this.authStreak = 0
    if (phase === 'data') this.probe = true

    // 400 num PUT de dados: o offset pode ter ficado para trás (o Google recusa) → consulta e continua.
    if (http && phase === 'data' && err.status === 400) info = { ...info, kind: 'retry' }

    if (info.kind === 'retry') {
      if (info.reason === 'userRateLimitExceeded') {
        // 750 GB/dia chega igual a um limite de taxa comum: só a insistência sem avanço denuncia.
        const hits = phase === 'init' ? ++this.initLimitHits : ++this.userLimitHits
        if (hits >= (phase === 'init' ? USER_LIMIT_HITS_INIT : USER_LIMIT_HITS)) {
          throw finalError('quota', MSG.quota, { reason: 'uploadLimitExceeded', retryAfterMs: QUOTA_RETRY_MS, status: 403 }, err)
        }
      }
      this.#log(`upload: ${info.reason || 'erro'} na etapa ${phase} (${err?.code || err?.status || err?.name}: ${err?.message}); tentando de novo`)
      await this.#failure(info, signal, { cause: err })
      return
    }

    if (info.kind === 'auth') {
      // Token vencido: renova (uma renovação só, mesmo com vários envios recebendo 401 juntos) e repete já.
      this.forceRefresh = true
      await this.#failure(info, signal, { cause: err, wait: this.authStreak++ > 0 })
      return
    }

    if (info.kind === 'notfound' && http) {
      if (phase === 'status' || phase === 'data') {
        // Sessão morreu (expirou ou o Google a descartou): começa outra do zero.
        this.#log('upload: sessão não existe mais; abrindo outra do zero')
        this.#dropSession()
        r.note = NOTE.sessionLost
        await this.#failure(info, signal, { cause: err, wait: false })
        return
      }
      if (phase === 'init' && r.target.replaceFileId) {
        r.target.replaceFileId = null
        r.note = NOTE.replaceGone
        this.#persist()
        await this.#failure(info, signal, { cause: err, wait: false })
        return
      }
      if ((phase === 'init' || phase === 'conflict') && !this.parentRetried) {
        // A pasta (talvez do cache) foi apagada: procura/cria de novo uma vez.
        this.parentRetried = true
        await this.#forgetParent(signal)
        await this.#failure(info, signal, { cause: err, wait: false })
        return
      }
      if (phase === 'init' || phase === 'conflict' || phase === 'folder') {
        throw finalError('notfound', MSG.folderGone, { reason: info.reason || 'parentNotFound', status: info.status }, err)
      }
    }

    if (err instanceof SobeDesceError) {
      err[FINAL] = true
      throw err
    }
    throw finalError(info.kind, info.message, { reason: info.reason, retryAfterMs: info.retryAfterMs, status: info.status }, err)
  }

  /** Conta uma falha sem avanço; desiste depois de MAX_FAILURES seguidas. */
  async #failure(info, signal, { cause, wait = true } = {}) {
    const r = this.record
    r.attempts = (r.attempts || 0) + 1
    if (r.attempts > MAX_FAILURES) {
      throw finalError('retry', MSG.gaveUp, { reason: info.reason || null, status: info.status ?? null }, cause)
    }
    if (!wait) return
    const delay = Math.min(MAX_RETRY_WAIT_MS, Math.max(backoffDelay(r.attempts - 1, { base: this.retryBaseMs }), info.retryAfterMs ?? 0))
    await sleep(delay, signal)
  }

  // ─────────── passos ───────────

  async #statLocal() {
    const p = this.record.local.path
    let st
    try {
      st = await fsp.stat(p)
    } catch (err) {
      throw localError(err, p)
    }
    if (!st.isFile()) throw finalError('fatal', MSG.notFile(p), { reason: 'notAFile' })
    return st
  }

  /** Antes de cada envio: se o arquivo mudou no meio do caminho, o Drive receberia uma mistura. */
  async #ensureUnchanged() {
    const st = await this.#statLocal()
    if (!sameStat(this.record.local, st)) throw finalError('fatal', MSG.changedDuring, { reason: 'localChanged' })
  }

  /** true = pulado (já estava no Drive). Pode trocar o nome (rename) ou marcar substituição (replace). */
  async #resolveConflict(signal) {
    const r = this.record
    const drive = this.ctx.drive
    const name = toNFC(r.name)
    const existing = await drive.findChild(r.target.parentId, name, { folder: false, signal, driveId: r.target.driveId })
    if (!existing) return false
    const mode = this.#settings().uploadConflict || 'skip'
    const binary = existing.size != null && !existing.isShortcut && !existing.isGoogleDoc
    if (mode === 'replace' && binary) {
      r.target.replaceFileId = existing.id
      r.note = NOTE.replaced
      this.#persist()
      return false
    }
    if (mode === 'skip' && binary && existing.size === this.size) {
      // Mesmo tamanho: igual se o MD5 bate (ou se o Drive não tem MD5 para comparar).
      let same = true
      if (existing.md5) {
        const local = await this.#localMd5(signal)
        same = local === existing.md5
        // Diferente: não é o mesmo arquivo, a conferência de verdade fica para o fim do envio.
        r.verify = same ? { state: 'ok', expected: local, actual: existing.md5 } : { state: 'pending', expected: null, actual: null }
      } else {
        r.verify = { state: 'skipped', expected: null, actual: null }
      }
      if (same) {
        r.status = 'skipped'
        r.note = NOTE.skipped
        r.target.fileId = existing.id
        this.#persist()
        return true
      }
    }
    // 'rename', ou 'skip' com conteúdo diferente (mantém os dois sem nomes repetidos no Drive).
    const siblings = await drive.listChildren(r.target.parentId, { signal })
    const taken = new Set(siblings.map(it => toNFC(it.name)))
    taken.add(name)
    const newName = uniqueName(name, taken)
    r.name = newName
    r.note = mode === 'rename' ? NOTE.renamed(name, newName) : NOTE.keptBoth(name, newName)
    this.#persist()
    return false
  }

  async #openSession(signal) {
    const r = this.record
    const drive = this.ctx.drive
    this.phase = 'init'
    const replaceId = r.target.replaceFileId
    const url = replaceId ? drive.uploadUpdateUrl(replaceId) : drive.uploadInitUrl()
    const meta = {}
    if (!replaceId) {
      meta.name = toNFC(r.name)
      meta.parents = [r.target.parentId]
    }
    if (Number.isFinite(r.local.mtimeMs)) meta.modifiedTime = new Date(r.local.mtimeMs).toISOString()
    // Marcas do app (a prévia leve leva { sobedesce: 'previa', original }): vão junto na criação, sem chamada extra.
    if (r.target.appProperties && typeof r.target.appProperties === 'object') meta.appProperties = { ...r.target.appProperties }
    const headers = {
      ...(await this.#authHeader(signal)),
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': mimeFor(r.name),
      'x-upload-content-length': String(this.size),
    }
    const location = await this.#request(url, { method: replaceId ? 'PATCH' : 'POST', headers, body: JSON.stringify(meta), expect: [200, 201] }, signal, {
      read: async res => {
        await drain(res.body)
        return res.headers.location
      },
    })
    if (!location || typeof location !== 'string') throw badResponse('noLocation')
    r.session = { uri: location, createdAt: Date.now(), offset: 0 }
    r.bytesDone = 0
    this.initLimitHits = 0
    this.userLimitHits = 0
    // Gravada NA HORA: sem ela, uma queda agora perderia a sessão (e o que for enviado nela).
    this.#persist()
  }

  async #queryStatus(signal) {
    this.phase = 'status'
    const headers = {
      ...(await this.#authHeader(signal)),
      'content-length': '0',
      'content-range': `bytes */${this.size}`,
    }
    return this.#request(this.record.session.uri, { method: 'PUT', headers, expect: [200, 201, 308] }, signal, {
      read: res => this.#readPutResponse(res),
    })
  }

  async #sendData(signal) {
    const r = this.record
    this.phase = 'data'
    await this.#ensureUnchanged()
    const start = r.session.offset
    let chunk = chunkLength(this.#settings().uploadChunkSize)
    if (this.probe) chunk = chunk > 0 ? Math.min(chunk, PROBE_SIZE) : PROBE_SIZE
    const end = (chunk > 0 ? Math.min(this.size, start + chunk) : this.size) - 1
    const headers = {
      ...(await this.#authHeader(signal)),
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${this.size}`,
    }
    return this.#request(r.session.uri, { method: 'PUT', headers, expect: [200, 201, 308] }, signal, {
      body: io => this.#dataBody(start, end, io),
      read: res => this.#readPutResponse(res),
    })
  }

  /** 308 → { offset } (do Range do Google); 200/201 → { done, json }. */
  async #readPutResponse(res) {
    if (res.status === 308) {
      const range = res.headers.range
      const location = res.headers.location
      await drain(res.body)
      const offset = committedFromRange(Array.isArray(range) ? range[0] : range)
      if (offset === undefined || offset > this.size) throw badResponse('badRange')
      if (typeof location === 'string' && location && location !== this.record.session.uri) {
        this.record.session.uri = location
        this.#persist()
      }
      return { done: false, offset }
    }
    const text = await res.body.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw badResponse('badJson')
    }
    if (!json || typeof json !== 'object' || !json.id) throw badResponse('noFileId')
    return { done: true, json }
  }

  /** Corpo do PUT: arquivo → limitador de banda + contagem + detector de travamento. */
  #dataBody(start, end, { signal, hold }) {
    const filePath = this.record.local.path
    const limiter = this.ctx.limiter
    const expected = end - start + 1
    let sent = 0
    let fileError = null
    const file = fs.createReadStream(filePath, { start, end, highWaterMark: READ_HWM })
    file.on('error', err => {
      fileError ??= err
    })
    const task = this
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        hold(true) // esperar o limitador não é travamento
        const wait = limiter?.take ? limiter.take(chunk.length, signal) : Promise.resolve()
        wait.then(
          () => {
            hold(false)
            sent += chunk.length
            task.#onSent(chunk.length, start + sent)
            cb(null, chunk)
          },
          err => {
            hold(false)
            cb(err)
          },
        )
      },
      flush(cb) {
        // Arquivo encolheu no meio da leitura: nunca completar com bytes errados.
        if (sent !== expected) {
          fileError ??= finalError('fatal', MSG.changedDuring, { reason: 'localChanged' })
          return cb(fileError)
        }
        cb()
      },
    })
    const stream = pipeline(file, meter, () => {})
    return {
      stream,
      error: () => fileError,
      destroy: () => {
        file.destroy()
        meter.destroy()
      },
    }
  }

  #onSent(n, pos) {
    this.meter.add(n)
    // Progresso ao vivo (enviado); o Range do Google corrige a cada 308/consulta.
    this.record.bytesDone = Math.min(this.size, pos)
    try {
      this.ctx.onBytes?.(n)
    } catch {
      // contagem é só informativa
    }
  }

  /**
   * Requisição com detector de travamento: sem bytes saindo nem resposta por stallTimeoutMs → aborta (STALLED).
   * `body(io)` cria o corpo em stream; `read(res)` consome a resposta (dentro do mesmo detector/abort).
   */
  async #request(url, opts, signal, { body: makeBody, read } = {}) {
    if (signal.aborted) throw abortError(signal)
    const ac = new AbortController()
    const onAbort = () => ac.abort(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    let last = Date.now()
    let holding = false
    let stalled = false
    const hold = on => {
      holding = on
      last = Date.now()
    }
    const stallMs = () => Math.max(100, Number(this.#settings().stallTimeoutMs) || DEFAULT_STALL_MS)
    const timer = setInterval(() => {
      if (holding || stalled) return
      if (Date.now() - last > stallMs()) {
        stalled = true
        ac.abort(stalledError())
      }
    }, Math.max(50, Math.min(1000, Math.floor(stallMs() / 4))))
    timer.unref?.()
    let src = null
    try {
      if (makeBody) src = makeBody({ signal: ac.signal, hold })
      const res = await httpRequest(url, { ...opts, body: src ? src.stream : opts.body, signal: ac.signal })
      last = Date.now()
      return read ? await read(res) : await drain(res.body)
    } catch (err) {
      if (signal.aborted) throw abortError(signal)
      const local = src?.error()
      if (local) throw localError(local, this.record.local.path)
      if (stalled) {
        this.#log('upload: conexão travada; reconectando')
        throw stalledError()
      }
      throw err
    } finally {
      clearInterval(timer)
      signal.removeEventListener('abort', onAbort)
      src?.destroy()
    }
  }

  /** Fim: confere tamanho, arquivo local inalterado e MD5. */
  async #finish(json, signal) {
    const r = this.record
    this.phase = 'verify'
    const item = toDriveItem(json)
    r.target.fileId = item.id
    r.bytesDone = this.size
    if (r.session) r.session.offset = this.size
    r.attempts = 0
    this.#persist()

    const reject = (message, reason) => {
      // O arquivo fica no Drive; tentar de novo troca o conteúdo dele (nova versão) em vez de duplicar.
      r.session = null
      r.target.replaceFileId = item.id
      r.target.fileId = null
      this.#persist()
      return finalError('fatal', message, { reason })
    }
    if (item.size != null && item.size !== this.size) throw reject(MSG.sizeMismatch, 'sizeMismatch')
    let st = null
    try {
      st = await this.#statLocal()
    } catch (err) {
      // Apagado com o envio já lido por inteiro: o descritor aberto leu o conteúdo original, o Drive está certo.
      if (err?.reason !== 'localMissing') throw err
      r.note = NOTE.localGone
    }
    if (st && !sameStat(r.local, st)) throw reject(MSG.changedDuring, 'localChanged')

    if (this.hashP || this.#settings().verifyChecksums) {
      this.#startHash()
      const prevStatus = r.status
      r.status = 'verifying'
      r.verify = { state: 'running', expected: null, actual: item.md5 }
      let local = null
      try {
        local = await this.#localMd5(signal)
      } catch (err) {
        if (signal.aborted) throw abortError(signal)
        // Calculadora fechada sem pausa pedida (app encerrando): a sessão fica, e a conferência acontece na retomada.
        if (isAbortError(err)) throw finalError('retry', MSG.verifyLater, { reason: 'verifyInterrupted' }, err)
        // Não deu para ler de novo (ex.: apagado depois de enviado): o envio vale, a conferência não.
        this.#log('upload: não consegui conferir o MD5:', err?.message)
      }
      r.verify = { state: !local || !item.md5 ? 'skipped' : local === item.md5 ? 'ok' : 'mismatch', expected: local, actual: item.md5 }
      if (r.status === 'verifying') r.status = prevStatus
      if (r.verify.state === 'mismatch') throw reject(MSG.md5Mismatch, 'checksumMismatch')
    }
    r.session = null // a URI é credencial: depois de terminar, não precisa ficar guardada
    r.bytesDone = this.size
    this.#persist()
  }

  // ─────────── apoio ───────────

  #commit(offset) {
    const r = this.record
    const s = r.session
    const progressed = offset > (s.offset ?? 0)
    s.offset = offset
    r.bytesDone = offset
    if (progressed) {
      r.attempts = 0
      this.userLimitHits = 0
      this.authStreak = 0
      this.probe = false
    }
    this.#persist()
    return progressed
  }

  #dropSession() {
    const r = this.record
    r.session = null
    r.bytesDone = 0
  }

  async #forgetParent(signal) {
    const r = this.record
    const stale = r.target.parentId
    r.target.parentId = null
    this.#persist()
    const parts = splitRel(toNFC(r.target.relDir || ''))
    const cache = this.#folderCache()
    if (!cache || !parts.length) return
    const key = `${r.target.rootId}/${parts.join('/')}`
    const p = cache.get(key)
    if (!p) return
    const id = await abortable(Promise.resolve(p), signal).catch(err => {
      if (signal.aborted) throw err
      return null
    })
    // Só tira do cache se ainda aponta para a pasta que sumiu (outra tarefa pode já ter recriado).
    if (id === stale && cache.get(key) === p) cache.delete(key)
  }

  #folderCache() {
    return this.ctx.folderCache ?? this.ctx.drive?.folderCache
  }

  #startHash() {
    if (this.hashP || !this.ctx.hasher || this.hashAc?.signal.aborted) return
    const r = this.record
    this.hashP = this.ctx.hasher.hash(r.local.path, { signal: this.hashAc.signal })
    this.hashP.catch(() => {}) // quem espera trata; aqui só evita rejeição sem dono
    r.verify = { state: 'pending', expected: null, actual: null }
  }

  async #localMd5(signal) {
    this.#startHash()
    if (!this.hashP) throw new Error('Sem calculadora de MD5.')
    try {
      return await abortable(this.hashP, signal)
    } catch (err) {
      if (isAbortError(err) || signal.aborted) throw err
      throw localError(err, this.record.local.path)
    }
  }

  async #authHeader(signal) {
    const drive = this.ctx.drive
    let header
    if (this.forceRefresh && drive.auth?.getAccessToken) {
      const token = await abortable(drive.auth.getAccessToken(drive.accountId, { forceRefresh: true, rejectedToken: this.token }), signal)
      header = { authorization: `Bearer ${token}` }
    } else {
      header = await abortable(drive.authHeader(this.forceRefresh ? { forceRefresh: true } : undefined), signal)
    }
    this.forceRefresh = false
    this.token = String(header.authorization || '').replace(/^Bearer\s+/i, '') || null
    return header
  }

  #settings() {
    return this.ctx.settings?.get?.() ?? {}
  }

  #persist() {
    try {
      this.record.updatedAt = Date.now()
      this.ctx.persist?.()
    } catch (err) {
      this.#log('upload: não consegui pedir gravação:', err?.message)
    }
  }

  #log(...args) {
    try {
      this.ctx.log?.(...args)
    } catch {
      // log nunca derruba o envio
    }
  }
}
