// Integração com o app de desktop (Electron). O preload expõe `window.sobedesce`; sem ele (navegador),
// tudo cai no comportamento de sempre: seletor próprio, links normais, POST /api/reveal.
//
// window.sobedesce = { desktop: true, platform, pickFolder({ title, defaultPath }) → Promise<string|null>,
//   pickPaths({ title, defaultPath, kind: 'any'|'files' }) → Promise<string[]>, pathForFile(File) → string,
//   setProgress(fraction|null, activeCount), notify(title, body), openExternal(url), reveal(path) }
import { api, attempt } from './api.js'
import { toast } from './toasts.js'
import { openModal, pickLocal } from './modals.js'
import { getState, setAccounts, setOAuthWait, setSetup, subscribe } from './store.js'
import { bytes, plural } from './format.js'

const raw = typeof window !== 'undefined' ? window.sobedesce : null
/** A ponte nativa, ou null no navegador. */
export const bridge = raw && raw.desktop ? raw : null
export const isDesktop = !!bridge

/** Plataforma de verdade: a da ponte (desktop) ou a que o motor informou. */
export function platform() {
  return bridge?.platform || getState().app?.platform || ''
}

function safe(fn, fallback = null) {
  try {
    return fn()
  } catch (err) {
    console.info('[sobedesce] ponte nativa falhou:', err?.message || err)
    return fallback
  }
}

// ───── seletores ─────

/** Uma pasta do computador. Nativo no desktop; o seletor próprio no navegador (ou se o nativo falhar). */
export async function pickFolderPath({ title, defaultPath, subtitle } = {}) {
  if (bridge?.pickFolder) {
    try {
      const p = await bridge.pickFolder({ title, defaultPath: defaultPath || undefined })
      return p || null
    } catch (err) {
      console.info('[sobedesce] seletor nativo indisponível, usando o próprio:', err?.message || err)
    }
  }
  return pickLocal({ mode: 'folder', title, subtitle, initialPath: defaultPath || undefined })
}

/**
 * Arquivos e pastas para enviar. No macOS o diálogo nativo aceita os dois juntos; no Windows/Linux o diálogo
 * nativo só escolhe arquivos OU uma pasta, então mostramos um menu "Arquivos… / Pasta…" ancorado no botão.
 * @param {{ title?: string, anchor?: Element|null }} opts
 * @returns {Promise<string[]|null>}
 */
export async function pickUploadPaths({ title, anchor } = {}) {
  if (bridge?.pickPaths) {
    try {
      if (platform() === 'darwin') {
        const list = await bridge.pickPaths({ title, kind: 'any' })
        return list?.length ? list : null
      }
      const rect = anchor?.getBoundingClientRect?.()
      const choice = await openModal('choice', {
        title: 'O que você quer enviar?',
        anchorRect: rect ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } : null,
        options: [
          { value: 'files', icon: 'doc', label: 'Arquivos…', hint: 'Um ou vários, da mesma pasta' },
          { value: 'folder', icon: 'folder', label: 'Pasta…', hint: 'Vai com tudo dentro' },
        ],
        foot: 'Dica: dá para arrastar arquivos e pastas direto para a janela.',
      })
      if (choice === 'files') {
        const list = await bridge.pickPaths({ title, kind: 'files' })
        return list?.length ? list : null
      }
      if (choice === 'folder') {
        const p = await bridge.pickFolder({ title })
        return p ? [p] : null
      }
      return null
    } catch (err) {
      console.info('[sobedesce] seletor nativo indisponível, usando o próprio:', err?.message || err)
    }
  }
  return pickLocal({ mode: 'files', title })
}

