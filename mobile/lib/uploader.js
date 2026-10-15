// Motor de envio no navegador: upload retomável do Google Drive, direto do aparelho para o Google.
//
// Por arquivo: abre uma sessão retomável (POST …/upload/drive/v3/files?uploadType=resumable → Location) e manda
// pedaços com PUT + Content-Range. Blob.slice é preguiçoso: só o pedaço da vez é lido do disco.
//  - 308 + Range "bytes=0-N" → o próximo byte é N+1. Sem Range → nada gravado (0).
//  - 200/201 → pronto (conferimos o tamanho que o Drive diz ter recebido).
//  - Queda de rede, 5xx, 429, 403 de limite → recuo exponencial com jitter (até 64 s), pergunta o status e segue.
//  - 404/410 na sessão → sessão morreu: abre outra e recomeça do zero.
//  - 401 → renova o token e repete.
// A URI da sessão é uma credencial (vale ~1 semana): fica no IndexedDB para retomar depois de recarregar a página,
// mas nunca vai para o console nem para a tela.
//
// Os PUTs na sessão vão SEM Authorization: a URI da sessão já autoriza (docs do Drive e o mock fiel a eles).
// Assim um token que vence no meio de um arquivo grande não para o envio — e no iPhone, onde renovar pode
// exigir um toque, só os passos que precisam mesmo de token (conferir destino, abrir sessão) esperam.
// Se mesmo assim o Google responder 401 num PUT, passamos a mandar o token naquela sessão.
import { getSettings, local } from './config.js'
import * as auth from './auth.js'
import { DriveError, backoffMs, createUploadSession, driveErrorFrom, findByName, isRetryable, sleep } from './drive.js'
import { allRecords, deleteRecord, getRecord, putRecord, sessionKey } from './idb.js'
import { keepAwake } from './wakelock.js'
import { bytes } from './format.js'

const MiB = 1024 * 1024
const SESSION_MAX_AGE = 6 * 24 * 3600 * 1000 // o Google guarda 7 dias; folga de 1
const STALL_MS = 45_000 // sem progresso por tanto tempo = conexão travada
const MAX_FAILURES = 10 // falhas seguidas antes de desistir (com recuo até 64 s, dá vários minutos)
const MAX_RESTARTS = 3
const CAP_HITS = 4 // 403 userRateLimitExceeded seguidos = limite diário de 750 GB
const RANGE_SEEN_KEY = 'sobedesce.rangeVisible'

export const ACTIVE = new Set(['queued', 'preparing', 'running', 'paused'])
const FINISHED = new Set(['done', 'skipped'])

const MSG = {
  network: 'A conexão caiu várias vezes seguidas. Confira a internet e toque em Tentar de novo — continua de onde parou.',
  quota: 'Seu Drive está cheio. Libere espaço e toque em Tentar de novo.',
  cap: 'O Google limita cada conta a 750 GB de envio por dia e esse limite chegou. Libera em até 24 horas; o que já subiu fica guardado.',
  restarts: 'O Google encerrou este envio várias vezes. Toque em Tentar de novo.',
}

class Aborted extends Error {
  constructor(reason) {
    super(reason)
    this.aborted = true
  }
}

class UploadError extends Error {
  constructor(message, { cap = false } = {}) {
    super(message)
    this.cap = cap
  }
}

// ───── Range ─────
//
// O Google lista Range em Access-Control-Expose-Headers (a amostra oficial de upload por CORS lê esse header),
// então normalmente dá para ler. Mas se algum dia o navegador não puder ler, getResponseHeader devolve null —
// igual a "nada gravado". Decisão:
//  1. Range legível → usa.
//  2. Range ausente depois de um PUT de dados → tratamos como DESCONHECIDO e fazemos uma consulta de status.
//  3. Ainda ausente: se este navegador já nos mostrou Range alguma vez (rangeVisible), a ausência é real e o
//     próximo byte é 0, como o Google documenta. Se nunca mostrou (header escondido), usamos o fim do pedaço —
//     e SÓ quando aquele PUT terminou com 308 (o Google confirmou que recebeu o corpo inteiro). Fora disso
//     (consulta depois de queda), voltamos ao último fim de pedaço confirmado assim (session.acked).
//  4. Se a suposição do item 3 estiver errada, o próximo PUT começa depois do que o Google tem e ele responde
//     400; sem Range legível não há como saber o ponto certo, então recomeçamos o arquivo numa sessão nova.
//     Mais lento, nunca corrompe.
let rangeVisible = Boolean(local.get(RANGE_SEEN_KEY))

