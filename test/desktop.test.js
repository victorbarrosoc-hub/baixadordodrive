// App de desktop: regras de confiança da ponte nativa (desktop/security.js), sem precisar do Electron.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { allowPermission, isAppUrl, trustedSender } from '../desktop/security.js'

const APP = 'http://127.0.0.1:4317'
const frame = (url, parent = null) => ({ senderFrame: { url, parent } })

test('a ponte nativa só atende a interface do motor, no quadro principal', () => {
  assert.equal(trustedSender(frame(`${APP}/#/transferencias`), APP), true)
  assert.equal(trustedSender(frame(`${APP}/`), `${APP}/`), true)
  for (const url of ['http://127.0.0.1:4318/', 'http://localhost:4317/', 'https://accounts.google.com/', 'file:///etc/passwd', 'about:blank', '', 'nada']) {
    assert.equal(trustedSender(frame(url), APP), false, url)
  }
  assert.equal(trustedSender(frame(`${APP}/`, { url: APP }), APP), false, 'iframe')
  assert.equal(trustedSender({}, APP), false)
  assert.equal(trustedSender(frame(`${APP}/`), null), false, 'motor ainda não subiu')
  assert.equal(isAppUrl(`${APP}/api/state`, APP), true)
})

test('permissões da web: só copiar texto, e só para a interface do motor', () => {
  assert.equal(allowPermission('clipboard-sanitized-write', `${APP}/`, APP), true)
  for (const p of ['media', 'geolocation', 'notifications', 'midi', 'openExternal', 'hid', 'serial', 'usb', 'display-capture', 'clipboard-read']) {
    assert.equal(allowPermission(p, `${APP}/`, APP), false, p)
  }
  assert.equal(allowPermission('clipboard-sanitized-write', 'https://example.com/', APP), false)
})

test('main.js confere a origem em todos os canais da ponte', async () => {
  const main = await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8')
  const channels = [...main.matchAll(/ipcMain\.(?:handle|on)\('([^']+)'/g)].map(m => m[1])
  assert.ok(channels.length >= 6)
  for (const ch of channels) {
    const body = main.slice(main.indexOf(`'${ch}'`), main.indexOf(`'${ch}'`) + 220)
    assert.match(body, /trustedSender\(event, engineUrl\)/, ch)
  }
  assert.match(main, /setPermissionRequestHandler/)
})

// ─────────── navegador de referências (desktop/navegador.js) ───────────
import { bloqueadoNoNavegador, dominiosValidos, enderecoDigitado, isLoopbackHost, permissaoNoNavegador, podeNavegar } from '../desktop/security.js'

test('navegador de referências: a página nunca alcança esta máquina (motor, celular, outros serviços)', () => {
  for (const url of [
    'http://127.0.0.1:4317/api/state', 'http://localhost:4317/', 'http://[::1]:4317/', 'ws://127.0.0.1:4317/api/events',
    'http://127.1.2.3/', 'http://0.0.0.0:4319/', 'http://app.localhost/', 'http://2130706433/', 'http://0x7f000001/',
    'file:///etc/passwd', 'chrome://settings', 'devtools://devtools/', 'javascript:alert(1)', 'nada',
  ]) assert.equal(bloqueadoNoNavegador(url), true, url)
  for (const url of ['https://www.instagram.com/reel/abc/', 'https://scontent.cdninstagram.com/v/x.jpg', 'wss://edge-chat.instagram.com/', 'data:image/png;base64,AAAA', 'blob:https://www.youtube.com/123']) {
    assert.equal(bloqueadoNoNavegador(url), false, url)
  }
  assert.equal(isLoopbackHost('LOCALHOST'), true)
  assert.equal(isLoopbackHost('instagram.com'), false)
  assert.equal(podeNavegar('https://www.youtube.com/watch?v=x'), true)
  for (const url of ['http://127.0.0.1:4317/', 'file:///x', 'https://user:pw@site.com/', 'instagram://reel/1', 'about:blank']) assert.equal(podeNavegar(url), false, url)
})

test('navegador de referências: endereço digitado, permissões e domínios de cookies', () => {
  assert.equal(enderecoDigitado('instagram.com'), 'https://instagram.com/')
  assert.equal(enderecoDigitado('https://youtu.be/abc'), 'https://youtu.be/abc')
  assert.match(enderecoDigitado('luz de janela'), /^https:\/\/www\.google\.com\/search\?q=luz/)
  assert.equal(enderecoDigitado('http://127.0.0.1:4317/'), null)
  assert.equal(enderecoDigitado(''), null)
  assert.equal(permissaoNoNavegador('fullscreen'), true)
  for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'hid', 'usb', 'openExternal']) assert.equal(permissaoNoNavegador(p), false, p)
  assert.deepEqual(dominiosValidos(['instagram.com', 'INSTAGRAM.com', 'localhost', '127.0.0.1', '*.x.com', '', 3, 'a.localhost', 'google.com']), ['instagram.com', 'google.com'])
  assert.deepEqual(dominiosValidos('instagram.com'), [])
})

