// Miniatura de .braw: extrairFrame (extratores trocáveis, tempo limite, tamanho), extratores do sistema com
// programas falsos (qlmanage/sips do Mac, PowerShell do Windows, ajudante nativo), detecção, setThumbnail no Drive
// falso e o envio de verdade pela fila gravando a miniatura sem atrasar nem quebrar nada.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  extrairFrame,
  isRawThumbCandidate,
  imageMime,
  runProcess,
  quickLookExtractor,
  windowsShellExtractor,
  helperExtractor,
  detectExtractor,
  RawThumbnailer,
  MAX_THUMB_BYTES,
  BLACKMAGIC_RAW_URL,
} from '../src/media/raw-thumb.js'
import { TransferManager } from '../src/engine/manager.js'
import { Settings } from '../src/config.js'
import { DriveClient } from '../src/google/drive.js'
import { Hasher } from '../src/engine/hasher.js'
import { planUploads } from '../src/engine/planner.js'
import { closeHttp } from '../src/net/http.js'
import { makeTmpDir, randomFile, setupDrive, waitFor } from './helpers.js'

const KiB = 1024
const MiB = 1024 * KiB
const posix = process.platform !== 'win32'

after(() => closeHttp())

/** "JPEG" de teste: só o cabeçalho importa para o motor e para o Drive falso. */
function fakeJpeg(size = 4 * KiB, fill = 7) {
  const b = Buffer.alloc(size, fill)
  b[0] = 0xff
  b[1] = 0xd8
  b[2] = 0xff
  b[3] = 0xe0
  return b
}
function fakePng(size = 4 * KiB) {
  const b = Buffer.alloc(size, 3)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b)
  return b
}

const fixed = (buf, id = 'fake') => ({ id, label: `Extrator ${id}`, extract: async () => buf })

async function tmp(t, prefix) {
  const dir = await makeTmpDir(prefix)
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}

async function clip(dir, name = 'A001_C001.braw', size = 64 * KiB) {
  const p = path.join(dir, name)
  await fs.writeFile(p, Buffer.alloc(size, 1))
  return p
}

/** Programa falso (Node com shebang) para fazer de qlmanage/sips/powershell/ajudante. */
async function fakeBin(dir, name, body) {
  const p = path.join(dir, name)
  await fs.writeFile(p, `#!${process.execPath}\n${body}\n`, { mode: 0o755 })
  return p
}

// ─────────── básico ───────────

test('isRawThumbCandidate: .braw e .r3d, sem diferenciar maiúsculas; o resto não', () => {
  for (const n of ['A001.braw', 'A001_C002.BRAW', '/x/y/Clip.Braw', 'B002.R3D']) assert.equal(isRawThumbCandidate(n), true, n)
  for (const n of ['A001.mov', 'braw', 'x.braw.mov', '', null, 'clip.braw.part']) assert.equal(isRawThumbCandidate(n), false, String(n))
})

test('imageMime reconhece JPEG, PNG e GIF pelos bytes', () => {
  assert.equal(imageMime(fakeJpeg()), 'image/jpeg')
  assert.equal(imageMime(fakePng()), 'image/png')
  assert.equal(imageMime(Buffer.from('GIF89a')), 'image/gif')
  assert.equal(imageMime(Buffer.from('nada disso')), null)
  assert.equal(imageMime(null), null)
})

// ─────────── extrairFrame ───────────

test('extrairFrame devolve a imagem do primeiro extrator que consegue', async t => {
  const dir = await tmp(t, 'sobedesce-thumb-')
  const file = await clip(dir)
  const img = fakeJpeg()
  const calls = []
  const none = { id: 'a', label: 'A', extract: async (f, o) => (calls.push(['a', f, o.width]), null) }
  const ok = { id: 'b', label: 'B', extract: async (f, o) => (calls.push(['b', f, o.width]), img) }
  const out = await extrairFrame(file, { extractors: [none, ok], largura: 1280 })
  assert.ok(out.equals(img))
  assert.deepEqual(calls, [
    ['a', file, 1280],
    ['b', file, 1280],
  ])
})

