// "Mandar o link pro cliente" e "achar a pasta certa rápido", contra o Drive falso: o link (webViewLink) e quem
// consegue abrir (permissões, herança, drive compartilhado), liberar para "qualquer pessoa com o link" só com
// confirmação explícita (e as recusas do Workspace/drive compartilhado), a busca de pastas (aspas no nome, escopo) e
// as rotas do servidor local. Os Recentes do seletor e os textos do aviso ficam nos testes de public/lib no fim.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { setupDrive } from './helpers.js'
import { linkAccess } from '../src/google/drive.js'
import { closeHttp } from '../src/net/http.js'
import { startApp } from '../src/index.js'
import { recentes, lembrarDestino, esquecerDestino, pastaInicial, MAX_RECENTES } from '../public/lib/destinos.js'
import { avisoDoLink, CONFIRMAR_LIBERAR } from '../public/lib/compartilhar.js'
import { batchFolder } from '../public/lib/transferencias.js'

after(() => closeHttp())

async function setup(t, mockOptions = {}) {
  const ctx = await setupDrive(mockOptions)
  t.after(ctx.cleanup)
  return ctx
}

/** Conta as chamadas que passam por drive.api (método e caminho). */
function spyApi(drive) {
  const calls = []
  const original = drive.api.bind(drive)
  drive.api = (method, pathOrUrl, opts = {}) => {
    calls.push({ method, path: String(pathOrUrl), query: { ...(opts.query || {}) }, body: opts.body })
    return original(method, pathOrUrl, opts)
  }
  return calls
}

const anyone = perms => perms.filter(p => p.type === 'anyone')

// ─────────── DriveClient: link e permissão ───────────

test('linkAccess: qualquer pessoa > domínio > restrito', () => {
  assert.deepEqual(linkAccess([{ type: 'user', role: 'owner' }]), { access: 'restrito', domain: null })
  assert.deepEqual(linkAccess([{ type: 'user', role: 'owner' }, { type: 'domain', role: 'reader', domain: 'zrofilmes.com' }]), { access: 'dominio', domain: 'zrofilmes.com' })
  assert.deepEqual(linkAccess([{ type: 'domain', role: 'reader', domain: 'x.com' }, { type: 'anyone', role: 'reader' }]), { access: 'qualquer', domain: null })
  assert.deepEqual(linkAccess(undefined), { access: 'restrito', domain: null })
})

test('sharing no Meu Drive: webViewLink, "só quem tem acesso" e uma chamada só', async t => {
  const { mock, drive } = await setup(t)
  const pasta = mock.addFolder('Diária 02 - Piscina')
  const calls = spyApi(drive)
  const link = await drive.sharing(pasta.id)
  assert.equal(calls.length, 1, 'files.get já traz permissions e shared')
  assert.equal(calls[0].method, 'GET')
  assert.match(calls[0].query.fields, /webViewLink/)
  assert.match(calls[0].query.fields, /permissions\(/)
  assert.equal(link.url, `https://drive.google.com/drive/folders/${pasta.id}`)
  assert.equal(link.access, 'restrito')
  assert.equal(link.isFolder, true)
  assert.equal(link.canShare, true)
  assert.equal(link.root, false)
  assert.equal(link.podeLiberar, true)

  const arq = mock.addFile('SERHS_Master_v3.mov', pasta.id, { size: 10 })
  const l2 = await drive.sharing(arq.id)
  assert.equal(l2.isFolder, false)
  assert.equal(l2.url, `https://drive.google.com/file/d/${arq.id}/view?usp=drivesdk`)
})

test('sharing: herda "qualquer pessoa" da pasta de cima e reconhece o domínio', async t => {
  const { mock, drive } = await setup(t)
  const cliente = mock.addFolder('SERHS Grand Hotel')
  const entregas = mock.addFolder('06 Entregas', cliente.id)
  const interna = mock.addFolder('Interna')
  mock.share(cliente.id, { type: 'anyone', role: 'reader' })
  mock.share(interna.id, { type: 'domain', role: 'reader', domain: 'zrofilmes.com' })
  const herdado = await drive.sharing(entregas.id)
  assert.equal(herdado.access, 'qualquer')
  assert.equal(herdado.podeLiberar, false, 'já abre para qualquer pessoa: nada a liberar')
  const dom = await drive.sharing(interna.id)
  assert.equal(dom.access, 'dominio')
  assert.equal(dom.domain, 'zrofilmes.com')
  assert.equal(dom.podeLiberar, true)
})

test('sharing em drive compartilhado: o Google não manda permissions, então vai um permissions.list', async t => {
  const { mock, drive } = await setup(t)
  const sd = mock.addSharedDrive('ZRO Filmes - Acervo')
  const ano = mock.addFolder('2025', sd.id)
  const calls = spyApi(drive)
  const link = await drive.sharing(ano.id)
  assert.equal(link.sharedDrive, true)
  assert.equal(link.access, 'restrito')
  assert.equal(link.podeLiberar, true)
  assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), [`GET files/${ano.id}`, `GET files/${ano.id}/permissions`])

  // Raiz do drive compartilhado: dá o link, mas não dá para liberar.
  const raiz = await drive.sharing(sd.id)
  assert.equal(raiz.root, true)
  assert.equal(raiz.podeLiberar, false)
  await assert.rejects(drive.shareWithAnyone(sd.id), err => err.status === 403 && /raiz de um drive compartilhado/.test(err.message))
})

