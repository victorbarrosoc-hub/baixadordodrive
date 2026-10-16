// App inteiro com a conta SOBEDESCE (site falso + Drive falso): rotas /api/cloud/*, SSE, upload/download de verdade
// com conta `nuvem:`, 409 reconectar (job pausa e volta sozinho), 401 da nuvem (sai da conta) e sair pelo botão.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { MSG_RECONNECT } from '../src/google/cloud-auth.js'
import { startApp } from '../src/index.js'
import { closeHttp } from '../src/net/http.js'
import { makeTmpDir, waitFor, randomFile, md5File } from './helpers.js'
import { startMockDrive, virtualMd5 } from './mock-drive.js'
import { startMockCloud } from './mock-cloud.js'

const MiB = 1024 * 1024
const FAST = { pollMs: 20, retryBaseMs: 5, refreshEveryMs: 0, deviceName: 'MacBook de Teste', platform: 'darwin' }

let mock, site, home, files, app

const keepAwake = { active: false, setActive() {}, stop() {} }

before(async () => {
  home = await makeTmpDir()
  files = await makeTmpDir('sobedesce-cloud-files-')
  mock = await startMockDrive()
  mock.applyEnv()
  site = await startMockCloud({ drive: mock })
  app = await startApp({
    home,
    port: 0,
    open: false,
    quiet: true,
    cloudOptions: { ...FAST, baseUrl: site.url },
    managerOptions: { keepAwake, taskOptions: { download: { retryBaseMs: 5, checkpointMs: 200 }, upload: { retryBaseMs: 5 } } },
    serverOptions: { log: () => {} },
    acompanharOptions: { ativoMs: 150, ociosoMs: 2000, eventoMs: 20, minGapMs: 20, log: () => {} },
  })
  await app.settings.update({ keepAwake: false, connectionsPerDownload: 4, minSegmentSize: MiB })
})

after(async () => {
  await app?.shutdown()
  await site?.close().catch(() => {})
  await mock?.close()
  await fs.rm(home, { recursive: true, force: true, maxRetries: 3 })
  await fs.rm(files, { recursive: true, force: true, maxRetries: 3 })
  await closeHttp()
})

function call(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const h = { host: `127.0.0.1:${app.port}`, ...headers }
    if (method !== 'GET' && !Object.keys(h).some(k => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json'
    if (data != null) h['content-length'] = Buffer.byteLength(data)
    const req = http.request({ host: '127.0.0.1', port: app.port, method, path: p, headers: h, agent: false }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {}
        resolve({ status: res.statusCode, text, json })
      })
    })
    req.on('error', reject)
    if (data != null) req.write(data)
    req.end()
  })
}
const get = p => call('GET', p)
const post = (p, body = {}, opts) => call('POST', p, { body, ...opts })

function sse() {
  const events = []
  let buf = ''
  const req = http.request({ host: '127.0.0.1', port: app.port, path: '/api/events', headers: { host: `127.0.0.1:${app.port}`, accept: 'text/event-stream' }, agent: false })
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
  return { ready, of: name => events.filter(e => e.event === name).map(e => e.data), close: () => req.destroy() }
}

async function transfersOf(ids) {
  return (await get('/api/state')).json.transfers.filter(t => ids.includes(t.id))
}

async function waitTransfers(ids, statuses = ['completed', 'skipped'], timeoutMs = 30_000) {
  let last
  await waitFor(async () => {
    last = await transfersOf(ids)
    if (last.some(t => t.status === 'failed')) throw new Error(`falhou: ${JSON.stringify(last.map(t => t.error))}`)
    return last.length === ids.length && last.every(t => statuses.includes(t.status))
  }, { timeoutMs, intervalMs: 50, message: `as transferências não chegaram a ${statuses}` })
  return last
}

