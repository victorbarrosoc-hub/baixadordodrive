// Testes do Google Drive falso: ele é a régua dos motores, então precisa estar certo.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { startMockDrive, virtualBytes, virtualMd5, writeVirtualFile, parseQuery } from './mock-drive.js'
import { httpRequest, requestJSON, HttpError, drain, closeHttp } from '../src/net/http.js'
import { classifyError } from '../src/google/errors.js'
import { DRIVE_SCOPE } from '../src/config.js'

const KiB = 1024
const MiB = 1024 * KiB
const FOLDER = 'application/vnd.google-apps.folder'
const md5 = buf => crypto.createHash('md5').update(buf).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

after(() => closeHttp())

async function setup(t, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sobedesce-mocktest-'))
  process.env.SOBEDESCE_HOME = home
  const mock = await startMockDrive(options)
  t.after(async () => {
    await mock.close()
    await fs.rm(home, { recursive: true, force: true })
  })
  const tokens = mock.issueTokens()
  const api = mock.env.SOBEDESCE_DRIVE_API
  return { mock, home, api, tokens, auth: { authorization: `Bearer ${tokens.accessToken}` } }
}

async function get(url, { headers, expect = [200], signal } = {}) {
  const res = await httpRequest(url, { headers, expect, signal })
  const buf = Buffer.from(await res.body.arrayBuffer())
  return { status: res.status, headers: res.headers, buf }
}

async function rejectsWith(promise, status, reason) {
  let caught = null
  await assert.rejects(promise, err => {
    caught = err
    assert.ok(err instanceof HttpError, `esperava HttpError, veio ${err}`)
    if (status != null) assert.equal(err.status, status, `status: ${err.status} ${err.message}`)
    if (reason) assert.equal(err.reason, reason)
    return true
  })
  return caught
}

async function waitFor(fn, timeoutMs = 5000) {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('condição não aconteceu a tempo')
    await sleep(10)
  }
}

function committedFrom(headers) {
  const m = /^bytes=0-(\d+)$/.exec(headers.range || '')
  return m ? Number(m[1]) + 1 : 0
}

async function initUpload(mock, auth, meta, { length, query = '', fileId = null } = {}) {
  const base = mock.env.SOBEDESCE_DRIVE_UPLOAD
  const url = fileId ? `${base}/files/${fileId}?uploadType=resumable${query}` : `${base}/files?uploadType=resumable${query}`
  const headers = { ...auth, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'video/quicktime' }
  if (length != null) headers['x-upload-content-length'] = String(length)
  const res = await httpRequest(url, { method: fileId ? 'PATCH' : 'POST', headers, body: JSON.stringify(meta), expect: [200] })
  await drain(res.body)
  assert.ok(res.headers.location, 'sem Location')
  return res.headers.location
}

async function putChunk(uri, data, start, total, { headers = {}, expect = [200, 308], signal } = {}) {
  const end = start + data.length - 1
  const res = await httpRequest(uri, {
    method: 'PUT',
    headers: { 'content-range': `bytes ${start}-${end}/${total}`, ...headers },
    body: data,
    expect,
    signal,
  })
  const text = await res.body.text()
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null }
}

async function statusQuery(uri, total, expect = [200, 308]) {
  const res = await httpRequest(uri, {
    method: 'PUT',
    headers: { 'content-range': `bytes */${total}`, 'content-length': '0' },
    body: '',
    expect,
  })
  const text = await res.body.text()
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null, committed: committedFrom(res.headers) }
}

function authUrl(mock, params = {}) {
  const verifier = crypto.randomBytes(64).toString('base64url')
  const url = new URL(mock.env.SOBEDESCE_OAUTH_AUTH)
  url.search = new URLSearchParams({
    client_id: mock.client.clientId,
    redirect_uri: 'http://127.0.0.1:4317/oauth/callback',
    response_type: 'code',
    scope: DRIVE_SCOPE,
    state: 'estado-123',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    ...params,
  })
  return { url, verifier }
}

async function authorize(mock, params) {
  const { url, verifier } = authUrl(mock, params)
  const res = await httpRequest(url, { expect: [302] })
  await drain(res.body)
  return { location: new URL(res.headers.location), verifier }
}

function tokenRequest(mock, fields) {
  return requestJSON(mock.env.SOBEDESCE_OAUTH_TOKEN, { method: 'POST', body: new URLSearchParams(fields) })
}

// ───────────────────────────── OAuth ─────────────────────────────

test('OAuth: fluxo de código com PKCE, refresh e revogação', async t => {
  const { mock, api } = await setup(t)
  assert.match(mock.client.clientId, /\.apps\.googleusercontent\.com$/)
  const redirectUri = 'http://127.0.0.1:4317/oauth/callback'
  const { location, verifier } = await authorize(mock)
  assert.equal(`${location.origin}${location.pathname}`, redirectUri)
  assert.equal(location.searchParams.get('state'), 'estado-123')
  const code = location.searchParams.get('code')
  assert.ok(code)

  const exchange = {
    grant_type: 'authorization_code',
    code,
    client_id: mock.client.clientId,
    client_secret: mock.client.clientSecret,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }
  const tok = await tokenRequest(mock, exchange)
  assert.equal(tok.token_type, 'Bearer')
  assert.equal(tok.expires_in, 3600)
  assert.equal(tok.scope, DRIVE_SCOPE)
  assert.ok(tok.access_token && tok.refresh_token)

  const about = await requestJSON(`${api}/about?fields=user(displayName,emailAddress,permissionId,photoLink),storageQuota`, {
    headers: { authorization: `Bearer ${tok.access_token}` },
  })
  assert.deepEqual(about.user, mock.user)

  // código é de uso único
  await rejectsWith(tokenRequest(mock, exchange), 400, 'invalid_grant')

  // refresh: novo access token, sem refresh token novo
  const refresh = { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: mock.client.clientId, client_secret: mock.client.clientSecret }
  const ref = await tokenRequest(mock, refresh)
  assert.ok(ref.access_token)
  assert.notEqual(ref.access_token, tok.access_token)
  assert.equal(ref.refresh_token, undefined)
  assert.equal(ref.scope, DRIVE_SCOPE)
  assert.equal(ref.token_type, 'Bearer')

  // revogar o refresh derruba a concessão inteira
  await requestJSON(mock.env.SOBEDESCE_OAUTH_REVOKE, { method: 'POST', body: new URLSearchParams({ token: tok.refresh_token }) })
  const err = await rejectsWith(tokenRequest(mock, refresh), 400, 'invalid_grant')
  assert.equal(classifyError(err).kind, 'reauth')
  await rejectsWith(requestJSON(`${api}/about?fields=user`, { headers: { authorization: `Bearer ${ref.access_token}` } }), 401, 'authError')
  await rejectsWith(requestJSON(mock.env.SOBEDESCE_OAUTH_REVOKE, { method: 'POST', body: new URLSearchParams({ token: tok.refresh_token }) }), 400, 'invalid_token')
})

