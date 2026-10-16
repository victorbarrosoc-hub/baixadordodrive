// "Gerar miniaturas" para RAW que já estão no Drive (src/media/raw-thumb-lote.js + rotas /api/raw-thumbs/lote):
// pares por nome (maiúsculas, NFC/NFD) + tamanho, tamanho diferente, sem arquivo no computador, subpastas,
// "refazer", cancelar no meio, extrator que falha sem parar o resto, Drive que recusa, varredura local com limites
// e validação das rotas — tudo contra o Drive falso, com um extrator de mentira.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { gerarMiniaturasLote, indexLocalRaw, nameKey, resumoLote } from '../src/media/raw-thumb-lote.js'
import { RawThumbnailer } from '../src/media/raw-thumb.js'
import { DriveClient } from '../src/google/drive.js'
import { startApp } from '../src/index.js'
import { HttpError, closeHttp } from '../src/net/http.js'
import { makeTmpDir, setupDrive, waitFor, loginWithMock } from './helpers.js'
import { startMockDrive } from './mock-drive.js'

const KiB = 1024
const posix = process.platform !== 'win32'

after(() => closeHttp())

function fakeJpeg(size = 4 * KiB, fill = 7) {
  const b = Buffer.alloc(size, fill)
  b[0] = 0xff
  b[1] = 0xd8
  b[2] = 0xff
  b[3] = 0xe0
  return b
}

async function tmp(t, prefix = 'sobedesce-lote-') {
  const dir = await makeTmpDir(prefix)
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}

/** Arquivo local de `size` bytes (o conteúdo não importa: o extrator é de mentira). */
async function put(dir, rel, size) {
  const p = path.join(dir, ...rel.split('/'))
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, Buffer.alloc(size, 1))
  return p
}

/** Drive falso + DriveClient rápido. */
async function driveSetup(t) {
  const env = await setupDrive()
  t.after(() => env.cleanup())
  const drive = new DriveClient(env.auth, env.accountId, { ratePerSec: 1000, retryBaseMs: 5 })
  return { env, mock: env.mock, drive }
}

/** Extrator de mentira: guarda os caminhos pedidos e devolve uma imagem por arquivo (ou o que `fn` decidir). */
function fakeFrame(fn = null) {
  const calls = []
  const frame = async (file, opts) => {
    calls.push(file)
    if (fn) return fn(file, opts)
    return { buf: fakeJpeg(2 * KiB, calls.length), reason: null }
  }
  return { frame, calls }
}

test('nameKey: NFC/NFD e maiúsculas viram a mesma chave', () => {
  const nfc = 'Cena Ação A001.braw'.normalize('NFC')
  const nfd = 'CENA AÇÃO a001.BRAW'.normalize('NFD')
  assert.notEqual(nfc, nfd.normalize('NFC'))
  assert.equal(nameKey(nfc), nameKey(nfd))
})

