// Tamanho das pastas (tela Drive): o Google não guarda, então o motor soma a árvore (DriveClient.folderSize).
// Rotas:
//   POST   /api/drive/:acc/tamanho   { folderId, refresh?, auto? } → { tamanho }   começa (ou devolve o que já sabe)
//   GET    /api/drive/:acc/tamanho   ?ids=a,b,c                   → { tamanhos: { id: TamanhoView|null } }
//   DELETE /api/drive/:acc/tamanho   { folderId, discard? }       → { tamanho }   "Parar" (discard: esquece o parcial)
// A interface pergunta (GET) a cada ~0,7 s enquanto alguma conta está rodando. Conta que ninguém pergunta há
// LEASE_MS é abandonada (a tela fechou). No máximo MAX_RUNNING contas ao mesmo tempo; as outras esperam na fila.
// O resultado fica guardado nesta sessão; um envio que termina nesta conta esquece os resultados dela.
//
// TamanhoView = { folderId, status: 'queued'|'running'|'done'|'stopped'|'error', bytes, files, folders, docs,
//                 shortcuts, pending, startedAt, finishedAt, elapsedMs, error? }

const DRIVE_ID = /^[\w-]{1,200}$/
const MAX_RUNNING = 2
const LEASE_MS = 20_000
const MAX_KEPT = 2000
const MAX_IDS = 200

function blank(folderId) {
  return { folderId, status: 'queued', bytes: 0, files: 0, folders: 0, docs: 0, shortcuts: 0, pending: 0, startedAt: null, finishedAt: null, error: null }
}

export class FolderSizeJobs {
  constructor(ctx, { HttpProblem, toProblem, leaseMs = LEASE_MS, maxRunning = MAX_RUNNING } = {}) {
    this.ctx = ctx
    this.HttpProblem = HttpProblem
    this.toProblem = toProblem
    this.leaseMs = leaseMs
    this.maxRunning = maxRunning
    this.jobs = new Map() // `${acc}|${folderId}` -> job
    this.waiting = []
    this.doneUploads = new Set()
    this.timer = setInterval(() => this.#sweep(), Math.max(250, Math.min(5000, leaseMs / 4)))
    this.timer.unref?.()
    // Envio terminado nesta conta: os tamanhos guardados dela ficam velhos (a pasta pode ser qualquer ancestral).
    this.onTransfers = list => {
      for (const t of Array.isArray(list) ? list : []) {
        if (t?.type !== 'upload' || t.status !== 'completed' || this.doneUploads.has(t.id)) continue
        this.doneUploads.add(t.id)
        if (this.doneUploads.size > 5000) this.doneUploads.clear()
        this.forgetAccount(t.accountId)
      }
    }
    ctx.manager?.on?.('transfers', this.onTransfers)
  }

  static key(accountId, folderId) {
    return `${accountId}|${folderId}`
  }

  view(job) {
    if (!job) return null
    const end = job.finishedAt ?? Date.now()
    return {
      folderId: job.folderId,
      status: job.status,
      bytes: job.bytes,
      files: job.files,
      folders: job.folders,
      docs: job.docs,
      shortcuts: job.shortcuts,
      pending: job.pending,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      elapsedMs: job.startedAt ? Math.max(0, end - job.startedAt) : 0,
      ...(job.error ? { error: job.error } : {}),
    }
  }

  /** Começa a conta. Já pronta (ou parada à mão, com `auto`) devolve o que tem; `refresh` refaz. */
  start(accountId, folderId, { refresh = false, auto = false } = {}) {
    const key = FolderSizeJobs.key(accountId, folderId)
    const cur = this.jobs.get(key)
    if (cur) {
      cur.seenAt = Date.now()
      if (cur.status === 'running' || cur.status === 'queued') return cur
      if (!refresh && (cur.status === 'done' || (auto && cur.status === 'stopped'))) return cur
    }
    const job = { ...blank(folderId), key, accountId, seenAt: Date.now(), ac: null }
    this.jobs.delete(key)
    this.jobs.set(key, job)
    this.waiting.push(job)
    this.#trim()
    this.#pump()
    return job
  }

  /** Respostas para a interface (e renova a vaga de quem ainda está olhando). */
  lookup(accountId, ids) {
    const out = {}
    const now = Date.now()
    for (const id of ids) {
      const job = this.jobs.get(FolderSizeJobs.key(accountId, id)) || null
      if (job) job.seenAt = now
      out[id] = this.view(job)
    }
    return out
  }

  /** "Parar": guarda o parcial (status 'stopped'). `discard`: esquece (a tela saiu da pasta). */
  stop(accountId, folderId, { discard = false } = {}) {
    const key = FolderSizeJobs.key(accountId, folderId)
    const job = this.jobs.get(key)
    if (!job) return null
    if (job.status === 'queued' || job.status === 'running') {
      job.discard = discard
      this.#halt(job)
    } else if (discard && job.status !== 'done') this.jobs.delete(key)
    return this.jobs.get(key) || null
  }

  forgetAccount(accountId) {
    for (const [key, job] of this.jobs) {
      if (job.accountId === accountId && job.status !== 'running' && job.status !== 'queued') this.jobs.delete(key)
    }
  }

  close() {
    clearInterval(this.timer)
    this.ctx.manager?.off?.('transfers', this.onTransfers)
    for (const job of this.jobs.values()) if (job.status === 'running' || job.status === 'queued') this.#halt(job)
  }

  #halt(job) {
    if (job.status === 'queued') {
      const i = this.waiting.indexOf(job)
      if (i >= 0) this.waiting.splice(i, 1)
      this.#finish(job, 'stopped')
    } else job.ac?.abort()
  }

