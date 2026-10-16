// Tamanho das pastas contra o Drive falso: a soma do motor (DriveClient.folderSize), a do app do celular
// (web/public/app/lib/tamanho.js, com fetch direto como no navegador), as contas guardadas por pasta dos dois lados
// e as rotas /api/drive/:acc/tamanho.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setupDrive, waitFor } from './helpers.js'
import { closeHttp } from '../src/net/http.js'
import { classifyError } from '../src/google/errors.js'
import { DriveClient } from '../src/google/drive.js'
import { FolderSizeJobs } from '../src/server/tamanho.js'
import { FolderSizes, pageLister, walkFolderSize as walkWeb, sizeIsBig, SIZE_FIELDS } from '../web/public/app/lib/tamanho.js'

after(() => closeHttp())

async function setup(t, mockOptions = {}) {
  const ctx = await setupDrive(mockOptions)
  t.after(ctx.cleanup)
  return ctx
}

/** Registra as chamadas que passam por drive.api. */
function spyApi(drive) {
  const calls = []
  const original = drive.api.bind(drive)
  drive.api = (method, pathOrUrl, opts = {}) => {
    calls.push({ method, path: pathOrUrl, query: { ...(opts.query || {}) } })
    return original(method, pathOrUrl, opts)
  }
  return calls
}

/** O `call` do app do celular (lib/drive.js), só que em Node: fetch com Bearer, erro com status e reason. */
function webCall(mock, calls = []) {
  const { accessToken } = mock.issueTokens()
  return async (p, { query = {}, signal } = {}) => {
    const url = new URL(`${mock.url}/drive/v3${p}`)
    for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v))
    calls.push(Object.fromEntries(url.searchParams))
    const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      const err = new Error(json?.error?.message || `HTTP ${res.status}`)
      err.status = res.status
      err.reason = json?.error?.errors?.[0]?.reason || null
      throw err
    }
    return json
  }
}

/** Árvore de exemplo: 3 níveis, lixeira, Docs, atalhos (para arquivo, para pasta e para a própria pasta). */
function buildTree(mock) {
  const root = mock.addFolder('Filme')
  const outside = mock.addFolder('Fora')
  const big = mock.addFile('fora.mov', outside.id, { size: 9_000_000 })
  let bytes = 0
  let files = 0
  let folders = 0
  for (let a = 0; a < 3; a++) {
    const day = mock.addFolder(`Dia ${a}`, root.id)
    folders++
    for (let b = 0; b < 2; b++) {
      const cam = mock.addFolder(`Cam ${b}`, day.id)
      folders++
      for (let c = 0; c < 4; c++) {
        const size = 1000 * (a + 1) + c
        mock.addFile(`C${c}.mov`, cam.id, { size })
        bytes += size
        files++
      }
    }
  }
  mock.addFile('vazio.txt', root.id, { size: 0 })
  files++
  mock.addFile('lixo.mov', root.id, { size: 123_456, trashed: true })
  const trashedDir = mock.addFolder('Apagada', root.id, { trashed: true })
  mock.addFile('dentro-da-lixeira.mov', trashedDir.id, { size: 5 })
  mock.addGoogleDoc('Roteiro', root.id, 'document', { size: 4096 })
  mock.addGoogleDoc('Orçamento', root.id, 'spreadsheet')
  files += 2
  mock.addShortcut('atalho arquivo', root.id, big.id)
  mock.addShortcut('atalho pasta', root.id, outside.id)
  mock.addShortcut('atalho para mim', root.id, root.id)
  return { root, outside, expect: { bytes, files, folders, docs: 2, shortcuts: 3 } }
}

const pickCounts = r => ({ bytes: r.bytes, files: r.files, folders: r.folders, docs: r.docs, shortcuts: r.shortcuts })

