// AuthManager: login OAuth (loopback + PKCE), cache e renovação de tokens, reconexão e remoção de contas.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import { request } from 'undici'
import { startMockDrive } from './mock-drive.js'
import { makeTmpDir, authorizeInMock, loginWithMock, REDIRECT_URI } from './helpers.js'
import { AuthManager, parseClientCredentials } from '../src/google/oauth.js'
import { DriveClient } from '../src/google/drive.js'
import { dataPaths, DRIVE_SCOPE } from '../src/config.js'
import { closeHttp, dispatcherFor } from '../src/net/http.js'
import { classifyError } from '../src/google/errors.js'

const DAY = 86_400_000

after(() => closeHttp())

/** Mock + SOBEDESCE_HOME novo + AuthManager iniciado (sem credenciais, sem conta). */
async function freshAuth(t, mockOptions = {}) {
  const home = await makeTmpDir()
  process.env.SOBEDESCE_HOME = home
  const mock = await startMockDrive(mockOptions)
  mock.applyEnv()
  t.after(async () => {
    await mock.close()
    await fs.rm(home, { recursive: true, force: true })
  })
  const paths = dataPaths(home)
  const auth = new AuthManager({ paths })
  await auth.init()
  return { mock, home, paths, auth }
}

async function loggedIn(t, mockOptions = {}) {
  const ctx = await freshAuth(t, mockOptions)
  await ctx.auth.setClientCredentials(ctx.mock.client)
  const account = await loginWithMock(ctx.auth)
  return { ...ctx, account, accountId: account.id }
}

async function fileMode(file) {
  return (await fs.stat(file)).mode & 0o777
}

function collect(emitter, event) {
  const seen = []
  emitter.on(event, payload => seen.push(payload))
  return seen
}

/** Servidor de token falso que falha `failures` vezes com 503 antes de responder. */
async function startTokenStub(t, { failures = 0 } = {}) {
  const stub = { count: 0, bodies: [], failures }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      stub.count++
      stub.bodies.push(new URLSearchParams(raw))
      if (stub.count <= stub.failures) {
        res.writeHead(503, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'temporarily_unavailable', error_description: 'Try again later' }))
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ access_token: `ya29.stub-${stub.count}`, expires_in: 3600, scope: DRIVE_SCOPE, token_type: 'Bearer' }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  stub.url = `http://127.0.0.1:${server.address().port}/token`
  stub.close = () => new Promise(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  t.after(stub.close)
  return stub
}

