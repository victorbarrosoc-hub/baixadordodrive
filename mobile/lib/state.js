// Estado global mínimo: um objeto, quem quiser se inscreve. Os componentes leem com useApp(seletor).
import { useEffect, useReducer, useRef } from '../vendor/preact-htm.js'
import { getClientId, local } from './config.js'

const listeners = new Set()

let state = {
  clientId: getClientId(),
  screen: null, // null = automático; 'setup' = trocar ID do cliente
  auth: { status: 'signedOut', error: null, needsTap: false },
  user: null, // { displayName, emailAddress, photoLink }
  quota: null, // { limit, usage }
  dest: null, // pasta de destino { id, name, driveId, path }
  awake: false, // trava de tela acesa ativa
  sheet: null, // { name, props }
  toasts: [],
}

export function getState() {
  return state
}

export function setState(patch) {
  const next = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...next }
  for (const fn of listeners) fn(state)
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Lê uma fatia do estado e só redesenha quando ela muda (comparação rasa). */
export function useApp(selector = (s) => s) {
  const [, force] = useReducer((x) => x + 1, 0)
  const sel = useRef(selector)
  sel.current = selector
  const last = useRef(selector(state))
  last.current = selector(state)
  useEffect(
    () =>
      subscribe((s) => {
        const next = sel.current(s)
        if (!shallowEqual(next, last.current)) force()
      }),
    [],
  )
  return last.current
}

function shallowEqual(a, b) {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => Object.is(a[k], b[k]))
}

// ───── sheets e avisos ─────

export function openSheet(name, props = {}) {
  setState({ sheet: { name, props } })
}

export function closeSheet() {
  setState({ sheet: null })
}

let toastSeq = 0
export function toast(text, { tone = 'neutral', ms = 2800 } = {}) {
  const id = ++toastSeq
  setState((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }))
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms)
}

// ───── destino e recentes ─────

export const MY_DRIVE = { id: 'root', name: 'Meu Drive', driveId: null, path: [{ id: 'root', name: 'Meu Drive' }] }

const RECENTS_KEY = 'sobedesce.recents'

export function getRecents(account) {
  const all = local.get(RECENTS_KEY) || []
  return all.filter((r) => !account || !r.account || r.account === account).slice(0, 5)
}

export function pushRecent(folder, account) {
  const all = (local.get(RECENTS_KEY) || []).filter((r) => !(r.id === folder.id && (r.account || null) === (account || null)))
  all.unshift({ id: folder.id, name: folder.name, driveId: folder.driveId || null, path: folder.path || [], account: account || null })
  local.set(RECENTS_KEY, all.slice(0, 12))
}

/** Caminho legível: "Meu Drive › Projetos › Clipe". */
export function folderTrail(folder, { skipLast = false } = {}) {
  const parts = (folder?.path || []).map((p) => p.name)
  return (skipLast ? parts.slice(0, -1) : parts).join(' › ')
}