test('shareWithAnyone: cria anyone/leitor sem aparecer em busca, também em drive compartilhado (supportsAllDrives)', async t => {
  const { mock, drive } = await setup(t)
  const pasta = mock.addFolder('ENTREGA_SERHS')
  const calls = spyApi(drive)
  const perm = await drive.shareWithAnyone(pasta.id)
  assert.equal(perm.type, 'anyone')
  assert.equal(perm.role, 'reader')
  const post = calls.find(c => c.method === 'POST')
  assert.deepEqual(post.body, { type: 'anyone', role: 'reader', allowFileDiscovery: false })
  assert.deepEqual(anyone(mock.permissionsOf(pasta.id)), [{ id: 'anyoneWithLink', type: 'anyone', role: 'reader', allowFileDiscovery: false }])
  assert.equal((await drive.sharing(pasta.id)).access, 'qualquer')
  // Repetir não duplica.
  await drive.shareWithAnyone(pasta.id)
  assert.equal(anyone(mock.permissionsOf(pasta.id)).length, 1)

  const sd = mock.addSharedDrive('Acervo')
  const dentro = mock.addFolder('Caravana SUDECO', sd.id)
  await drive.shareWithAnyone(dentro.id) // sem supportsAllDrives o mock responderia 404
  assert.equal((await drive.sharing(dentro.id)).access, 'qualquer')
})

test('shareWithAnyone: recusa da política do Workspace e do drive compartilhado vira mensagem clara e não muda nada', async t => {
  const { mock, drive } = await setup(t, { anyoneSharingBlocked: true })
  const pasta = mock.addFolder('Diária 02')
  await assert.rejects(drive.shareWithAnyone(pasta.id), err => {
    assert.equal(err.name, 'SobeDesceError')
    assert.equal(err.status, 403)
    assert.equal(err.reason, 'politicaCompartilhamento')
    assert.match(err.message, /^Seu Workspace não deixa compartilhar com qualquer pessoa/)
    return true
  })
  assert.deepEqual(anyone(mock.permissionsOf(pasta.id)), [])

  mock.setOptions({ anyoneSharingBlocked: false })
  const sd = mock.addSharedDrive('Só da empresa', { domainUsersOnly: true })
  const f = mock.addFolder('Brutos', sd.id)
  await assert.rejects(drive.shareWithAnyone(f.id), /Seu Workspace não deixa compartilhar com qualquer pessoa/)
  assert.deepEqual(anyone(mock.permissionsOf(f.id)), [])
})

test('sharing sem poder compartilhar: não oferece liberar e, sem ver as permissões, diz que não sabe', async t => {
  const { mock, drive } = await setup(t)
  const pasta = mock.addFolder('Compartilhada comigo', 'root', { canShare: false })
  mock.share(pasta.id, { type: 'user', role: 'writer', emailAddress: 'edu@zrofilmes.com' })
  const link = await drive.sharing(pasta.id)
  assert.equal(link.canShare, false)
  assert.equal(link.access, 'desconhecido')
  assert.equal(link.podeLiberar, false)
  await assert.rejects(drive.shareWithAnyone(pasta.id), /Sua conta não pode mudar o compartilhamento/)
})