  #finish(job, status, error = null) {
    job.status = status
    job.error = error
    job.finishedAt = Date.now()
    job.pending = status === 'done' ? 0 : job.pending
    job.ac = null
    if (job.discard && this.jobs.get(job.key) === job) this.jobs.delete(job.key)
  }

  #running() {
    let n = 0
    for (const job of this.jobs.values()) if (job.status === 'running') n++
    return n
  }

  #pump() {
    while (this.waiting.length && this.#running() < this.maxRunning) this.#run(this.waiting.shift())
  }

  #run(job) {
    job.status = 'running'
    job.startedAt = Date.now()
    job.ac = new AbortController()
    const signal = job.ac.signal
    const take = p => {
      if (!p) return
      for (const k of ['bytes', 'files', 'folders', 'docs', 'shortcuts', 'pending']) job[k] = p[k] ?? job[k]
    }
    let drive
    try {
      drive = this.ctx.manager.driveFor(job.accountId)
    } catch (err) {
      this.#finish(job, 'error', 'Conta não encontrada. Conecte a conta de novo.')
      this.ctx.log?.('tamanho da pasta: conta', err?.message)
      return
    }
    drive
      .folderSize(job.folderId, { signal, onProgress: p => job.ac?.signal === signal && take(p) })
      .then(
        out => {
          take(out)
          this.#finish(job, 'done')
        },
        err => {
          take(err?.partial)
          if (signal.aborted) return this.#finish(job, 'stopped')
          const p = this.toProblem?.(err)
          if (!p) this.ctx.log?.('tamanho da pasta falhou:', err?.stack || err)
          this.#finish(job, 'error', p?.message || 'Não consegui somar esta pasta.')
        },
      )
      .finally(() => this.#pump())
  }

  #sweep() {
    const now = Date.now()
    for (const job of this.jobs.values()) {
      if ((job.status === 'running' || job.status === 'queued') && now - job.seenAt > this.leaseMs) {
        job.discard = true // ninguém olhando: não vale guardar um parcial
        this.#halt(job)
      }
    }
    this.#pump()
  }

  #trim() {
    if (this.jobs.size <= MAX_KEPT) return
    for (const [key, job] of this.jobs) {
      if (this.jobs.size <= MAX_KEPT) break
      if (job.status !== 'running' && job.status !== 'queued') this.jobs.delete(key)
    }
  }
}

/** Liga as rotas. Devolve o gerenciador (close() no encerramento). */
export function registerTamanho({ route, ctx, account, HttpProblem, toProblem }) {
  const jobs = new FolderSizeJobs(ctx, { HttpProblem, toProblem })
  const folderOf = v => {
    const id = typeof v === 'string' && v ? v : 'root'
    if (!DRIVE_ID.test(id)) throw new HttpProblem(400, 'Pasta inválida.')
    return id
  }

  route('POST', '/api/drive/:acc/tamanho', ({ params, body }) => {
    const acc = account(params.acc)
    const job = jobs.start(acc.id, folderOf(body.folderId), { refresh: body.refresh === true, auto: body.auto === true })
    return { tamanho: jobs.view(job) }
  })

  route('GET', '/api/drive/:acc/tamanho', ({ params, query }) => {
    const acc = account(params.acc)
    const raw = query.get('ids') ?? query.get('folderId') ?? ''
    const ids = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))].slice(0, MAX_IDS)
    for (const id of ids) folderOf(id)
    return { tamanhos: jobs.lookup(acc.id, ids) }
  })

  route('DELETE', '/api/drive/:acc/tamanho', ({ params, body }) => {
    const acc = account(params.acc)
    return { tamanho: jobs.view(jobs.stop(acc.id, folderOf(body.folderId), { discard: body.discard === true })) }
  })

  return jobs
}
