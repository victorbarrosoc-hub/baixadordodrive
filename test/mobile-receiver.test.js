// Recepção pelo Wi-Fi ("Receber do celular"): o segundo servidor (só /m/*, protegido por código), envio em pedaços com
// retomada, o envio direto do Atalho do iPhone, a entrega para a fila do Drive (MD5 conferido no Drive falso),
// nomes perigosos, corpo maior que o declarado, ligar/desligar pelo ajuste, código novo e retomada depois de reiniciar.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { startApp } from '../src/index.js'
import { cloudUrl } from '../src/config.js'
import { closeHttp } from '../src/net/http.js'
import { PARTS_DIR } from '../src/mobile/receiver.js'
import { setupDrive, makeTmpDir, waitFor } from './helpers.js'

const KiB = 1024
const MiB = 1024 * 1024
const keepAwake = { active: false, setActive() {}, stop() {} }

let env
let app
let stage
let folder

async function boot() {
  const a = await startApp({
    home: env.home,
    port: 0,
    open: false,
    quiet: true,
    managerOptions: { keepAwake, taskOptions: { upload: { retryBaseMs: 5 } } },
    serverOptions: { log: () => {} },
    mobileOptions: { port: 0, host: '127.0.0.1', log: () => {} },
  })
  await a.settings.update({ keepAwake: false, mobileStagingDir: stage, mobileReceive: true })
  await a.mobile.status() // espera a porta abrir
  return a
}

before(async () => {
  env = await setupDrive()
  stage = await makeTmpDir('sobedesce-recebidos-')
  folder = env.mock.addFolder('Do Celular')
  app = await boot()
})

after(async () => {
  await app?.shutdown()
  await env?.cleanup()
  if (stage) await fs.rm(stage, { recursive: true, force: true, maxRetries: 3 })
  await closeHttp()
})

// ─────────── HTTP cru ───────────

/**
 * Requisição com controle total. `body`: Buffer/string/objeto (JSON). `chunked`: sem Content-Length.
 * `cutAfter`: escreve só esses bytes do corpo e derruba a conexão (Wi-Fi caindo no meio).
 */
function raw(method, p, { port = app.mobile.port, body, headers = {}, chunked = false, cutAfter = null } = {}) {
  return new Promise((resolve, reject) => {
    let data = body
    const h = { ...headers }
    if (data != null && !Buffer.isBuffer(data) && typeof data !== 'string') {
      data = JSON.stringify(data)
      h['content-type'] ??= 'application/json'
    }
    if (data != null) data = Buffer.from(data)
    if (data != null && !chunked) h['content-length'] ??= data.length
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json })
      })
      res.on('error', reject)
    })
    req.on('error', err => (cutAfter != null ? resolve({ status: 0, error: err }) : reject(err)))
    if (cutAfter != null) {
      req.write(data.subarray(0, cutAfter), () => setTimeout(() => req.destroy(), 50))
      return
    }
    if (data != null) req.write(data)
    req.end()
  })
}

const code = () => app.mobile.code
const auth = (extra = {}) => ({ 'x-sobedesce-code': code(), ...extra })
const mget = (p, opts = {}) => raw('GET', p, { ...opts, headers: { ...auth(), ...(opts.headers || {}) } })
const create = body => raw('POST', '/m/api/uploads', { body, headers: auth() })
const put = (id, offset, data, opts = {}) => raw('PUT', `/m/api/uploads/${id}`, { body: data, ...opts, headers: { ...auth({ 'upload-offset': String(offset), 'content-type': 'application/octet-stream' }), ...(opts.headers || {}) } })
const main = (method, p, body) => raw(method, p, { port: app.port, body: body ?? (method === 'GET' ? undefined : {}), headers: { host: `127.0.0.1:${app.port}`, 'content-type': 'application/json' } })

const md5 = buf => crypto.createHash('md5').update(buf).digest('hex')

/** Espera o envio pro Drive terminar e devolve o arquivo do Drive falso. */
async function driveDone(id, { timeoutMs = 20_000 } = {}) {
  let last
  await waitFor(
    async () => {
      last = (await mget(`/m/api/uploads/${id}`)).json
      return last?.drive?.status === 'completed' || last?.drive?.status === 'skipped' || last?.drive?.status === 'failed'
    },
    { timeoutMs, intervalMs: 50, message: `o envio pro Drive não terminou: ${JSON.stringify(last)}` },
  )
  assert.equal(last.drive.status, 'completed', JSON.stringify(last.drive))
  assert.ok(last.drive.fileId)
  return { view: last, item: env.mock.getItem(last.drive.fileId) }
}

