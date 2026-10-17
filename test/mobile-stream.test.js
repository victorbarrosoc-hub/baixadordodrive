// Recepção pelo Wi-Fi em fluxo (relatório de rede, 4.12): o computador abre a sessão no Drive assim que o arquivo do
// celular começa a chegar e sobe o que já foi gravado enquanto o resto chega. Celular falso (PUTs com ritmo
// controlado) + Drive falso (banda por conexão). Cobre: o PUT começando antes do fim e o tempo ≈ a maior perna,
// celular lento sem falso travamento, celular que cai e volta (retoma do ponto do Google), cancelamento, limite
// diário e arquivo pequeno (caminho antigo), MD5 conferido no fim (e refeito quando não bate), fechar o app no meio e
// duas recepções com o mesmo nome.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { startApp } from '../src/index.js'
import { closeHttp } from '../src/net/http.js'
import { PARTS_DIR } from '../src/mobile/receiver.js'
import { setupDrive, makeTmpDir, waitFor } from './helpers.js'

const KiB = 1024
const MiB = 1024 * 1024
const keepAwake = { active: false, setActive() {}, stop() {} }
const UPLOAD = { retryBaseMs: 5, feedIdleMs: 20_000, feedParkMs: 60_000 }

let env
let app
let stage
let folder

async function boot() {
  const a = await startApp({
    home: env.home,
    port: 0,
    open: false,
    quiet: true,
    managerOptions: { keepAwake, taskOptions: { upload: { ...UPLOAD } } },
    serverOptions: { log: () => {} },
    mobileOptions: { port: 0, host: '127.0.0.1', log: () => {} },
  })
  await a.settings.update({ keepAwake: false, mobileStagingDir: stage, mobileReceive: true })
  await a.mobile.status()
  return a
}

before(async () => {
  env = await setupDrive()
  stage = await makeTmpDir('sobedesce-fluxo-')
  folder = env.mock.addFolder('Do Celular')
  app = await boot()
})

after(async () => {
  await app?.shutdown()
  await env?.cleanup()
  if (stage) await fs.rm(stage, { recursive: true, force: true, maxRetries: 3 })
  await closeHttp()
})

beforeEach(() => {
  Object.assign(app.manager.taskOptions.upload, UPLOAD)
  env.mock.setOptions({ perConnectionBps: 0, uploadDailyLimitBytes: 0 })
})

// ─────────── celular falso ───────────

const code = () => app.mobile.code
const auth = (extra = {}) => ({ 'x-sobedesce-code': code(), ...extra })
const md5 = buf => crypto.createHash('md5').update(buf).digest('hex')

function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body))
    const headers = auth(data ? { 'content-type': 'application/json', 'content-length': data.length } : {})
    const req = http.request({ host: '127.0.0.1', port: app.mobile.port, method, path: p, headers, agent: false }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(data ?? undefined)
  })
}

/** Um pedaço no ritmo de `bps` (0 = sem limite), em fatias de 256 KiB, como o XHR do celular. */
function putPaced(id, offset, buf, { bps = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: app.mobile.port,
      method: 'PUT',
      path: `/m/api/uploads/${id}`,
      agent: false,
      headers: auth({ 'upload-offset': String(offset), 'content-type': 'application/octet-stream', 'content-length': buf.length }),
    })
    req.on('response', res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }))
    })
    req.on('error', reject)
    ;(async () => {
      const t0 = performance.now()
      for (let off = 0; off < buf.length; off += 256 * KiB) {
        const slice = buf.subarray(off, off + 256 * KiB)
        if (!req.write(slice)) await once(req, 'drain')
        if (bps > 0) {
          const wait = t0 + ((off + slice.length) / bps) * 1000 - performance.now()
          if (wait > 0) await delay(wait)
        }
      }
      req.end()
    })().catch(reject)
  })
}

/** O celular manda de `from` até `to` em pedaços de `chunk`, com `pauseMs` entre eles. Devolve a última resposta. */
async function phoneSend(id, data, { from = 0, to = data.length, chunk = 8 * MiB, bps = 0, pauseMs = 0 } = {}) {
  let r = null
  for (let off = from; off < to; ) {
    const end = Math.min(to, off + chunk)
    r = await putPaced(id, off, data.subarray(off, end), { bps })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.offset, end)
    off = end
    if (pauseMs && off < to) await delay(pauseMs)
  }
  return r
}

