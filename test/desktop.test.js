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