// ─────────── DriveClient: buscar pasta ───────────

test('searchFolders: só pastas, aspas e barra no nome, caminho de cada uma e o escopo (Meu Drive ou drive compartilhado)', async t => {
  const { mock, drive } = await setup(t)
  const cliente = mock.addFolder('SERHS Grand Hotel')
  const proj = mock.addFolder('2026-10 Campanha Verão', cliente.id)
  const alvo = mock.addFolder("Diária 02 - D'Ávila", proj.id)
  mock.addFolder("Diária 02 - D'Ávila (lixeira)", proj.id, { trashed: true })
  mock.addFile("D'Ávila making of.mov", proj.id, { size: 5 })
  const barra = mock.addFolder('Cena \\ 1', 'root')
  const sd = mock.addSharedDrive('ZRO Filmes - Acervo')
  const noSd = mock.addFolder("D'Ávila acervo", sd.id)

  const calls = spyApi(drive)
  const r = await drive.searchFolders("D'Ávila")
  assert.deepEqual(r.map(x => x.name), ["Diária 02 - D'Ávila"], 'nem arquivo, nem lixeira, nem o drive compartilhado')
  assert.equal(r[0].id, alvo.id)
  assert.deepEqual(r[0].path, ['Meu Drive', 'SERHS Grand Hotel', '2026-10 Campanha Verão'])
  const q = calls.find(c => c.query.q)?.query.q
  assert.equal(q, "mimeType = 'application/vnd.google-apps.folder' and name contains 'D\\'Ávila' and trashed = false")

  assert.deepEqual((await drive.searchFolders('Cena \\')).map(x => x.id), [barra.id])

  const s2 = await drive.searchFolders("d'ávila", { driveId: sd.id })
  assert.deepEqual(s2.map(x => x.id), [noSd.id])
  assert.deepEqual(s2[0].path, ['ZRO Filmes - Acervo'])
  assert.deepEqual(await drive.searchFolders('   '), [])
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
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {}
        resolve({ status: res.statusCode, json })
      })
    })
    req.on('error', reject)
    if (data != null) req.write(data)
    req.end()
  })
}

// Os testes de cima sobem Drives falsos próprios (e apontam os endpoints para eles): as rotas voltam para o do app.
const acc = () => {
  env.mock.applyEnv()
  return encodeURIComponent(env.accountId)
}

test('rotas: GET /link mostra o link e quem abre; liberar exige confirmado: true (e Content-Type JSON)', async () => {
  const pasta = env.mock.addFolder('Rota - Entrega')
  let r = await call('GET', `/api/drive/${acc()}/link?id=${pasta.id}`)
  assert.equal(r.status, 200)
  assert.equal(r.json.link.access, 'restrito')
  assert.equal(r.json.link.url, `https://drive.google.com/drive/folders/${pasta.id}`)
  assert.equal(r.json.link.podeLiberar, true)

  // Nunca libera sem a confirmação explícita da tela.
  for (const body of [{ id: pasta.id }, { id: pasta.id, confirmado: 'true' }, { id: pasta.id, confirmado: 1 }]) {
    r = await call('POST', `/api/drive/${acc()}/link/liberar`, { body })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /Confirme na tela/)
  }
  // Um formulário de outro site não manda JSON: recusado antes de chegar na rota.
  r = await call('POST', `/api/drive/${acc()}/link/liberar`, { body: { id: pasta.id, confirmado: true }, headers: { 'content-type': 'text/plain' } })
  assert.equal(r.status, 415)
  r = await call('POST', `/api/drive/${acc()}/link/liberar`, { body: { id: pasta.id, confirmado: true }, headers: { origin: 'https://evil.example' } })
  assert.equal(r.status, 403)
  assert.deepEqual(anyone(env.mock.permissionsOf(pasta.id)), [])

  r = await call('POST', `/api/drive/${acc()}/link/liberar`, { body: { id: pasta.id, confirmado: true } })
  assert.equal(r.status, 200)
  assert.equal(r.json.link.access, 'qualquer')
  assert.equal(r.json.link.podeLiberar, false)
  assert.deepEqual(anyone(env.mock.permissionsOf(pasta.id)).map(p => [p.id, p.role]), [['anyoneWithLink', 'reader']])
})