test('navegador.js: página sem preload, isolada, e todo canal da barra confere a origem', async () => {
  const src = await fs.readFile(new URL('../desktop/navegador.js', import.meta.url), 'utf8')
  const pagina = src.slice(src.indexOf('pagina = new WebContentsView'), src.indexOf('wc.setWindowOpenHandler'))
  assert.match(pagina, /session: ses/)
  assert.match(pagina, /sandbox: true/)
  assert.match(pagina, /contextIsolation: true/)
  assert.match(pagina, /nodeIntegration: false/)
  assert.doesNotMatch(pagina, /preload/)
  assert.match(src, /onBeforeRequest\(\(details, callback\) => callback\(\{ cancel: bloqueadoNoNavegador\(details\.url\) \}\)\)/)
  assert.match(src, /will-download', event => event\.preventDefault\(\)/)
  assert.match(src, /setPermissionRequestHandler/)
  const canais = [...src.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1])
  assert.ok(canais.length >= 5)
  for (const ch of canais) {
    const at = src.indexOf(`ipcMain.handle('${ch}'`)
    assert.match(src.slice(at, at + 160), /ok\(event\)/, ch)
  }
  assert.match(src, /confiavel\(event\) && barra && event\.sender === barra\.webContents/)
  const main = await fs.readFile(new URL('../desktop/main.js', import.meta.url), 'utf8')
  assert.match(main, /registrarCanais\(ipcMain, event => trustedSender\(event, engineUrl\)\)/)
  const preload = await fs.readFile(new URL('../desktop/preload-navegador.cjs', import.meta.url), 'utf8')
  assert.doesNotMatch(preload, /require\('(fs|child_process|path)'\)/)
})

// ─────────── zoom automático (desktop/zoom.js) ───────────
import { lerEscolha, proximoPasso, zoomAutomatico } from '../desktop/zoom.js'

test('zoom automático: tamanho real até 1600 px, cresce até 1,3× em 2560 e para em 1,4×', () => {
  assert.equal(zoomAutomatico(980), 1)
  assert.equal(zoomAutomatico(1440), 1)
  assert.equal(zoomAutomatico(1600), 1)
  assert.equal(zoomAutomatico(1920), 1.1)
  assert.equal(zoomAutomatico(2560), 1.3)
  assert.equal(zoomAutomatico(5120), 1.4)
  assert.equal(zoomAutomatico(undefined), 1)
})

test('zoom da pessoa: passos do menu, Tamanho real e arquivo estragado', async () => {
  assert.equal(proximoPasso(1, 1), 1.1)
  assert.equal(proximoPasso(1, -1), 0.9)
  assert.equal(proximoPasso(1.25, 0), 1)
  assert.equal(proximoPasso(2, 1), 2)
  assert.equal(proximoPasso(0.67, -1), 0.67)
  assert.equal(proximoPasso(1.3, -1), 1.25, 'valor fora da lista volta para o passo de baixo')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-zoom-'))
  try {
    assert.equal(lerEscolha(path.join(dir, 'nao-existe.json')), 1)
    await fs.writeFile(path.join(dir, 'z.json'), '{"pessoa": 1.25}')
    assert.equal(lerEscolha(path.join(dir, 'z.json')), 1.25)
    await fs.writeFile(path.join(dir, 'z.json'), '{"pessoa": 99}')
    assert.equal(lerEscolha(path.join(dir, 'z.json')), 1)
    await fs.writeFile(path.join(dir, 'z.json'), 'lixo')
    assert.equal(lerEscolha(path.join(dir, 'z.json')), 1)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
