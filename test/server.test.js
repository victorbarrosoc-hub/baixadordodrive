// Servidor local de ponta a ponta contra o Drive falso: segurança (Host, Content-Type, Origin, tamanho), estado e SSE,
// rotas do Drive e do disco, login pelo navegador, download/upload/comparação pela API com arquivos de verdade,
// arquivos da interface, "mostrar na pasta", trava de instância.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { startApp } from '../src/index.js'
import { closeHttp } from '../src/net/http.js'
import { setupDrive, makeTmpDir, waitFor, randomFile, md5File } from './helpers.js'
import { virtualMd5 } from './mock-drive.js'

const MiB = 1024 * 1024

let env
let app
let files
const spawned = []

const keepAwake = { active: false, setActive() {}, stop() {} }

before(async () => {
  env = await setupDrive()
  files = await makeTmpDir('sobedesce-server-files-')
  app = await startApp({
    home: env.home,
    port: 0,
    open: false,
    quiet: true,
    managerOptions: { keepAwake, taskOptions: { download: { retryBaseMs: 5, checkpointMs: 200 }, upload: { retryBaseMs: 5 } } },
    serverOptions: {
      log: () => {},
      spawn: (cmd, args, opts) => {
        spawned.push({ cmd, args, opts })
        const child = new EventEmitter()
        child.unref = () => {}
        return child
      },
    },
  })
  await app.settings.update({ keepAwake: false, connectionsPerDownload: 4, minSegmentSize: MiB })
})

after(async () => {
  await app?.shutdown()
  await env?.cleanup()
  if (files) await fs.rm(files, { recursive: true, force: true, maxRetries: 3 })
  await closeHttp()
})

// ─────────── cliente HTTP cru (controle total dos cabeçalhos) ───────────

function call(method, p, { body, headers = {}, port = app.port } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
    const h = { host: `127.0.0.1:${port}`, ...headers }
    if (data != null && !Object.keys(h).some(k => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json'
    if (method !== 'GET' && method !== 'HEAD' && data == null && !Object.keys(h).some(k => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json'
    if (data != null) h['content-length'] = Buffer.byteLength(data)
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    if (data != null) req.write(data)
    req.end()
  })
}

const get = (p, opts) => call('GET', p, opts)
const post = (p, body, opts) => call('POST', p, { body: body ?? {}, ...opts })

/** Cliente SSE: junta os eventos recebidos. */
function sse(port = app.port) {
  const events = []
  let buf = ''
  const req = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}`, accept: 'text/event-stream' }, agent: false })
  const ready = new Promise((resolve, reject) => {
    req.on('response', res => {
      res.setEncoding('utf8')
      res.on('data', chunk => {
        buf += chunk
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          let event = 'message'
          const data = []
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7)
            else if (line.startsWith('data: ')) data.push(line.slice(6))
          }
          if (data.length) events.push({ event, data: JSON.parse(data.join('\n')) })
        }
      })
      res.on('error', () => {})
      resolve(res)
    })
    req.on('error', reject)
  })
  req.end()
  return {
    events,
    ready,
    of: name => events.filter(e => e.event === name).map(e => e.data),
    close: () => req.destroy(),
  }
}

async function waitTransfers(ids, statuses = ['completed', 'skipped'], timeoutMs = 30_000) {
  let last
  await waitFor(async () => {
    last = (await get('/api/state')).json.transfers.filter(t => ids.includes(t.id))
    if (last.some(t => t.status === 'failed')) throw new Error(`falhou: ${JSON.stringify(last.map(t => t.error))}`)
    return last.length === ids.length && last.every(t => statuses.includes(t.status))
  }, { timeoutMs, intervalMs: 100, message: 'as transferências não terminaram' })
  return last
}

// ─────────── segurança ───────────

test('segurança: Host errado 403, sem JSON 415, Origin de fora 403, corpo grande 413, JSON inválido 400, sem pilha de erro', async () => {
  let r = await get('/api/state', { headers: { host: 'evil.example:80' } })
  assert.equal(r.status, 403)
  assert.equal(r.json.ok, false)
  r = await get('/', { headers: { host: `attacker.test:${app.port}` } })
  assert.equal(r.status, 403, 'DNS rebinding também nos arquivos da interface')
  r = await get('/api/state', { headers: { host: `localhost:${app.port}` } })
  assert.equal(r.status, 200, 'localhost:<porta> vale')

  r = await call('POST', '/api/transfers/clear', { body: '{}', headers: { 'content-type': 'text/plain' } })
  assert.equal(r.status, 415)
  assert.match(r.json.error, /Content-Type/)
  r = await call('DELETE', `/api/accounts/${env.accountId}`, { headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  assert.equal(r.status, 415, 'DELETE também exige JSON')
  r = await post('/api/transfers/clear', {}, { headers: { origin: 'https://evil.example' } })
  assert.equal(r.status, 403)
  r = await post('/api/transfers/clear', {}, { headers: { origin: `http://127.0.0.1:${app.port}` } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true })
  r = await call('POST', '/api/transfers/clear', { body: '{}', headers: { 'content-type': 'application/json; charset=utf-8' } })
  assert.equal(r.status, 200, 'charset no Content-Type vale')

  r = await post('/api/transfers/action', 'x'.repeat(1024 * 1024 + 10))
  assert.equal(r.status, 413)
  r = await post('/api/transfers/action', '{nao é json')
  assert.equal(r.status, 400)
  assert.equal(r.json.error, 'JSON inválido.')
  r = await post('/api/transfers/action', { action: 'explodir', ids: [] })
  assert.equal(r.status, 400)
  assert.equal(r.json.error, 'Ação desconhecida.')
  r = await get('/api/nada-aqui')
  assert.equal(r.status, 404)
  assert.equal(r.json.error, 'Rota não encontrada.')
  r = await call('PUT', '/api/state', { body: {} })
  assert.equal(r.status, 405)
  r = await get('/api/drive/conta-que-nao-existe/about')
  assert.equal(r.status, 404)
  assert.match(r.json.error, /Conta não encontrada/)
  for (const x of [r]) assert.ok(!/at .*\.js:\d+/.test(x.text), 'sem pilha de erro')
})

