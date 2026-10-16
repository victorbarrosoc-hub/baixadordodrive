// Tamanho das pastas: o Google não guarda, então a conta é feita aqui, descendo a árvore direto no Drive.
// Barato de propósito: só id, tipo e tamanho de cada item (páginas de 1000), poucas listagens ao mesmo tempo, sem
// lixeira, sem seguir atalhos (contam à parte) e Docs do Google contam 0. É a mesma conta do app do computador
// (src/google/folder-size.js); este arquivo não importa nada para os testes do Node rodarem ele contra o Drive falso.

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'
const GAPPS = 'application/vnd.google-apps.'

export const SIZE_FIELDS = 'nextPageToken,files(id,mimeType,size)'
export const BIG_ITEMS = 20_000 // acima disso (ou de BIG_MS) a tela mostra "…+" e "Parar"
export const BIG_MS = 30_000
const PROGRESS_MS = 200
const MAX_RUNNING = 2

const abortErr = (signal) => {
  const r = signal?.reason
  if (r instanceof Error && r.name === 'AbortError') return r
  try {
    return new DOMException('Abortado', 'AbortError')
  } catch {
    const e = new Error('Abortado')
    e.name = 'AbortError'
    return e
  }
}
const isAbort = (err) => err?.name === 'AbortError'
const withPartial = (err, partial) => {
  try {
    err.partial = partial
  } catch {
    // erro congelado: segue sem o parcial
  }
  return err
}

export function emptySize() {
  return { bytes: 0, files: 0, folders: 0, docs: 0, shortcuts: 0, pending: 0 }
}

/**
 * Soma a árvore de `rootId`. `listPage(folderId, pageToken, signal)` → `{ files, nextPageToken }`.
 * Pasta que some no meio (404/403 sem ser limite) fica de fora; a raiz precisa existir.
 * Cancelada: rejeita com AbortError e `err.partial`. files inclui os docs; folders não conta a raiz.
 */
export async function walkFolderSize({ listPage, rootId, signal, onProgress, concurrency = 4, progressMs = PROGRESS_MS }) {
  if (signal?.aborted) throw withPartial(abortErr(signal), emptySize())
  const inner = new AbortController()
  const sig = signal ? anySignal([signal, inner.signal]) : inner.signal
  const c = emptySize()
  const queue = [rootId]
  const seen = new Set([rootId])
  let head = 0
  let active = 0
  let failure = null
  let waiters = []
  let lastEmit = 0

  const wake = () => {
    const list = waiters
    waiters = []
    for (const resolve of list) resolve()
  }
  const fail = (err) => {
    failure ??= err
    inner.abort()
    wake()
  }
  const emit = (force = false) => {
    if (!onProgress) return
    const now = Date.now()
    if (!force && now - lastEmit < progressMs) return
    lastEmit = now
    c.pending = queue.length - head + active
    try {
      onProgress({ ...c })
    } catch {
      // progresso é só informativo
    }
  }
  const add = (f) => {
    const mime = f?.mimeType || ''
    if (mime === FOLDER_MIME) {
      c.folders++
      if (f.id && !seen.has(f.id)) {
        seen.add(f.id)
        queue.push(f.id)
      }
    } else if (mime === SHORTCUT_MIME) c.shortcuts++
    else {
      c.files++
      if (mime.startsWith(GAPPS)) c.docs++
      else {
        const n = Number(f.size)
        if (Number.isFinite(n) && n > 0) c.bytes += n
      }
    }
  }

  const lister = async () => {
    for (;;) {
      if (failure || sig.aborted) return
      if (head < queue.length) {
        const id = queue[head++]
        active++
        try {
          let pageToken
          do {
            const r = await listPage(id, pageToken, sig)
            for (const f of r?.files || []) add(f)
            pageToken = r?.nextPageToken || undefined
            emit()
          } while (pageToken && !sig.aborted)
        } catch (err) {
          const limit = err?.reason === 'rateLimitExceeded' || err?.reason === 'userRateLimitExceeded'
          const gone = err?.status === 404 || (err?.status === 403 && !limit)
          if (!isAbort(err) && (id === rootId || !gone)) fail(err)
        } finally {
          active--
          wake()
        }
      } else if (active === 0) {
        wake()
        return
      } else {
        await new Promise((resolve) => waiters.push(resolve))
      }
    }
  }

  const n = Math.max(1, Math.floor(concurrency) || 1)
  await Promise.all(Array.from({ length: n }, lister))
  c.pending = queue.length - head
  if (signal?.aborted) throw withPartial(abortErr(signal), { ...c })
  if (failure) throw withPartial(failure, { ...c })
  c.pending = 0
  emit(true)
  return { ...c }
}

function anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  const ac = new AbortController()
  for (const s of signals) {
    if (s.aborted) {
      ac.abort(s.reason)
      break
    }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true })
  }
  return ac.signal
}

/** Página de filhos de uma pasta pelo `call` do Drive (lib/drive.js). Drive compartilhado: corpora=drive. */
export function pageLister(call, driveId = null) {
  return (id, pageToken, signal) => {
    const query = {
      q: `'${String(id).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' in parents and trashed = false`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 1000,
      fields: SIZE_FIELDS,
      pageToken,
    }
    if (driveId) Object.assign(query, { corpora: 'drive', driveId })
    return call('/files', { query, signal })
  }
}