test('motor: soma pastas aninhadas, ignora lixeira, Docs contam 0, atalhos não são seguidos; listagem mínima', async t => {
  const { mock, drive } = await setup(t)
  const { root, expect } = buildTree(mock)
  const calls = spyApi(drive)
  const progress = []
  mock.resetStats()
  const out = await drive.folderSize(root.id, { onProgress: p => progress.push(p) })
  assert.deepEqual(pickCounts(out), expect)
  assert.equal(out.pending, 0)
  assert.equal(out.root.id, root.id)
  assert.equal(out.root.name, 'Filme')
  const lists = calls.filter(c => c.path === 'files')
  assert.equal(lists.length, 1 + expect.folders, 'uma listagem por pasta (lixeira e atalhos de fora)')
  for (const c of lists) {
    assert.equal(c.query.fields, 'nextPageToken,files(id,mimeType,size)')
    assert.equal(c.query.pageSize, 1000)
    assert.match(c.query.q, /trashed = false/)
    assert.equal(c.query.corpora, undefined)
  }
  assert.ok(progress.length >= 1)
  assert.deepEqual(pickCounts(progress.at(-1)), expect)
  // Mesma soma que a varredura completa já existente (que traz tudo de cada item).
  const walked = await drive.walk(root.id)
  const files = walked.items.filter(i => !i.isFolder && !i.isShortcut)
  assert.equal(files.length, expect.files)
  assert.equal(files.reduce((a, i) => a + (i.size || 0), 0), expect.bytes)

  // Pasta vazia, atalho de pasta como raiz (segue) e 'root' (Meu Drive).
  const empty = mock.addFolder('Vazia')
  assert.deepEqual(pickCounts(await drive.folderSize(empty.id)), { bytes: 0, files: 0, folders: 0, docs: 0, shortcuts: 0 })
  const short = mock.addShortcut('atalho raiz', 'root', root.id)
  const viaShortcut = await drive.folderSize(short.id)
  assert.equal(viaShortcut.root.id, root.id)
  assert.deepEqual(pickCounts(viaShortcut), expect)
  const mine = await drive.folderSize('root')
  assert.equal(mine.root.id, 'root')
  assert.equal(mine.bytes, expect.bytes + 9_000_000)
})

test('motor: drive compartilhado usa corpora=drive com o driveId da raiz (na raiz do drive e numa subpasta)', async t => {
  const { mock, drive } = await setup(t)
  const team = mock.addSharedDrive('Equipe Montagem')
  const proj = mock.addFolder('Projeto X', team.id)
  const sub = mock.addFolder('Brutos', proj.id)
  mock.addFile('A001.mov', sub.id, { size: 4096 })
  mock.addFile('B001.mov', proj.id, { size: 1000 })
  mock.addFile('solto.wav', team.id, { size: 24 })
  const calls = spyApi(drive)
  const all = await drive.folderSize(team.id)
  assert.deepEqual(pickCounts(all), { bytes: 5120, files: 3, folders: 2, docs: 0, shortcuts: 0 })
  const fresh = new DriveClient(drive.auth, drive.accountId)
  const freshCalls = spyApi(fresh)
  const part = await fresh.folderSize(proj.id)
  assert.deepEqual(pickCounts(part), { bytes: 5096, files: 2, folders: 1, docs: 0, shortcuts: 0 })
  for (const c of [...calls, ...freshCalls].filter(c => c.path === 'files')) {
    assert.equal(c.query.corpora, 'drive')
    assert.equal(c.query.driveId, team.id)
    assert.equal(c.query.includeItemsFromAllDrives, 'true')
  }
})

test('motor: muitas páginas, falhas 5xx/429 repetidas com recuo, subpasta que some no meio fica de fora', async t => {
  const { mock, drive } = await setup(t, { failures: { shortPageProb: 0.3 } })
  const root = mock.addFolder('Grande')
  let bytes = 0
  for (let i = 0; i < 2600; i++) {
    mock.addFile(`f${i}.mov`, root.id, { size: i + 1 })
    bytes += i + 1
  }
  for (let i = 0; i < 20; i++) {
    const d = mock.addFolder(`Sub ${i}`, root.id)
    mock.addFile('s.mov', d.id, { size: 5 })
    bytes += 5
  }
  const doomed = mock.addFolder('Vai sumir', root.id)
  mock.addFile('x.mov', doomed.id, { size: 10 })
  const fast = new DriveClient(drive.auth, drive.accountId, { retryBaseMs: 2 })
  // Apaga a subpasta assim que a raiz termina de listar (antes de a fila chegar nela).
  const original = fast.api.bind(fast)
  fast.api = async (method, p, opts) => {
    const r = await original(method, p, opts)
    if (p === 'files' && opts.query.q.startsWith(`'${root.id}'`) && !r.nextPageToken && mock.getItem(doomed.id)) mock.deleteItem(doomed.id)
    return r
  }
  mock.setOptions({ failures: { shortPageProb: 0.3, error5xxProb: 0.2, error429Prob: 0.15 } })
  const out = await fast.folderSize(root.id)
  mock.setOptions({ failures: {} })
  assert.deepEqual(pickCounts(out), { bytes, files: 2620, folders: 21, docs: 0, shortcuts: 0 })
  const st = mock.stats()
  assert.ok(st.faults.error5xx + st.faults.error429 > 0, 'houve falhas para repetir')
})