test('rotas: entrar pela API (código + URL), estado pelo SSE, segurança das rotas', async () => {
  let r = await get('/api/state')
  assert.equal(r.json.cloud.conectado, false)
  assert.equal(r.json.cloud.site, site.url)
  assert.equal(r.json.accounts.length, 0)

  // Mesmas regras das outras rotas: sem JSON 415, Origin de fora 403.
  r = await call('POST', '/api/cloud/login', { headers: { 'content-type': 'text/plain' } })
  assert.equal(r.status, 415)
  r = await post('/api/cloud/login', {}, { headers: { origin: 'https://evil.example' } })
  assert.equal(r.status, 403)
  assert.equal(site.stats.iniciar, 0)

  const ev = sse()
  try {
    await ev.ready
    r = await post('/api/cloud/login')
    assert.equal(r.status, 200, r.text)
    const { login } = r.json.cloud
    assert.equal(login.estado, 'pendente')
    assert.match(login.codigo, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    assert.ok(login.url.includes(login.codigo))
    await waitFor(() => ev.of('cloud').some(s => s.login.estado === 'pendente'))
    site.approve(login.codigo)
    await waitFor(() => ev.of('cloud').some(s => s.login.estado === 'pronto' && s.contas.length === 2), { message: 'SSE cloud pronto' })
    await waitFor(() => ev.of('accounts').some(list => list.length === 2 && list.every(a => a.source === 'nuvem')))
  } finally {
    ev.close()
  }
  r = await get('/api/cloud')
  assert.equal(r.json.cloud.conectado, true)
  assert.equal(r.json.cloud.usuario.nome, 'Ana Montadora')
  r = await post('/api/cloud/refresh')
  assert.equal(r.status, 200)
  assert.equal(r.json.cloud.contas.length, 2)
  r = await call('DELETE', '/api/accounts/nuvem%3Ag1')
  assert.equal(r.status, 400)
  assert.match(r.json.error, /conta SOBEDESCE/)
  // A rota do Drive aceita o id com ':' (codificado).
  r = await get('/api/drive/nuvem%3Ag1/list')
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.folder.name, 'Meu Drive')
})

test('upload e download de verdade no Drive falso usando uma conta nuvem:', async () => {
  const local = path.join(files, 'Envio Nuvem')
  const m1 = await randomFile(path.join(local, 'Brutos_A001.mov'), 3 * MiB + 11, 71)
  const m2 = await randomFile(path.join(local, 'Sub', 'Som.wav'), 600_000, 72)
  let r = await post('/api/transfers/upload', { accountId: 'nuvem:g1', paths: [local], destFolderId: 'root' })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.count, 2)
  const upIds = (await get('/api/state')).json.transfers.filter(t => t.batchId === r.json.batch.id).map(t => t.id)
  const done = await waitTransfers(upIds)
  const by = Object.fromEntries(done.map(t => [t.name, t]))
  assert.equal(by['Brutos_A001.mov'].accountId, 'nuvem:g1')
  assert.equal(await mock.contentMd5(by['Brutos_A001.mov'].target.fileId), m1)
  assert.equal(await mock.contentMd5(by['Som.wav'].target.fileId), m2)

  // Acompanhar pelo celular: o site recebeu o andamento e, no fim, "concluído" com os dois arquivos em "Já passou".
  await waitFor(() => site.andamento.some(a => a.corpo?.estado === 'concluido' && a.corpo.terminados.some(t => t.nome === 'Som.wav')))
  assert.equal(app.manager.batches.get(r.json.batch.id).destino, 'Meu Drive') // a pasta de destino, para a lista do celular
  const fim = site.andamento.findLast(a => a.corpo?.estado === 'concluido').corpo
  assert.equal(fim.geral.feitos, 2)
  assert.equal(fim.geral.totalBytes, 3 * MiB + 11 + 600_000)
  assert.ok(!JSON.stringify(fim).includes(files), 'sem caminhos do computador')

  const clip = mock.addFile('Entrega_v3.mov', 'root', { size: 5 * MiB + 3, seed: 73 })
  const dest = path.join(files, 'baixados')
  r = await post('/api/transfers/download', { accountId: 'nuvem:g2', items: [{ id: clip.id }], destDir: dest })
  assert.equal(r.status, 200, r.text)
  const downIds = (await get('/api/state')).json.transfers.filter(t => t.batchId === r.json.batch.id).map(t => t.id)
  await waitTransfers(downIds)
  assert.equal(await md5File(path.join(dest, 'Entrega_v3.mov')), await virtualMd5(73, 5 * MiB + 3))

  // A fila grava o accountId como veio (nuvem:...).
  await app.manager.queueFile.save()
  const queue = JSON.parse(await fs.readFile(app.paths.queue, 'utf8'))
  const recs = Array.isArray(queue) ? queue : queue.records || queue.transfers || []
  assert.ok(JSON.stringify(recs).includes('nuvem:g2'))
})

