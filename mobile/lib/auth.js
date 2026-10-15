// Login com Google Identity Services (modelo de token, só no navegador).
//
// - O token de acesso fica em memória + sessionStorage (morre quando a aba fecha), com a validade.
// - ~5 min antes de vencer pedimos outro com requestAccessToken({ prompt: '' }). O iPhone costuma bloquear o
//   popup sem um toque do usuário: aí quem precisa de token espera e a tela mostra a pílula
//   "Toque para continuar conectado", que pede o token dentro do toque e libera tudo.
// - Modo de teste (DEV): sem GIS; o token vem da URL e a "renovação" chama window.__sobedesceDevRefresh.
import { DEV, DRIVE_SCOPE, local, session } from './config.js'
import { getState, setState } from './state.js'

const GIS_SRC = 'https://accounts.google.com/gsi/client'
const TOKEN_KEY = 'sobedesce.token'
const HINT_KEY = 'sobedesce.hint'
const EARLY_MS = 5 * 60_000 // renova com esta folga
const MIN_MS = 60_000 // abaixo disso o token não serve mais para começar nada

let token = null // { value, expiresAt }
let client = null
let clientFor = null
let gisPromise = null
let refreshing = false
let refreshTimer = 0
let waiters = []

function setAuth(patch) {
  setState((s) => ({ auth: { ...s.auth, ...patch } }))
}

export function getHint() {
  return local.get(HINT_KEY)
}

export function rememberUser(email) {
  if (!DEV && email) local.set(HINT_KEY, email)
}

// ───── GIS ─────

export function loadGis() {
  if (DEV) return Promise.resolve(null)
  if (window.google?.accounts?.oauth2) return Promise.resolve(window.google)
  if (gisPromise) return gisPromise
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = GIS_SRC
    s.async = true
    s.onload = () => (window.google?.accounts?.oauth2 ? resolve(window.google) : reject(new Error('gis')))
    s.onerror = () => {
      gisPromise = null
      s.remove()
      reject(new Error('Não consegui carregar o login do Google. Confira a internet e tente de novo.'))
    }
    document.head.appendChild(s)
  })
  return gisPromise
}

/**
 * Carrega o GIS e cria o cliente de token ANTES do toque. No iPhone o popup só abre se requestAccessToken
 * rodar direto no toque, sem nenhum await no meio.
 */
export async function prepare(clientId) {
  if (DEV) return
  const google = await loadGis()
  if (client && clientFor === clientId) return
  client = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: DRIVE_SCOPE,
    callback: onToken,
    error_callback: onError,
  })
  clientFor = clientId
}

export function isReady() {
  return Boolean(DEV || client)
}

const MESSAGES = {
  popup_failed_to_open: 'O navegador bloqueou a janela do Google. Toque em Entrar de novo.',
  access_denied: 'Sem a permissão do Google Drive o SOBEDESCE não consegue enviar. Entre de novo e deixe o acesso ao Drive marcado.',
  scope: 'Sem a permissão do Google Drive o SOBEDESCE não consegue enviar. Entre de novo e deixe o acesso ao Drive marcado.',
  invalid_client: 'O Google não reconheceu este ID do cliente. Confira em Configurar.',
  unauthorized_client: 'O Google não reconheceu este ID do cliente. Confira em Configurar.',
}

function onToken(resp) {
  clearTimeout(refreshTimer)
  refreshing = false
  if (!resp || resp.error) return onError({ type: resp?.error || 'unknown' })
  const oauth2 = window.google?.accounts?.oauth2
  if (oauth2 && !oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) return onError({ type: 'scope' })
  setToken(resp.access_token, Number(resp.expires_in) || 3599)
}

function onError(err) {
  clearTimeout(refreshTimer)
  refreshing = false
  const type = err?.type || 'unknown'
  if (getState().auth.status === 'signingIn') {
    // Fechar a janela sem entrar não é erro; o resto ganha uma explicação curta.
    const message = type === 'popup_closed' ? null : MESSAGES[type] || 'O Google não completou o login. Tente de novo.'
    setAuth({ status: 'signedOut', error: message })
  } else if (getState().auth.status === 'signedIn') {
    // Renovação falhou (popup bloqueado, fechado ou negado): só um toque resolve.
    setAuth({ needsTap: true })
  }
}

function setToken(value, expiresInSec) {
  token = { value, expiresAt: Date.now() + expiresInSec * 1000 }
  if (!DEV) session.set(TOKEN_KEY, token)
  setAuth({ status: 'signedIn', needsTap: false, error: null })
  const ready = waiters
  waiters = []
  for (const w of ready) w.resolve(value)
}

