// "Mover para a lixeira…" dos arquivos de controle do Mac (._A003_C001.braw, .DS_Store, Thumbs.db) contra o Drive
// falso: DriveClient.trash (files.update trashed: true, supportsAllDrives, limitador de metadados) e a rota
// POST /api/drive/:acc/lixeira/mac (só com `confirmado: true`, só ._ pequenos da própria pasta, drive compartilhado e
// recusa de permissão).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { setupDrive } from './helpers.js'
import { closeHttp } from '../src/net/http.js'
import { startApp } from '../src/index.js'

after(() => closeHttp())

const KB = 1000

// ─────────── DriveClient ───────────

test('DriveClient.trash: PATCH trashed: true pelo api() (limitador) e recusa sem permissão em português', async t => {
  const env = await setupDrive()
  t.after(env.cleanup)
  const { mock, drive } = env
  const pasta = mock.addFolder('Diária 02')
  const meta = mock.addFile('._A003_C001_1014XQ.braw', pasta.id, { size: 143 * KB })
  const calls = []
  const original = drive.api.bind(drive)
  drive.api = (method, p, opts = {}) => {
    calls.push({ method, path: String(p), body: opts.body })
    return original(method, p, opts)
  }
  let acquired = 0
  const acquire = drive.limiter.acquire.bind(drive.limiter)
  drive.limiter.acquire = (...a) => {
    acquired++
    return acquire(...a)
  }
  assert.deepEqual(await drive.trash(meta.id), { id: meta.id, trashed: true })
  assert.deepEqual(calls, [{ method: 'PATCH', path: `files/${meta.id}`, body: { trashed: true } }])
  assert.equal(acquired, 1, 'passa pelo limitador de metadados da conta')
  assert.equal(mock.getItem(meta.id).trashed, true)

  const so = mock.addFile('._A003_C002.braw', pasta.id, { size: 4 * KB, canTrash: false })
  await assert.rejects(drive.trash(so.id), err => err.status === 403 && /não pode mover este arquivo para a lixeira/.test(err.message))
  assert.equal(mock.getItem(so.id).trashed, false)
})

// ─────────── rota ───────────

let env
let app
before(async () => {
  env = await setupDrive()
  app = await startApp({ home: env.home, port: 0, open: false, quiet: true, managerOptions: { keepAwake: { active: false, setActive() {}, stop() {} } }, serverOptions: { log: () => {} } })
})
after(async () => {
  await app?.shutdown()
  await env?.cleanup()
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
        let json = null
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {}
        resolve({ status: res.statusCode, json })
      })
    })
    req.on('error', reject)
    if (data != null) req.write(data)
    req.end()
  })
}

const acc = () => {
  env.mock.applyEnv()
  return encodeURIComponent(env.accountId)
}
const lixeira = body => call('POST', `/api/drive/${acc()}/lixeira/mac`, { body })
const trashed = id => env.mock.getItem(id).trashed

/** Uma diária como as do Victor: BRAW de verdade e, no meio, os ._ que outra ferramenta subiu junto. */
function diaria(parent = 'root', nome = 'Diária 02 - Piscina') {
  const m = env.mock
  const pasta = m.addFolder(nome, parent)
  const braw = m.addFile('A003_C001_1014XQ.braw', pasta.id, { size: 31_000_000, mimeType: 'application/octet-stream' })
  const metas = [1, 2, 3].map(i => m.addFile(`._A003_C00${i}_1014XQ.braw`, pasta.id, { size: (120 + i * 10) * KB, mimeType: 'application/octet-stream' }))
  const grande = m.addFile('._A003_C009_grande.braw', pasta.id, { size: 4_000_000 })
  const ds = m.addFile('.DS_Store', pasta.id, { size: 6148 })
  const thumbs = m.addFile('Thumbs.db', pasta.id, { size: 2 * KB })
  return { pasta, braw, metas, grande, ds, thumbs }
}

test('rota: sem confirmado: true recusa e não mexe em nada', async () => {
  const d = diaria()
  for (const extra of [{}, { confirmado: 'true' }, { confirmado: 1 }, { confirmado: false }]) {
    const r = await lixeira({ folderId: d.pasta.id, ids: d.metas.map(x => x.id), ...extra })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /Confirme na tela/)
  }
  assert.ok(d.metas.every(x => !trashed(x.id)))
  // Um formulário de outro site não chega na rota.
  let r = await call('POST', `/api/drive/${acc()}/lixeira/mac`, { body: { folderId: d.pasta.id, ids: [d.metas[0].id], confirmado: true }, headers: { 'content-type': 'text/plain' } })
  assert.equal(r.status, 415)
  r = await call('POST', `/api/drive/${acc()}/lixeira/mac`, { body: { folderId: d.pasta.id, ids: [d.metas[0].id], confirmado: true }, headers: { origin: 'https://evil.example' } })
  assert.equal(r.status, 403)
  assert.ok(!trashed(d.metas[0].id))
  // Pedido malformado.
  for (const body of [
    { folderId: d.pasta.id, ids: [], confirmado: true },
    { folderId: d.pasta.id, ids: 'x', confirmado: true },
    { folderId: d.pasta.id, ids: ['../x'], confirmado: true },
    { folderId: d.pasta.id, ids: Array.from({ length: 51 }, (_, i) => `id${i}`), confirmado: true },
    { folderId: "' or 1", ids: [d.metas[0].id], confirmado: true },
  ]) {
    r = await lixeira(body)
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80))
  }
})