test('rotas: liberar recusa Meu Drive, item inválido e mostra a recusa do domínio', async () => {
  let r = await call('POST', `/api/drive/${acc()}/link/liberar`, { body: { id: 'root', confirmado: true } })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /Meu Drive inteiro/)
  r = await call('GET', `/api/drive/${acc()}/link?id=${encodeURIComponent('../x')}`)
  assert.equal(r.status, 400)
  r = await call('GET', `/api/drive/nao-existe/link?id=abc`)
  assert.equal(r.status, 404)

  const pasta = env.mock.addFolder('Rota - Bloqueada')
  env.mock.setOptions({ anyoneSharingBlocked: true })
  try {
    r = await call('POST', `/api/drive/${acc()}/link/liberar`, { body: { id: pasta.id, confirmado: true } })
    assert.equal(r.status, 403)
    assert.match(r.json.error, /^Seu Workspace não deixa compartilhar com qualquer pessoa/)
    assert.deepEqual(anyone(env.mock.permissionsOf(pasta.id)), [])
  } finally {
    env.mock.setOptions({ anyoneSharingBlocked: false })
  }
})

test('rotas: GET /pastas busca pastas pelo nome no escopo, com o caminho', async () => {
  const cli = env.mock.addFolder('Rota SESI Nordeste Criativo')
  const alvo = env.mock.addFolder("Rota Diária 'aspas'", cli.id)
  let r = await call('GET', `/api/drive/${acc()}/pastas?q=${encodeURIComponent("Diária 'aspas")}&escopo=root`)
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.items.map(x => [x.id, x.path.join(' / ')]), [[alvo.id, 'Meu Drive / Rota SESI Nordeste Criativo']])
  r = await call('GET', `/api/drive/${acc()}/pastas?q=`)
  assert.deepEqual(r.json.items, [])
  r = await call('GET', `/api/drive/${acc()}/pastas?q=x&escopo=${encodeURIComponent("' or 1")}`)
  assert.equal(r.status, 400)
})

// ─────────── interface sem navegador (public/lib) ───────────

function memoryStore(init = {}) {
  const data = { ...init }
  return { data, get: (k, fb = null) => (k in data ? JSON.parse(JSON.stringify(data[k])) : fb), set: (k, v) => (v == null ? delete data[k] : (data[k] = JSON.parse(JSON.stringify(v)))) }
}

test('Recentes: as 5 últimas pastas de destino por conta, sem repetir, e onde o seletor abre', () => {
  const s = memoryStore()
  assert.deepEqual(recentes(s, 'nuvem:g1'), [])
  assert.equal(pastaInicial(s, 'nuvem:g1').id, 'root', 'sem nada: Meu Drive')
  s.set('drive.last', { accountId: 'nuvem:g1', id: 'abertaNoDrive', name: 'Diária 01', driveId: null })
  assert.equal(pastaInicial(s, 'nuvem:g1').id, 'abertaNoDrive', 'sem destino ainda: a última pasta aberta no Drive (mesma conta)')
  assert.equal(pastaInicial(s, 'nuvem:g2').id, 'root', 'drive.last de outra conta não vale')

  for (let i = 1; i <= 7; i++) lembrarDestino(s, 'nuvem:g1', { id: `p${i}`, name: `Pasta ${i}`, path: `Meu Drive / Pasta ${i}` }, 1000 + i)
  lembrarDestino(s, 'nuvem:g1', { id: 'p4', name: 'Pasta 4', path: 'Meu Drive / Pasta 4' }, 2000)
  const r = recentes(s, 'nuvem:g1')
  assert.equal(r.length, MAX_RECENTES)
  assert.deepEqual(r.map(x => x.id), ['p4', 'p7', 'p6', 'p5', 'p3'])
  assert.equal(pastaInicial(s, 'nuvem:g1').id, 'p4', 'abre no último destino')
  assert.deepEqual(recentes(s, 'nuvem:g2'), [], 'cada conta tem os seus')

  lembrarDestino(s, 'nuvem:g2', { id: 'sdroot', name: 'Acervo', driveId: '0AXRVw3t_EaWSQUk9PVA' })
  assert.deepEqual(recentes(s, 'nuvem:g2').map(x => [x.id, x.driveId]), [['sdroot', '0AXRVw3t_EaWSQUk9PVA']])

  // Lixo no armazenamento não quebra nem entra.
  lembrarDestino(s, 'nuvem:g1', { id: '../x', name: 'ruim' })
  lembrarDestino(s, 'nuvem:g1', { id: 'semNome' })
  assert.equal(recentes(s, 'nuvem:g1')[0].id, 'p4')
  s.set('drive.destinos', { 'nuvem:g1': 'não é lista' })
  assert.deepEqual(recentes(s, 'nuvem:g1'), [])

  lembrarDestino(s, 'nuvem:g1', { id: 'a', name: 'A' })
  lembrarDestino(s, 'nuvem:g1', { id: 'b', name: 'B' })
  assert.deepEqual(esquecerDestino(s, 'nuvem:g1', 'b').map(x => x.id), ['a'])
  assert.deepEqual(recentes(s, 'nuvem:g1').map(x => x.id), ['a'])
})