// ───── ciclo de vida ─────

/** Ao abrir: reaproveita o token da aba (se ainda vale) ou o do modo de teste. */
export function restore() {
  if (DEV) {
    setToken(DEV.token, 3600)
    return true
  }
  const saved = session.get(TOKEN_KEY)
  if (saved?.value && saved.expiresAt - Date.now() > MIN_MS) {
    token = saved
    setAuth({ status: 'signedIn', needsTap: false, error: null })
    return true
  }
  session.set(TOKEN_KEY, null)
  return false
}

/** Toque em "Entrar com Google". Precisa rodar dentro do toque (síncrono). */
export function signIn() {
  if (DEV) return setToken(DEV.token, 3600)
  if (!client) {
    setAuth({ error: 'O login do Google ainda está carregando. Tente de novo em instantes.' })
    return
  }
  setAuth({ status: 'signingIn', error: null })
  try {
    const hint = getHint()
    client.requestAccessToken(hint ? { login_hint: hint } : {})
  } catch {
    setAuth({ status: 'signedOut', error: MESSAGES.popup_failed_to_open })
  }
}

/** Token válido (espera se precisar renovar — inclusive pelo toque na pílula). */
export function getToken() {
  if (token) {
    const left = token.expiresAt - Date.now()
    if (left > EARLY_MS) return Promise.resolve(token.value)
    if (left > MIN_MS) {
      refreshSoon()
      return Promise.resolve(token.value)
    }
  }
  if (getState().auth.status !== 'signedIn') return Promise.reject(Object.assign(new Error('Você saiu da conta.'), { signedOut: true }))
  refreshSoon()
  return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
}

/** O Google respondeu 401 com este token: descarta e pede outro. */
export function invalidate(value) {
  if (token && (!value || token.value === value)) {
    token = null
    if (!DEV) session.set(TOKEN_KEY, null)
  }
}

/** Chamado de tempos em tempos enquanto há envios: renova com folga. */
export function ensureFresh() {
  if (token && token.expiresAt - Date.now() < EARLY_MS) refreshSoon()
}

export function expiresAt() {
  return token?.expiresAt ?? 0
}

function refreshSoon() {
  if (refreshing || getState().auth.needsTap) return
  refreshing = true
  if (DEV) return void devRefresh(false)
  if (!client) {
    const id = getState().clientId
    prepare(id).then(
      () => {
        refreshing = false
        refreshSoon()
      },
      () => {
        refreshing = false
        setAuth({ needsTap: true })
      },
    )
    return
  }
  try {
    const hint = getHint()
    client.requestAccessToken({ prompt: '', ...(hint ? { login_hint: hint } : {}) })
  } catch {
    refreshing = false
    setAuth({ needsTap: true })
    return
  }
  // Se o navegador engolir o popup sem avisar, depois de um tempo mostramos a pílula.
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    if (refreshing) {
      refreshing = false
      setAuth({ needsTap: true })
    }
  }, 20_000)
}

/** Toque na pílula "Toque para continuar conectado" (dentro do toque, síncrono). */
export function tapRefresh() {
  setAuth({ needsTap: false })
  refreshing = true
  if (DEV) return void devRefresh(true)
  if (!client) {
    refreshing = false
    setAuth({ needsTap: true })
    return
  }
  try {
    const hint = getHint()
    client.requestAccessToken({ prompt: '', ...(hint ? { login_hint: hint } : {}) })
  } catch {
    refreshing = false
    setAuth({ needsTap: true })
  }
}

async function devRefresh(interactive) {
  const hook = window.__sobedesceDevRefresh
  if (typeof hook !== 'function') {
    refreshing = false
    setAuth({ needsTap: true })
    return
  }
  try {
    const value = await hook({ interactive })
    refreshing = false
    if (value) setToken(String(value), 3600)
    else setAuth({ needsTap: true })
  } catch {
    refreshing = false
    setAuth({ needsTap: true })
  }
}

export function signOut() {
  const value = token?.value
  token = null
  refreshing = false
  clearTimeout(refreshTimer)
  session.set(TOKEN_KEY, null)
  local.set(HINT_KEY, null)
  const pending = waiters
  waiters = []
  for (const w of pending) w.reject(Object.assign(new Error('Você saiu da conta.'), { signedOut: true }))
  setState({ user: null, quota: null, sheet: null })
  setAuth({ status: 'signedOut', needsTap: false, error: null })
  if (value && !DEV) {
    try {
      window.google?.accounts?.oauth2?.revoke(value, () => {})
    } catch {
      // revogar é cortesia; o token já foi esquecido aqui
    }
  }
}