// ─────────── testes ───────────

test('sem código → 401; código errado → 401; só /m/*; a API principal não aparece na rede', async () => {
  const none = await raw('GET', '/m/api/info')
  assert.equal(none.status, 401)
  assert.match(none.json.error, /código/i)

  const wrong = await raw('GET', '/m/api/info', { headers: { 'x-sobedesce-code': 'A'.repeat(43) } })
  assert.equal(wrong.status, 401)
  const wrongQuery = await raw('GET', `/m/api/info?t=${code().slice(0, -1)}x`)
  assert.equal(wrongQuery.status, 401)
  const page = await raw('GET', '/m/')
  assert.equal(page.status, 401)
  assert.match(page.headers['content-type'], /text\/html/)

  // Mesmo com o código certo, nada fora de /m/.
  for (const p of ['/api/state', '/api/settings', '/', '/index.html', '/vendor/preact-htm.js']) {
    const r = await raw('GET', `${p}?t=${code()}`, { headers: auth() })
    assert.equal(r.status, 404, p)
  }

  const info = await mget('/m/api/info')
  assert.equal(info.status, 200)
  assert.equal(info.json.account.email, env.account.email)
  assert.equal(info.json.folder.id, 'root')
  assert.ok(info.json.mac.name)

  // A página com ?t= grava o cookie; os arquivos da interface vêm com ele (e sem ele, não).
  const index = await raw('GET', `/m/?t=${code()}`)
  assert.equal(index.status, 200)
  assert.match(index.text, /<script src="lan-config\.js"><\/script>/)
  assert.doesNotMatch(index.text, /rel="manifest"/)
  assert.match(index.headers['content-security-policy'], /connect-src 'self'/)
  const cookie = String(index.headers['set-cookie']).split(';')[0]
  assert.match(String(index.headers['set-cookie']), /HttpOnly/i)
  assert.match(String(index.headers['set-cookie']), /SameSite=Strict/i)
  assert.equal((await raw('GET', '/m/app.js', { headers: { cookie } })).status, 200)
  assert.equal((await raw('GET', '/m/lib/uploader.js', { headers: { cookie } })).status, 200)
  assert.equal((await raw('GET', '/m/app.js')).status, 401)
  const cfg = await raw('GET', '/m/lan-config.js', { headers: { cookie } })
  assert.equal(cfg.status, 200)
  assert.match(cfg.text, /__SOBEDESCE_LAN__/)
  assert.ok(cfg.text.includes(code()))
  // O cookie não abre a API (lá só vale ?t= ou o header), e nada além da casca do app é servido.
  assert.equal((await raw('GET', '/m/api/info', { headers: { cookie } })).status, 401)
  for (const p of ['/m/dev-server.mjs', '/m/README.md', '/m/vercel.json', '/m/sw.js', '/m/../package.json', '/m/%2e%2e/package.json', '/m/lib/../../package.json']) {
    const r = await raw('GET', p, { headers: { cookie } })
    assert.equal(r.status, 404, p)
  }
})