test('OAuth: verificador errado, sem client_secret, cliente/redirect inválidos e acesso negado', async t => {
  const { mock } = await setup(t)
  const redirectUri = 'http://127.0.0.1:4317/oauth/callback'
  const base = { grant_type: 'authorization_code', client_id: mock.client.clientId, client_secret: mock.client.clientSecret, redirect_uri: redirectUri }

  let a = await authorize(mock)
  let err = await rejectsWith(tokenRequest(mock, { ...base, code: a.location.searchParams.get('code'), code_verifier: 'x'.repeat(64) }), 400, 'invalid_grant')
  assert.equal(err.message, 'Invalid code verifier.')

  a = await authorize(mock)
  const { client_secret: _omit, ...noSecret } = base
  err = await rejectsWith(tokenRequest(mock, { ...noSecret, code: a.location.searchParams.get('code'), code_verifier: a.verifier }), 400, 'invalid_request')
  assert.equal(err.message, 'client_secret is missing.')

  a = await authorize(mock)
  await rejectsWith(tokenRequest(mock, { ...base, client_secret: 'GOCSPX-errado', code: a.location.searchParams.get('code'), code_verifier: a.verifier }), 401, 'invalid_client')
  a = await authorize(mock)
  await rejectsWith(tokenRequest(mock, { ...base, redirect_uri: 'http://127.0.0.1:9999/outro', code: a.location.searchParams.get('code'), code_verifier: a.verifier }), 400, 'redirect_uri_mismatch')
  await rejectsWith(tokenRequest(mock, { ...base, code: 'inventado', code_verifier: a.verifier }), 400, 'invalid_grant')
  await rejectsWith(tokenRequest(mock, { ...base, client_id: 'outro.apps.googleusercontent.com', code: 'x', code_verifier: 'y' }), 401, 'invalid_client')
  await rejectsWith(tokenRequest(mock, { ...base, grant_type: 'password' }), 400, 'unsupported_grant_type')
  await rejectsWith(tokenRequest(mock, { grant_type: 'refresh_token', refresh_token: '1//inventado', client_id: mock.client.clientId, client_secret: mock.client.clientSecret }), 400, 'invalid_grant')

  // erros na tela de consentimento não redirecionam (página de erro do Google)
  for (const params of [
    { redirect_uri: 'https://exemplo.com/callback' },
    { code_challenge_method: 'plain' },
    { code_challenge: '' },
    { scope: '' },
    { response_type: 'token' },
    { client_id: '1-outro.apps.googleusercontent.com' },
  ]) {
    const res = await httpRequest(authUrl(mock, params).url, { expect: [400, 401] })
    assert.equal(res.headers.location, undefined)
    assert.match(await res.body.text(), /Error 40[01]/)
  }

  // sem exigir segredo, omitindo refresh token e com escopo granular
  mock.setOptions({ requireClientSecret: false, omitRefreshToken: true, grantedScope: 'https://www.googleapis.com/auth/drive.file' })
  a = await authorize(mock)
  assert.equal(a.location.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file')
  const tok = await tokenRequest(mock, { ...noSecret, code: a.location.searchParams.get('code'), code_verifier: a.verifier })
  assert.equal(tok.refresh_token, undefined)
  assert.equal(tok.scope, 'https://www.googleapis.com/auth/drive.file')

  mock.setOptions({ authDeny: true })
  a = await authorize(mock)
  assert.equal(a.location.searchParams.get('error'), 'access_denied')
  assert.equal(a.location.searchParams.get('state'), 'estado-123')
  assert.equal(a.location.searchParams.get('code'), null)
})

test('token expirado, ausente ou com escopo insuficiente', async t => {
  const { mock, api, auth, tokens } = await setup(t)
  const listUrl = `${api}/files?q=${encodeURIComponent("'root' in parents")}&fields=files(id)`
  await requestJSON(listUrl, { headers: auth })

  mock.expireAccessTokens()
  const err = await rejectsWith(requestJSON(listUrl, { headers: auth }), 401, 'authError')
  assert.equal(err.message, 'Request had invalid authentication credentials.')
  assert.equal(classifyError(err).kind, 'auth')
  await rejectsWith(requestJSON(listUrl), 401, 'authError')
  await rejectsWith(requestJSON(listUrl, { headers: { authorization: 'Bearer lixo' } }), 401, 'authError')

  const ref = await tokenRequest(mock, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: mock.client.clientId, client_secret: mock.client.clientSecret })
  await requestJSON(listUrl, { headers: { authorization: `Bearer ${ref.access_token}` } })

  // tokenTtlSec controla expires_in (0 = nasce vencido)
  mock.setOptions({ tokenTtlSec: 0 })
  const short = await tokenRequest(mock, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: mock.client.clientId, client_secret: mock.client.clientSecret })
  assert.equal(short.expires_in, 0)
  await rejectsWith(requestJSON(listUrl, { headers: { authorization: `Bearer ${short.access_token}` } }), 401, 'authError')

  // revokeRefreshTokens simula o fim dos 7 dias do modo Teste
  mock.revokeRefreshTokens()
  await rejectsWith(tokenRequest(mock, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: mock.client.clientId, client_secret: mock.client.clientSecret }), 400, 'invalid_grant')

  // escopo só leitura: lista, mas não cria
  mock.setOptions({ tokenTtlSec: 3600 })
  const ro = mock.issueTokens({ scope: 'https://www.googleapis.com/auth/drive.readonly' })
  const roAuth = { authorization: `Bearer ${ro.accessToken}` }
  await requestJSON(listUrl, { headers: roAuth })
  await rejectsWith(requestJSON(`${api}/files`, { method: 'POST', headers: roAuth, body: { name: 'x', mimeType: FOLDER } }), 403, 'insufficientPermissions')
})

// ───────────────────────────── metadados ─────────────────────────────

test('about exige fields e informa a cota como texto', async t => {
  const { mock, api, auth } = await setup(t, { storageLimitBytes: 15 * 1024 ** 3 })
  await rejectsWith(requestJSON(`${api}/about`, { headers: auth }), 400, 'required')
  mock.addFile('a.mov', 'root', { size: 1000 })
  mock.addFile('b.mov', 'root', { size: 24, trashed: true })
  const sd = mock.addSharedDrive('Equipe')
  mock.addFile('fora-da-cota.mov', sd.id, { size: 5000 })
  const about = await requestJSON(`${api}/about?fields=user(displayName,emailAddress,permissionId,photoLink),storageQuota`, { headers: auth })
  assert.deepEqual(about, {
    user: { ...mock.user },
    storageQuota: { limit: String(15 * 1024 ** 3), usage: '1024', usageInDrive: '1000', usageInDriveTrash: '24' },
  })
  const full = await requestJSON(`${api}/about?fields=user`, { headers: auth })
  assert.equal(full.user.me, true)
  assert.equal(full.user.kind, 'drive#user')
  await rejectsWith(requestJSON(`${api}/about?fields=usuario`, { headers: auth }), 400, 'invalidParameter')
})

