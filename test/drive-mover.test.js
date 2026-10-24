// "Compartilhados comigo", Renomear e Mover para… contra o Drive falso: DriveClient.listSharedWithMe / rename / move
// (files.update addParents/removeParents com supportsAllDrives) e as rotas /api/drive/:acc/compartilhados, /renomear e
// /mover (validação, recusas em português, pasta para dentro dela mesma, lote com parte recusada).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { setupDrive } from './helpers.js'
import { closeHttp } from '../src/net/http.js'
import { startApp } from '../src/index.js'

after(() => closeHttp())

// ─────────── DriveClient ───────────

test('DriveClient.listSharedWithMe: só o que outras pessoas compartilharam, sem lixeira, pastas primeiro', async t => {
  const env = await setupDrive()
  t.after(env.cleanup)
  const { mock, drive } = env
  mock.addFolder('Minha pasta')
  mock.addFile('meu.mov', 'root', { size: 10 })
  const sd = mock.addSharedDrive('Produtora XYZ')
  mock.addFile('do drive.mov', sd.id, { size: 10 })
  const pasta = mock.addShared('Campanha Verão', { folder: true, by: 'Bia' })
  mock.addFile('Filme_30s.mov', pasta.id, { size: 1234 })
  const arq = mock.addShared('Briefing.pdf', { size: 99, role: 'reader' })
  mock.addShared('Antigo.mov', { size: 5, trashed: true })
  const calls = []
  const original = drive.api.bind(drive)
  drive.api = (method, p, opts = {}) => {
    calls.push({ method, path: String(p), query: opts.query })
    return original(method, p, opts)
  }
  const items = await drive.listSharedWithMe()
  assert.deepEqual(items.map(x => x.name), ['Campanha Verão', 'Briefing.pdf'], 'pasta primeiro; nada do Meu Drive nem do drive compartilhado')
  assert.match(calls[0].query.q, /sharedWithMe = true and trashed = false/)
  assert.equal(calls[0].query.includeItemsFromAllDrives, 'true')
  assert.equal(calls[0].query.supportsAllDrives, 'true')
  const [p, f] = items
  assert.equal(p.isFolder, true)
  assert.equal(p.canAddChildren, true, 'editor pode enviar para dentro')
  assert.equal(p.canMove, false, 'a raiz do que foi compartilhado só o dono muda de lugar')
  assert.equal(f.id, arq.id)
  assert.equal(f.canRename, false, 'leitor não renomeia')
  assert.equal(f.owner?.name, 'Bia Produtora')

  // A pasta compartilhada abre como qualquer outra; o caminho começa nela (o pai não é visível).
  const filhos = await drive.listChildren(pasta.id, { media: true })
  assert.deepEqual(filhos.map(x => x.name), ['Filme_30s.mov'])
  assert.equal(filhos[0].canMove, true)
  assert.deepEqual(await drive.getPath(pasta.id), [{ id: pasta.id, name: 'Campanha Verão' }])
})