// ─────────── estado, ajustes, SSE ───────────

test('estado, ajustes e SSE: hello igual a /api/state, ajustes e stats chegam ao vivo', async () => {
  const state = await get('/api/state')
  assert.equal(state.status, 200)
  const s = state.json
  assert.equal(s.ok, true)
  assert.equal(s.app.name, 'SOBEDESCE')
  assert.equal(s.setup.configured, true)
  assert.match(s.setup.clientIdHint, /…apps\.googleusercontent\.com$/)
  assert.equal(s.accounts.length, 1)
  assert.equal(s.accounts[0].email, 'ana.montadora@example.com')
  assert.ok(!JSON.stringify(s).includes('refresh'), 'nada de token')
  for (const k of ['settings', 'transfers', 'batches', 'stats']) assert.ok(k in s, k)

  const ev = sse()
  try {
    const res = await ev.ready
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'], /^text\/event-stream/)
    await waitFor(() => ev.of('hello').length === 1)
    const hello = ev.of('hello')[0]
    assert.deepEqual(Object.keys(hello).sort(), ['accounts', 'app', 'backup', 'batches', 'celular', 'cenas', 'cloud', 'copia', 'discos', 'frames', 'lan', 'media', 'previas', 'rawThumbs', 'referencias', 'settings', 'setup', 'stats', 'transfers', 'versao'])
    assert.equal(hello.accounts[0].id, env.accountId)

    let r = await call('PATCH', '/api/settings', { body: { maxConcurrentDownloads: 5, bandwidthLimitUp: 2_000_000 } })
    assert.equal(r.status, 200)
    assert.equal(r.json.settings.maxConcurrentDownloads, 5)
    await waitFor(() => ev.of('settings').some(x => x.maxConcurrentDownloads === 5))
    assert.equal(app.manager.limiters.upload.rate, 2_000_000, 'limite de banda segue o ajuste')
    r = await call('PATCH', '/api/settings', { body: { downloadConflict: 'explodir' } })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /Valor inválido/)
    r = await get('/api/settings')
    assert.equal(r.json.settings.maxConcurrentDownloads, 5)
    await call('PATCH', '/api/settings', { body: { maxConcurrentDownloads: 3, bandwidthLimitUp: 0 } })

    await waitFor(() => ev.of('stats').length >= 2, { timeoutMs: 3000 })
    const st = ev.of('stats').at(-1)
    assert.ok(Array.isArray(st.history))
    assert.equal(typeof st.down.speed, 'number')
  } finally {
    ev.close()
  }
  await waitFor(() => app.server.hub.size === 0, { message: 'cliente SSE não foi limpo' })
})