test('envio em pedaços: 409 com o ponto certo, queda no meio, retomada e entrega no Drive (MD5 confere)', async () => {
  const data = crypto.randomBytes(3 * MiB + 123)
  const name = 'A001_C002 Entrevista.mov'
  const meta = { name, size: data.length, lastModified: Date.now(), folderId: folder.id, folderName: 'Meu Drive / Do Celular' }

  const first = await create(meta)
  assert.equal(first.status, 200, first.text)
  const { id } = first.json
  assert.equal(first.json.offset, 0)
  assert.equal(first.json.status, 'receiving')

  let r = await put(id, 0, data.subarray(0, 1 * MiB))
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.offset, 1 * MiB)

  // Ponto errado: 409 dizendo onde continuar.
  r = await put(id, 0, data.subarray(0, 1000))
  assert.equal(r.status, 409)
  assert.equal(r.json.offset, 1 * MiB)
  r = await put(id, 2 * MiB, data.subarray(2 * MiB, 2 * MiB + 10))
  assert.equal(r.status, 409)
  assert.equal(r.json.offset, 1 * MiB)

  // O Wi-Fi cai no meio de um pedaço: o que chegou fica.
  const cut = 300 * KiB
  await put(id, 1 * MiB, data.subarray(1 * MiB, 2 * MiB), { cutAfter: cut })
  let offset = 0
  await waitFor(async () => {
    offset = (await mget(`/m/api/uploads/${id}`)).json.offset
    return offset > 1 * MiB
  }, { message: 'o pedaço interrompido não foi gravado' })
  assert.ok(offset <= 1 * MiB + cut, `offset ${offset}`)

  // A página recarregou: escolher o mesmo arquivo de novo continua o mesmo recebimento.
  const again = await create(meta)
  assert.equal(again.json.id, id)
  assert.equal(again.json.offset, offset)

  r = await put(id, offset, data.subarray(offset))
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.offset, data.length)
  assert.equal(r.json.status, 'received')
  assert.ok(r.json.drive)

  const { item } = await driveDone(id)
  assert.equal(item.name, name)
  assert.equal(item.parents[0], folder.id)
  assert.equal(item.md5, md5(data))
  assert.equal(await env.mock.contentMd5(item.id), md5(data))

  // No computador: o arquivo com o nome certo, nenhum pedaço sobrando, e a transferência no lote "Do celular".
  assert.equal(md5(await fs.readFile(path.join(stage, name))), md5(data))
  assert.deepEqual(await fs.readdir(path.join(stage, PARTS_DIR)), [])
  const t = app.manager.snapshot().transfers.find(x => x.local?.path === path.join(stage, name))
  assert.ok(t)
  assert.equal(t.status, 'completed')
  assert.equal(t.verify?.state, 'ok')
  assert.equal(app.manager.snapshot().batches.find(b => b.id === t.batchId)?.label, 'Do celular')
  // Arquivo que já chegou inteiro não aceita mais pedaços.
  r = await put(id, data.length, Buffer.alloc(0))
  assert.equal(r.status, 409)
})

test('dois PUTs do mesmo arquivo: o novo derruba o que ficou pendurado e continua do ponto confirmado', async () => {
  const data = crypto.randomBytes(2 * MiB)
  const { json } = await create({ name: 'pendurado.bin', size: data.length, folderId: folder.id })
  // Primeira conexão manda metade e fica parada (sem fechar), como um Wi-Fi que sumiu sem avisar.
  const stuck = http.request({ host: '127.0.0.1', port: app.mobile.port, method: 'PUT', path: `/m/api/uploads/${json.id}`, agent: false, headers: { ...auth({ 'upload-offset': '0' }), 'content-length': data.length } })
  stuck.on('error', () => {})
  stuck.write(data.subarray(0, 512 * KiB))
  await new Promise(resolve => setTimeout(resolve, 150))
  // O celular desistiu dela e manda de novo a partir do 0: o computador grava o que tinha e diz o ponto.
  let r = await put(json.id, 0, data)
  if (r.status === 409) {
    assert.ok(r.json.offset > 0 && r.json.offset <= 512 * KiB)
    r = await put(json.id, r.json.offset, data.subarray(r.json.offset))
  }
  assert.equal(r.status, 200, r.text)
  assert.equal(r.json.status, 'received')
  stuck.destroy()
  const { item } = await driveDone(json.id)
  assert.equal(item.md5, md5(data))
})

test('o ponto confirmado (resposta e mobile-uploads.json) só inclui bytes que já passaram pelo fdatasync', async () => {
  const data = crypto.randomBytes(3 * MiB)
  const { json } = await create({ name: 'queda de energia.mov', size: data.length, folderId: folder.id })
  const req = http.request({ host: '127.0.0.1', port: app.mobile.port, method: 'PUT', path: `/m/api/uploads/${json.id}`, agent: false, headers: { ...auth({ 'upload-offset': '0' }), 'content-length': data.length } })
  const done = new Promise(resolve => req.on('response', res => {
    const chunks = []
    res.on('data', c => chunks.push(c))
    res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
  }))
  req.on('error', () => {})
  // Mais que o grupo de gravação (1 MiB): o computador já gravou parte, mas ainda não sincronizou nem terminou.
  req.write(data.subarray(0, 2 * MiB))
  await waitFor(async () => (await app.mobile.status()).receiving.some(r => r.id === json.id && r.offset >= 1 * MiB), { message: 'a tela do computador mostra o progresso ao vivo' })
  const view = (await mget(`/m/api/uploads/${json.id}`)).json
  assert.equal(view.offset, 0, 'o ponto confirmado não inclui bytes sem fdatasync')
  await new Promise(resolve => setTimeout(resolve, 700)) // dá tempo da gravação agrupada do registro
  const disk = JSON.parse(await fs.readFile(path.join(env.home, 'mobile-uploads.json'), 'utf8'))
  assert.equal(disk.uploads.find(u => u.id === json.id).offset, 0, 'nem no disco')
  req.end(data.subarray(2 * MiB))
  const res = await done
  assert.equal(res.offset, data.length)
  assert.equal(res.status, 'received')
  const { item } = await driveDone(json.id)
  assert.equal(item.md5, md5(data))
})

