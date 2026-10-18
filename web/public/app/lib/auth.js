// Conta SOBEDESCE: o celular não entra no Google. O site (mesma origem, cookie de sessão) diz quem está logado e
// quais Google Drives a conta tem (GET /api/eu) e entrega o token de acesso do Drive escolhido
// (POST /api/drive/token). Contrato em docs/CONTAS.md.
//
// - O token fica só em memória. ~5 min antes de vencer pedimos outro, sem toque nenhum (o servidor renova no Google).
// - O Google respondeu 401 → invalidate() e o próximo pedido vai com { renovar: true }.
// - 409 "reconectar" → os envios que precisam de token pausam e a tela pede para reconectar o Drive na conta.
//   Quando a conta volta ao normal (conferimos ao voltar para a tela), os envios pausados por isso continuam.
// - Sem rede ou servidor fora do ar → tenta de novo com recuo; quem precisa de token espera.
import { ACCOUNT, LAN, local } from './config.js'
import { getState, setState } from './state.js'

const DRIVE_KEY = 'sobedesce.drive' // id da conta Drive escolhida neste aparelho
const EARLY_MS = 5 * 60_000 // renova com esta folga (o servidor também renova quando falta menos que isso)
const MIN_MS = 60_000 // abaixo disso o token não serve mais para começar nada
const RECHECK_MS = 20_000 // com "reconectar" na tela, confere a conta de tempos em tempos

let token = null // { value, expiresAt, drive }
let renew = false // o Google recusou o token atual: o próximo pedido vai com renovar: true
let inflight = null
let timer = 0
let recheckTimer = 0
let booting = null

function setAuth(patch) {
  setState((s) => ({ auth: { ...s.auth, ...patch } }))
}

function signedOutError(message = 'Você saiu da conta.') {
  return Object.assign(new Error(message), { signedOut: true })
}

function reconnectError(message) {
  return Object.assign(new Error(message || 'Reconecte o Google Drive na sua conta.'), { signedOut: true, reconnect: true })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json', 'x-sobedesce-app': 'celular', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    // corpo vazio ou HTML de erro
  }
  return { status: res.status, ok: res.ok, json }
}

// ───── conta e Drives ─────

/** Ao abrir (e ao voltar para a tela, quando falta algo): quem está logado e quais Drives a conta tem. */
export function boot() {
  if (LAN) return Promise.resolve()
  if (!booting) booting = load().finally(() => (booting = null))
  return booting
}

async function load() {
  const first = getState().auth.status === 'loading'
  let r
  try {
    r = await api(ACCOUNT.me)
  } catch {
    r = null
  }
  if (r?.status === 401) return endSession(first ? null : 'Sua sessão terminou. Entre de novo.')
  if (!r?.ok || !r.json?.usuario) {
    // Sem rede (ou servidor fora do ar). Com a tela principal aberta, não derruba ninguém: só não atualiza.
    if (getState().auth.status !== 'signedIn') {
      setAuth({ status: 'error', error: r ? 'O SOBEDESCE não respondeu. Tente de novo em instantes.' : 'Sem conexão. Confira a internet e tente de novo.' })
    }
    return
  }
  apply(r.json)
}

function apply({ usuario, contas, recursos }) {
  const drives = Array.isArray(contas) ? contas : []
  setState({ account: usuario, drives, recursos: recursos && typeof recursos === 'object' ? recursos : {} })
  if (!drives.length) {
    forget()
    setState({ drive: null })
    setAuth({ status: 'noDrive', issue: null, error: null })
    return
  }
  const current = getState().drive
  const wanted = current?.id || local.get(DRIVE_KEY)
  const pick = drives.find((d) => d.id === wanted) || (drives.length === 1 ? drives[0] : null)
  if (!pick) {
    setAuth({ status: 'choose', issue: null, error: null })
    return
  }
  use(pick)
}

/** Usa esta conta Drive (id de Conta). Lembra a escolha neste aparelho. */
export function selectDrive(id) {
  const pick = (getState().drives || []).find((d) => d.id === id)
  if (pick) use(pick)
}

function use(drive) {
  local.set(DRIVE_KEY, drive.id)
  if (token && token.drive !== drive.id) forget()
  const wasIssue = getState().auth.issue
  setState({ drive })
  if (drive.estado === 'reconectar') {
    forget()
    // Com envios na tela, a tela principal fica e mostra o aviso; sem nada, a tela de reconectar.
    if (getState().auth.status === 'signedIn') setAuth({ issue: 'reconectar', error: null })
    else setAuth({ status: 'reconnect', issue: 'reconectar', error: null })
    watchRecheck()
    return
  }
  setAuth({ status: 'signedIn', issue: null, error: null })
  stopRecheck()
  if (wasIssue === 'reconectar') setState({ resumeAt: Date.now() }) // a tela principal retoma o que pausou por isso
  getToken().catch(() => {})
}

/** "Usar outro Drive" na tela de reconectar. */
export function chooseDrive() {
  setAuth({ status: 'choose', error: null })
}

