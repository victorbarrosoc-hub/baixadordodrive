// Rotas por hash: #/painel (Início, padrão), #/transferencias, #/drive, #/comparar, #/ajustes; #/inicio = Primeiros passos.
import { useEffect, useState } from '/vendor/preact-htm.js'

export const ROUTES = ['painel', 'transferencias', 'drive', 'referencias', 'frames', 'comparar', 'computadores', 'cartoes', 'ajustes', 'inicio']

export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, '')
  const [p, qs] = raw.split('?')
  const parts = p.split('/').filter(Boolean).map(decodeURIComponent)
  const name = ROUTES.includes(parts[0]) ? parts[0] : 'painel'
  return { name, parts, query: new URLSearchParams(qs || '') }
}

export function navigate(to, { replace = false } = {}) {
  const hash = to.startsWith('#') ? to : `#/${to.replace(/^\//, '')}`
  if (replace) history.replaceState(null, '', hash)
  else location.hash = hash
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'))
}

export function useRoute() {
  const [route, setRoute] = useState(parseHash)
  useEffect(() => {
    const on = () => setRoute(parseHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}
