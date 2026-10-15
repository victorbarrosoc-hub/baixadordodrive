// MD5 de arquivos locais em worker_threads (arquivos de centenas de GB não podem travar o motor),
// com cache por caminho + tamanho + data de modificação para não recalcular à toa.
import { Worker } from 'node:worker_threads'
import fs from 'node:fs/promises'
import path from 'node:path'
import { dataPaths } from '../config.js'
import { JsonFile } from '../util/store.js'
import { abortError } from '../util/backoff.js'

const WORKER_URL = new URL('./hash-worker.js', import.meta.url)
const SAVE_DELAY_MS = 3000 // o cache pode ter milhares de itens: agrupa as gravações
const MAX_CACHE_ENTRIES = 100_000 // acima disso, os mais antigos saem
const CANCEL_TIMEOUT_MS = 2000 // worker que não confirma o cancelamento nesse tempo é substituído

function rebuildError(info = {}) {
  const err = new Error(info.message || 'Não consegui ler o arquivo.')
  if (info.code) err.code = info.code
  if (info.errno != null) err.errno = info.errno
  if (info.syscall) err.syscall = info.syscall
  if (info.path) err.path = info.path
  return err
}

/**
 * @typedef {{ resolve: Function, reject: Function, onProgress?: Function, signal?: AbortSignal, onAbort?: Function }} Sub
 * @typedef {{ id: number, key: string, path: string, size: number, mtimeMs: number, subs: Set<Sub>, state: 'queued'|'running'|'finishing'|'done', canceled: boolean, slot: object|null, bytes: number }} Job
 */

export class Hasher {
  /**
   * @param {{ cacheFile?: string, workers?: number, cancelTimeoutMs?: number, workerUrl?: URL|string, log?: Function }} [opts]
   *   `workerUrl` e `cancelTimeoutMs` existem só para os testes.
   */
  constructor({ cacheFile = dataPaths().hashCache, workers = 2, cancelTimeoutMs = CANCEL_TIMEOUT_MS, workerUrl = WORKER_URL, log = null } = {}) {
    this.cache = new JsonFile(cacheFile, {})
    this.maxWorkers = Math.max(1, Math.floor(Number(workers) || 1))
    this.cancelTimeoutMs = cancelTimeoutMs
    this.workerUrl = workerUrl
    this.log = log || ((...args) => console.warn('[hasher]', ...args))
    this.ready = null
    this.closed = false
    this.touched = false
    this.cacheCount = 0
    /** @type {Map<string, Job>} */
    this.jobs = new Map()
    /** @type {Job[]} */
    this.queue = []
    this.qHead = 0
    this.pool = [] // [{ worker, job: Job|null, cancelTimer }]
    this.nextId = 1
    this.started = 0 // jobs que chegaram a um worker (os testes conferem o compartilhamento)
    let warned = false
    this.cache.onError = err => {
      if (!warned) this.log('não consegui gravar o cache de MD5:', err.message)
      warned = true
    }
  }