test('motor: cancelar devolve AbortError com o parcial; raiz que não existe dá erro', async t => {
  const { mock, drive } = await setup(t, { latencyMs: 25 })
  const { root } = buildTree(mock)
  const ac = new AbortController()
  let seen = null
  // O primeiro aviso vem logo depois da primeira página (a da raiz): para ali.
  const pending = drive.folderSize(root.id, {
    signal: ac.signal,
    onProgress: p => {
      seen ??= p
      ac.abort()
    },
  })
  const err = await pending.then(() => null, e => e)
  assert.equal(classifyError(err).kind, 'abort')
  assert.ok(err.partial, 'traz o parcial')
  assert.ok(err.partial.files >= seen.files && err.partial.files >= 3)
  assert.ok(err.partial.pending > 0, 'ainda tinha pasta na fila')
  await assert.rejects(drive.folderSize(root.id, { signal: AbortSignal.abort() }), e => classifyError(e).kind === 'abort')
  await assert.rejects(drive.folderSize('nao-existe-123'), e => classifyError(e).kind === 'notfound')
})

test('celular: a mesma soma direto no Drive (fetch + Bearer), drive compartilhado e cancelamento', async t => {
  const { mock } = await setup(t)
  const { root, expect } = buildTree(mock)
  const calls = []
  const call = webCall(mock, calls)
  const progress = []
  const out = await walkWeb({ listPage: pageLister(call), rootId: root.id, onProgress: p => progress.push(p) })
  assert.deepEqual(pickCounts(out), expect)
  assert.deepEqual(pickCounts(progress.at(-1)), expect)
  for (const c of calls) {
    assert.equal(c.fields, SIZE_FIELDS)
    assert.equal(c.pageSize, '1000')
    assert.equal(c.supportsAllDrives, 'true')
    assert.equal(c.corpora, undefined)
  }

  const team = mock.addSharedDrive('Equipe')
  const proj = mock.addFolder("Projeto d'Ana", team.id)
  mock.addFile('A.mov', proj.id, { size: 70 })
  mock.addFile('B.mov', team.id, { size: 30 })
  calls.length = 0
  const shared = await walkWeb({ listPage: pageLister(call, team.id), rootId: team.id })
  assert.deepEqual(pickCounts(shared), { bytes: 100, files: 2, folders: 1, docs: 0, shortcuts: 0 })
  assert.ok(calls.every(c => c.corpora === 'drive' && c.driveId === team.id))
  // Pasta com aspas no id não quebra a busca (escape igual ao lib/drive.js).
  assert.ok(calls.some(c => c.q === `'${proj.id}' in parents and trashed = false`))

  mock.setOptions({ latencyMs: 25 })
  const ac = new AbortController()
  const err = await walkWeb({ listPage: pageLister(call), rootId: root.id, signal: ac.signal, onProgress: () => ac.abort() }).then(() => null, e => e)
  assert.equal(err?.name, 'AbortError')
  assert.ok(err.partial.files >= 3 && err.partial.pending > 0)
  mock.setOptions({ latencyMs: 0 })
  // Erro que não é "sumiu" derruba a conta (com o parcial); 404 numa subpasta só a deixa de fora.
  const flaky = (id, token, signal) => (id === 'sub-404' ? Promise.reject(Object.assign(new Error('nf'), { status: 404 })) : id === 'root-x' ? Promise.resolve({ files: [{ id: 'sub-404', mimeType: 'application/vnd.google-apps.folder' }, { id: 'f', mimeType: 'video/mp4', size: '7' }] }) : Promise.reject(Object.assign(new Error('x'), { status: 500 })))
  assert.deepEqual(pickCounts(await walkWeb({ listPage: flaky, rootId: 'root-x' })), { bytes: 7, files: 1, folders: 1, docs: 0, shortcuts: 0 })
  const boom = await walkWeb({ listPage: flaky, rootId: 'outra' }).then(() => null, e => e)
  assert.equal(boom.status, 500)
  assert.ok(boom.partial)
})

