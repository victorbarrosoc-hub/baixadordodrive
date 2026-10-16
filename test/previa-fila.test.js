// Prévia leve, parte do motor: a fila depois do envio (src/media/previa-fila.js no TransferManager), o lote "Gerar
// prévias" para o que já está no Drive (src/media/previa-lote.js) e as rotas (/api/previas*), contra o Drive falso.
// O conversor é de mentira (escreve uma "cópia" pequena): o que importa aqui é onde ela vai parar, com que marca,
// quando é pulada, e que nada disso muda o status do envio.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Settings } from '../src/config.js'
import { DriveClient } from '../src/google/drive.js'
import { TransferManager } from '../src/engine/manager.js'
import { Hasher } from '../src/engine/hasher.js'
import { planUploads } from '../src/engine/planner.js'
import { GeradorPrevias, procurarProxy } from '../src/media/previa-fila.js'
import { gerarPreviasLote, listDriveVideos, resumoPrevias } from '../src/media/previa-lote.js'
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
    calls.push({ file, forcar })
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
  const send = async (paths, destFolderId = 'root') => {
    const plan = await planUploads({ drive, accountId: env.accountId, paths, destFolderId })
    await m.add({ batch: plan.batch, records: plan.records })
    return plan.records.map(r => r.id)
  }
  return { env, mock: env.mock, m, s, drive, dir, tmpRoot, fake, previas, send, logs }
}

const children = (mock, parentId) => mock.listAll().filter(i => i.parents[0] === parentId && !i.trashed)
const childNamed = (mock, parentId, name) => children(mock, parentId).find(i => i.name === name)

test('depois do envio de um vídeo: cópia leve em Proxy/<nome>.mp4 com a marca, sem mexer no envio; áudio não ganha', async t => {
  const { mock, m, dir, fake, send, tmpRoot } = await realSetup(t)
  const pasta = mock.addFolder('Diária 1')
  const video = await put(dir, 'A001_C002.MOV', 300_000)
  const audio = await put(dir, 'Som.wav', 50_000)
  const [idV, idA] = await send([video, audio], pasta.id)
  await waitFor(() => m.get(idV)?.previa?.estado === 'pronta', { timeoutMs: 15_000, message: 'a prévia não ficou pronta' })
  const rec = m.get(idV)
  assert.equal(rec.status, 'completed')
  assert.equal(m.get(idA).status, 'completed')
  assert.equal(m.get(idA).previa, undefined, 'áudio não tem prévia')
  const proxyDir = childNamed(mock, pasta.id, 'Proxy')
  assert.ok(proxyDir?.isFolder, 'criou a pasta Proxy ao lado do original')
  const copia = childNamed(mock, proxyDir.id, 'A001_C002.mp4')
  assert.ok(copia, 'Proxy/A001_C002.mp4')
  assert.equal(copia.size, 4096)
  assert.deepEqual(copia.appProperties, { sobedesce: 'previa', original: rec.target.fileId })
  assert.equal(rec.previa.fileId, copia.id)
  assert.equal(rec.previa.encoder, 'h264_videotoolbox')
  // O original continua igual (nome, tamanho, sem marca).
  const orig = mock.getItem(rec.target.fileId)
  assert.equal(orig.name, 'A001_C002.MOV')
  assert.equal(orig.size, 300_000)
  assert.equal(orig.appProperties, null)
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].file, video)
  // Temporário apagado.
  assert.deepEqual(await fs.readdir(tmpRoot), [])

  // Segundo vídeo na mesma pasta: reaproveita a pasta Proxy (não cria outra).
  const v2 = await put(dir, 'A001_C003.mov', 200_000)
  const [id2] = await send([v2], pasta.id)
  await waitFor(() => m.get(id2)?.previa?.estado === 'pronta', { timeoutMs: 15_000 })
  assert.equal(children(mock, pasta.id).filter(i => i.name === 'Proxy').length, 1)
  assert.ok(childNamed(mock, proxyDir.id, 'A001_C003.mp4'))
})

