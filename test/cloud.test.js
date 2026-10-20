// Conta SOBEDESCE no computador (src/google/cloud-auth.js) contra o site falso (test/mock-cloud.js) e o Drive falso:
// fluxo de dispositivo, token guardado (0600) e reaproveitado ao reabrir, cache e uma requisição por conta, rede fora
// (retry), 401 da nuvem (sai da conta), sair, contas mescladas no AuthManager e renovação depois de 401 do Google.
// O app inteiro (rotas, transferências, 409 reconectar) fica em cloud-app.test.js.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { CloudAuth, platformName } from '../src/google/cloud-auth.js'
import { AuthManager } from '../src/google/oauth.js'
import { DriveClient } from '../src/google/drive.js'
import { dataPaths, validateSettings, DEFAULT_SETTINGS } from '../src/config.js'
import { closeHttp } from '../src/net/http.js'
import { setupDrive, makeTmpDir, waitFor } from './helpers.js'
import { startMockCloud } from './mock-cloud.js'

const FAST = { pollMs: 20, retryBaseMs: 5, refreshEveryMs: 0, deviceName: 'MacBook de Teste', platform: 'darwin' }

after(() => closeHttp())

/** Entra pelo fluxo de dispositivo: começa, o "navegador" aprova, espera ficar pronto. */
async function signIn(cloudAuth, site) {
  const login = await cloudAuth.beginLogin()
  assert.equal(login.estado, 'pendente')
  assert.match(login.codigo, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  site.approve(login.codigo)
  await waitFor(() => cloudAuth.status().login.estado === 'pronto', { timeoutMs: 5000, message: 'o login não terminou' })
  await waitFor(() => cloudAuth.listAccounts().length > 0, { message: 'as contas da nuvem não apareceram' })
  return login
}

// ─────────── CloudAuth sozinho ───────────

test('fluxo de dispositivo completo: código, aprovação, token guardado com 0600 e reaproveitado ao reabrir', async t => {
  const home = await makeTmpDir()
  const site = await startMockCloud()
  t.after(async () => {
    await site.close().catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  })
  const paths = dataPaths(home)
  const cloud = new CloudAuth({ paths, baseUrl: site.url, build: 163, ...FAST })
  await cloud.init()
  assert.equal(cloud.status().conectado, false)
  assert.deepEqual(cloud.listAccounts(), [])

  const statuses = []
  cloud.on('status', s => statuses.push(s))
  const accountsEvents = []
  cloud.on('accounts', list => accountsEvents.push(list))

  const login = await cloud.beginLogin()
  assert.equal(login.estado, 'pendente')
  assert.ok(login.url.startsWith(`${site.url}/dispositivo?codigo=`), 'URL para abrir no navegador')
  assert.ok(login.expiraEm > Date.now())
  // Nada de segredo na tela.
  assert.ok(!JSON.stringify(cloud.status()).includes('segredo'))
  const sent = [...site.codes.values()][0]
  assert.equal(sent.nome, 'MacBook de Teste')
  assert.equal(sent.plataforma, 'mac')

  // Esperando: o site responde 202 algumas vezes.
  await waitFor(() => site.stats.aguardar >= 2)
  assert.equal(cloud.status().login.estado, 'pendente')
  site.approve(login.codigo)
  await waitFor(() => cloud.status().login.estado === 'pronto', { message: 'não ficou pronto' })
  await waitFor(() => cloud.listAccounts().length === 2)

  const st = cloud.status()
  assert.equal(st.conectado, true)
  assert.equal(st.usuario.email, 'ana@sobedesce.app')
  assert.deepEqual(st.contas.map(c => [c.id, c.status, c.source]), [['nuvem:g1', 'ok', 'nuvem'], ['nuvem:g2', 'ok', 'nuvem']])
  // A lista muda antes de o aviso sair (o app grava em disco entre os dois): espera o aviso.
  await waitFor(() => accountsEvents.length >= 1, { message: 'evento accounts ao entrar' })
  assert.ok(statuses.some(s => s.login.estado === 'pronto'))

  // Arquivo do token: 0600, com o token do dispositivo; nada de token na tela.
  const stat = await fs.stat(paths.cloud)
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600)
  const saved = JSON.parse(await fs.readFile(paths.cloud, 'utf8'))
  assert.match(saved.token, /^sdd_/)
  assert.equal(saved.servidor, site.url)
  assert.ok(!JSON.stringify(st).includes(saved.token))
  cloud.close()

  // Reabrir (mesmo com o site fora do ar): a sessão e a última lista continuam.
  site.down = true
  const again = new CloudAuth({ paths, baseUrl: site.url, ...FAST })
  await again.init()
  assert.equal(again.status().conectado, true)
  assert.deepEqual(again.listAccounts().map(a => a.id), ['nuvem:g1', 'nuvem:g2'])
  await waitFor(() => again.status().erro, { message: 'sem internet devia aparecer como erro da lista' })
  assert.equal(again.listAccounts().length, 2, 'sem internet a lista fica')
  site.down = false
  const iniciarAntes = site.stats.iniciar
  assert.match(await again.getAccessToken('g1'), /^ya29\./, 'o token guardado vale depois de reabrir')
  assert.equal(site.stats.iniciar, iniciarAntes, 'não pediu login de novo')
  again.close()
  // O build do app vai em todo pedido (o admin vê a versão de cada computador); sem build informado, o do app.
  assert.ok(site.builds.length > 0)
  assert.ok(site.builds.includes('163'), 'o build informado foi junto')
  assert.ok(site.builds.every(b => /^\d+$/.test(b ?? '')), 'nenhum pedido sem o cabeçalho')

  // Outro servidor (SOBEDESCE_CLOUD_URL diferente): o token não vale lá.
  const other = new CloudAuth({ paths, baseUrl: 'http://127.0.0.1:9', ...FAST })
  await other.init()
  assert.equal(other.status().conectado, false)
  other.close()
})