const create = meta => call('POST', '/m/api/uploads', meta)
const transfersNamed = name => app.manager.snapshot().transfers.filter(t => t.name === name)

async function driveDone(id, { timeoutMs = 60_000 } = {}) {
  let last
  await waitFor(
    async () => {
      last = (await call('GET', `/m/api/uploads/${id}`)).json
      return ['completed', 'skipped', 'failed'].includes(last?.drive?.status)
    },
    { timeoutMs, intervalMs: 50, message: 'o envio pro Drive não terminou' },
  )
  assert.equal(last.drive.status, 'completed', JSON.stringify(last.drive))
  return { view: last, item: env.mock.getItem(last.drive.fileId) }
}

// ─────────── testes ───────────

test('em fluxo: o PUT começa antes de o arquivo terminar de chegar e o tempo total fica perto da maior perna', async t0ctx => {
  const size = 48 * MiB
  const lanBps = 16 * MiB
  const driveBps = 12 * MiB
  env.mock.setOptions({ perConnectionBps: driveBps })
  env.mock.resetStats()
  const data = crypto.randomBytes(size)
  const name = 'A001 Entrevista em fluxo.mov'
  const t0 = performance.now()
  const { json } = await create({ name, size, folderId: folder.id })
  assert.equal(json.status, 'receiving')

  let firstUp = null
  let sawReceive = false
  const watch = setInterval(() => {
    const t = transfersNamed(name)[0]
    if (!t) return
    if (t.receive && t.receive.size === size) sawReceive = true
    if (firstUp == null && t.bytesDone > 0) firstUp = performance.now()
  }, 20)
  try {
    await phoneSend(json.id, data, { bps: lanBps })
    const phoneDone = performance.now()
    const { item } = await driveDone(json.id)
    const total = (performance.now() - t0) / 1000
    const lan = size / lanBps
    const up = size / driveBps
    t0ctx.diagnostic(`LAN ${lan.toFixed(1)} s, Drive ${up.toFixed(1)} s, soma ${(lan + up).toFixed(1)} s; em fluxo ${total.toFixed(2)} s; 1º byte no Drive aos ${((firstUp - t0) / 1000).toFixed(2)} s, celular terminou aos ${((phoneDone - t0) / 1000).toFixed(2)} s`)
    assert.ok(firstUp != null && firstUp < phoneDone, 'o envio pro Drive começou antes de o arquivo terminar de chegar')
    assert.ok(sawReceive, 'a linha da transferência mostra quanto já chegou do celular')
    // Antes: LAN + internet (≈ 7 s). Em fluxo: ≈ a maior perna (4 s) + o fim.
    assert.ok(total < (lan + up) * 0.85, `tempo total ${total.toFixed(2)} s (LAN ${lan} s + Drive ${up} s)`)
    assert.ok(total > up * 0.9, `rápido demais para o limite do Drive falso: ${total.toFixed(2)} s`)

    assert.equal(item.md5, md5(data))
    assert.equal(await env.mock.contentMd5(item.id), md5(data))
    const t = transfersNamed(name)[0]
    assert.equal(t.status, 'completed')
    assert.equal(t.verify?.state, 'ok')
    assert.equal(t.local.growing, false)
    assert.equal(t.local.path, path.join(stage, name), 'o registro passa a apontar para o arquivo final')
    assert.equal(t.receive, undefined)
    assert.equal(env.mock.stats().uploadSessionsCreated, 1)
    assert.deepEqual(await fs.readdir(path.join(stage, PARTS_DIR)), [])
  } finally {
    clearInterval(watch)
  }
})