test('já tem proxy (da câmera ou de antes): pula sem converter; "já estava no Drive" também ganha a que falta', async t => {
  const { mock, m, dir, fake, send } = await realSetup(t)
  const pasta = mock.addFolder('Câmera B')
  const proxies = mock.addFolder('Proxies', pasta.id)
  mock.addFile('B001.mp4', proxies.id, { size: 1000, seed: 1 })
  const b = await put(dir, 'B001.mov', 100_000)
  const [idB] = await send([b], pasta.id)
  await waitFor(() => m.get(idB)?.previa?.estado === 'dispensada', { timeoutMs: 15_000 })
  assert.match(m.get(idB).previa.motivo, /proxy da câmera/)
  assert.equal(fake.calls.length, 0)
  assert.equal(childNamed(mock, pasta.id, 'Proxy'), undefined, 'não criou pasta nova')

  // Original já no Drive (mesmo conteúdo): o envio é pulado, mas a prévia que falta é gerada.
  const c = await put(dir, 'C001.mov', 120_000, 5)
  const [first] = await send([c], pasta.id)
  await waitFor(() => m.get(first)?.previa?.estado === 'pronta', { timeoutMs: 15_000 })
  // Já existe a subpasta "Proxies": a cópia vai para ela (não cria "Proxy").
  const copia = childNamed(mock, proxies.id, 'C001.mp4')
  assert.ok(copia)
  assert.equal(childNamed(mock, pasta.id, 'Proxy'), undefined)
  mock.deleteItem(copia.id)
  const [again] = await send([c], pasta.id)
  await waitFor(() => ['skipped', 'completed', 'failed'].includes(m.get(again)?.status), { timeoutMs: 15_000 })
  assert.equal(m.get(again).status, 'skipped')
  await waitFor(() => m.get(again)?.previa?.estado === 'pronta', { timeoutMs: 15_000 })
  // Agora existe: um terceiro envio não converte de novo.
  const n = fake.calls.length
  const [third] = await send([c], pasta.id)
  await waitFor(() => m.get(third)?.previa?.estado === 'dispensada', { timeoutMs: 15_000 })
  assert.equal(m.get(third).previa.motivo, 'já tinha prévia leve')
  assert.equal(fake.calls.length, n)
})

test('falha da prévia não falha o envio; ajuste desligado não gera nada', async t => {
  const { mock, m, dir, send, s, fake, logs } = await realSetup(t, { fail: new Error('o ffmpeg não abriu este arquivo') })
  const pasta = mock.addFolder('Falhas')
  const v = await put(dir, 'quebrado.mov', 80_000)
  const [id] = await send([v], pasta.id)
  await waitFor(() => m.get(id)?.previa?.estado === 'falhou', { timeoutMs: 15_000 })
  assert.equal(m.get(id).status, 'completed')
  assert.equal(m.get(id).error, null)
  assert.match(m.get(id).previa.motivo, /não abriu/)
  assert.ok(logs.some(l => /ficou sem cópia leve/.test(l)))
  assert.equal(childNamed(mock, pasta.id, 'Proxy'), undefined)

  await s.update({ proxyAoEnviar: 'nunca' })
  const n = fake.calls.length
  const v2 = await put(dir, 'outro.mov', 80_000)
  const [id2] = await send([v2], pasta.id)
  await waitFor(() => m.get(id2)?.status === 'completed', { timeoutMs: 15_000 })
  await m.previas.idle()
  assert.equal(m.get(id2).previa, undefined)
  assert.equal(fake.calls.length, n)
})