test('celular: FolderSizes guarda por pasta, refaz com refresh, Parar guarda o parcial, focus esquece as outras', async t => {
  const { mock } = await setup(t)
  const { root, outside } = buildTree(mock)
  const call = webCall(mock)
  let walks = 0
  let gate = null
  const store = new FolderSizes({
    walk: async (folder, opts) => {
      walks++
      if (gate) await gate
      return walkWeb({ listPage: pageLister(call, folder.driveId), rootId: folder.id, ...opts })
    },
  })
  let changes = 0
  store.subscribe(() => changes++)
  const first = store.start({ id: root.id })
  assert.ok(['queued', 'running'].includes(first.status))
  await waitFor(() => store.get(root.id)?.status === 'done')
  const done = store.get(root.id)
  assert.equal(done.files, 27)
  assert.ok(done.finishedAt >= done.startedAt)
  assert.ok(changes >= 2)
  // Já pronta: não refaz. refresh: refaz.
  assert.equal(store.start({ id: root.id }).status, 'done')
  assert.equal(walks, 1)
  store.start({ id: root.id }, { refresh: true })
  await waitFor(() => store.get(root.id)?.status === 'done')
  assert.equal(walks, 2)

  // Parar guarda o parcial; `auto` não recomeça sozinho, refresh recomeça.
  let release
  gate = new Promise(r => (release = r))
  store.start({ id: outside.id })
  await waitFor(() => store.get(outside.id)?.status === 'running')
  store.stop(outside.id)
  release()
  await waitFor(() => store.get(outside.id)?.status === 'stopped')
  gate = null
  assert.equal(store.start({ id: outside.id }, { auto: true }).status, 'stopped')
  store.start({ id: outside.id }, { refresh: true })
  await waitFor(() => store.get(outside.id)?.status === 'done')
  assert.equal(store.get(outside.id).bytes, 9_000_000)

  // focus: a conta de outra pasta que ainda andava some; a pronta continua guardada.
  gate = new Promise(r => (release = r))
  const other = mock.addFolder('Outra')
  store.start({ id: other.id })
  await waitFor(() => store.get(other.id)?.status === 'running')
  store.focus(root.id)
  release()
  await waitFor(() => !store.get(other.id))
  assert.equal(store.get(root.id).status, 'done')
  assert.equal(store.running(), false)

  // No máximo 2 ao mesmo tempo: a terceira espera na fila.
  gate = new Promise(r => (release = r))
  const ids = [mock.addFolder('A').id, mock.addFolder('B').id, mock.addFolder('C').id]
  for (const id of ids) store.start({ id })
  await waitFor(() => store.get(ids[1])?.status === 'running')
  assert.equal(store.get(ids[2]).status, 'queued')
  release()
  await waitFor(() => ids.every(id => store.get(id)?.status === 'done'))

  assert.equal(sizeIsBig({ files: 15_000, folders: 6_000, elapsedMs: 1000 }), true)
  assert.equal(sizeIsBig({ files: 10, folders: 1, elapsedMs: 31_000 }), true)
  assert.equal(sizeIsBig({ files: 10, folders: 1, elapsedMs: 1000 }), false)
})