test('celular lento: esperar o celular dentro do PUT não é travamento', async () => {
  await app.settings.update({ stallTimeoutMs: 5000 })
  try {
    env.mock.resetStats()
    const size = 40 * MiB
    const data = crypto.randomBytes(size)
    const name = 'celular lento.mov'
    const { json } = await create({ name, size, folderId: folder.id })
    // Primeiro pedaço, 6,5 s parado (mais que o detector de travamento, menos que o tempo de espera do celular) e o resto.
    await phoneSend(json.id, data, { to: 8 * MiB })
    await waitFor(() => transfersNamed(name)[0]?.bytesDone >= 8 * MiB - 256 * KiB, { timeoutMs: 10_000, message: 'o primeiro pedaço não subiu' })
    await delay(6500)
    assert.equal(transfersNamed(name)[0].status, 'running')
    await phoneSend(json.id, data, { from: 8 * MiB })
    const { item } = await driveDone(json.id)
    assert.equal(item.md5, md5(data))
    const s = env.mock.stats()
    assert.equal(s.uploadPuts, 1, 'um PUT só, do começo ao fim (nenhuma reconexão por "travamento")')
    assert.equal(s.statusQueries, 0)
  } finally {
    await app.settings.update({ stallTimeoutMs: 30_000 })
  }
})

test('celular cai no meio e volta: a sessão fica pela metade, a vaga é solta e o envio retoma do ponto do Google', async () => {
  Object.assign(app.manager.taskOptions.upload, { feedIdleMs: 300, feedParkMs: 300 })
  env.mock.resetStats()
  const size = 40 * MiB
  const data = crypto.randomBytes(size)
  const name = 'caiu no meio.mov'
  const meta = { name, size, folderId: folder.id }
  const { json } = await create(meta)
  await phoneSend(json.id, data, { to: 16 * MiB })
  // O celular sumiu: o PUT fecha, o Google guarda o que chegou e a transferência espera fora da vaga.
  let t
  await waitFor(() => {
    t = transfersNamed(name)[0]
    return t?.status === 'queued' && t.bytesDone > 0
  }, { timeoutMs: 10_000, message: 'a transferência não soltou a vaga' })
  assert.ok(t.receive, 'continua mostrando quanto chegou')
  const session = env.mock.listUploadSessions().find(s => s.declaredLength === size && !s.completed)
  assert.ok(session && session.committed > 0 && session.committed <= 16 * MiB, JSON.stringify(session))
  assert.equal(t.bytesDone, session.committed)
  await delay(500)
  assert.equal(transfersNamed(name)[0].status, 'queued', 'sem nada novo do celular, não ocupa vaga de novo')

  // Voltou: a página pergunta onde parou e manda o resto.
  const again = await create(meta)
  assert.equal(again.json.id, json.id)
  assert.equal(again.json.offset, 16 * MiB)
  await phoneSend(json.id, data, { from: 16 * MiB })
  const { item } = await driveDone(json.id)
  assert.equal(item.md5, md5(data))
  const s = env.mock.stats()
  assert.equal(s.uploadSessionsCreated, 1, 'a mesma sessão retomada')
  // Nada foi mandado de novo do zero: o Drive recebeu pouco mais que o arquivo.
  assert.ok(s.bytesReceived < size + 4 * MiB, `o Drive recebeu ${s.bytesReceived} bytes para um arquivo de ${size}`)
})

test('cancelar no celular: a sessão no Drive é encerrada, a transferência sai da fila e o pedaço some', async () => {
  const size = 40 * MiB
  const data = crypto.randomBytes(size)
  const name = 'desisti.mov'
  const { json } = await create({ name, size, folderId: folder.id })
  await phoneSend(json.id, data, { to: 16 * MiB })
  let t
  await waitFor(() => (t = transfersNamed(name)[0])?.bytesDone > 0, { timeoutMs: 10_000, message: 'não começou a subir' })
  const before = env.mock.listUploadSessions().filter(s => s.declaredLength === size && !s.completed)
  assert.equal(before.length, 1)
  const del = await call('DELETE', `/m/api/uploads/${json.id}`)
  assert.deepEqual(del.json, { ok: true, removed: true })
  assert.equal(app.manager.get(t.id), null)
  assert.equal(transfersNamed(name).length, 0)
  await waitFor(() => !env.mock.listUploadSessions().some(s => s.id === before[0].id), { message: 'a sessão do Drive não foi encerrada' })
  assert.deepEqual(await fs.readdir(path.join(stage, PARTS_DIR)), [])
  assert.ok(!env.mock.listAll().some(it => it.name === name))
  assert.equal((await call('GET', `/m/api/uploads/${json.id}`)).status, 404)
})