test('DriveClient.move: addParents/removeParents, já está lá, pasta para dentro dela mesma, sem permissão', async t => {
  const env = await setupDrive()
  t.after(env.cleanup)
  const { mock, drive } = env
  const brutos = mock.addFolder('Brutos')
  const dia1 = mock.addFolder('Dia 01', brutos.id)
  const entrega = mock.addFolder('Entrega')
  const clip = mock.addFile('A001_C002.mov', dia1.id, { size: 1000 })
  const calls = []
  const original = drive.api.bind(drive)
  drive.api = (method, p, opts = {}) => {
    calls.push({ method, path: String(p), query: opts.query, body: opts.body })
    return original(method, p, opts)
  }

  const r = await drive.move(clip.id, entrega.id)
  assert.equal(r.moved, true)
  assert.deepEqual(r.item.parents, [entrega.id])
  const patch = calls.find(c => c.method === 'PATCH')
  assert.equal(patch.path, `files/${clip.id}`)
  assert.equal(patch.query.addParents, entrega.id)
  assert.equal(patch.query.removeParents, dia1.id)
  assert.deepEqual(mock.getItem(clip.id).parents, [entrega.id])

  // De novo para o mesmo lugar: nada a fazer, nenhuma escrita.
  calls.length = 0
  assert.equal((await drive.move(clip.id, entrega.id)).moved, false)
  assert.equal(calls.filter(c => c.method === 'PATCH').length, 0)

  // Pasta para dentro dela mesma ou de uma subpasta: recusa antes de chamar o Google.
  await assert.rejects(drive.move(brutos.id, brutos.id), err => err.status === 400 && /dentro dela mesma/.test(err.message))
  await assert.rejects(drive.move(brutos.id, dia1.id), err => err.status === 400 && /pasta que está nela/.test(err.message))
  assert.deepEqual(mock.getItem(brutos.id).parents, [mock.rootId])
  // Destino que não é pasta.
  await assert.rejects(drive.move(entrega.id, clip.id), err => err.status === 400 && /precisa ser uma pasta/.test(err.message))

  // Para a raiz ('root') e para um drive compartilhado (supportsAllDrives).
  assert.equal((await drive.move(dia1.id, 'root')).moved, true)
  assert.deepEqual(mock.getItem(dia1.id).parents, [mock.rootId])
  const sd = mock.addSharedDrive('Finalização')
  const r2 = await drive.move(entrega.id, sd.id)
  assert.equal(r2.item.driveId, sd.id)
  assert.equal(mock.getItem(clip.id).driveId, sd.id, 'o que está dentro vai junto')

  // Compartilhado comigo: leitor não move nem recebe; editor move dentro da pasta dele.
  const ler = mock.addShared('Só leitura', { folder: true, role: 'reader' })
  const dentro = mock.addFile('cena.mov', ler.id, { size: 10 })
  await assert.rejects(drive.move(dentro.id, brutos.id), err => err.status === 403 && /não pode mover este item para lá/.test(err.message))
  await assert.rejects(drive.move(brutos.id, ler.id), err => err.status === 403 && /não pode mover/.test(err.message))
  const edita = mock.addShared('Projeto da Bia', { folder: true })
  const sub = mock.addFolder('Cor', edita.id)
  const take = mock.addFile('take.mov', edita.id, { size: 10 })
  assert.equal((await drive.move(take.id, sub.id)).moved, true)
  // A raiz do que foi compartilhado: só quem é dono muda de lugar.
  await assert.rejects(drive.move(edita.id, brutos.id), err => err.status === 403 && /só quem é dono/.test(err.message))
})

test('DriveClient.rename: troca o nome e recusa leitor em português', async t => {
  const env = await setupDrive()
  t.after(env.cleanup)
  const { mock, drive } = env
  const f = mock.addFile('Master_v1.mov', 'root', { size: 10 })
  const item = await drive.rename(f.id, '  Master_v2.mov ')
  assert.equal(item.name, 'Master_v2.mov')
  assert.equal(mock.getItem(f.id).name, 'Master_v2.mov')
  const so = mock.addShared('Contrato.pdf', { size: 10, role: 'reader' })
  await assert.rejects(drive.rename(so.id, 'x.pdf'), err => err.status === 403 && /não pode renomear/.test(err.message))
  await assert.rejects(drive.rename(f.id, '   '), err => err.status === 400)
})

// ─────────── rotas ───────────

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

test('rota compartilhados: lista o que foi compartilhado e a pasta abre pelo /list com o caminho começando nela', async () => {
  const m = env.mock
  const pasta = m.addShared('Casamento Ana e Leo', { folder: true, by: 'Bia' })
  m.addFile('Ceri_A001.mov', pasta.id, { size: 5000 })
  m.addShared('Roteiro.pdf', { size: 10, role: 'reader' })
  const r = await call('GET', `/api/drive/${acc()}/compartilhados`)
  assert.equal(r.status, 200)
  const nomes = r.json.items.map(x => x.name)
  assert.ok(nomes.includes('Casamento Ana e Leo') && nomes.includes('Roteiro.pdf'))
  assert.ok(nomes.indexOf('Casamento Ana e Leo') < nomes.indexOf('Roteiro.pdf'), 'pastas primeiro')
  const lista = await call('GET', `/api/drive/${acc()}/list?folderId=${pasta.id}`)
  assert.equal(lista.status, 200)
  assert.deepEqual(lista.json.path, [{ id: pasta.id, name: 'Casamento Ana e Leo' }])
  assert.deepEqual(lista.json.items.map(x => x.name), ['Ceri_A001.mov'])
  assert.equal(lista.json.folder.canAddChildren, true, 'a pasta aberta diz se dá para enviar para ela')
  const so = m.addShared('Só para ver', { folder: true, role: 'reader' })
  const r2 = await call('GET', `/api/drive/${acc()}/list?folderId=${so.id}`)
  assert.equal(r2.json.folder.canAddChildren, false)
})

