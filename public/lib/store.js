// Estado do app: carrega /api/state uma vez e depois se mantém em dia pelo SSE (/api/events).
// Componentes assinam só a fatia que usam (useStore(selector)), então o tique de stats (2×/s)
// não re-renderiza a lista de transferências, e cada transferência alterada troca só o próprio objeto.
import { useEffect, useRef, useState } from '/vendor/preact-htm.js'
import { api } from './api.js'
import { toast } from './toasts.js'
import { storage } from './ui.js'

export const EMPTY_STATS = Object.freeze({
  down: { speed: 0, active: 0, queued: 0 },
  up: { speed: 0, active: 0, queued: 0 },
  totals: { count: 0, bytes: 0, doneBytes: 0 },
  eta: null,
  history: [],
  keepAwake: false,
})

let state = {
  status: 'loading', // 'loading' | 'ready' | 'error'
  loadError: null,
  conn: 'connecting', // 'connecting' | 'open' | 'lost'
  app: { name: 'SOBEDESCE', version: '', platform: '' },
  setup: { configured: false, clientIdHint: null },
  accounts: [],
  activeAccountId: storage.get('account', null),
  settings: null,
  transfers: new Map(), // id -> PublicTransfer (objeto novo só quando muda)
  batches: [],
  stats: EMPTY_STATS,
  compare: {}, // jobId -> { status, progress, error }
}

const listeners = new Set()

export function getState() {
  return state
}

function setState(patch) {
  state = { ...state, ...patch }
  for (const fn of listeners) fn(state)
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Assina uma fatia do estado. O seletor deve devolver referências estáveis (campos do estado). */
export function useStore(selector) {
  const [, force] = useState(0)
  const sel = useRef(selector)
  sel.current = selector
  const value = selector(state)
  const last = useRef(value)
  last.current = value
  useEffect(() => {
    const check = (s) => {
      const v = sel.current(s)
      if (!Object.is(v, last.current)) {
        last.current = v
        force((n) => n + 1)
      }
    }
    const off = subscribe(check)
    check(state) // algo pode ter mudado entre o render e a assinatura
    return off
  }, [])
  return value
}

// ───── aplicação de dados do servidor ─────

function pickActiveAccount(accounts, wanted) {
  if (wanted && accounts.some((a) => a.id === wanted)) return wanted
  return accounts[0]?.id ?? null
}

function applyFull(data) {
  const transfers = new Map()
  for (const t of data.transfers || []) transfers.set(t.id, t)
  const accounts = data.accounts || []
  setState({
    status: 'ready',
    loadError: null,
    app: data.app || state.app,
    setup: data.setup || state.setup,
    accounts,
    activeAccountId: pickActiveAccount(accounts, state.activeAccountId),
    settings: data.settings || state.settings,
    transfers,
    batches: data.batches || [],
    stats: data.stats || EMPTY_STATS,
  })
  applyTheme(state.settings?.theme)
}

function asArray(data, key) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data[key])) return data[key]
  return []
}

function mergeTransfers(list) {
  if (!list.length) return
  const next = new Map(state.transfers)
  for (const t of list) next.set(t.id, t)
  setState({ transfers: next })
}

function removeTransfers(ids) {
  if (!ids.length) return
  const next = new Map(state.transfers)
  let changed = false
  for (const id of ids) changed = next.delete(id) || changed
  if (changed) setState({ transfers: next })
}

export function setSettings(settings) {
  if (!settings) return
  setState({ settings })
  applyTheme(settings.theme)
}

export function setSetup(setup) {
  if (setup) setState({ setup })
}

export function setAccounts(accounts) {
  setState({ accounts, activeAccountId: pickActiveAccount(accounts, state.activeAccountId) })
}

export function setActiveAccount(id) {
  storage.set('account', id)
  setState({ activeAccountId: id })
}

export function setCompareJob(jobId, info) {
  setState({ compare: { ...state.compare, [jobId]: { ...(state.compare[jobId] || {}), ...info } } })
}

// ───── tema ─────

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null

export function applyTheme(theme) {
  const root = document.documentElement
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme
  else delete root.dataset.theme
  storage.set('theme', theme || 'system')
  const dark = theme === 'dark' || (theme !== 'light' && darkQuery?.matches)
  root.style.colorScheme = dark ? 'dark' : 'light'
}
darkQuery?.addEventListener?.('change', () => applyTheme(state.settings?.theme))

// ───── conexão ─────

let es = null
let retryTimer = null

function on(name, fn) {
  es.addEventListener(name, (e) => {
    let data
    try {
      data = JSON.parse(e.data)
    } catch {
      return
    }
    fn(data)
  })
}

function connect() {
  clearTimeout(retryTimer)
  try {
    es?.close()
  } catch {}
  es = new EventSource('/api/events')
  setState({ conn: state.conn === 'open' ? 'open' : 'connecting' })
  es.onopen = () => setState({ conn: 'open' })
  es.onerror = () => {
    setState({ conn: 'lost' })
    // o EventSource tenta sozinho; se desistiu (CLOSED), tentamos nós
    if (es.readyState === 2) retryTimer = setTimeout(connect, 3000)
  }
  on('hello', applyFull)
  on('transfers', (d) => mergeTransfers(asArray(d, 'transfers')))
  on('removed', (d) => removeTransfers(asArray(d, 'ids')))
  on('batches', (d) => setState({ batches: asArray(d, 'batches') }))
  on('stats', (d) => setState({ stats: d?.stats || d || EMPTY_STATS }))
  on('accounts', (d) => setAccounts(asArray(d, 'accounts')))
  on('settings', (d) => setSettings(d?.settings || d))
  on('setup', (d) => setSetup(d?.setup || d))
  on('compare', (d) => d?.jobId && setCompareJob(d.jobId, { status: d.status, progress: d.progress, error: d.error || null }))
  on('toast', (d) => d?.message && toast(d.kind || 'info', d.message))
}

export async function start() {
  try {
    const data = await api.get('/api/state')
    applyFull(data)
  } catch (err) {
    setState({ status: 'error', loadError: err.message })
    retryTimer = setTimeout(start, 4000)
    return
  }
  connect()
}

export async function reload() {
  try {
    applyFull(await api.get('/api/state'))
  } catch (err) {
    toast('error', err.message)
  }
}

// ───── derivados ─────

export const ACTIVE = new Set(['running', 'verifying', 'queued', 'waiting'])

export function activeCount(transfers) {
  let n = 0
  for (const t of transfers.values()) if (ACTIVE.has(t.status)) n++
  return n
}