/** Caminhos dos itens soltos (arquivos e pastas) — só existe no desktop. */
export function pathsFromDrop(dataTransfer) {
  if (!bridge?.pathForFile || !dataTransfer) return []
  const out = []
  for (const f of Array.from(dataTransfer.files || [])) {
    const p = safe(() => bridge.pathForFile(f), '')
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/** O primeiro item solto é uma pasta? (null = não dá para saber) */
export function droppedIsFolder(dataTransfer) {
  const item = dataTransfer?.items?.[0]
  const entry = item?.webkitGetAsEntry?.()
  return entry ? entry.isDirectory : null
}

// ───── links externos, Finder ─────

export function openExternal(url) {
  const abs = new URL(url, location.href).href
  if (bridge?.openExternal) {
    safe(() => bridge.openExternal(abs))
    return
  }
  window.open(abs, '_blank', 'noopener,noreferrer')
}

/** Mac: abre Ajustes do Sistema na Rede Local ou no Firewall (src/celular/rede-local.js, firewall.js). */
export function abrirAjustesRede(qual = 'rede-local') {
  if (!bridge?.abrirAjustesRede) return false
  safe(() => bridge.abrirAjustesRede(qual))
  return true
}

export function revealPath(path) {
  if (!path) return null
  if (bridge?.reveal) {
    safe(() => bridge.reveal(path))
    return null
  }
  return attempt(api.post('/api/reveal', { path }))
}

export function revealLabel(p = platform()) {
  if (p === 'darwin') return 'Mostrar no Finder'
  if (p === 'win32') return 'Mostrar no Explorer'
  return 'Mostrar na pasta'
}

// ───── login do Google no navegador do sistema ─────
// O Google bloqueia login dentro de janelas Electron. No desktop, "Conectar" abre o navegador padrão e a
// interface espera a conta aparecer (evento SSE 'accounts' + consulta a /api/state a cada 3 s).

let pollTimer = null

export function beginOAuth() {
  const { accounts } = getState()
  openExternal('/api/auth/start')
  setOAuthWait({
    since: Date.now(),
    before: accounts.map((a) => a.id),
    reauth: accounts.filter((a) => a.status === 'reauth').map((a) => a.id),
  })
  clearInterval(pollTimer)
  pollTimer = setInterval(async () => {
    if (!getState().oauthWait) return clearInterval(pollTimer)
    // depois de 15 min sem resposta, para de consultar (a pessoa pode clicar de novo)
    if (Date.now() - getState().oauthWait.since > 15 * 60e3) return cancelOAuth()
    try {
      const st = await api.get('/api/state')
      if (st.setup) setSetup(st.setup)
      if (Array.isArray(st.accounts)) setAccounts(st.accounts)
    } catch {}
  }, 3000)
}

export function reopenOAuth() {
  openExternal('/api/auth/start')
}

export function cancelOAuth() {
  clearInterval(pollTimer)
  setOAuthWait(null)
}

function watchOAuth(state) {
  const w = state.oauthWait
  if (!w) return
  // conta nova, conta que pedia reconexão, ou a mesma conta autorizada de novo (consentedAt renova a cada login)
  const fresh = state.accounts.find(
    (a) => !w.before.includes(a.id) || (w.reauth.includes(a.id) && a.status === 'ok') || (a.status === 'ok' && (a.consentedAt || 0) >= w.since),
  )
  if (fresh) {
    cancelOAuth()
    toast('success', `Conta conectada: ${fresh.email}`)
  }
}

/** Intercepta links que saem do app (Console do Google, Drive, OAuth) para abrir no navegador do sistema. */
function interceptLinks() {
  document.addEventListener(
    'click',
    (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = e.target?.closest?.('a[href]')
      if (!a) return
      const href = a.getAttribute('href')
      if (!href || href.startsWith('#')) return
      const url = new URL(href, location.href)
      if (url.origin === location.origin && url.pathname === '/api/auth/start') {
        e.preventDefault()
        beginOAuth()
        return
      }
      if (url.origin !== location.origin || a.target === '_blank') {
        e.preventDefault()
        openExternal(url.href)
      }
    },
    true,
  )
}

// ───── soltar arquivos fora de um alvo não pode navegar a janela ─────

function guardDrops() {
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files')
  window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault())
  window.addEventListener('drop', (e) => hasFiles(e) && e.preventDefault())
}

// ───── progresso no Dock / barra de tarefas ─────

const WORKING = new Set(['running', 'verifying', 'queued', 'waiting'])
let lastProgressAt = 0
let lastProgressKey = ''
let progressTimer = null

function computeProgress(transfers) {
  let size = 0
  let done = 0
  let active = 0
  for (const t of transfers.values()) {
    if (!WORKING.has(t.status)) continue
    active++
    if (!t.size) continue
    size += t.size
    done += t.status === 'verifying' ? t.size : Math.min(t.size, t.bytesDone || 0)
  }
  if (!active) return { fraction: null, active: 0 }
  return { fraction: size ? Math.max(0, Math.min(1, done / size)) : 0, active }
}

function pushProgress() {
  progressTimer = null
  lastProgressAt = Date.now()
  const { fraction, active } = computeProgress(getState().transfers)
  const key = fraction == null ? 'none' : `${fraction.toFixed(3)}:${active}`
  if (key === lastProgressKey) return
  lastProgressKey = key
  safe(() => bridge.setProgress(fraction, active))
}

function scheduleProgress() {
  if (!bridge?.setProgress || progressTimer) return
  const wait = Math.max(0, 1000 - (Date.now() - lastProgressAt))
  progressTimer = setTimeout(pushProgress, wait)
}

// ───── avisos do sistema (lote terminou, item com problema) ─────

function systemNotify(title, body) {
  if (typeof document !== 'undefined' && document.hasFocus()) return
  if (bridge?.notify) {
    safe(() => bridge.notify(title, body))
    return
  }
  try {
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, icon: '/favicon.svg', silent: false })
  } catch {}
}

