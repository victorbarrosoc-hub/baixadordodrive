// Service worker mínimo: guarda a casca do app para abrir sem rede, mas SEMPRE tenta a rede primeiro para
// html/js/css (atualizações chegam na hora). Nunca intercepta nada fora deste site — em especial
// googleapis.com e accounts.google.com, por onde passam o login e os arquivos.
const CACHE = 'sobedesce-shell-v1'
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  './vendor/preact-htm.js',
  './lib/auth.js',
  './lib/config.js',
  './lib/drive.js',
  './lib/format.js',
  './lib/idb.js',
  './lib/platform.js',
  './lib/state.js',
  './lib/uploader.js',
  './lib/wakelock.js',
  './components/folders.js',
  './components/icons.js',
  './components/install-hint.js',
  './components/main.js',
  './components/queue.js',
  './components/settings.js',
  './components/setup.js',
  './components/signin.js',
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
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('sobedesce-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // Google (API, upload, login) passa direto, sem SW no meio
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
