// Proteção do app de desktop (revisão de segurança A9): segredos com a guarda do sistema (src/util/segredos.js),
// o cofre do processo principal (desktop/cofre.js), os cookies antigos do navegador (desktop/cookies-cifrados.js),
// o QuickJS no lugar do Electron-como-Node (binarios.js) e o teste de fumaça (desktop/smoke.js). Tudo sem Electron:
// a guarda é a versão em memória.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ArquivoSecreto, caminhoCifrado, guardaEmMemoria, guardaPorMensagens } from '../src/util/segredos.js'
import { AuthManager } from '../src/google/oauth.js'
import { CloudAuth } from '../src/google/cloud-auth.js'
import { dataPaths } from '../src/config.js'
import { closeHttp } from '../src/net/http.js'
import { jsRuntimePadrao, quickjsCandidates } from '../src/referencias/binarios.js'
import { montarArgs } from '../src/referencias/ytdlp.js'
import { cofreDisponivel, responderCofre } from '../desktop/cofre.js'
import { marcarAvisado, migrarCookies, precisaAvisar } from '../desktop/cookies-cifrados.js'
import { relatorio, verificar } from '../desktop/smoke.js'
import { startApp } from '../src/index.js'
import { loginWithMock, makeTmpDir, waitFor } from './helpers.js'
import { startMockDrive } from './mock-drive.js'
import { startMockCloud } from './mock-cloud.js'

after(() => closeHttp())

const silencio = () => {}
const modo = async f => (await fs.stat(f)).mode & 0o777
const existe = f => fs.stat(f).then(() => true, () => false)

async function pasta(t) {
  const dir = await makeTmpDir('sobedesce-protecao-')
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

// ─────────── ArquivoSecreto ───────────

test('sem guarda: continua o JSON 0600 de sempre (npm start, testes, modo servidor)', async t => {
  const dir = await pasta(t)
  const file = path.join(dir, 'accounts.json')
  const arq = new ArquivoSecreto(file, { log: silencio })
  assert.equal(await arq.ler('nada'), 'nada')
  await arq.gravar({ token: 'segredo-1' })
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { token: 'segredo-1' })
  if (process.platform !== 'win32') assert.equal(await modo(file), 0o600)
  assert.equal(await existe(caminhoCifrado(file)), false)
  assert.deepEqual(await arq.ler(), { token: 'segredo-1' })
  assert.equal(await arq.protecao(), 'arquivo')
})

test('migração: o JSON antigo é lido, cifrado, conferido e apagado; o novo não tem o segredo em claro', async t => {
  const dir = await pasta(t)
  const file = path.join(dir, 'accounts.json')
  await fs.writeFile(file, JSON.stringify({ accounts: [{ id: '1', refreshToken: '1//segredo-antigo' }] }), { mode: 0o600 })
  const guarda = guardaEmMemoria()
  const logs = []
  const arq = new ArquivoSecreto(file, { guarda, log: (...a) => logs.push(a.join(' ')) })
  assert.deepEqual(await arq.ler(), { accounts: [{ id: '1', refreshToken: '1//segredo-antigo' }] })
  assert.equal(await existe(file), false, 'o JSON antigo foi apagado')
  const cifrado = caminhoCifrado(file)
  assert.equal(cifrado, path.join(dir, 'accounts.cifrado.json'))
  const bruto = await fs.readFile(cifrado, 'utf8')
  assert.doesNotMatch(bruto, /segredo-antigo|refreshToken/)
  if (process.platform !== 'win32') assert.equal(await modo(cifrado), 0o600)
  assert.equal(JSON.parse(bruto).guarda, 'memoria')
  assert.ok(logs.some(l => /migrado/.test(l)))
  assert.equal(await arq.protecao(), 'sistema')

  // Reabrir com a mesma chave: lê do cifrado. Gravar de novo: continua cifrado, sem recriar o JSON.
  const de_novo = new ArquivoSecreto(file, { guarda, log: silencio })
  assert.equal((await de_novo.ler()).accounts[0].refreshToken, '1//segredo-antigo')
  await de_novo.gravar({ accounts: [] })
  assert.equal(await existe(file), false)
  assert.deepEqual(await new ArquivoSecreto(file, { guarda, log: silencio }).ler(), { accounts: [] })

  await de_novo.apagar()
  assert.equal(await existe(cifrado), false)
})