test('extrairFrame nunca lança: extrator quebrado, nenhum extrator, arquivo sumido → null com motivo', async t => {
  const dir = await tmp(t, 'sobedesce-thumb-')
  const file = await clip(dir)
  const reasons = []
  const log = r => reasons.push(r)
  const broken = { id: 'x', label: 'Quebrado', extract: async () => { throw new Error('explodiu') } }
  assert.equal(await extrairFrame(file, { extractors: [broken], log }), null)
  assert.match(reasons.pop(), /Quebrado: explodiu/)
  assert.equal(await extrairFrame(file, { extractors: [], log }), null)
  assert.match(reasons.pop(), /nenhum extrator/)
  assert.equal(await extrairFrame(path.join(dir, 'nao-existe.braw'), { extractors: [fixed(fakeJpeg())], log }), null)
  assert.match(reasons.pop(), /não encontrado/)
  assert.equal(await extrairFrame(file, { extractors: [fixed(Buffer.from('texto qualquer'))], log }), null)
  assert.match(reasons.pop(), /formato desconhecido/)
})

test('extrairFrame respeita o tempo limite mesmo com extrator que ignora o signal', async t => {
  const dir = await tmp(t, 'sobedesce-thumb-')
  const file = await clip(dir)
  const reasons = []
  const stuck = { id: 's', label: 'Travado', extract: () => new Promise(() => {}) }
  const t0 = Date.now()
  assert.equal(await extrairFrame(file, { extractors: [stuck], timeoutMs: 150, log: r => reasons.push(r) }), null)
  assert.ok(Date.now() - t0 < 2000, 'não esperou o extrator travado')
  assert.match(reasons[0], /tempo esgotado/)
})

test('extrairFrame recusa imagem acima do máximo (padrão 1,5 MB)', async t => {
  const dir = await tmp(t, 'sobedesce-thumb-')
  const file = await clip(dir)
  const reasons = []
  assert.equal(MAX_THUMB_BYTES, 1.5 * MiB)
  assert.equal(await extrairFrame(file, { extractors: [fixed(fakeJpeg(MAX_THUMB_BYTES + 1))], log: r => reasons.push(r) }), null)
  assert.match(reasons[0], /grande demais/)
  const fits = fakeJpeg(MAX_THUMB_BYTES)
  assert.ok((await extrairFrame(file, { extractors: [fixed(fits)] })).equals(fits))
  assert.equal(await extrairFrame(file, { extractors: [fixed(fakeJpeg(20 * KiB))], maxBytes: 10 * KiB }), null)
})

test('runProcess mata o processo no tempo limite', async () => {
  const t0 = Date.now()
  const r = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 200 })
  assert.equal(r.timedOut, true)
  assert.ok(Date.now() - t0 < 5000)
  const missing = await runProcess(path.join(process.cwd(), 'nao-existe-mesmo'), [], { timeoutMs: 2000 })
  assert.ok(missing.error)
})

// ─────────── extratores do sistema com programas falsos ───────────

// qlmanage falso: grava "<nome>.png" na pasta de -o, como o de verdade. Guarda os argumentos para conferir.
const QL_BODY = `
const fs = require('fs'), path = require('path')
const a = process.argv.slice(2)
fs.writeFileSync(path.join(process.env.FAKE_LOG_DIR, 'ql.json'), JSON.stringify(a))
if (process.env.FAKE_QL_NONE) process.exit(0)
const out = a[a.indexOf('-o') + 1], file = a[a.length - 1]
const png = Buffer.alloc(Number(process.env.FAKE_PNG_SIZE || 4096), 3)
Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(png)
fs.writeFileSync(path.join(out, path.basename(file) + '.png'), png)
`
// sips falso: JPEG cujo tamanho depende da qualidade e da largura (para provar a redução até caber).
const SIPS_BODY = `
const fs = require('fs'), path = require('path')
const a = process.argv.slice(2)
fs.appendFileSync(path.join(process.env.FAKE_LOG_DIR, 'sips.log'), JSON.stringify(a) + '\\n')
if (process.env.FAKE_SIPS_FAIL) process.exit(1)
const q = Number(a[a.indexOf('formatOptions') + 1]), w = Number(a[a.indexOf('-Z') + 1])
const size = Math.round(q * w * Number(process.env.FAKE_JPEG_FACTOR || 1))
const jpg = Buffer.alloc(size, 9)
Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(jpg)
fs.writeFileSync(a[a.indexOf('--out') + 1], jpg)
`

