// "Copiar de um link" (tela Drive): link do Drive de outra pessoa → pasta do Drive da conta (src/google/copiar.js).
// Rotas:
//   POST   /api/copiar/:acc/ler  { link }                        → { plano }  lê o link (a tela espera a resposta)
//   POST   /api/copiar/:acc      { planoId, dest: { id, name, driveId? }, localDir? } → { copia }  começa a cópia
//          (`localDir`: também baixa para a mídia física, pela fila de downloads de sempre, DA CÓPIA que ficou no
//          Drive da conta: o Google entrega o próprio Drive bem mais rápido que o arquivo de outra pessoa por link)
//   GET    /api/copiar                                           → { copia }  a última cópia (ou null)
//   DELETE /api/copiar/:id                                       → { parou }  "Parar"
// Uma cópia por vez. Progresso pelo SSE ('copiar', no máximo 4×/s). O plano fica guardado no servidor (pode ter
// milhares de arquivos): a tela só manda o id dele de volta. O resultado da última cópia fica para a tela mostrar.
import fs from 'node:fs/promises'
import { copiarPlano, copyDownloadItems, lerLink, parseDriveLink, readErrorMessage } from '../google/copiar.js'
import { newId } from '../util/ids.js'
import { isAbortError } from '../util/backoff.js'

const DRIVE_ID = /^[\w-]{1,200}$/
const EVENT_MS = 250
const MAX_PLANS = 10

/** O que a tela precisa do plano (sem a lista inteira de arquivos). */
function planView(id, accountId, p) {
  return {
    planoId: id,
    accountId,
    nome: p.root.name,
    pasta: p.root.folder,
    dono: p.owner,
    arquivos: p.files.length,
    subpastas: p.folders.length,
    bytes: p.bytes,
    bloqueados: p.blocked,
    atalhos: p.skipped.length,
  }
}

export class CopyJobs {
  constructor(ctx, { HttpProblem, baixar }) {
    this.ctx = ctx
    this.HttpProblem = HttpProblem
    this.baixar = baixar
    this.plans = new Map() // id → { accountId, plan }
    this.job = null
  }

  keepPlan(accountId, plan) {
    const id = newId('cpl')
    this.plans.set(id, { accountId, plan })
    while (this.plans.size > MAX_PLANS) this.plans.delete(this.plans.keys().next().value)
    return planView(id, accountId, plan)
  }

  running() {
    return this.job?.status === 'running' ? this.job : null
  }

  /** O plano lido (para começar): confere a conta, se ainda vale e se não tem outra cópia andando. */
  planFor(accountId, planoId) {
    const { HttpProblem } = this
    if (this.running()) throw new HttpProblem(409, 'Já tem uma cópia em andamento. Espere terminar ou pare a atual.')
    const kept = this.plans.get(planoId)
    if (!kept || kept.accountId !== accountId) throw new HttpProblem(404, 'Leia o link de novo: essa leitura não vale mais.')
    if (!kept.plan.files.some(f => f.canCopy)) throw new HttpProblem(400, 'Nada para copiar: o dono bloqueou a cópia de tudo.')
    return kept.plan
  }

  /**
   * `localDir`: "Também baixar para…". Quando a cópia termina (ou para no meio), o que ela criou no Drive da conta
   * entra na fila de downloads. `download` na view: { status: 'aguardando'|'na fila'|'nada'|'erro', destDir, count,
   * bytes, batchId, skipped, error }.
   */
  start({ accountId, planoId, dest, localDir = null }) {
    const plan = this.planFor(accountId, planoId)
    const job = {
      id: newId('cpy'),
      accountId,
      plano: planView(planoId, accountId, plan),
      dest,
      download: localDir ? { status: 'aguardando', destDir: localDir } : null,
      status: 'running',
      progress: null,
      error: null,
      ac: new AbortController(),
      lastSent: 0,
      timer: null,
    }
    this.job = job
    this.#emit(job)
    const novas = { pastas: [], arquivos: [] }
    ;(async () => {
      try {
        const s = await copiarPlano(this.ctx.manager.driveFor(accountId), plan, dest, { signal: job.ac.signal, onProgress: p => this.#progress(job, p), novas })
        job.progress = s
        job.status = 'done'
        this.ctx.log(`copiar de link: ${s.done - (s.failed.length - plan.blocked)} de ${s.total} copiados para ${dest.name}${s.stopped ? ` (parou: ${s.stopped})` : ''}`)
      } catch (err) {
        if (job.ac.signal.aborted || isAbortError(err)) {
          job.status = 'canceled'
          job.error = 'Você parou a cópia. O que já foi copiado ficou no seu Drive.'
        } else {
          this.ctx.log('copiar de link falhou:', err?.stack || err)
          job.status = 'error'
          job.error = readErrorMessage(err)
        }
      } finally {
        this.plans.delete(planoId)
        this.#emit(job)
      }
      if (localDir) await this.#baixarCopia(job, plan, novas, localDir)
    })()
    return this.view(job)
  }

  /** Põe na fila os downloads do que a cópia criou (mesmo parada no meio: o que foi copiado, baixa). */
  async #baixarCopia(job, plan, novas, destDir) {
    const items = copyDownloadItems(plan, novas, job.progress?.newFolderId)
    if (!items.length) {
      job.download = { status: 'nada', destDir }
      return this.#emit(job)
    }
    try {
      const r = await this.baixar({ accountId: job.accountId, items, destDir })
      job.download = { status: 'na fila', destDir, count: r.count, bytes: r.bytes, batchId: r.batch?.id || null, skipped: (r.skipped || []).length }
    } catch (err) {
      this.ctx.log('copiar de link: download para a mídia falhou:', err?.stack || err)
      job.download = { status: 'erro', destDir, error: err?.message || 'Não consegui pôr os downloads na fila.' }
    }
    this.#emit(job)
  }

  #progress(job, p) {
    if (job.status !== 'running') return
    job.progress = p
    const wait = job.lastSent + EVENT_MS - Date.now()
    if (wait <= 0) return this.#emit(job)
    job.timer ??= setTimeout(() => {
      job.timer = null
      if (job.status === 'running') this.#emit(job)
    }, wait)
    job.timer.unref?.()
  }