test('credenciais: aceita JSON do Console, texto JSON e { clientId, clientSecret }; recusa o que não serve', async t => {
  const { auth, mock, paths } = await freshAuth(t)
  const { clientId, clientSecret } = mock.client

  assert.equal(auth.hasClientCredentials(), false)
  assert.deepEqual(auth.getClientInfo(), { configured: false, clientIdHint: null })
  assert.throws(() => auth.beginLogin(REDIRECT_URI), /Configure a chave do Google/)

  await assert.rejects(auth.setClientCredentials({ web: { client_id: clientId, client_secret: clientSecret } }), {
    message: 'Este é um cliente do tipo Aplicativo Web; crie um do tipo "App para computador".',
  })
  await assert.rejects(auth.setClientCredentials({ installed: { client_id: clientId, client_secret: '' } }), /segredo do cliente/)
  await assert.rejects(auth.setClientCredentials({ installed: { client_id: clientId } }), /segredo do cliente/)
  await assert.rejects(auth.setClientCredentials({ clientId: '1234-abc', clientSecret: 'x' }), /\.apps\.googleusercontent\.com/)
  await assert.rejects(auth.setClientCredentials({ clientId: '.apps.googleusercontent.com', clientSecret: 'x' }), /\.apps\.googleusercontent\.com/)
  await assert.rejects(auth.setClientCredentials('{isso não é json'), /JSON/)
  await assert.rejects(auth.setClientCredentials(''), /JSON/)
  await assert.rejects(auth.setClientCredentials(null), /Client ID/)
  assert.equal(auth.hasClientCredentials(), false, 'nada inválido pode ficar salvo')
  await assert.rejects(fs.stat(paths.credentials), { code: 'ENOENT' })

  // Texto colado do arquivo baixado do Console (com espaços em volta).
  const consoleJson = { installed: { client_id: clientId, project_id: 'sobedesce-123', auth_uri: 'https://accounts.google.com/o/oauth2/auth', client_secret: clientSecret, redirect_uris: ['http://localhost'] } }
  const info = await auth.setClientCredentials(`  ${JSON.stringify(consoleJson)}\n`)
  assert.deepEqual(info, { configured: true, clientIdHint: `${clientId.slice(0, 4)}…apps.googleusercontent.com` })
  assert.equal(auth.hasClientCredentials(), true)
  assert.equal(await fileMode(paths.credentials), 0o600)
  assert.deepEqual(JSON.parse(await fs.readFile(paths.credentials, 'utf8')), { clientId, clientSecret })

  // Objeto do Console e { clientId, clientSecret } também servem.
  assert.deepEqual(parseClientCredentials(consoleJson), { clientId, clientSecret })
  assert.deepEqual(parseClientCredentials({ clientId: ` ${clientId} `, clientSecret }), { clientId, clientSecret })
  await auth.setClientCredentials({ clientId, clientSecret })

  // Outro processo (reabrir o app) enxerga a chave salva.
  const again = new AuthManager({ paths })
  await again.init()
  assert.equal(again.hasClientCredentials(), true)
  assert.equal(again.getClientInfo().clientIdHint, info.clientIdHint)
})

test('login: PKCE S256 + state + offline/consent; conta salva em accounts.json (0600) sem expor tokens', async t => {
  const { auth, mock, paths } = await freshAuth(t)
  await auth.setClientCredentials(mock.client)
  const events = collect(auth, 'accounts')

  const first = auth.beginLogin(REDIRECT_URI)
  const second = auth.beginLogin(REDIRECT_URI)
  const u = new URL(first.url)
  const p = u.searchParams
  assert.equal(`${u.origin}${u.pathname}`, mock.env.SOBEDESCE_OAUTH_AUTH)
  assert.equal(p.get('client_id'), mock.client.clientId)
  assert.equal(p.get('redirect_uri'), REDIRECT_URI)
  assert.equal(p.get('response_type'), 'code')
  assert.equal(p.get('scope'), DRIVE_SCOPE)
  assert.equal(p.get('code_challenge_method'), 'S256')
  assert.match(p.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/)
  assert.equal(p.get('access_type'), 'offline')
  assert.equal(p.get('prompt'), 'consent')
  assert.equal(p.get('include_granted_scopes'), null)
  assert.equal(p.get('state'), first.state)
  assert.ok(first.state.length >= 22)
  assert.notEqual(first.state, second.state)
  assert.notEqual(p.get('code_challenge'), new URL(second.url).searchParams.get('code_challenge'))

  // Segue o consentimento do mock à mão (302 para o redirect_uri com code e state).
  const res = await request(first.url, { dispatcher: dispatcherFor(first.url) })
  await res.body.dump()
  assert.equal(res.statusCode, 302)
  const back = new URL(res.headers.location)
  assert.equal(back.searchParams.get('state'), first.state)
  mock.resetStats()
  // O mock confere o verifier contra o challenge (S256) e exige client_secret: se passou, o PKCE está certo.
  const account = await auth.completeLogin({ code: back.searchParams.get('code'), state: back.searchParams.get('state'), redirectUri: REDIRECT_URI })
  assert.equal(account.id, mock.user.permissionId)
  assert.equal(account.email, mock.user.emailAddress)
  assert.equal(account.name, mock.user.displayName)
  assert.equal(account.photoUrl, mock.user.photoLink)
  assert.equal(account.status, 'ok')
  assert.equal(typeof account.addedAt, 'number')
  assert.equal(typeof account.consentedAt, 'number')
  assert.equal('refreshToken' in account, false)
  assert.equal(mock.stats().requests['oauth.token'], 1)
  assert.equal(mock.stats().requests['about.get'], 1)

  assert.deepEqual(auth.listAccounts(), [account])
  assert.equal(events.length, 1)
  assert.equal(events[0][0].status, 'ok')
  const exposed = JSON.stringify([auth.listAccounts(), events])
  assert.doesNotMatch(exposed, /ya29\.|1\/\/mock-|refreshToken|accessToken/)

  assert.equal(await fileMode(paths.accounts), 0o600)
  const saved = JSON.parse(await fs.readFile(paths.accounts, 'utf8'))
  assert.equal(saved.accounts.length, 1)
  assert.match(saved.accounts[0].refreshToken, /^1\/\/mock-/)
  assert.equal(saved.accounts[0].consentedAt, account.consentedAt)
  assert.doesNotMatch(JSON.stringify(saved), /ya29\./, 'access token não vai para o disco')

  // O state é de uso único.
  await assert.rejects(auth.completeLogin({ code: back.searchParams.get('code'), state: first.state }), /expirou ou não foi iniciado/)

  // O token do login fica no cache e funciona no Drive.
  const token = await auth.getAccessToken(account.id)
  const drive = new DriveClient(auth, account.id)
  assert.equal((await drive.about()).user.permissionId, account.id)
  assert.equal(await auth.getAccessToken(account.id), token)
  assert.equal(mock.stats().requests['oauth.token'], 1, 'token ainda válido não é renovado')

  // Reconectar a mesma conta atualiza (não duplica) e mantém addedAt.
  await new Promise(resolve => setTimeout(resolve, 5))
  const again = await loginWithMock(auth)
  assert.equal(auth.listAccounts().length, 1)
  assert.equal(again.addedAt, account.addedAt)
  assert.ok(again.consentedAt > account.consentedAt)

  // Reabrir o app carrega a conta do disco.
  const reopened = new AuthManager({ paths })
  await reopened.init()
  assert.deepEqual(reopened.listAccounts(), auth.listAccounts())
  assert.ok(await reopened.getAccessToken(account.id))
})