function markRangeSeen() {
  if (!rangeVisible) {
    rangeVisible = true
    local.set(RANGE_SEEN_KEY, true)
  }
}

function parseRange(header) {
  const m = /bytes\s*=\s*(\d+)\s*-\s*(\d+)/i.exec(header || '')
  return m ? Number(m[2]) + 1 : 0
}

function parseJson(text) {
  try {
    return JSON.parse(text || 'null')
  } catch {
    return null
  }
}

function safeHeader(xhr, name) {
  try {
    return xhr.getResponseHeader(name)
  } catch {
    return null
  }
}

function messageFor(err) {
  if (!err) return 'Algo deu errado. Toque em Tentar de novo.'
  if (err instanceof UploadError) return err.message
  const r = err.reason
  if (r === 'storageQuotaExceeded') return MSG.quota
  if (r === 'userRateLimitExceeded') return MSG.cap
  if (r === 'teamDriveFileLimitExceeded') return 'Este drive compartilhado chegou ao limite de arquivos do Google.'
  if (r === 'numChildrenInNonRootLimitExceeded') return 'Esta pasta chegou ao limite de itens do Google. Escolha outra pasta.'
  if (r === 'insufficientFilePermissions' || r === 'forbidden' || r === 'insufficientPermissions')
    return 'Sua conta não tem permissão para enviar para esta pasta.'
  if (err.status === 404) return 'A pasta de destino não existe mais (ou você perdeu o acesso a ela).'
  if (err.status === 0) return MSG.network
  if (err.signedOut) return 'Você saiu da conta. Entre de novo para continuar.'
  return `O Google recusou o envio (${err.status || 'erro'}${r ? ` · ${r}` : ''}). Toque em Tentar de novo.`
}

let seq = 0