  view(job = this.job) {
    if (!job) return null
    return { jobId: job.id, accountId: job.accountId, plano: job.plano, dest: job.dest, download: job.download || null, status: job.status, progress: job.progress, ...(job.error ? { error: job.error } : {}) }
  }

  #emit(job) {
    if (job.timer) clearTimeout(job.timer)
    job.timer = null
    job.lastSent = Date.now()
    this.ctx.hub?.send('copiar', this.view(job))
  }

  cancel(id) {
    if (this.job?.id !== id) return false
    this.job.ac.abort()
    return true
  }

  close() {
    this.job?.ac.abort()
    if (this.job?.timer) clearTimeout(this.job.timer)
  }
}

/** `baixar({ accountId, items, destDir, signal })`: planeja e põe na fila de downloads (routes.js, como o Baixar). */
export function registerCopiar({ route, ctx, account, HttpProblem, baixar }) {
  const jobs = new CopyJobs(ctx, { HttpProblem, baixar })

  route('POST', '/api/copiar/:acc/ler', async ({ params, body, signal }) => {
    account(params.acc)
    const ref = parseDriveLink(typeof body.link === 'string' ? body.link.slice(0, 4000) : '')
    if (!ref) throw new HttpProblem(400, 'Cole um link do Google Drive (pasta ou arquivo).')
    try {
      const plan = await lerLink(ctx.manager.driveFor(params.acc), ref, { signal })
      return { plano: jobs.keepPlan(params.acc, plan) }
    } catch (err) {
      if (isAbortError(err)) throw err
      if (err?.reason === 'muitosArquivos') throw new HttpProblem(413, err.message)
      throw new HttpProblem(400, readErrorMessage(err))
    }
  })

  route('POST', '/api/copiar/:acc', async ({ params, body }) => {
    account(params.acc)
    const d = body.dest
    if (!d || typeof d.id !== 'string' || !DRIVE_ID.test(d.id)) throw new HttpProblem(400, 'Escolha a pasta do Drive para onde copiar.')
    if (typeof body.planoId !== 'string') throw new HttpProblem(400, 'Leia o link primeiro.')
    const dest = { id: d.id, name: typeof d.name === 'string' && d.name ? d.name.slice(0, 255) : 'Meu Drive', path: typeof d.path === 'string' ? d.path.slice(0, 2000) : null, driveId: typeof d.driveId === 'string' && DRIVE_ID.test(d.driveId) ? d.driveId : null }
    if (body.localDir != null && (typeof body.localDir !== 'string' || body.localDir.length > 4096)) throw new HttpProblem(400, 'Pasta do computador inválida.')
    const localDir = body.localDir?.trim() || null
    jobs.planFor(params.acc, body.planoId)
    // Mídia física: a pasta precisa existir agora (disco que sumiu → nada começa).
    if (localDir) {
      const st = await fs.stat(localDir).catch(() => null)
      if (!st?.isDirectory()) throw new HttpProblem(400, 'Não encontrei essa pasta no computador. O disco está conectado?')
    }
    return { copia: jobs.start({ accountId: params.acc, planoId: body.planoId, dest, localDir }) }
  })

  route('GET', '/api/copiar', async () => ({ copia: jobs.view() }))

  route('DELETE', '/api/copiar/:id', async ({ params }) => ({ parou: jobs.cancel(params.id) }))

  return jobs
}