test('sem safeStorage (Linux sem keyring): segue em JSON 0600 e avisa no log, sem apagar nada', async t => {
  const dir = await pasta(t)
  const file = path.join(dir, 'cloud.json')
  await fs.writeFile(file, JSON.stringify({ token: 'sdd_x' }), { mode: 0o600 })
  const arq = new ArquivoSecreto(file, { guarda: guardaEmMemoria({ disponivel: false }), log: silencio })
  assert.deepEqual(await arq.ler(), { token: 'sdd_x' })
  assert.equal(await existe(file), true)
  assert.equal(await existe(caminhoCifrado(file)), false)
  await arq.gravar({ token: 'sdd_y' })
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { token: 'sdd_y' })
  assert.equal(await arq.protecao(), 'arquivo')

  // A guarda que lança ao perguntar também conta como indisponível.
  const lanca = { nome: 'x', disponivel: () => Promise.reject(new Error('sem keyring')), cifrar: () => {}, decifrar: () => {} }
  assert.deepEqual(await new ArquivoSecreto(file, { guarda: lanca, log: silencio }).ler(), { token: 'sdd_y' })
})

test('dado corrompido: devolve o padrão, não apaga, e guarda uma cópia antes de gravar por cima', async t => {
  const dir = await pasta(t)
  const file = path.join(dir, 'accounts.json')
  const cifrado = caminhoCifrado(file)
  const guarda = guardaEmMemoria()

  // 1) envelope que nem é JSON
  await fs.writeFile(cifrado, 'lixo{{{', { mode: 0o600 })
  const arq = new ArquivoSecreto(file, { guarda, log: silencio })
  assert.equal(await arq.ler('padrão'), 'padrão')
  assert.equal(await fs.readFile(cifrado, 'utf8'), 'lixo{{{', 'o arquivo ficou onde estava')
  await arq.gravar({ accounts: ['nova'] })
  const irmaos = await fs.readdir(dir)
  assert.ok(irmaos.some(n => n.startsWith('accounts.cifrado.json.guardado-')), irmaos.join(','))
  assert.deepEqual(await new ArquivoSecreto(file, { guarda, log: silencio }).ler(), { accounts: ['nova'] })

  // 2) envelope certo, conteúdo adulterado (o GCM recusa)
  const env = JSON.parse(await fs.readFile(cifrado, 'utf8'))
  const b = Buffer.from(env.dados, 'base64')
  b[b.length - 1] ^= 0xff
  await fs.writeFile(cifrado, JSON.stringify({ ...env, dados: b.toString('base64') }))
  assert.equal(await new ArquivoSecreto(file, { guarda, log: silencio }).ler(null), null)
  assert.equal(await existe(cifrado), true)

  // 3) outra chave (outro computador, Keychain trocado) ou Keychain recusando: mesma coisa, nada some.
  await new ArquivoSecreto(file, { guarda, log: silencio }).gravar({ ok: 1 })
  assert.equal(await new ArquivoSecreto(file, { guarda: guardaEmMemoria(), log: silencio }).ler('x'), 'x')
  assert.equal(await new ArquivoSecreto(file, { guarda: guardaEmMemoria({ quebrada: true }), log: silencio }).ler('y'), 'y')
  assert.deepEqual(await new ArquivoSecreto(file, { guarda, log: silencio }).ler(), { ok: 1 }, 'com a chave certa, volta')
})

test('guarda quebrada ao cifrar: a migração não apaga o JSON antigo', async t => {
  const dir = await pasta(t)
  const file = path.join(dir, 'credentials.json')
  await fs.writeFile(file, JSON.stringify({ clientId: 'a', clientSecret: 'b' }))
  const arq = new ArquivoSecreto(file, { guarda: guardaEmMemoria({ quebrada: true }), log: silencio })
  assert.deepEqual(await arq.ler(), { clientId: 'a', clientSecret: 'b' })
  assert.equal(await existe(file), true)
  await arq.gravar({ clientId: 'c', clientSecret: 'd' })
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { clientId: 'c', clientSecret: 'd' })
  assert.equal(await existe(caminhoCifrado(file)), false)
})