test('rota: só vão os ._ com menos de 4 MB, .DS_Store e Thumbs.db da própria pasta; o vídeo nunca', async () => {
  const d = diaria()
  const outra = diaria('root', 'Diária 03')
  const before = env.mock.stats().requests['files.update'] || 0
  const ids = [...d.metas, d.ds, d.thumbs, d.braw, d.grande, outra.metas[0]].map(x => x.id)
  const r = await lixeira({ folderId: d.pasta.id, ids, confirmado: true })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.movidos.sort(), [...d.metas, d.ds, d.thumbs].map(x => x.id).sort())
  assert.deepEqual(r.json.recusados, [])
  const pulados = Object.fromEntries(r.json.pulados.map(p => [p.id, p.motivo]))
  assert.match(pulados[d.braw.id], /Não é arquivo de controle do Mac/)
  assert.match(pulados[d.grande.id], /Não é arquivo de controle do Mac/, '._ de 4 MB ou mais fica')
  assert.match(pulados[outra.metas[0].id], /Não está mais nesta pasta/, 'id de outra pasta não vai')
  assert.equal((env.mock.stats().requests['files.update'] || 0) - before, 5, 'um files.update por arquivo movido, nenhum a mais')

  for (const x of [...d.metas, d.ds, d.thumbs]) assert.equal(trashed(x.id), true, x.name)
  for (const x of [d.braw, d.grande, ...outra.metas]) assert.equal(trashed(x.id), false, x.name)
  // A pasta listada de novo não traz mais os ._ (a lixeira some da listagem).
  const lista = await call('GET', `/api/drive/${acc()}/list?folderId=${d.pasta.id}`)
  assert.deepEqual(lista.json.items.map(x => x.name).sort(), ['._A003_C009_grande.braw', 'A003_C001_1014XQ.braw'])

  // De novo (outro clique, lote repetido): já foram, nada acontece.
  const r2 = await lixeira({ folderId: d.pasta.id, ids: d.metas.map(x => x.id), confirmado: true })
  assert.equal(r2.status, 200)
  assert.deepEqual(r2.json.movidos, [])
  assert.equal(r2.json.pulados.length, 3)
})

test('rota: drive compartilhado (supportsAllDrives) e recusa de permissão', async () => {
  const m = env.mock
  const sd = m.addSharedDrive('ZRO Filmes - Acervo')
  const d = diaria(sd.id, 'Caravana SUDECO')
  let r = await lixeira({ folderId: d.pasta.id, ids: [d.metas[0].id, d.ds.id], confirmado: true })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.movidos.sort(), [d.metas[0].id, d.ds.id].sort())
  assert.equal(trashed(d.metas[0].id), true)

  // Colaborador num drive compartilhado: o Google recusa jogar fora. Tudo recusado → 403 com o motivo.
  const so = m.addFolder('Só leitura', sd.id)
  const a = m.addFile('._A001.braw', so.id, { size: 4 * KB, canTrash: false })
  const b = m.addFile('._A002.braw', so.id, { size: 4 * KB, canTrash: false })
  r = await lixeira({ folderId: so.id, ids: [a.id, b.id], confirmado: true })
  assert.equal(r.status, 403)
  assert.match(r.json.error, /drive compartilhado/)
  assert.match(r.json.error, /Administrador de conteúdo/)
  assert.ok(!trashed(a.id) && !trashed(b.id))

  // Meu Drive, pasta de outra pessoa: mesma recusa, sem falar de drive compartilhado.
  const meu = m.addFolder('Compartilhada comigo')
  const c = m.addFile('._C001.braw', meu.id, { size: 4 * KB, canTrash: false })
  r = await lixeira({ folderId: meu.id, ids: [c.id], confirmado: true })
  assert.equal(r.status, 403)
  assert.match(r.json.error, /^Sua conta não pode mover estes arquivos para a lixeira/)

  // Parte pode, parte não: 200 com a lista do que foi recusado (a tela mostra).
  const mix = m.addFolder('Misturada')
  const ok = m.addFile('._OK.braw', mix.id, { size: 4 * KB })
  const no = m.addFile('._NAO.braw', mix.id, { size: 4 * KB, canTrash: false })
  r = await lixeira({ folderId: mix.id, ids: [ok.id, no.id], confirmado: true })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.movidos, [ok.id])
  assert.equal(r.json.recusados.length, 1)
  assert.equal(r.json.recusados[0].id, no.id)
  assert.equal(r.json.recusados[0].status, 403)
  assert.match(r.json.recusados[0].error, /não pode mover/)
})