test('Atalho do iPhone: corpo inteiro no POST /m/api/drop, nome por ?name= e extensão pelo tipo', async () => {
  const data = crypto.randomBytes(700 * KiB + 5)
  const r = await raw('POST', `/m/api/drop?t=${code()}&name=${encodeURIComponent('Vídeo do Show')}&folderId=${folder.id}`, { body: data, headers: { 'content-type': 'video/quicktime' } })
  assert.equal(r.status, 200, r.text)
  assert.match(r.headers['content-type'], /text\/plain/)
  assert.match(r.text, /^Recebido no computador: Vídeo do Show\.mov \(.+\)\. Subindo pro Drive\.$/)
  await waitFor(() => env.mock.listAll().some(it => it.name === 'Vídeo do Show.mov' && it.parents[0] === folder.id), { timeoutMs: 20_000, message: 'o arquivo do Atalho não chegou ao Drive' })
  const item = env.mock.listAll().find(it => it.name === 'Vídeo do Show.mov')
  await waitFor(async () => app.manager.snapshot().transfers.some(t => t.target?.fileId === item.id && t.status === 'completed'), { timeoutMs: 20_000 })
  assert.equal(await env.mock.contentMd5(item.id), md5(data))

  // Sem código também não entra pelo Atalho; corpo sem tamanho (chunked) também é aceito.
  assert.equal((await raw('POST', `/m/api/drop?name=x`, { body: data })).status, 401)
  const chunked = await raw('POST', `/m/api/drop?t=${code()}&name=sem-tamanho.bin&folderId=${folder.id}`, { body: data.subarray(0, 1000), chunked: true, headers: { accept: 'application/json' } })
  assert.equal(chunked.status, 200, chunked.text)
  assert.equal(chunked.json.size, 1000)
  // Corpo "Formulário" (multipart) embrulharia o arquivo: recusado com a dica certa, nada fica para trás.
  const form = await raw('POST', `/m/api/drop?t=${code()}&name=form.bin`, { body: '--x\r\n\r\nabc\r\n--x--', headers: { 'content-type': 'multipart/form-data; boundary=x' } })
  assert.equal(form.status, 400)
  assert.match(form.text, /Arquivo \(não Formulário\)/)
  assert.deepEqual(await fs.readdir(path.join(stage, PARTS_DIR)), [])
})

test('nomes perigosos viram nomes seguros dentro da pasta de recebidos', async () => {
  const cases = [
    { name: '../../../etc/passwd', local: '.._.._.._etc_passwd' },
    { name: '..', local: '_' },
    { name: '.DS_Store', local: '_.DS_Store' }, // o planejador ignoraria lixo de sistema: ganha um '_' e sobe
    { name: 'clipe\u0000\u0007final.mov', local: 'clipefinal.mov' },
  ]
  for (const c of cases) {
    const data = crypto.randomBytes(1000 + c.local.length)
    const { json, status, text } = await create({ name: c.name, size: data.length, folderId: folder.id })
    assert.equal(status, 200, text)
    const r = await put(json.id, 0, data)
    assert.equal(r.status, 200, r.text)
    const { item } = await driveDone(json.id)
    assert.equal(item.md5, md5(data))
    const t = app.manager.snapshot().transfers.find(x => x.target?.fileId === item.id)
    assert.equal(path.dirname(t.local.path), stage, c.name)
    assert.equal(path.basename(t.local.path), c.local, c.name)
  }
  // Nada foi parar fora da pasta de recebidos.
  await assert.rejects(fs.stat(path.join(stage, '..', 'etc')))
  // Nome vazio ou só espaços: recusado.
  assert.equal((await create({ name: '   ', size: 1 })).status, 400)
  // Mesmo nome de novo: não sobrescreve, ganha "(2)".
  const a = crypto.randomBytes(500)
  const { json } = await create({ name: 'mesmo nome.txt', size: a.length, folderId: folder.id })
  await put(json.id, 0, a)
  await driveDone(json.id)
  const b = crypto.randomBytes(501)
  const second = await create({ name: 'mesmo nome.txt', size: b.length, folderId: folder.id })
  await put(second.json.id, 0, b)
  await driveDone(second.json.id)
  const names = await fs.readdir(stage)
  assert.ok(names.includes('mesmo nome.txt') && names.includes('mesmo nome (2).txt'), names.join(', '))
})