test('acha pelo nome (maiúsculas e NFC/NFD) + tamanho e grava a miniatura; tamanho diferente e sem arquivo ficam de fora', async t => {
  const { mock, drive } = await driveSetup(t)
  const local = await tmp(t)
  const dia = mock.addFolder('Diária 1')
  const a = mock.addFile('Cena Ação A001.braw'.normalize('NFC'), dia.id, { size: 1000, seed: 1 })
  const b = mock.addFile('B002_C003.BRAW', dia.id, { size: 2000, seed: 2 })
  const c = mock.addFile('C003_C001.braw', dia.id, { size: 3000, seed: 3 })
  const d = mock.addFile('D004_C001.r3d', dia.id, { size: 4000, seed: 4 })
  const mov = mock.addFile('Making of.mov', dia.id, { size: 500, seed: 5 })
  mock.addFile('E005_lixo.braw', dia.id, { size: 10, seed: 6, trashed: true })
  // No computador: nome em NFD (como o macOS grava), outro em minúsculas, um com tamanho diferente,
  // um repetido em duas pastas (só o do tamanho certo vale) e o .r3d que não existe aqui.
  const pa = await put(local, `CARD_A/${'Cena Ação A001.braw'.normalize('NFD')}`, 1000)
  const pb = await put(local, 'CARD_B/clip/b002_c003.braw', 2000)
  await put(local, 'CARD_C/C003_C001.braw', 2999)
  await put(local, 'CARD_A/B002_C003.braw', 1999)
  await put(local, 'Making of.mov', 500)

  const { frame, calls } = fakeFrame()
  const events = []
  const s = await gerarMiniaturasLote({ drive, driveFolderId: dia.id, localDir: local, frame, onProgress: p => events.push(p.phase) })
  assert.equal(s.raw, 4)
  assert.equal(s.total, 4)
  assert.equal(s.feitos, 2)
  assert.equal(s.semLocal, 1)
  assert.equal(s.tamanhoDiferente, 1)
  assert.equal(s.falhou, 0)
  assert.deepEqual(s.semLocalNomes, ['D004_C001.r3d'])
  assert.deepEqual(s.tamanhoNomes, [{ name: 'C003_C001.braw', drive: 3000, local: 2999 }])
  assert.deepEqual(calls.sort(), [pa, pb].sort())
  assert.deepEqual(new Set(s.feitosIds), new Set([a.id, b.id]))
  assert.ok(mock.getThumbnail(a.id))
  assert.ok(mock.getThumbnail(b.id))
  assert.equal(mock.getThumbnail(c.id), null)
  assert.equal(mock.getThumbnail(d.id), null)
  assert.equal(mock.getThumbnail(mov.id), null)
  assert.equal(s.phase, 'fim')
  for (const ph of ['drive', 'local', 'gerar', 'fim']) assert.ok(events.includes(ph), ph)
  assert.equal(resumoLote(s), '2 miniaturas gravadas · 1 sem arquivo no computador · 1 com tamanho diferente')

  // O Drive passou a ter miniatura: na segunda vez não sobra nada a fazer além dos que não têm par.
  const again = await gerarMiniaturasLote({ drive, driveFolderId: dia.id, localDir: local, frame })
  assert.equal(again.jaTinham, 2)
  assert.equal(again.feitos, 0)
  assert.equal(calls.length, 2)
})

test('subpastas do Drive só entram com "Incluir subpastas"', async t => {
  const { mock, drive } = await driveSetup(t)
  const local = await tmp(t)
  const proj = mock.addFolder('Projeto')
  const sub = mock.addFolder('Câmera B', proj.id)
  const top = mock.addFile('A001.braw', proj.id, { size: 100, seed: 1 })
  const deep = mock.addFile('B001.braw', sub.id, { size: 200, seed: 2 })
  await put(local, 'A001.braw', 100)
  await put(local, 'outro/B001.braw', 200)

  const flat = await gerarMiniaturasLote({ drive, driveFolderId: proj.id, localDir: local, recursive: false, frame: fakeFrame().frame })
  assert.equal(flat.raw, 1)
  assert.equal(flat.feitos, 1)
  assert.equal(mock.getThumbnail(deep.id), null)

  const all = await gerarMiniaturasLote({ drive, driveFolderId: proj.id, localDir: local, recursive: true, frame: fakeFrame().frame })
  assert.equal(all.raw, 2)
  assert.equal(all.jaTinham, 1)
  assert.equal(all.feitos, 1)
  assert.ok(mock.getThumbnail(deep.id))
  assert.ok(mock.getThumbnail(top.id))
})

test('quem já tem miniatura fica como está, a não ser com "refazer"', async t => {
  const { mock, drive } = await driveSetup(t)
  const local = await tmp(t)
  const f = mock.addFolder('Brutos')
  const old = fakeJpeg(1 * KiB, 9)
  const has = mock.addFile('A001.braw', f.id, { size: 100, seed: 1, thumbnail: old })
  const none = mock.addFile('A002.braw', f.id, { size: 100, seed: 2 })
  await put(local, 'A001.braw', 100)
  await put(local, 'A002.braw', 100)

  const s = await gerarMiniaturasLote({ drive, driveFolderId: f.id, localDir: local, frame: fakeFrame().frame })
  assert.equal(s.jaTinham, 1)
  assert.equal(s.total, 1)
  assert.equal(s.feitos, 1)
  assert.ok(mock.getThumbnail(has.id).data.equals(old), 'a miniatura que já existia não mudou')
  assert.ok(mock.getThumbnail(none.id))

  const nova = fakeJpeg(3 * KiB, 42)
  const r = await gerarMiniaturasLote({ drive, driveFolderId: f.id, localDir: local, refazer: true, frame: async () => ({ buf: nova, reason: null }) })
  assert.equal(r.jaTinham, 0)
  assert.equal(r.total, 2)
  assert.equal(r.feitos, 2)
  assert.ok(mock.getThumbnail(has.id).data.equals(nova))
})

