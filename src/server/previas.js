// Rotas da prévia leve (docs/ARCHITECTURE.md, tabela da API): estado do conversor para os Ajustes, pular a prévia de
// um envio e o lote "Gerar prévias" da tela Drive (um por vez, progresso pelo SSE 'previas', no máximo 4×/s).
// Fica fora de routes.js para o arquivo das rotas não crescer; recebe dele o que precisa (sem import circular).
import fs from 'node:fs/promises'
import path from 'node:path'
import { expandHome } from '../local/fsbrowse.js'
import { newId } from '../util/ids.js'
import { gerarPreviasLote, originaisLocais, resumoPrevias } from '../media/previa-lote.js'
import { espacoLivre, isPrevia, procurarProxy } from '../media/previa-fila.js'
import { isBrawName, isVideoName } from '../media/previa.js'

const EVENT_MS = 250
const DRIVE_ID = /^[\w-]{1,200}$/

class PreviaJobs {
  constructor(ctx, { HttpProblem, toProblem }) {
    this.ctx = ctx
    this.HttpProblem = HttpProblem
    this.toProblem = toProblem
    this.job = null
  }

  running() {
    return this.job?.status === 'running' ? this.job : null
  }

  start({ accountId, driveFolderId, folderName, localDir, recursive, refazer, somente = null, forcar = false, baixar = false, dicas = null, arquivo = null }) {
    const gerador = this.ctx.manager.previas
    if (!gerador?.gerarESubir) throw new this.HttpProblem(409, 'A prévia leve está desligada neste app.')
    if (this.running()) throw new this.HttpProblem(409, 'Já estou gerando prévias. Espere terminar ou pare o lote atual.')
    const job = { id: newId('prv'), accountId, driveFolderId, folderName, localDir, recursive, refazer, baixar, arquivo, status: 'running', progress: null, error: null, ac: new AbortController(), lastSent: 0, timer: null }
    this.job = job
    this.#emit(job)
    ;(async () => {
      try {
        const s = await gerarPreviasLote({
          drive: this.ctx.manager.driveFor(accountId),
          gerador,
          driveFolderId,
          localDir,
          recursive,
          refazer,
          somente,
          forcar,
          baixar,
          dicas,
          signal: job.ac.signal,
          onProgress: p => this.#progress(job, p),
        })
        job.progress = { ...s }
        job.status = 'done'
        this.ctx.log(`prévias: ${resumoPrevias(s)}`)
      } catch (err) {
        if (job.ac.signal.aborted) {
          job.status = 'canceled'
          job.error = 'Parado. As prévias que já subiram ficam.'
        } else {
          const p = err?.status ? new this.HttpProblem(err.status, err.message) : this.toProblem(err)
          if (!p) this.ctx.log('gerar prévias falhou:', err?.stack || err)
          job.status = 'error'
          job.error = p?.message || 'O lote não terminou: algo deu errado no caminho.'
        }
      } finally {
        this.#emit(job)
      }
    })()
    return job.id
  }

  #progress(job, p) {
    if (job.status !== 'running') return
    job.progress = { ...p, falhas: p.falhas.slice(), semLocalNomes: p.semLocalNomes.slice(), tamanhoNomes: p.tamanhoNomes.slice(), feitosIds: p.feitosIds.slice() }
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
    return { jobId: job.id, accountId: job.accountId, driveFolderId: job.driveFolderId, folderName: job.folderName, localDir: job.localDir, recursive: job.recursive, refazer: job.refazer, baixar: job.baixar, arquivo: job.arquivo, status: job.status, progress: job.progress, ...(job.error ? { error: job.error } : {}) }
  }

  #emit(job) {
    if (job.timer) clearTimeout(job.timer)
    job.timer = null
    job.lastSent = Date.now()
    this.ctx.hub?.send('previas', this.view(job))
  }

  lookup(id) {
    return this.job?.id === id ? this.job : null
  }

  cancel(id) {
    const job = this.lookup(id)
    job?.ac.abort()
    return !!job
  }

  close() {
    this.job?.ac.abort()
    if (this.job?.timer) clearTimeout(this.job.timer)
  }
}

/**
 * Registra as rotas. Devolve { view() (para /api/state), close() }.
 * @param {{ route: Function, ctx: object, account: (id) => object, HttpProblem: Function, toProblem: Function }} o
 */