test('motor: FolderSizeJobs guarda por pasta, fila de 2, Parar/descartar, vaga vencida e envio terminado esquecem', async t => {
  const { mock, drive } = await setup(t)
  const { root, outside, expect } = buildTree(mock)
  const manager = new EventEmitter()
  let gate = null
  const slow = Object.create(drive)
  slow.folderSize = async (id, opts) => {
    if (gate) await gate
    return drive.folderSize(id, opts)
  }
  manager.driveFor = () => slow
  const jobs = new FolderSizeJobs({ manager, log: () => {} }, { toProblem: () => null, leaseMs: 400 })
  t.after(() => jobs.close())
  const view = id => jobs.lookup('acc', [id])[id]

  jobs.start('acc', root.id)
  await waitFor(() => view(root.id)?.status === 'done')
  assert.deepEqual(pickCounts(view(root.id)), expect)
  assert.equal(jobs.start('acc', root.id).status, 'done', 'guardado')
  assert.equal(jobs.start('acc', root.id, { refresh: true }).status, 'running', 'refresh refaz')
  await waitFor(() => view(root.id)?.status === 'done')

  // Fila: 2 rodando, a 3ª espera; Parar guarda o parcial, discard esquece.
  let release
  gate = new Promise(r => (release = r))
  const a = mock.addFolder('A').id
  const b = mock.addFolder('B').id
  jobs.start('acc', a)
  jobs.start('acc', b)
  jobs.start('acc', outside.id)
  assert.equal(view(outside.id).status, 'queued')
  jobs.stop('acc', a)
  jobs.stop('acc', b, { discard: true })
  release()
  await waitFor(() => view(a)?.status === 'stopped' && !view(b))
  gate = null
  await waitFor(() => view(outside.id)?.status === 'done')
  assert.equal(view(outside.id).bytes, 9_000_000)
  assert.equal(jobs.start('acc', a, { auto: true }).status, 'stopped', 'parada à mão não recomeça sozinha')

  // Ninguém perguntando: a conta é abandonada (e esquecida).
  gate = new Promise(r => (release = r))
  const c = mock.addFolder('C').id
  jobs.start('acc', c)
  await new Promise(r => setTimeout(r, 900))
  release()
  gate = null
  await waitFor(() => jobs.jobs.get(FolderSizeJobs.key('acc', c)) === undefined)

  // Envio terminado nesta conta: os tamanhos guardados dela vão embora; de outra conta ficam.
  jobs.start('outra', outside.id)
  await waitFor(() => jobs.lookup('outra', [outside.id])[outside.id]?.status === 'done')
  manager.emit('transfers', [{ id: 'up1', type: 'upload', status: 'running', accountId: 'acc' }])
  assert.equal(view(root.id).status, 'done')
  manager.emit('transfers', [{ id: 'up1', type: 'upload', status: 'completed', accountId: 'acc' }])
  assert.equal(view(root.id), null)
  assert.equal(jobs.lookup('outra', [outside.id])[outside.id].status, 'done')
})

test('rotas: POST começa, GET acompanha (vários ids), DELETE para; erros de entrada em português', async t => {
  const env = await setupDrive()
  const { startApp } = await import('../src/index.js')
  const app = await startApp({ home: env.home, port: 0, open: false, quiet: true, serverOptions: { log: () => {} }, managerOptions: { keepAwake: { active: false, setActive() {}, stop() {} } } })
  t.after(async () => {
    await app.shutdown()
    await env.cleanup()
  })
  const { root, expect } = buildTree(env.mock)
  const base = `${app.url}/api/drive/${encodeURIComponent(env.accountId)}/tamanho`
  const req = async (method, url, body) => {
    const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, json: await res.json() }
  }
  const started = await req('POST', base, { folderId: root.id })
  assert.equal(started.status, 200)
  assert.ok(['queued', 'running', 'done'].includes(started.json.tamanho.status))
  let got
  await waitFor(async () => {
    got = await req('GET', `${base}?ids=${root.id},desconhecida`)
    return got.json.tamanhos[root.id]?.status === 'done'
  })
  assert.deepEqual(pickCounts(got.json.tamanhos[root.id]), expect)
  assert.equal(got.json.tamanhos.desconhecida, null)
  assert.equal((await req('POST', base, { folderId: root.id })).json.tamanho.status, 'done', 'guardado na sessão')
  const again = await req('POST', base, { folderId: root.id, refresh: true })
  assert.ok(['queued', 'running'].includes(again.json.tamanho.status))
  const stopped = await req('DELETE', base, { folderId: root.id, discard: true })
  assert.equal(stopped.status, 200)
  assert.equal((await req('POST', base, { folderId: '../x' })).status, 400)
  const bad = await req('GET', `${app.url}/api/drive/nao-existe/tamanho?ids=a`)
  assert.equal(bad.status, 404)
  assert.match(bad.json.error, /Conta não encontrada/)
})