test('aviso do link: texto de quem abre, botão de liberar só quando dá e a frase da confirmação', () => {
  assert.equal(CONFIRMAR_LIBERAR, 'Qualquer pessoa com o link vai poder ver e baixar.')
  const restrito = avisoDoLink({ access: 'restrito', isFolder: true, canShare: true, podeLiberar: true })
  assert.equal(restrito.texto, 'Copiado. Só quem tem acesso a esta pasta consegue abrir.')
  assert.equal(restrito.liberar, true)
  assert.equal(avisoDoLink({ access: 'restrito', isFolder: false, podeLiberar: true }).texto, 'Copiado. Só quem tem acesso a este arquivo consegue abrir.')
  const publico = avisoDoLink({ access: 'qualquer', isFolder: true, podeLiberar: false })
  assert.equal(publico.tone, 'ok')
  assert.equal(publico.liberar, false)
  const dom = avisoDoLink({ access: 'dominio', domain: 'zrofilmes.com', isFolder: true, canShare: true, podeLiberar: true })
  assert.equal(dom.texto, 'Copiado. Só quem é de zrofilmes.com consegue abrir.')
  const sem = avisoDoLink({ access: 'restrito', isFolder: true, canShare: false, podeLiberar: false })
  assert.equal(sem.liberar, false)
  assert.match(sem.nota, /não pode mudar o compartilhamento/)
  assert.match(avisoDoLink({ access: 'restrito', root: true, sharedDrive: true, canShare: true, podeLiberar: false }).nota, /raiz de um drive compartilhado/)
  assert.equal(avisoDoLink(null).liberar, false)
  assert.equal(avisoDoLink({ access: 'desconhecido', podeLiberar: false }).liberar, false)
})

test('pasta do lote concluído: a pasta enviada inteira, senão o destino; nada para download', () => {
  const up = (relDir, extra = {}) => ({ type: 'upload', status: 'completed', accountId: 'nuvem:g1', target: { rootId: 'dest', relDir, driveId: null, parentId: relDir ? `id:${relDir}` : 'dest', ...extra } })
  assert.deepEqual(batchFolder([up('CAM_A'), up('CAM_A/Sub')], { destino: 'Diária 02' }), { id: 'id:CAM_A', name: 'CAM_A', driveId: null, accountId: 'nuvem:g1' })
  assert.deepEqual(batchFolder([up(''), up('')], { destino: 'Diária 02' }), { id: 'dest', name: 'Diária 02', driveId: null, accountId: 'nuvem:g1' })
  assert.deepEqual(batchFolder([up('CAM_A'), up('CAM_B')], { destino: 'Diária 02' }).id, 'dest', 'duas pastas: o destino')
  assert.equal(batchFolder([up('CAM_A'), up('', { rootId: 'outro' })]), null, 'destinos diferentes: sem link')
  assert.equal(batchFolder([{ type: 'download', status: 'completed', target: null }]), null)
  const raiz = batchFolder([{ type: 'upload', status: 'completed', accountId: 'a', target: { rootId: 'root', relDir: '', parentId: null } }])
  assert.deepEqual(raiz, { id: 'root', name: 'Meu Drive', driveId: null, accountId: 'a' })
})
