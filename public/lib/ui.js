// Pequenos utilitários de interface: memo (o bundle standalone do htm/preact não traz preact/compat),
// classes condicionais, armazenamento local seguro e hooks comuns.
import { h, Component, useEffect, useRef, useState, useCallback } from '/vendor/preact-htm.js'

export function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

export function shallowEqual(a, b) {
  if (a === b) return true
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) if (!Object.is(a[k], b[k])) return false
  return true
}

/** Igual ao memo do React: só re-renderiza quando alguma prop muda (comparação rasa). */
export function memo(fn, eq = shallowEqual) {
  class Memo extends Component {
    shouldComponentUpdate(next) {
      return !eq(this.props, next)
    }
    render(props) {
      return h(fn, props)
    }
  }
  Memo.displayName = `Memo(${fn.displayName || fn.name || 'Componente'})`
  return Memo
}

const PREFIX = 'sobedesce.'
export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(PREFIX + key)
      return raw == null ? fallback : JSON.parse(raw)
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      if (value === undefined || value === null) localStorage.removeItem(PREFIX + key)
      else localStorage.setItem(PREFIX + key, JSON.stringify(value))
    } catch {}
  },
}

/** useState que também lembra o valor neste navegador. */
export function usePersistentState(key, initial) {
  const [value, setValue] = useState(() => storage.get(key, typeof initial === 'function' ? initial() : initial))
  const set = useCallback(
    (v) =>
      setValue((prev) => {
        const next = typeof v === 'function' ? v(prev) : v
        storage.set(key, next)
        return next
      }),
    [key],
  )
  return [value, set]
}

export function useDebounced(value, ms) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Chama `onOutside` em clique fora de `ref` ou Esc. */
export function useDismiss(ref, onDismiss, active = true) {
  const cb = useRef(onDismiss)
  cb.current = onDismiss
  useEffect(() => {
    if (!active) return undefined
    const down = (e) => {
      if (ref.current && !ref.current.contains(e.target)) cb.current?.(e)
    }
    const key = (e) => {
      if (e.key === 'Escape') cb.current?.(e)
    }
    // adia um tique para o clique que abriu não fechar na hora
    const t = setTimeout(() => document.addEventListener('pointerdown', down, true), 0)
    document.addEventListener('keydown', key)
    return () => {
      clearTimeout(t)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('keydown', key)
    }
  }, [active])
}

/** Re-renderiza a cada `ms` (para textos relativos tipo "há 5 min"). */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

// (rótulo de "Mostrar no Finder/Explorer" fica em lib/desktop.js, junto com a ponte nativa)