// ─────────── Drive e disco ───────────

test('Drive pela API (mock): sobre, drives compartilhados, listar, buscar e criar pasta', async () => {
  const shared = env.mock.addSharedDrive('Produtora XYZ')
  const brutos = env.mock.addFolder('Brutos API')
  env.mock.addFile('A001_C001_API.mov', brutos.id, { size: 1000 })
  env.mock.addFile('Roteiro.pdf', shared.id, { size: 1000 })
  const acc = env.accountId

  let r = await get(`/api/drive/${acc}/about`)
  assert.equal(r.status, 200)
  assert.equal(r.json.about.user.email, 'ana.montadora@example.com')
  r = await get(`/api/drive/${acc}/drives`)
  assert.ok(r.json.drives.some(d => d.id === shared.id && d.name === 'Produtora XYZ'))

  r = await get(`/api/drive/${acc}/list`)
  assert.equal(r.status, 200)
  assert.equal(r.json.folder.id, 'root')
  assert.equal(r.json.folder.name, 'Meu Drive')
  assert.deepEqual(r.json.path, [{ id: 'root', name: 'Meu Drive' }])
  assert.ok(r.json.items.some(i => i.id === brutos.id && i.isFolder))

  r = await get(`/api/drive/${acc}/list?folderId=${encodeURIComponent(brutos.id)}`)
  assert.deepEqual(r.json.path.map(p => p.name), ['Meu Drive', 'Brutos API'])
  assert.equal(r.json.items[0].name, 'A001_C001_API.mov')
  assert.equal(r.json.items[0].size, 1000)

  r = await get(`/api/drive/${acc}/list?folderId=${encodeURIComponent(shared.id)}`)
  assert.equal(r.json.folder.name, 'Produtora XYZ')
  assert.equal(r.json.folder.driveId, shared.id)
  assert.ok(r.json.items.some(i => i.name === 'Roteiro.pdf'))

  r = await get(`/api/drive/${acc}/list?folderId=nao-existe-mesmo`)
  assert.equal(r.status, 404)
  r = await get(`/api/drive/${acc}/list?folderId=${encodeURIComponent(r.json ? env.mock.listAll().find(i => i.name === 'A001_C001_API.mov').id : '')}`)
  assert.equal(r.status, 400, 'arquivo não é pasta')

  r = await get(`/api/drive/${acc}/search?q=A001_C001_API`)
  assert.deepEqual(r.json.items.map(i => i.name), ['A001_C001_API.mov'])
  r = await get(`/api/drive/${acc}/search?q=`)
  assert.deepEqual(r.json.items, [])

  r = await post(`/api/drive/${acc}/folders`, { parentId: brutos.id, name: '  Dia 02  ' })
  assert.equal(r.status, 200)
  assert.equal(r.json.item.name, 'Dia 02')
  assert.ok(r.json.item.isFolder)
  assert.equal(env.mock.getItem(r.json.item.id).name, 'Dia 02')
  r = await post(`/api/drive/${acc}/folders`, { parentId: brutos.id, name: '   ' })
  assert.equal(r.status, 400)
})