if (typeof window !== 'undefined') {
  window.addEventListener('sd:backup', (ev) => systemNotify(ev.detail?.titulo || 'SOBEDESCE', ev.detail?.texto || ''))
  window.addEventListener('sd:lan-pedido', (ev) => systemNotify(`${ev.detail?.quem || 'Alguém'} quer te mandar arquivos`, 'Abra Dispositivos no SOBEDESCE para aceitar ou recusar.'))
}

const FIN = new Set(['completed', 'skipped'])
let baseEpoch = -1
let prevObjs = new Map() // id -> objeto da última vez
let doneBatches = new Set()

function batchStats(transfers) {
  const by = new Map()
  for (const t of transfers.values()) {
    let b = by.get(t.batchId)
    if (!b) by.set(t.batchId, (b = { n: 0, fin: 0, bytes: 0, type: t.type }))
    if (t.status === 'canceled') continue
    b.n++
    if (FIN.has(t.status)) b.fin++
    b.bytes += t.size || 0
  }
  return by
}

function rebaseline(state) {
  baseEpoch = state.epoch
  prevObjs = new Map(state.transfers)
  doneBatches = new Set()
  for (const [id, b] of batchStats(state.transfers)) if (b.n && b.fin === b.n) doneBatches.add(id)
}

function watchTransfers(state) {
  if (state.epoch !== baseEpoch) return rebaseline(state)
  const failed = []
  let changed = false
  for (const [id, t] of state.transfers) {
    const prev = prevObjs.get(id)
    if (prev === t) continue
    changed = true
    if (t.status === 'failed' && prev && prev.status !== 'failed') failed.push(t)
  }
  if (!changed && prevObjs.size === state.transfers.size) return
  prevObjs = new Map(state.transfers)

  if (failed.length === 1) systemNotify(`Problema em ${failed[0].name}`, failed[0].error?.message || 'A transferência parou. Abra o SOBEDESCE para tentar de novo.')
  else if (failed.length > 1) systemNotify(`${failed.length} transferências com problema`, failed[0].error?.message || 'Abra o SOBEDESCE para ver o que houve.')

  const labels = new Map(state.batches.map((b) => [b.id, b.label]))
  for (const [id, b] of batchStats(state.transfers)) {
    const done = b.n > 0 && b.fin === b.n
    if (done && !doneBatches.has(id)) {
      doneBatches.add(id)
      const label = labels.get(id) || (b.type === 'upload' ? 'Envio' : 'Download')
      systemNotify(`${label} terminou`, `${plural(b.n, 'arquivo', 'arquivos')}, ${bytes(b.bytes)}${b.type === 'upload' ? ' · no Drive' : ''}`)
    } else if (!done) doneBatches.delete(id)
  }
}

// ───── início ─────

let started = false
export function startDesktopIntegration() {
  if (started) return
  started = true
  guardDrops()
  if (bridge) {
    const root = document.documentElement
    root.classList.add('is-desktop', `platform-${bridge.platform || 'unknown'}`)
    interceptLinks()
  }
  let lastTransfers = null
  let lastStats = null
  let lastAccounts = null
  subscribe((state) => {
    if (state.status !== 'ready') return
    const transfersChanged = state.transfers !== lastTransfers
    if (transfersChanged) {
      lastTransfers = state.transfers
      watchTransfers(state)
    }
    if (transfersChanged || state.stats !== lastStats) {
      lastStats = state.stats
      scheduleProgress()
    }
    if (state.accounts !== lastAccounts) {
      lastAccounts = state.accounts
      watchOAuth(state)
    }
  })
}