test('corpo maior que o declarado é recusado (com e sem Content-Length) e o tamanho máximo é 5 TB', async () => {
  const { json } = await create({ name: 'pequeno.bin', size: 1000, folderId: folder.id })
  let r = await put(json.id, 0, crypto.randomBytes(1500))
  assert.equal(r.status, 413)
  assert.equal(r.json.offset, 0)
  r = await put(json.id, 0, crypto.randomBytes(1500), { chunked: true })
  assert.equal(r.status, 413)
  assert.equal((await mget(`/m/api/uploads/${json.id}`)).json.offset, 0)
  // Pedaço que cabe: segue normal.
  r = await put(json.id, 0, crypto.randomBytes(400))
  assert.equal(r.status, 200)
  assert.equal(r.json.offset, 400)
  r = await put(json.id, 400, crypto.randomBytes(601))
  assert.equal(r.status, 413)
  assert.equal((await mget(`/m/api/uploads/${json.id}`)).json.offset, 400)

  const huge = await create({ name: 'enorme.mov', size: 5 * 1024 ** 4 + 1 })
  assert.equal(huge.status, 413)
  assert.equal((await create({ name: 'x', size: -1 })).status, 400)
  assert.equal((await create({ name: 'x', size: 1.5 })).status, 400)
  assert.equal((await put(json.id, 'abc', Buffer.alloc(1))).status, 400)

  // Desistir: o pedaço some do computador.
  assert.deepEqual((await raw('DELETE', `/m/api/uploads/${json.id}`, { headers: auth() })).json, { ok: true, removed: true })
  assert.equal((await mget(`/m/api/uploads/${json.id}`)).status, 404)
})

test('pastas do Drive pelo celular: só pastas, e os drives compartilhados', async () => {
  const sub = env.mock.addFolder('Brutos', folder.id)
  env.mock.addFile('solto.mov', folder.id, { size: 10 })
  const r = await mget(`/m/api/folders?folderId=${folder.id}`)
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(r.json.folders.map(f => f.name), ['Brutos'])
  assert.equal(r.json.folders[0].id, sub.id)
  const shared = env.mock.addSharedDrive('Produtora')
  const d = await mget('/m/api/folders?drives=1')
  assert.ok(d.json.drives.some(x => x.id === shared.id && x.name === 'Produtora'))
  const root = await mget('/m/api/folders')
  assert.ok(root.json.folders.some(f => f.id === folder.id))
})

test('apagar do computador depois de subir: só depois de o Drive conferir o MD5', async () => {
  await app.settings.update({ mobileDeleteAfterUpload: true })
  try {
    const data = crypto.randomBytes(200 * KiB)
    const { json } = await create({ name: 'apagar depois.mov', size: data.length, folderId: folder.id })
    await put(json.id, 0, data)
    const { item } = await driveDone(json.id)
    assert.equal(item.md5, md5(data))
    await waitFor(async () => (await mget(`/m/api/uploads/${json.id}`)).json.localDeleted, { message: 'não apagou do computador' })
    await assert.rejects(fs.stat(path.join(stage, 'apagar depois.mov')), { code: 'ENOENT' })

    // Com a conferência de MD5 desligada no envio, o receptor confere sozinho antes de apagar.
    await app.settings.update({ verifyChecksums: false })
    const data2 = crypto.randomBytes(150 * KiB)
    const second = await create({ name: 'sem conferência.mov', size: data2.length, folderId: folder.id })
    await put(second.json.id, 0, data2)
    await driveDone(second.json.id)
    await waitFor(async () => (await mget(`/m/api/uploads/${second.json.id}`)).json.localDeleted, { message: 'não apagou (conferência própria)' })
  } finally {
    await app.settings.update({ mobileDeleteAfterUpload: false, verifyChecksums: true })
  }
})