test('pausar tudo pausa a prévia (recomeça depois); pular cancela; fechar o app no meio e reabrir continua', async t => {
  let release
  const hold = new Promise(r => (release = r))
  const { env, mock, m, dir, send, fake, tmpRoot, s } = await realSetup(t, { hold })
  const pasta = mock.addFolder('Pausa')
  const a = await put(dir, 'P1.mov', 60_000)
  const b = await put(dir, 'P2.mov', 60_000)
  const ids = await send([a, b], pasta.id)
  await waitFor(() => ids.every(id => m.get(id)?.status === 'completed'), { timeoutMs: 15_000 })
  await waitFor(() => fake.calls.length === 1 && ids.some(id => m.get(id).previa?.estado === 'gerando'), { timeoutMs: 5000 })
  // Quem terminou de subir primeiro está convertendo; o outro espera na fila.
  const ia = ids.find(id => m.get(id).previa.estado === 'gerando')
  const ib = ids.find(id => id !== ia)
  assert.equal(m.get(ib).previa.estado, 'fila')

  await m.pause('all')
  await waitFor(() => m.get(ia).previa.estado === 'pausada' && m.get(ib).previa.estado === 'pausada', { timeoutMs: 5000 })
  assert.equal(m.get(ia).status, 'completed', 'o envio continua concluído')
  release()
  await new Promise(r => setTimeout(r, 50))
  assert.equal(fake.calls.length, 1, 'pausado não começa outra')

  // Pular a segunda; retomar faz só a primeira (de novo, do começo).
  assert.equal(m.previas.cancel([ib]), 1)
  assert.equal(m.get(ib).previa.estado, 'cancelada')
  await m.resume('all')
  await waitFor(() => m.get(ia).previa.estado === 'pronta', { timeoutMs: 15_000 })
  assert.equal(m.get(ib).previa.estado, 'cancelada')
  assert.equal(fake.calls.length, 2)
  assert.deepEqual(await fs.readdir(tmpRoot), [])

  // Fechar com uma na fila e reabrir: volta para a fila e termina.
  const c = await put(dir, 'P3.mov', 60_000)
  let release2
  const fake2 = fakeGerar(tmpRoot, { hold: new Promise(r => (release2 = r)) })
  m.previas.gerar = fake2.gerar
  const [ic] = await send([c], pasta.id)
  await waitFor(() => fake2.calls.length === 1, { timeoutMs: 15_000 })
  await m.shutdown()
  const saved = JSON.parse(await fs.readFile(env.paths.queue, 'utf8')).transfers.find(r => r.id === ic)
  assert.equal(saved.previa.estado, 'fila')
  release2()
  const fake3 = fakeGerar(tmpRoot)
  const previas = new GeradorPrevias({ settings: s, detect: async () => MOTOR, gerar: fake3.gerar, tmpRoot, retryBaseMs: 5, selfCheck: false })
  const m2 = new TransferManager({ settings: s, auth: env.auth, paths: env.paths, keepAwake: { active: false, setActive() {}, stop() {} }, driveFactory: id => new DriveClient(env.auth, id, { ratePerSec: 1000, retryBaseMs: 5 }), thumbnailer: null, previas })
  await m2.init()
  t.after(() => m2.shutdown())
  await waitFor(() => m2.get(ic)?.previa?.estado === 'pronta', { timeoutMs: 15_000 })
  assert.equal(fake3.calls.length, 1)
  assert.ok(childNamed(mock, childNamed(mock, pasta.id, 'Proxy').id, 'P3.mp4'))
})

test('procurarProxy: mesma pasta, Proxy e Proxies; o próprio original não conta; prefere a subpasta e .mp4', async t => {
  const env = await setupDrive()
  t.after(() => env.cleanup())
  const drive = new DriveClient(env.auth, env.accountId, { ratePerSec: 1000, retryBaseMs: 5 })
  const mock = env.mock
  const p = mock.addFolder('Rodagem')
  const orig = mock.addFile('A001.mov', p.id, { size: 10, seed: 1 })
  assert.equal((await procurarProxy(drive, { parentId: p.id, name: 'A001.mov', excludeId: orig.id })).proxy, null)
  mock.addFile('A001.mov', p.id, { size: 11, seed: 2 }) // outro com o mesmo nome: não é proxy
  mock.addFile('A0011.mp4', p.id, { size: 11, seed: 2 })
  assert.equal((await procurarProxy(drive, { parentId: p.id, name: 'A001.mov', excludeId: orig.id })).proxy, null)
  mock.addFile('a001.MOV.mp4', p.id, { size: 1, seed: 3 }) // nome-base diferente
  const mesma = mock.addFile('A001.mp4', p.id, { size: 1, seed: 3 })
  assert.equal((await procurarProxy(drive, { parentId: p.id, name: 'A001.mov', excludeId: orig.id })).proxy.id, mesma.id)
  const dir = mock.addFolder('Proxy', p.id)
  const sub = mock.addFile('A001.mov', dir.id, { size: 1, seed: 4 })
  const found = await procurarProxy(drive, { parentId: p.id, name: 'A001.mov', excludeId: orig.id })
  assert.equal(found.proxy.id, sub.id, 'subpasta Proxy antes da mesma pasta')
  assert.deepEqual(found.pastas, [{ id: dir.id, name: 'Proxy' }])
})