test('extrator que falha (null ou erro) e Drive que recusa não param o resto', async t => {
  const { mock, drive } = await driveSetup(t)
  const local = await tmp(t)
  const f = mock.addFolder('Lote')
  const ids = {}
  for (const n of ['A1', 'A2', 'A3', 'A4', 'A5']) {
    ids[n] = mock.addFile(`${n}.braw`, f.id, { size: 100, seed: n.charCodeAt(1) }).id
    await put(local, `${n}.braw`, 100)
  }
  const frame = async file => {
    const n = path.basename(file, '.braw')
    if (n === 'A1') return { buf: null, reason: 'Quick Look do macOS: sem miniatura para este arquivo' }
    if (n === 'A2') throw new Error('o extrator caiu')
    if (n === 'A3') return { buf: Buffer.from('isto não é imagem'), reason: null }
    return { buf: fakeJpeg(), reason: null }
  }
  // Drive que recusa a gravação de um arquivo só.
  const picky = drive
  const realSet = drive.setThumbnail.bind(drive)
  picky.setThumbnail = (id, ...rest) => {
    if (id === ids.A4) {
      const message = 'The user does not have sufficient permissions for this file.'
      const body = { error: { code: 403, message, errors: [{ reason: 'insufficientFilePermissions', message }] } }
      return Promise.reject(new HttpError(403, { body, method: 'PATCH', url: 'https://www.googleapis.com/drive/v3/files/x' }))
    }
    return realSet(id, ...rest)
  }
  const s = await gerarMiniaturasLote({ drive: picky, driveFolderId: f.id, localDir: local, frame })
  assert.equal(s.total, 5)
  assert.equal(s.feitos, 1)
  assert.equal(s.falhou, 4)
  const why = Object.fromEntries(s.falhas.map(x => [x.name, x.reason]))
  assert.match(why['A1.braw'], /sem miniatura/)
  assert.match(why['A2.braw'], /caiu/)
  assert.match(why['A3.braw'], /inválida/)
  assert.match(why['A4.braw'], /sem permissão de edição/)
  assert.ok(mock.getThumbnail(ids.A5))
  assert.equal(resumoLote(s), '1 miniatura gravada · 4 falharam')
})

test('cancelar no meio para o lote: nada além do que já estava pronto é gravado', async t => {
  const { mock, drive } = await driveSetup(t)
  const local = await tmp(t)
  const f = mock.addFolder('Cartão')
  for (let i = 1; i <= 6; i++) {
    mock.addFile(`C${i}.braw`, f.id, { size: 100, seed: i })
    await put(local, `C${i}.braw`, 100)
  }
  const ac = new AbortController()
  let started = 0
  const frame = (file, { signal }) => {
    started++
    if (started === 1) return Promise.resolve({ buf: fakeJpeg(), reason: null })
    // O segundo trava até o cancelamento (como um RAW pesado decodificando).
    if (started === 2) setTimeout(() => ac.abort(), 30)
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('parou'), { name: 'AbortError' })), { once: true }))
  }
  const t0 = Date.now()
  await assert.rejects(gerarMiniaturasLote({ drive, driveFolderId: f.id, localDir: local, frame, signal: ac.signal, concurrency: 1 }), err => err.name === 'AbortError')
  assert.ok(Date.now() - t0 < 5000)
  assert.equal(started, 2)
  assert.equal(mock.stats().thumbnailsSet, 1)
})

test('varredura do computador: pula ocultas e de sistema, não segue links, avisa quando para no teto', async t => {
  const local = await tmp(t)
  await put(local, 'A/A001.braw', 10)
  await put(local, '.Trashes/A002.braw', 10)
  await put(local, '.hidden/A003.braw', 10)
  await put(local, '$RECYCLE.BIN/A004.braw', 10)
  await put(local, 'System Volume Information/A005.braw', 10)
  await put(local, 'B/._A001.braw', 4) // AppleDouble do macOS em cartão FAT/exFAT
  await put(local, 'B/notas.txt', 4)
  if (posix) {
    await fs.symlink(local, path.join(local, 'A', 'loop')) // link para a própria pasta: não pode virar laço
    await fs.symlink(path.join(local, 'A', 'A001.braw'), path.join(local, 'B', 'link.braw'))
  }
  const idx = await indexLocalRaw(local)
  assert.equal(idx.files, 1)
  assert.deepEqual([...idx.byName.keys()], ['a001.braw'])
  assert.equal(idx.truncated, false)

  const few = await indexLocalRaw(local, { limits: { maxEntries: 3 } })
  assert.equal(few.truncated, true)
  const shallow = await indexLocalRaw(local, { limits: { maxDepth: 0 } })
  assert.equal(shallow.truncated, true)
  assert.equal(shallow.files, 0)

  await assert.rejects(indexLocalRaw(path.join(local, 'nao-existe')), err => err.status === 400)
  await assert.rejects(indexLocalRaw(path.join(local, 'B', 'notas.txt')), err => err.status === 400)
})