test('código vencido e cancelar o login', async t => {
  const home = await makeTmpDir()
  const site = await startMockCloud()
  t.after(async () => {
    await site.close()
    await fs.rm(home, { recursive: true, force: true })
  })
  const cloud = new CloudAuth({ paths: dataPaths(home), baseUrl: site.url, ...FAST })
  await cloud.init()
  const login = await cloud.beginLogin()
  site.expire(login.codigo)
  await waitFor(() => cloud.status().login.estado === 'expirado')
  assert.match(cloud.status().login.mensagem, /venceu/)

  await cloud.beginLogin()
  assert.equal(cloud.status().login.estado, 'pendente')
  cloud.cancelLogin()
  assert.equal(cloud.status().login.estado, 'nenhum')
  const n = site.stats.aguardar
  await new Promise(r => setTimeout(r, 120))
  assert.ok(site.stats.aguardar <= n + 1, 'parou de consultar')
  cloud.close()
})

test('"Pronto. Seus Drives apareceram aqui." some sozinho: o login volta a "nenhum" depois de mostrado', async t => {
  const home = await makeTmpDir()
  const site = await startMockCloud()
  t.after(async () => {
    await site.close().catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  })
  const cloud = new CloudAuth({ paths: dataPaths(home), baseUrl: site.url, ...FAST, readyShownMs: 150 })
  await cloud.init()
  const statuses = []
  cloud.on('status', s => statuses.push(s.login.estado))
  await signIn(cloud, site)
  assert.equal(cloud.status().login.estado, 'pronto')
  await waitFor(() => cloud.status().login.estado === 'nenhum', { message: 'o "pronto" não sumiu' })
  assert.equal(statuses.at(-1), 'nenhum', 'a interface fica sabendo (evento status)')
  assert.equal(cloud.status().conectado, true, 'continua na conta')
  assert.equal(cloud.listAccounts().length, 2)
  cloud.close()
})

test('tokens: cache, uma requisição por vez por conta, rede fora → retry, 401 da nuvem → sai da conta', async t => {
  const home = await makeTmpDir()
  const site = await startMockCloud()
  t.after(async () => {
    await site.close().catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  })
  const paths = dataPaths(home)
  const cloud = new CloudAuth({ paths, baseUrl: site.url, ...FAST })
  await cloud.init()
  await signIn(cloud, site)

  const [a, b, c] = await Promise.all([cloud.getAccessToken('g1'), cloud.getAccessToken('g1'), cloud.getAccessToken('g1')])
  assert.equal(a, b)
  assert.equal(b, c)
  assert.equal(site.stats.token, 1, 'uma requisição só para três pedidos simultâneos')
  assert.equal(await cloud.getAccessToken('g1'), a, 'cache')
  assert.equal(site.stats.token, 1)

  // Google recusou o token: renovar: true; outro pedido com o mesmo token recusado aproveita o novo.
  const renewed = await cloud.getAccessToken('g1', { forceRefresh: true, rejectedToken: a })
  assert.notEqual(renewed, a)
  assert.equal(site.stats.renovar, 1)
  assert.equal(await cloud.getAccessToken('g1', { forceRefresh: true, rejectedToken: a }), renewed)
  assert.equal(site.stats.renovar, 1)

  // Rede fora: 'retry' (o motor espera e tenta de novo), nada de sair da conta.
  site.down = true
  await assert.rejects(cloud.getAccessToken('g2'), err => err.name === 'SobeDesceError' && err.kind === 'retry')
  // Uma atualização que começou antes da rede cair (a do login) pode ainda estar no ar: refresh() espera por ela
  // e devolve o estado dela. A segunda chamada já vai ao site fora do ar.
  await cloud.refresh()
  const st = await cloud.refresh()
  assert.equal(st.conectado, true)
  assert.match(st.erro, /Sem conexão/)
  assert.equal(st.contas.length, 2)
  await assert.rejects(cloud.beginLogin(), err => err.kind === 'retry')
  site.down = false

  // Conta que saiu do site: 'reauth' com mensagem.
  site.contas = site.contas.filter(x => x.id !== 'g2')
  await assert.rejects(cloud.getAccessToken('g2'), err => err.kind === 'reauth' && /saiu da sua conta/.test(err.message))
  await waitFor(() => cloud.listAccounts().length === 1, { message: 'a lista devia ser atualizada' })

  // Sessão revogada no site: 401 → sai da conta, apaga o arquivo e avisa.
  const out = []
  cloud.on('signedOut', e => out.push(e))
  site.revokeSessions()
  cloud.tokens.clear()
  await assert.rejects(cloud.getAccessToken('g1'), err => err.kind === 'reauth' && err.reason === 'cloudSignedOut')
  assert.equal(cloud.status().conectado, false)
  assert.match(cloud.status().aviso, /sessão na conta SOBEDESCE terminou/)
  assert.deepEqual(cloud.listAccounts(), [])
  assert.equal(out.length, 1)
  await assert.rejects(fs.stat(paths.cloud), { code: 'ENOENT' })
  cloud.close()
})

