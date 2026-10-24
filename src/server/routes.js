// Rotas da API local (tabela em docs/ARCHITECTURE.md, "Servidor (src/server) — API").
// Cada rota devolve um objeto (vira { ok: true, ...objeto }) ou lança; o erro vira { ok: false, error } em PT-BR.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { APP_NAME, APP_VERSION, cloudUrl, validateSettings } from '../config.js'
import { classifyError } from '../google/errors.js'
import { FOLDER_MIME } from '../google/drive.js'
import { listDir, listRoots, expandHome } from '../local/fsbrowse.js'
import { planDownloads, planDownloadsFromCompare, planUploads, planUploadsFromCompare } from '../engine/planner.js'
import { compareFolders, loadCompare } from '../engine/compare.js'
import { writeJSONAtomic } from '../util/store.js'
import { newId } from '../util/ids.js'
import { isMacClutter } from '../util/paths.js'
import { isAbortError } from '../util/backoff.js'
import { qrSvg, shortcutSteps } from '../mobile/qr.js'
import { gerarMiniaturasLote, resumoLote } from '../media/raw-thumb-lote.js'
import { referenciasRoutes } from './referencias.js'
import { registerPrevias } from './previas.js'
import { registerTamanho } from './tamanho.js'
import { registerCopiar } from './copiar.js'
import { registerFrames } from './frames.js'
import { registerCenas } from './cenas.js'
import { registerDiscos } from './discos.js'
import { registerLan } from './lan.js'
import { registerCelular } from './celular.js'
import { registerBackup } from './backup.js'

const BODY_LIMIT = 1024 * 1024
const BODY_HARD_LIMIT = 16 * BODY_LIMIT // além disso nem lê o resto: derruba a conexão
const COMPARE_EVENT_MS = 250 // progresso da comparação: no máximo 4×/s
const KEEP_JOBS = 10 // comparações guardadas na memória (os resultados ficam no disco)
const KEEP_COMPARES = 20
const DRIVE_ID = /^[\w-]{1,200}$/ // ids e resourceKeys do Drive: letras, números, _ e -
const ACTIONS = ['pause', 'resume', 'cancel', 'retry', 'remove', 'prioritize']

/** Erro que já sabe o status HTTP e a mensagem para o usuário. */
export class HttpProblem extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpProblem'
    this.status = status
  }
}

export function baseHeaders(extra = {}) {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-resource-policy': 'same-origin',
    ...extra,
  }
}

export function sendJSON(res, status, body) {
  if (res.headersSent) {
    res.end()
    return
  }
  const json = JSON.stringify(body)
  res.writeHead(status, baseHeaders({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(json) }))
  res.end(json)
}

/** Qualquer erro → HttpProblem com mensagem para o usuário, ou null se for um defeito nosso (vira 500 genérico). */
export function toProblem(err) {
  if (err instanceof HttpProblem) return err
  if (isAbortError(err)) return new HttpProblem(499, 'Interrompido.')
  const fromGoogle = err?.name === 'HttpError' || err?.name === 'SobeDesceError'
  if (!fromGoogle && Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 && err.message) return new HttpProblem(err.status, err.message)
  const info = classifyError(err)
  if (!fromGoogle && info.kind !== 'retry') return null
  switch (info.kind) {
    case 'notfound':
      return new HttpProblem(404, info.message)
    case 'reauth':
      return new HttpProblem(401, info.message)
    case 'auth':
      return new HttpProblem(401, 'O Google recusou o acesso desta conta. Conecte a conta de novo.')
    case 'quota':
      return new HttpProblem(429, info.message)
    case 'retry':
      return new HttpProblem(503, 'Não consegui falar com o Google agora. Confira a internet e tente de novo.')
    default:
      return new HttpProblem(info.status === 400 || info.status === 403 ? info.status : 400, info.message)
  }
}