test('Quick Look (Mac): qlmanage gera PNG, sips converte para JPEG e reduz até caber', { skip: !posix }, async t => {
  const dir = await tmp(t, 'sobedesce-ql-')
  const file = await clip(dir, 'Cena 1 Take 2.braw')
  const qlmanage = await fakeBin(dir, 'qlmanage', QL_BODY)
  const sips = await fakeBin(dir, 'sips', SIPS_BODY)
  process.env.FAKE_LOG_DIR = dir
  t.after(() => {
    for (const k of ['FAKE_LOG_DIR', 'FAKE_JPEG_FACTOR', 'FAKE_SIPS_FAIL', 'FAKE_PNG_SIZE', 'FAKE_QL_NONE']) delete process.env[k]
  })
  const ex = quickLookExtractor({ qlmanage, sips })

  // Cabe de primeira: qualidade 80 na largura pedida.
  const out = await extrairFrame(file, { extractors: [ex], largura: 1280 })
  assert.equal(imageMime(out), 'image/jpeg')
  assert.equal(out.length, 80 * 1280)
  const ql = JSON.parse(await fs.readFile(path.join(dir, 'ql.json'), 'utf8'))
  assert.deepEqual(ql.slice(0, 3), ['-t', '-s', '1280'])
  assert.equal(ql.at(-1), file)

  // Não cabe: baixa a qualidade e depois a largura.
  await fs.rm(path.join(dir, 'sips.log'), { force: true })
  process.env.FAKE_JPEG_FACTOR = '20' // 80*1280*20 ≈ 2 MB; 65*1280*20 ≈ 1,6 MB; 60*768*20 ≈ 0,9 MB
  const small = await extrairFrame(file, { extractors: [ex], largura: 1280 })
  assert.equal(small.length, 60 * 768 * 20)
  assert.ok(small.length <= MAX_THUMB_BYTES)
  const sipsCalls = (await fs.readFile(path.join(dir, 'sips.log'), 'utf8')).trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(sipsCalls.map(a => [a[a.indexOf('formatOptions') + 1], a[a.indexOf('-Z') + 1]]), [
    ['80', '1280'],
    ['65', '1280'],
    ['60', '768'],
  ])

  // Sem sips: fica o PNG do Quick Look (o Drive aceita PNG).
  process.env.FAKE_SIPS_FAIL = '1'
  const png = await extrairFrame(file, { extractors: [ex] })
  assert.equal(imageMime(png), 'image/png')

  // Quick Look sem miniatura para o tipo (nada instalado): null, sem erro.
  process.env.FAKE_QL_NONE = '1'
  const reasons = []
  assert.equal(await extrairFrame(file, { extractors: [ex], log: r => reasons.push(r) }), null)
  assert.match(reasons[0], /sem miniatura/)
})

