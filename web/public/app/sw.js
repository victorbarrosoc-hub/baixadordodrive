// Service worker do app (escopo /app/). Três tarefas:
//  1. Guarda a casca do app para abrir sem rede, mas SEMPRE tenta a rede primeiro para html/js/css (atualizações
//     chegam na hora). A conta (/api/*, /entrar, /conta) e o Google seguem direto, sem cache.
//  2. /app/stream/<id>: prévia e download de arquivos do Drive. <video>, <audio>, <img> e links não mandam o
//     cabeçalho Authorization; aqui a requisição vai para o Google com o token, repassando o Range (o Safari só toca
//     vídeo com 206), e volta em streaming — nada é guardado. O token vem da página (postMessage com MessageChannel,
//     lib/stream.js) e fica só na memória deste SW, que some quando ele dorme.
//     Segurança (o arquivo é de quem subiu, não nosso): só atende pedidos de mídia ou fetch da página, nunca a
//     abertura do endereço numa aba (a não ser o Baixar, que sai sempre como anexo). O tipo só passa se for vídeo,
//     áudio ou imagem (sem SVG); o resto vira application/octet-stream + attachment. Toda resposta leva CSP sandbox,
//     CORP same-origin e nosniff. E o endereço precisa da chave `k` da aba que o gerou: o SW só usa o token se a
//     página confirmar a chave (quem manda um link de fora não sabe a chave).
//  3. Avisos (Web Push): "Pronto: 8 arquivos enviados do MacBook…" quando o computador termina; o toque abre
//     /app/#computador (ou a folha, se o app já estiver aberto).
const CACHE = 'sobedesce-app-v17'
const SCOPE = new URL('./', self.location).pathname // "/app/"
const STREAM = SCOPE + 'stream/'
const GOOGLE_API = 'https://www.googleapis.com/drive/v3'
const LOOPBACK = new Set(['127.0.0.1', 'localhost'])
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  './vendor/preact-htm.js',
  './lib/auth.js',
  './lib/browse.js',
  './lib/computador.js',
  './lib/config.js',
  './lib/drive.js',
  './lib/format.js',
  './lib/idb.js',
  './lib/lan.js',
  './lib/platform.js',
  './lib/referencias.js',
  './lib/state.js',
  './lib/stream.js',
  './lib/tamanho.js',
  './lib/uploader.js',
  './lib/wakelock.js',
  './components/account.js',
  './components/browser.js',
  './components/computador.js',
  './components/folders.js',
  './components/icons.js',
  './components/install-hint.js',
  './components/main.js',
  './components/player.js',
  './components/preview.js',
  './components/queue.js',
  './components/referencias.js',
  './components/settings.js',
  './components/tabs.js',
  './components/thumb.js',
  './components/ui.js',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/favicon.svg',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .catch(() => {}) // sem rede na instalação: tudo bem, a rede vem primeiro mesmo
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('sobedesce-app-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // Google (API e upload) passa direto, sem SW no meio
  if (!url.pathname.startsWith(SCOPE)) return // conta e resto do site: sempre da rede, nunca guardados
  if (url.pathname.startsWith(STREAM)) return event.respondWith(stream(event, url))
  if (url.search && url.searchParams.has('dev_api')) return

  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req, { cache: 'no-cache' })
        if (res.ok && res.type === 'basic') {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? './' : req, copy)).catch(() => {})
        }
        return res
      } catch (err) {
        const cached = await caches.match(req.mode === 'navigate' ? './' : req, { ignoreSearch: req.mode === 'navigate' })
        if (cached) return cached
        throw err
      }
    })(),
  )
})

// ───── /app/stream/<id>?s=<tamanho>&t=<tipo>&n=<nome>&k=<chave>[&download=1] ─────

const toks = new Map() // chave da aba → { value, api, expiresAt } — só em memória
const MAX_TOKS = 16
const KEY_RE = /^[0-9a-f]{32}$/
// Quem pode pedir o stream: <video>, <audio>, <img>, <track> e fetch() da página (destination vazio).
const MEDIA_DEST = new Set(['video', 'audio', 'image', 'track', ''])
// Toda resposta de /app/stream/: nada de rodar como página do site, nem ser lida por outra origem.
const GUARD = {
  'Content-Security-Policy': "sandbox; default-src 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
}