test('disco local pela API: raízes e listagem (ocultos só com hidden=1)', async () => {
  const dir = path.join(files, 'navegar')
  await fs.mkdir(path.join(dir, 'Sub'), { recursive: true })
  await fs.writeFile(path.join(dir, 'a.mov'), 'abc')
  await fs.writeFile(path.join(dir, '.oculto'), 'x')
  let r = await get('/api/local/roots')
  assert.equal(r.status, 200)
  assert.equal(r.json.home, os.homedir())
  assert.equal(r.json.sep, path.sep)
  assert.equal(r.json.roots[0].kind, 'home')
  r = await get(`/api/local/list?path=${encodeURIComponent(dir)}`)
  assert.deepEqual(r.json.entries.map(e => e.name), ['Sub', 'a.mov'])
  assert.equal(r.json.parent, files)
  r = await get(`/api/local/list?path=${encodeURIComponent(dir)}&hidden=1`)
  assert.ok(r.json.entries.some(e => e.name === '.oculto'))
  r = await get(`/api/local/list?path=${encodeURIComponent(path.join(dir, 'nao-existe'))}`)
  assert.equal(r.status, 404)
  assert.match(r.json.error, /Não encontrei esta pasta/)
})

// ─────────── transferências de ponta a ponta ───────────

test('download e upload de ponta a ponta pela API, com arquivos de verdade e eventos pelo SSE', async () => {
  const acc = env.accountId
  const pasta = env.mock.addFolder('Documentário Mar Aberto')
  const clip = env.mock.addFile('A001_C001_0612XY.mov', pasta.id, { size: 6 * MiB + 17, seed: 31 })
  env.mock.addFile('Boom_T01.wav', pasta.id, { size: MiB, seed: 32 })
  const destDir = path.join(files, 'baixados')
  const ev = sse()
  try {
    await ev.ready
    let r = await post('/api/transfers/download', { accountId: acc, items: [{ id: pasta.id }], destDir })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.count, 2)
    assert.equal(r.json.bytes, 7 * MiB + 17)
    assert.equal(r.json.batch.type, 'download')
    const batchId = r.json.batch.id
    await waitFor(() => ev.of('batches').some(list => list.some(b => b.id === batchId)))
    const ids = (await get('/api/state')).json.transfers.filter(t => t.batchId === batchId).map(t => t.id)
    assert.equal(ids.length, 2)
    await waitTransfers(ids)
    assert.equal(await md5File(path.join(destDir, 'Documentário Mar Aberto', 'A001_C001_0612XY.mov')), await virtualMd5(31, 6 * MiB + 17))
    assert.equal(await md5File(path.join(destDir, 'Documentário Mar Aberto', 'Boom_T01.wav')), await virtualMd5(32, MiB))
    await waitFor(() => ev.of('transfers').flat().some(t => t.batchId === batchId && t.status === 'completed'))
    assert.ok(ev.of('toast').some(t => /terminou/.test(t.message)), 'aviso de lote concluído')

    // O mesmo pedido de novo: já existe no computador (mesmo tamanho) → nada novo.
    r = await post('/api/transfers/download', { accountId: acc, items: [{ id: clip.id }], destDir: path.join(destDir, 'Documentário Mar Aberto') })
    assert.equal(r.json.count, 0)
    assert.equal(r.json.skipped.length, 1)

    // Upload de uma pasta local.
    const local = path.join(files, 'Envio Áudio')
    const m1 = await randomFile(path.join(local, 'Direto_T01.wav'), 3 * MiB + 5, 41)
    const m2 = await randomFile(path.join(local, 'Sub', 'Lapela.wav'), 700_000, 42)
    r = await post('/api/transfers/upload', { accountId: acc, paths: [local], destFolderId: 'root' })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.count, 2)
    const upIds = (await get('/api/state')).json.transfers.filter(t => t.batchId === r.json.batch.id).map(t => t.id)
    const done = await waitTransfers(upIds)
    const byName = Object.fromEntries(done.map(t => [t.name, t]))
    assert.equal(await env.mock.contentMd5(byName['Direto_T01.wav'].target.fileId), m1)
    assert.equal(await env.mock.contentMd5(byName['Lapela.wav'].target.fileId), m2)
    const folder = env.mock.listAll().find(i => i.name === 'Envio Áudio' && i.isFolder)
    assert.ok(folder, 'a pasta foi criada no Drive')
    assert.ok(!ev.events.some(e => JSON.stringify(e.data).includes('upload_id')), 'a URI da sessão nunca vai para a interface')

    // Ações pela API.
    r = await post('/api/transfers/action', { action: 'remove', ids: [upIds[0]] })
    assert.equal(r.status, 200)
    await waitFor(() => ev.of('removed').flat().includes(upIds[0]))
    r = await post('/api/transfers/action', { action: 'pause' })
    assert.equal(r.status, 400, 'sem ids')
    r = await post('/api/transfers/action', { action: 'cancel', ids: 'all' })
    assert.equal(r.status, 400, '"all" só para pausar/retomar/tentar de novo')
    r = await post('/api/transfers/clear')
    assert.equal(r.status, 200)
    await waitFor(async () => (await get('/api/state')).json.transfers.length === 0)
  } finally {
    ev.close()
  }
})