test('Windows: PowerShell recebe os caminhos por variável de ambiente e o script do Shell', { skip: !posix }, async t => {
  const dir = await tmp(t, 'sobedesce-ps-')
  const file = await clip(dir, "Cliente 'X' & Cia.braw")
  // PowerShell falso: confere o script codificado (UTF-16LE em base64) e grava o JPEG onde pediram.
  const ps = await fakeBin(
    dir,
    'powershell',
    `
const fs = require('fs'), path = require('path')
const a = process.argv.slice(2)
const script = Buffer.from(a[a.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'ps.json'), JSON.stringify({ a, script, env: {
  input: process.env.SOBEDESCE_THUMB_IN, width: process.env.SOBEDESCE_THUMB_WIDTH, max: process.env.SOBEDESCE_THUMB_MAX } }))
if (process.env.FAKE_PS_EXIT) process.exit(Number(process.env.FAKE_PS_EXIT))
const jpg = Buffer.alloc(2048, 5); Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(jpg)
fs.writeFileSync(process.env.SOBEDESCE_THUMB_OUT, jpg)
`,
  )
  t.after(() => delete process.env.FAKE_PS_EXIT)
  const ex = windowsShellExtractor({ powershell: ps })
  const out = await extrairFrame(file, { extractors: [ex], largura: 1280 })
  assert.equal(imageMime(out), 'image/jpeg')
  const seen = JSON.parse(await fs.readFile(path.join(dir, 'ps.json'), 'utf8'))
  assert.deepEqual(seen.a.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
  assert.equal(seen.env.input, file)
  assert.equal(seen.env.width, '1280')
  assert.equal(seen.env.max, String(MAX_THUMB_BYTES))
  assert.match(seen.script, /IShellItemImageFactory/)
  assert.match(seen.script, /0x8 \| 0x1/, 'só miniatura (nunca o ícone do arquivo)')
  assert.ok(!seen.script.includes(file), 'o nome do arquivo não entra no texto do script')

  // Código 2 = o Windows não tem miniatura para o tipo (Blackmagic RAW não instalado).
  process.env.FAKE_PS_EXIT = '2'
  const reasons = []
  assert.equal(await extrairFrame(file, { extractors: [ex], log: r => reasons.push(r) }), null)
  assert.match(reasons[0], /sem miniatura/)
  process.env.FAKE_PS_EXIT = '1'
  assert.equal(await extrairFrame(file, { extractors: [ex], log: r => reasons.push(r) }), null)
  assert.match(reasons[1], /saiu com 1/)
})

test('ajudante nativo: contrato --input/--output/--width/--max-bytes', { skip: !posix }, async t => {
  const dir = await tmp(t, 'sobedesce-helper-')
  const file = await clip(dir)
  const helper = await fakeBin(
    dir,
    'sobedesce-raw-frame',
    `
const fs = require('fs')
const a = process.argv.slice(2), arg = k => a[a.indexOf(k) + 1]
if (!fs.existsSync(arg('--input')) || arg('--width') !== '960' || arg('--max-bytes') !== '1000000') process.exit(9)
const jpg = Buffer.alloc(1024, 1); Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(jpg)
fs.writeFileSync(arg('--output'), jpg)
`,
  )
  const out = await extrairFrame(file, { extractors: [helperExtractor(helper)], largura: 960, maxBytes: 1_000_000 })
  assert.equal(imageMime(out), 'image/jpeg')
})

test('detecção: Linux não tem caminho; Mac com Quick Look e Blackmagic RAW instalado é encontrado', { skip: !posix }, async t => {
  const dir = await tmp(t, 'sobedesce-detect-')
  const linux = await detectExtractor({ platform: 'linux', env: {}, resourcesPath: undefined })
  assert.deepEqual(linux, { supported: false, found: false, via: null, downloadUrl: BLACKMAGIC_RAW_URL })

  const qlmanage = await fakeBin(dir, 'qlmanage', 'process.exit(0)')
  const home = path.join(dir, 'home')
  const mac = await detectExtractor({ platform: 'darwin', env: {}, resourcesPath: undefined, bins: { qlmanage }, home })
  assert.equal(mac.supported, true)
  assert.equal(mac.via, 'quicklook')
  assert.equal(mac.found, false)
  await fs.mkdir(path.join(home, 'Applications', 'Blackmagic RAW'), { recursive: true })
  const mac2 = await detectExtractor({ platform: 'darwin', env: {}, resourcesPath: undefined, bins: { qlmanage }, home })
  assert.equal(mac2.found, true)

  // Ajudante nativo presente conta como encontrado (ele carrega o SDK instalado).
  const helper = await fakeBin(dir, 'sobedesce-raw-frame', 'process.exit(2)')
  const withHelper = await detectExtractor({ platform: 'linux', env: { SOBEDESCE_RAW_HELPER: helper }, resourcesPath: undefined })
  assert.equal(withHelper.via, 'helper')
  assert.equal(withHelper.found, true)
})

// ─────────── RawThumbnailer (sem Drive) ───────────

test('RawThumbnailer: Drive que recusa ou extrator quebrado nunca vira erro; desligado não extrai', async () => {
  const rec = { id: 't1', type: 'upload', name: 'A.braw', local: { path: '/x/A.braw', size: 1, mtimeMs: 1 }, target: { fileId: 'F1' } }
  const results = []
  const refusing = { setThumbnail: async () => { throw new Error('403 recusado') } }
  const th = new RawThumbnailer({ extract: async () => fakeJpeg(), onResult: (r, ok) => results.push(ok) })
  assert.equal(await th.attach(rec, refusing), false)
  assert.match(th.last.reason, /recusou/)

  let calls = 0
  const broken = new RawThumbnailer({ extract: async () => { calls++; throw new Error('quebrou') } })
  assert.equal(await broken.attach({ ...rec, local: { ...rec.local, mtimeMs: 2 } }, { setThumbnail: async () => assert.fail('não grava') }), false)
  assert.equal(calls, 1)

  const settings = { get: () => ({ brawThumbnails: false }) }
  const off = new RawThumbnailer({ settings, extract: async () => { calls++; return fakeJpeg() } })
  off.prepare(rec)
  assert.equal(await off.attach(rec, { setThumbnail: async () => assert.fail('desligado') }), false)
  assert.equal(calls, 1)
  assert.deepEqual(results, [false])
})

test('RawThumbnailer: depois de 3 falhas seguidas do extrator, dá um tempo antes de tentar de novo', async () => {
  let calls = 0
  const th = new RawThumbnailer({ extract: async () => (calls++, null) })
  const drive = { setThumbnail: async () => {} }
  for (let i = 0; i < 4; i++) {
    await th.attach({ id: `r${i}`, type: 'upload', name: `C${i}.braw`, local: { path: `/x/C${i}.braw`, size: 1, mtimeMs: i }, target: { fileId: `F${i}` } }, drive)
  }
  assert.equal(calls, 3)
  assert.ok(th.pausedUntil > Date.now())
})

// ─────────── Drive falso ───────────

test('setThumbnail grava contentHints.thumbnail (base64 URL-safe) e o Drive passa a ter miniatura', async t => {
  const env = await setupDrive()
  t.after(() => env.cleanup())
  const drive = new DriveClient(env.auth, env.accountId, { ratePerSec: 1000, retryBaseMs: 5 })
  const item = env.mock.addFile('A001_C003.braw', 'root', { size: 1000, seed: 3 })
  // Bytes que em base64 comum teriam '+' e '/': provam o alfabeto URL-safe.
  const img = Buffer.concat([fakeJpeg(8), Buffer.from([0xfb, 0xff, 0xbf, 0xfe])])
  const r = await drive.setThumbnail(item.id, img, 'image/jpeg')
  assert.deepEqual(r, { id: item.id, hasThumbnail: true })
  const stored = env.mock.getThumbnail(item.id)
  assert.equal(stored.mimeType, 'image/jpeg')
  assert.ok(stored.data.equals(img))
  assert.equal(env.mock.stats().thumbnailsSet, 1)

  const meta = await drive.api('GET', `files/${item.id}`, { query: { fields: 'hasThumbnail,thumbnailLink' } })
  assert.equal(meta.hasThumbnail, true)
  // Como no Google, o thumbnailLink só abre com o token da conta.
  const served = Buffer.from(await (await fetch(meta.thumbnailLink, { headers: await drive.authHeader() })).arrayBuffer())
  assert.ok(served.equals(img))

  // Miniatura grande (1,5 MB) passa: o corpo do PATCH chega a ~2 MB em base64.
  const big = fakeJpeg(MAX_THUMB_BYTES)
  await drive.setThumbnail(item.id, big, 'image/jpeg')
  assert.equal(env.mock.getThumbnail(item.id).data.length, MAX_THUMB_BYTES)

  // Validação local antes de gastar uma chamada.
  await assert.rejects(drive.setThumbnail(item.id, fakeJpeg(2 * MiB + 1)), /2 MB/)
  await assert.rejects(drive.setThumbnail(item.id, fakeJpeg(), 'image/webp'), /não aceito/)
  // O Drive falso recusa base64 comum (com '+' e '/'), como o Google.
  await assert.rejects(
    drive.api('PATCH', `files/${item.id}`, { body: { contentHints: { thumbnail: { image: img.toString('base64'), mimeType: 'image/jpeg' } } }, query: { fields: 'id' }, retries: 0 }),
    err => err.status === 400,
  )
  // Conteúdo novo derruba a miniatura nossa (como no Google).
  env.mock.updateContent(item.id, { size: 2000, seed: 9 })
  assert.equal(env.mock.getThumbnail(item.id), null)
})

// ─────────── envio de verdade pela fila ───────────

async function queueSetup(t, { thumbnailer, settings = {} } = {}) {
  const env = await setupDrive()
  const dir = await makeTmpDir('sobedesce-thumb-queue-')
  const hasher = new Hasher({ cacheFile: path.join(env.home, 'hash-cache.json'), log: () => {} })
  t.after(async () => {
    await hasher.close()
    await env.cleanup()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })
  })
  const s = new Settings(env.paths.settings)
  await s.load()
  await s.update({ keepAwake: false, ...settings })
  const m = new TransferManager({
    settings: s,
    auth: env.auth,
    hasher,
    paths: env.paths,
    keepAwake: { active: false, setActive(v) { this.active = !!v }, stop() { this.active = false } },
    driveFactory: id => new DriveClient(env.auth, id, { ratePerSec: 1000, retryBaseMs: 5 }),
    taskOptions: { upload: { retryBaseMs: 5 } },
    thumbnailer,
  })
  if (thumbnailer && !thumbnailer.settings) thumbnailer.settings = s
  await m.init()
  t.after(() => m.shutdown())
  const send = async names => {
    const paths = []
    for (const [i, n] of names.entries()) {
      const p = path.join(dir, n)
      await randomFile(p, 256 * KiB + i, 40 + i)
      paths.push(p)
    }
    const plan = await planUploads({ drive: m.driveFor(env.accountId), accountId: env.accountId, paths, destFolderId: 'root' })
    await m.add({ batch: plan.batch, records: plan.records })
    return plan.records.map(r => r.id)
  }
  const finished = id => ['completed', 'failed', 'skipped', 'canceled'].includes(m.get(id)?.status)
  return { env, m, s, send, finished }
}