test('sair da conta: avisa o site, apaga o token; sem internet sai do mesmo jeito', async t => {
  const home = await makeTmpDir()
  const site = await startMockCloud()
  t.after(async () => {
    await site.close().catch(() => {})
    await fs.rm(home, { recursive: true, force: true })
  })
  const paths = dataPaths(home)
  const cloud = new CloudAuth({ paths, baseUrl: site.url, ...FAST })
  await cloud.init()
  await signIn(cloud, site)
  assert.equal(site.activeSessions().length, 1)
  const st = await cloud.signOut()
  assert.equal(st.conectado, false)
  assert.equal(st.aviso, null)
  assert.equal(site.stats.sair, 1)
  assert.equal(site.activeSessions().length, 0)
  await assert.rejects(fs.stat(paths.cloud), { code: 'ENOENT' })
  await assert.rejects(cloud.getAccessToken('g1'), err => err.kind === 'reauth')

  await signIn(cloud, site)
  site.down = true
  assert.equal((await cloud.signOut()).conectado, false)
  await assert.rejects(fs.stat(paths.cloud), { code: 'ENOENT' })
  cloud.close()
})

test('AuthManager: contas locais e da nuvem juntas; tokens da nuvem; DriveClient renova depois de 401 do Google', async t => {
  const env = await setupDrive()
  const site = await startMockCloud({ drive: env.mock })
  t.after(async () => {
    await site.close()
    await env.cleanup()
  })
  const cloud = new CloudAuth({ paths: env.paths, baseUrl: site.url, ...FAST })
  const auth = new AuthManager({ paths: env.paths, cloud })
  await auth.init()
  assert.deepEqual(auth.listAccounts().map(a => [a.id, a.source]), [[env.accountId, 'local']])

  const events = []
  auth.on('accounts', list => events.push(list))
  await signIn(cloud, site)
  await waitFor(() => events.some(list => list.length === 3))
  const list = auth.listAccounts()
  assert.deepEqual(list.map(a => a.source), ['local', 'nuvem', 'nuvem'])
  assert.deepEqual(list.slice(1).map(a => a.id), ['nuvem:g1', 'nuvem:g2'])
  assert.equal(list[1].email, 'ana.montadora@gmail.com')
  assert.ok(!JSON.stringify(list).includes('sdd_'))

  // A conta local continua com o OAuth dela.
  assert.match(await auth.getAccessToken(env.accountId), /^ya29\./)
  const before = site.stats.token
  const nuvem = new DriveClient(auth, 'nuvem:g1')
  const about = await nuvem.about()
  assert.equal(about.user.email, env.mock.user.emailAddress)
  assert.equal(site.stats.token, before + 1, 'o token da conta nuvem veio do site')

  // Google recusou (401): o DriveClient pede de novo com renovar: true e segue.
  env.mock.expireAccessTokens()
  const items = await nuvem.listChildren('root')
  assert.ok(Array.isArray(items))
  assert.equal(site.stats.renovar, 1)

  // Conta da nuvem não se remove pelo app.
  await assert.rejects(auth.removeAccount('nuvem:g1'), /sobedesce\.com\/conta/)
  // Sem conta SOBEDESCE: id nuvem: pede para entrar.
  const solo = new AuthManager({ paths: env.paths })
  await solo.init()
  await assert.rejects(solo.getAccessToken('nuvem:g1'), err => err.kind === 'reauth')
  // Ajuste do celular aceita conta da nuvem.
  assert.equal(validateSettings({ mobileAccountId: 'nuvem:g1' }, DEFAULT_SETTINGS).mobileAccountId, 'nuvem:g1')
  assert.equal(platformName('win32'), 'windows')
  assert.equal(platformName('linux'), 'linux')
  auth.close()
})