test('arquivo pequeno (< 32 MiB): recebe tudo e só depois sobe, como antes', async () => {
  const size = 12 * MiB
  const data = crypto.randomBytes(size)
  const name = 'pequeno.mov'
  const { json } = await create({ name, size, folderId: folder.id })
  await phoneSend(json.id, data, { to: 8 * MiB })
  await delay(300)
  assert.equal(transfersNamed(name).length, 0, 'nada na fila enquanto chega')
  await phoneSend(json.id, data, { from: 8 * MiB })
  const { item } = await driveDone(json.id)
  assert.equal(item.md5, md5(data))
  const t = transfersNamed(name)[0]
  assert.equal(t.local.path, path.join(stage, name))
  assert.ok(!t.local.stream)
})

test('conta no limite diário: recebe tudo e só depois enfileira (caminho antigo)', async () => {
  // Um envio comum bate no limite de 750 GB/dia do Drive falso: a conta fica "esperando a cota".
  env.mock.setOptions({ uploadDailyLimitBytes: 1 })
  const small = crypto.randomBytes(300 * KiB)
  const first = await create({ name: 'antes do limite.mov', size: small.length, folderId: folder.id })
  await phoneSend(first.json.id, small)
  await waitFor(() => transfersNamed('antes do limite.mov')[0]?.status === 'waiting', { timeoutMs: 10_000, message: 'o limite diário não apareceu' })
  assert.equal(transfersNamed('antes do limite.mov')[0].error.reason, 'uploadLimitExceeded')
  try {
    const size = 40 * MiB
    const data = crypto.randomBytes(size)
    const name = 'depois do limite.mov'
    const { json } = await create({ name, size, folderId: folder.id })
    await phoneSend(json.id, data, { to: 24 * MiB })
    await delay(300)
    assert.equal(transfersNamed(name).length, 0, 'em fluxo não: nada na fila enquanto chega')
    await phoneSend(json.id, data, { from: 24 * MiB })
    await waitFor(() => transfersNamed(name).length === 1, { message: 'chegou inteiro e não entrou na fila' })
    const t = transfersNamed(name)[0]
    assert.equal(t.local.path, path.join(stage, name))
    assert.ok(!t.local.stream)
  } finally {
    const ids = app.manager.snapshot().transfers.filter(t => t.status !== 'completed').map(t => t.id)
    await app.manager.remove(ids)
    env.mock.setOptions({ uploadDailyLimitBytes: 0 })
  }
})

test('MD5 no fim: se o arquivo no disco não bate com o que subiu, o envio é refeito a partir do disco', async () => {
  const size = 40 * MiB
  const data = crypto.randomBytes(size)
  const name = 'mexeram no disco.mov'
  env.mock.resetStats()
  const { json } = await create({ name, size, folderId: folder.id })
  await phoneSend(json.id, data, { to: 16 * MiB })
  await waitFor(() => transfersNamed(name)[0]?.bytesDone >= 8 * MiB, { timeoutMs: 10_000, message: 'não começou a subir' })
  // Depois de subir, o começo do arquivo muda no disco (defeito, outro programa): o Drive tem o original.
  const part = path.join(stage, PARTS_DIR, `${json.id}.sobedesce-part`)
  const fh = await fs.open(part, 'r+')
  await fh.write(Buffer.alloc(4096, 0x5a), 0, 4096, 0)
  await fh.close()
  await phoneSend(json.id, data, { from: 16 * MiB })
  await waitFor(() => transfersNamed(name)[0]?.status === 'completed', { timeoutMs: 30_000, message: 'não terminou depois de refazer' })
  const t = transfersNamed(name)[0]
  const local = await fs.readFile(t.local.path)
  assert.notEqual(md5(local), md5(data))
  assert.equal(t.verify.state, 'ok')
  assert.equal(t.verify.expected, md5(local))
  assert.equal(await env.mock.contentMd5(t.target.fileId), md5(local), 'o Drive ficou com o que está no disco')
  assert.ok(env.mock.stats().uploadSessionsCreated >= 2, 'refez numa sessão nova (nova versão do mesmo arquivo)')
  assert.equal(env.mock.listAll().filter(it => it.name === name).length, 1, 'sem arquivo duplicado no Drive')
})