test('files.list: paginação, filtros q, fields, ordem e lixeira', async t => {
  const { mock, api, auth } = await setup(t)
  const folder = mock.addFolder('Projeto')
  for (let i = 0; i < 250; i++) mock.addFile(`clip ${String(i).padStart(3, '0')}.mov`, folder.id, { size: 1000 + i })
  const sub = mock.addFolder('Sub', folder.id)
  const doc = mock.addGoogleDoc('Roteiro', folder.id)
  mock.addFile('apagado.mov', folder.id, { size: 5, trashed: true })
  const weird = mock.addFile("it's a \\ test.mov", folder.id, { content: Buffer.from('oi') })
  mock.addFile('fora.mov', 'root', { size: 1 })

  const list = async (q, extra = '') =>
    requestJSON(`${api}/files?q=${encodeURIComponent(q)}&supportsAllDrives=true&includeItemsFromAllDrives=true${extra}`, { headers: auth })

  // paginação: segue nextPageToken até o fim
  const ids = []
  let pageToken = null
  let pages = 0
  do {
    const r = await list(`'${folder.id}' in parents and trashed = false`, `&pageSize=100&fields=nextPageToken,files(id,name)${pageToken ? `&pageToken=${pageToken}` : ''}`)
    ids.push(...r.files.map(f => f.id))
    pageToken = r.nextPageToken
    pages++
  } while (pageToken)
  assert.equal(pages, 3)
  assert.equal(ids.length, 253)
  assert.equal(new Set(ids).size, 253)

  // sem trashed = false, a lixeira vem junto (como no Google)
  const all = await list(`'${folder.id}' in parents`, '&pageSize=1000&fields=files(id,trashed)')
  assert.equal(all.files.length, 254)
  assert.equal(all.files.filter(f => f.trashed).length, 1)

  // sem fields: só kind/id/name/mimeType (nada de size/md5)
  const plain = await list(`'${folder.id}' in parents and name = 'clip 000.mov'`)
  assert.equal(plain.kind, 'drive#fileList')
  assert.equal(plain.incompleteSearch, false)
  assert.deepEqual(Object.keys(plain.files[0]).sort(), ['id', 'kind', 'mimeType', 'name'])

  // fields com campos de verdade: size é texto, md5Checksum confere
  const rich = await list(`'${folder.id}' in parents and name = 'clip 007.mov'`, '&fields=files(id,name,size,md5Checksum,mimeType,parents,modifiedTime,headRevisionId,capabilities(canDownload))')
  const f7 = rich.files[0]
  assert.equal(f7.size, '1007')
  assert.equal(f7.md5Checksum, md5(mock.readContent(f7.id)))
  assert.deepEqual(f7.parents, [folder.id])
  assert.deepEqual(f7.capabilities, { canDownload: true })
  assert.equal(f7.mimeType, 'video/quicktime')
  assert.ok(f7.headRevisionId && f7.modifiedTime)

  const fields = '&pageSize=1000&fields=files(id,name,mimeType,size,md5Checksum)'
  const folders = await list(`'${folder.id}' in parents and mimeType = '${FOLDER}'`, fields)
  assert.deepEqual(folders.files.map(f => f.id), [sub.id])
  assert.equal(folders.files[0].size, undefined)
  const nonFolders = await list(`'${folder.id}' in parents and mimeType != '${FOLDER}' and trashed = false`, fields)
  assert.equal(nonFolders.files.length, 252)
  const gdoc = nonFolders.files.find(f => f.id === doc.id)
  assert.equal(gdoc.size, undefined)
  assert.equal(gdoc.md5Checksum, undefined)

  const prefix = await list(`'${folder.id}' in parents and name contains 'clip 01'`, fields)
  assert.equal(prefix.files.length, 10)
  const middle = await list(`'${folder.id}' in parents and name contains 'lip'`, fields)
  assert.equal(middle.files.length, 0, 'contains só casa prefixo de palavra')
  const caseless = await list(`'${folder.id}' in parents and name = 'CLIP 000.MOV'`, fields)
  assert.equal(caseless.files.length, 1, 'name = não diferencia maiúsculas')
  const escaped = await list(`'${folder.id}' in parents and name = 'it\\'s a \\\\ test.mov'`, fields)
  assert.deepEqual(escaped.files.map(f => f.id), [weird.id])
  const either = await list(`'${folder.id}' in parents and (name = 'clip 000.mov' or name = 'clip 001.mov') and trashed = false`, fields)
  assert.equal(either.files.length, 2)
  const negated = await list(`'${folder.id}' in parents and not name contains 'clip' and trashed = false`, fields)
  assert.deepEqual(negated.files.map(f => f.name).sort(), ['Roteiro', 'Sub', "it's a \\ test.mov"])
  const rootOnly = await list(`'root' in parents and trashed = false`, fields)
  assert.deepEqual(rootOnly.files.map(f => f.name).sort(), ['Projeto', 'fora.mov'])

  const ordered = await list(`'${folder.id}' in parents and trashed = false`, '&orderBy=folder,name&pageSize=3&fields=files(name)')
  assert.deepEqual(ordered.files.map(f => f.name), ['Sub', 'clip 000.mov', 'clip 001.mov'])
  const desc = await list(`'${folder.id}' in parents and mimeType != '${FOLDER}'`, '&orderBy=name desc&pageSize=1&fields=files(name)')
  assert.equal(desc.files[0].name, 'Roteiro')

  // páginas curtas (até vazias) com nextPageToken: quem lista tem que seguir o token
  mock.setOptions({ failures: { shortPageProb: 1 } })
  const seen = new Set()
  pageToken = null
  pages = 0
  do {
    const r = await list(`'${folder.id}' in parents and trashed = false`, `&pageSize=100&fields=nextPageToken,files(id)${pageToken ? `&pageToken=${pageToken}` : ''}`)
    for (const f of r.files) seen.add(f.id)
    pageToken = r.nextPageToken
    pages++
  } while (pageToken)
  assert.equal(seen.size, 253)
  assert.ok(pages > 3)
  mock.setOptions({ failures: {} })

  await rejectsWith(list(`'${folder.id}' in parents and`), 400, 'invalid')
  await rejectsWith(list('tamanho > 3'), 400, 'invalid')
  await rejectsWith(list(`'${folder.id}' in parents`, '&fields=files(id,md5)'), 400, 'invalidParameter')
  await rejectsWith(list(`'${folder.id}' in parents`, '&pageSize=1001'), 400, 'invalid')
  await rejectsWith(list(`'${folder.id}' in parents`, '&pageToken=lixo'), 400, 'invalid')
  assert.throws(() => parseQuery("name = 'sem fim"))
})

test('drives compartilhados só aparecem com supportsAllDrives e includeItemsFromAllDrives', async t => {
  const { mock, api, auth } = await setup(t)
  const sd = mock.addSharedDrive('Equipe')
  mock.addSharedDrive('Outra')
  const file = mock.addFile('bruto.mxf', sd.id, { size: 100 })
  assert.equal(file.driveId, sd.id)
  const q = encodeURIComponent(`'${sd.id}' in parents and trashed = false`)
  const fields = 'fields=nextPageToken,files(id,name,driveId,parents)'

  let r = await requestJSON(`${api}/files?q=${q}&${fields}`, { headers: auth })
  assert.deepEqual(r.files, [])
  r = await requestJSON(`${api}/files?q=${q}&includeItemsFromAllDrives=true&${fields}`, { headers: auth })
  assert.deepEqual(r.files, [])
  r = await requestJSON(`${api}/files?q=${q}&includeItemsFromAllDrives=true&supportsAllDrives=true&${fields}`, { headers: auth })
  assert.deepEqual(r.files, [{ id: file.id, name: 'bruto.mxf', driveId: sd.id, parents: [sd.id] }])
  r = await requestJSON(`${api}/files?q=${encodeURIComponent('trashed = false')}&corpora=drive&driveId=${sd.id}&includeItemsFromAllDrives=true&supportsAllDrives=true&${fields}`, { headers: auth })
  assert.deepEqual(r.files.map(f => f.id), [file.id])
  await rejectsWith(requestJSON(`${api}/files?corpora=drive&includeItemsFromAllDrives=true&supportsAllDrives=true`, { headers: auth }), 400, 'invalid')
  await rejectsWith(requestJSON(`${api}/files?corpora=drive&driveId=0Ainexistente&includeItemsFromAllDrives=true&supportsAllDrives=true`, { headers: auth }), 404, 'notFound')

  // por id: sem supportsAllDrives o item "não existe"
  await rejectsWith(requestJSON(`${api}/files/${file.id}?fields=id`, { headers: auth }), 404, 'notFound')
  await rejectsWith(get(`${api}/files/${file.id}?alt=media`, { headers: auth }), 404, 'notFound')
  const meta = await requestJSON(`${api}/files/${file.id}?supportsAllDrives=true&fields=id,driveId,size`, { headers: auth })
  assert.deepEqual(meta, { id: file.id, driveId: sd.id, size: '100' })
  const root = await requestJSON(`${api}/files/${sd.id}?supportsAllDrives=true&fields=id,name,mimeType,driveId`, { headers: auth })
  assert.deepEqual(root, { id: sd.id, name: 'Equipe', mimeType: FOLDER, driveId: sd.id })

  // drives.list paginado (até 100 por página)
  const page1 = await requestJSON(`${api}/drives?pageSize=1`, { headers: auth })
  assert.equal(page1.drives.length, 1)
  assert.ok(page1.nextPageToken)
  const page2 = await requestJSON(`${api}/drives?pageSize=1&pageToken=${page1.nextPageToken}`, { headers: auth })
  assert.equal(page2.nextPageToken, undefined)
  assert.deepEqual([...page1.drives, ...page2.drives].map(d => d.name), ['Equipe', 'Outra'])
  await rejectsWith(requestJSON(`${api}/drives?pageSize=101`, { headers: auth }), 400, 'invalid')
  assert.deepEqual(await requestJSON(`${api}/drives/${sd.id}?fields=id,name`, { headers: auth }), { id: sd.id, name: 'Equipe' })
  await rejectsWith(requestJSON(`${api}/drives/0Anada`, { headers: auth }), 404, 'notFound')

  // resourceKey: sem o header, o item some
  const old = mock.addFile('antigo.mov', 'root', { size: 10, resourceKey: true })
  await rejectsWith(requestJSON(`${api}/files/${old.id}?fields=id`, { headers: auth }), 404, 'notFound')
  const withKey = await requestJSON(`${api}/files/${old.id}?fields=id,resourceKey`, { headers: { ...auth, 'x-goog-drive-resource-keys': `${old.id}/${old.resourceKey}` } })
  assert.equal(withKey.resourceKey, old.resourceKey)

  // atalho e documento nativo: sem size/md5
  const sc = mock.addShortcut('atalho', 'root', file.id)
  const scMeta = await requestJSON(`${api}/files/${sc.id}?fields=id,mimeType,size,md5Checksum,shortcutDetails`, { headers: auth })
  assert.deepEqual(scMeta, { id: sc.id, mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: file.id, targetMimeType: 'application/mxf' } })
  const rootMeta = await requestJSON(`${api}/files/root?fields=id,name,parents`, { headers: auth })
  assert.deepEqual(rootMeta, { id: mock.rootId, name: 'My Drive' })
})