test('login: state desconhecido, acesso negado, escopo desmarcado, sem refresh_token, segredo errado', async t => {
  const { auth, mock } = await freshAuth(t)
  await auth.setClientCredentials(mock.client)
  const events = collect(auth, 'accounts')

  // state que não saiu deste app (CSRF): recusa antes de falar com o Google.
  const cb = await authorizeInMock(auth)
  mock.resetStats()
  await assert.rejects(auth.completeLogin({ code: cb.code, state: 'state-de-outro-lugar', redirectUri: REDIRECT_URI }), /expirou ou não foi iniciado/)
  await assert.rejects(auth.completeLogin({ code: cb.code, redirectUri: REDIRECT_URI }), /expirou ou não foi iniciado/)
  assert.equal(mock.stats().requests['oauth.token'] ?? 0, 0)

  // A pessoa clicou em "Cancelar" (ou o app está em modo Teste sem o e-mail dela).
  mock.setOptions({ authDeny: true })
  const denied = await authorizeInMock(auth)
  assert.equal(denied.error, 'access_denied')
  await assert.rejects(auth.completeLogin(denied), err => {
    assert.match(err.message, /negou o acesso/)
    assert.match(err.message, /Usuários de teste/)
    return true
  })
  mock.setOptions({ authDeny: false })

  // Consentimento granular: desmarcou a caixa do Drive.
  mock.setOptions({ grantedScope: 'https://www.googleapis.com/auth/drive.file' })
  await assert.rejects(loginWithMock(auth), /Marque a permissão do Google Drive/)
  mock.setOptions({ grantedScope: null })

  // Sem refresh_token não dá para continuar depois de uma hora.
  mock.setOptions({ omitRefreshToken: true })
  await assert.rejects(loginWithMock(auth), err => {
    assert.match(err.message, /refresh token/)
    assert.equal(classifyError(err).kind, 'fatal')
    return true
  })
  mock.setOptions({ omitRefreshToken: false })

  // Segredo errado: o endpoint de token recusa o cliente.
  await auth.setClientCredentials({ clientId: mock.client.clientId, clientSecret: 'GOCSPX-segredo-errado' })
  await assert.rejects(loginWithMock(auth), /não reconheceu sua chave/)

  assert.deepEqual(auth.listAccounts(), [])
  assert.equal(events.length, 0)

  // Com tudo certo de novo, o login funciona.
  await auth.setClientCredentials(mock.client)
  assert.equal((await loginWithMock(auth)).status, 'ok')
})