test('rota renomear: valida o pedido e devolve o item novo; leitor → 403', async () => {
  const m = env.mock
  const f = m.addFile('Corte_v3.mov', 'root', { size: 10 })
  for (const body of [{ id: f.id }, { id: f.id, name: '   ' }, { id: '../x', name: 'a' }, { id: 'root', name: 'a' }, { id: f.id, name: 'a/b' }, { id: f.id, name: 'x'.repeat(256) }]) {
    const r = await call('POST', `/api/drive/${acc()}/renomear`, { body })
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60))
  }
  let r = await call('POST', `/api/drive/${acc()}/renomear`, { body: { id: f.id, name: 'Corte_v4.mov' } })
  assert.equal(r.status, 200)
  assert.equal(r.json.item.name, 'Corte_v4.mov')
  assert.equal(m.getItem(f.id).name, 'Corte_v4.mov')
  const so = m.addShared('Deles.mov', { size: 10, role: 'reader' })
  r = await call('POST', `/api/drive/${acc()}/renomear`, { body: { id: so.id, name: 'Meu.mov' } })
  assert.equal(r.status, 403)
  assert.match(r.json.error, /não pode renomear/)
  // Um formulário de outro site não chega na rota.
  r = await call('POST', `/api/drive/${acc()}/renomear`, { body: { id: f.id, name: 'x' }, headers: { origin: 'https://evil.example' } })
  assert.equal(r.status, 403)
  assert.equal(m.getItem(f.id).name, 'Corte_v4.mov')
})

test('rota mover: lote com o que foi, o que já estava e o que foi recusado; tudo recusado vira erro', async () => {
  const m = env.mock
  const origem = m.addFolder('Diária 05')
  const destino = m.addFolder('Selecionados')
  const a = m.addFile('A.mov', origem.id, { size: 1 })
  const b = m.addFile('B.mov', destino.id, { size: 1 })
  const so = m.addShared('Pasta da Bia', { folder: true, role: 'reader' })
  const c = m.addFile('C.mov', so.id, { size: 1 })
  for (const body of [{ ids: [], destId: destino.id }, { ids: 'x', destId: destino.id }, { ids: ['root'], destId: destino.id }, { ids: [a.id] }, { ids: [a.id], destId: "' or 1" }, { ids: Array.from({ length: 51 }, (_, i) => `id${i}`), destId: destino.id }]) {
    const r = await call('POST', `/api/drive/${acc()}/mover`, { body })
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60))
  }
  let r = await call('POST', `/api/drive/${acc()}/mover`, { body: { ids: [a.id, b.id, c.id], destId: destino.id } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.movidos, [a.id])
  assert.deepEqual(r.json.ja, [b.id])
  assert.equal(r.json.recusados.length, 1)
  assert.equal(r.json.recusados[0].id, c.id)
  assert.equal(r.json.recusados[0].status, 403)
  assert.deepEqual(m.getItem(a.id).parents, [destino.id])
  assert.deepEqual(m.getItem(c.id).parents, [so.id])

  // Tudo recusado: erro com a mensagem (a tela mostra).
  r = await call('POST', `/api/drive/${acc()}/mover`, { body: { ids: [origem.id], destId: origem.id } })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /dentro dela mesma/)
  r = await call('POST', `/api/drive/${acc()}/mover`, { body: { ids: [c.id], destId: destino.id } })
  assert.equal(r.status, 403)
  // A lista do destino já mostra o que chegou.
  const lista = await call('GET', `/api/drive/${acc()}/list?folderId=${destino.id}`)
  assert.deepEqual(lista.json.items.map(x => x.name), ['A.mov', 'B.mov'])
})