test('files.create, PATCH e DELETE: pastas, renomear, mover e lixeira', async t => {
  const { mock, api, auth } = await setup(t)
  const created = await requestJSON(`${api}/files?fields=id,name,mimeType,parents`, { method: 'POST', headers: auth, body: { name: 'Entregas', mimeType: FOLDER, parents: ['root'] } })
  assert.equal(created.mimeType, FOLDER)
  assert.deepEqual(created.parents, [mock.rootId])
  const plain = await requestJSON(`${api}/files`, { method: 'POST', headers: auth, body: { name: 'Sem fields', mimeType: FOLDER } })
  assert.deepEqual(Object.keys(plain).sort(), ['id', 'kind', 'mimeType', 'name'])
  await rejectsWith(requestJSON(`${api}/files`, { method: 'POST', headers: auth, body: { name: 'x', parents: [created.id, plain.id] } }), 403, 'cannotAddParent')
  await rejectsWith(requestJSON(`${api}/files`, { method: 'POST', headers: auth, body: { name: 'x', parents: ['1naoexiste'] } }), 404, 'notFound')

  const inner = mock.addFile('cena.mov', created.id, { size: 10 })
  const renamed = await requestJSON(`${api}/files/${created.id}?fields=id,name`, { method: 'PATCH', headers: auth, body: { name: 'Entregas OK' } })
  assert.equal(renamed.name, 'Entregas OK')
  await rejectsWith(requestJSON(`${api}/files/${created.id}`, { method: 'PATCH', headers: auth, body: { parents: ['root'] } }), 403, 'fieldNotWritable')

  // mover: addParents + removeParents
  const moved = await requestJSON(`${api}/files/${inner.id}?addParents=${plain.id}&removeParents=${created.id}&fields=parents`, { method: 'PATCH', headers: auth, body: {} })
  assert.deepEqual(moved.parents, [plain.id])
  await rejectsWith(requestJSON(`${api}/files/${inner.id}?addParents=${created.id}`, { method: 'PATCH', headers: auth, body: {} }), 403, 'cannotAddParent')

  // lixeira: filhos vão junto (implicitamente)
  await requestJSON(`${api}/files/${plain.id}?fields=trashed`, { method: 'PATCH', headers: auth, body: { trashed: true } })
  assert.equal(mock.getItem(inner.id).trashed, true)
  const visible = await requestJSON(`${api}/files?q=${encodeURIComponent(`'${plain.id}' in parents and trashed = false`)}&fields=files(id)`, { headers: auth })
  assert.deepEqual(visible.files, [])

  const del = await httpRequest(`${api}/files/${plain.id}`, { method: 'DELETE', headers: auth, expect: [204] })
  await drain(del.body)
  assert.equal(mock.getItem(plain.id), null)
  assert.equal(mock.getItem(inner.id), null)
  await rejectsWith(requestJSON(`${api}/files/${plain.id}?fields=id`, { headers: auth }), 404, 'notFound')
  await rejectsWith(httpRequest(`${api}/files/root`, { method: 'DELETE', headers: auth, expect: [204] }), 403)
})

test('lixeira: trashed só booleano, sem permissão (canTrash) dá 403 e drive compartilhado exige supportsAllDrives', async t => {
  const { mock, api, auth } = await setup(t)
  const pasta = mock.addFolder('Diária 02')
  const meta = mock.addFile('._A003_C001.braw', pasta.id, { size: 4096 })
  const so = mock.addFile('._A003_C002.braw', pasta.id, { size: 4096, canTrash: false })
  const caps = await requestJSON(`${api}/files/${so.id}?fields=capabilities(canTrash)`, { headers: auth })
  assert.equal(caps.capabilities.canTrash, false)
  await rejectsWith(requestJSON(`${api}/files/${meta.id}`, { method: 'PATCH', headers: auth, body: { trashed: 'true' } }), 400, 'invalid')
  await rejectsWith(requestJSON(`${api}/files/${so.id}`, { method: 'PATCH', headers: auth, body: { trashed: true } }), 403, 'insufficientFilePermissions')
  assert.equal(mock.getItem(so.id).trashed, false)
  const r = await requestJSON(`${api}/files/${meta.id}?fields=id,trashed`, { method: 'PATCH', headers: auth, body: { trashed: true } })
  assert.deepEqual(r, { id: meta.id, trashed: true })
  const list = await requestJSON(`${api}/files?q=${encodeURIComponent(`'${pasta.id}' in parents and trashed = false`)}&fields=files(id)`, { headers: auth })
  assert.deepEqual(list.files.map(f => f.id), [so.id])
  // Tirar da lixeira volta para a lista (e quem não pode jogar fora pode tirar).
  await requestJSON(`${api}/files/${meta.id}?fields=id`, { method: 'PATCH', headers: auth, body: { trashed: false } })
  assert.equal(mock.getItem(meta.id).trashed, false)

  const sd = mock.addSharedDrive('Acervo')
  const dentro = mock.addFile('.DS_Store', sd.id, { size: 6148 })
  await rejectsWith(requestJSON(`${api}/files/${dentro.id}`, { method: 'PATCH', headers: auth, body: { trashed: true } }), 404, 'notFound')
  await requestJSON(`${api}/files/${dentro.id}?supportsAllDrives=true&fields=trashed`, { method: 'PATCH', headers: auth, body: { trashed: true } })
  assert.equal(mock.getItem(dentro.id).trashed, true)
})

// ───────────────────────────── download ─────────────────────────────