/** A página só pode apontar para o Google (ou, no modo de teste em 127.0.0.1, para um Drive falso em loopback). */
function allowedApi(api) {
  if (api === GOOGLE_API) return true
  try {
    const u = new URL(api)
    return LOOPBACK.has(self.location.hostname) && u.protocol === 'http:' && LOOPBACK.has(u.hostname)
  } catch {
    return false
  }
}

/** Quem perguntar: a aba que fez o pedido; se ela não vem (navegação do Baixar, player de mídia sem clientId), as
 *  abas do app. Só a dona da chave responde com o token (lib/stream.js). */
async function pages(event) {
  const out = []
  if (event.clientId) {
    const c = await self.clients.get(event.clientId)
    if (c) return [c]
  }
  const all = await self.clients.matchAll({ type: 'window' })
  all.sort((a, b) => Number(b.focused) - Number(a.focused) || Number(b.visibilityState === 'visible') - Number(a.visibilityState === 'visible'))
  for (const c of all) if (!out.some((o) => o.id === c.id) && new URL(c.url).pathname.startsWith(SCOPE)) out.push(c)
  return out
}

function ask(client, k, stale) {
  return new Promise((resolve) => {
    const ch = new MessageChannel()
    const t = setTimeout(() => resolve(null), 20_000)
    ch.port1.onmessage = (e) => {
      clearTimeout(t)
      resolve(e.data)
    }
    client.postMessage({ type: 'sd-token', k, stale: stale || null }, [ch.port2])
  })
}

async function token(event, k, stale) {
  const cached = toks.get(k)
  if (!stale && cached && cached.expiresAt - Date.now() > 60_000) return cached
  toks.delete(k)
  for (const c of await pages(event)) {
    const r = await ask(c, k, stale)
    if (!r) continue
    // Só vale a resposta que devolve a mesma chave: aba de outra sessão diz "chave" e aba antiga (sem chave) não conta.
    if (r.ok) {
      if (r.k !== k || !r.token || !allowedApi(r.api)) continue
      const t = { value: String(r.token), api: r.api, expiresAt: Number(r.expiresAt) || Date.now() + 10 * 60_000 }
      toks.set(k, t)
      if (toks.size > MAX_TOKS) toks.delete(toks.keys().next().value)
      return t
    }
    if (r.reason === 'chave') continue
    return { error: r.reason || 'erro' }
  }
  return { error: 'sem-pagina' }
}

/** "bytes=a-b" | "bytes=a-" | "bytes=-n" → { start, end } dentro de size, ou null. */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!m || (m[1] === '' && m[2] === '') || size == null) return null
  let start
  let end
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  return start <= end ? { start, end } : null
}

