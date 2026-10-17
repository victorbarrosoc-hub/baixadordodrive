// Conta SOBEDESCE: entrar pelo código (fluxo de dispositivo), sair, recarregar a lista de Drives.
// O motor faz a conversa com o site; aqui só pedimos e abrimos o navegador (no app, pelo navegador do sistema).
import { api, attempt } from './api.js'
import { getState, setCloud } from './store.js'
import { openExternal } from './desktop.js'

export const SITE = 'https://sobedesce.com'

export function siteUrl() {
  return getState().cloud?.site || SITE
}

export function contaUrl() {
  return getState().cloud?.contaUrl || `${siteUrl()}/conta`
}

/** Criar conta (web/src/app/(conta)/criar-conta), no navegador do sistema. */
export function criarContaUrl() {
  return `${siteUrl()}/criar-conta`
}

/** Pede o código e já abre o navegador na página de liberar o computador. */
export async function cloudLogin({ open = true } = {}) {
  const res = await attempt(api.post('/api/cloud/login'))
  if (!res?.cloud) return null
  setCloud(res.cloud)
  const url = res.cloud.login?.url
  if (open && url) openExternal(url)
  return res.cloud
}

export function openLoginPage() {
  const url = getState().cloud?.login?.url
  if (url) openExternal(url)
}

export async function cloudCancel() {
  const res = await attempt(api.post('/api/cloud/login/cancel'))
  if (res?.cloud) setCloud(res.cloud)
}

export async function cloudLogout() {
  const res = await attempt(api.post('/api/cloud/logout'))
  if (res?.cloud) setCloud(res.cloud)
  return res?.cloud ?? null
}

let lastRefresh = 0
/** Recarrega a lista de Drives da conta (no máximo uma vez a cada 20 s, salvo `force`). */
export async function cloudRefresh({ force = false, quiet = false } = {}) {
  if (!getState().cloud?.conectado) return null
  if (!force && Date.now() - lastRefresh < 20_000) return null
  lastRefresh = Date.now()
  const call = api.post('/api/cloud/refresh')
  const res = quiet ? await call.catch(() => null) : await attempt(call)
  if (res?.cloud) setCloud(res.cloud)
  return res?.cloud ?? null
}

/** Voltar para a janela depois de mexer em sobedesce.com/conta: a lista se atualiza sozinha. */
export function startCloudWatch() {
  const onBack = () => {
    if (document.visibilityState === 'visible') cloudRefresh({ quiet: true })
  }
  window.addEventListener('focus', onBack)
  document.addEventListener('visibilitychange', onBack)
}

/** Conta da nuvem? (id 'nuvem:<id>') */
export const isCloudAccount = (a) => (typeof a === 'string' ? a : a?.id || '').startsWith('nuvem:')