test('comparar de ponta a ponta: progresso pelo SSE, resultado, subir o que falta e baixar o que só está no Drive', async () => {
  const acc = env.accountId
  const remote = env.mock.addFolder('Comparar Mar Aberto')
  const brutos = env.mock.addFolder('Brutos', remote.id)
  env.mock.addFile('igual.mov', brutos.id, { size: MiB, seed: 51 })
  env.mock.addFile('diferente.mov', brutos.id, { size: MiB, seed: 52 })
  env.mock.addFile('so-no-drive.wav', remote.id, { size: 300_000, seed: 53 })
  const local = path.join(files, 'Comparar Local')
  await randomFile(path.join(local, 'Brutos', 'igual.mov'), MiB, 51)
  await randomFile(path.join(local, 'Brutos', 'diferente.mov'), MiB, 59)
  const faltando = await randomFile(path.join(local, 'Brutos', 'faltando.mov'), 400_000, 54)

  const ev = sse()
  try {
    await ev.ready
    let r = await post('/api/compare', { accountId: acc, localPath: local, driveFolderId: remote.id, mode: 'deep' })
    assert.equal(r.status, 200, r.text)
    const jobId = r.json.jobId
    await waitFor(() => ev.of('compare').some(c => c.jobId === jobId && c.status !== 'running'), { timeoutMs: 20_000 })
    const final = ev.of('compare').filter(c => c.jobId === jobId).at(-1)
    assert.equal(final.status, 'done', final.error)
    assert.ok(ev.of('compare').some(c => c.jobId === jobId && c.status === 'running'), 'progresso enquanto roda')
    r = await get(`/api/compare/${jobId}`)
    assert.equal(r.json.status, 'done')
    const s = r.json.result.summary
    assert.equal(s.synced, 1)
    assert.equal(s.different, 1)
    assert.equal(s.missing, 1)
    assert.equal(s.onlyDrive, 1)
    await fs.stat(path.join(env.paths.compares, `${jobId}.json`)) // gravado para sobreviver a reiniciar

    r = await post(`/api/compare/${jobId}/upload`, {})
    assert.equal(r.json.count, 1)
    const upIds = (await get('/api/state')).json.transfers.filter(t => t.batchId === r.json.batch.id).map(t => t.id)
    const [upDone] = await waitTransfers(upIds)
    assert.equal(await env.mock.contentMd5(upDone.target.fileId), faltando)
    assert.deepEqual(env.mock.getItem(upDone.target.fileId).parents, [brutos.id], 'na pasta certa do Drive')

    r = await post(`/api/compare/${jobId}/download`, {})
    assert.equal(r.json.count, 1)
    const downIds = (await get('/api/state')).json.transfers.filter(t => t.batchId === r.json.batch.id).map(t => t.id)
    await waitTransfers(downIds)
    assert.equal(await md5File(path.join(local, 'so-no-drive.wav')), await virtualMd5(53, 300_000))

    r = await get('/api/compare/cmp-que-nao-existe')
    assert.equal(r.status, 404)
    r = await post('/api/compare', { accountId: acc, localPath: path.join(files, 'nao-existe'), driveFolderId: remote.id })
    const badJob = r.json.jobId
    await waitFor(() => ev.of('compare').some(c => c.jobId === badJob && c.status === 'error'), { timeoutMs: 10_000 })
    const bad = (await get(`/api/compare/${badJob}`)).json
    assert.equal(bad.status, 'error')
    assert.match(bad.error, /Não encontrei/)
    r = await post(`/api/compare/${badJob}/upload`, {})
    assert.equal(r.status, 409)
  } finally {
    ev.close()
  }
})

