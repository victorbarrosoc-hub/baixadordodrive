// Celular: estado da recepção pelo Wi-Fi (/api/mobile), código novo e copiar endereços.
import { useEffect, useRef, useState } from '/vendor/preact-htm.js'
import { api } from './api.js'

const POLL_MS = 4000 // ligado: endereços (IP pode mudar) e "recebendo agora" se mantêm em dia

/**
 * Estado de GET /api/mobile. Recarrega quando `deps` mudam (ajustes confirmados pelo motor) e, com `poll`, a cada 4 s.
 * O servidor espera a porta abrir/fechar antes de responder, então o que volta já é o estado de verdade.
 */
export function useMobileState(deps, { poll = false } = {}) {
  const [state, setState] = useState(null)
  const [error, setError] = useState(null)
  const seq = useRef(0)
  const load = async () => {
    const n = ++seq.current
    try {
      const r = await api.get('/api/mobile')
      if (n === seq.current) {
        setState(r)
        setError(null)
      }
    } catch (err) {
      if (n === seq.current) setError(err.message)
    }
  }
  useEffect(() => {
    load()
  }, deps)
  useEffect(() => {
    if (!poll) return undefined
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, POLL_MS)
    return () => clearInterval(t)
  }, [poll])
  return { state, error, reload: load, setState }
}

/** Código novo: o QR, os endereços e o Atalho antigos param de funcionar na hora. */
export const rotateMobileCode = () => api.post('/api/mobile', { rotate: true })

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

/** Acha o ID do cliente num texto colado (o ID puro, com espaços, ou o JSON inteiro baixado do Console). */
export function extractClientId(text) {
  const m = /[A-Za-z0-9][\w.-]*\.apps\.googleusercontent\.com/.exec(String(text || ''))
  return m ? m[0] : ''
}

/** "sobedesce.com" → "https://sobedesce.com". Vazio continua vazio. */
export function normalizeWebUrl(text) {
  const t = String(text || '').trim()
  if (!t) return ''
  return /^https?:\/\//i.test(t) ? t : `https://${t}`
}