class Engine {
  constructor() {
    this.items = []
    this.running = new Set()
    this.notice = null // { kind: 'cap', text }
    this.account = null
    this.version = 0
    this._listeners = new Set()
    this._emitTimer = 0
    this._ticker = 0
    this._tickN = 0
    this._hiddenAt = 0
    this._restoredFor = undefined
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => this._onVisibility())
      window.addEventListener('beforeunload', (e) => {
        if (this.running.size) {
          e.preventDefault()
          e.returnValue = ''
        }
      })
    }
  }

  // ───── assinatura (a UI redesenha no máximo ~5×/s) ─────

  subscribe(fn) {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  changed(now = false) {
    if (now) {
      clearTimeout(this._emitTimer)
      this._emitTimer = 0
      this._emit()
      return
    }
    if (this._emitTimer) return
    this._emitTimer = setTimeout(() => {
      this._emitTimer = 0
      this._emit()
    }, 200)
  }

  _emit() {
    this.version++
    for (const fn of this._listeners) fn(this.version)
  }

  // ───── entrada ─────

  setAccount(email) {
    this.account = email || null
  }

  /** Sessões guardadas no aparelho viram itens "Pausado — escolha o arquivo de novo". */
  async restore() {
    if (this._restoredFor === this.account) return
    this._restoredFor = this.account
    const records = await allRecords()
    const now = Date.now()
    for (const rec of records) {
      if (!rec?.key) continue
      if (now - rec.createdAt > SESSION_MAX_AGE) {
        deleteRecord(rec.key)
        continue
      }
      if (rec.account && this.account && rec.account !== this.account) continue
      if (this.items.some((it) => it.key === rec.key)) continue
      this.items.push({
        ...this._blank(),
        name: rec.name,
        size: rec.size,
        lastModified: rec.lastModified,
        type: rec.type || '',
        folder: rec.folder,
        key: rec.key,
        status: 'needsFile',
        offset: Math.min(rec.acked || 0, rec.size),
        addedAt: rec.createdAt,
      })
    }
    this.changed(true)
  }

  _blank() {
    return {
      id: ++seq,
      file: null,
      name: '',
      size: 0,
      lastModified: 0,
      type: '',
      folder: null,
      key: '',
      status: 'queued',
      offset: 0,
      inflight: 0,
      speed: 0,
      note: '',
      error: null,
      fileId: null,
      forceCopy: false,
      addedAt: Date.now(),
      finishedAt: 0,
      lastProgressAt: 0,
      ctl: null,
      _lastBytes: 0,
      _lastAt: 0,
    }
  }

  /** Arquivos escolhidos: retoma os pausados que batem (nome, tamanho, data) e enfileira os novos. */
  addFiles(files, folder) {
    let added = 0
    let resumed = 0
    let dupes = 0
    for (const file of files) {
      const waiting = this.items.find(
        (it) => it.status === 'needsFile' && it.name === file.name && it.size === file.size && it.lastModified === file.lastModified,
      )
      if (waiting) {
        waiting.file = file
        waiting.type = file.type || waiting.type
        waiting.status = 'queued'
        resumed++
        continue
      }
      const key = sessionKey(file, folder.id)
      if (this.items.some((it) => it.key === key && ACTIVE.has(it.status))) {
        dupes++
        continue
      }
      this.items.push({
        ...this._blank(),
        file,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        type: file.type || '',
        folder,
        key,
      })
      added++
    }
    this.notice = null
    this.pump()
    this.changed(true)
    return { added, resumed, dupes }
  }

  // ───── controle ─────

  pump() {
    const { concurrency } = getSettings()
    for (const it of this.items) {
      if (this.running.size >= concurrency) break
      if (it.status === 'queued' && it.file) this._start(it)
    }
    this._activity()
  }

  pause(it) {
    if (it.status === 'queued') it.status = 'paused'
    else if (it.ctl) {
      this._abort(it, 'pause')
      it.status = 'paused'
      it.note = ''
    }
    this._activity()
    this.changed(true)
  }

  resume(it) {
    if (it.status !== 'paused') return
    it.status = 'queued'
    it.note = ''
    this.pump()
    this.changed(true)
  }

  pauseAll() {
    for (const it of this.items) if (it.status === 'queued' || it.status === 'preparing' || it.status === 'running') this.pause(it)
  }

  resumeAll() {
    this.notice = null
    for (const it of this.items) if (it.status === 'paused') it.status = 'queued'
    this.pump()
    this.changed(true)
  }

  retry(it) {
    if (it.status !== 'failed') return
    it.status = 'queued'
    it.error = null
    this.notice = null
    this.pump()
    this.changed(true)
  }

  /** "Enviar mesmo assim": sobe outra cópia com o mesmo nome. */
  sendAnyway(it) {
    if (it.status !== 'skipped') return
    it.forceCopy = true
    it.fileId = null
    it.offset = 0
    it.status = 'queued'
    this.pump()
    this.changed(true)
  }

  remove(it) {
    if (it.ctl) this._abort(it, 'remove')
    this.items = this.items.filter((x) => x !== it)
    if (!FINISHED.has(it.status)) {
      // Cancela a sessão no Google (cortesia) e esquece a retomada.
      getRecord(it.key).then((rec) => {
        if (rec?.uri) fetch(rec.uri, { method: 'DELETE' }).catch(() => {})
        deleteRecord(it.key)
      })
    }
    this._activity()
    this.changed(true)
  }

  clearFinished() {
    this.items = this.items.filter((it) => !FINISHED.has(it.status))
    this.changed(true)
  }

  hasWork() {
    return this.items.some((it) => it.status === 'queued' || it.status === 'preparing' || it.status === 'running')
  }

  _abort(it, reason) {
    const ctl = it.ctl
    if (!ctl) return
    ctl.aborted = reason
    ctl.abortCtl.abort()
    ctl.xhr?.abort()
  }

  _check(ctl) {
    if (ctl.aborted) throw new Aborted(ctl.aborted)
  }

  // ───── atividade: tela acesa, velocidade, token ─────

  _activity() {
    const busy = this.running.size > 0
    keepAwake(busy || this.items.some((it) => it.status === 'queued' && it.file))
    if (busy && !this._ticker) {
      this._ticker = setInterval(() => this._tick(), 500)
    } else if (!busy && this._ticker) {
      clearInterval(this._ticker)
      this._ticker = 0
    }
  }

  _tick() {
    const now = performance.now()
    for (const it of this.running) {
      const done = it.offset + it.inflight
      if (!it._lastAt) {
        it._lastAt = now
        it._lastBytes = done
        continue
      }
      const dt = (now - it._lastAt) / 1000
      if (dt < 0.4) continue
      const delta = Math.max(0, done - it._lastBytes)
      const inst = delta / dt
      it.speed = it.speed ? it.speed * 0.7 + inst * 0.3 : inst
      it._lastAt = now
      it._lastBytes = done
    }
    if (++this._tickN % 60 === 0) auth.ensureFresh()
    this.changed()
  }

  _onVisibility() {
    if (document.visibilityState === 'hidden') {
      this._hiddenAt = Date.now()
      return
    }
    const away = this._hiddenAt ? Date.now() - this._hiddenAt : 0
    this._hiddenAt = 0
    if (!this.running.size) return
    auth.ensureFresh()
    // O iOS corta a rede de páginas em segundo plano: uma requisição pode ter morrido sem avisar. Depois de um
    // instante visível, quem não deu sinal de vida é refeito (consulta de status e segue de onde o Google parou).
    setTimeout(() => {
      for (const it of this.running) {
        const ctl = it.ctl
        if (ctl?.xhr && away > 1000 && Date.now() - it.lastProgressAt > 2500) {
          ctl.resync = true
          ctl.xhr.abort()
        }
      }
    }, 1500)
  }

  // ───── um arquivo ─────

  _start(it) {
    it.status = 'preparing'
    it.error = null
    it.note = ''
    it.speed = 0
    it._lastAt = 0
    const ctl = { aborted: null, xhr: null, resync: false, abortCtl: new AbortController() }
    ctl.signal = ctl.abortCtl.signal
    it.ctl = ctl
    this.running.add(it)
    this._run(it, ctl)
      .catch((err) => {
        if (ctl.aborted) return
        if (err?.signedOut) {
          it.status = 'paused'
          it.note = ''
          return
        }
        this._fail(it, err)
      })
      .finally(() => {
        if (it.ctl === ctl) it.ctl = null
        it.inflight = 0
        it.speed = 0
        this.running.delete(it)
        this.pump()
        this.changed(true)
      })
    this.changed(true)
  }

  _fail(it, err) {
    it.status = 'failed'
    it.note = ''
    it.error = messageFor(err)
    if (err?.cap || err?.reason === 'userRateLimitExceeded') {
      // Limite diário: os outros também vão bater nele. Pausa a fila e avisa uma vez.
      this.notice = { kind: 'cap', text: MSG.cap }
      for (const other of this.items) if (other.status === 'queued') other.status = 'paused'
    }
  }

  async _run(it, ctl) {
    let rec = await getRecord(it.key)
    if (rec && (Date.now() - rec.createdAt > SESSION_MAX_AGE || rec.size !== it.size)) {
      await deleteRecord(it.key)
      rec = null
    }
    this._check(ctl)

    if (!rec && !it.forceCopy) {
      it.note = 'Conferindo o destino…'
      this.changed()
      const found = await this._retrying(it, ctl, () => findByName(it.name, it.folder, ctl.signal))
      this._check(ctl)
      const same = found.find((f) => f.name === it.name && Number(f.size) === it.size)
      if (same) {
        it.status = 'skipped'
        it.fileId = same.id
        it.note = ''
        it.finishedAt = Date.now()
        return
      }
    }

    it.status = 'running'
    it.note = ''
    let session = null
    if (rec) {
      session = { uri: rec.uri, createdAt: rec.createdAt, acked: rec.acked || 0, useAuth: false }
      it.note = 'Conferindo o que já chegou…'
      this.changed()
      const st = await this._status(it, session, ctl, session.acked)
      if (st.done) return this._finish(it, st.done)
      if (st.gone) {
        await deleteRecord(it.key)
        session = null
      } else {
        it.offset = st.offset
        it.note = ''
      }
    }
    if (!session) session = await this._newSession(it, ctl)
    await this._loop(it, session, ctl)
  }

  async _newSession(it, ctl) {
    it.note = 'Abrindo o envio…'
    it.offset = 0
    this.changed()
    const uri = await this._retrying(it, ctl, () => createUploadSession(it.file, it.folder, ctl.signal))
    this._check(ctl)
    const session = { uri, createdAt: Date.now(), acked: 0, useAuth: false }
    await this._save(it, session)
    it.note = ''
    return session
  }

  _save(it, session) {
    return putRecord({
      key: it.key,
      uri: session.uri,
      createdAt: session.createdAt,
      acked: session.acked,
      name: it.name,
      size: it.size,
      lastModified: it.lastModified,
      type: it.type,
      folder: it.folder,
      account: this.account,
    })
  }

  /** Metadados (conferir destino, abrir sessão): o fetch já repete; aqui esperamos rede e tentamos mais. */
  async _retrying(it, ctl, fn) {
    for (let failures = 0; ; ) {
      try {
        return await fn()
      } catch (err) {
        if (ctl.aborted) throw new Aborted(ctl.aborted)
        if (err?.signedOut || !isRetryable(err) || ++failures > 3) throw err
        await this._waitBeforeRetry(it, ctl, failures + 2)
      }
    }
  }

  async _waitBeforeRetry(it, ctl, failures) {
    if (navigator.onLine === false) {
      it.note = 'Sem internet — continuo quando voltar'
      this.changed()
      await new Promise((resolve, reject) => {
        const done = () => {
          window.removeEventListener('online', done)
          ctl.signal.removeEventListener('abort', stop)
          resolve()
        }
        const stop = () => {
          window.removeEventListener('online', done)
          reject(new Aborted(ctl.aborted || 'abort'))
        }
        window.addEventListener('online', done)
        ctl.signal.addEventListener('abort', stop, { once: true })
      })
    }
    const ms = backoffMs(failures)
    it.note = `Conexão instável — tentando de novo em ${Math.max(1, Math.round(ms / 1000))} s`
    this.changed()
    try {
      await sleep(ms, ctl.signal)
    } catch {
      throw new Aborted(ctl.aborted || 'abort')
    }
    it.note = 'Conferindo o que já chegou…'
    this.changed()
  }

  async _restart(it, ctl, restarts, note) {
    if (restarts > MAX_RESTARTS) throw new UploadError(MSG.restarts)
    await deleteRecord(it.key)
    const session = await this._newSession(it, ctl)
    it.note = note || ''
    return session
  }

  async _loop(it, first, ctl) {
    let session = first
    const chunk = getSettings().chunkMiB * MiB
    let failures = 0
    let restarts = 0
    let capHits = 0
    let badRequests = 0

    // Consulta o status e ajusta o ponto de partida. Devolve o JSON final se o Google disser que já terminou.
    const resync = async (fallback) => {
      const st = await this._status(it, session, ctl, fallback)
      if (st.done) return st.done
      if (st.gone) {
        session = await this._restart(it, ctl, ++restarts, 'O envio expirou no Google; recomeçando este arquivo.')
        return null
      }
      it.offset = st.offset
      if (st.offset > session.acked) {
        session.acked = st.offset
        await this._save(it, session)
      }
      it.note = ''
      return null
    }

    for (;;) {
      this._check(ctl)
      const start = it.offset
      if (it.size > 0 && start >= it.size) {
        const done = await resync(it.size)
        if (done) return this._finish(it, done)
        if (it.offset >= it.size) throw new UploadError('O Google não confirmou o fim do envio. Toque em Tentar de novo.')
        continue
      }
      const end = Math.min(start + chunk, it.size)
      let r
      try {
        r = await this._put(it, session, ctl, start, end)
      } catch (err) {
        if (ctl.aborted) throw new Aborted(ctl.aborted)
        if (err?.signedOut) throw err
        const wasResync = ctl.resync
        ctl.resync = false
        if (!wasResync) {
          if (++failures > MAX_FAILURES) throw new UploadError(MSG.network)
          await this._waitBeforeRetry(it, ctl, failures)
        } else {
          it.note = 'Conferindo o que já chegou…'
          this.changed()
        }
        const done = await resync(session.acked)
        if (done) return this._finish(it, done)
        continue
      }

      if (r.status === 308) {
        failures = 0
        capHits = 0
        badRequests = 0
        if (r.range != null) {
          markRangeSeen()
          it.offset = parseRange(r.range)
        } else {
          // Range ausente ou ilegível: desconhecido → consulta (fallback: fim deste pedaço, que terminou com 308).
          const done = await resync(end)
          if (done) return this._finish(it, done)
        }
        session.acked = it.offset
        await this._save(it, session)
        continue
      }
      if (r.status === 200 || r.status === 201) return this._finish(it, parseJson(r.text) || {})

      const err = driveErrorFrom(r.status, r.text)
      if (r.status === 404 || r.status === 410) {
        session = await this._restart(it, ctl, ++restarts, 'O envio expirou no Google; recomeçando este arquivo.')
        continue
      }
      if (r.status === 401) {
        if (++failures > MAX_FAILURES) throw new UploadError(MSG.network)
        auth.invalidate()
        session.useAuth = true
        continue
      }
      if (err.reason === 'storageQuotaExceeded') throw new UploadError(MSG.quota)
      if (err.reason === 'userRateLimitExceeded' && ++capHits >= CAP_HITS) throw new UploadError(MSG.cap, { cap: true })
      if (isRetryable(err)) {
        if (++failures > MAX_FAILURES) throw new UploadError(MSG.network)
        await this._waitBeforeRetry(it, ctl, failures)
        const done = await resync(session.acked)
        if (done) return this._finish(it, done)
        continue
      }
      if (r.status === 400 || r.status === 416) {
        // Quase sempre: o pedaço começou depois do que o Google tem (ponto de partida desatualizado).
        if (!rangeVisible) {
          session = await this._restart(it, ctl, ++restarts, 'O Google não confirmou o progresso; recomeçando este arquivo.')
          continue
        }
        if (++badRequests > 3) throw err
        const done = await resync(0)
        if (done) return this._finish(it, done)
        continue
      }
      throw err
    }
  }

  /** Consulta de status: PUT vazio com Content-Range "bytes *\/TOTAL". → { offset } | { done } | { gone } */
  async _status(it, session, ctl, fallback) {
    let failures = 0
    for (;;) {
      this._check(ctl)
      let r
      try {
        r = await this._put(it, session, ctl, null, null)
      } catch (err) {
        if (ctl.aborted) throw new Aborted(ctl.aborted)
        if (err?.signedOut) throw err
        ctl.resync = false
        if (++failures > MAX_FAILURES) throw new UploadError(MSG.network)
        await this._waitBeforeRetry(it, ctl, failures)
        continue
      }
      if (r.status === 308) {
        if (r.range != null) {
          markRangeSeen()
          return { offset: Math.min(parseRange(r.range), it.size) }
        }
        // Sem Range legível: ver a decisão no topo (item 3).
        return { offset: rangeVisible ? 0 : Math.min(fallback || 0, it.size) }
      }
      if (r.status === 200 || r.status === 201) return { done: parseJson(r.text) || {} }
      if (r.status === 404 || r.status === 410) return { gone: true }
      if (r.status === 401) {
        if (++failures > MAX_FAILURES) throw new UploadError(MSG.network)
        auth.invalidate()
        session.useAuth = true
        continue
      }
      const err = driveErrorFrom(r.status, r.text)
      if (isRetryable(err)) {
        if (++failures > MAX_FAILURES) throw new UploadError(MSG.network)
        await this._waitBeforeRetry(it, ctl, failures)
        continue
      }
      // Qualquer outra resposta: a sessão está num estado que não dá para retomar.
      return { gone: true }
    }
  }

  /** Um PUT na sessão (XHR, para ter progresso do envio). start == null → consulta de status. */
  async _put(it, session, ctl, start, end) {
    const token = session.useAuth ? await auth.getToken() : null
    this._check(ctl)
    const data = start != null && end > start
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      ctl.xhr = xhr
      xhr.open('PUT', session.uri)
      xhr.setRequestHeader('Content-Range', data ? `bytes ${start}-${end - 1}/${it.size}` : `bytes */${it.size}`)
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      let last = performance.now()
      it.lastProgressAt = Date.now()
      const watchdog = setInterval(() => {
        if (performance.now() - last > STALL_MS) xhr.abort()
      }, 5000)
      const finish = (fn) => {
        clearInterval(watchdog)
        if (ctl.xhr === xhr) ctl.xhr = null
        it.inflight = 0
        fn()
      }
      if (data) {
        xhr.upload.onprogress = (e) => {
          last = performance.now()
          it.lastProgressAt = Date.now()
          it.inflight = Math.min(e.loaded, end - start)
        }
      }
      xhr.onload = () => finish(() => resolve({ status: xhr.status, range: safeHeader(xhr, 'Range'), text: xhr.responseText }))
      xhr.onerror = () => finish(() => reject(new DriveError(0, 'network', 'A conexão caiu.')))
      xhr.onabort = () => finish(() => reject(new DriveError(0, 'aborted', 'Interrompido.')))
      xhr.ontimeout = () => finish(() => reject(new DriveError(0, 'timeout', 'A conexão travou.')))
      try {
        xhr.send(data ? it.file.slice(start, end, it.type || 'application/octet-stream') : null)
      } catch {
        finish(() => reject(new DriveError(0, 'network', 'Não consegui ler o arquivo.')))
      }
    })
  }

  async _finish(it, json) {
    const size = json && json.size != null ? Number(json.size) : null
    if (size != null && size !== it.size) {
      await deleteRecord(it.key)
      throw new UploadError(`O Drive recebeu ${bytes(size)} em vez de ${bytes(it.size)}. Toque em Tentar de novo para enviar outra vez.`)
    }
    it.status = 'done'
    it.fileId = json?.id || null
    it.offset = it.size
    it.inflight = 0
    it.note = ''
    it.finishedAt = Date.now()
    await deleteRecord(it.key)
  }
}

export const engine = new Engine()

/** Resumo para o medidor do topo. */
export function summarize(items) {
  let total = 0
  let finished = 0
  let remaining = 0
  let speed = 0
  let running = 0
  let pending = 0
  let paused = 0
  let failed = 0
  let waitingFile = 0
  for (const it of items) {
    total++
    if (FINISHED.has(it.status)) {
      finished++
      continue
    }
    const left = Math.max(0, it.size - it.offset - it.inflight)
    if (it.status === 'failed') failed++
    else if (it.status === 'needsFile') waitingFile++
    else {
      remaining += left
      if (it.status === 'paused') paused++
      else pending++
      if (it.status === 'running' || it.status === 'preparing') {
        running++
        speed += it.speed || 0
      }
    }
  }
  return { total, finished, remaining, speed, running, pending, paused, failed, waitingFile, eta: speed > 0 ? remaining / speed : null }
}
