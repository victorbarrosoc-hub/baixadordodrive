// Proxy por envio e por arquivo (src/media/previa-fila.js + TransferManager.setProxy + rotas): migração do ajuste
// antigo, a escolha de cada envio, "Proxy: sim/não" na fila, "Gerar proxy" depois de enviado, e o "Baixar do Drive para
// gerar" (original que não está no computador: baixa num temporário, gera, sobe e apaga), com falta de espaço.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Settings, validateSettings } from '../src/config.js'
import { DriveClient } from '../src/google/drive.js'
import { TransferManager } from '../src/engine/manager.js'
import { Hasher } from '../src/engine/hasher.js'
import { planUploads } from '../src/engine/planner.js'
import { GeradorPrevias } from '../src/media/previa-fila.js'
import { gerarPreviasLote } from '../src/media/previa-lote.js'
import { startApp } from '../src/index.js'
import { closeHttp } from '../src/net/http.js'
import { makeTmpDir, setupDrive, waitFor, loginWithMock } from './helpers.js'
import { startMockDrive } from './mock-drive.js'

after(() => closeHttp())

const MOTOR = { via: 'ffmpeg', ffmpeg: { path: '/fake/ffmpeg', versao: '9.9', origem: 'app' }, encoder: { nome: 'h264_videotoolbox', hardware: true }, encoders: ['libx264'], label: 'Usando o chip de vídeo do Mac' }

async function tmp(t, prefix = 'sobedesce-previa-fila-') {
  const dir = await makeTmpDir(prefix)
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}

async function put(dir, rel, size, fill = 1) {
  const p = path.join(dir, ...rel.split('/'))
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, Buffer.alloc(size, fill))
  return p
}

/**
 * Conversor de mentira: grava uma "cópia" de `size` bytes num temporário de verdade (para conferir a limpeza).
 * `hold` (promessa) segura a conversão; `fail` (Error) faz falhar; `leve` devolve "já é leve".
 */
function fakeGerar(tmpRoot, opts = {}) {
  const calls = []
  const temps = []
  const gerar = async (file, { signal, onProgress, forcar }) => {
    const md5 = opts.md5 ? crypto.createHash('md5').update(await fs.readFile(file)).digest('hex') : null
    calls.push({ file, forcar, md5 })
    onProgress?.('analisando')
    if (opts.leve?.(file) && !forcar) return { estado: 'dispensada', motivo: 'já é leve' }
    onProgress?.('gerando', 0)
    if (opts.hold) {
      await new Promise((resolve, reject) => {
        opts.hold.then(resolve)
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('Interrompido.'), { name: 'AbortError' })), { once: true })
      })
    }
    if (opts.fail) throw opts.fail
    onProgress?.('gerando', 0.5)
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'sobedesce-previa-'))
    temps.push(dir)
    const p = path.join(dir, 'previa.mp4')
    await fs.writeFile(p, Buffer.alloc(opts.size ?? 4096, 9))
    return { estado: 'pronta', path: p, size: opts.size ?? 4096, encoder: 'h264_videotoolbox', motivo: 'ProRes 10 bits', limpar: () => fs.rm(dir, { recursive: true, force: true }) }
  }
  return { gerar, calls, temps }
}

