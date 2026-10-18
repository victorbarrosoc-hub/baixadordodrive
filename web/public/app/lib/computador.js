// "No computador": o andamento das transferências que o app SOBEDESCE do computador manda para a conta
// (GET /api/transferencias, docs/CONTAS.md §9) e os avisos por Web Push ("Avisar no celular quando terminar").
// Atualiza a cada 5 s com a tela à vista quando algo anda ou a folha está aberta; 30 s quando tudo está parado;
// nada com a tela escondida.
import { getState, setState } from './state.js'
import { isStandalone } from './platform.js'

export const API = { transferencias: '/api/transferencias', inscricao: '/api/push/inscricao' }

const RAPIDO_MS = 5000
const DEVAGAR_MS = 30000
const DIA = 24 * 60 * 60 * 1000

const ATIVOS = new Set(['enviando', 'baixando'])

// ───── leitura ─────

let timer = 0
let inflight = null
let started = false
let fast = 0 // quantas telas pediram o ritmo rápido (folha aberta)

/** Idade da notícia de um computador, pelo relógio do servidor (o do celular pode estar torto). */
export function ageOf(pc, pcState = getState().pc) {
  const base = Number(pcState?.agora) || Date.now()
  const passou = Date.now() - (Number(pcState?.at) || Date.now())
  return Math.max(0, base - Number(pc.atualizadoEm) + passou)
}

/** O computador está andando (e com notícia recente). */
export function isActive(pc) {
  return pc?.online && ATIVOS.has(pc.snapshot?.estado)
}

/** Vale mostrar no cartão da tela principal: algo andando, parado no meio, ou que terminou nas últimas 24 h. */
export function isRelevant(pc, pcState = getState().pc) {
  const s = pc?.snapshot
  if (!s) return false
  if (ATIVOS.has(s.estado) || s.estado === 'pausado') return ageOf(pc, pcState) < DIA
  const ultimo = s.terminados?.[0]?.terminouEm
  if (!ultimo) return false
  const agora = Number(pcState?.agora) || Date.now()
  return agora - ultimo < DIA
}

export async function refreshPc() {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch(API.transferencias, { headers: { accept: 'application/json', 'x-sobedesce-app': 'celular' }, cache: 'no-store', credentials: 'same-origin' })
      if (res.status === 401) return setState((s) => ({ pc: { ...s.pc, status: 'signedOut' } }))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = await res.json()
      setState({
        pc: {
          status: 'ok',
          computadores: Array.isArray(d.computadores) ? d.computadores : [],
          agora: Number(d.agora) || Date.now(),
          at: Date.now(),
          push: d.push || null,
          error: null,
        },
      })
    } catch (err) {
      setState((s) => ({ pc: { ...s.pc, status: s.pc?.computadores?.length ? 'ok' : 'error', error: err?.message || 'erro' } }))
    } finally {
      inflight = null
    }
  })()
  return inflight
}

function schedule() {
  clearTimeout(timer)
  timer = 0
  if (!started || document.visibilityState === 'hidden') return
  const busy = fast > 0 || (getState().pc?.computadores || []).some(isActive)
  timer = setTimeout(tick, busy ? RAPIDO_MS : DEVAGAR_MS)
}

async function tick() {
  await refreshPc()
  schedule()
}

/** Começa a acompanhar (depois de entrar na conta). */
export function startPc() {
  if (started) return
  started = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick()
    else schedule()
  })
  tick()
  syncPush().catch(() => {})
}

/** A folha "No computador" aberta: ritmo de 5 s (e uma leitura na hora). Devolve o "fechar". */
export function watchFast() {
  fast++
  tick()
  return () => {
    fast = Math.max(0, fast - 1)
    schedule()
  }
}

// ───── avisos (Web Push) ─────

export function pushSupported() {
  try {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  } catch {
    return false
  }
}

/** No iPhone, o Safari só deixa pedir notificação com o app na Tela de Início. */
export function pushNeedsInstall(ios) {
  return ios && !isStandalone()
}

function keyBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

async function registration() {
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('sw')), 8000))])
  if (!reg?.pushManager) throw new Error('sem-push')
  return reg
}

/** { suportado, permissao: 'default'|'granted'|'denied', inscrito } */
export async function pushStatus() {
  if (!pushSupported()) return { suportado: false, permissao: 'default', inscrito: false }
  const permissao = Notification.permission
  let inscrito = false
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    inscrito = Boolean(await reg?.pushManager?.getSubscription())
  } catch {
    inscrito = false
  }
  return { suportado: true, permissao, inscrito: inscrito && permissao === 'granted' }
}

async function send(method, body) {
  const res = await fetch(API.inscricao, { method, headers: { 'content-type': 'application/json', 'x-sobedesce-app': 'celular' }, body: JSON.stringify(body), credentials: 'same-origin' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

/** Pede a permissão, inscreve o aparelho no serviço de push do navegador e avisa o site. */
export async function enablePush() {
  const chave = getState().pc?.push?.chavePublica
  if (!chave) throw new Error('Os avisos ainda não estão disponíveis. Tente de novo em instantes.')
  const permissao = await Notification.requestPermission()
  if (permissao !== 'granted') {
    const e = new Error(permissao === 'denied' ? 'bloqueado' : 'recusado')
    e.code = permissao
    throw e
  }
  const reg = await registration()
  let sub = await reg.pushManager.getSubscription()
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(chave) })
  await send('POST', sub.toJSON())
}

export async function disablePush() {
  const reg = await registration().catch(() => null)
  const sub = await reg?.pushManager?.getSubscription()
  if (!sub) return
  await send('DELETE', { endpoint: sub.endpoint }).catch(() => {})
  await sub.unsubscribe().catch(() => {})
}

/** Com o aparelho já inscrito, lembra o site (a inscrição pode ter caído lá, ou a conta ter mudado). */
async function syncPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager?.getSubscription()
  if (sub) await send('POST', sub.toJSON())
}

// ───── textos ─────

/** "~14 min", "~1 h 20 min", "menos de 1 min". */
export function aprox(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return null
  if (sec < 60) return 'menos de 1 min'
  const min = Math.round(sec / 60)
  if (min < 60) return `~${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `~${h} h ${m} min` : `~${h} h`
}

/** "agora", "há 12 min", "há 3 h", "há 2 dias". */
export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 45) return 'agora'
  const min = Math.round(s / 60)
  if (min < 60) return `há ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.round(h / 24)
  return `há ${d} ${d === 1 ? 'dia' : 'dias'}`
}

export function fraction(s) {
  const g = s?.geral
  if (!g || !g.totalBytes) return g?.total ? g.feitos / g.total : 0
  return Math.max(0, Math.min(1, g.feitoBytes / g.totalBytes))
}