test('renova quando faltam menos de 120 s; com tempo sobrando usa o cache', async t => {
  const { auth, mock, accountId, paths } = await loggedIn(t, { tokenTtlSec: 3600 })
  mock.resetStats()
  const t1 = await auth.getAccessToken(accountId)
  assert.equal(await auth.getAccessToken(accountId), t1)
  assert.equal(mock.stats().requests['oauth.token'] ?? 0, 0)

  // Tokens que duram só 100 s: o próximo pedido já renova (faltam < 120 s).
  mock.setOptions({ tokenTtlSec: 100 })
  const t2 = await auth.getAccessToken(accountId, { forceRefresh: true })
  assert.notEqual(t2, t1)
  assert.equal(mock.stats().requests['oauth.token'], 1)
  const t3 = await auth.getAccessToken(accountId)
  assert.notEqual(t3, t2)
  assert.equal(mock.stats().requests['oauth.token'], 2)

  // De volta a 1 h: renova uma vez e depois fica no cache.
  mock.setOptions({ tokenTtlSec: 3600 })
  const t4 = await auth.getAccessToken(accountId)
  assert.equal(mock.stats().requests['oauth.token'], 3)
  assert.equal(await auth.getAccessToken(accountId), t4)
  assert.equal(mock.stats().requests['oauth.token'], 3)

  // O refresh token salvo continua o mesmo (o Google não manda outro na renovação).
  const saved = JSON.parse(await fs.readFile(paths.accounts, 'utf8'))
  assert.match(saved.accounts[0].refreshToken, /^1\/\/mock-/)
})

test('pedidos simultâneos de token compartilham uma única renovação', async t => {
  const { auth, mock, accountId } = await loggedIn(t)
  mock.setOptions({ latencyMs: 40 })
  mock.resetStats()
  const forced = await Promise.all(Array.from({ length: 20 }, () => auth.getAccessToken(accountId, { forceRefresh: true })))
  assert.equal(new Set(forced).size, 1)
  assert.equal(mock.stats().requests['oauth.token'], 1)

  // Token perto de vencer: 20 pedidos normais ao mesmo tempo = uma renovação.
  mock.setOptions({ tokenTtlSec: 60 })
  await auth.getAccessToken(accountId, { forceRefresh: true })
  mock.resetStats()
  const tokens = await Promise.all(Array.from({ length: 20 }, () => auth.getAccessToken(accountId)))
  assert.equal(new Set(tokens).size, 1)
  assert.equal(mock.stats().requests['oauth.token'], 1)

  // rejectedToken: se o cache já tem outro token, não renova de novo.
  mock.setOptions({ tokenTtlSec: 3600, latencyMs: 0 })
  const fresh = await auth.getAccessToken(accountId, { forceRefresh: true })
  mock.resetStats()
  assert.equal(await auth.getAccessToken(accountId, { forceRefresh: true, rejectedToken: 'ya29.um-token-velho' }), fresh)
  assert.equal(mock.stats().requests['oauth.token'] ?? 0, 0)
  assert.notEqual(await auth.getAccessToken(accountId, { forceRefresh: true, rejectedToken: fresh }), fresh)
  assert.equal(mock.stats().requests['oauth.token'], 1)
})