/** Drive falso + TransferManager de verdade (envio real) com a fila da prévia ligada a um conversor de mentira. */
async function realSetup(t, gerarOpts = {}, settings = {}) {
  const env = await setupDrive()
  const dir = await tmp(t)
  const tmpRoot = await tmp(t, 'sobedesce-previa-tmp-')
  const fake = fakeGerar(tmpRoot, gerarOpts)
  const s = new Settings(env.paths.settings)
  await s.load()
  await s.update({ keepAwake: false, verifyChecksums: false, ...settings })
  const logs = []
  const previas = new GeradorPrevias({ settings: s, detect: async () => MOTOR, gerar: fake.gerar, tmpRoot, retryBaseMs: 5, selfCheck: false, log: m => logs.push(m) })
  const hasher = new Hasher({ cacheFile: env.paths.hashCache, workers: 1 })
  await hasher.init()
  const m = new TransferManager({
    settings: s,
    auth: env.auth,
    hasher,
    paths: env.paths,
    keepAwake: { active: false, setActive() {}, stop() {} },
    driveFactory: id => new DriveClient(env.auth, id, { ratePerSec: 1000, retryBaseMs: 5 }),
    taskOptions: { upload: { retryBaseMs: 5 } },
    thumbnailer: null,
    previas,
  })
  await m.init()
  t.after(async () => {
    await m.shutdown()
    await hasher.close()
    await env.cleanup()
  })
  const drive = m.driveFor(env.accountId)
  // `pausado`: entra já pausado na fila (pausar depois de adicionar corre com o envio de arquivos pequenos).
  const send = async (paths, destFolderId = 'root', { proxy, pausado = false } = {}) => {
    const plan = await planUploads({ drive, accountId: env.accountId, paths, destFolderId })
    if (typeof proxy === 'boolean') for (const r of plan.records) r.proxy = proxy
    if (pausado) for (const r of plan.records) r.status = 'paused'
    await m.add({ batch: plan.batch, records: plan.records })
    return plan.records.map(r => r.id)
  }
  return { env, mock: env.mock, m, s, drive, dir, tmpRoot, fake, previas, send, logs }
}

const children = (mock, parentId) => mock.listAll().filter(i => i.parents[0] === parentId && !i.trashed)
const childNamed = (mock, parentId, name) => children(mock, parentId).find(i => i.name === name)
const sleep = ms => new Promise(r => setTimeout(r, ms))

test('ajuste: o booleano antigo vira "Proxy ao enviar" (true → sempre, false → nunca); opção inválida é recusada', async t => {
  const dir = await tmp(t)
  const file = path.join(dir, 'settings.json')
  for (const [old, want] of [[true, 'sempre'], [false, 'nunca']]) {
    await fs.writeFile(file, JSON.stringify({ previaLeve: old, keepAwake: false }))
    const s = new Settings(file)
    await s.load()
    assert.equal(s.get().proxyAoEnviar, want)
    assert.equal(s.get().keepAwake, false, 'o resto continua')
    assert.equal('previaLeve' in s.get(), false)
    await s.update({ theme: 'dark' })
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(saved.proxyAoEnviar, want)
    assert.equal('previaLeve' in saved, false, 'o antigo sai do arquivo')
  }
  // Já migrado: o novo vale, mesmo com o antigo esquecido no arquivo.
  await fs.writeFile(file, JSON.stringify({ previaLeve: false, proxyAoEnviar: 'perguntar' }))
  const s = new Settings(file)
  await s.load()
  assert.equal(s.get().proxyAoEnviar, 'perguntar')
  // Sem nada salvo: sempre.
  await fs.writeFile(file, '{}')
  const s2 = new Settings(file)
  await s2.load()
  assert.equal(s2.get().proxyAoEnviar, 'sempre')
  assert.throws(() => validateSettings({ proxyAoEnviar: 'talvez' }), /Valor inválido/)
})

test('escolha do envio: sem proxy não gera nada; com proxy gera mesmo com o ajuste em "Nunca"; sem escolha vale o ajuste', async t => {
  const { mock, m, dir, fake, send, s } = await realSetup(t)
  const pasta = mock.addFolder('Escolha')
  const a = await put(dir, 'A001.mov', 50_000)
  const [ia] = await send([a], pasta.id, { proxy: false })
  await waitFor(() => m.get(ia)?.status === 'completed', { timeoutMs: 15_000 })
  await m.previas.idle()
  assert.equal(m.get(ia).proxy, false)
  assert.equal(m.get(ia).previa, undefined)
  assert.equal(fake.calls.length, 0)
  assert.equal(childNamed(mock, pasta.id, 'Proxy'), undefined)

  await s.update({ proxyAoEnviar: 'nunca' })
  const b = await put(dir, 'B001.mov', 50_000)
  const [ib] = await send([b], pasta.id, { proxy: true })
  await waitFor(() => m.get(ib)?.previa?.estado === 'pronta', { timeoutMs: 15_000 })
  assert.ok(childNamed(mock, childNamed(mock, pasta.id, 'Proxy').id, 'B001.mp4'))

  // Sem escolha (celular, Comparar): o ajuste. "Nunca" → nada; "Perguntar" (ninguém perguntou) → gera.
  const c = await put(dir, 'C001.mov', 50_000)
  const [ic] = await send([c], pasta.id)
  await waitFor(() => m.get(ic)?.status === 'completed', { timeoutMs: 15_000 })
  await m.previas.idle()
  assert.equal(m.get(ic).previa, undefined)
  await s.update({ proxyAoEnviar: 'perguntar' })
  const d = await put(dir, 'D001.mov', 50_000)
  const [idd] = await send([d], pasta.id)
  await waitFor(() => m.get(idd)?.previa?.estado === 'pronta', { timeoutMs: 15_000 })
})

