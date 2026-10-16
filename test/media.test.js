// Miniaturas, stream com Range e proxy de câmera (src/server/media.js) de ponta a ponta contra o Drive falso,
// com uma conta deste computador e uma conta `nuvem:` (site de contas falso).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { startApp } from '../src/index.js'
import { closeHttp } from '../src/net/http.js'
import { ThumbCache, parseClientRange, resizeThumbLink, thumbSize } from '../src/server/media.js'
import { makeTmpDir, waitFor, loginWithMock } from './helpers.js'
import { startMockDrive, makePng } from './mock-drive.js'
import { startMockCloud } from './mock-cloud.js'

let mock, site, home, app, local, key
const F = {}

const keepAwake = { active: false, setActive() {}, stop() {} }

function call(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${app.port}`, ...headers }
    let data = null
    if (body !== undefined) {
      data = JSON.stringify(body)
      h['content-type'] = 'application/json'
      h['content-length'] = Buffer.byteLength(data)
    }
    const req = http.request({ host: '127.0.0.1', port: app.port, method, path: p, headers: h, agent: false }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        let json = null
        try {
          json = JSON.parse(buf.toString('utf8'))
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, buf, json })
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}
const get = (p, opts) => call('GET', p, opts)
const q = params => new URLSearchParams(params).toString()
const thumbUrl = (account, id, extra = {}) => `/api/drive/thumb?${q({ account, id, k: key, ...extra })}`
const streamUrl = (account, id, extra = {}) => `/api/drive/stream?${q({ account, id, k: key, ...extra })}`

before(async () => {
  home = await makeTmpDir()
  mock = await startMockDrive()
  mock.applyEnv()
  site = await startMockCloud({ drive: mock })
  app = await startApp({
    home,
    port: 0,
    open: false,
    quiet: true,
    cloudOptions: { pollMs: 20, retryBaseMs: 5, refreshEveryMs: 0, deviceName: 'Teste', platform: 'darwin', baseUrl: site.url },
    managerOptions: { keepAwake },
    serverOptions: { log: () => {} },
  })
  await app.auth.setClientCredentials(mock.client)
  local = (await loginWithMock(app.auth)).id

  // Conta SOBEDESCE: entra pelo fluxo de dispositivo.
  const r = await call('POST', '/api/cloud/login', { body: {} })
  site.approve(r.json.cloud.login.codigo)
  await waitFor(() => app.auth.listAccounts().some(a => a.id === 'nuvem:g1'), { timeoutMs: 10_000 })

  const brutos = mock.addFolder('Brutos')
  F.brutos = brutos
  F.thumbPng = makePng(32, 18)
  F.video = mock.addFile('Entrevista.mp4', brutos.id, {
    content: Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7 + 3) % 251)),
    thumbnail: F.thumbPng,
    videoMediaMetadata: { width: 3840, height: 2160, durationMillis: 12_500 },
  })
  F.photo = mock.addFile('Still.jpg', brutos.id, { size: 50_000, seed: 9, thumbnail: makePng(20, 30), imageMediaMetadata: { width: 6000, height: 4000, cameraMake: 'Canon', cameraModel: 'EOS R5' } })
  F.plain = mock.addFile('Notas.txt', brutos.id, { content: 'só texto' })
  F.html = mock.addFile('pagina.html', brutos.id, { content: '<script>alert(1)</script>', mimeType: 'text/html' })
  // Proxy de câmera: BRAW sem miniatura + Proxy/<mesmo nome>.mp4 com miniatura; MXF com proxy .mov na mesma pasta.
  F.braw = mock.addFile('A001_08221425_C001.braw', brutos.id, { size: 4_000_000, seed: 3 })
  F.proxyDir = mock.addFolder('Proxy', brutos.id)
  F.proxy = mock.addFile('A001_08221425_C001.mp4', F.proxyDir.id, { content: Buffer.from('proxy-bytes-0123456789'), thumbnail: makePng(16, 9) })
  mock.addFile('A001_08221425_C001_extra.mp4', F.proxyDir.id, { content: Buffer.from('não é o proxy') })
  F.mxf = mock.addFile('B002_C014.mxf', brutos.id, { size: 1_000_000, seed: 4 })
  F.mxfProxy = mock.addFile('B002_C014.mov', brutos.id, { content: Buffer.from('mov-proxy') })
  F.lonely = mock.addFile('C003_C001.braw', brutos.id, { size: 1000, seed: 5 })

  key = (await get('/api/state')).json.media.key
})

after(async () => {
  await app?.shutdown()
  await site?.close().catch(() => {})
  await mock?.close()
  await fs.rm(home, { recursive: true, force: true, maxRetries: 3 })
  await closeHttp()
})

test('ajudantes: tamanho da miniatura, link redimensionado e Range do navegador', () => {
  assert.equal(thumbSize(undefined), 220)
  assert.equal(thumbSize(200), 220)
  assert.equal(thumbSize(300), 320)
  assert.equal(thumbSize(99999), 2000)
  assert.equal(resizeThumbLink('https://lh3.googleusercontent.com/drive-storage/AJQ=s220', 1600), 'https://lh3.googleusercontent.com/drive-storage/AJQ=s1600')
  assert.equal(resizeThumbLink('https://x.googleusercontent.com/abc', 64), 'https://x.googleusercontent.com/abc=s64')
  assert.equal(parseClientRange('bytes=0-'), 'bytes=0-')
  assert.equal(parseClientRange('bytes=-500'), 'bytes=-500')
  assert.equal(parseClientRange('bytes=10-5'), null)
  assert.equal(parseClientRange('bytes=0-1,5-9'), null)
  assert.equal(parseClientRange('items=0-1'), null)
})

test('listagem traz miniatura, dimensões e dono', async () => {
  const r = await get(`/api/drive/${encodeURIComponent(local)}/list?folderId=${F.brutos.id}`)
  assert.equal(r.status, 200)
  const by = Object.fromEntries(r.json.items.map(i => [i.name, i]))
  assert.equal(by['Entrevista.mp4'].hasThumbnail, true)
  assert.deepEqual(by['Entrevista.mp4'].video, { width: 3840, height: 2160, durationMs: 12_500 })
  assert.equal(by['Still.jpg'].image.camera, 'Canon EOS R5')
  assert.equal(by['Notas.txt'].hasThumbnail, false)
  assert.equal(by['Notas.txt'].owner.email, 'ana.montadora@example.com')
})

test('rotas de mídia: sem a chave do servidor local, chave errada ou outro site = 403', async () => {
  const before = mock.stats().thumbGets
  let r = await get(`/api/drive/thumb?${q({ account: local, id: F.video.id })}`)
  assert.equal(r.status, 403)
  r = await get(thumbUrl(local, F.video.id, { k: 'x'.repeat(key.length) }))
  assert.equal(r.status, 403)
  r = await get(thumbUrl(local, F.video.id), { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(r.status, 403)
  r = await get(`/api/drive/stream?${q({ account: local, id: F.video.id })}`, { headers: { range: 'bytes=0-9' } })
  assert.equal(r.status, 403)
  // Sem a chave não dá nem para saber se a conta existe.
  r = await get(`/api/drive/thumb?${q({ account: 'nao-existe', id: F.video.id })}`)
  assert.equal(r.status, 403)
  // Host de fora continua barrado antes de tudo (DNS rebinding).
  r = await get(thumbUrl(local, F.video.id), { headers: { host: 'evil.example' } })
  assert.equal(r.status, 403)
  assert.equal(mock.stats().thumbGets, before)
  // Com a chave: conta desconhecida 404, id inválido 400.
  r = await get(thumbUrl('nao-existe', F.video.id))
  assert.equal(r.status, 404)
  r = await get(thumbUrl(local, '../etc'))
  assert.equal(r.status, 400)
})

test('miniatura: vem do Google com o token, depois da memória; tamanho pedido sobe para o próximo', async () => {
  const t0 = mock.stats().thumbGets
  let r = await get(thumbUrl(local, F.video.id, { s: 300, v: '1' }))
  assert.equal(r.status, 200, r.buf.toString())
  assert.equal(r.headers['content-type'], 'image/png')
  assert.equal(r.headers['x-sobedesce-cache'], 'google')
  assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin')
  assert.ok(r.buf.equals(F.thumbPng))
  assert.equal(mock.stats().thumbGets, t0 + 1)
  assert.equal(mock.stats().thumbSizes.at(-1), 320)

  r = await get(thumbUrl(local, F.video.id, { s: 300, v: '1' }))
  assert.equal(r.headers['x-sobedesce-cache'], 'memory')
  assert.ok(r.buf.equals(F.thumbPng))
  assert.equal(mock.stats().thumbGets, t0 + 1)

  // Vários pedidos iguais ao mesmo tempo: uma ida ao Google só.
  const many = await Promise.all(Array.from({ length: 6 }, () => get(thumbUrl(local, F.video.id, { s: 2000, v: '1' }))))
  assert.ok(many.every(x => x.status === 200))
  assert.equal(mock.stats().thumbGets, t0 + 2)
  assert.equal(mock.stats().thumbSizes.at(-1), 2000)

  // Sem miniatura: 404 com mensagem.
  r = await get(thumbUrl(local, F.plain.id))
  assert.equal(r.status, 404)
  assert.match(r.json.error, /miniatura/)
})

test('miniatura: link vencido é pedido de novo ao Drive; cache no disco sobrevive a reabrir o app', async () => {
  await get(thumbUrl(local, F.photo.id, { v: 'a' })) // guarda o link da listagem/consulta
  mock.expireThumbnailLinks()
  const r = await get(thumbUrl(local, F.photo.id, { v: 'b' }))
  assert.equal(r.status, 200, r.buf.toString())
  assert.equal(r.headers['x-sobedesce-cache'], 'google')

  // Disco: um cache novo na mesma pasta acha o que o primeiro gravou.
  const files = await fs.readdir(app.paths.thumbs)
  assert.ok(files.some(f => f.endsWith('.img')))
  const fresh = new ThumbCache({ dir: app.paths.thumbs })
  const k = ThumbCache.key([local, F.photo.id, '220', 'b'])
  const hit = await fresh.get(k)
  assert.equal(hit?.source, 'disk')
  assert.equal(hit.type, 'image/png')
})

test('ThumbCache: memória com teto (LRU) e disco podado pelas mais antigas', async () => {
  const dir = await makeTmpDir('sobedesce-thumbs-')
  try {
    const png = makePng(40, 40)
    const c = new ThumbCache({ dir, memoryBytes: png.length * 2 + 10, diskBytes: png.length * 3 })
    for (let i = 0; i < 5; i++) {
      await c.put(ThumbCache.key(['a', String(i)]), { buf: png, type: 'image/png' })
      await new Promise(r => setTimeout(r, 5))
    }
    const st = c.stats()
    assert.equal(st.memoryItems, 2)
    assert.ok(st.diskBytes <= png.length * 3, JSON.stringify(st))
    assert.equal(await c.get(ThumbCache.key(['a', '0'])), null) // a mais antiga saiu do disco
    assert.equal((await c.get(ThumbCache.key(['a', '4']))).source, 'memory')
    assert.equal((await fs.readdir(dir)).filter(n => n.endsWith('.img')).length, st.diskItems)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('stream: Range devolve 206 com os bytes certos; sem Range 200; sufixo, 416 e HEAD', async () => {
  const size = F.video.size
  let r = await get(streamUrl(local, F.video.id), { headers: { range: 'bytes=1000-1999' } })
  assert.equal(r.status, 206)
  assert.equal(r.headers['content-range'], `bytes 1000-1999/${size}`)
  assert.equal(r.headers['content-length'], '1000')
  assert.equal(r.headers['accept-ranges'], 'bytes')
  assert.equal(r.headers['content-type'], 'video/mp4')
  assert.ok(r.buf.equals(mock.readContent(F.video.id, 1000, 2000)))

  r = await get(streamUrl(local, F.video.id), { headers: { range: 'bytes=0-' } })
  assert.equal(r.status, 206)
  assert.equal(r.buf.length, size)

  r = await get(streamUrl(local, F.video.id), { headers: { range: 'bytes=-500' } })
  assert.equal(r.status, 206)
  assert.ok(r.buf.equals(mock.readContent(F.video.id, size - 500)))

  r = await get(streamUrl(local, F.video.id))
  assert.equal(r.status, 200)
  assert.ok(r.buf.equals(mock.readContent(F.video.id)))

  r = await get(streamUrl(local, F.video.id), { headers: { range: `bytes=${size + 10}-` } })
  assert.equal(r.status, 416)
  assert.equal(r.headers['content-range'], `bytes */${size}`)

  r = await call('HEAD', streamUrl(local, F.video.id), { headers: { range: 'bytes=0-99' } })
  assert.equal(r.status, 206)
  assert.equal(r.headers['content-length'], '100')
  assert.equal(r.buf.length, 0)

  // HTML do Drive nunca roda com a origem do app.
  r = await get(streamUrl(local, F.html.id))
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'application/octet-stream')
  assert.match(r.headers['content-security-policy'], /sandbox/)
  assert.equal(r.headers['x-content-type-options'], 'nosniff')
})

test('stream: quem fecha no meio não derruba nada', async () => {
  const big = mock.addFile('Grande.mov', F.brutos.id, { size: 64 * 1024 * 1024, seed: 11 })
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: streamUrl(local, big.id), headers: { host: `127.0.0.1:${app.port}` }, agent: false }, res => {
      assert.equal(res.statusCode, 200)
      res.once('data', () => {
        req.destroy()
        resolve()
      })
    })
    req.on('error', err => (err.code === 'ECONNRESET' ? resolve() : reject(err)))
    req.end()
  })
  await waitFor(() => mock.stats().activeMediaConnections === 0, { message: 'a conexão com o Drive ficou aberta' })
  const r = await get(streamUrl(local, F.video.id), { headers: { range: 'bytes=0-9' } })
  assert.equal(r.status, 206)
})

test('conta nuvem: miniatura e stream com o token que vem do site', async () => {
  const before = site.stats.token
  let r = await get(thumbUrl('nuvem:g1', F.video.id, { v: 'nuvem' }))
  assert.equal(r.status, 200, r.buf.toString())
  assert.ok(r.buf.equals(F.thumbPng))
  r = await get(streamUrl('nuvem:g2', F.video.id), { headers: { range: 'bytes=10-19' } })
  assert.equal(r.status, 206)
  assert.ok(r.buf.equals(mock.readContent(F.video.id, 10, 20)))
  assert.ok(site.stats.token > before, 'o token veio do site de contas')
  // Token vencido no Google: renova e segue.
  mock.expireAccessTokens()
  r = await get(streamUrl('nuvem:g1', F.video.id), { headers: { range: 'bytes=0-4' } })
  assert.equal(r.status, 206)
})

test('proxy de câmera: subpasta Proxy, mesma pasta, nenhum; cache por pasta', async () => {
  const acc = encodeURIComponent(local)
  const q0 = app.server.ctx.media.stats().proxyQueries
  let r = await get(`/api/drive/${acc}/proxy?id=${F.braw.id}`)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.proxy.id, F.proxy.id)
  assert.equal(r.json.proxy.hasThumbnail, true)
  assert.equal(app.server.ctx.media.stats().proxyQueries, q0 + 2) // subpastas + nome

  r = await get(`/api/drive/${acc}/proxy?id=${F.mxf.id}`)
  assert.equal(r.json.proxy.id, F.mxfProxy.id)
  assert.equal(app.server.ctx.media.stats().proxyQueries, q0 + 3) // a pasta já era conhecida: só o nome

  r = await get(`/api/drive/${acc}/proxy?id=${F.lonely.id}`)
  assert.equal(r.json.proxy, null)

  r = await get(`/api/drive/${acc}/proxy?id=${F.braw.id}`)
  assert.equal(app.server.ctx.media.stats().proxyQueries, q0 + 4) // repetido: cache

  // O proxy toca pelo mesmo stream e tem miniatura própria; o original não tem.
  r = await get(streamUrl(local, F.proxy.id), { headers: { range: 'bytes=0-4' } })
  assert.equal(r.status, 206)
  assert.equal(r.buf.toString(), 'proxy')
  r = await get(thumbUrl(local, F.braw.id))
  assert.equal(r.status, 404)
  r = await get(thumbUrl(local, F.proxy.id))
  assert.equal(r.status, 200)

  // Baixar o original continua sendo o original.
  const dest = path.join(home, 'Baixados')
  r = await call('POST', '/api/transfers/download', { body: { accountId: local, items: [{ id: F.braw.id }], destDir: dest } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.count, 1)
  assert.equal(r.json.bytes, F.braw.size)
})