test('invalid_grant: conta vira "reauth", emite "accounts" e explica; reconectar resolve', async t => {
  const { auth, mock, accountId, paths } = await loggedIn(t)
  const events = collect(auth, 'accounts')
  mock.revokeRefreshTokens()
  mock.resetStats()

  await assert.rejects(auth.getAccessToken(accountId, { forceRefresh: true }), err => {
    assert.equal(err.name, 'SobeDesceError')
    assert.equal(err.kind, 'reauth')
    assert.equal(classifyError(err).kind, 'reauth')
    assert.match(err.message, /Conecte a conta de novo/)
    assert.match(err.message, /ana\.montadora@example\.com/)
    assert.doesNotMatch(err.message, /modo Teste/, 'logo depois de conectar não é o limite de 7 dias')
    return true
  })
  assert.equal(auth.listAccounts()[0].status, 'reauth')
  assert.equal(events.length, 1)
  assert.equal(events[0][0].status, 'reauth')
  const saved = JSON.parse(await fs.readFile(paths.accounts, 'utf8'))
  assert.equal(saved.accounts[0].status, 'reauth')
  assert.ok(saved.accounts[0].refreshToken, 'o refresh token salvo nunca vira undefined')

  // Depois de marcada, não insiste no Google.
  const before = mock.stats().requests['oauth.token']
  await assert.rejects(auth.getAccessToken(accountId), { kind: 'reauth' })
  const drive = new DriveClient(auth, accountId)
  await assert.rejects(drive.getItem('root'), err => classifyError(err).kind === 'reauth')
  assert.equal(mock.stats().requests['oauth.token'], before)

  // Reconectar volta a funcionar.
  const back = await loginWithMock(auth)
  assert.equal(back.status, 'ok')
  assert.equal((await drive.getItem('root')).isFolder, true)
})

test('invalid_grant ~7 dias depois de conectar: mensagem explica o modo Teste', async t => {
  const { mock, accountId, paths } = await loggedIn(t)
  // Finge que o consentimento foi há 7 dias (reabrindo o app a partir do disco).
  const saved = JSON.parse(await fs.readFile(paths.accounts, 'utf8'))
  saved.accounts[0].consentedAt = Date.now() - 7 * DAY + 3600_000
  await fs.writeFile(paths.accounts, JSON.stringify(saved))
  const reopened = new AuthManager({ paths })
  await reopened.init()
  mock.revokeRefreshTokens()
  const events = collect(reopened, 'accounts')
  await assert.rejects(reopened.getAccessToken(accountId), err => {
    assert.equal(err.kind, 'reauth')
    assert.match(err.message, /modo Teste/)
    assert.match(err.message, /Público-alvo → Publicar app/)
    assert.match(err.message, /reconecte toda semana/)
    return true
  })
  assert.equal(events.length, 1)
  // A mesma mensagem continua valendo nas tentativas seguintes e depois de reabrir.
  await assert.rejects(reopened.getAccessToken(accountId), /modo Teste/)
  const third = new AuthManager({ paths })
  await third.init()
  assert.equal(third.listAccounts()[0].status, 'reauth')
  await assert.rejects(third.getAccessToken(accountId), /modo Teste/)

  // 20 dias depois já não é "certeza" de modo Teste: mensagem genérica.
  const other = JSON.parse(await fs.readFile(paths.accounts, 'utf8'))
  other.accounts[0].consentedAt = Date.now() - 20 * DAY
  other.accounts[0].status = 'ok'
  other.accounts[0].reauthAt = null
  await fs.writeFile(paths.accounts, JSON.stringify(other))
  const fourth = new AuthManager({ paths })
  await fourth.init()
  await assert.rejects(fourth.getAccessToken(accountId), err => !/modo Teste/.test(err.message) && /Conecte a conta de novo/.test(err.message))
})