test('por arquivo: "Proxy: não" na fila vale no fim; "Gerar proxy" depois de enviado gera (forçado); desligar no meio para e limpa', async t => {
  let release
  const hold = new Promise(r => (release = r))
  const { mock, m, dir, fake, send, tmpRoot } = await realSetup(t)
  const pasta = mock.addFolder('Por arquivo')
  const a = await put(dir, 'A002.mov', 60_000)
  const wav = await put(dir, 'Som.wav', 10_000)
  const [ia, iw] = await send([a, wav], pasta.id, { pausado: true })
  assert.equal(m.get(ia).status, 'paused')
  // Pausado na fila: muda a escolha. Áudio não conta.
  assert.equal(m.setProxy([ia, iw], false), 1)
  assert.equal(m.get(ia).proxy, false)
  assert.equal(m.get(iw).proxy, undefined)
  await m.resume('all')
  await waitFor(() => m.get(ia)?.status === 'completed', { timeoutMs: 15_000 })
  await m.previas.idle()
  assert.equal(m.get(ia).previa, undefined)
  assert.equal(fake.calls.length, 0)

  // Depois de concluído: "Gerar proxy" (forçado: gera mesmo se for leve).
  assert.equal(m.setProxy([ia], true), 1)
  await waitFor(() => m.get(ia)?.previa?.estado === 'pronta', { timeoutMs: 15_000 })
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].forcar, true)
  assert.equal(m.get(ia).proxy, true)
  // Pedir de novo com o proxy pronto não faz nada.
  m.setProxy([ia], true)
  await m.previas.idle()
  assert.equal(fake.calls.length, 1)

  // Desligar no meio da conversão: para, marca cancelada e não deixa temporário.
  const fake2 = fakeGerar(tmpRoot, { hold })
  m.previas.gerar = fake2.gerar
  const b = await put(dir, 'B002.mov', 60_000)
  const [ib] = await send([b], pasta.id)
  await waitFor(() => fake2.calls.length === 1, { timeoutMs: 15_000 })
  m.setProxy([ib], false)
  await waitFor(() => m.get(ib)?.previa?.estado === 'cancelada', { timeoutMs: 5000 })
  release()
  await m.previas.idle()
  assert.equal(m.get(ib).status, 'completed')
  assert.deepEqual(await fs.readdir(tmpRoot), [])
  assert.equal(children(mock, childNamed(mock, pasta.id, 'Proxy').id).filter(i => i.name === 'B002.mp4').length, 0)
  // E ligar de novo gera.
  m.previas.gerar = fake.gerar
  m.setProxy([ib], true)
  await waitFor(() => m.get(ib)?.previa?.estado === 'pronta', { timeoutMs: 15_000 })
})