test('comparar: cancelar no meio para de verdade; limpar apaga o resultado da memória e do disco', async () => {
  const acc = env.accountId
  const remote = env.mock.addFolder('Comparar Limpar')
  env.mock.addFile('a.mov', remote.id, { size: 200_000, seed: 61 })
  const local = path.join(files, 'Comparar Limpar')
  for (let i = 0; i < 40; i++) await randomFile(path.join(local, `p${i % 4}`, `f${i}.mov`), 300_000, 70 + i)

  const ev = sse()
  try {
    await ev.ready
    // Cancelar logo depois de começar (modo completo, que lê cada arquivo).
    let r = await post('/api/compare', { accountId: acc, localPath: local, driveFolderId: remote.id, mode: 'deep' })
    const parar = r.json.jobId
    r = await call('DELETE', `/api/compare/${parar}`)
    assert.equal(r.status, 200, r.text)
    await waitFor(() => ev.of('compare').some(c => c.jobId === parar && c.status !== 'running'), { timeoutMs: 20_000 })
    const fim = ev.of('compare').filter(c => c.jobId === parar).at(-1)
    assert.equal(fim.status, 'canceled')
    assert.match(fim.error, /cancelada/)
    await assert.rejects(fs.stat(path.join(env.paths.compares, `${parar}.json`)), 'cancelada não grava resultado')

    // Comparar até o fim e limpar: some da memória e do disco.
    r = await post('/api/compare', { accountId: acc, localPath: local, driveFolderId: remote.id, mode: 'quick' })
    const jobId = r.json.jobId
    await waitFor(() => ev.of('compare').some(c => c.jobId === jobId && c.status === 'done'), { timeoutMs: 20_000 })
    await fs.stat(path.join(env.paths.compares, `${jobId}.json`))
    r = await post(`/api/compare/${jobId}/limpar`, {})
    assert.equal(r.status, 200, r.text)
    assert.equal((await get(`/api/compare/${jobId}`)).status, 404)
    await assert.rejects(fs.stat(path.join(env.paths.compares, `${jobId}.json`)))
    // Limpar de novo (ou algo que não existe) não dá erro; id estranho é recusado.
    assert.equal((await post(`/api/compare/${jobId}/limpar`, {})).status, 200)
    assert.equal((await post('/api/compare/..%2F..%2Fsettings/limpar', {})).status, 400)
  } finally {
    ev.close()
  }
})

// ─────────── interface ───────────

test('arquivos da interface: index sem cache e com CSP, tipos certos, vendor, 304, nada fora de public/', async () => {
  let r = await get('/')
  assert.equal(r.status, 200)
  assert.match(r.headers['content-type'], /^text\/html/)
  assert.equal(r.headers['cache-control'], 'no-cache')
  assert.match(r.headers['content-security-policy'], /script-src 'self'/)
  assert.match(r.text, /<div id="app">/)
  for (const [p, type] of [['/app.js', /^text\/javascript/], ['/styles.css', /^text\/css/], ['/favicon.svg', /^image\/svg\+xml/], ['/lib/api.js', /^text\/javascript/]]) {
    r = await get(p)
    assert.equal(r.status, 200, p)
    assert.match(r.headers['content-type'], type, p)
    assert.equal(r.headers['x-content-type-options'], 'nosniff')
  }
  r = await get('/vendor/preact-htm.js')
  assert.equal(r.status, 200)
  assert.match(r.headers['content-type'], /^text\/javascript/)
  assert.match(r.text, /export/)
  const again = await get('/vendor/preact-htm.js', { headers: { 'if-none-match': r.headers.etag } })
  assert.equal(again.status, 304)
  r = await call('HEAD', '/app.js')
  assert.equal(r.status, 200)
  assert.equal(r.text, '')

  for (const p of ['/../package.json', '/%2e%2e/package.json', '/lib/%2e%2e/%2e%2e/package.json', '/.gitignore', '/nao-existe.js', '/%00.js']) {
    r = await get(p)
    assert.equal(r.status, 404, p)
    assert.ok(!r.text.includes('"name": "sobedesce"'), p)
  }
  r = await get('/qualquer/rota')
  assert.equal(r.status, 200, 'rota da interface cai no index')
  assert.match(r.text, /<div id="app">/)
})