/** Corpo JSON (até 1 MB). Vazio = {}. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > BODY_LIMIT) return reject(new HttpProblem(413, 'O pedido é grande demais (limite de 1 MB).'))
    let size = 0
    let chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > BODY_HARD_LIMIT) return req.destroy()
      if (size > BODY_LIMIT) chunks = null
      else chunks?.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      if (!chunks) return reject(new HttpProblem(413, 'O pedido é grande demais (limite de 1 MB).'))
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      let data
      try {
        data = JSON.parse(text)
      } catch {
        return reject(new HttpProblem(400, 'JSON inválido.'))
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return reject(new HttpProblem(400, 'O corpo do pedido precisa ser um objeto JSON.'))
      resolve(data)
    })
  })
}

function redirect(res, location) {
  res.writeHead(302, baseHeaders({ location, 'cache-control': 'no-store', 'content-length': 0 }))
  res.end()
}

// ─────────── páginas do login (navegador) ───────────

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

function page({ title, heading, text, refresh = null, links = [], tone = 'ok' }) {
  const mark = tone === 'ok' ? '✓' : '!'
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} · SOBEDESCE</title>
${refresh ? `<meta http-equiv="refresh" content="1;url=${escapeHtml(refresh)}">` : ''}
<style>
:root{--bg:#FBFBFD;--fg:#1D1D1F;--muted:#6E6E73;--card:#fff;--line:#E5E5EA;--accent:${tone === 'ok' ? '#1F8A4C' : '#C4441C'}}
@media (prefers-color-scheme:dark){:root{--bg:#0B0B0C;--fg:#F5F5F7;--muted:#A1A1A6;--card:#161618;--line:#2C2C2E}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Inter",Roboto,sans-serif;padding:24px}
.card{max-width:440px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:32px 28px;text-align:center}
.mark{width:44px;height:44px;border-radius:50%;margin:0 auto 14px;display:grid;place-items:center;font-size:22px;font-weight:600;color:#fff;background:var(--accent)}
h1{font-size:21px;letter-spacing:-.01em;margin:0 0 8px}p{margin:0;color:var(--muted)}
.links{margin-top:22px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
a{color:var(--fg);text-decoration:none;border:1px solid var(--line);border-radius:10px;padding:8px 14px;font-weight:500}
a.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.brand{margin-top:26px;font-size:12px;letter-spacing:.14em;color:var(--muted)}
</style></head>
<body><main class="card"><div class="mark" aria-hidden="true">${mark}</div><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(text)}</p>
${links.length ? `<div class="links">${links.map(l => `<a href="${escapeHtml(l.href)}"${l.primary ? ' class="primary"' : ''}>${escapeHtml(l.label)}</a>`).join('')}</div>` : ''}
<div class="brand">SOBEDESCE</div></main></body></html>`
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8')
  res.writeHead(status, baseHeaders({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PAGE_CSP, 'content-length': body.length }))
  res.end(body)
}

function loginOkPage(account, desktop) {
  const who = account?.email ? `${account.email} já pode ser usada.` : 'A conta já pode ser usada.'
  if (desktop) return page({ title: 'Conta conectada', heading: 'Conta conectada', text: `${who} Pode voltar para o SOBEDESCE.` })
  return page({ title: 'Conta conectada', heading: 'Conta conectada', text: `${who} Voltando para o SOBEDESCE…`, refresh: '/#/transferencias', links: [{ href: '/#/transferencias', label: 'Abrir o SOBEDESCE', primary: true }] })
}

function loginErrorPage(message, desktop) {
  const links = [{ href: '/api/auth/start', label: 'Tentar de novo', primary: true }]
  if (!desktop) links.push({ href: '/#/inicio', label: 'Voltar para o SOBEDESCE' })
  return page({ title: 'Não deu para conectar', heading: 'Não deu para conectar a conta', text: message, links, tone: 'error' })
}

// ─────────── comparações ───────────

class CompareJobs {
  constructor(ctx) {
    this.ctx = ctx
    this.jobs = new Map()
  }

  start({ accountId, localPath, driveFolderId, mode }) {
    const id = newId('cmp')
    const job = { id, accountId, mode, status: 'running', progress: { phase: 'local', done: 0, total: 0, current: '' }, result: null, error: null, ac: new AbortController(), lastSent: 0, timer: null }
    this.jobs.set(id, job)
    this.#trim()
    this.#emit(job)
    const run = async () => {
      try {
        const result = await compareFolders({
          drive: this.ctx.manager.driveFor(accountId),
          localPath: expandHome(localPath),
          driveFolderId,
          mode,
          hasher: this.ctx.hasher,
          signal: job.ac.signal,
          onProgress: p => this.#progress(job, p),
          paths: this.ctx.paths,
          persist: false,
        })
        // O id do resultado é o do job: depois de reiniciar o app, GET /api/compare/:jobId ainda acha no disco.
        result.id = id
        result.accountId = accountId
        job.result = result
        job.status = 'done'
        await this.#save(result)
      } catch (err) {
        if (job.ac?.signal.aborted) {
          job.status = 'canceled'
          job.error = 'A comparação foi cancelada.'
        } else {
          const p = toProblem(err)
          if (!p) this.ctx.log('comparação falhou:', err?.stack || err)
          job.status = 'error'
          job.error = p?.message || 'A comparação não terminou: algo deu errado no caminho.'
        }
      } finally {
        job.ac = null
        this.#emit(job)
      }
    }
    run()
    return id
  }

  #progress(job, p) {
    if (!p || job.status !== 'running') return
    job.progress = { phase: p.phase, done: p.done ?? 0, total: p.total ?? 0, current: p.current ?? '' }
    if (p.bytesTotal != null) Object.assign(job.progress, { bytesDone: p.bytesDone ?? 0, bytesTotal: p.bytesTotal })
    const wait = job.lastSent + COMPARE_EVENT_MS - Date.now()
    if (wait <= 0) return this.#emit(job)
    job.timer ??= setTimeout(() => {
      job.timer = null
      if (job.status === 'running') this.#emit(job)
    }, wait)
    job.timer.unref?.()
  }

  #emit(job) {
    if (job.timer) clearTimeout(job.timer)
    job.timer = null
    job.lastSent = Date.now()
    this.ctx.hub?.send('compare', { jobId: job.id, status: job.status, progress: job.progress, ...(job.error ? { error: job.error } : {}) })
  }

  async #save(result) {
    const dir = this.ctx.paths.compares
    try {
      await writeJSONAtomic(path.join(dir, `${result.id}.json`), result)
      const names = (await fs.readdir(dir)).filter(n => /^cmp[A-Za-z0-9_-]*\.json$/.test(n)).sort()
      await Promise.all(names.slice(0, Math.max(0, names.length - KEEP_COMPARES)).map(n => fs.rm(path.join(dir, n), { force: true }).catch(() => {})))
    } catch (err) {
      // Sem gravar, o resultado vale enquanto o app estiver aberto.
      this.ctx.log('não consegui gravar a comparação:', err?.message)
    }
  }

  #trim() {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= KEEP_JOBS) break
      if (job.status !== 'running') this.jobs.delete(id)
    }
  }

  /** Job da memória ou resultado gravado (depois de reiniciar). */
  async lookup(jobId) {
    const job = this.jobs.get(jobId)
    if (job) return job
    const result = await loadCompare(jobId, this.ctx.paths).catch(() => null)
    if (!result?.files) return null
    const n = result.summary?.files ?? result.files.length
    return { id: jobId, accountId: result.accountId ?? null, status: 'done', progress: { phase: 'match', done: n, total: n, current: '' }, result, error: null }
  }

  cancel(jobId) {
    const job = this.jobs.get(jobId)
    job?.ac?.abort()
    return !!job
  }

  /** "Limpar comparação": para se ainda roda, tira da memória e apaga o resultado gravado. */
  async forget(jobId) {
    const job = this.jobs.get(jobId)
    job?.ac?.abort()
    if (job?.timer) clearTimeout(job.timer)
    this.jobs.delete(jobId)
    if (/^cmp[A-Za-z0-9_-]{0,100}$/.test(jobId)) await fs.rm(path.join(this.ctx.paths.compares, `${jobId}.json`), { force: true }).catch(() => {})
  }

  close() {
    for (const job of this.jobs.values()) {
      job.ac?.abort()
      if (job.timer) clearTimeout(job.timer)
      job.timer = null
    }
  }
}

// ─────────── "Gerar miniaturas" (RAW que já estão no Drive) ───────────

/**
 * Um lote por vez (decodificar RAW pesa e divide a fila com os envios). Progresso pelo SSE ('rawthumbs', no
 * máximo 4×/s) e por GET; o último lote fica guardado para a interface mostrar o resumo depois.
 */
class RawThumbJobs {
  constructor(ctx) {
    this.ctx = ctx
    this.job = null
  }

  running() {
    return this.job?.status === 'running' ? this.job : null
  }

  start({ accountId, driveFolderId, folderName, localDir, recursive, refazer }) {
    const thumbnailer = this.ctx.manager.thumbnailer
    if (!thumbnailer?.frameFor) throw new HttpProblem(409, 'Este computador não tem como tirar o frame dos RAW.')
    if (this.running()) throw new HttpProblem(409, 'Já estou gerando miniaturas. Espere terminar ou pare o lote atual.')
    const id = newId('thb')
    const job = { id, accountId, driveFolderId, folderName, localDir, recursive, refazer, status: 'running', progress: null, error: null, ac: new AbortController(), lastSent: 0, timer: null }
    this.job = job
    this.#emit(job)
    const run = async () => {
      try {
        const s = await gerarMiniaturasLote({
          drive: this.ctx.manager.driveFor(accountId),
          driveFolderId,
          localDir,
          recursive,
          refazer,
          frame: (file, opts) => thumbnailer.frameFor(file, opts),
          signal: job.ac.signal,
          onProgress: p => this.#progress(job, p),
        })
        job.progress = { ...s }
        job.status = 'done'
        this.ctx.log(`miniaturas: ${resumoLote(s)}`)
      } catch (err) {
        if (job.ac.signal.aborted) {
          job.status = 'canceled'
          job.error = 'Parado. As miniaturas que já foram gravadas ficam.'
        } else {
          const p = toProblem(err)
          if (!p) this.ctx.log('gerar miniaturas falhou:', err?.stack || err)
          job.status = 'error'
          job.error = p?.message || 'O lote não terminou: algo deu errado no caminho.'
        }
      } finally {
        // As miniaturas novas: o servidor esquece o que sabia (a tela pede de novo).
        if (job.progress?.feitosIds?.length) this.ctx.media?.forget?.(accountId, job.progress.feitosIds)
        this.#emit(job)
      }
    }
    run()
    return id
  }