test('"Baixar do Drive para gerar": baixa o original num temporário, gera dele, sobe o proxy e apaga o temporário', async t => {
  const env = await setupDrive()
  t.after(() => env.cleanup())
  const mock = env.mock
  const drive = new DriveClient(env.auth, env.accountId, { ratePerSec: 1000, retryBaseMs: 5 })
  const tmpRoot = await tmp(t, 'sobedesce-proxy-tmp-')
  const fake = fakeGerar(tmpRoot, { md5: true })
  const gerador = new GeradorPrevias({ detect: async () => MOTOR, gerar: fake.gerar, tmpRoot, retryBaseMs: 5, selfCheck: false, downloadOptions: { retryBaseMs: 5 } })
  const pasta = mock.addFolder('Celular')
  const orig = mock.addFile('VID_20261016.mov', pasta.id, { size: 3_500_000, seed: 41 })
  mock.addFile('Outro.mov', pasta.id, { size: 1000, seed: 42 })
  const fases = []
  const s = await gerarPreviasLote({ drive, gerador, driveFolderId: pasta.id, somente: [orig.id], forcar: true, baixar: true, recursive: false, onProgress: p => p.fase && fases.push(p.fase) })
  assert.equal(s.feitos, 1)
  assert.equal(s.baixados, 1)
  assert.equal(s.semLocal, 0)
  assert.equal(s.videos, 2)
  assert.equal(s.aGerar, 1, 'só o pedido')
  assert.equal(fake.calls.length, 1)
  assert.ok(path.basename(path.dirname(fake.calls[0].file)).startsWith('sobedesce-original-'), fake.calls[0].file)
  assert.equal(path.basename(fake.calls[0].file), 'VID_20261016.mov')
  assert.equal(fake.calls[0].md5, await mock.contentMd5(orig.id), 'gerou do original de verdade')
  assert.ok(fases.includes('baixando') && fases.includes('enviando'))
  const prx = childNamed(mock, childNamed(mock, pasta.id, 'Proxy').id, 'VID_20261016.mp4')
  assert.deepEqual(prx.appProperties, { sobedesce: 'previa', original: orig.id })
  assert.deepEqual(await fs.readdir(tmpRoot), [], 'original baixado e cópia apagados')

  // Sem `baixar`: o que não está no computador vira "sem arquivo", com o tamanho e os ids para baixar depois.
  const local = await tmp(t)
  const sem = await gerarPreviasLote({ drive, gerador, driveFolderId: pasta.id, localDir: local, recursive: false, refazer: false })
  assert.equal(sem.semLocal, 1)
  assert.equal(sem.semLocalBytes, 1000)
  assert.deepEqual(sem.semLocalIds, [children(mock, pasta.id).find(i => i.name === 'Outro.mov').id])
})

test('"Baixar do Drive para gerar" sem espaço livre: nem começa a baixar, explica e o lote segue; cancelar no meio apaga o parcial', async t => {
  const env = await setupDrive()
  t.after(() => env.cleanup())
  const mock = env.mock
  const drive = new DriveClient(env.auth, env.accountId, { ratePerSec: 1000, retryBaseMs: 5 })
  const tmpRoot = await tmp(t, 'sobedesce-proxy-tmp-')
  const fake = fakeGerar(tmpRoot)
  const pasta = mock.addFolder('Cheio')
  const grande = mock.addFile('Grande.mov', pasta.id, { size: 2_000_000, seed: 51 })
  const cheio = new GeradorPrevias({ detect: async () => MOTOR, gerar: fake.gerar, tmpRoot, selfCheck: false, espaco: async () => 500_000_000 })
  mock.resetStats()
  const s = await gerarPreviasLote({ drive, gerador: cheio, driveFolderId: pasta.id, somente: [grande.id], forcar: true, baixar: true, recursive: false })
  assert.equal(s.feitos, 0)
  assert.equal(s.falhou, 1)
  assert.match(s.falhas[0].reason, /sem espaço para baixar o original \(precisa de .* livre 0,5 GB\)/)
  assert.equal(fake.calls.length, 0)
  assert.equal(mock.stats().mediaGets, 0)
  assert.deepEqual(await fs.readdir(tmpRoot), [])

  // Cancelar no meio do download: o temporário some.
  mock.setOptions({ perConnectionBps: 200_000 })
  const lento = new GeradorPrevias({ detect: async () => MOTOR, gerar: fake.gerar, tmpRoot, selfCheck: false, downloadOptions: { retryBaseMs: 5 } })
  const ac = new AbortController()
  const p = gerarPreviasLote({ drive, gerador: lento, driveFolderId: pasta.id, somente: [grande.id], forcar: true, baixar: true, recursive: false, signal: ac.signal, onProgress: x => x.fase === 'baixando' && x.frac > 0 && ac.abort() })
  await assert.rejects(p, e => e.name === 'AbortError')
  await sleep(100)
  assert.deepEqual(await fs.readdir(tmpRoot), [])
  assert.equal(fake.calls.length, 0)
})