test('pasta do Drive que não existe vira erro claro (404); arquivo no lugar de pasta, 400', async t => {
  const { mock, drive } = await driveSetup(t)
  const local = await tmp(t)
  const file = mock.addFile('A.braw', 'root', { size: 1, seed: 1 })
  await assert.rejects(gerarMiniaturasLote({ drive, driveFolderId: 'naoexiste123', localDir: local, frame: fakeFrame().frame }), err => err.status === 404 && /Não achei esta pasta/.test(err.message))
  await assert.rejects(gerarMiniaturasLote({ drive, driveFolderId: file.id, localDir: local, frame: fakeFrame().frame }), err => err.status === 400)
})

test('RawThumbnailer.frameFor: mesma fila dos envios (2 por vez) e cancelar não espera a vez', async () => {
  let active = 0
  let peak = 0
  const gates = []
  const th = new RawThumbnailer({
    maxConcurrent: 2,
    extract: async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => gates.push(resolve))
      active--
      return fakeJpeg()
    },
  })
  const ac = new AbortController()
  const p = [th.frameFor('/x/1.braw'), th.frameFor('/x/2.braw'), th.frameFor('/x/3.braw', { signal: ac.signal })]
  await waitFor(() => gates.length === 2)
  ac.abort()
  await assert.rejects(p[2], err => err.name === 'AbortError')
  for (const g of gates.splice(0)) g()
  const [a, b] = await Promise.all([p[0], p[1]])
  assert.ok(a.buf && b.buf)
  assert.equal(peak, 2)
  // Extrator que não acha nada: motivo vem do log do extrator.
  const none = new RawThumbnailer({ extract: async (f, o) => (o.log('nenhum extrator neste computador'), null) })
  assert.deepEqual(await none.frameFor('/x/4.braw'), { buf: null, reason: 'nenhum extrator neste computador' })
  await th.close()
})

// ─────────── rotas (app de verdade, Drive falso, extrator de mentira) ───────────

let mock, app, home, acc, files
const keepAwake = { active: false, setActive() {}, stop() {} }
const frameCalls = []
let frameHold = null

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
  files = await makeTmpDir('sobedesce-lote-files-')
  mock = await startMockDrive()
  mock.applyEnv()
  const thumbnailer = new RawThumbnailer({
    extract: async file => {
      frameCalls.push(file)
      if (frameHold) await frameHold
      return fakeJpeg()
    },
    detect: async () => ({ supported: true, found: true, via: 'quicklook', downloadUrl: 'https://example.invalid/braw' }),
  })
  app = await startApp({ home, port: 0, open: false, quiet: true, managerOptions: { keepAwake, thumbnailer }, serverOptions: { log: () => {}, spawn: () => new EventEmitter() } })
  await app.auth.setClientCredentials(mock.client)
  acc = (await loginWithMock(app.auth)).id
})

after(async () => {
  await app?.shutdown()
  await mock?.close()
  for (const d of [home, files]) if (d) await fs.rm(d, { recursive: true, force: true, maxRetries: 3 })
})