  #progress(job, p) {
    if (job.status !== 'running') return
    job.progress = { ...p, falhas: p.falhas.slice(), semLocalNomes: p.semLocalNomes.slice(), tamanhoNomes: p.tamanhoNomes.slice(), feitosIds: p.feitosIds.slice() }
    const wait = job.lastSent + COMPARE_EVENT_MS - Date.now()
    if (wait <= 0) return this.#emit(job)
    job.timer ??= setTimeout(() => {
      job.timer = null
      if (job.status === 'running') this.#emit(job)
    }, wait)
    job.timer.unref?.()
  }

  view(job = this.job) {
    if (!job) return null
    return { jobId: job.id, accountId: job.accountId, driveFolderId: job.driveFolderId, folderName: job.folderName, localDir: job.localDir, recursive: job.recursive, refazer: job.refazer, status: job.status, progress: job.progress, ...(job.error ? { error: job.error } : {}) }
  }

  #emit(job) {
    if (job.timer) clearTimeout(job.timer)
    job.timer = null
    job.lastSent = Date.now()
    this.ctx.hub?.send('rawthumbs', this.view(job))
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

// ─────────── rotas ───────────

function match(pattern, segs) {
  if (pattern.length !== segs.length) return null
  const params = {}
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]
    if (p.startsWith(':')) {
      try {
        params[p.slice(1)] = decodeURIComponent(segs[i])
      } catch {
        return null
      }
    } else if (p !== segs[i]) return null
  }
  return params
}

/** Finder/Explorer já selecionam o item; no Linux não há padrão para isso, então abre a pasta onde ele está. */
function revealCommand(platform, target) {
  if (platform === 'darwin') return ['open', ['-R', target]]
  if (platform === 'win32') return ['explorer.exe', ['/select,', target]]
  return ['xdg-open', [path.dirname(target)]]
}

/**
 * @param {object} ctx { settings, auth, manager, hasher, paths, hub, port, desktop, mobile, versao, spawn, platform, log }
 * @returns {{ dispatch(req, res, url): Promise<boolean>, state(): object, close(): void }}
 */
