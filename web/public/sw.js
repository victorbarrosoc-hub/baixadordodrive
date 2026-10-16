// Aposentadoria do service worker antigo. Até a versão 1 o SOBEDESCE Celular morava na raiz do site e registrava
// /sw.js com escopo "/". Agora o app vive em /app/ (com o próprio /app/sw.js) e a raiz é o site da conta.
// Quem ainda tem o antigo instalado recebe este arquivo na checagem de atualização: ele apaga a casca guardada,
// se desregistra e recarrega as abas abertas, que passam a vir direto da rede.
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k.startsWith('sobedesce-shell-')).map((k) => caches.delete(k)))
      await self.registration.unregister()
      const tabs = await self.clients.matchAll({ type: 'window' })
      for (const tab of tabs) tab.navigate(tab.url).catch(() => {})
    })(),
  )
})