test('envio de .BRAW pela fila grava a miniatura no arquivo; .mov não chama o extrator', async t => {
  const img = fakeJpeg(16 * KiB)
  const seen = []
  const thumbnailer = new RawThumbnailer({ extract: async (file, opts) => (seen.push({ file, largura: opts.largura, timeoutMs: opts.timeoutMs }), img) })
  const { env, m, send, finished } = await queueSetup(t, { thumbnailer })
  const [brawId, movId] = await send(['A001_C004_0101AB.BRAW', 'Making of.mov'])
  await waitFor(() => finished(brawId) && finished(movId), { timeoutMs: 20_000 })
  assert.equal(m.get(brawId).status, 'completed', m.get(brawId).error?.message)
  assert.equal(m.get(movId).status, 'completed')
  await thumbnailer.idle()
  assert.equal(seen.length, 1)
  assert.match(seen[0].file, /A001_C004_0101AB\.BRAW$/)
  assert.equal(seen[0].largura, 960)
  assert.equal(seen[0].timeoutMs, 90_000)
  const brawFile = m.get(brawId).target.fileId
  assert.ok(env.mock.getThumbnail(brawFile).data.equals(img))
  assert.equal(env.mock.getThumbnail(m.get(movId).target.fileId), null)
  await waitFor(() => m.get(brawId).thumbnail === true, { message: 'o registro não marcou a miniatura' })
  assert.equal(m.get(movId).thumbnail, undefined)
})