export function createApi(ctx) {
  const routes = []
  const route = (method, pattern, handler, { raw = false, corpo = true } = {}) => routes.push({ method, pattern: pattern.split('/').filter(Boolean), handler, raw, corpo })
  const jobs = new CompareJobs(ctx)
  const thumbJobs = new RawThumbJobs(ctx)

  const state = () => {
    const snap = ctx.manager.snapshot()
    return {
      app: { name: APP_NAME, version: APP_VERSION, platform: process.platform, desktop: !!ctx.desktop, protecao: ctx.auth?.protecao || 'arquivo' },
      setup: ctx.auth.getClientInfo(),
      accounts: ctx.auth.listAccounts(),
      cloud: ctx.auth.cloud?.status() ?? null,
      settings: ctx.settings.get(),
      transfers: snap.transfers,
      batches: snap.batches,
      stats: snap.stats,
      // Chave das rotas de mídia (<img>/<video> não mandam cabeçalho): só a interface lê /api/state.
      media: ctx.media ? { key: ctx.media.key } : null,
      // "Gerar miniaturas": o lote atual (ou o último), para a interface voltar a mostrar depois de reconectar.
      rawThumbs: thumbJobs.view(),
      // Aviso de versão nova (src/version.js): build deste app, o mais novo conhecido e se mostra o aviso.
      versao: ctx.versao?.status() ?? null,
      // Referências (src/referencias/service.js): se está liberado, os downloads em andamento e os que deram erro.
      referencias: ctx.referencias?.status() ?? null,
      // "Gerar prévias": o lote atual (ou o último).
      previas: previas.view(),
      // "Copiar de um link": a cópia atual (ou a última).
      copia: copias.view(),
      // Frames: o trabalho atual (ou o último).
      frames: frames.view(),
      // Busca por cena: o modelo (baixado ou não) e a fila de análise.
      cenas: cenas.view(),
      // Copiar entre discos: o plano (comparação) e a cópia atual (ou a última).
      discos: discos.view(),
      // Entre computadores: recepção pela rede (ligada?, recebendo) e o envio atual.
      lan: lan.view(),
      // Celular pelo Wi-Fi: celulares online, o ajuste e o que está passando.
      celular: celular.view(),
      // Backup Automático: o projeto aberto, os cartões espetados, a descarga de agora e a última.
      backup: backup.view(),
    }
  }

  const account = id => {
    const acc = typeof id === 'string' && id ? ctx.auth.listAccounts().find(a => a.id === id) : null
    if (!acc) throw new HttpProblem(404, 'Conta não encontrada. Conecte a conta de novo.')
    return acc
  }

  /** Nome de pasta para mostrar (sem controle, até 255). '' → null. */
  const destName = v => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255) : '') || null

  const enqueue = async plan => {
    const added = plan.records?.length ? await ctx.manager.add({ batch: plan.batch, records: plan.records }) : { records: [] }
    let bytes = 0
    for (const r of added.records) bytes += r.size || 0
    return { batch: plan.batch, count: added.records.length, bytes, skipped: plan.skipped || [], warnings: plan.warnings || [] }
  }

  const compareJob = async jobId => {
    const job = await jobs.lookup(jobId)
    if (!job) throw new HttpProblem(404, 'Essa comparação não existe mais. Compare de novo.')
    return job
  }

  const finishedJob = async (jobId, body) => {
    const job = await compareJob(jobId)
    if (job.status !== 'done' || !job.result) throw new HttpProblem(409, 'A comparação ainda não terminou.')
    const acc = account(job.accountId || job.result.accountId || body.accountId)
    return { job, acc }
  }

  // Prévia leve (src/server/previas.js): /api/previas, /api/previas/pular e o lote /api/previas/lote.
  const previas = registerPrevias({ route, ctx, account, HttpProblem, toProblem })

  // Tamanho das pastas (src/server/tamanho.js): /api/drive/:acc/tamanho.
  const tamanhos = registerTamanho({ route, ctx, account, HttpProblem, toProblem })

  // Copiar de um link do Drive para uma pasta da conta (src/server/copiar.js): /api/copiar.
  const copias = registerCopiar({
    route,
    ctx,
    account,
    HttpProblem,
    // "Também baixar para…": o mesmo caminho do Baixar (planDownloads + fila), com a árvore que a cópia já leu.
    baixar: async ({ accountId, items, destDir, signal }) => {
      const st = ctx.settings.get()
      const plan = await planDownloads({ drive: ctx.manager.driveFor(accountId), accountId, items, destDir, conflict: st.downloadConflict, signal, reservedPaths: ctx.manager.reservedPaths() })
      if (plan.batch) plan.batch.destino = path.basename(path.resolve(destDir)) || null
      return enqueue(plan)
    },
  })

  // Frames (src/server/frames.js): frames, takes e posts de um vídeo final; a pasta pronta sobe pela fila de envio.
  const frames = registerFrames({
    route,
    ctx,
    account,
    HttpProblem,
    baseHeaders,
    subir: async ({ accountId, pasta, folderId, driveId, name }) => {
      const plan = await planUploads({ drive: ctx.manager.driveFor(accountId), accountId, paths: [pasta], destFolderId: folderId, driveId, signal: undefined })
      for (const r of plan.records || []) r.proxy = false
      if (plan.batch) plan.batch.destino = name || null
      return enqueue(plan)
    },
  })

  // Busca por cena (src/server/cenas.js): analisar os vídeos de uma pasta e procurar por texto, tudo no computador.
  const cenas = registerCenas({ route, ctx, account, HttpProblem, baseHeaders, servico: ctx.cenasServico })
  // Copiar entre discos (src/server/discos.js): cartão/SSD → um ou mais SSDs, com MD5 conferido.
  const discos = registerDiscos({ route, ctx, HttpProblem, servico: ctx.discosServico })
  // Entre computadores (src/server/lan.js): manda e recebe arquivos pela rede local, entre computadores da mesma conta.
  const lan = registerLan({ route, ctx, account, HttpProblem, receptor: ctx.lanReceptor, enviador: ctx.lanEnviador })
  // Celular ↔ computador pelo Wi-Fi (src/server/celular.js): o celular da conta manda e recebe direto, por WebRTC.
  const celular = registerCelular({ route, ctx, HttpProblem, baseHeaders, wifi: ctx.celularWifi })
  // Backup Automático (src/server/backup.js): Cartões → Projetos; cada cartão espetado é descarregado sozinho.
  const backup = registerBackup({ route, ctx, HttpProblem, servico: ctx.backupServico })

  const stringList = (v, max = 10_000) => (Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, max) : null)

  // ── Referências (src/server/referencias.js)
  referenciasRoutes(route, ctx)

  // ── estado e eventos
  route('GET', '/api/state', () => state())
  route('GET', '/api/events', ({ req, res }) => ctx.hub.attach(req, res, state()), { raw: true })

  // ── chave do Google e login
  route('POST', '/api/setup/credentials', async ({ body }) => {
    let input = body
    if (body.json !== undefined) input = body.json
    else if (body.clientId !== undefined || body.clientSecret !== undefined) input = { clientId: body.clientId, clientSecret: body.clientSecret }
    const setup = await ctx.auth.setClientCredentials(input)
    ctx.hub?.send('setup', setup)
    return { setup }
  })

  route('GET', '/api/auth/start', ({ res }) => {
    if (!ctx.auth.hasClientCredentials()) return redirect(res, '/#/inicio')
    try {
      const { url } = ctx.auth.beginLogin(`http://127.0.0.1:${ctx.port}/oauth/callback`)
      redirect(res, url)
    } catch (err) {
      sendHtml(res, 400, loginErrorPage(toProblem(err)?.message || 'Não consegui começar o login. Tente de novo.', ctx.desktop))
    }
  }, { raw: true })

  route('GET', '/oauth/callback', async ({ res, query }) => {
    try {
      const acc = await ctx.auth.completeLogin({ code: query.get('code'), state: query.get('state'), error: query.get('error') })
      sendHtml(res, 200, loginOkPage(acc, ctx.desktop))
    } catch (err) {
      const p = toProblem(err)
      if (!p) ctx.log('login falhou:', err?.stack || err)
      sendHtml(res, 400, loginErrorPage(p?.message || 'Não consegui concluir o login. Tente conectar de novo.', ctx.desktop))
    }
  }, { raw: true })

  // ── conta SOBEDESCE (fluxo de dispositivo; docs/CONTAS.md §7)
  const cloud = () => {
    if (!ctx.auth.cloud) throw new HttpProblem(404, 'A conta SOBEDESCE não está disponível nesta versão.')
    return ctx.auth.cloud
  }

  route('GET', '/api/cloud', () => ({ cloud: cloud().status() }))

  // Devolve o código e o endereço; a interface abre o navegador (window.sobedesce.openExternal no app, nova aba no navegador).
  route('POST', '/api/cloud/login', async () => {
    const c = cloud()
    try {
      await c.beginLogin()
    } catch (err) {
      // A mensagem já fala do site (não do Google): vai como está.
      if (err?.name === 'SobeDesceError') throw new HttpProblem(err.kind === 'retry' ? 503 : 502, err.message)
      throw err
    }
    return { cloud: c.status() }
  })

  route('POST', '/api/cloud/login/cancel', () => ({ cloud: cloud().cancelLogin() }))

  route('POST', '/api/cloud/logout', async () => ({ cloud: await cloud().signOut() }))

  route('POST', '/api/cloud/refresh', async () => ({ cloud: await cloud().refresh({ full: true }) }))

  route('DELETE', '/api/accounts/:id', async ({ params }) => {
    account(params.id)
    return { accounts: await ctx.auth.removeAccount(params.id) }
  })

  // ── Drive
  route('GET', '/api/drive/:acc/about', async ({ params, signal }) => {
    account(params.acc)
    return { about: await ctx.manager.driveFor(params.acc).about({ signal }) }
  })

  route('GET', '/api/drive/:acc/drives', async ({ params, signal }) => {
    account(params.acc)
    return { drives: await ctx.manager.driveFor(params.acc).listSharedDrives({ signal }) }
  })

  route('GET', '/api/drive/:acc/list', async ({ params, query, signal }) => {
    account(params.acc)
    const drive = ctx.manager.driveFor(params.acc)
    let folderId = query.get('folderId') || 'root'
    // media: a pasta aberta também diz se a conta pode pôr coisas nela (canAddChildren: "Enviar para esta pasta").
    let item = await drive.getItem(folderId, { signal, resourceKey: query.get('resourceKey') || undefined, media: true })
    // Atalho para pasta: abre a pasta de verdade.
    if (item.isShortcut && item.shortcutTargetId && item.shortcutTargetMimeType === FOLDER_MIME) {
      folderId = item.shortcutTargetId
      item = await drive.getItem(folderId, { signal, resourceKey: item.shortcutTargetResourceKey || undefined, media: true })
    }
    if (!item.isFolder) throw new HttpProblem(400, 'Isso não é uma pasta.')
    const [crumbs, items] = await Promise.all([drive.getPath(folderId, { signal }), drive.listChildren(folderId, { signal, media: true })])
    ctx.media?.remember(params.acc, items)
    const folder = { ...item }
    if (folderId === 'root') {
      folder.id = 'root'
      folder.name = 'Meu Drive'
    } else if (crumbs.length) folder.name = crumbs[crumbs.length - 1].name
    return { folder, path: crumbs, items }
  })

  route('GET', '/api/drive/:acc/search', async ({ params, query, signal }) => {
    account(params.acc)
    const q = (query.get('q') || '').trim()
    if (!q) return { items: [] }
    const items = await ctx.manager.driveFor(params.acc).search(q.slice(0, 200), { signal, media: true })
    ctx.media?.remember(params.acc, items)
    return { items }
  })

  // Seletor de pasta: busca só pastas, no escopo aberto (Meu Drive ou um drive compartilhado).
  route('GET', '/api/drive/:acc/pastas', async ({ params, query, signal }) => {
    account(params.acc)
    const q = (query.get('q') || '').trim()
    if (!q) return { items: [] }
    const escopo = query.get('escopo') || 'root'
    if (escopo !== 'root' && !DRIVE_ID.test(escopo)) throw new HttpProblem(400, 'Onde buscar? Escolha Meu Drive ou um drive compartilhado.')
    const items = await ctx.manager.driveFor(params.acc).searchFolders(q.slice(0, 200), { signal, driveId: escopo === 'root' ? null : escopo })
    return { items }
  })

  // ── Copiar link (mandar para o cliente): o link do item e quem consegue abrir.
  const linkTarget = (query) => {
    const id = typeof query.id === 'string' ? query.id : ''
    if (!DRIVE_ID.test(id)) throw new HttpProblem(400, 'Item inválido.')
    const rk = typeof query.rk === 'string' && DRIVE_ID.test(query.rk) ? query.rk : undefined
    return { id, resourceKey: rk }
  }

  route('GET', '/api/drive/:acc/link', async ({ params, query, signal }) => {
    account(params.acc)
    const { id, resourceKey } = linkTarget({ id: query.get('id'), rk: query.get('rk') })
    return { link: await ctx.manager.driveFor(params.acc).sharing(id, { signal, resourceKey }) }
  })

  // Libera para "qualquer pessoa com o link" (leitor). Só com `confirmado: true`, que a tela manda depois de a pessoa
  // ler "Qualquer pessoa com o link vai poder ver e baixar" e clicar em Liberar. Nada no app chama isto sozinho.
  route('POST', '/api/drive/:acc/link/liberar', async ({ params, body, signal }) => {
    account(params.acc)
    if (body.confirmado !== true) throw new HttpProblem(400, 'Confirme na tela antes de liberar o link.')
    const { id, resourceKey } = linkTarget(body)
    if (id === 'root') throw new HttpProblem(400, 'O Meu Drive inteiro não pode ser liberado. Escolha uma pasta dentro dele.')
    const drive = ctx.manager.driveFor(params.acc)
    const before = await drive.sharing(id, { signal, resourceKey })
    if (before.root) throw new HttpProblem(400, before.sharedDrive ? 'A raiz de um drive compartilhado não pode ser liberada para qualquer pessoa. Libere uma pasta dentro dele.' : 'O Meu Drive inteiro não pode ser liberado. Escolha uma pasta dentro dele.')
    if (before.access === 'qualquer') return { link: before }
    if (!before.canShare) throw new HttpProblem(403, 'Sua conta não pode mudar o compartilhamento deste item. Peça a quem é dono ou gerente.')
    await drive.shareWithAnyone(before.id, { signal, resourceKey })
    ctx.log?.(`link liberado para qualquer pessoa: ${before.id}`)
    return { link: await drive.sharing(before.id, { signal, resourceKey }) }
  })

  // ── Arquivos do Mac (._A003_C001.braw, .DS_Store, Thumbs.db) que vieram junto com os originais: para a lixeira do
  // Drive (recuperável por 30 dias). Só com `confirmado: true`, que a tela manda depois de a pessoa ler o aviso e clicar
  // em "Mover para a lixeira". A tela manda os ids em lotes pequenos (mostra o progresso); aqui a pasta é listada de
  // novo e só vai o que é filho dela E passa por isMacClutter (._ com menos de 4 MB, .DS_Store, Thumbs.db). O resto
  // volta em `pulados`. Cada files.update passa pelo limitador de metadados da conta (drive.api).
  const LIXEIRA_LOTE = 50
  const LIXEIRA_PARALELO = 4
  route('POST', '/api/drive/:acc/lixeira/mac', async ({ params, body, signal }) => {
    account(params.acc)
    if (body.confirmado !== true) throw new HttpProblem(400, 'Confirme na tela antes de mover para a lixeira.')
    const folderId = typeof body.folderId === 'string' && DRIVE_ID.test(body.folderId) ? body.folderId : null
    if (!folderId) throw new HttpProblem(400, 'Pasta inválida.')
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids)] : []
    if (!ids.length || ids.length > LIXEIRA_LOTE || !ids.every(id => typeof id === 'string' && DRIVE_ID.test(id))) {
      throw new HttpProblem(400, `Mande de 1 a ${LIXEIRA_LOTE} arquivos por vez.`)
    }
    const drive = ctx.manager.driveFor(params.acc)
    const filhos = new Map((await drive.listChildren(folderId, { signal })).map(it => [it.id, it]))
    const movidos = []
    const pulados = []
    const recusados = []
    const fila = []
    for (const id of ids) {
      const it = filhos.get(id)
      if (!it) pulados.push({ id, motivo: 'Não está mais nesta pasta.' })
      else if (!isMacClutter(it)) pulados.push({ id, name: it.name, motivo: 'Não é arquivo de controle do Mac: fica onde está.' })
      else fila.push(it)
    }
    let compartilhado = false
    const um = async it => {
      try {
        await drive.trash(it.id, { signal })
        movidos.push(it.id)
      } catch (err) {
        const info = classifyError(err)
        if (info.kind === 'abort' || info.kind === 'auth' || info.kind === 'reauth') throw err
        if (info.status === 403 && it.driveId) compartilhado = true
        recusados.push({ id: it.id, name: it.name, status: info.status ?? null, error: info.message })
      }
    }
    for (let i = 0; i < fila.length; i += LIXEIRA_PARALELO) await Promise.all(fila.slice(i, i + LIXEIRA_PARALELO).map(um))
    if (movidos.length) ctx.log?.(`lixeira: ${movidos.length} arquivo(s) do Mac em ${folderId}`)
    // Nada foi e foi tudo recusa de permissão: responde como recusa (a tela mostra e para).
    if (!movidos.length && recusados.length && recusados.every(r => r.status === 403)) {
      throw new HttpProblem(403, compartilhado
        ? 'Sua conta não pode mover arquivos para a lixeira neste drive compartilhado. Isso pede acesso de Administrador de conteúdo ou Administrador.'
        : 'Sua conta não pode mover estes arquivos para a lixeira. Peça a quem é dono da pasta.')
    }
    return { movidos, pulados, recusados }
  })

  // ── miniaturas e prévia (src/server/media.js): chave `k` da interface, conta e id na query
  const mediaTarget = (req, query) => {
    if (!ctx.media) throw new HttpProblem(404, 'A prévia não está disponível nesta versão.')
    ctx.media.check(req, query) // antes de tudo: sem a chave não dá nem para saber se a conta existe
    const acc = account(query.get('account'))
    const id = query.get('id') || ''
    if (!DRIVE_ID.test(id)) throw new HttpProblem(400, 'Arquivo inválido.')
    const rk = query.get('rk') || ''
    return { accountId: acc.id, id, resourceKey: DRIVE_ID.test(rk) ? rk : null }
  }

  route('GET', '/api/drive/thumb', async ({ req, res, query, signal }) => {
    const t = mediaTarget(req, query)
    const img = await ctx.media.thumb({ ...t, size: query.get('s'), version: (query.get('v') || '').slice(0, 64), signal })
    res.writeHead(200, baseHeaders({
      'content-type': img.type,
      'content-length': img.buf.length,
      'cache-control': 'private, max-age=86400',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-sobedesce-cache': img.source,
    }))
    res.end(img.buf)
  }, { raw: true })

  // Proxy de câmera para a prévia (arquivo que não toca no Chromium). JSON comum: { proxy: DriveItem|null }.
  route('GET', '/api/drive/:acc/proxy', async ({ params, query, signal }) => {
    account(params.acc)
    if (!ctx.media) return { proxy: null }
    const id = query.get('id') || ''
    if (!DRIVE_ID.test(id)) throw new HttpProblem(400, 'Arquivo inválido.')
    const rk = query.get('rk') || ''
    return { proxy: await ctx.media.findProxy(params.acc, id, { resourceKey: DRIVE_ID.test(rk) ? rk : null, signal }) }
  })

  const stream = async ({ req, res, query, signal }) => {
    const t = mediaTarget(req, query)
    await ctx.media.stream({ req, res, ...t, signal })
  }
  route('GET', '/api/drive/stream', stream, { raw: true })
  route('HEAD', '/api/drive/stream', stream, { raw: true })

  route('POST', '/api/drive/:acc/folders', async ({ params, body, signal }) => {
    account(params.acc)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) throw new HttpProblem(400, 'Dê um nome para a pasta.')
    if (name.length > 255) throw new HttpProblem(400, 'Nome de pasta longo demais.')
    const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : 'root'
    return { item: await ctx.manager.driveFor(params.acc).createFolder(name, parentId, { signal }) }
  })

  // ── Compartilhados comigo: o que outras pessoas compartilharam com a conta (pastas abrem pelo /list de sempre).
  route('GET', '/api/drive/:acc/compartilhados', async ({ params, signal }) => {
    account(params.acc)
    const items = await ctx.manager.driveFor(params.acc).listSharedWithMe({ signal, media: true })
    ctx.media?.remember(params.acc, items)
    return { items }
  })

  // ── Renomear (menu de contexto da tela Drive).
  route('POST', '/api/drive/:acc/renomear', async ({ params, body, signal }) => {
    account(params.acc)
    const id = typeof body.id === 'string' ? body.id : ''
    if (!DRIVE_ID.test(id) || id === 'root') throw new HttpProblem(400, 'Item inválido.')
    const name = typeof body.name === 'string' ? body.name.replace(/[\u0000-\u001f\u007f]/g, '').trim() : ''
    if (!name) throw new HttpProblem(400, 'Dê um nome.')
    if (name.length > 255) throw new HttpProblem(400, 'Nome longo demais.')
    if (name.includes('/')) throw new HttpProblem(400, 'O nome não pode ter “/”.')
    return { item: await ctx.manager.driveFor(params.acc).rename(id, name, { signal }) }
  })

  // ── Mover para… (menu de contexto e arrastar e soltar): de 1 a 50 itens para uma pasta. Um de cada vez (cada
  // files.update passa pelo limitador da conta). O que não deu volta em `recusados`; nada movido e tudo recusado →
  // erro com a mensagem do primeiro (a tela mostra).
  const MOVER_LOTE = 50
  route('POST', '/api/drive/:acc/mover', async ({ params, body, signal }) => {
    account(params.acc)
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids)] : []
    if (!ids.length || ids.length > MOVER_LOTE || !ids.every(id => typeof id === 'string' && DRIVE_ID.test(id) && id !== 'root')) {
      throw new HttpProblem(400, `Mande de 1 a ${MOVER_LOTE} itens por vez.`)
    }
    const destId = typeof body.destId === 'string' && DRIVE_ID.test(body.destId) ? body.destId : null
    if (!destId) throw new HttpProblem(400, 'Escolha a pasta de destino.')
    const drive = ctx.manager.driveFor(params.acc)
    const movidos = []
    const ja = []
    const recusados = []
    for (const id of ids) {
      try {
        const r = await drive.move(id, destId, { signal })
        ;(r.moved ? movidos : ja).push(id)
      } catch (err) {
        const info = classifyError(err)
        if (info.kind === 'abort' || info.kind === 'auth' || info.kind === 'reauth' || info.kind === 'retry' || info.kind === 'quota') throw err
        recusados.push({ id, status: info.status ?? null, error: info.message })
      }
    }
    if (movidos.length) ctx.log?.(`mover: ${movidos.length} item(ns) para ${destId}`)
    if (!movidos.length && !ja.length && recusados.length) {
      const st = recusados[0].status
      throw new HttpProblem(st === 400 || st === 403 || st === 404 ? st : 400, recusados[0].error)
    }
    return { movidos, ja, recusados }
  })

  // ── disco local
  route('GET', '/api/local/roots', async () => ({ roots: await listRoots(), home: os.homedir(), sep: path.sep }))

  route('GET', '/api/local/list', async ({ query }) => {
    const hidden = query.get('hidden')
    return listDir(query.get('path') || os.homedir(), { showHidden: hidden === '1' || hidden === 'true' })
  })

  // ── transferências
  route('POST', '/api/transfers/download', async ({ body, signal }) => {
    const acc = account(body.accountId)
    if (!Array.isArray(body.items) || !body.items.length) throw new HttpProblem(400, 'Escolha pelo menos um item do Drive.')
    if (body.destDir != null && typeof body.destDir !== 'string') throw new HttpProblem(400, 'Pasta de destino inválida.')
    const st = ctx.settings.get()
    const plan = await planDownloads({
      drive: ctx.manager.driveFor(acc.id),
      accountId: acc.id,
      items: body.items,
      destDir: body.destDir || st.downloadDir,
      conflict: typeof body.conflict === 'string' ? body.conflict : st.downloadConflict,
      signal,
      reservedPaths: ctx.manager.reservedPaths(),
    })
    // Nome da pasta de destino, para o "Acompanhar pelo celular" (src/engine/acompanhar.js).
    if (plan.batch) plan.batch.destino = path.basename(path.resolve(body.destDir || st.downloadDir)) || null
    return enqueue(plan)
  })

  route('POST', '/api/transfers/upload', async ({ body, signal }) => {
    const acc = account(body.accountId)
    const paths = stringList(body.paths)
    if (!paths?.length) throw new HttpProblem(400, 'Escolha pelo menos um arquivo ou pasta.')
    if (body.destFolderId != null && typeof body.destFolderId !== 'string') throw new HttpProblem(400, 'Pasta de destino inválida.')
    // `conflict` não entra aqui: o envio aplica o ajuste uploadConflict na hora de subir.
    const plan = await planUploads({
      drive: ctx.manager.driveFor(acc.id),
      accountId: acc.id,
      paths,
      destFolderId: body.destFolderId || 'root',
      driveId: typeof body.driveId === 'string' && body.driveId ? body.driveId : null,
      signal,
    })
    // Proxy (prévia leve) deste envio: a escolha da tela; sem ela, o ajuste vale na hora de gerar.
    if (body.proxy != null && typeof body.proxy !== 'boolean') throw new HttpProblem(400, 'Pedido inválido.')
    if (typeof body.proxy === 'boolean') for (const r of plan.records || []) r.proxy = body.proxy
    // Nome da pasta do Drive (a interface conta, quando sabe), para o "Acompanhar pelo celular".
    if (plan.batch) plan.batch.destino = destName(body.destName) || ((body.destFolderId || 'root') === 'root' && !body.driveId ? 'Meu Drive' : null)
    return enqueue(plan)
  })

  route('POST', '/api/transfers/action', async ({ body }) => {
    const action = body.action
    if (!ACTIONS.includes(action)) throw new HttpProblem(400, 'Ação desconhecida.')
    let ids
    if (typeof body.batchId === 'string' && body.batchId) ids = ctx.manager.idsOfBatch(body.batchId)
    else if (body.ids === 'all') {
      if (!['pause', 'resume', 'retry'].includes(action)) throw new HttpProblem(400, 'Escolha quais transferências.')
      ids = 'all'
    } else {
      ids = stringList(body.ids)
      if (!ids) throw new HttpProblem(400, 'Escolha quais transferências.')
    }
    await ctx.manager[action](ids)
    return {}
  })

  route('POST', '/api/transfers/clear', () => {
    ctx.manager.clearFinished()
    return {}
  })

  // ── ajustes
  route('GET', '/api/settings', () => ({ settings: ctx.settings.get() }))

  // Miniatura de .braw (Ajustes): o que o computador tem para tirar o frame e o último resultado.
  route('GET', '/api/raw-thumbs', async ({ query }) => {
    const t = ctx.manager.thumbnailer
    const rawThumbs = t ? await t.status({ refresh: query.get('refresh') === '1' }) : { supported: false, found: false, via: null, enabled: false, last: null, downloadUrl: null }
    return { rawThumbs }
  })

  // "Gerar miniaturas" (tela Drive): acha os RAW do Drive no computador, tira o frame e grava como miniatura.
  route('POST', '/api/raw-thumbs/lote', async ({ body }) => {
    const acc = account(body.accountId)
    const folderId = body.driveFolderId
    if (typeof folderId !== 'string' || !DRIVE_ID.test(folderId)) throw new HttpProblem(400, 'Escolha a pasta do Drive.')
    const raw = body.localDir
    if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0') || raw.length > 4096) throw new HttpProblem(400, 'Escolha a pasta do computador onde estão os originais.')
    const localDir = expandHome(raw)
    if (!path.isAbsolute(localDir)) throw new HttpProblem(400, 'Escolha a pasta do computador onde estão os originais.')
    let st
    try {
      st = await fs.stat(localDir)
    } catch {
      throw new HttpProblem(400, 'Não achei essa pasta no computador. O disco ou o cartão está conectado?')
    }
    if (!st.isDirectory()) throw new HttpProblem(400, 'Escolha uma pasta do computador (não um arquivo).')
    for (const k of ['recursive', 'refazer']) if (body[k] != null && typeof body[k] !== 'boolean') throw new HttpProblem(400, 'Pedido inválido.')
    const folderName = typeof body.folderName === 'string' ? body.folderName.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) : ''
    const jobId = thumbJobs.start({ accountId: acc.id, driveFolderId: folderId, folderName, localDir, recursive: body.recursive !== false, refazer: body.refazer === true })
    // Lembra a pasta para a próxima vez (falhar aqui não impede o lote).
    if (ctx.settings.get().rawThumbLocalDir !== localDir) {
      ctx.settings.update({ rawThumbLocalDir: localDir }).catch(err => ctx.log('não consegui lembrar a pasta das miniaturas:', err?.message))
    }
    return { jobId }
  })

  route('GET', '/api/raw-thumbs/lote/:jobId', ({ params }) => {
    const job = thumbJobs.lookup(params.jobId)
    if (!job) throw new HttpProblem(404, 'Esse lote de miniaturas não existe mais.')
    return thumbJobs.view(job)
  })

  route('DELETE', '/api/raw-thumbs/lote/:jobId', ({ params }) => {
    if (!thumbJobs.cancel(params.jobId)) throw new HttpProblem(404, 'Esse lote de miniaturas não existe mais.')
    return {}
  })

  route('PATCH', '/api/settings', async ({ body }) => {
    try {
      validateSettings(body, ctx.settings.get())
    } catch (err) {
      throw new HttpProblem(400, err.message)
    }
    return { settings: await ctx.settings.update(body) }
  })

  // ── comparar
  route('POST', '/api/compare', ({ body }) => {
    const acc = account(body.accountId)
    if (typeof body.localPath !== 'string' || !body.localPath) throw new HttpProblem(400, 'Escolha a pasta do computador.')
    if (typeof body.driveFolderId !== 'string' || !body.driveFolderId) throw new HttpProblem(400, 'Escolha a pasta do Drive.')
    const jobId = jobs.start({ accountId: acc.id, localPath: body.localPath, driveFolderId: body.driveFolderId, mode: body.mode === 'deep' ? 'deep' : 'quick' })
    return { jobId }
  })

  route('GET', '/api/compare/:jobId', async ({ params }) => {
    const job = await compareJob(params.jobId)
    return { status: job.status, progress: job.progress, ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}) }
  })

  route('DELETE', '/api/compare/:jobId', ({ params }) => {
    if (!jobs.cancel(params.jobId)) throw new HttpProblem(404, 'Essa comparação não existe mais.')
    return {}
  })

  // Limpar: tira a comparação da memória e do disco (a tela volta ao começo). Para antes, se ainda estiver rodando.
  route('POST', '/api/compare/:jobId/limpar', async ({ params }) => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(params.jobId)) throw new HttpProblem(400, 'Comparação inválida.')
    await jobs.forget(params.jobId)
    return {}
  })

  route('POST', '/api/compare/:jobId/upload', async ({ params, body }) => {
    const { job, acc } = await finishedJob(params.jobId, body)
    const plan = planUploadsFromCompare(job.result, { accountId: acc.id, statuses: stringList(body.statuses) || undefined, relDirs: stringList(body.relDirs) })
    if (plan.batch) plan.batch.destino = destName(job.result.drive?.name)
    return enqueue(plan)
  })

  route('POST', '/api/compare/:jobId/download', async ({ params, body }) => {
    const { job, acc } = await finishedJob(params.jobId, body)
    const plan = planDownloadsFromCompare(job.result, { accountId: acc.id, relDirs: stringList(body.relDirs) })
    if (plan.batch) plan.batch.destino = destName(path.basename(job.result.localPath || ''))
    return enqueue(plan)
  })

  // ── celular (recepção pelo Wi-Fi e QR do app publicado)
  const mobileState = async () => {
    const st = ctx.settings.get()
    // O app do celular agora mora no site das contas (/app/) e usa os Drives da conta SOBEDESCE: sem client_id no QR.
    const base = ctx.auth?.cloud?.baseUrl || cloudUrl()
    const webUrl = `${base}/app/`
    const web = { webUrl, webQrSvg: webUrl ? qrSvg(webUrl) : null }
    if (!ctx.mobile) return { available: false, enabled: false, running: false, port: st.mobilePort, urls: [], qrSvg: null, dropUrl: null, shortcutSteps: shortcutSteps(null), ...web }
    const s = await ctx.mobile.status()
    return { available: true, ...s, qrSvg: s.qrUrl ? qrSvg(s.qrUrl) : null, shortcutSteps: shortcutSteps(s.dropUrl), ...web }
  }

  route('GET', '/api/mobile', () => mobileState())

  route('POST', '/api/mobile', async ({ body }) => {
    if (body.rotate === true) {
      if (!ctx.mobile) throw new HttpProblem(409, 'A recepção do celular não está disponível.')
      await ctx.mobile.rotateCode()
    }
    return mobileState()
  })

  // ── versão nova (src/version.js): "Atualizar" no app empacotado (src/updater.js) ou "Baixar" no navegador
  const versao = () => {
    if (!ctx.versao) throw new HttpProblem(404, 'O aviso de versão nova não está disponível.')
    return ctx.versao
  }

  route('GET', '/api/versao', () => ({ versao: versao().status() }))

  route('POST', '/api/versao/verificar', async () => ({ versao: await versao().check() }))

  route('POST', '/api/versao/depois', async ({ body }) => {
    const v = versao()
    if (body.build !== undefined && !(Number.isSafeInteger(body.build) && body.build > 0)) throw new HttpProblem(400, 'Versão inválida.')
    // dismiss() lança Error com status 400/409 e mensagem em PT-BR (toProblem repassa).
    return { versao: await v.dismiss(body.build) }
  })

  // "Tentar de novo" o download automático da versão nova (sem trocar no fim).
  route('POST', '/api/versao/baixar', async () => ({ versao: await versao().baixar() }))

  // Atualizar fecha o app no fim: transferências em andamento pausam (e continuam ao abrir de novo).
  // Com alguma andando, só segue com { pausar: true } (a interface pergunta antes).
  route('POST', '/api/versao/atualizar', async ({ body }) => {
    const v = versao()
    if (body.pausar !== undefined && typeof body.pausar !== 'boolean') throw new HttpProblem(400, 'Pedido inválido.')
    const ativas = ctx.manager?.activeCount?.() ?? 0
    if (ativas > 0 && body.pausar !== true) {
      throw new HttpProblem(409, 'Há transferências em andamento. Atualizar agora vai pausá-las.')
    }
    return { versao: await v.update() }
  })

  // ── mostrar no Finder/Explorer
  route('POST', '/api/reveal', async ({ body }) => {
    const p = body.path
    if (typeof p !== 'string' || !p || p.includes('\0') || !path.isAbsolute(p)) throw new HttpProblem(400, 'Caminho inválido.')
    const target = path.resolve(p)
    try {
      await fs.stat(target)
    } catch {
      throw new HttpProblem(404, 'Não encontrei esse item. Ele pode ter sido movido ou apagado.')
    }
    const [cmd, args] = revealCommand(ctx.platform || process.platform, target)
    try {
      const child = (ctx.spawn || nodeSpawn)(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
      child.on?.('error', err => ctx.log('não consegui abrir a pasta:', err?.code || err?.message))
      child.unref?.()
    } catch (err) {
      ctx.log('não consegui abrir a pasta:', err?.code || err?.message)
      throw new HttpProblem(500, 'Não consegui abrir a pasta neste computador.')
    }
    return {}
  })

  async function dispatch(req, res, url) {
    const segs = url.pathname.split('/').filter(Boolean)
    let pathMatched = false
    for (const r of routes) {
      const params = match(r.pattern, segs)
      if (!params) continue
      pathMatched = true
      if (r.method !== req.method) continue
      const ac = new AbortController()
      res.on('close', () => {
        if (!res.writableFinished) ac.abort()
      })
      try {
        const body = req.method === 'GET' || req.method === 'HEAD' || !r.corpo ? {} : await readBody(req)
        const out = await r.handler({ req, res, url, params, query: url.searchParams, body, signal: ac.signal })
        if (!r.raw) sendJSON(res, 200, { ok: true, ...(out || {}) })
      } catch (err) {
        if (res.headersSent) {
          res.destroy()
          return true
        }
        const p = toProblem(err)
        if (p?.status === 499 && ac.signal.aborted) {
          res.destroy()
          return true
        }
        if (!p) ctx.log(`erro inesperado em ${req.method} ${url.pathname}:`, err?.stack || err)
        sendJSON(res, p?.status || 500, { ok: false, error: p?.message || 'Algo deu errado aqui dentro. Tente de novo.' })
      }
      return true
    }
    if (pathMatched) {
      sendJSON(res, 405, { ok: false, error: 'Método não permitido.' })
      return true
    }
    return false
  }

  return {
    dispatch,
    state,
    close: () => {
      jobs.close()
      thumbJobs.close()
      previas.close()
      tamanhos.close()
      copias.close()
      frames.close()
      cenas.close()
      discos.close()
      lan.close()
      celular.close()
      backup.close()
    },
  }
}
