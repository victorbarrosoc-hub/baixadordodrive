// Rotas da API local (tabela em docs/ARCHITECTURE.md, "Servidor (src/server) — API").
// Cada rota devolve um objeto (vira { ok: true, ...objeto }) ou lança; o erro vira { ok: false, error } em PT-BR.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { APP_NAME, APP_VERSION, validateSettings } from '../config.js'
import { classifyError } from '../google/errors.js'
import { FOLDER_MIME } from '../google/drive.js'
import { listDir, listRoots, expandHome } from '../local/fsbrowse.js'
import { planDownloads, planDownloadsFromCompare, planUploads, planUploadsFromCompare } from '../engine/planner.js'
import { compareFolders, loadCompare } from '../engine/compare.js'
import { writeJSONAtomic } from '../util/store.js'
import { newId } from '../util/ids.js'
import { isAbortError } from '../util/backoff.js'

const BODY_LIMIT = 1024 * 1024
const BODY_HARD_LIMIT = 16 * BODY_LIMIT // além disso nem lê o resto: derruba a conexão
const COMPARE_EVENT_MS = 250 // progresso da comparação: no máximo 4×/s
const KEEP_JOBS = 10 // comparações guardadas na memória (os resultados ficam no disco)
const KEEP_COMPARES = 20
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

  close() {
    for (const job of this.jobs.values()) {
      job.ac?.abort()
      if (job.timer) clearTimeout(job.timer)
      job.timer = null
    }
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
 * @param {object} ctx { settings, auth, manager, hasher, paths, hub, port, desktop, spawn, platform, log }
 * @returns {{ dispatch(req, res, url): Promise<boolean>, state(): object, close(): void }}
 */
export function createApi(ctx) {
  const routes = []
  const route = (method, pattern, handler, { raw = false } = {}) => routes.push({ method, pattern: pattern.split('/').filter(Boolean), handler, raw })
  const jobs = new CompareJobs(ctx)

  const state = () => {
    const snap = ctx.manager.snapshot()
    return {
      app: { name: APP_NAME, version: APP_VERSION, platform: process.platform, desktop: !!ctx.desktop },
      setup: ctx.auth.getClientInfo(),
      accounts: ctx.auth.listAccounts(),
      settings: ctx.settings.get(),
      transfers: snap.transfers,
      batches: snap.batches,
      stats: snap.stats,
    }
  }

  const account = id => {
    const acc = typeof id === 'string' && id ? ctx.auth.listAccounts().find(a => a.id === id) : null
    if (!acc) throw new HttpProblem(404, 'Conta não encontrada. Conecte a conta de novo.')
    return acc
  }

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

  const stringList = (v, max = 10_000) => (Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, max) : null)

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
    let item = await drive.getItem(folderId, { signal, resourceKey: query.get('resourceKey') || undefined })
    // Atalho para pasta: abre a pasta de verdade.
    if (item.isShortcut && item.shortcutTargetId && item.shortcutTargetMimeType === FOLDER_MIME) {
      folderId = item.shortcutTargetId
      item = await drive.getItem(folderId, { signal, resourceKey: item.shortcutTargetResourceKey || undefined })
    }
    if (!item.isFolder) throw new HttpProblem(400, 'Isso não é uma pasta.')
    const [crumbs, items] = await Promise.all([drive.getPath(folderId, { signal }), drive.listChildren(folderId, { signal })])
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
    return { items: await ctx.manager.driveFor(params.acc).search(q.slice(0, 200), { signal }) }
  })

  route('POST', '/api/drive/:acc/folders', async ({ params, body, signal }) => {
    account(params.acc)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) throw new HttpProblem(400, 'Dê um nome para a pasta.')
    if (name.length > 255) throw new HttpProblem(400, 'Nome de pasta longo demais.')
    const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : 'root'
    return { item: await ctx.manager.driveFor(params.acc).createFolder(name, parentId, { signal }) }
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

  route('POST', '/api/compare/:jobId/upload', async ({ params, body }) => {
    const { job, acc } = await finishedJob(params.jobId, body)
    const plan = planUploadsFromCompare(job.result, { accountId: acc.id, statuses: stringList(body.statuses) || undefined, relDirs: stringList(body.relDirs) })
    return enqueue(plan)
  })

  route('POST', '/api/compare/:jobId/download', async ({ params, body }) => {
    const { job, acc } = await finishedJob(params.jobId, body)
    const plan = planDownloadsFromCompare(job.result, { accountId: acc.id, relDirs: stringList(body.relDirs) })
    return enqueue(plan)
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
        const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req)
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

  return { dispatch, state, close: () => jobs.close() }
}