test('extrator lento não atrasa o envio: termina antes e a miniatura chega depois, em segundo plano', async t => {
  let release
  const gate = new Promise(resolve => (release = resolve))
  let started = 0
  const thumbnailer = new RawThumbnailer({ extract: async () => (started++, gate) })
  const { env, m, send, finished } = await queueSetup(t, { thumbnailer })
  const [id] = await send(['B002_C001.braw'])
  await waitFor(() => finished(id), { timeoutMs: 20_000 })
  assert.equal(m.get(id).status, 'completed', m.get(id).error?.message)
  assert.equal(started, 1, 'o frame começou junto com o envio')
  const fileId = m.get(id).target.fileId
  assert.equal(env.mock.getThumbnail(fileId), null, 'ainda sem miniatura: o extrator não terminou')
  release(fakeJpeg())
  await thumbnailer.idle()
  assert.ok(env.mock.getThumbnail(fileId))
})

test('extrator travado, quebrado ou ausente não afeta o envio', async t => {
  const reasons = []
  const stuck = { id: 's', label: 'Travado', extract: () => new Promise(() => {}) }
  const broken = { id: 'b', label: 'Quebrado', extract: async () => { throw new Error('falhou feio') } }
  let n = 0
  // Extrator de verdade (extrairFrame) com tempo limite curto, alternando travado / quebrado / nenhum.
  const variants = [[stuck], [broken], []]
  const thumbnailer = new RawThumbnailer({
    timeoutMs: 200,
    log: r => reasons.push(r),
    extract: (file, opts) => extrairFrame(file, { ...opts, extractors: variants[n++ % variants.length] }),
  })
  const { env, m, send, finished } = await queueSetup(t, { thumbnailer, settings: { maxConcurrentUploads: 1 } })
  const ids = await send(['C1.braw', 'C2.braw', 'C3.braw'])
  await waitFor(() => ids.every(finished), { timeoutMs: 20_000 })
  for (const id of ids) {
    const r = m.get(id)
    assert.equal(r.status, 'completed', r.error?.message)
    assert.equal(r.error, null)
  }
  await thumbnailer.idle()
  for (const id of ids) assert.equal(env.mock.getThumbnail(m.get(id).target.fileId), null)
  assert.equal(env.mock.stats().thumbnailsSet, 0)
  assert.equal(reasons.filter(r => /ficou sem miniatura/.test(r)).length, 3)
})

test('Ajustes → miniatura de BRAW desligada: nenhum frame é extraído', async t => {
  let calls = 0
  const thumbnailer = new RawThumbnailer({ extract: async () => (calls++, fakeJpeg()) })
  const { env, m, send, finished } = await queueSetup(t, { thumbnailer, settings: { brawThumbnails: false } })
  const [id] = await send(['D1.braw'])
  await waitFor(() => finished(id), { timeoutMs: 20_000 })
  assert.equal(m.get(id).status, 'completed')
  await thumbnailer.idle()
  assert.equal(calls, 0)
  assert.equal(env.mock.getThumbnail(m.get(id).target.fileId), null)
})