test('queda no meio da migração e abertura sem a guarda: vale o mais novo e nada se perde', async t => {
  const dir = await pasta(t)
  const file = path.join(dir, 'accounts.json')
  const cifrado = caminhoCifrado(file)
  const guarda = guardaEmMemoria()
  // Queda depois de gravar o cifrado e antes de apagar o antigo: o cifrado é o mais novo.
  await fs.writeFile(file, JSON.stringify({ v: 'antigo' }))
  await new ArquivoSecreto(path.join(dir, 'outro.json'), { guarda, log: silencio }).gravar({})
  await new ArquivoSecreto(file, { guarda, log: silencio }).gravar({ v: 'cifrado' })
  await fs.writeFile(file, JSON.stringify({ v: 'antigo' }))
  const velho = new Date(Date.now() - 60_000)
  await fs.utimes(file, velho, velho)
  assert.deepEqual(await new ArquivoSecreto(file, { guarda, log: silencio }).ler(), { v: 'cifrado' })
  assert.equal(await existe(file), false, 'o resto antigo foi apagado')

  // Uma abertura sem a guarda gravou o JSON depois do cifrado: o JSON é o mais novo e vira o cifrado; o cifrado de
  // antes fica guardado ao lado.
  await new ArquivoSecreto(file, { guarda: guardaEmMemoria({ disponivel: false }), log: silencio }).gravar({ v: 'sem-guarda' })
  const futuro = new Date(Date.now() + 60_000)
  await fs.utimes(file, futuro, futuro)
  assert.deepEqual(await new ArquivoSecreto(file, { guarda, log: silencio }).ler(), { v: 'sem-guarda' })
  assert.equal(await existe(file), false)
  assert.ok((await fs.readdir(dir)).some(n => n.startsWith('accounts.cifrado.json.guardado-')))
  assert.deepEqual(await new ArquivoSecreto(file, { guarda, log: silencio }).ler(), { v: 'sem-guarda' })
  assert.equal(await existe(cifrado), true)
})

// ─────────── AuthManager e CloudAuth com a guarda ───────────

test('AuthManager: accounts.json e credentials.json de antes migram e as contas continuam funcionando', async t => {
  const home = await pasta(t)
  process.env.SOBEDESCE_HOME = home
  const mock = await startMockDrive()
  mock.applyEnv()
  t.after(() => mock.close())
  const paths = dataPaths(home)

  // Versão anterior do app: tudo em texto.
  const antes = new AuthManager({ paths })
  await antes.init()
  await antes.setClientCredentials(mock.client)
  const conta = await loginWithMock(antes)
  const refresh = JSON.parse(await fs.readFile(paths.accounts, 'utf8')).accounts[0].refreshToken
  assert.match(refresh, /^1\/\/mock-/)

  // Versão nova, com a guarda: migra na primeira abertura.
  const guarda = guardaEmMemoria()
  const auth = new AuthManager({ paths, segredos: guarda })
  await auth.init()
  assert.deepEqual(auth.listAccounts().map(a => a.id), [conta.id])
  assert.equal(auth.hasClientCredentials(), true)
  assert.equal(await existe(paths.accounts), false)
  assert.equal(await existe(paths.credentials), false)
  for (const f of [caminhoCifrado(paths.accounts), caminhoCifrado(paths.credentials)]) {
    const bruto = await fs.readFile(f, 'utf8')
    assert.doesNotMatch(bruto, /1\/\/mock-|clientSecret|refreshToken/, f)
  }
  // O refresh token decifrado ainda vale: pega um access token novo no Google falso.
  assert.match(await auth.getAccessToken(conta.id, { forceRefresh: true }), /\S/)

  // Conta nova depois da migração também vai cifrada.
  await auth.removeAccount(conta.id)
  assert.deepEqual(auth.listAccounts(), [])
  const outra = new AuthManager({ paths, segredos: guarda })
  await outra.init()
  assert.deepEqual(outra.listAccounts(), [])
  assert.equal(await existe(paths.accounts), false)
})

