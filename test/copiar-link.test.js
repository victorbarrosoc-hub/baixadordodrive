// "Copiar de um link" (tela Drive) contra o Drive falso: leitura do link (pasta com resourcekey, subpastas, atalho,
// arquivo com cópia bloqueada), cópia pelo Google (files.copy) recriando as pastas no destino, progresso pelo
// GET /api/copiar e as recusas (link que a conta não abre, link que não é do Drive, plano que não vale mais).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setupDrive } from './helpers.js'
import { closeHttp } from '../src/net/http.js'
import { startApp } from '../src/index.js'
import { parseDriveLink } from '../src/google/copiar.js'

after(() => closeHttp())

test('parseDriveLink: pasta, arquivo, Documentos, ?id= e resourcekey; o resto não', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUv'
  assert.deepEqual(parseDriveLink(`https://drive.google.com/drive/folders/${id}?resourcekey=0-xyz_1&usp=sharing`), { id, resourceKey: '0-xyz_1', url: `https://drive.google.com/drive/folders/${id}?resourcekey=0-xyz_1&usp=sharing` })
  assert.equal(parseDriveLink(`olha: https://drive.google.com/drive/u/1/folders/${id}`).id, id)
  assert.equal(parseDriveLink(`https://drive.google.com/file/d/${id}/view?usp=drive_link`).id, id)
  assert.equal(parseDriveLink(`https://docs.google.com/document/d/${id}/edit`).id, id)
  assert.equal(parseDriveLink(`https://drive.google.com/open?id=${id}`).id, id)
  assert.equal(parseDriveLink(`https://drive.google.com/drive/folders/${id}?resourcekey=<script>`).resourceKey, null)
  assert.equal(parseDriveLink('https://www.dropbox.com/s/abc/file'), null)
  assert.equal(parseDriveLink('https://drive.google.com/drive/my-drive'), null)
  assert.equal(parseDriveLink('sem link'), null)
})

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