test('rota: pedidos inválidos são recusados (400/404) antes de começar', async () => {
  mock.applyEnv() // os testes de cima apontaram os endpoints para outros Drives falsos
  const folder = mock.addFolder('Validação')
  const okBody = { accountId: acc, driveFolderId: folder.id, localDir: files }
  const cases = [
    [{ ...okBody, accountId: 'quem?' }, 404],
    [{ ...okBody, driveFolderId: '' }, 400],
    [{ ...okBody, driveFolderId: '../../etc' }, 400],
    [{ ...okBody, driveFolderId: "x' or name contains '" }, 400],
    [{ ...okBody, driveFolderId: 42 }, 400],
    [{ ...okBody, localDir: '' }, 400],
    [{ ...okBody, localDir: 7 }, 400],
    [{ ...okBody, localDir: `${files}\u0000/x` }, 400],
    [{ ...okBody, localDir: path.join(files, 'nao-existe') }, 400],
    [{ ...okBody, recursive: 'sim' }, 400],
    [{ ...okBody, refazer: 1 }, 400],
  ]
  await fs.writeFile(path.join(files, 'arquivo.txt'), 'x')
  cases.push([{ ...okBody, localDir: path.join(files, 'arquivo.txt') }, 400])
  for (const [body, status] of cases) {
    const r = await call('POST', '/api/raw-thumbs/lote', body)
    assert.equal(r.status, status, JSON.stringify(body))
    assert.equal(r.json.ok, false)
    assert.ok(r.json.error)
  }
  assert.equal((await call('GET', '/api/raw-thumbs/lote/thbnaoexiste')).status, 404)
  assert.equal((await call('DELETE', '/api/raw-thumbs/lote/thbnaoexiste')).status, 404)
  assert.equal(frameCalls.length, 0)
})

test('rota: lote de ponta a ponta com progresso, um por vez, pasta lembrada nos ajustes e cancelar', async () => {
  mock.applyEnv()
  const folder = mock.addFolder('Rodagem')
  const sub = mock.addFolder('Cam B', folder.id)
  const a = mock.addFile('A001.braw', folder.id, { size: 300, seed: 1 })
  const b = mock.addFile('B001.braw', sub.id, { size: 400, seed: 2 })
  mock.addFile('Z009.braw', folder.id, { size: 10, seed: 3 })
  await put(files, 'cartao/A001.braw', 300)
  await put(files, 'cartao/B001.braw', 400)

  const st = await call('GET', '/api/raw-thumbs')
  assert.equal(st.json.rawThumbs.supported, true)

  let release
  frameHold = new Promise(resolve => (release = resolve))
  const r = await call('POST', '/api/raw-thumbs/lote', { accountId: acc, driveFolderId: folder.id, localDir: files })
  assert.equal(r.status, 200, r.json?.error)
  const jobId = r.json.jobId
  assert.match(jobId, /^thb/)
  // Um lote por vez.
  const busy = await call('POST', '/api/raw-thumbs/lote', { accountId: acc, driveFolderId: folder.id, localDir: files })
  assert.equal(busy.status, 409)
  await waitFor(() => frameCalls.length >= 1, { timeoutMs: 5000 })
  const mid = await call('GET', `/api/raw-thumbs/lote/${jobId}`)
  assert.equal(mid.json.status, 'running')
  assert.equal(mid.json.progress.phase, 'gerar')
  assert.equal((await call('GET', '/api/state')).json.rawThumbs.jobId, jobId)
  release()
  frameHold = null
  await waitFor(async () => (await call('GET', `/api/raw-thumbs/lote/${jobId}`)).json.status === 'done', { timeoutMs: 10_000 })
  const done = (await call('GET', `/api/raw-thumbs/lote/${jobId}`)).json
  assert.equal(done.progress.feitos, 2)
  assert.equal(done.progress.semLocal, 1)
  assert.deepEqual(new Set(done.progress.feitosIds), new Set([a.id, b.id]))
  assert.ok(mock.getThumbnail(a.id) && mock.getThumbnail(b.id))
  assert.equal(app.settings.get().rawThumbLocalDir, files)

  // Cancelar: o extrator trava, o DELETE para o lote e nada é gravado.
  const c = mock.addFolder('Para cancelar')
  mock.addFile('X1.braw', c.id, { size: 50, seed: 7 })
  await put(files, 'x/X1.braw', 50)
  frameHold = new Promise(() => {})
  const before = mock.stats().thumbnailsSet
  const n0 = frameCalls.length
  const r2 = await call('POST', '/api/raw-thumbs/lote', { accountId: acc, driveFolderId: c.id, localDir: files, recursive: false })
  assert.equal(r2.status, 200)
  await waitFor(() => frameCalls.length > n0, { timeoutMs: 5000 })
  assert.equal((await call('DELETE', `/api/raw-thumbs/lote/${r2.json.jobId}`)).status, 200)
  await waitFor(async () => (await call('GET', `/api/raw-thumbs/lote/${r2.json.jobId}`)).json.status === 'canceled', { timeoutMs: 5000 })
  assert.equal(mock.stats().thumbnailsSet, before)
  frameHold = null
})