test('download: Range devolve exatamente os bytes do arquivo', async t => {
  const { mock, api, auth } = await setup(t)
  const size = 3 * MiB + 123
  const file = mock.addFile('cena.mov', 'root', { size, seed: 7 })
  const url = `${api}/files/${file.id}?alt=media&supportsAllDrives=true&acknowledgeAbuse=false`

  const r = await get(url, { headers: { ...auth, range: 'bytes=1000-2999999' }, expect: [206] })
  assert.equal(r.headers['content-range'], `bytes 1000-2999999/${size}`)
  assert.equal(r.headers['content-length'], '2999000')
  assert.equal(r.headers['accept-ranges'], 'bytes')
  assert.ok(r.buf.equals(mock.readContent(file.id, 1000, 3000000)))
  assert.ok(r.buf.equals(virtualBytes(7, 1000, 3000000)))

  const tail = await get(url, { headers: { ...auth, range: 'bytes=3000000-' }, expect: [206] })
  assert.equal(tail.headers['content-range'], `bytes 3000000-${size - 1}/${size}`)
  assert.ok(tail.buf.equals(mock.readContent(file.id, 3000000)))
  const suffix = await get(url, { headers: { ...auth, range: 'bytes=-100' }, expect: [206] })
  assert.ok(suffix.buf.equals(mock.readContent(file.id, size - 100)))
  const beyond = await get(url, { headers: { ...auth, range: `bytes=${size - 10}-${size + 5000}` }, expect: [206] })
  assert.equal(beyond.buf.length, 10)

  const whole = await get(url, { headers: auth })
  assert.equal(whole.status, 200)
  assert.equal(whole.buf.length, size)
  const meta = await requestJSON(`${api}/files/${file.id}?fields=md5Checksum,size`, { headers: auth })
  assert.equal(meta.md5Checksum, md5(whole.buf))
  assert.equal(await mock.contentMd5(file.id), md5(whole.buf))

  const e416 = await httpRequest(url, { headers: { ...auth, range: `bytes=${size}-` }, expect: [416] })
  assert.equal(e416.headers['content-range'], `bytes */${size}`)
  await drain(e416.body)

  // arquivo vazio: Range falha (416); sem Range vem 200 vazio
  const empty = mock.addFile('vazio.txt', 'root', { size: 0 })
  const emptyUrl = `${api}/files/${empty.id}?alt=media`
  await drain((await httpRequest(emptyUrl, { headers: { ...auth, range: 'bytes=0-' }, expect: [416] })).body)
  assert.equal((await get(emptyUrl, { headers: auth })).buf.length, 0)

  // conteúdo real (Buffer)
  const real = mock.addFile('nota.txt', 'root', { content: Buffer.from('olá, mundo') })
  const part = await get(`${api}/files/${real.id}?alt=media`, { headers: { ...auth, range: 'bytes=0-4' }, expect: [206] })
  assert.equal(part.buf.toString(), 'olá,')
  assert.equal(part.headers['content-type'], 'text/plain')

  // determinístico: mesma semente, mesmos bytes; sementes automáticas diferem
  const twin = mock.addFile('gemeo.mov', 'root', { size: 4096, seed: 7 })
  assert.ok(mock.readContent(twin.id).equals(mock.readContent(file.id, 0, 4096)))
  const a = mock.addFile('a.bin', 'root', { size: 4096 })
  const b = mock.addFile('b.bin', 'root', { size: 4096 })
  assert.ok(!mock.readContent(a.id).equals(mock.readContent(b.id)))

  const st = mock.stats()
  assert.equal(st.mediaGets, 9)
  assert.equal(st.rangeGets, 7)
  assert.equal(st.activeMediaConnections, 0)
  assert.equal(st.bytesServed, 2999000 + (size - 3000000) + 100 + 10 + size + 0 + 5)
  assert.equal(st.requests['files.media'], 9)
})

test('download: Docs, bloqueio do dono, cota do arquivo e exportação', async t => {
  const { mock, api, auth } = await setup(t)
  const doc = mock.addGoogleDoc('Roteiro', 'root', 'document', { size: 5000 })
  const bigDoc = mock.addGoogleDoc('Planilhão', 'root', 'spreadsheet', { size: 11 * 1000 * 1000 })
  const locked = mock.addFile('bloqueado.mov', 'root', { size: 10, canDownload: false })
  const hot = mock.addFile('viral.mov', 'root', { size: 10 })
  mock.setOptions({ downloadQuotaExceededIds: [hot.id] })

  let err = await rejectsWith(get(`${api}/files/${doc.id}?alt=media`, { headers: auth }), 403, 'fileNotDownloadable')
  assert.equal(err.message, 'Only files with binary content can be downloaded. Use Export with Docs Editors files.')
  await rejectsWith(get(`${api}/files/${locked.id}?alt=media`, { headers: auth }), 403, 'cannotDownloadFile')
  err = await rejectsWith(get(`${api}/files/${hot.id}?alt=media`, { headers: auth }), 403, 'downloadQuotaExceeded')
  assert.equal(classifyError(err).kind, 'quota')
  await rejectsWith(get(`${api}/files/1naoexiste?alt=media`, { headers: auth }), 404, 'notFound')

  const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  const exportUrl = `${api}/files/${doc.id}/export?mimeType=${encodeURIComponent(docx)}`
  const e1 = await get(exportUrl, { headers: auth })
  const e2 = await get(exportUrl, { headers: auth })
  assert.equal(e1.buf.length, 5000)
  assert.ok(e1.buf.equals(e2.buf))
  assert.equal(e1.headers['content-type'], docx)
  assert.equal(e1.headers['content-length'], undefined, 'exportação vem sem Content-Length')
  await rejectsWith(get(`${api}/files/${bigDoc.id}/export?mimeType=text/csv`, { headers: auth }), 403, 'exportSizeLimitExceeded')
  await rejectsWith(get(`${api}/files/${doc.id}/export?mimeType=image/png`, { headers: auth }), 400, 'badRequest')
  await rejectsWith(get(`${api}/files/${locked.id}/export?mimeType=text/plain`, { headers: auth }), 403, 'fileNotExportable')
})

test('download: Content-Range errado e Range ignorado', async t => {
  const { mock, api, auth } = await setup(t, { failures: { wrongRangeProb: 1 } })
  const size = 4 * MiB
  const file = mock.addFile('cena.mov', 'root', { size, seed: 3 })
  const url = `${api}/files/${file.id}?alt=media`
  for (let i = 0; i < 5; i++) {
    const start = 2 * MiB
    const r = await get(url, { headers: { ...auth, range: `bytes=${start}-${3 * MiB - 1}` }, expect: [206] })
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.headers['content-range'])
    assert.ok(m, r.headers['content-range'])
    const [a, b] = [Number(m[1]), Number(m[2])]
    assert.notEqual(a, start, 'o Content-Range deveria começar no lugar errado')
    assert.equal(Number(r.headers['content-length']), b - a + 1)
    assert.ok(r.buf.equals(mock.readContent(file.id, a, b + 1)), 'o corpo bate com o que o Content-Range diz')
  }
  assert.equal(mock.stats().faults.wrongRange, 5)

  mock.setOptions({ failures: {}, ignoreRange: true })
  const r = await get(url, { headers: { ...auth, range: 'bytes=100-199' }, expect: [200] })
  assert.equal(r.headers['content-range'], undefined)
  assert.equal(r.buf.length, size)
  assert.ok(r.buf.equals(mock.readContent(file.id)))
})

test('download: queda, trava, 5xx/429/403 e cliente que desiste não derrubam o mock', async t => {
  const { mock, api, auth } = await setup(t)
  const file = mock.addFile('x.mov', 'root', { size: 4 * MiB })
  const url = `${api}/files/${file.id}?alt=media`

  mock.setOptions({ failures: { dropDownloadProb: 1 } })
  for (let i = 0; i < 3; i++) {
    const res = await httpRequest(url, { headers: auth })
    await assert.rejects(res.body.arrayBuffer())
  }

  mock.setOptions({ failures: { stallDownloadProb: 1 } })
  const ac = new AbortController()
  const res = await httpRequest(url, { headers: auth, signal: ac.signal })
  let got = 0
  let last = Date.now()
  const reading = (async () => {
    for await (const chunk of res.body) {
      got += chunk.length
      last = Date.now()
    }
  })()
  while (Date.now() - last < 300) await sleep(50)
  ac.abort()
  await assert.rejects(reading)
  assert.ok(got < 4 * MiB)
  await waitFor(() => mock.stats().activeMediaConnections === 0)

  mock.setOptions({ failures: { error5xxProb: 1 } })
  let err = await rejectsWith(get(url, { headers: auth }))
  assert.ok([500, 503].includes(err.status))
  assert.ok(['backendError', 'internalError'].includes(err.reason))
  assert.equal(classifyError(err).kind, 'retry')
  mock.setOptions({ failures: { error429Prob: 1 } })
  err = await rejectsWith(get(url, { headers: auth }), 429, 'rateLimitExceeded')
  assert.equal(classifyError(err).kind, 'retry')
  mock.setOptions({ failures: { rateLimit403Prob: 1 } })
  err = await rejectsWith(get(url, { headers: auth }), 403)
  assert.ok(['userRateLimitExceeded', 'rateLimitExceeded'].includes(err.reason))
  assert.equal(classifyError(err).kind, 'retry')

  // cliente desiste no meio de um download normal (lento)
  mock.setOptions({ failures: {}, perConnectionBps: 512 * KiB })
  const ac2 = new AbortController()
  const slow = await httpRequest(url, { headers: auth, signal: ac2.signal })
  assert.equal(mock.stats().activeMediaConnections, 1)
  setTimeout(() => ac2.abort(), 200)
  await assert.rejects(slow.body.arrayBuffer())
  await waitFor(() => mock.stats().activeMediaConnections === 0)

  mock.setOptions({ perConnectionBps: 0 })
  const ok = await get(url, { headers: auth })
  assert.ok(ok.buf.equals(mock.readContent(file.id)))
  const st = mock.stats()
  assert.equal(st.faults.downloadDrops, 3)
  assert.equal(st.faults.downloadStalls, 1)
  assert.equal(st.activeMediaConnections, 0)
})