test('409 reconectar → o job pausa com erro reauth; reconectado no site, volta sozinho', async () => {
  site.setEstado('g1', 'reconectar')
  mock.expireAccessTokens() // o token guardado leva 401 do Google → renovar → 409
  const local = path.join(files, 'Depois.wav')
  const md5 = await randomFile(local, 2 * MiB + 1, 81)
  let r = await post('/api/transfers/upload', { accountId: 'nuvem:g1', paths: [local], destFolderId: 'root' })
  // Planejar já usa o Drive: pode falhar na hora (401) ou entrar na fila e pausar.
  let ids
  if (r.status === 200) {
    ids = (await get('/api/state')).json.transfers.filter(t => t.batchId === r.json.batch.id).map(t => t.id)
    const [t] = await waitTransfers(ids, ['paused'])
    assert.equal(t.error.kind, 'reauth')
    assert.equal(t.error.message, MSG_RECONNECT)
  } else {
    assert.equal(r.status, 401, r.text)
    assert.equal(r.json.error, MSG_RECONNECT)
  }
  r = await get('/api/state')
  assert.equal(r.json.accounts.find(a => a.id === 'nuvem:g1').status, 'reauth')
  assert.equal(r.json.accounts.find(a => a.id === 'nuvem:g2').status, 'ok')

  // Reconectou no site; a interface pede para recarregar a lista.
  site.setEstado('g1', 'ok')
  r = await post('/api/cloud/refresh')
  assert.equal(r.json.cloud.contas.find(a => a.id === 'nuvem:g1').status, 'ok')
  if (!ids) {
    r = await post('/api/transfers/upload', { accountId: 'nuvem:g1', paths: [local], destFolderId: 'root' })
    assert.equal(r.status, 200, r.text)
    ids = (await get('/api/state')).json.transfers.filter(t => t.batchId === r.json.batch.id).map(t => t.id)
  }
  const [t] = await waitTransfers(ids)
  assert.equal(await mock.contentMd5(t.target.fileId), md5)
})

test('pausa por 409 no meio do envio', async () => {
  // Envio lento e em pedaços (cada pedaço é uma requisição com token): dá tempo de o site mandar reconectar no meio.
  mock.setOptions({ perConnectionBps: 2 * MiB })
  await app.settings.update({ uploadChunkSize: MiB })
  try {
    const local = path.join(files, 'Grande.mov')
    await randomFile(local, 12 * MiB, 91)
    let r = await post('/api/transfers/upload', { accountId: 'nuvem:g2', paths: [local], destFolderId: 'root' })
    assert.equal(r.status, 200, r.text)
    const ids = (await get('/api/state')).json.transfers.filter(t => t.batchId === r.json.batch.id).map(t => t.id)
    await waitFor(async () => (await transfersOf(ids))[0]?.bytesDone > 0 || (await transfersOf(ids))[0]?.status === 'running', { timeoutMs: 10_000 })
    site.setEstado('g2', 'reconectar')
    mock.expireAccessTokens()
    const [t] = await waitTransfers(ids, ['paused'], 20_000)
    assert.equal(t.error.kind, 'reauth')
    assert.equal(t.error.message, MSG_RECONNECT)
    mock.setOptions({ perConnectionBps: 0 })
    site.setEstado('g2', 'ok')
    await post('/api/cloud/refresh')
    await waitTransfers(ids)
  } finally {
    mock.setOptions({ perConnectionBps: 0 })
    await app.settings.update({ uploadChunkSize: 0 })
  }
})

test('401 da nuvem → sai da conta e avisa a interface; entrar de novo e sair pelo botão', async () => {
  const ev = sse()
  try {
    await ev.ready
    site.revokeSessions()
    const r = await post('/api/cloud/refresh')
    assert.equal(r.status, 200)
    assert.equal(r.json.cloud.conectado, false)
    await waitFor(() => ev.of('toast').some(t => /sessão na conta SOBEDESCE terminou/.test(t.message)))
    await waitFor(() => ev.of('accounts').some(list => list.length === 0))
    await assert.rejects(fs.stat(app.paths.cloud), { code: 'ENOENT' })
  } finally {
    ev.close()
  }
  // Entra de novo e sai pelo botão "Sair da conta".
  let r = await post('/api/cloud/login')
  site.approve(r.json.cloud.login.codigo)
  await waitFor(async () => (await get('/api/cloud')).json.cloud.contas.length === 2)
  r = await post('/api/cloud/logout')
  assert.equal(r.status, 200)
  assert.equal(r.json.cloud.conectado, false)
  assert.equal(site.activeSessions().length, 0)
  assert.equal((await get('/api/state')).json.accounts.length, 0)
})