test('lote: acha os originais por nome + tamanho, gera só o que falta, pula proxy de câmera e leves; refazer troca só as nossas', async t => {
  const env = await setupDrive()
  t.after(() => env.cleanup())
  const mock = env.mock
  const drive = new DriveClient(env.auth, env.accountId, { ratePerSec: 1000, retryBaseMs: 5 })
  const local = await tmp(t)
  const tmpRoot = await tmp(t, 'sobedesce-previa-tmp-')
  const fake = fakeGerar(tmpRoot, { leve: f => f.endsWith('leve.mov') })
  const gerador = new GeradorPrevias({ detect: async () => MOTOR, gerar: fake.gerar, tmpRoot, retryBaseMs: 5, selfCheck: false })

  const dia = mock.addFolder('Diária 2')
  const camB = mock.addFolder('Cam B', dia.id)
  const a = mock.addFile('A001.mov', dia.id, { size: 1000, seed: 1 })
  const b = mock.addFile('B001.MXF', camB.id, { size: 2000, seed: 2 })
  mock.addFile('C001.mov', dia.id, { size: 3000, seed: 3 }) // tamanho diferente no computador
  mock.addFile('D001.mov', dia.id, { size: 4000, seed: 4 }) // não está no computador
  const e = mock.addFile('E001.mov', dia.id, { size: 5000, seed: 5 })
  const eProxy = mock.addFolder('Proxy', dia.id)
  mock.addFile('E001.mp4', eProxy.id, { size: 10, seed: 6 }) // proxy da câmera
  mock.addFile('pequeno.mp4', dia.id, { size: 1000, seed: 7, videoMediaMetadata: { width: 1920, height: 1080, durationMillis: 5000 } })
  mock.addFile('leve.mov', dia.id, { size: 1100, seed: 8 })
  mock.addFile('foto.jpg', dia.id, { size: 100, seed: 9 })
  mock.addFile('X.braw', dia.id, { size: 100, seed: 9 })
  await put(local, 'cartao/A001.mov', 1000)
  await put(local, 'cartao/b001.mxf', 2000)
  await put(local, 'cartao/C001.mov', 2999)
  await put(local, 'cartao/E001.mov', 5000)
  await put(local, 'cartao/leve.mov', 1100)

  const phases = []
  const s = await gerarPreviasLote({ drive, gerador, driveFolderId: dia.id, localDir: local, onProgress: p => phases.push(p.phase) })
  assert.equal(s.videos, 7, 'A, B, C, D, E, pequeno e leve (o .mp4 da pasta Proxy não conta)')
  assert.equal(s.jaTinham, 1)
  assert.equal(s.jaLeves, 2, 'pequeno.mp4 pelo Drive e leve.mov pelo conversor')
  assert.equal(s.feitos, 2)
  assert.equal(s.semLocal, 1)
  assert.equal(s.tamanhoDiferente, 1)
  assert.equal(s.falhou, 0)
  assert.deepEqual(s.semLocalNomes, ['D001.mov'])
  for (const ph of ['drive', 'local', 'gerar', 'fim']) assert.ok(phases.includes(ph), ph)
  assert.equal(resumoPrevias(s), '2 prévias geradas · 1 sem arquivo no computador · 1 com tamanho diferente')
  const pa = childNamed(mock, eProxy.id, 'A001.mp4')
  assert.deepEqual(pa.appProperties, { sobedesce: 'previa', original: a.id })
  const pb = childNamed(mock, childNamed(mock, camB.id, 'Proxy').id, 'B001.mp4')
  assert.deepEqual(pb.appProperties, { sobedesce: 'previa', original: b.id })
  assert.deepEqual(new Set(s.feitosIds), new Set([pa.id, pb.id]))
  assert.equal(childNamed(mock, eProxy.id, 'E001.mp4').size, 10, 'proxy da câmera intocado')
  assert.equal(mock.getItem(e.id).appProperties, null)

  // De novo: nada a fazer além do que não tem par.
  const n = fake.calls.length
  const again = await gerarPreviasLote({ drive, gerador, driveFolderId: dia.id, localDir: local })
  assert.equal(again.jaTinham, 3)
  assert.equal(again.feitos, 0)
  assert.equal(fake.calls.length, n + 1, 'só o leve.mov olha de novo')

  // Refazer: troca o conteúdo das NOSSAS cópias (nova versão do mesmo arquivo); o proxy da câmera fica.
  const refeito = await gerarPreviasLote({ drive, gerador, driveFolderId: dia.id, localDir: local, refazer: true, recursive: false })
  assert.equal(refeito.feitos, 1, 'A001 (a nossa)')
  assert.equal(refeito.jaTinham, 1, 'E001 com proxy da câmera')
  assert.equal(refeito.jaLeves, 2, 'leve continua leve')
  assert.equal(refeito.semLocal, 1, 'só o D001 (o B001 está numa subpasta)')
  const versoes = children(mock, eProxy.id).filter(i => i.name === 'A001.mp4')
  assert.equal(versoes.length, 1, 'substituiu, não duplicou')
  assert.equal(versoes[0].id, pa.id)
  assert.deepEqual(versoes[0].appProperties, { sobedesce: 'previa', original: a.id })
  assert.ok(fake.calls.some(c => c.forcar), 'refazer força a conversão')
})