// ───────────────────────────── upload ─────────────────────────────

test('upload retomável em pedaços: 308 com Range e md5 no final', async t => {
  const { mock, api, auth } = await setup(t)
  const folder = mock.addFolder('Entrega')
  const data = crypto.randomBytes(MiB + 1000)
  const total = data.length
  const query = '&supportsAllDrives=true&fields=id,name,size,md5Checksum,parents,modifiedTime,mimeType'
  const uri = await initUpload(mock, auth, { name: 'final.mov', parents: [folder.id], modifiedTime: '2026-01-02T03:04:05.000Z' }, { length: total, query })
  assert.match(uri, /^http:\/\/127\.0\.0\.1:\d+\/upload\/drive\/v3\/files\?uploadType=resumable&upload_id=/)

  let r = await statusQuery(uri, total)
  assert.equal(r.status, 308)
  assert.equal(r.headers.range, undefined, 'nada gravado: 308 sem Range')

  r = await putChunk(uri, data.subarray(0, 512 * KiB), 0, total)
  assert.equal(r.status, 308)
  assert.equal(r.headers.range, 'bytes=0-524287')
  r = await putChunk(uri, data.subarray(512 * KiB, MiB), 512 * KiB, total)
  assert.equal(r.headers.range, `bytes=0-${MiB - 1}`)
  assert.equal((await statusQuery(uri, total)).committed, MiB)
  r = await putChunk(uri, data.subarray(MiB), MiB, total)
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, {
    id: r.json.id,
    name: 'final.mov',
    mimeType: 'video/quicktime',
    parents: [folder.id],
    size: String(total),
    md5Checksum: md5(data),
    modifiedTime: '2026-01-02T03:04:05.000Z',
  })
  assert.ok(mock.readContent(r.json.id).equals(data))
  assert.equal(await mock.contentMd5(r.json.id), md5(data))

  // consulta depois de terminar devolve o arquivo de novo
  const again = await statusQuery(uri, total)
  assert.equal(again.status, 200)
  assert.equal(again.json.id, r.json.id)

  // e baixar devolve os mesmos bytes
  const down = await get(`${api}/files/${r.json.id}?alt=media`, { headers: auth })
  assert.ok(down.buf.equals(data))

  const st = mock.stats()
  assert.equal(st.uploadSessionsCreated, 1)
  assert.equal(st.uploadPuts, 3)
  assert.equal(st.statusQueries, 3)
  assert.equal(st.bytesReceived, total)
})