test('CloudAuth: a sessão da conta SOBEDESCE vai cifrada, reabre e some ao sair', async t => {
  const home = await pasta(t)
  const site = await startMockCloud()
  t.after(() => site.close().catch(() => {}))
  const paths = dataPaths(home)
  const FAST = { pollMs: 20, retryBaseMs: 5, refreshEveryMs: 0, deviceName: 'Mac', platform: 'darwin', log: silencio }
  const guarda = guardaEmMemoria()

  const cloud = new CloudAuth({ paths, baseUrl: site.url, segredos: guarda, ...FAST })
  await cloud.init()
  const login = await cloud.beginLogin()
  site.approve(login.codigo)
  const ate = Date.now() + 5000
  while (cloud.status().login.estado !== 'pronto' && Date.now() < ate) await new Promise(r => setTimeout(r, 20))
  assert.equal(cloud.status().conectado, true)
  // "pronto" aparece antes da sessão ser gravada (a tela confirma na hora): espera o arquivo cifrado.
  await waitFor(() => existe(caminhoCifrado(paths.cloud)), { message: 'a sessão cifrada não foi gravada' })
  cloud.close()
  assert.equal(await existe(paths.cloud), false)
  const bruto = await fs.readFile(caminhoCifrado(paths.cloud), 'utf8')
  assert.doesNotMatch(bruto, /sdd_/)

  const again = new CloudAuth({ paths, baseUrl: site.url, segredos: guarda, ...FAST })
  await again.init()
  assert.equal(again.status().conectado, true)
  await again.signOut()
  again.close()
  assert.equal(await existe(caminhoCifrado(paths.cloud)), false)
  assert.equal(await existe(paths.cloud), false)
})

// ─────────── cofre do processo principal ───────────

function safeStorageFalso({ disponivel = true, backend = 'gnome_libsecret', quebra = false } = {}) {
  return {
    isEncryptionAvailable: () => disponivel,
    getSelectedStorageBackend: () => backend,
    encryptString: s => {
      if (quebra) throw new Error('keychain')
      return Buffer.from(`X${Buffer.from(s, 'utf8').toString('hex')}`)
    },
    decryptString: b => {
      if (quebra) throw new Error('keychain')
      const t = Buffer.from(b).toString()
      if (!t.startsWith('X')) throw new Error('lixo')
      return Buffer.from(t.slice(1), 'hex').toString('utf8')
    },
  }
}

test('cofre (processo principal): estado, cifrar/decifrar, basic_text do Linux não conta, erro sem vazar texto', () => {
  const ss = safeStorageFalso()
  assert.equal(cofreDisponivel(ss, 'darwin'), true)
  assert.equal(cofreDisponivel(safeStorageFalso({ backend: 'basic_text' }), 'linux'), false)
  assert.equal(cofreDisponivel(safeStorageFalso({ backend: 'basic_text' }), 'win32'), true)
  assert.equal(cofreDisponivel(safeStorageFalso({ disponivel: false }), 'win32'), false)
  assert.equal(cofreDisponivel({ isEncryptionAvailable: () => { throw new Error('antes do ready') } }), false)

  assert.deepEqual(responderCofre(ss, { id: 1, op: 'estado' }, { platform: 'darwin' }), { type: 'cofre-resposta', id: 1, ok: true, disponivel: true })
  const c = responderCofre(ss, { id: 2, op: 'cifrar', dados: Buffer.from('olá').toString('base64') }, { platform: 'darwin' })
  assert.equal(c.ok, true)
  const d = responderCofre(ss, { id: 3, op: 'decifrar', dados: c.dados }, { platform: 'darwin' })
  assert.equal(Buffer.from(d.dados, 'base64').toString('utf8'), 'olá')

  const r = responderCofre(ss, { id: 4, op: 'decifrar', dados: Buffer.from('não é meu').toString('base64') }, { platform: 'darwin' })
  assert.deepEqual(r, { type: 'cofre-resposta', id: 4, ok: false, erro: 'não deu para decifrar' })
  assert.equal(responderCofre(safeStorageFalso({ quebra: true }), { id: 5, op: 'cifrar', dados: 'eA==' }, { platform: 'darwin' }).ok, false)
  assert.equal(responderCofre(safeStorageFalso({ disponivel: false }), { id: 6, op: 'cifrar', dados: 'eA==' }, { platform: 'darwin' }).ok, false)
  assert.equal(responderCofre(ss, { id: 7, op: 'apagar-tudo', dados: 'eA==' }, { platform: 'darwin' }).ok, false)
  assert.equal(responderCofre(ss, { id: 8, op: 'cifrar', dados: 42 }, { platform: 'darwin' }).ok, false)
})