/** Nome para o Content-Disposition: ASCII de reserva + o nome de verdade em UTF-8 (RFC 6266/5987). */
function disposition(kind, name) {
  const ascii = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]|["\\%;]/g, '_') || 'arquivo'
  const utf = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf}`
}

/** "video/mp4" etc. se o tipo é mídia que o navegador só mostra (sem SVG, que roda script); senão null. */
function mediaType(type) {
  const base = String(type || '').split(';')[0].trim().toLowerCase()
  if (!/^(video|audio|image)\/[a-z0-9][a-z0-9.+-]*$/.test(base)) return null
  if (base.includes('svg') || base.includes('xml')) return null
  return base
}

function fail(status, message) {
  return new Response(message, { status, headers: { ...GUARD, 'Content-Type': 'text/plain; charset=utf-8' } })
}

async function stream(event, url) {
  let id
  try {
    id = decodeURIComponent(url.pathname.slice(STREAM.length))
  } catch {
    id = ''
  }
  const req = event.request
  const p = url.searchParams
  const download = p.get('download') === '1'
  // Abrir o endereço numa aba (link de fora, iframe) não mostra nada: só o Baixar navega, e sai como anexo.
  if (req.mode === 'navigate' ? !download || req.destination !== 'document' : !MEDIA_DEST.has(req.destination)) {
    return fail(403, 'Abra o arquivo pelo SOBEDESCE.')
  }
  const k = p.get('k') || ''
  if (!KEY_RE.test(k)) return fail(403, 'Abra o arquivo pelo SOBEDESCE.')
  if (!id || /[/?#]/.test(id)) return fail(404, 'Arquivo não encontrado.')
  const size = p.has('s') && /^\d+$/.test(p.get('s')) ? Number(p.get('s')) : null
  const type = p.get('t') || 'application/octet-stream'
  const name = p.get('n') || 'arquivo'
  const range = req.headers.get('Range')

  let stale = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await token(event, k, stale)
    if (t.error) return fail(t.error === 'reconectar' ? 409 : 401, t.error === 'reconectar' ? 'Reconecte o Google Drive na sua conta.' : 'Abra o SOBEDESCE para continuar.')
    const headers = { Authorization: `Bearer ${t.value}` }
    if (range) headers.Range = range
    let up
    try {
      up = await fetch(`${t.api}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, {
        headers,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        // Prévia: se o player desiste do pedaço (pulou para outro ponto), o pedido ao Google para junto. Download
        // não: o navegador passa o pedido para o gerenciador de downloads e o sinal original é cancelado.
        signal: download ? undefined : req.signal,
      })
    } catch {
      return fail(504, 'Sem conexão com o Google.')
    }
    if (up.status === 401 && attempt === 0) {
      stale = t.value
      continue
    }
    if (!up.ok) {
      const h = { ...GUARD }
      const cr = up.headers.get('Content-Range')
      if (up.status === 416) h['Content-Range'] = cr || (size != null ? `bytes */${size}` : 'bytes */*')
      return new Response(null, { status: up.status, headers: h })
    }

    const h = new Headers(GUARD)
    // Baixar: sempre anexo e octet-stream. Prévia: o tipo só passa se for mídia; o resto também vira anexo.
    const media = download ? null : mediaType(up.headers.get('Content-Type') || type)
    h.set('Content-Type', media || 'application/octet-stream')
    h.set('Accept-Ranges', 'bytes')
    const len = up.headers.get('Content-Length')
    if (len) h.set('Content-Length', len)
    if (up.status === 206) {
      // Com CORS, o Content-Range do Google pode não ser legível: refaz pelo pedido + tamanho do arquivo.
      let cr = up.headers.get('Content-Range')
      if (!cr) {
        const r = parseRange(range, size)
        if (r) {
          const end = len ? Math.min(r.end, r.start + Number(len) - 1) : r.end
          cr = `bytes ${r.start}-${end}/${size}`
          if (!len) h.set('Content-Length', String(end - r.start + 1))
        }
      }
      if (cr) h.set('Content-Range', cr)
    } else if (!len && size != null) {
      h.set('Content-Length', String(size))
    }
    h.set('Content-Disposition', disposition(media ? 'inline' : 'attachment', name))
    return new Response(up.body, { status: up.status, statusText: up.status === 206 ? 'Partial Content' : 'OK', headers: h })
  }
  return fail(401, 'O Google recusou o acesso.')
}

// ───── avisos (Web Push, docs/CONTAS.md §9) ─────

self.addEventListener('push', (event) => {
  let d = {}
  try {
    d = event.data ? event.data.json() : {}
  } catch {
    d = { corpo: event.data ? event.data.text() : '' }
  }
  const titulo = typeof d.titulo === 'string' && d.titulo ? d.titulo : 'SOBEDESCE'
  const url = typeof d.url === 'string' && d.url.startsWith(SCOPE) ? d.url : SCOPE + '#computador'
  event.waitUntil(
    self.registration.showNotification(titulo, {
      body: typeof d.corpo === 'string' ? d.corpo : '',
      tag: typeof d.tag === 'string' ? d.tag : 'sd-computador',
      renotify: true,
      icon: SCOPE + 'icons/icon-192.png',
      badge: SCOPE + 'icons/icon-192.png',
      data: { url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || SCOPE + '#computador'
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = all.find((c) => new URL(c.url).pathname.startsWith(SCOPE))
      if (open) {
        await open.focus().catch(() => {})
        open.postMessage({ type: 'sd-computador' })
        return
      }
      await self.clients.openWindow(url)
    })(),
  )
})