export function registerPrevias({ route, ctx, account, HttpProblem, toProblem }) {
  const jobs = new PreviaJobs(ctx, { HttpProblem, toProblem })

  // Ajustes: qual conversor este computador tem (e se a prévia está ligada).
  route('GET', '/api/previas', async ({ query }) => {
    const g = ctx.manager.previas
    const previas = g ? await g.status({ refresh: query.get('refresh') === '1' }) : { enabled: false, motor: { via: null, label: '', aviso: 'A prévia leve está desligada neste app.' }, fila: 0, atual: null, last: null }
    return { previas }
  })

  // Transferências: pular a prévia de um envio (a linha "Gerando prévia leve…").
  route('POST', '/api/previas/pular', ({ body }) => {
    const ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string').slice(0, 10_000) : null
    if (!ids?.length) throw new HttpProblem(400, 'Pedido inválido.')
    return { count: ctx.manager.previas?.cancel(ids) ?? 0 }
  })

  // "Gerar prévias" (tela Drive): acha os vídeos do Drive no computador, gera a cópia leve e sobe em Proxy/.
  route('POST', '/api/previas/lote', async ({ body }) => {
    const acc = account(body.accountId)
    const folderId = body.driveFolderId
    if (typeof folderId !== 'string' || !DRIVE_ID.test(folderId)) throw new HttpProblem(400, 'Escolha a pasta do Drive.')
    for (const k of ['recursive', 'refazer', 'forcar', 'baixar']) if (body[k] != null && typeof body[k] !== 'boolean') throw new HttpProblem(400, 'Pedido inválido.')
    const baixar = body.baixar === true
    let somente = null
    if (body.somente != null) {
      if (!Array.isArray(body.somente) || !body.somente.length || body.somente.length > 5000 || !body.somente.every(x => typeof x === 'string' && DRIVE_ID.test(x))) throw new HttpProblem(400, 'Pedido inválido.')
      somente = body.somente
    }
    // A pasta do computador é opcional quando o original vem da fila (envio que subiu ele) ou é baixado do Drive.
    const raw = body.localDir
    let localDir = null
    if (raw != null && raw !== '') {
      if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0') || raw.length > 4096) throw new HttpProblem(400, 'Escolha a pasta do computador onde estão os originais.')
      localDir = expandHome(raw)
      if (!path.isAbsolute(localDir)) throw new HttpProblem(400, 'Escolha a pasta do computador onde estão os originais.')
      let st
      try {
        st = await fs.stat(localDir)
      } catch {
        throw new HttpProblem(400, 'Não achei essa pasta no computador. O disco ou o cartão está conectado?')
      }
      if (!st.isDirectory()) throw new HttpProblem(400, 'Escolha uma pasta do computador (não um arquivo).')
    } else if (!baixar && !somente) {
      throw new HttpProblem(400, 'Escolha a pasta do computador onde estão os originais.')
    }
    const folderName = typeof body.folderName === 'string' ? body.folderName.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) : ''
    const arquivo = typeof body.arquivo === 'string' ? body.arquivo.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) : null
    const jobId = jobs.start({
      accountId: acc.id,
      driveFolderId: folderId,
      folderName,
      localDir,
      recursive: body.recursive !== false,
      refazer: body.refazer === true,
      somente,
      forcar: body.forcar === true,
      baixar,
      dicas: originaisLocais(ctx.manager, acc.id),
      arquivo,
    })
    if (localDir && ctx.settings.get().previaLocalDir !== localDir) {
      ctx.settings.update({ previaLocalDir: localDir }).catch(err => ctx.log('não consegui lembrar a pasta das prévias:', err?.message))
    }
    return { jobId }
  })

  // "Gerar proxy" de um arquivo (tela Drive): onde está o original, se já tem proxy, quanto baixar e o espaço livre.
  route('GET', '/api/previas/arquivo', async ({ query, signal }) => {
    const acc = account(query.get('accountId'))
    const id = query.get('id') || ''
    if (!DRIVE_ID.test(id)) throw new HttpProblem(400, 'Pedido inválido.')
    const drive = ctx.manager.driveFor(acc.id)
    const item = await drive.getItem(id, { signal, media: true })
    if (item.isFolder || !(isVideoName(item.name) || isBrawName(item.name))) throw new HttpProblem(400, 'Escolha um arquivo de vídeo.')
    const parentId = item.parents?.[0] || null
    const found = parentId ? await procurarProxy(drive, { parentId, name: item.name, driveId: item.driveId, excludeId: item.id, signal }) : { proxy: null }
    const p = originaisLocais(ctx.manager, acc.id).get(id)
    let local = null
    if (p) {
      const st = await fs.stat(p).catch(() => null)
      if (st?.isFile() && st.size === item.size) local = p
    }
    return {
      arquivo: { id: item.id, name: item.name, size: item.size, parentId, driveId: item.driveId },
      proxy: found.proxy ? { id: found.proxy.id, name: found.proxy.name, nosso: isPrevia(found.proxy) } : null,
      local,
      livre: await espacoLivre(),
    }
  })

  // Espaço livre onde os originais baixados do Drive ficam enquanto viram proxy.
  route('GET', '/api/previas/espaco', async () => ({ livre: await espacoLivre() }))

  route('GET', '/api/previas/lote/:jobId', ({ params }) => {
    const job = jobs.lookup(params.jobId)
    if (!job) throw new HttpProblem(404, 'Esse lote de prévias não existe mais.')
    return jobs.view(job)
  })

  route('DELETE', '/api/previas/lote/:jobId', ({ params }) => {
    if (!jobs.cancel(params.jobId)) throw new HttpProblem(404, 'Esse lote de prévias não existe mais.')
    return {}
  })

  // Transferências: proxy sim/não por arquivo (na fila, subindo ou já enviado: "Gerar proxy").
  route('POST', '/api/transfers/proxy', ({ body }) => {
    const ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string').slice(0, 100_000) : null
    if (!ids?.length || typeof body.proxy !== 'boolean') throw new HttpProblem(400, 'Pedido inválido.')
    return { count: ctx.manager.setProxy(ids, body.proxy) }
  })

  return { view: () => jobs.view(), close: () => jobs.close() }
}