test('guarda por mensagens (motor ⇄ processo principal) com ArquivoSecreto de ponta a ponta', async t => {
  const dir = await pasta(t)
  const ss = safeStorageFalso()
  let guarda = null
  // "Processo principal": responde no próximo tique, como o postMessage.
  guarda = guardaPorMensagens(msg => setImmediate(() => guarda.receber(responderCofre(ss, msg, { platform: 'darwin' }))))
  assert.equal(await guarda.disponivel(), true)
  assert.equal(await guarda.decifrar(await guarda.cifrar('ação ✓')), 'ação ✓')

  const file = path.join(dir, 'cloud.json')
  await fs.writeFile(file, JSON.stringify({ token: 'sdd_abc' }))
  assert.deepEqual(await new ArquivoSecreto(file, { guarda, log: silencio }).ler(), { token: 'sdd_abc' })
  assert.equal(await existe(file), false)

  // Ninguém responde: vira indisponível depois do tempo, sem travar o motor.
  const muda = guardaPorMensagens(() => {}, { timeoutMs: 30 })
  assert.equal(await muda.disponivel(), false)
  await assert.rejects(muda.cifrar('x'), /não respondeu/)
  // Processo principal sem cofre (Linux sem keyring): indisponível.
  let semCofre = null
  semCofre = guardaPorMensagens(msg => setImmediate(() => semCofre.receber(responderCofre(safeStorageFalso({ backend: 'basic_text' }), msg, { platform: 'linux' }))))
  assert.equal(await semCofre.disponivel(), false)
})

// ─────────── cookies do navegador ───────────

test('cookies antigos do navegador: apagados uma vez no app com o fusível, com aviso único', async t => {
  const userData = await pasta(t)
  const net = path.join(userData, 'Partitions', 'navegador', 'Network')
  await fs.mkdir(net, { recursive: true })
  await fs.writeFile(path.join(net, 'Cookies'), 'sessionid=texto-puro')
  await fs.writeFile(path.join(net, 'Cookies-journal'), '')
  await fs.writeFile(path.join(userData, 'Partitions', 'navegador', 'Preferences'), '{}')

  // Desenvolvimento (Electron sem o fusível): nada muda.
  assert.deepEqual(migrarCookies({ userData, ligado: false }), { apagou: false })
  assert.equal(await existe(path.join(net, 'Cookies')), true)

  assert.deepEqual(migrarCookies({ userData, ligado: true }), { apagou: true })
  assert.equal(await existe(path.join(net, 'Cookies')), false)
  assert.equal(await existe(path.join(net, 'Cookies-journal')), false)
  assert.equal(await existe(path.join(userData, 'Partitions', 'navegador', 'Preferences')), true, 'só os cookies')
  assert.equal(precisaAvisar(userData), true)
  marcarAvisado(userData)
  assert.equal(precisaAvisar(userData), false)

  // Cookies novos (já cifrados) nunca mais são apagados.
  await fs.writeFile(path.join(net, 'Cookies'), 'cifrado')
  assert.deepEqual(migrarCookies({ userData, ligado: true }), { apagou: false })
  assert.equal(await existe(path.join(net, 'Cookies')), true)

  // Instalação nova (sem cookies): sem aviso.
  const novo = await pasta(t)
  assert.deepEqual(migrarCookies({ userData: novo, ligado: true }), { apagou: false })
  assert.equal(precisaAvisar(novo), false)
})

// ─────────── QuickJS no lugar do Electron-como-Node ───────────

