// Service worker do app do celular (web/public/app/sw.js), parte /app/stream/<id>: roda o sw.js de verdade numa vm,
// com abas, Google e pedidos de mentira. Cobre o achado A1 da revisão de segurança: link de fora aberto numa aba não
// vira página do site (nem com o token de ninguém), o tipo só passa se for mídia, todo stream sai com CSP sandbox,
// CORP e nosniff, e o token só vale para a chave (k) da aba que gerou o endereço. A prévia (Range → 206) e o Baixar
// (navegação com download=1, sempre anexo) continuam.
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const SRC = fs.readFileSync(new URL('../web/public/app/sw.js', import.meta.url), 'utf8')
const ORIGIN = 'https://sobedesce.com'
const GOOGLE = 'https://www.googleapis.com/drive/v3'
const KEY = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const VIDEO = Buffer.alloc(1000, 7)
const HTML = '<script>fetch("/api/drive/token",{method:"POST"})</script>'

/** Arquivos no "Google": id → { type, body }. */
const FILES = {
  vid: { type: 'video/mp4', body: VIDEO },
  pagina: { type: 'text/html; charset=utf-8', body: Buffer.from(HTML) },
  desenho: { type: 'image/svg+xml', body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') },
  xhtml: { type: 'application/xhtml+xml', body: Buffer.from('<html/>') },
  foto: { type: 'image/jpeg', body: Buffer.alloc(50, 1) },
}

/** Uma aba do app: responde ao pedido de token como lib/stream.js (só com a própria chave). */
function tab(id, { key = KEY, old = false, path = '/app/' } = {}) {
  const c = {
    id,
    url: ORIGIN + path,
    focused: false,
    visibilityState: 'visible',
    asked: [],
    postMessage(msg, ports) {
      c.asked.push(msg)
      const port = ports?.[0]
      if (!port || msg.type !== 'sd-token') return
      setTimeout(() => port.close(), 50) // senão o canal segura o processo do teste aberto
      // Aba da versão antiga: não conhece a chave e entrega o token para qualquer um.
      if (old) return port.postMessage({ ok: true, token: 'tok-velho', api: GOOGLE, expiresAt: Date.now() + 3600_000 })
      if (msg.k !== key) return port.postMessage({ ok: false, reason: 'chave' })
      port.postMessage({ ok: true, k: key, token: `tok-${key.slice(0, 4)}`, api: GOOGLE, expiresAt: Date.now() + 3600_000 })
    },
  }
  return c
}

function load(tabs) {
  const handlers = {}
  const google = []
  const self = {
    location: new URL(ORIGIN + '/app/sw.js'),
    addEventListener: (type, fn) => (handlers[type] = fn),
    skipWaiting: async () => {},
    clients: {
      get: async (id) => tabs.find((t) => t.id === id) || null,
      matchAll: async () => tabs,
      claim: async () => {},
    },
    registration: {},
  }
  const fakeFetch = async (url, init = {}) => {
    const u = new URL(String(url))
    google.push({ url: u, headers: init.headers || {} })
    if (u.origin + '/drive/v3' !== GOOGLE) throw new Error('fora do Google: ' + u)
    const id = decodeURIComponent(u.pathname.split('/').pop())
    const f = FILES[id]
    if (!f) return new Response('{}', { status: 404 })
    const range = /^bytes=(\d+)-(\d*)$/.exec(init.headers?.Range || '')
    if (range) {
      const start = Number(range[1])
      const end = range[2] === '' ? f.body.length - 1 : Math.min(Number(range[2]), f.body.length - 1)
      return new Response(f.body.subarray(start, end + 1), {
        status: 206,
        headers: { 'Content-Type': f.type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${f.body.length}` },
      })
    }
    return new Response(f.body, { status: 200, headers: { 'Content-Type': f.type, 'Content-Length': String(f.body.length) } })
  }
  const ctx = vm.createContext({
    self,
    caches: { open: async () => ({ addAll: async () => {}, put: async () => {} }), keys: async () => [], match: async () => undefined },
    fetch: fakeFetch,
    Response,
    Headers,
    URL,
    URLSearchParams,
    MessageChannel,
    setTimeout,
    clearTimeout,
    console,
  })
  vm.runInContext(SRC, ctx, { filename: 'sw.js' })
  return { handlers, google }
}

/** Dispara um fetch no SW. `mode`/`destination` como o navegador manda; devolve a Response (ou null se o SW não atende). */
async function get(sw, path, { mode = 'no-cors', destination = 'video', range, clientId = 'aba1' } = {}) {
  let res = null
  const headers = new Headers()
  if (range) headers.set('Range', range)
  const event = {
    request: { method: 'GET', url: ORIGIN + path, mode, destination, headers, signal: new AbortController().signal },
    clientId: mode === 'navigate' ? '' : clientId,
    respondWith: (p) => (res = p),
  }
  sw.handlers.fetch(event)
  return res ? await res : null
}

const url = (id, { k = KEY, t, download, n = 'arquivo.bin' } = {}) => {
  const p = new URLSearchParams()
  if (t) p.set('t', t)
  p.set('n', n)
  if (download) p.set('download', '1')
  if (k != null) p.set('k', k)
  return `/app/stream/${id}?${p}`
}

function assertGuard(res) {
  assert.equal(res.headers.get('Content-Security-Policy'), "sandbox; default-src 'none'")
  assert.equal(res.headers.get('Cross-Origin-Resource-Policy'), 'same-origin')
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(res.headers.get('Cache-Control'), 'no-store')
}

describe('sw.js /app/stream/', () => {
  let tabs, sw
  beforeEach(() => {
    tabs = [tab('aba1')]
    sw = load(tabs)
  })

  test('todo módulo do app (lib/ e components/) está na lista do cache, para abrir sem internet', () => {
    const missing = []
    for (const dir of ['lib', 'components']) {
      for (const f of fs.readdirSync(new URL(`../web/public/app/${dir}/`, import.meta.url))) {
        if (f.endsWith('.js') && !SRC.includes(`'./${dir}/${f}'`)) missing.push(`${dir}/${f}`)
      }
    }
    assert.deepEqual(missing, [])
  })

  test('cache e versão do app subiram (2.8.27 / sobedesce-app-v42)', () => {
    assert.match(SRC, /const CACHE = 'sobedesce-app-v42'/)
    const cfg = fs.readFileSync(new URL('../web/public/app/lib/config.js', import.meta.url), 'utf8')
    assert.match(cfg, /export const VERSION = '2\.8\.27'/)
    const lib = fs.readFileSync(new URL('../web/public/app/lib/stream.js', import.meta.url), 'utf8')
    assert.match(lib, /p\.set\('k', KEY\)/, 'a página põe a chave em todo endereço')
    assert.match(lib, /d\.k !== KEY/, 'a página só entrega o token com a chave dela')
  })

  test('link de fora aberto numa aba (navegação) não renderiza nada nem pede token, mesmo com a chave certa', async () => {
    for (const k of [KEY, OTHER, null]) {
      const res = await get(sw, url('pagina', { k, t: 'text/html' }), { mode: 'navigate', destination: 'document' })
      assert.equal(res.status, 403)
      assert.match(res.headers.get('Content-Type'), /^text\/plain/)
      assertGuard(res)
      assert.doesNotMatch(await res.text(), /<script/)
    }
    // iframe e object/embed também não
    assert.equal((await get(sw, url('pagina'), { mode: 'navigate', destination: 'iframe' })).status, 403)
    assert.equal((await get(sw, url('pagina', { download: true }), { mode: 'navigate', destination: 'iframe' })).status, 403)
    assert.equal((await get(sw, url('pagina'), { mode: 'no-cors', destination: 'embed' })).status, 403)
    assert.equal((await get(sw, url('pagina'), { mode: 'no-cors', destination: 'object' })).status, 403)
    assert.equal((await get(sw, url('pagina'), { mode: 'no-cors', destination: 'script' })).status, 403)
    assert.equal(tabs[0].asked.length, 0, 'nenhuma aba foi consultada')
    assert.equal(sw.google.length, 0, 'nada foi buscado no Google')
  })

  test('sem a chave da aba, o token não sai: chave errada, sem chave e aba antiga (sem chave) não contam', async () => {
    tabs.push(tab('velha', { old: true }))
    // navegação do Baixar com chave inventada (o link "Atualizacao.dmg" de fora)
    const dl = await get(sw, url('pagina', { k: OTHER, download: true, n: 'Atualizacao-SOBEDESCE.dmg' }), { mode: 'navigate', destination: 'document' })
    assert.equal(dl.status, 401)
    assertGuard(dl)
    assert.equal(sw.google.length, 0)
    // sem k / k fora do formato
    assert.equal((await get(sw, url('vid', { k: null }))).status, 403)
    assert.equal((await get(sw, url('vid', { k: 'x' }))).status, 403)
    // pedido de mídia de uma aba com outra chave
    const other = await get(sw, url('vid', { k: OTHER }), { clientId: 'aba1' })
    assert.equal(other.status, 401)
    assert.equal(sw.google.length, 0)
  })

  test('prévia de vídeo: Range bytes=0-1 → 206 com Content-Range, tipo de vídeo inline e os cabeçalhos de proteção', async () => {
    const res = await get(sw, url('vid', { t: 'video/mp4', n: 'Clipe.mp4' }), { destination: 'video', range: 'bytes=0-1' })
    assert.equal(res.status, 206)
    assert.equal(res.headers.get('Content-Type'), 'video/mp4')
    assert.equal(res.headers.get('Content-Range'), `bytes 0-1/${VIDEO.length}`)
    assert.equal(res.headers.get('Accept-Ranges'), 'bytes')
    assert.match(res.headers.get('Content-Disposition'), /^inline; filename="Clipe.mp4"/)
    assertGuard(res)
    assert.equal((await res.arrayBuffer()).byteLength, 2)
    assert.equal(sw.google[0].headers.Authorization, 'Bearer tok-aaaa')
    assert.equal(sw.google[0].headers.Range, 'bytes=0-1')
    // o resto do vídeo, sem pedir o token de novo (fica na memória para esta chave)
    const rest = await get(sw, url('vid', { t: 'video/mp4' }), { destination: 'video', range: 'bytes=2-' })
    assert.equal(rest.status, 206)
    assert.equal(rest.headers.get('Content-Range'), `bytes 2-999/${VIDEO.length}`)
    assert.equal(tabs[0].asked.length, 1)
    // fetch() da página (o "por que não tocou?" do preview.js) e <img> também passam
    assert.equal((await get(sw, url('vid'), { mode: 'cors', destination: '', range: 'bytes=0-1' })).status, 206)
    const img = await get(sw, url('foto'), { destination: 'image' })
    assert.equal(img.status, 200)
    assert.equal(img.headers.get('Content-Type'), 'image/jpeg')
  })

  test('player sem clientId (Safari): pergunta às abas e só a dona da chave responde', async () => {
    tabs.unshift(tab('outra', { key: OTHER }))
    tabs.unshift(tab('velha', { old: true }))
    const res = await get(sw, url('vid'), { destination: 'video', range: 'bytes=0-1', clientId: '' })
    assert.equal(res.status, 206)
    assert.equal(sw.google[0].headers.Authorization, 'Bearer tok-aaaa')
  })

  test('tipo que não é mídia sai como application/octet-stream + attachment (HTML, SVG, XHTML), mesmo com t= de vídeo', async () => {
    for (const id of ['pagina', 'desenho', 'xhtml']) {
      const res = await get(sw, url(id, { t: 'video/mp4', n: 'x.mp4' }), { mode: 'cors', destination: '' })
      assert.equal(res.status, 200, id)
      assert.equal(res.headers.get('Content-Type'), 'application/octet-stream', id)
      assert.match(res.headers.get('Content-Disposition'), /^attachment;/, id)
      assertGuard(res)
    }
  })

  test('Baixar (navegação com download=1 e a chave): sempre anexo, octet-stream, com o nome em UTF-8', async () => {
    const res = await get(sw, url('vid', { download: true, t: 'video/mp4', n: 'Cerimônia.mp4' }), { mode: 'navigate', destination: 'document' })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('Content-Type'), 'application/octet-stream')
    assert.equal(res.headers.get('Content-Disposition'), `attachment; filename="Cerimonia.mp4"; filename*=UTF-8''Cerim%C3%B4nia.mp4`)
    assertGuard(res)
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(VIDEO))
    // HTML do Drive pelo Baixar: baixa, não abre
    const html = await get(sw, url('pagina', { download: true, n: 'index.html' }), { mode: 'navigate', destination: 'document' })
    assert.equal(html.headers.get('Content-Type'), 'application/octet-stream')
    assert.match(html.headers.get('Content-Disposition'), /^attachment;/)
  })

  test('erro do Google (404, 416) também leva os cabeçalhos de proteção', async () => {
    const res = await get(sw, url('sumiu'), { destination: 'video' })
    assert.equal(res.status, 404)
    assertGuard(res)
  })
})