test('GET /api/mobile: endereços com o código, QR em SVG, envio direto, passo a passo e QR do app publicado', async () => {
  let r = await main('GET', '/api/mobile')
  assert.equal(r.status, 200, r.text)
  const m = r.json
  assert.equal(m.enabled, true)
  assert.equal(m.running, true)
  assert.equal(m.port, app.mobile.port)
  assert.ok(m.urls.length >= 1)
  for (const u of m.urls) assert.ok(u.endsWith(`/m/?t=${code()}`) && u.includes(`:${m.port}/`), u)
  assert.match(m.qrSvg, /^<svg[^>]*viewBox/)
  assert.ok(m.dropUrl.includes(`/m/api/drop?t=${code()}&name=`))
  assert.equal(m.shortcutSteps.length, 6)
  assert.match(m.shortcutSteps.join(' '), /Obter Conteúdo do URL/)
  assert.match(m.shortcutSteps.join(' '), /POST/)
  // App do celular no site das contas (/app/), sem client_id: o QR existe sem configurar nada.
  assert.equal(m.webUrl, `${cloudUrl()}/app/`)
  assert.ok(!m.webUrl.includes('client_id'))
  assert.match(m.webQrSvg, /^<svg/)

  // Ajustes antigos (endereço e ID do cliente Web) não mudam mais o QR.
  r = await main('PATCH', '/api/settings', { mobileWebUrl: 'https://outro.example/', webClientId: '123-abc.apps.googleusercontent.com' })
  assert.equal(r.status, 200, r.text)
  r = await main('GET', '/api/mobile')
  assert.equal(r.json.webUrl, `${cloudUrl()}/app/`)
  // Valores inválidos nos ajustes novos: recusados com mensagem.
  for (const bad of [{ mobileWebUrl: 'javascript:alert(1)' }, { webClientId: 'nada' }, { mobilePort: 'x' }, { mobileFolderId: "a' or 1" }]) {
    const res = await main('PATCH', '/api/settings', bad)
    assert.equal(res.status, 400, JSON.stringify(bad))
  }
  await main('PATCH', '/api/settings', { mobileWebUrl: '', webClientId: '' })
})

test('gerar novo código invalida o anterior', async () => {
  const old = code()
  assert.equal((await raw('GET', `/m/api/info?t=${old}`)).status, 200)
  const r = await main('POST', '/api/mobile', { rotate: true })
  assert.equal(r.status, 200, r.text)
  assert.notEqual(code(), old)
  assert.ok(r.json.urls.every(u => u.endsWith(`?t=${code()}`)))
  assert.equal((await raw('GET', `/m/api/info?t=${old}`)).status, 401)
  assert.equal((await raw('GET', '/m/api/info', { headers: { 'x-sobedesce-code': old } })).status, 401)
  assert.equal((await raw('GET', `/m/api/info?t=${code()}`)).status, 200)
  // O código fica guardado com permissão só do dono.
  const saved = JSON.parse(await fs.readFile(path.join(env.home, 'mobile.json'), 'utf8'))
  assert.equal(saved.code, code())
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(env.home, 'mobile.json'))).mode & 0o777, 0o600)
})

test('desligar o ajuste fecha o servidor; ligar de novo abre', async () => {
  const port = app.mobile.port
  assert.equal((await mget('/m/api/info')).status, 200)
  await app.settings.update({ mobileReceive: false })
  const off = await main('GET', '/api/mobile')
  assert.equal(off.json.running, false)
  assert.deepEqual(off.json.urls, [])
  assert.equal(off.json.qrSvg, null)
  await assert.rejects(raw('GET', '/m/api/info', { port, headers: auth() }), { code: 'ECONNREFUSED' })
  await app.settings.update({ mobileReceive: true })
  const on = await main('GET', '/api/mobile')
  assert.equal(on.json.running, true)
  assert.equal((await mget('/m/api/info')).status, 200)
})

test('recebimento pela metade sobrevive a fechar e abrir o app', async () => {
  const data = crypto.randomBytes(2 * MiB + 77)
  const meta = { name: 'continua depois.mov', size: data.length, folderId: folder.id }
  const { json } = await create(meta)
  let r = await put(json.id, 0, data.subarray(0, 1 * MiB + 5))
  assert.equal(r.json.offset, 1 * MiB + 5)
  await app.shutdown()
  app = await boot()
  const again = await create(meta)
  assert.equal(again.json.id, json.id)
  assert.equal(again.json.offset, 1 * MiB + 5)
  r = await put(json.id, again.json.offset, data.subarray(again.json.offset))
  assert.equal(r.status, 200, r.text)
  const { item } = await driveDone(json.id)
  assert.equal(item.md5, md5(data))
})