test('yt-dlp: Node fora do Electron, QuickJS do app dentro dele, nunca ELECTRON_RUN_AS_NODE', () => {
  assert.deepEqual(jsRuntimePadrao({ electron: false, execPath: '/usr/bin/node' }), { nome: 'node', path: '/usr/bin/node', env: {} })
  assert.equal(jsRuntimePadrao({ electron: true, candidatos: [{ path: '/nao/existe/qjs', origem: 'app' }] }), null)
  const qjs = jsRuntimePadrao({ electron: true, candidatos: [{ path: process.execPath, origem: 'app' }] })
  assert.deepEqual(qjs, { nome: 'quickjs', path: process.execPath, env: {} })
  assert.ok(!JSON.stringify(qjs).includes('ELECTRON_RUN_AS_NODE'))
  const args = montarArgs({ url: 'https://www.youtube.com/watch?v=x', workDir: '/tmp/w', jsRuntime: { nome: 'quickjs', path: '/R/quickjs/qjs' } })
  assert.equal(args[args.indexOf('--js-runtimes') + 1], 'quickjs:/R/quickjs/qjs')

  const mac = quickjsCandidates({ env: { SOBEDESCE_QJS: '/x/qjs' }, platform: 'darwin', arch: 'arm64', resourcesPath: '/A.app/Contents/Resources', appRoot: '/A.app/Contents/Resources/app.asar' })
  assert.deepEqual(mac.map(c => c.path), ['/x/qjs', '/A.app/Contents/Resources/quickjs/qjs', '/A.app/Contents/Resources/app.asar/build/quickjs/mac-arm64/qjs'])
  const win = quickjsCandidates({ env: {}, platform: 'win32', arch: 'arm64', resourcesPath: 'C:\\SD\\resources', appRoot: 'C:\\SD\\resources\\app.asar' })
  assert.equal(win[0].path, 'C:\\SD\\resources\\quickjs\\qjs.exe')
  assert.ok(win.some(c => c.path.endsWith('build\\quickjs\\win-arm64\\qjs.exe')))
})

test('electron-builder: asar, fusíveis e o QuickJS no pacote; o yt-dlp não depende mais do RunAsNode', async () => {
  const yml = await fs.readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  assert.match(yml, /^asar: true$/m)
  for (const f of ['runAsNode: false', 'enableCookieEncryption: true', 'enableNodeOptionsEnvironmentVariable: false', 'enableNodeCliInspectArguments: false', 'enableEmbeddedAsarIntegrityValidation: true', 'onlyLoadAppFromAsar: true']) {
    assert.match(yml, new RegExp(`^  ${f}$`, 'm'), f)
  }
  assert.match(yml, /from: build\/quickjs\/\$\{os\}-\$\{arch\}\n\s+to: quickjs/)
  const servico = await fs.readFile(new URL('../src/referencias/service.js', import.meta.url), 'utf8')
  assert.doesNotMatch(servico, /ELECTRON_RUN_AS_NODE/)
  const wf = await fs.readFile(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8')
  assert.match(wf, /--smoke/)
  assert.match(wf, /quickjs-baixar\.mjs/)
  for (const m of wf.matchAll(/uses: ([^\s]+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `action fixada por SHA: ${m[1]}`)
})

// ─────────── teste de fumaça (sem Electron) ───────────

test('smoke: o motor de verdade sobe e as verificações passam (binários e cofre como aviso fora do app)', async t => {
  const home = await pasta(t)
  const app = await startApp({ home, port: 0, open: false, quiet: true, segredos: guardaEmMemoria(), serverOptions: { log: silencio }, managerOptions: { keepAwake: { active: false, setActive() {}, stop() {} } }, referenciasOptions: { updater: null, autoStart: false, log: silencio } })
  t.after(() => app.shutdown())
  const env = { PATH: '' }
  const checks = await verificar({ app, guarda: guardaEmMemoria(), env, resourcesPath: path.join(home, 'nada') })
  const por = Object.fromEntries(checks.map(c => [c.nome, c]))
  for (const n of ['motor', 'interface', 'app do celular', 'md5 (worker)', 'cofre']) assert.equal(por[n].ok && !por[n].aviso, true, `${n}: ${por[n].detalhe}`)
  assert.equal(por.ffmpeg.aviso, true)
  const r = relatorio(checks)
  assert.equal(r.ok, true)
  assert.match(r.texto, /SMOKE OK$/)

  // No app empacotado do Mac/Windows, faltar binário ou cofre é falha.
  const exigindo = await verificar({ app, guarda: guardaEmMemoria({ disponivel: false }), exigirBinarios: true, exigirCofre: true, env, platform: 'darwin', arch: 'arm64', resourcesPath: path.join(home, 'nada') })
  const falhas = exigindo.filter(c => !c.ok).map(c => c.nome).sort()
  assert.deepEqual(falhas, ['cofre', 'ffmpeg', 'quickjs', 'yt-dlp'])
  assert.match(relatorio(exigindo).texto, /SMOKE FALHOU$/)
})