test('original conhecido pela fila (dica): gera sem pasta do computador; tamanho diferente não serve', async t => {
  const env = await setupDrive()
  t.after(() => env.cleanup())
  const mock = env.mock
  const drive = new DriveClient(env.auth, env.accountId, { ratePerSec: 1000, retryBaseMs: 5 })
  const tmpRoot = await tmp(t, 'sobedesce-proxy-tmp-')
  const fake = fakeGerar(tmpRoot)
  const gerador = new GeradorPrevias({ detect: async () => MOTOR, gerar: fake.gerar, tmpRoot, selfCheck: false })
  const dir = await tmp(t)
  const pasta = mock.addFolder('Dica')
  const it = mock.addFile('E001.mov', pasta.id, { size: 7000, seed: 61 })
  const p = await put(dir, 'E001.mov', 7000)
  const s = await gerarPreviasLote({ drive, gerador, driveFolderId: pasta.id, somente: [it.id], forcar: true, dicas: new Map([[it.id, p]]), recursive: false })
  assert.equal(s.feitos, 1)
  assert.equal(fake.calls[0].file, p)
  await fs.writeFile(p, Buffer.alloc(10))
  const s2 = await gerarPreviasLote({ drive, gerador, driveFolderId: pasta.id, somente: [it.id], forcar: true, refazer: true, dicas: new Map([[it.id, p]]), recursive: false })
  assert.equal(s2.semLocal, 1, 'arquivo mudou: não é mais o original')
})

// ── rotas ──

let home
let files
let rmock
let app
let acc
const rcalls = []