test('/api/reveal valida o caminho e chama o gerenciador de arquivos do sistema', async () => {
  const f = path.join(files, 'mostrar.mov')
  await fs.writeFile(f, 'x')
  let r = await post('/api/reveal', { path: 'relativo/x.mov' })
  assert.equal(r.status, 400)
  r = await post('/api/reveal', { path: path.join(files, 'sumiu.mov') })
  assert.equal(r.status, 404)
  r = await post('/api/reveal', {})
  assert.equal(r.status, 400)
  spawned.length = 0
  r = await post('/api/reveal', { path: f })
  assert.equal(r.status, 200)
  assert.equal(spawned.length, 1)
  const { cmd, args, opts } = spawned[0]
  if (process.platform === 'darwin') assert.deepEqual([cmd, args], ['open', ['-R', f]])
  else if (process.platform === 'win32') assert.deepEqual([cmd, args], ['explorer.exe', ['/select,', f]])
  else assert.deepEqual([cmd, args], ['xdg-open', [files]])
  assert.equal(opts.detached, true)
})

// ─────────── login ───────────

test('login pelo navegador: /api/auth/start → Google (mock) → /oauth/callback → a conta aparece', async () => {
  const ev = sse()
  try {
    await ev.ready
    // Chave do Google colada (o JSON do Console) — a mesma do mock.
    let r = await post('/api/setup/credentials', { json: JSON.stringify({ installed: { client_id: env.mock.client.clientId, client_secret: env.mock.client.clientSecret } }) })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.setup.configured, true)
    await waitFor(() => ev.of('setup').length === 1)
    r = await post('/api/setup/credentials', { clientId: 'errado', clientSecret: 'x' })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /Client ID/)

    // Sai da conta e entra de novo pelo fluxo do navegador.
    r = await call('DELETE', `/api/accounts/${env.accountId}`, { body: {} })
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.accounts, [])
    await waitFor(() => ev.of('accounts').some(list => list.length === 0))

    r = await get('/api/auth/start')
    assert.equal(r.status, 302)
    const consent = new URL(r.headers.location)
    assert.ok(consent.href.startsWith(env.mock.url), consent.href)
    assert.equal(consent.searchParams.get('redirect_uri'), `http://127.0.0.1:${app.port}/oauth/callback`)
    assert.equal(consent.searchParams.get('code_challenge_method'), 'S256')

    // O "navegador" segue o consentimento do mock até o callback.
    const back = await new Promise((resolve, reject) => {
      http.get(consent, { agent: false }, res => {
        res.resume()
        resolve(res.headers.location)
      }).on('error', reject)
    })
    const cb = new URL(back)
    assert.equal(cb.pathname, '/oauth/callback')
    r = await get(cb.pathname + cb.search)
    assert.equal(r.status, 200)
    assert.match(r.headers['content-type'], /^text\/html/)
    assert.match(r.text, /Conta conectada/)
    assert.match(r.text, /url=\/#\/transferencias/)
    assert.match(r.headers['content-security-policy'], /default-src 'none'/)

    const state = (await get('/api/state')).json
    assert.equal(state.accounts.length, 1)
    assert.equal(state.accounts[0].email, 'ana.montadora@example.com')
    await waitFor(() => ev.of('accounts').some(list => list.length === 1 && list[0].status === 'ok'))

    // Callback repetido (state já usado) ou com erro: página amigável, sem pilha.
    r = await get(cb.pathname + cb.search)
    assert.equal(r.status, 400)
    assert.match(r.text, /Não deu para conectar a conta/)
    assert.match(r.text, /Tente conectar de novo/)
    assert.ok(!/at .*\.js:\d+/.test(r.text))
    r = await get('/oauth/callback?error=access_denied&state=qualquer')
    assert.equal(r.status, 400)
    assert.match(r.text, /href="\/api\/auth\/start"/)
  } finally {
    ev.close()
  }
})

