// Estado global mínimo: um objeto, quem quiser se inscreve. Os componentes leem com useApp(seletor).
import { useEffect, useReducer, useRef } from '../vendor/preact-htm.js'
import { LAN, local } from './config.js'

const listeners = new Set()

let state = {
  // status: 'loading' | 'signedOut' | 'noDrive' | 'choose' | 'reconnect' | 'error' | 'signedIn'
  // issue (com a tela principal aberta): null | 'reconectar' (o Google pediu nova autorização) | 'rede' (sem resposta)
  auth: { status: LAN ? 'signedIn' : 'loading', issue: null, error: null },
  account: null, // conta SOBEDESCE { id, email, nome }
  drives: [], // Google Drives da conta: [{ id, email, nome, fotoUrl, estado: 'ok' | 'reconectar' }]
  drive: null, // o Drive escolhido neste aparelho (um dos acima)
  resumeAt: 0, // o Drive voltou depois de "reconectar": retomar o que pausou por isso
  user: null, // { displayName, emailAddress, photoLink } (do próprio Drive, /about)
  quota: null, // { limit, usage }
  dest: null, // pasta de destino { id, name, driveId, path }
  awake: false, // trava de tela acesa ativa
  lan: null, // modo Wi-Fi: { mac, noAccount, deleteAfterUpload, error, badCode }
  sheet: null, // { name, props }
  tab: 'send', // 'send' (envio) | 'drive' (navegar e baixar) | 'ap' (Aparelhos, Wi-Fi) | 'refs' (Referências) | 'criar' (Frames…); no modo Wi-Fi só 'send'
  criarTela: 'hub', // aba Criar: 'hub' | 'frames' | 'calc'
  escolher: null, // aba Drive escolhendo um arquivo para outra tela: { para: 'frames' } (tocar no vídeo leva para lá)
  recursos: {}, // de /api/eu: { referencias: boolean }
  refs: { status: 'idle', colecoes: [], fila: [], raiz: null, error: null, at: 0 }, // Referências (lib/referencias.js)
  refsOpen: null, // id da coleção aberta na aba Referências
  // "No computador" (lib/computador.js): o andamento das transferências dos computadores da conta
  pc: { status: 'idle', computadores: [], agora: 0, at: 0, push: null, error: null },
  // Celular ↔ computador pelo Wi-Fi (lib/p2p.js): aparelhos ligados agora, o envio, o recebimento e "aceitar de outras pessoas"
  p2p: { aparelhos: [], envio: null, recebimento: null, outros: Boolean(local.get('sobedesce.p2p.outros', false)) },
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

// ───── abas ─────

const scrollByTab = {}
/** Troca de aba guardando a rolagem de cada uma (as duas telas usam a rolagem da página). */
export function setTab(tab) {
  const cur = state.tab
  if (cur === tab) {
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' })
    return
  }
  scrollByTab[cur] = window.scrollY
  setState({ tab })
  local.set('sobedesce.tab', tab)
  requestAnimationFrame(() => window.scrollTo(0, scrollByTab[tab] || 0))
}

export function savedTab() {
  if (LAN) return 'send'
  if (typeof location !== 'undefined' && location.hash === '#referencias') return 'refs'
  if (typeof location !== 'undefined' && location.hash === '#aparelhos') return 'ap'
  const t = local.get('sobedesce.tab')
  return t === 'drive' || t === 'ap' || t === 'refs' || t === 'criar' ? t : 'send'
}