function endSession(message) {
  forget()
  stopRecheck()
  setState({ account: null, drives: [], drive: null, user: null, quota: null, sheet: null })
  setAuth({ status: 'signedOut', issue: null, error: message || null })
}

function forget() {
  token = null
  renew = false
  clearTimeout(timer)
}

// Voltou para a tela (ou ganhou foco): se falta algo, confere a conta de novo — a pessoa pode ter entrado,
// conectado ou reconectado o Drive em outra aba.
function onBack() {
  if (LAN || document.visibilityState === 'hidden') return
  const { status, issue } = getState().auth
  if (status !== 'signedIn' && status !== 'loading') boot()
  else if (issue === 'reconectar') boot()
  else ensureFresh()
}

if (!LAN) {
  document.addEventListener('visibilitychange', onBack)
  window.addEventListener('focus', onBack)
  window.addEventListener('pageshow', (e) => e.persisted && onBack())
}

function watchRecheck() {
  if (recheckTimer) return
  recheckTimer = setInterval(() => {
    if (document.visibilityState !== 'hidden') boot()
  }, RECHECK_MS)
}

function stopRecheck() {
  clearInterval(recheckTimer)
  recheckTimer = 0
}

function markReconnect(message) {
  const drive = getState().drive
  forget()
  if (drive) {
    const flagged = { ...drive, estado: 'reconectar' }
    setState((s) => ({ drive: flagged, drives: (s.drives || []).map((d) => (d.id === drive.id ? flagged : d)) }))
  }
  setAuth({ issue: 'reconectar', error: message || null })
  watchRecheck()
}

/** A API do Drive recusou o acesso de vez (ex.: permissão retirada): pede para reconectar. */
export function needsReconnect(message) {
  markReconnect(message)
}

// ───── token do Drive ─────

/** Token válido (espera se precisar pedir outro ao servidor). */
export function getToken() {
  const { status, issue } = getState().auth
  if (status !== 'signedIn') return Promise.reject(signedOutError())
  if (issue === 'reconectar') return Promise.reject(reconnectError(getState().auth.error))
  if (token && !renew && token.drive === getState().drive?.id) {
    const left = token.expiresAt - Date.now()
    if (left > EARLY_MS) return Promise.resolve(token.value)
    if (left > MIN_MS) {
      refresh().catch(() => {})
      return Promise.resolve(token.value)
    }
  }
  return refresh()
}

function refresh() {
  if (!inflight) inflight = obtain().finally(() => (inflight = null))
  return inflight
}

async function obtain() {
  for (let attempt = 1; ; attempt++) {
    const { status, issue } = getState().auth
    const drive = getState().drive
    if (status !== 'signedIn' || !drive) throw signedOutError()
    if (issue === 'reconectar') throw reconnectError(getState().auth.error)
    let r
    try {
      r = await api(ACCOUNT.token, { method: 'POST', body: renew ? { conta: drive.id, renovar: true } : { conta: drive.id } })
    } catch {
      r = null
    }
    if (getState().drive?.id !== drive.id) continue // trocou de Drive no meio do pedido
    if (r?.ok && r.json?.accessToken) {
      const expiresAt = Number(r.json.expiraEm) || Date.now() + 50 * 60_000
      token = { value: String(r.json.accessToken), expiresAt, drive: drive.id }
      renew = false
      if (getState().auth.issue === 'rede') setAuth({ issue: null })
      schedule()
      return token.value
    }
    if (r?.status === 401) {
      endSession('Sua sessão terminou. Entre de novo.')
      throw signedOutError()
    }
    if (r?.status === 409) {
      const message = r.json?.mensagem || `O Google pediu uma nova autorização para ${drive.email}.`
      markReconnect(message)
      throw reconnectError(message)
    }
    if (r?.status === 404) {
      // A conta Drive saiu da conta SOBEDESCE (removida em outra tela): recarrega a lista.
      forget()
      setState({ drive: null })
      await boot()
      throw signedOutError('Esse Google Drive não está mais na sua conta.')
    }
    // Rede, 5xx, 502 do Google: tenta de novo com recuo. Quem precisa de token espera.
    if (attempt >= 2 && !getState().auth.issue) setAuth({ issue: 'rede' })
    await sleep(Math.min(30_000, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5))
  }
}

/** Renova sozinho ~5 min antes de vencer (sem toque: quem renova é o servidor). */
function schedule() {
  clearTimeout(timer)
  if (!token) return
  const wait = Math.max(30_000, token.expiresAt - Date.now() - EARLY_MS)
  timer = setTimeout(() => refresh().catch(() => {}), wait)
}

/** O Google respondeu 401 com este token: descarta e o próximo pedido renova. */
export function invalidate(value) {
  if (!value || token?.value === value) {
    token = null
    renew = true
    clearTimeout(timer)
  }
}

/** Chamado de tempos em tempos enquanto há envios: renova com folga. */
export function ensureFresh() {
  if (getState().auth.status !== 'signedIn' || getState().auth.issue === 'reconectar') return
  if (token && token.expiresAt - Date.now() < EARLY_MS) refresh().catch(() => {})
}

export function expiresAt() {
  return token?.expiresAt ?? 0
}