/** A conta já passou do ponto de "grande" (mostra "…+" e "Parar"). */
export function sizeIsBig(v) {
  if (!v) return false
  return v.files + v.folders > BIG_ITEMS || (v.elapsedMs ?? 0) > BIG_MS
}

/**
 * Contas por pasta nesta sessão: no máximo MAX_RUNNING ao mesmo tempo (as outras esperam), resultado guardado por id,
 * "Parar" guarda o parcial e `focus(id)` esquece as contas de outras pastas que ainda estão andando (a tela saiu delas).
 * `walk(folder, { signal, onProgress })` faz a conta (ver folderSize em lib/browse.js).
 * View = { folderId, status: 'queued'|'running'|'done'|'stopped'|'error', bytes, files, folders, docs, shortcuts,
 *          pending, startedAt, finishedAt, elapsedMs, error? }
 */
export class FolderSizes {
  constructor({ walk, maxRunning = MAX_RUNNING, now = () => Date.now() }) {
    this.walk = walk
    this.maxRunning = maxRunning
    this.now = now
    this.jobs = new Map()
    this.waiting = []
    this.listeners = new Set()
  }

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  #changed() {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch {
        // quem ouve se vira
      }
    }
  }

  get(id) {
    const j = this.jobs.get(id)
    if (!j) return null
    if (j.status === 'running') j.view = { ...j.view, elapsedMs: this.now() - j.view.startedAt }
    return j.view
  }

  running() {
    return [...this.jobs.values()].some((j) => j.status === 'running' || j.status === 'queued')
  }

  /** folder = { id, driveId? }. Já pronta (ou parada à mão, com `auto`) devolve o que tem; `refresh` refaz. */
  start(folder, { refresh = false, auto = false } = {}) {
    const cur = this.jobs.get(folder.id)
    if (cur) {
      if (cur.status === 'running' || cur.status === 'queued') return cur.view
      if (!refresh && (cur.status === 'done' || (auto && cur.status === 'stopped'))) return cur.view
    }
    const job = { folder, status: 'queued', ac: null, discard: false }
    job.view = { folderId: folder.id, status: 'queued', ...emptySize(), startedAt: null, finishedAt: null, elapsedMs: 0 }
    this.jobs.delete(folder.id)
    this.jobs.set(folder.id, job)
    this.waiting.push(job)
    this.#pump()
    this.#changed()
    return job.view
  }

  /** "Parar" (guarda o parcial) ou, com `discard`, esquece. */
  stop(id, { discard = false } = {}) {
    const job = this.jobs.get(id)
    if (!job) return
    job.discard = discard
    if (job.status === 'queued') {
      this.waiting.splice(this.waiting.indexOf(job), 1)
      this.#finish(job, 'stopped')
    } else if (job.status === 'running') job.ac.abort()
    else if (discard && job.status !== 'done') {
      this.jobs.delete(id)
      this.#changed()
    }
  }

  /** A tela está nesta pasta: contas de outras pastas que ainda andam são esquecidas. */
  focus(id) {
    for (const [k, job] of this.jobs) if (k !== id && (job.status === 'running' || job.status === 'queued')) this.stop(k, { discard: true })
  }

  forget(id) {
    const job = this.jobs.get(id)
    if (job && job.status !== 'running' && job.status !== 'queued') {
      this.jobs.delete(id)
      this.#changed()
    }
  }

  #pump() {
    let running = 0
    for (const j of this.jobs.values()) if (j.status === 'running') running++
    while (this.waiting.length && running < this.maxRunning) {
      this.#run(this.waiting.shift())
      running++
    }
  }

  #run(job) {
    job.status = 'running'
    job.ac = new AbortController()
    const signal = job.ac.signal
    const startedAt = this.now()
    job.view = { ...job.view, status: 'running', startedAt }
    let last = 0
    const take = (p) => {
      if (!p || this.jobs.get(job.folder.id) !== job) return
      job.view = { ...job.view, ...pick(p), elapsedMs: this.now() - startedAt }
    }
    this.#changed()
    Promise.resolve()
      .then(() =>
        this.walk(job.folder, {
          signal,
          onProgress: (p) => {
            if (signal.aborted) return
            take(p)
            const t = this.now()
            if (t - last >= 250) {
              last = t
              this.#changed()
            }
          },
        }),
      )
      .then(
        (out) => {
          take(out)
          this.#finish(job, 'done')
        },
        (err) => {
          take(err?.partial)
          if (signal.aborted) return this.#finish(job, 'stopped')
          this.#finish(job, 'error', err?.status === 0 ? 'Sem conexão com o Google.' : 'Não consegui somar esta pasta.')
        },
      )
      .finally(() => {
        this.#pump()
        this.#changed()
      })
  }

  #finish(job, status, error = null) {
    job.status = status
    job.ac = null
    const finishedAt = this.now()
    job.view = { ...job.view, status, finishedAt, elapsedMs: job.view.startedAt ? finishedAt - job.view.startedAt : 0, ...(status === 'done' ? { pending: 0 } : {}), ...(error ? { error } : {}) }
    if (job.discard && this.jobs.get(job.folder.id) === job) this.jobs.delete(job.folder.id)
    this.#changed()
  }
}

function pick(p) {
  const out = {}
  for (const k of ['bytes', 'files', 'folders', 'docs', 'shortcuts', 'pending']) if (p[k] != null) out[k] = p[k]
  return out
}