test('fechar o app no meio do fluxo: o recebimento e o envio continuam de onde pararam', async () => {
  const size = 40 * MiB
  const data = crypto.randomBytes(size)
  const name = 'fechou o app.mov'
  const meta = { name, size, folderId: folder.id }
  const { json } = await create(meta)
  await phoneSend(json.id, data, { to: 16 * MiB })
  await waitFor(() => transfersNamed(name)[0]?.bytesDone > 0, { timeoutMs: 10_000, message: 'não começou a subir' })
  await app.shutdown()
  // Fechar sincroniza o que já tinha chegado: o ponto guardado é o gravado.
  const saved = JSON.parse(await fs.readFile(path.join(env.home, 'mobile-uploads.json'), 'utf8')).uploads.find(u => u.id === json.id)
  assert.equal(saved.offset, 16 * MiB)
  app = await boot()
  const t = transfersNamed(name)[0]
  assert.ok(t?.local.growing, 'o envio em fluxo volta para a fila')
  const again = await create(meta)
  assert.equal(again.json.id, json.id)
  assert.equal(again.json.offset, 16 * MiB)
  await phoneSend(json.id, data, { from: again.json.offset })
  const { item } = await driveDone(json.id)
  assert.equal(item.md5, md5(data))
  assert.equal(transfersNamed(name).length, 1)
})

test('duas recepções com o mesmo nome para a mesma pasta: só a primeira sobe em fluxo, as duas chegam inteiras', async () => {
  const name = 'mesmo nome.mov'
  const a = crypto.randomBytes(40 * MiB)
  const b = crypto.randomBytes(40 * MiB + 1)
  const ra = await create({ name, size: a.length, folderId: folder.id })
  const rb = await create({ name, size: b.length, folderId: folder.id })
  assert.notEqual(ra.json.id, rb.json.id)
  await Promise.all([phoneSend(ra.json.id, a, { to: 8 * MiB }), phoneSend(rb.json.id, b, { to: 8 * MiB })])
  await delay(200)
  const streaming = transfersNamed(name)
  assert.equal(streaming.length, 1, 'só um envio em fluxo com esse nome')
  await Promise.all([phoneSend(ra.json.id, a, { from: 8 * MiB }), phoneSend(rb.json.id, b, { from: 8 * MiB })])
  const [da, db] = await Promise.all([driveDone(ra.json.id), driveDone(rb.json.id)])
  assert.equal(await env.mock.contentMd5(da.item.id), md5(a))
  assert.equal(await env.mock.contentMd5(db.item.id), md5(b))
  const names = (await fs.readdir(stage)).filter(n => n.startsWith('mesmo nome'))
  assert.deepEqual(names.sort(), ['mesmo nome (2).mov', 'mesmo nome.mov'])
})

test('mobile-uploads.json guarda o ponto sincronizado; o celular ouve o gravado', async () => {
  const size = 20 * MiB
  const data = crypto.randomBytes(size)
  const { json } = await create({ name: 'ponto guardado.mov', size, folderId: folder.id })
  const r = await putPaced(json.id, 0, data.subarray(0, 4 * MiB))
  assert.equal(r.json.offset, 4 * MiB, 'o celular continua do que foi gravado')
  await delay(700)
  const disk = JSON.parse(await fs.readFile(path.join(env.home, 'mobile-uploads.json'), 'utf8')).uploads.find(u => u.id === json.id)
  assert.equal(disk.offset, 0, 'sem fdatasync (menos de 64 MiB e não é o fim), o ponto guardado não avança')
  assert.equal(disk.synced, undefined)
  await phoneSend(json.id, data, { from: 4 * MiB })
  await driveDone(json.id)
})