test('removeAccount revoga o token (melhor esforço) e apaga a conta', async t => {
  const { auth, mock, accountId, paths } = await loggedIn(t)
  const refreshToken = JSON.parse(await fs.readFile(paths.accounts, 'utf8')).accounts[0].refreshToken
  const events = collect(auth, 'accounts')
  mock.resetStats()
  assert.deepEqual(await auth.removeAccount(accountId), [])
  assert.equal(mock.stats().requests['oauth.revoke'], 1)
  assert.equal(mock.refreshTokens.get(refreshToken).revoked, true)
  assert.deepEqual(auth.listAccounts(), [])
  assert.deepEqual(events, [[]])
  assert.deepEqual(JSON.parse(await fs.readFile(paths.accounts, 'utf8')).accounts, [])
  await assert.rejects(auth.getAccessToken(accountId), { kind: 'reauth' })
  // De novo (ou conta desconhecida): não falha.
  assert.deepEqual(await auth.removeAccount(accountId), [])

  // Revogação que falha não impede a remoção.
  await loginWithMock(auth)
  process.env.SOBEDESCE_OAUTH_REVOKE = 'http://127.0.0.1:1/revoke'
  t.after(() => mock.applyEnv())
  assert.deepEqual(await auth.removeAccount(accountId), [])
})

test('endpoint de token: 5xx e rede caída são repetidos (3 tentativas), sem marcar a conta', async t => {
  const { auth, mock, accountId } = await loggedIn(t)
  t.after(() => mock.applyEnv())

  const flaky = await startTokenStub(t, { failures: 2 })
  process.env.SOBEDESCE_OAUTH_TOKEN = flaky.url
  const token = await auth.getAccessToken(accountId, { forceRefresh: true })
  assert.equal(token, 'ya29.stub-3')
  assert.equal(flaky.count, 3)
  for (const body of flaky.bodies) {
    assert.equal(body.get('grant_type'), 'refresh_token')
    assert.equal(body.get('client_id'), mock.client.clientId)
    assert.equal(body.get('client_secret'), mock.client.clientSecret, 'client_secret vai SEMPRE')
    assert.match(body.get('refresh_token'), /^1\/\/mock-/)
  }

  const down = await startTokenStub(t, { failures: Infinity })
  process.env.SOBEDESCE_OAUTH_TOKEN = down.url
  await assert.rejects(auth.getAccessToken(accountId, { forceRefresh: true }), err => {
    assert.equal(classifyError(err).kind, 'retry')
    return true
  })
  assert.equal(down.count, 3)

  // Porta fechada (sem internet / Google fora).
  const gone = await startTokenStub(t)
  await gone.close()
  process.env.SOBEDESCE_OAUTH_TOKEN = gone.url
  await assert.rejects(auth.getAccessToken(accountId, { forceRefresh: true }), err => classifyError(err).kind === 'retry')

  assert.equal(auth.listAccounts()[0].status, 'ok', 'falha de rede não pede reconexão')
  mock.applyEnv()
  assert.ok(await auth.getAccessToken(accountId, { forceRefresh: true }))
})

test('trocar a chave por outro cliente pede para reconectar as contas', async t => {
  const { auth, mock, accountId } = await loggedIn(t)
  const events = collect(auth, 'accounts')
  // Mesma chave de novo: nada muda.
  await auth.setClientCredentials(mock.client)
  assert.equal(auth.listAccounts()[0].status, 'ok')
  assert.equal(events.length, 0)
  await auth.setClientCredentials({ clientId: '999999999999-outro.apps.googleusercontent.com', clientSecret: 'GOCSPX-outro' })
  assert.equal(auth.listAccounts()[0].status, 'reauth')
  assert.equal(events.length, 1)
  await assert.rejects(auth.getAccessToken(accountId), err => err.kind === 'reauth' && /chave do Google mudou/.test(err.message))
  // Voltar para a chave que emitiu o token desfaz o "reconectar".
  await auth.setClientCredentials(mock.client)
  assert.equal(auth.listAccounts()[0].status, 'ok')
  assert.equal(events.length, 2)
  assert.ok(await auth.getAccessToken(accountId, { forceRefresh: true }))
})
