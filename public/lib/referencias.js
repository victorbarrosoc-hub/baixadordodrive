// Referências na interface: chamadas à API local (/api/referencias/*), lista de coleções compartilhada entre as telas
// (a tela de Referências, a janela "Salvar referência" e o painel do navegador) e textos de estado dos downloads.
import { useEffect, useRef, useState } from '/vendor/preact-htm.js'
import { api, enc, withQuery } from './api.js'
import { storage } from './ui.js'

// ───── coleções (uma lista só para o app inteiro) ─────

let col = { colecoes: null, loading: false, error: null, status: 0, at: 0 }
const subs = new Set()
let inflight = null

function setCol(patch) {
  col = { ...col, ...patch }
  for (const fn of subs) fn(col)
}

/** Recarrega a lista de coleções (forcar = pergunta ao site mesmo com cache no motor). */
export function carregarColecoes({ forcar = false } = {}) {
  if (inflight && !forcar) return inflight
  setCol({ loading: true, error: null })
  inflight = api
    .get(withQuery('/api/referencias/colecoes', { forcar: forcar ? '1' : '' }))
    .then((res) => {
      setCol({ colecoes: res.colecoes || [], loading: false, error: null, status: 200, at: Date.now() })
      return res.colecoes || []
    })
    .catch((err) => {
      setCol({ loading: false, error: err.message, status: err.status || 0 })
      return null
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function useColecoes({ ativo = true } = {}) {
  const [state, setState] = useState(col)
  useEffect(() => {
    subs.add(setState)
    if (ativo && !col.colecoes && !col.loading) carregarColecoes()
    return () => subs.delete(setState)
  }, [ativo])
  return { ...state, reload: () => carregarColecoes({ forcar: true }) }
}

export function colecaoPorId(id) {
  return (col.colecoes || []).find((c) => c.id === id) || null
}

// ───── itens de uma coleção ─────

const itensCache = new Map() // colecaoId -> { colecao, accountId, itens, pendentes }

export function esquecerItens(colecaoId) {
  if (colecaoId) itensCache.delete(colecaoId)
  else itensCache.clear()
}

/**
 * Arquivos da coleção (com origem) + links do celular pendentes. `versao` muda quando um salvamento termina.
 * `limite`: só os primeiros (capas da grade de coleções), sem a fila.
 */
export function useItens(colecaoId, { versao = 0, capa = false } = {}) {
  const [state, setState] = useState(() => ({ data: itensCache.get(colecaoId) || null, loading: !itensCache.get(colecaoId), error: null }))
  const seq = useRef(0)
  const load = async (forcar = false) => {
    if (!colecaoId) return
    const my = ++seq.current
    const hit = itensCache.get(colecaoId)
    setState({ data: hit || null, loading: !hit || forcar, error: null })
    try {
      const res = await api.get(withQuery(`/api/referencias/colecoes/${enc(colecaoId)}/itens`, { forcar: forcar ? '1' : '', fila: capa ? '0' : '' }))
      const data = { colecao: res.colecao, accountId: res.accountId, itens: res.itens || [], pendentes: capa ? hit?.pendentes || [] : res.pendentes || [] }
      itensCache.set(colecaoId, data)
      if (my === seq.current) setState({ data, loading: false, error: null })
    } catch (err) {
      if (my === seq.current) setState({ data: hit || null, loading: false, error: err.message })
    }
  }
  useEffect(() => {
    load(versao > 0)
  }, [colecaoId, versao])
  return { ...state, reload: () => load(true) }
}

// ───── ações ─────

export async function criarColecao({ nome, contaId }) {
  const res = await api.post('/api/referencias/colecoes', { nome, ...(contaId ? { contaId } : {}) })
  await carregarColecoes({ forcar: true })
  return res.colecao
}

export async function editarColecao(id, patch) {
  const res = await api.patch(`/api/referencias/colecoes/${enc(id)}`, patch)
  if (res.colecao) setCol({ colecoes: (col.colecoes || []).map((c) => (c.id === id ? { ...c, ...res.colecao } : c)) })
  return res.colecao
}

export async function apagarColecao(id, { apagarNoDrive = false } = {}) {
  await api.del(`/api/referencias/colecoes/${enc(id)}`, { apagarNoDrive })
  setCol({ colecoes: (col.colecoes || []).filter((c) => c.id !== id) })
  esquecerItens(id)
}

export function salvarLink({ url, colecaoId, nota, origem = 'colar' }) {
  storage.set('ref.colecao', colecaoId)
  return api.post('/api/referencias/salvar', { url, colecaoId, nota: nota || '', origem })
}

export function salvarImagem({ imagemUrl, paginaUrl, titulo, colecaoId, nota }) {
  storage.set('ref.colecao', colecaoId)
  return api.post('/api/referencias/salvar-imagem', { imagemUrl, paginaUrl: paginaUrl || '', titulo: titulo || '', colecaoId, nota: nota || '' })
}

export const detectarLink = (url) => api.get(withQuery('/api/referencias/detectar', { url }))
export const cancelarTrabalho = (id) => api.post(`/api/referencias/trabalhos/${enc(id)}/cancelar`, {})
export const tentarTrabalho = (id) => api.post(`/api/referencias/trabalhos/${enc(id)}/tentar`, {})
export const removerTrabalho = (id) => api.del(`/api/referencias/trabalhos/${enc(id)}`, {})
export const tentarItemFila = (id) => api.post(`/api/referencias/fila/${enc(id)}/tentar`, {})
export const cancelarItemFila = (id) => api.del(`/api/referencias/fila/${enc(id)}`, {})
export const consultarFila = () => api.post('/api/referencias/fila/consultar', {}).catch(() => null)

export const ultimaColecao = () => storage.get('ref.colecao', null)

// ───── textos ─────

export const ATIVAS = new Set(['na_fila', 'baixando', 'enviando', 'concluindo'])

/** "Baixando 45%", "Enviando para o Drive 80%", "Salvo", "Vídeo privado ou removido." */
export function faseTexto(t) {
  const p = t.progresso
  const pct = p?.fracao != null ? ` ${Math.round(p.fracao * 100)}%` : ''
  switch (t.fase) {
    case 'na_fila':
      return 'Na fila'
    case 'baixando':
      if (p?.fase === 'juntando') return 'Juntando vídeo e áudio'
      if (p?.fase === 'convertendo') return `Convertendo para tocar no celular${pct}`
      if (p?.fase === 'preparando' || !p) return 'Abrindo o link'
      return `Baixando${pct}`
    case 'enviando':
      if (p?.fase === 'pausado') return 'Envio pausado'
      if (p?.fase === 'aguardando') return 'Esperando para enviar'
      return `Enviando para o Drive${pct}`
    case 'concluindo':
      return 'Finalizando'
    case 'pronto':
      return `Salvo em ${t.colecao?.nome || 'sua coleção'}`
    case 'cancelado':
      return 'Cancelado'
    case 'erro':
      return t.erro?.mensagem || 'Não deu para salvar.'
    default:
      return ''
  }
}

/** Fração geral (baixar = 0–70%, enviar = 70–100%) para uma barra só. */
export function fracaoGeral(t) {
  const f = t.progresso?.fracao
  if (t.fase === 'pronto') return 1
  if (t.fase === 'baixando') return f == null ? null : f * 0.7
  if (t.fase === 'enviando') return 0.7 + (f || 0) * 0.3
  if (t.fase === 'concluindo') return 0.99
  return null
}

/** Endereço curto para mostrar ("instagram.com/reel/DQx1…"). */
export function urlCurta(url, max = 48) {
  try {
    const u = new URL(url)
    const s = `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}${u.search}`
    return s.length > max ? `${s.slice(0, max - 1)}…` : s
  } catch {
    return String(url || '').slice(0, max)
  }
}

export const PLATAFORMAS = ['Instagram', 'YouTube', 'TikTok', 'Pinterest', 'Vimeo']
export const ATALHOS = [
  { nome: 'Instagram', url: 'https://www.instagram.com/' },
  { nome: 'YouTube', url: 'https://www.youtube.com/' },
  { nome: 'TikTok', url: 'https://www.tiktok.com/' },
  { nome: 'Pinterest', url: 'https://br.pinterest.com/' },
  { nome: 'Vimeo', url: 'https://vimeo.com/' },
]
