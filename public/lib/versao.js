// Aviso de versão nova (o motor confere no site; src/version.js). O app não se atualiza sozinho:
// "Baixar" abre o instalador certo no navegador do sistema, "Depois" esconde este build até sair um mais novo.
import { api, attempt } from './api.js'
import { getState, setVersao } from './store.js'
import { openExternal } from './desktop.js'

/** "Baixe e substitua…" (Mac) ou "Baixe e rode…" (Windows). */
export function installHint(plataforma) {
  return plataforma === 'windows' ? 'Baixe e rode o instalador.' : 'Baixe e substitua o app em Aplicativos.'
}

/** "build 42 · 15 de out. de 2026" (ou "versão de desenvolvimento"). */
export function buildLabel(info) {
  if (!info?.build) return 'versão de desenvolvimento'
  const d = info.data ? new Date(info.data) : null
  const when = d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
  return when ? `build ${info.build} · ${when}` : `build ${info.build}`
}

export function downloadUpdate() {
  const url = getState().versao?.baixarUrl
  if (url) openExternal(url)
}

export async function dismissUpdate() {
  const build = getState().versao?.ultima?.build
  const res = await attempt(api.post('/api/versao/depois', build ? { build } : {}))
  if (res?.versao) setVersao(res.versao)
}

/** "Procurar atualização": pergunta ao site agora. Devolve o estado novo (ou null se o motor não respondeu). */
export async function checkUpdate() {
  const res = await attempt(api.post('/api/versao/verificar'))
  if (res?.versao) setVersao(res.versao)
  return res?.versao ?? null
}