function call(method, p, { body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const h = { host: `127.0.0.1:${app.port}` }
    if (method !== 'GET') h['content-type'] = 'application/json'
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
const kids = id => [...env.mock.items.values()].filter(i => i.parents?.includes(id) && !i.trashed)

async function esperarFim() {
  for (let i = 0; i < 200; i++) {
    const r = await call('GET', '/api/copiar')
    if (r.json?.copia && r.json.copia.status !== 'running') return r.json.copia
    await new Promise(res => setTimeout(res, 25))
  }
  throw new Error('a cópia não terminou')
}

test('rota: lê a pasta do link (com resourcekey) e copia tudo para a pasta escolhida, menos o bloqueado e o atalho', async () => {
  const m = env.mock
  const destino = m.addFolder('Projetos')
  const terceiros = m.addFolder('Terceiros')
  const src = m.addFolder('Material SERHS', terceiros.id, { resourceKey: true })
  const drone = m.addFolder('Drone', src.id, { resourceKey: true })
  m.addFile('A001_C001.MP4', src.id, { size: 3_000_000, resourceKey: true })
  m.addFile('A001_C002.MP4', src.id, { size: 2_000_000, resourceKey: true })
  m.addFile('DJI_0001.MP4', drone.id, { size: 1_000_000, resourceKey: true })
  m.addFile('BLOQUEADO.MOV', src.id, { size: 9_000_000, canDownload: false, resourceKey: true })
  const alvo = m.addFile('outro.mp4', terceiros.id, { size: 10 })
  m.addShortcut('atalho', src.id, alvo.id)
  const link = `https://drive.google.com/drive/folders/${src.id}?resourcekey=${m.getItem(src.id).resourceKey}&usp=sharing`

  const lido = await call('POST', `/api/copiar/${acc()}/ler`, { body: { link } })
  assert.equal(lido.status, 200, JSON.stringify(lido.json))
  const p = lido.json.plano
  assert.equal(p.nome, 'Material SERHS')
  assert.equal(p.pasta, true)
  assert.equal(p.arquivos, 4)
  assert.equal(p.subpastas, 1)
  assert.equal(p.bloqueados, 1)
  assert.equal(p.atalhos, 1)
  assert.equal(p.bytes, 15_000_000)
  assert.ok(p.planoId)

  const antes = m.stats().copies || 0
  const ini = await call('POST', `/api/copiar/${acc()}`, { body: { planoId: p.planoId, dest: { id: destino.id, name: 'Projetos', path: 'Meu Drive / Projetos' } } })
  assert.equal(ini.status, 200, JSON.stringify(ini.json))
  const fim = await esperarFim()
  assert.equal(fim.status, 'done')
  assert.equal(fim.progress.total, 3)
  assert.equal(fim.progress.done, 3)
  assert.equal(fim.progress.bytesDone, 6_000_000)
  assert.equal(fim.progress.stopped, null)
  assert.deepEqual(fim.progress.failed.map(f => f.name), ['BLOQUEADO.MOV'])
  assert.equal((m.stats().copies || 0) - antes, 3, 'três files.copy, nenhum download')

  const nova = kids(destino.id).find(i => i.name === 'Material SERHS')
  assert.ok(nova, 'criou a pasta com o nome da do link')
  assert.equal(fim.progress.newFolderId, nova.id)
  assert.deepEqual(kids(nova.id).map(i => i.name).sort(), ['A001_C001.MP4', 'A001_C002.MP4', 'Drone'])
  const novoDrone = kids(nova.id).find(i => i.name === 'Drone')
  assert.deepEqual(kids(novoDrone.id).map(i => i.name), ['DJI_0001.MP4'])

  // O plano vale uma vez só.
  const de_novo = await call('POST', `/api/copiar/${acc()}`, { body: { planoId: p.planoId, dest: { id: destino.id, name: 'Projetos' } } })
  assert.equal(de_novo.status, 404)
})

test('rota: arquivo avulso por link vai direto para o destino', async () => {
  const m = env.mock
  const destino = m.addFolder('Roteiros')
  const pdf = m.addFile('Roteiro.pdf', m.addFolder('Cliente').id, { size: 1234 })
  const lido = await call('POST', `/api/copiar/${acc()}/ler`, { body: { link: `https://drive.google.com/file/d/${pdf.id}/view?usp=drive_link` } })
  assert.equal(lido.status, 200)
  assert.equal(lido.json.plano.pasta, false)
  assert.equal(lido.json.plano.arquivos, 1)
  await call('POST', `/api/copiar/${acc()}`, { body: { planoId: lido.json.plano.planoId, dest: { id: destino.id, name: 'Roteiros' } } })
  const fim = await esperarFim()
  assert.equal(fim.status, 'done')
  assert.equal(fim.progress.newFolderId, null)
  assert.deepEqual(kids(destino.id).map(i => i.name), ['Roteiro.pdf'])
})

test('rota: "também baixar para…" baixa da CÓPIA no Drive da conta (não do link), com as pastas e sem o bloqueado', async () => {
  const m = env.mock
  const destino = m.addFolder('Projetos HD')
  const src = m.addFolder('Diária 03', m.addFolder('De fora').id, { resourceKey: true })
  const sub = m.addFolder('Som', src.id, { resourceKey: true })
  const a = m.addFile('A002_C001.MP4', src.id, { size: 300_000, resourceKey: true })
  const b = m.addFile('ZOOM0001.WAV', sub.id, { size: 120_000, resourceKey: true })
  m.addFile('TRAVADO.MOV', src.id, { size: 50_000, canDownload: false, resourceKey: true })
  const link = `https://drive.google.com/drive/folders/${src.id}?resourcekey=${m.getItem(src.id).resourceKey}`
  const hd = path.join(env.home, 'SSD Externo')
  await fs.mkdir(hd, { recursive: true })

  const lido = await call('POST', `/api/copiar/${acc()}/ler`, { body: { link } })
  assert.equal(lido.status, 200, JSON.stringify(lido.json))
  const ini = await call('POST', `/api/copiar/${acc()}`, { body: { planoId: lido.json.plano.planoId, dest: { id: destino.id, name: 'Projetos HD' }, localDir: hd } })
  assert.equal(ini.status, 200, JSON.stringify(ini.json))
  assert.deepEqual(ini.json.copia.download, { status: 'aguardando', destDir: hd })
  await esperarFim()
  let copia
  for (let i = 0; i < 200; i++) {
    copia = (await call('GET', '/api/copiar')).json.copia
    if (copia.download?.status !== 'aguardando') break
    await new Promise(res => setTimeout(res, 25))
  }
  assert.equal(copia.download.status, 'na fila', JSON.stringify(copia.download))
  assert.equal(copia.download.count, 2, 'dois downloads (o bloqueado nem foi copiado)')
  assert.equal(copia.download.bytes, 420_000)

  // Os downloads apontam para as cópias (no Drive da conta), nunca para os arquivos do link.
  const nova = kids(destino.id).find(i => i.name === 'Diária 03')
  const novoSom = kids(nova.id).find(i => i.name === 'Som')
  const copias = new Set([...kids(nova.id), ...kids(novoSom.id)].map(i => i.id))
  const st = (await call('GET', '/api/state')).json
  const desta = (st.transfers || []).filter(t => t.batchId === copia.download.batchId)
  assert.equal(desta.length, 2)
  for (const t of desta) {
    assert.ok(copias.has(t.source?.fileId), `baixa da cópia, não do link (${t.name})`)
    assert.ok(t.source?.fileId !== a.id && t.source?.fileId !== b.id)
  }

  // No SSD: a pasta do link com a subpasta, os arquivos inteiros.
  const alvoA = path.join(hd, 'Diária 03', 'A002_C001.MP4')
  const alvoB = path.join(hd, 'Diária 03', 'Som', 'ZOOM0001.WAV')
  for (let i = 0; i < 400; i++) {
    const ok = await Promise.all([alvoA, alvoB].map(f => fs.stat(f).then(s => s.size, () => -1)))
    if (ok[0] === 300_000 && ok[1] === 120_000) break
    await new Promise(res => setTimeout(res, 50))
  }
  assert.equal((await fs.stat(alvoA)).size, 300_000)
  assert.equal((await fs.stat(alvoB)).size, 120_000)
  await assert.rejects(fs.stat(path.join(hd, 'Diária 03', 'TRAVADO.MOV')))
})

test('rota: pasta do computador inválida não começa nada', async () => {
  const m = env.mock
  const destino = m.addFolder('Nada começa')
  const src = m.addFolder('Outro link', 'root')
  m.addFile('x.mp4', src.id, { size: 10 })
  const lido = await call('POST', `/api/copiar/${acc()}/ler`, { body: { link: `https://drive.google.com/drive/folders/${src.id}` } })
  const antes = m.stats().copies || 0
  const r = await call('POST', `/api/copiar/${acc()}`, { body: { planoId: lido.json.plano.planoId, dest: { id: destino.id, name: 'x' }, localDir: 42 } })
  assert.equal(r.status, 400)
  const sumiu = await call('POST', `/api/copiar/${acc()}`, { body: { planoId: lido.json.plano.planoId, dest: { id: destino.id, name: 'x' }, localDir: path.join(env.home, 'disco que saiu') } })
  assert.equal(sumiu.status, 400)
  assert.match(sumiu.json.error, /disco está conectado/)
  assert.equal((m.stats().copies || 0) - antes, 0)
  assert.equal(kids(destino.id).length, 0)
})

test('rota: recusas em português (sem a chave, não é do Drive, sem destino)', async () => {
  const m = env.mock
  const src = m.addFolder('Fechada', 'root', { resourceKey: true })
  const sem = await call('POST', `/api/copiar/${acc()}/ler`, { body: { link: `https://drive.google.com/drive/folders/${src.id}` } })
  assert.equal(sem.status, 400)
  assert.match(sem.json.error, /não abre esse link/)
  const fora = await call('POST', `/api/copiar/${acc()}/ler`, { body: { link: 'https://www.dropbox.com/s/abc' } })
  assert.equal(fora.status, 400)
  assert.match(fora.json.error, /link do Google Drive/)
  const semDest = await call('POST', `/api/copiar/${acc()}`, { body: { planoId: 'x' } })
  assert.equal(semDest.status, 400)
  assert.match(semDest.json.error, /Escolha a pasta/)
})