// ─────────── app ───────────

test('startApp: sem chave, "conectar" leva para os primeiros passos; trava de instância; encerrar libera', async () => {
  const home = await makeTmpDir('sobedesce-app-')
  try {
    const a = await startApp({ home, port: 0, open: false, quiet: true, managerOptions: { keepAwake } })
    try {
      const r = await get('/api/auth/start', { port: a.port })
      assert.equal(r.status, 302)
      assert.equal(r.headers.location, '/#/inicio')
      const lock = JSON.parse(await fs.readFile(path.join(home, 'engine.lock'), 'utf8'))
      assert.equal(lock.pid, process.pid)
      assert.equal(lock.url, a.url)
      await assert.rejects(startApp({ home, port: 0, open: false, quiet: true, managerOptions: { keepAwake } }), err => {
        assert.equal(err.code, 'ALREADY_RUNNING')
        assert.equal(err.url, a.url)
        assert.equal(err.message, 'O SOBEDESCE já está aberto neste computador.')
        return true
      })
    } finally {
      await a.shutdown()
    }
    await assert.rejects(fs.stat(path.join(home, 'engine.lock')), { code: 'ENOENT' })
    // Trava de um motor morto é ignorada.
    await fs.writeFile(path.join(home, 'engine.lock'), JSON.stringify({ pid: 999_999_999, url: 'http://127.0.0.1:9', startedAt: 1 }))
    const b = await startApp({ home, port: 0, open: false, quiet: true, managerOptions: { keepAwake } })
    await b.shutdown()
    const queue = JSON.parse(await fs.readFile(path.join(home, 'queue.json'), 'utf8'))
    assert.deepEqual(queue.transfers, [])
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('startApp: faixa de portas toda ocupada (ou reservada pelo Windows) → o sistema escolhe outra porta', async () => {
  const net = await import('node:net')
  const home = await makeTmpDir('sobedesce-porta-')
  // Acha 21 portas livres seguidas e ocupa todas.
  const ocupadas = []
  let base = 0
  for (let tentativa = 0; tentativa < 20 && !ocupadas.length; tentativa++) {
    base = 30000 + Math.floor(Math.random() * 20000)
    const abertos = []
    try {
      for (let i = 0; i < 21; i++) {
        const s = net.createServer()
        await new Promise((resolve, reject) => s.once('error', reject).listen(base + i, '127.0.0.1', resolve))
        abertos.push(s)
      }
      ocupadas.push(...abertos)
    } catch {
      for (const s of abertos) s.close()
    }
  }
  assert.ok(ocupadas.length, 'não achei 21 portas livres seguidas')
  try {
    const a = await startApp({ home, port: base, open: false, quiet: true, managerOptions: { keepAwake } })
    try {
      assert.ok(a.port < base || a.port > base + 20, `porta ${a.port}`)
      const r = await get('/api/state', { port: a.port })
      assert.equal(r.status, 200)
    } finally {
      await a.shutdown()
    }
  } finally {
    for (const s of ocupadas) s.close()
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('motor sobe com mais threads de disco (UV_THREADPOOL_SIZE) antes de qualquer uso do pool', async () => {
  const { execFile } = await import('node:child_process')
  const entry = new URL('../src/index.js', import.meta.url).href
  const code = `const before = process.env.UV_THREADPOOL_SIZE ?? ''; await import(${JSON.stringify(entry)}); console.log(JSON.stringify({ before, after: process.env.UV_THREADPOOL_SIZE }))`
  const env = { ...process.env }
  delete env.UV_THREADPOOL_SIZE
  const out = await new Promise((resolve, reject) =>
    execFile(process.execPath, ['--input-type=module', '-e', code], { env, timeout: 20_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  )
  const { before, after } = JSON.parse(out.trim().split('\n').pop())
  assert.equal(before, '')
  assert.ok(Number(after) >= 16, `UV_THREADPOOL_SIZE=${after}`)
  // O app de desktop repassa o mesmo ajuste ao processo do motor.
  const main = await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8')
  assert.match(main, /UV_THREADPOOL_SIZE/)
})