  init() {
    this.ready ??= (async () => {
      let raw = null
      try {
        raw = await this.cache.load()
      } catch (err) {
        // Sem conseguir ler o cache, segue sem ele (só fica mais lento).
        this.log('não consegui ler o cache de MD5:', err.message)
      }
      // Cache estranho (versão antiga/editado à mão): fica só com o que tem o formato certo.
      const clean = {}
      let count = 0
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw)) {
          if (v && typeof v.md5 === 'string' && Number.isFinite(v.size) && Number.isFinite(v.mtimeMs)) {
            clean[k] = { size: v.size, mtimeMs: v.mtimeMs, md5: v.md5 }
            count++
          }
        }
      }
      this.cache.data = clean
      this.cacheCount = count
    })()
    return this.ready
  }

  /** MD5 já conhecido para este arquivo nesta versão (mesmo tamanho e data), ou null. */
  getCached(filePath, size, mtimeMs) {
    const entry = this.cache.data[path.resolve(String(filePath))]
    if (entry && entry.size === size && entry.mtimeMs === mtimeMs) return entry.md5
    return null
  }

  #remember(abs, size, mtimeMs, md5) {
    const data = this.cache.data
    // Apaga e grava de novo para ir para o fim da ordem de inserção (o fim = mais recente).
    if (Object.hasOwn(data, abs)) delete data[abs]
    else this.cacheCount++
    data[abs] = { size, mtimeMs, md5 }
    if (this.cacheCount > MAX_CACHE_ENTRIES + 1000) {
      let drop = this.cacheCount - MAX_CACHE_ENTRIES
      for (const k in data) {
        if (drop-- <= 0) break
        delete data[k]
        this.cacheCount--
      }
    }
    this.touched = true
    this.cache.saveSoon(SAVE_DELAY_MS)
  }

  /**
   * MD5 (hex) do arquivo. Usa o cache se caminho+tamanho+data batem; senão calcula num worker.
   * Pedidos simultâneos do mesmo arquivo compartilham o mesmo cálculo.
   * @param {string} filePath
   * @param {{ signal?: AbortSignal, onProgress?: (p: { bytes: number, done: number, total: number }) => void }} [opts]
   * @returns {Promise<string>}
   */
  async hash(filePath, { signal, onProgress } = {}) {
    if (signal?.aborted) throw abortError(signal)
    if (this.closed) throw abortError()
    await this.init()
    const abs = path.resolve(String(filePath))
    const st = await fs.stat(abs) // erro de disco sobe com o código original (ENOENT, EACCES…)
    if (!st.isFile()) {
      const err = new Error(st.isDirectory() ? `É uma pasta, não um arquivo: ${abs}` : `Não é um arquivo comum: ${abs}`)
      err.code = st.isDirectory() ? 'EISDIR' : 'EINVAL'
      err.path = abs
      throw err
    }
    if (signal?.aborted) throw abortError(signal)

    const cached = this.getCached(abs, st.size, st.mtimeMs)
    if (cached) {
      safeProgress({ onProgress }, st.size, st.size)
      return cached
    }
    if (this.closed) throw abortError() // fechou enquanto o stat rodava

    const key = `${abs}\u0000${st.size}\u0000${st.mtimeMs}`
    let job = this.jobs.get(key)
    if (!job) {
      job = { id: this.nextId++, key, path: abs, size: st.size, mtimeMs: st.mtimeMs, subs: new Set(), state: 'queued', canceled: false, slot: null, bytes: 0 }
      this.jobs.set(key, job)
      this.queue.push(job)
    }

    return new Promise((resolve, reject) => {
      const sub = { resolve, reject, onProgress, signal, onAbort: null }
      if (signal) {
        sub.onAbort = () => this.#dropSub(job, sub, abortError(signal))
        signal.addEventListener('abort', sub.onAbort, { once: true })
      }
      job.subs.add(sub)
      this.#pump()
    })
  }

  /** Tira um interessado do job; se ninguém mais quer o resultado, cancela o job. */
  #dropSub(job, sub, err) {
    if (!job.subs.delete(sub)) return
    if (sub.signal && sub.onAbort) sub.signal.removeEventListener('abort', sub.onAbort)
    sub.reject(err)
    if (job.subs.size === 0 && job.state !== 'done') this.#cancelJob(job)
  }

  #cancelJob(job) {
    if (job.canceled) return
    job.canceled = true
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key)
    if (job.state === 'running' && job.slot) {
      const slot = job.slot
      slot.worker.postMessage({ type: 'cancel', id: job.id })
      // Se o worker não responder (ex.: travado), ele é encerrado e outro nasce quando precisar.
      slot.cancelTimer = setTimeout(() => {
        if (slot.job === job) this.#killSlot(slot, null)
      }, this.cancelTimeoutMs)
      slot.cancelTimer.unref?.()
    }
    // Job ainda na fila: #pump pula os cancelados.
  }

  #settle(job, fn) {
    job.state = 'done'
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key)
    for (const sub of job.subs) {
      if (sub.signal && sub.onAbort) sub.signal.removeEventListener('abort', sub.onAbort)
      fn(sub)
    }
    job.subs.clear()
  }

  #spawn() {
    // execArgv vazio: o worker não precisa de flags, e algumas herdadas (ex.: --input-type) impedem ele de nascer.
    const worker = new Worker(this.workerUrl, { execArgv: [] })
    const slot = { worker, job: null, cancelTimer: null, dead: false }
    worker.on('message', msg => this.#onMessage(slot, msg))
    worker.on('error', err => this.#onWorkerGone(slot, err))
    worker.on('exit', () => this.#onWorkerGone(slot, null))
    worker.unref() // worker parado não segura o processo aberto
    this.pool.push(slot)
    return slot
  }

  #pump() {
    if (this.closed) return
    while (this.qHead < this.queue.length) {
      const job = this.queue[this.qHead]
      if (job.canceled || job.subs.size === 0) {
        if (job.subs.size === 0 && !job.canceled) this.#cancelJob(job)
        this.queue[this.qHead++] = null
        continue
      }
      let slot = this.pool.find(s => !s.job && !s.dead)
      if (!slot && this.pool.length < this.maxWorkers) slot = this.#spawn()
      if (!slot) break
      this.queue[this.qHead++] = null
      job.state = 'running'
      job.slot = slot
      slot.job = job
      this.started++
      slot.worker.ref() // trabalhando: o processo espera o resultado
      slot.worker.postMessage({ type: 'hash', id: job.id, path: job.path })
    }
    // Compacta a fila de vez em quando (FIFO sem o custo de Array.shift em filas enormes).
    if (this.qHead > 1024 && this.qHead * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.qHead)
      this.qHead = 0
    } else if (this.qHead === this.queue.length) {
      this.queue = []
      this.qHead = 0
    }
  }

  #release(slot) {
    if (slot.cancelTimer) clearTimeout(slot.cancelTimer)
    slot.cancelTimer = null
    if (slot.job) slot.job.slot = null
    slot.job = null
    if (!slot.dead) slot.worker.unref()
    this.#pump()
  }

  #onMessage(slot, msg) {
    const job = slot.job
    if (!job || msg?.id !== job.id) return // resposta atrasada de um job que já saiu deste worker
    if (msg.type === 'progress') {
      job.bytes = msg.bytes
      for (const sub of job.subs) safeProgress(sub, msg.bytes, job.size)
    } else if (msg.type === 'done') {
      job.state = 'finishing' // falta só conferir o arquivo; o worker já está livre
      this.#release(slot)
      this.#finish(job, msg).catch(err => this.log('erro ao concluir MD5:', err.message))
    } else if (msg.type === 'error') {
      this.#release(slot)
      const err = rebuildError(msg.error)
      this.#settle(job, sub => sub.reject(err))
    } else if (msg.type === 'canceled') {
      this.#release(slot)
      this.#settle(job, sub => sub.reject(abortError()))
    }
  }

  async #finish(job, { md5, bytes }) {
    // Confere se o arquivo não mudou durante a leitura; se mudou, o resultado vale só para quem pediu agora.
    let still = null
    try {
      still = await fs.stat(job.path)
    } catch {}
    const stable = still && still.size === job.size && still.mtimeMs === job.mtimeMs && bytes === job.size
    if (stable && !this.closed) this.#remember(job.path, job.size, job.mtimeMs, md5)
    if (job.canceled) return // ninguém mais esperava, mas o cache aproveitou
    this.#settle(job, sub => {
      safeProgress(sub, bytes, job.size)
      sub.resolve(md5)
    })
  }

  #killSlot(slot, err) {
    if (slot.dead) return
    slot.dead = true
    this.pool = this.pool.filter(s => s !== slot)
    if (slot.cancelTimer) clearTimeout(slot.cancelTimer)
    const job = slot.job
    slot.job = null
    slot.worker.terminate().catch(() => {})
    if (job && job.state !== 'done') {
      const reason = job.canceled ? abortError() : err || new Error('O cálculo do MD5 parou inesperadamente.')
      this.#settle(job, sub => sub.reject(reason))
    }
    this.#pump()
  }

  #onWorkerGone(slot, err) {
    if (slot.dead) return
    if (err) this.log('worker de MD5 falhou:', err.message)
    this.#killSlot(slot, err)
  }

  /** Grava o cache agora (se mudou desde que abriu). */
  async flush() {
    if (this.touched) await this.cache.save()
  }

  /** Encerra os workers (cálculos em andamento são interrompidos) e grava o cache. */
  async close() {
    if (this.closed) return
    this.closed = true
    for (let i = this.qHead; i < this.queue.length; i++) {
      const job = this.queue[i]
      if (job && job.state === 'queued') this.#settle(job, sub => sub.reject(abortError()))
    }
    this.queue = []
    this.qHead = 0
    const slots = this.pool
    this.pool = []
    await Promise.all(slots.map(async slot => {
      slot.dead = true
      if (slot.cancelTimer) clearTimeout(slot.cancelTimer)
      const job = slot.job
      slot.job = null
      if (job && job.state !== 'done') this.#settle(job, sub => sub.reject(abortError()))
      await slot.worker.terminate().catch(() => {})
    }))
    this.jobs.clear()
    if (this.ready) await this.ready.catch(() => {})
    await this.flush()
  }
}

function safeProgress(sub, bytes, total) {
  if (!sub.onProgress) return
  try {
    sub.onProgress({ bytes, done: bytes, total })
  } catch {
    // Erro em quem só queria acompanhar não pode derrubar o cálculo.
  }
}
