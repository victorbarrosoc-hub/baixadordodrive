// Aviso de versão nova (o motor confere no site; src/version.js).
// App instalado no Mac/Windows: assim que sai uma versão nova, o motor já baixa, confere o SHA-256 e prepara em
// segundo plano (src/version.js + src/updater.js); o aviso mostra o progresso e, no fim, "Atualizar agora".
// "Baixar" abre o instalador certo no navegador do sistema (sempre fica como alternativa).
// "Depois" esconde este build até sair um mais novo.
import { api, attempt } from './api.js'
import { activeCount, getState, setVersao } from './store.js'
import { openExternal } from './desktop.js'
import { confirmDialog } from './modals.js'
import { bytes } from './format.js'

/** Fases do download (sozinho em segundo plano, ou depois do "Atualizar agora"). */
const BAIXANDO = new Set(['baixando', 'conferindo', 'preparando'])

/** "Baixe e substitua…" (Mac) ou "Baixe e rode…" (Windows); com Atualizar, o app faz isso sozinho. */
export function installHint(plataforma, podeAtualizar = false) {
  if (podeAtualizar) return 'O app baixa a versão nova, troca e abre de novo sozinho.'
  return plataforma === 'windows' ? 'Baixe e rode o instalador.' : 'Baixe e substitua o app em Aplicativos.'
}

/** "build 42 · 15 de out. de 2026" (ou "versão de desenvolvimento"). */
export function buildLabel(info) {
  if (!info?.build) return 'versão de desenvolvimento'
  const d = info.data ? new Date(info.data) : null
  const when = d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
  return when ? `build ${info.build} · ${when}` : `build ${info.build}`
}

/** O app está trocando de versão agora (a pessoa pediu "Atualizar agora"): sem botões, só o progresso. */
export function updating(v) {
  const a = v?.atualizacao
  return a?.fase === 'reiniciando' || (BAIXANDO.has(a?.fase) && !!a.aplicar)
}

/** Baixando a versão nova sozinho, em segundo plano (a pessoa ainda não pediu nada). */
export function downloadingAlone(v) {
  const a = v?.atualizacao
  return BAIXANDO.has(a?.fase) && !a.aplicar
}

/** Versão nova baixada, conferida e preparada: falta só o "Atualizar agora". */
export function updateReady(v) {
  return v?.atualizacao?.fase === 'pronto'
}

/**
 * Progresso da atualização para a interface: { label, fraction (0–1, ou null = sem medida), erro }.
 * null quando não há nada a mostrar.
 */
export function updateProgress(a) {
  if (!a?.fase) return null
  if (a.fase === 'erro') return { label: a.erro || 'Algo deu errado ao atualizar. Use Baixar.', fraction: null, erro: true }
  if (a.fase === 'baixando') {
    const total = Number(a.total) || 0
    const got = Number(a.recebido) || 0
    if (!total) return { label: got ? `Baixando a versão nova… ${bytes(got)}` : 'Baixando a versão nova…', fraction: null, erro: false }
    const f = Math.min(1, got / total)
    return { label: `Baixando a versão nova… ${Math.floor(f * 100)}% · ${bytes(got)} de ${bytes(total)}`, fraction: f, erro: false }
  }
  if (a.fase === 'conferindo') return { label: 'Conferindo o arquivo…', fraction: 1, erro: false }
  if (a.fase === 'preparando') return { label: 'Preparando a troca…', fraction: 1, erro: false }
  if (a.fase === 'pronto') return { label: 'Versão nova baixada e conferida.', fraction: 1, erro: false }
  if (a.fase === 'reiniciando') return { label: 'Abrindo a versão nova…', fraction: 1, erro: false }
  return null
}

export function downloadUpdate() {
  const url = getState().versao?.baixarUrl
  if (url) openExternal(url)
}

/** "Atualizar": com transferências andando, pergunta antes (fechar o app pausa e elas continuam ao abrir de novo). */
export async function installUpdate() {
  const s = getState()
  let pausar = false
  if (activeCount(s.transfers) > 0) {
    const ok = await confirmDialog({
      title: 'Atualizar agora?',
      message: 'Há transferências em andamento. Atualizar agora vai pausá-las. Elas continuam de onde pararam quando o app abrir de novo.',
      confirmLabel: 'Atualizar mesmo assim',
      cancelLabel: 'Depois',
    })
    if (!ok) return null
    pausar = true
  }
  const res = await attempt(api.post('/api/versao/atualizar', pausar ? { pausar: true } : {}))
  if (res?.versao) setVersao(res.versao)
  return res?.versao ?? null
}

/** "Tentar de novo" depois de um erro no download automático (baixa de novo, sem trocar no fim). */
export async function retryUpdate() {
  const res = await attempt(api.post('/api/versao/baixar'))
  if (res?.versao) setVersao(res.versao)
  return res?.versao ?? null
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