test('lote: sem conversor é recusado antes de começar; cancelar no meio para e limpa', async t => {
  const env = await setupDrive()
  t.after(() => env.cleanup())
  const drive = new DriveClient(env.auth, env.accountId, { ratePerSec: 1000, retryBaseMs: 5 })
  const local = await tmp(t)
  const tmpRoot = await tmp(t, 'sobedesce-previa-tmp-')
  const pasta = env.mock.addFolder('Lote')
  env.mock.addFile('Z1.mov', pasta.id, { size: 500, seed: 1 })
  env.mock.addFile('Z2.mov', pasta.id, { size: 600, seed: 2 })
  await put(local, 'Z1.mov', 500)
  await put(local, 'Z2.mov', 600)
  const semMotor = new GeradorPrevias({ detect: async () => ({ via: null, aviso: 'Não encontramos o ffmpeg neste computador.' }), selfCheck: false })
  await assert.rejects(gerarPreviasLote({ drive, gerador: semMotor, driveFolderId: pasta.id, localDir: local }), e => e.status === 409 && /ffmpeg/.test(e.message))

  const fake = fakeGerar(tmpRoot, { hold: new Promise(() => {}) })
  const gerador = new GeradorPrevias({ detect: async () => MOTOR, gerar: fake.gerar, tmpRoot, selfCheck: false })
  const ac = new AbortController()
  const p = gerarPreviasLote({ drive, gerador, driveFolderId: pasta.id, localDir: local, signal: ac.signal })
  await waitFor(() => fake.calls.length === 1, { timeoutMs: 5000 })
  ac.abort()
  await assert.rejects(p, e => e.name === 'AbortError')
  assert.equal(fake.calls.length, 1)
  assert.equal(env.mock.listAll().filter(i => i.name === 'Proxy').length, 0)
  assert.deepEqual(await fs.readdir(tmpRoot), [])
})

test('listDriveVideos: sem subpastas ainda olha dentro de Proxy; cópias marcadas não viram candidatas', async t => {
  const env = await setupDrive()
  t.after(() => env.cleanup())
  const drive = new DriveClient(env.auth, env.accountId, { ratePerSec: 1000, retryBaseMs: 5 })
  const m = env.mock
  const p = m.addFolder('Raiz')
  const a = m.addFile('A.mov', p.id, { size: 10, seed: 1 })
  const prx = m.addFolder('Proxy', p.id)
  const pa = m.addFile('A.mp4', prx.id, { size: 1, seed: 2, appProperties: { sobedesce: 'previa', original: a.id } })
  m.addFile('solta.mp4', p.id, { size: 1, seed: 3, appProperties: { sobedesce: 'previa' } })
  const sub = m.addFolder('Sub', p.id)
  m.addFile('S.mov', sub.id, { size: 10, seed: 4 })
  const flat = await listDriveVideos(drive, p.id, { recursive: false })
  assert.deepEqual(flat.videos.map(v => v.name), ['A.mov'])
  assert.equal(flat.proxyOf(flat.videos[0]).id, pa.id)
  assert.equal(flat.proxyOf(flat.videos[0]).appProperties.sobedesce, 'previa')
  const deep = await listDriveVideos(drive, p.id, { recursive: true })
  assert.deepEqual(deep.videos.map(v => v.name).sort(), ['A.mov', 'S.mov'])
  await assert.rejects(listDriveVideos(drive, a.id), e => e.status === 400)
  await assert.rejects(listDriveVideos(drive, 'naoexiste123'), e => e.status === 404)
})

// ── rotas ──