test('upload num PUT só, arquivo vazio, cancelamento e validações da sessão', async t => {
  const { mock, auth } = await setup(t, { storageLimitBytes: 100 * MiB })
  const data = crypto.randomBytes(700 * KiB + 7)
  // sem fields na iniciação: a resposta final traz o arquivo completo
  let uri = await initUpload(mock, auth, { name: 'um.mov' }, { length: data.length })
  let r = await putChunk(uri, data, 0, data.length)
  assert.equal(r.status, 200)
  assert.equal(r.json.md5Checksum, md5(data))
  assert.equal(r.json.size, String(data.length))
  assert.deepEqual(r.json.parents, [mock.rootId])
  assert.equal(r.json.name, 'um.mov')
  assert.ok(r.json.modifiedTime && r.json.headRevisionId)

  // vazio: "bytes */0" sem corpo fecha a sessão
  uri = await initUpload(mock, auth, { name: 'vazio.txt' }, { length: 0 })
  r = await statusQuery(uri, 0)
  assert.equal(r.status, 200)
  assert.equal(r.json.size, '0')
  assert.equal(r.json.md5Checksum, 'd41d8cd98f00b204e9800998ecf8427e')

  // cancelamento: DELETE → 499 e a sessão some
  uri = await initUpload(mock, auth, { name: 'cancelado.mov' }, { length: data.length })
  await putChunk(uri, data.subarray(0, 256 * KiB), 0, data.length)
  const del = await httpRequest(uri, { method: 'DELETE', expect: [499] })
  await drain(del.body)
  await rejectsWith(statusQuery(uri, data.length), 404, 'notFound')

  // Authorization ausente vale (a URI é a credencial), mas inválida não
  uri = await initUpload(mock, auth, { name: 'auth.mov' }, { length: data.length })
  await rejectsWith(putChunk(uri, data.subarray(0, 256 * KiB), 0, data.length, { headers: { authorization: 'Bearer vencido' } }), 401, 'authError')
  r = await putChunk(uri, data.subarray(0, 256 * KiB), 0, data.length, { headers: auth })
  assert.equal(r.status, 308)

  // total diferente do X-Upload-Content-Length; Content-Range malformado; sessão desconhecida
  await rejectsWith(putChunk(uri, data.subarray(256 * KiB), 256 * KiB, data.length + 1), 400, 'badRequest')
  await rejectsWith(httpRequest(uri, { method: 'PUT', headers: { 'content-range': 'bytes lixo' }, body: 'x' }), 400, 'badRequest')
  await rejectsWith(statusQuery(uri.replace(/upload_id=[^&]+/, 'upload_id=inventado'), data.length), 404, 'notFound')

  // validações na iniciação
  const upload = mock.env.SOBEDESCE_DRIVE_UPLOAD
  const init = (meta, headers = {}, query = 'uploadType=resumable') =>
    httpRequest(`${upload}/files?${query}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json; charset=UTF-8', ...headers }, body: JSON.stringify(meta) })
  await rejectsWith(init({ name: 'x', parents: ['1naoexiste'] }), 404, 'notFound')
  const sub = mock.addFolder('A')
  await rejectsWith(init({ name: 'x', parents: [sub.id, 'root'] }), 403, 'cannotAddParent')
  const notFolder = mock.addFile('arquivo.mov', 'root', { size: 1 })
  await rejectsWith(init({ name: 'x', parents: [notFolder.id] }), 404, 'notFound')
  await rejectsWith(init({ name: 42 }), 400, 'parseError')
  await rejectsWith(init({ name: 'x' }, {}, 'uploadType=resumable&fields=id,md5'), 400, 'invalidParameter')
  const err = await rejectsWith(init({ name: 'grande.mov' }, { 'x-upload-content-length': String(200 * MiB) }), 403, 'storageQuotaExceeded')
  assert.equal(classifyError(err).kind, 'fatal')
  await rejectsWith(init({ name: 'x' }, {}, 'uploadType=media'), 400, 'badRequest')
  await rejectsWith(httpRequest(`${upload}/files?uploadType=resumable`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{lixo' }), 400, 'parseError')
  await rejectsWith(init({ name: 'x' }, { authorization: 'Bearer lixo' }), 401, 'authError')
})

test('upload: conexão que cai guarda só o que foi assentado; sobreposição, buraco e pedaço desalinhado', async t => {
  const { mock, auth } = await setup(t)
  const total = 2 * MiB
  const data = crypto.randomBytes(total)
  let uri = await initUpload(mock, auth, { name: 'queda.mov' }, { length: total })

  // manda 700 KiB de um PUT de 2 MiB e derruba a conexão
  const sent = 700 * KiB
  const before = mock.stats().bytesReceived
  const req = http.request(uri, { method: 'PUT', agent: false, headers: { 'content-range': `bytes 0-${total - 1}/${total}`, 'content-length': total } })
  req.on('error', () => {})
  req.write(data.subarray(0, sent))
  await waitFor(() => mock.stats().bytesReceived - before >= sent)
  req.destroy()

  let r = await statusQuery(uri, total)
  assert.equal(r.status, 308)
  assert.equal(r.headers.range, 'bytes=0-524287', '700 KiB recebidos → 512 KiB assentados (múltiplo de 256 KiB)')

  // sobreposição: recomeça antes do ponto assentado; o mock pula o que já tem
  r = await putChunk(uri, data.subarray(256 * KiB), 256 * KiB, total)
  assert.equal(r.status, 200)
  assert.equal(r.json.md5Checksum, md5(data))
  assert.ok(mock.readContent(r.json.id).equals(data))

  // buraco: começa depois do que o Google tem → 400
  uri = await initUpload(mock, auth, { name: 'buraco.mov' }, { length: total })
  let err = await rejectsWith(putChunk(uri, data.subarray(512 * KiB, MiB), 512 * KiB, total), 400, 'badRequest')
  assert.match(err.message, /exceeds already uploaded size of 0 byte/)

  // pedaço intermediário fora do múltiplo de 256 KiB → 400 (o final pode ter qualquer tamanho)
  err = await rejectsWith(putChunk(uri, data.subarray(0, 300000), 0, total), 400, 'badRequest')
  assert.match(err.message, /262144/)
  r = await putChunk(uri, data.subarray(0, 256 * KiB), 0, total)
  assert.equal(r.headers.range, 'bytes=0-262143')

  // granularidade maior: só múltiplos de 1 MiB ficam
  mock.setOptions({ uploadRetainGranularity: MiB })
  uri = await initUpload(mock, auth, { name: 'grao.mov' }, { length: total })
  const before2 = mock.stats().bytesReceived
  const req2 = http.request(uri, { method: 'PUT', agent: false, headers: { 'content-range': `bytes 0-${total - 1}/${total}`, 'content-length': total } })
  req2.on('error', () => {})
  req2.write(data.subarray(0, 1536 * KiB))
  await waitFor(() => mock.stats().bytesReceived - before2 >= 1536 * KiB)
  req2.destroy()
  r = await statusQuery(uri, total)
  assert.equal(r.committed, MiB)
  r = await putChunk(uri, data.subarray(MiB), MiB, total)
  assert.equal(r.json.md5Checksum, md5(data))
})

test('upload: falhas sorteadas (queda, trava, 5xx depois do corpo) não corrompem o arquivo', async t => {
  const { mock, auth } = await setup(t, { seed: 1234 })
  const total = 3 * MiB + 99
  const data = crypto.randomBytes(total)

  async function resume(uri) {
    for (let i = 0; i < 20; i++) {
      const s = await statusQuery(uri, total)
      if (s.status === 200) return s.json
      assert.equal(s.committed % (256 * KiB), 0, `offset assentado ${s.committed} fora do múltiplo de 256 KiB`)
      try {
        const r = await putChunk(uri, data.subarray(s.committed), s.committed, total, { signal: AbortSignal.timeout(1500) })
        if (r.status === 200) return r.json
      } catch {
        // queda/trava/5xx: pergunta de novo onde parou
      }
    }
    throw new Error('não terminou')
  }

  for (const failures of [{ dropUploadProb: 1 }, { stallUploadProb: 1 }, { error5xxProb: 1 }]) {
    const uri = await initUpload(mock, auth, { name: `${Object.keys(failures)[0]}.mov` }, { length: total })
    mock.setOptions({ failures })
    if (failures.stallUploadProb) {
      await assert.rejects(putChunk(uri, data, 0, total, { signal: AbortSignal.timeout(500) }))
    } else {
      await assert.rejects(putChunk(uri, data, 0, total))
    }
    mock.setOptions({ failures: {} })
    const s = await statusQuery(uri, total)
    if (s.status === 308) assert.equal(s.committed % (256 * KiB), 0)
    const file = await resume(uri)
    assert.equal(file.md5Checksum, md5(data))
    assert.ok(mock.readContent(file.id).equals(data))
  }
  const f = mock.stats().faults
  assert.equal(f.uploadDrops, 1)
  assert.equal(f.uploadStalls, 1)
  assert.equal(f.error5xx, 1)
})

test('upload: sessão expirada dá 404 e o limite diário dá 403 userRateLimitExceeded', async t => {
  const { mock, auth } = await setup(t)
  const data = crypto.randomBytes(1536 * KiB)

  let uri = await initUpload(mock, auth, { name: 'velho.mov' }, { length: data.length })
  mock.setOptions({ sessionTtlMs: 1 })
  await sleep(20)
  await rejectsWith(statusQuery(uri, data.length), 404, 'notFound')
  await rejectsWith(putChunk(uri, data.subarray(0, 256 * KiB), 0, data.length), 404, 'notFound')
  mock.setOptions({ sessionTtlMs: 7 * 24 * 3600 * 1000 })
  uri = await initUpload(mock, auth, { name: 'velho2.mov' }, { length: data.length })
  mock.expireUploadSessions()
  const gone = await rejectsWith(statusQuery(uri, data.length), 404, 'notFound')
  assert.equal(classifyError(gone).kind, 'notfound')

  // limite de 1 MiB "por dia": A cruza o limite e termina; B e novas sessões levam 403
  mock.setOptions({ uploadDailyLimitBytes: MiB })
  const uriA = await initUpload(mock, auth, { name: 'A.mov' }, { length: data.length })
  const dataB = data.subarray(0, MiB)
  const uriB = await initUpload(mock, auth, { name: 'B.mov' }, { length: dataB.length })
  assert.equal((await putChunk(uriA, data.subarray(0, 512 * KiB), 0, data.length)).status, 308)
  assert.equal((await putChunk(uriB, dataB.subarray(0, 512 * KiB), 0, dataB.length)).status, 308)
  assert.equal((await putChunk(uriA, data.subarray(512 * KiB, MiB), 512 * KiB, data.length)).status, 308) // cruzou aqui
  const done = await putChunk(uriA, data.subarray(MiB), MiB, data.length)
  assert.equal(done.status, 200, 'quem cruzou o limite termina')
  assert.equal(done.json.md5Checksum, md5(data))

  const err = await rejectsWith(putChunk(uriB, dataB.subarray(512 * KiB), 512 * KiB, dataB.length), 403, 'userRateLimitExceeded')
  assert.equal(err.message, 'User rate limit exceeded.')
  assert.equal(classifyError(err).kind, 'retry')
  assert.equal((await statusQuery(uriB, dataB.length)).committed, 512 * KiB, 'consulta de status continua valendo')
  await rejectsWith(initUpload(mock, auth, { name: 'C.mov' }, { length: 10 }), 403, 'userRateLimitExceeded')
  assert.equal(mock.stats().dailyUploadBytes, data.length + 512 * KiB)

  mock.resetDailyUsage()
  const finished = await putChunk(uriB, dataB.subarray(512 * KiB), 512 * KiB, dataB.length)
  assert.equal(finished.json.md5Checksum, md5(dataB))
})

test('upload: PATCH troca o conteúdo mantendo o id', async t => {
  const { mock, auth } = await setup(t)
  const file = mock.addFile('versao.mov', 'root', { size: 300 * KiB, seed: 1, md5: 'mentira' })
  const before = mock.getItem(file.id)
  assert.equal(before.md5, 'mentira')
  const data = crypto.randomBytes(700 * KiB)
  const count = mock.listAll().length
  const uri = await initUpload(mock, auth, { modifiedTime: '2025-05-05T05:05:05.000Z' }, { fileId: file.id, length: data.length, query: '&fields=id,name,size,md5Checksum,headRevisionId,modifiedTime' })
  assert.ok(uri.includes(`/files/${file.id}?uploadType=resumable&upload_id=`))
  const r = await putChunk(uri, data, 0, data.length)
  assert.equal(r.status, 200)
  assert.equal(r.json.id, file.id)
  assert.equal(r.json.name, 'versao.mov')
  assert.equal(r.json.size, String(data.length))
  assert.equal(r.json.md5Checksum, md5(data))
  assert.equal(r.json.modifiedTime, '2025-05-05T05:05:05.000Z')
  assert.notEqual(r.json.headRevisionId, before.headRevisionId)
  assert.ok(mock.readContent(file.id).equals(data))
  assert.equal(mock.listAll().length, count)

  await rejectsWith(initUpload(mock, auth, {}, { fileId: '1naoexiste', length: 1 }), 404, 'notFound')
  await rejectsWith(initUpload(mock, auth, { parents: ['root'] }, { fileId: file.id, length: 1 }), 403, 'fieldNotWritable')
})

// ───────────────────────────── banda e desempenho ─────────────────────────────

test('banda por conexão: 4 conexões em paralelo são bem mais rápidas que 1 (slow)', async t => {
  const { mock, api, auth } = await setup(t, { perConnectionBps: 4 * MiB })
  const size = 32 * MiB
  const file = mock.addFile('grande.mov', 'root', { size, seed: 99 })
  const url = `${api}/files/${file.id}?alt=media`
  const expected = await mock.contentMd5(file.id)

  let t0 = performance.now()
  const one = await get(url, { headers: auth })
  const tOne = performance.now() - t0
  assert.equal(md5(one.buf), expected)

  mock.resetStats()
  const part = size / 4
  t0 = performance.now()
  const parts = await Promise.all([0, 1, 2, 3].map(i =>
    get(url, { headers: { ...auth, range: `bytes=${i * part}-${(i + 1) * part - 1}` }, expect: [206] }),
  ))
  const tPar = performance.now() - t0
  assert.equal(md5(Buffer.concat(parts.map(p => p.buf))), expected)
  t.diagnostic(`1 conexão: ${(tOne / 1000).toFixed(2)} s; 4 conexões: ${(tPar / 1000).toFixed(2)} s`)
  assert.ok(tOne > 5000, `o limite por conexão não segurou (${tOne.toFixed(0)} ms)`)
  assert.ok(tOne / tPar >= 2, `paralelo só ${(tOne / tPar).toFixed(2)}× mais rápido`)
  assert.ok(mock.stats().maxActiveMediaConnections >= 4)

  // o corpo de um upload também é limitado por conexão
  mock.setOptions({ perConnectionBps: 2 * MiB })
  const data = crypto.randomBytes(2 * MiB)
  const uri = await initUpload(mock, auth, { name: 'lento.mov' }, { length: data.length })
  t0 = performance.now()
  const r = await putChunk(uri, data, 0, data.length)
  const tUp = performance.now() - t0
  assert.equal(r.json.md5Checksum, md5(data))
  assert.ok(tUp > 700, `upload não foi limitado (${tUp.toFixed(0)} ms)`)
})

test('desempenho: 512 MiB numa conexão sem limite e 32 conexões simultâneas', async t => {
  const { mock, api, auth } = await setup(t)
  const size = 512 * MiB
  const file = mock.addFile('enorme.mov', 'root', { size, seed: 2026 })
  const url = `${api}/files/${file.id}?alt=media`
  const md5Promise = mock.contentMd5(file.id) // worker thread, em paralelo

  const t0 = performance.now()
  const res = await httpRequest(url, { headers: auth })
  const hash = crypto.createHash('md5')
  let n = 0
  for await (const chunk of res.body) {
    hash.update(chunk)
    n += chunk.length
  }
  const secs = (performance.now() - t0) / 1000
  t.diagnostic(`512 MiB em ${secs.toFixed(2)} s (${(size / MiB / secs).toFixed(0)} MiB/s, com MD5 no cliente)`)
  assert.equal(n, size)
  assert.equal(hash.digest('hex'), await md5Promise)
  assert.ok(secs < 60)

  // 32 conexões ao mesmo tempo, cada uma num pedaço diferente (com limite por conexão para elas se sobreporem)
  mock.resetStats()
  mock.setOptions({ perConnectionBps: 8 * MiB })
  const piece = 2 * MiB
  const results = await Promise.all(Array.from({ length: 32 }, (_, i) =>
    get(url, { headers: { ...auth, range: `bytes=${i * piece}-${(i + 1) * piece - 1}` }, expect: [206] }),
  ))
  results.forEach((r, i) => assert.ok(r.buf.equals(virtualBytes(2026, i * piece, (i + 1) * piece)), `pedaço ${i}`))
  const st = mock.stats()
  assert.equal(st.rangeGets, 32)
  assert.equal(st.activeMediaConnections, 0)
  assert.ok(st.maxActiveMediaConnections >= 16, `só ${st.maxActiveMediaConnections} conexões ao mesmo tempo`)
  t.diagnostic(`máximo de conexões simultâneas: ${st.maxActiveMediaConnections}`)
})

// ───────────────────────────── utilidades exportadas ─────────────────────────────

test('virtualBytes, virtualMd5 e writeVirtualFile batem com o mock', async t => {
  const { mock, home, api, auth } = await setup(t, { latencyMs: 0 })
  const size = 20 * MiB + 5 // passa do limite do MD5 em linha → worker thread
  const file = mock.addFile('igual.mov', 'root', { size, seed: 'cena-42' })
  assert.equal(file.seed, 'cena-42')
  const local = await writeVirtualFile(path.join(home, 'igual.mov'), { size, seed: 'cena-42' })
  const localMd5 = md5(await fs.readFile(local))
  assert.equal(await virtualMd5('cena-42', size), localMd5)
  assert.equal(await mock.contentMd5(file.id), localMd5)
  const meta = await requestJSON(`${api}/files/${file.id}?fields=md5Checksum`, { headers: auth })
  assert.equal(meta.md5Checksum, localMd5)
  assert.ok(virtualBytes('cena-42', 65530, 65560).equals(mock.readContent(file.id, 65530, 65560)))

  // updateContent: nova versão com md5 e revisão novos
  const v2 = mock.updateContent(file.id, { content: Buffer.from('nova versão') })
  assert.notEqual(v2.headRevisionId, file.headRevisionId)
  assert.equal(await mock.contentMd5(file.id), md5(Buffer.from('nova versão')))

  // arquivo virtual gigante: metadados na hora (md5 provisório) e Range em deslocamentos > 4 GiB
  const hugeSize = 200 * 1024 ** 3
  const huge = mock.addFile('gigante.mov', 'root', { size: hugeSize, seed: 77 })
  let t0 = performance.now()
  const hugeMeta = await requestJSON(`${api}/files/${huge.id}?fields=size,md5Checksum`, { headers: auth })
  assert.ok(performance.now() - t0 < 2000)
  assert.equal(hugeMeta.size, String(hugeSize))
  assert.match(hugeMeta.md5Checksum, /^[0-9a-f]{32}$/)
  assert.equal(mock.getItem(huge.id).md5, hugeMeta.md5Checksum)
  const at = 150 * 1024 ** 3 + 12345
  const far = await get(`${api}/files/${huge.id}?alt=media`, { headers: { ...auth, range: `bytes=${at}-${at + MiB - 1}` }, expect: [206] })
  assert.equal(far.headers['content-range'], `bytes ${at}-${at + MiB - 1}/${hugeSize}`)
  assert.ok(far.buf.equals(virtualBytes(77, at, at + MiB)))

  // latência configurável
  mock.setOptions({ latencyMs: 150 })
  t0 = performance.now()
  await requestJSON(`${api}/files/${file.id}?fields=id`, { headers: auth })
  assert.ok(performance.now() - t0 >= 120)
})