function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${app.port}`, 'content-type': 'application/json' }
    const data = body === undefined ? null : JSON.stringify(body)
    if (data) h['content-length'] = Buffer.byteLength(data)
    const req = http.request({ host: '127.0.0.1', port: app.port, method, path: p, headers: h, agent: false }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        let json = null
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {}
        resolve({ status: res.statusCode, json })
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

before(async () => {
  home = await makeTmpDir()
  files = await makeTmpDir('sobedesce-proxy-files-')
  rmock = await startMockDrive()
  rmock.applyEnv()
  const tmpRoot = await makeTmpDir('sobedesce-proxy-rt-')
  const base = fakeGerar(tmpRoot)
  const previas = new GeradorPrevias({ detect: async () => MOTOR, gerar: async (f, o) => (rcalls.push(f), base.gerar(f, o)), tmpRoot, selfCheck: false })
  app = await startApp({ home, port: 0, open: false, quiet: true, managerOptions: { keepAwake: { active: false, setActive() {}, stop() {} }, thumbnailer: null, previas }, serverOptions: { log: () => {}, spawn: () => new EventEmitter() } })
  await app.auth.setClientCredentials(rmock.client)
  acc = (await loginWithMock(app.auth)).id
  await app.settings.update({ verifyChecksums: false })
})

after(async () => {
  await app?.shutdown()
  await rmock?.close()
  for (const d of [home, files]) if (d) await fs.rm(d, { recursive: true, force: true, maxRetries: 3 })
})

test('rotas: envio com "proxy", proxy por arquivo, o arquivo no Drive (original achado pela fila) e espaço livre', async () => {
  rmock.applyEnv()
  const pasta = rmock.addFolder('Rotas proxy')
  const v = await put(files, 'R001.mov', 40_000)
  assert.equal((await call('POST', '/api/transfers/upload', { accountId: acc, paths: [v], destFolderId: pasta.id, proxy: 'sim' })).status, 400)
  const up = await call('POST', '/api/transfers/upload', { accountId: acc, paths: [v], destFolderId: pasta.id, proxy: false })
  assert.equal(up.status, 200, up.json?.error)
  const rec = [...app.manager.records.values()].find(r => r.local?.path === v)
  assert.equal(rec.proxy, false)
  await waitFor(() => app.manager.get(rec.id).status === 'completed', { timeoutMs: 15_000 })
  await app.manager.previas.idle()
  assert.equal(rcalls.length, 0)

  for (const body of [{ ids: [rec.id] }, { ids: [], proxy: true }, { ids: 'x', proxy: true }, { ids: [rec.id], proxy: 'sim' }]) {
    assert.equal((await call('POST', '/api/transfers/proxy', body)).status, 400, JSON.stringify(body))
  }
  // O arquivo no Drive: o original está neste computador (a fila sabe), sem proxy ainda.
  const info = await call('GET', `/api/previas/arquivo?accountId=${encodeURIComponent(acc)}&id=${rec.target.fileId}`)
  assert.equal(info.status, 200, info.json?.error)
  assert.equal(info.json.local, v)
  assert.equal(info.json.proxy, null)
  assert.equal(info.json.arquivo.parentId, pasta.id)
  assert.ok(info.json.livre > 0)
  assert.ok((await call('GET', '/api/previas/espaco')).json.livre > 0)
  assert.equal((await call('GET', `/api/previas/arquivo?accountId=${encodeURIComponent(acc)}&id=${pasta.id}`)).status, 400)

  // "Gerar proxy" na linha da transferência.
  const r = await call('POST', '/api/transfers/proxy', { ids: [rec.id], proxy: true })
  assert.equal(r.json.count, 1)
  await waitFor(() => app.manager.get(rec.id).previa?.estado === 'pronta', { timeoutMs: 15_000 })
  const info2 = await call('GET', `/api/previas/arquivo?accountId=${encodeURIComponent(acc)}&id=${rec.target.fileId}`)
  assert.equal(info2.json.proxy.nosso, true)

  // Lote de um arquivo só, sem pasta do computador: o original vem da fila.
  const lote = await call('POST', '/api/previas/lote', { accountId: acc, driveFolderId: pasta.id, somente: [rec.target.fileId], forcar: true, refazer: true, recursive: false })
  assert.equal(lote.status, 200, lote.json?.error)
  await waitFor(async () => (await call('GET', `/api/previas/lote/${lote.json.jobId}`)).json.status === 'done', { timeoutMs: 10_000 })
  assert.equal((await call('GET', `/api/previas/lote/${lote.json.jobId}`)).json.progress.feitos, 1)
  // Validação do lote: sem pasta e sem "somente"/"baixar" → 400; "somente" inválido → 400.
  assert.equal((await call('POST', '/api/previas/lote', { accountId: acc, driveFolderId: pasta.id })).status, 400)
  assert.equal((await call('POST', '/api/previas/lote', { accountId: acc, driveFolderId: pasta.id, somente: ['../x'] })).status, 400)
  assert.equal((await call('POST', '/api/previas/lote', { accountId: acc, driveFolderId: pasta.id, baixar: 'sim' })).status, 400)
})

test('Referências não ganham proxy: nem no fim do envio, nem pelo "Gerar proxy"', async t => {
  const { mock, m, dir, fake, previas } = await realSetup(t)
  const pasta = mock.addFolder('Refs')
  const v = await put(dir, 'reels.mp4', 80_000)
  const st = await fs.stat(v)
  const rec = { id: 'tref1', type: 'upload', accountId: null, status: 'queued', name: 'reels.mp4', relPath: 'reels.mp4', size: st.size, bytesDone: 0, local: { path: v, size: st.size, mtimeMs: st.mtimeMs }, target: { rootId: pasta.id, relDir: '', parentId: pasta.id, driveId: null, replaceFileId: null, fileId: null }, session: null, referencia: { jobId: 'r1', colecao: 'Moodboard' } }
  rec.accountId = (await m.auth.listAccounts())[0].id
  await m.add({ batch: { id: 'bref', type: 'upload', label: 'Referência', createdAt: Date.now(), accountId: rec.accountId }, records: [rec] })
  await waitFor(() => m.get('tref1')?.status === 'completed', { timeoutMs: 15_000 })
  await previas.idle()
  assert.equal(m.get('tref1').previa, undefined)
  assert.equal(m.setProxy(['tref1'], true), 0)
  await previas.idle()
  assert.equal(fake.calls.length, 0)
})