let home
let files
let mock
let app
let acc
let holdRelease = null
let routeCalls = 0

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
  files = await makeTmpDir('sobedesce-previa-files-')
  mock = await startMockDrive()
  mock.applyEnv()
  const tmpRoot = await makeTmpDir('sobedesce-previa-rt-')
  const base = fakeGerar(tmpRoot)
  const previas = new GeradorPrevias({
    detect: async () => MOTOR,
    gerar: async (file, opts) => {
      routeCalls++
      if (holdRelease) await holdRelease.promise
      return base.gerar(file, opts)
    },
    tmpRoot,
    selfCheck: false,
  })
  app = await startApp({ home, port: 0, open: false, quiet: true, managerOptions: { keepAwake: { active: false, setActive() {}, stop() {} }, thumbnailer: null, previas }, serverOptions: { log: () => {}, spawn: () => new EventEmitter() } })
  await app.auth.setClientCredentials(mock.client)
  acc = (await loginWithMock(app.auth)).id
})

after(async () => {
  await app?.shutdown()
  await mock?.close()
  for (const d of [home, files]) if (d) await fs.rm(d, { recursive: true, force: true, maxRetries: 3 })
})

test('rota: estado do conversor e pedidos inválidos recusados antes de começar', async () => {
  mock.applyEnv()
  const st = await call('GET', '/api/previas')
  assert.equal(st.status, 200)
  assert.equal(st.json.previas.enabled, true)
  assert.equal(st.json.previas.motor.label, 'Usando o chip de vídeo do Mac')
  assert.equal(st.json.previas.motor.hardware, true)
  const folder = mock.addFolder('Validação')
  const okBody = { accountId: acc, driveFolderId: folder.id, localDir: files }
  const cases = [
    [{ ...okBody, accountId: 'quem?' }, 404],
    [{ ...okBody, driveFolderId: '' }, 400],
    [{ ...okBody, driveFolderId: "x' or name contains '" }, 400],
    [{ ...okBody, localDir: '' }, 400],
    [{ ...okBody, localDir: `${files}\u0000/x` }, 400],
    [{ ...okBody, localDir: path.join(files, 'nao-existe') }, 400],
    [{ ...okBody, localDir: 'relativo/pasta' }, 400],
    [{ ...okBody, recursive: 'sim' }, 400],
    [{ ...okBody, refazer: 1 }, 400],
  ]
  await fs.writeFile(path.join(files, 'arquivo.txt'), 'x')
  cases.push([{ ...okBody, localDir: path.join(files, 'arquivo.txt') }, 400])
  for (const [body, status] of cases) {
    const r = await call('POST', '/api/previas/lote', body)
    assert.equal(r.status, status, JSON.stringify(body))
    assert.equal(r.json.ok, false)
    assert.ok(r.json.error)
  }
  assert.equal((await call('GET', '/api/previas/lote/prvnaoexiste')).status, 404)
  assert.equal((await call('DELETE', '/api/previas/lote/prvnaoexiste')).status, 404)
  assert.equal((await call('POST', '/api/previas/pular', { ids: 'x' })).status, 400)
  assert.equal((await call('POST', '/api/previas/pular', { ids: ['naoexiste'] })).json.count, 0)
  assert.equal(routeCalls, 0)
})

test('rota: lote de ponta a ponta, um por vez, pasta lembrada nos ajustes e estado em /api/state', async () => {
  mock.applyEnv()
  const folder = mock.addFolder('Rodagem')
  const a = mock.addFile('A001.mov', folder.id, { size: 300, seed: 1 })
  await put(files, 'cartao/A001.mov', 300)
  holdRelease = {}
  holdRelease.promise = new Promise(r => (holdRelease.resolve = r))
  const r = await call('POST', '/api/previas/lote', { accountId: acc, driveFolderId: folder.id, folderName: 'Rodagem', localDir: files })
  assert.equal(r.status, 200, r.json?.error)
  const jobId = r.json.jobId
  assert.match(jobId, /^prv/)
  assert.equal((await call('POST', '/api/previas/lote', { accountId: acc, driveFolderId: folder.id, localDir: files })).status, 409)
  await waitFor(() => routeCalls >= 1, { timeoutMs: 5000 })
  assert.equal((await call('GET', '/api/state')).json.previas.jobId, jobId)
  holdRelease.resolve()
  holdRelease = null
  await waitFor(async () => (await call('GET', `/api/previas/lote/${jobId}`)).json.status === 'done', { timeoutMs: 10_000 })
  const done = (await call('GET', `/api/previas/lote/${jobId}`)).json
  assert.equal(done.progress.feitos, 1)
  const proxy = mock.listAll().find(i => i.name === 'A001.mp4')
  assert.deepEqual(proxy.appProperties, { sobedesce: 'previa', original: a.id })
  assert.equal(app.settings.get().previaLocalDir, files)
})
