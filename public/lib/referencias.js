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

export function salvarLink({ url, colecaoId, nota, origem = 'colar', formatos = [] }) {
  storage.set('ref.colecao', colecaoId)
  return api.post('/api/referencias/salvar', { url, colecaoId, nota: nota || '', origem, ...(formatos.length ? { formatos } : {}) })
}

export function salvarImagem({ imagemUrl, paginaUrl, titulo, colecaoId, nota, formatos = [] }) {
  storage.set('ref.colecao', colecaoId)
  return api.post('/api/referencias/salvar-imagem', { imagemUrl, paginaUrl: paginaUrl || '', titulo: titulo || '', colecaoId, nota: nota || '', ...(formatos.length ? { formatos } : {}) })
}

// ───── formatos ("Baixar como…"; a tabela do motor fica em src/referencias/formatos.js) ─────

export const FORMATOS = {
  original: { id: 'original', tipo: 'ambos', titulo: 'Original', sub: 'Como foi salvo', curto: 'Original', icone: 'download' },
  mp4: { id: 'mp4', tipo: 'video', grupo: 'Vídeo', titulo: 'MP4', sub: 'H.264 + AAC, melhor disponível', curto: 'MP4', icone: 'film' },
  'mp4-1080': { id: 'mp4-1080', tipo: 'video', grupo: 'Vídeo', titulo: 'MP4 1080p', sub: 'H.264 + AAC', curto: 'MP4 1080p', icone: 'film' },
  'mp4-720': { id: 'mp4-720', tipo: 'video', grupo: 'Vídeo', titulo: 'MP4 720p', sub: 'Mais leve', curto: 'MP4 720p', icone: 'film' },
  'mp3-320': { id: 'mp3-320', tipo: 'video', grupo: 'Só áudio', titulo: 'MP3 320 kbps', sub: 'Abre em qualquer lugar', curto: 'MP3 320', icone: 'music' },
  wav: { id: 'wav', tipo: 'video', grupo: 'Só áudio', titulo: 'WAV', sub: 'Sem perda, para edição', curto: 'WAV', icone: 'music' },
  m4a: { id: 'm4a', tipo: 'video', grupo: 'Só áudio', titulo: 'M4A', sub: 'AAC, leve', curto: 'M4A', icone: 'music' },
  jpg: { id: 'jpg', tipo: 'foto', grupo: 'Foto', titulo: 'JPG', sub: 'Abre em qualquer lugar', curto: 'JPG', icone: 'photo' },
}

/** 'video' | 'foto' | null, pelo tipo do arquivo no Drive. */
export function tipoDoItem(it) {
  const m = String(it?.mimeType || '')
  if (m.startsWith('video/') || it?.video) return 'video'
  if (m.startsWith('image/')) return 'foto'
  return null
}

/** Formatos deste tipo de arquivo, na ordem do menu. */
export const formatosPara = (tipo) => Object.values(FORMATOS).filter((f) => f.tipo === 'ambos' || f.tipo === tipo)

/** Destinos do "Baixar como…": o mesmo "Para" da prévia (pasta do computador) e/ou a coleção no Drive. */
export const DESTINOS = [
  { value: 'computador', label: 'Computador' },
  { value: 'drive', label: 'Coleção' },
  { value: 'ambos', label: 'Os dois' },
]

// A última escolha fica lembrada (por tipo de arquivo, porque foto e vídeo têm formatos diferentes).
export const ultimoFormato = (tipo) => storage.get(`ref.formato.${tipo}`, tipo === 'foto' ? 'jpg' : 'mp3-320')
export const lembrarFormato = (tipo, id) => storage.set(`ref.formato.${tipo}`, id)
export const ultimoDestino = () => storage.get('ref.formato.destino', 'computador')
export const lembrarDestino = (d) => storage.set('ref.formato.destino', d)
/** "Também salvar como" na hora de salvar (lista; vazia = só o original). */
export const ultimosTambem = (tipo = 'video') => {
  const v = storage.get(`ref.tambem.${tipo}`, [])
  return Array.isArray(v) ? v.filter((id) => FORMATOS[id] && FORMATOS[id].tipo === tipo) : []
}
export const lembrarTambem = (tipo, lista) => storage.set(`ref.tambem.${tipo}`, lista)

/** Converte uma referência da coleção (o motor baixa o original do Drive, converte e manda para o destino). */
export const exportar = ({ colecaoId, fileId, formato, destino, destDir }) => api.post('/api/referencias/exportar', { colecaoId, fileId, formato, destino, ...(destDir ? { destDir } : {}) })

let conversorCache = null
/** O que este computador converte (ffmpeg, MP3): pergunta uma vez por abertura da tela. */
export function conversor() {
  conversorCache ??= api.get('/api/referencias/conversor').then(
    (r) => r.conversor,
    () => {
      conversorCache = null
      return null
    },
  )
  return conversorCache
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
  if (t.tipo === 'formato') return formatoTexto(t, p, pct)
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

/** Andamento de um "Baixar como…": original do Drive → convertendo → computador e/ou Drive. */
function formatoTexto(t, p, pct) {
  const nome = t.formatoNome || 'outro formato'
  switch (t.fase) {
    case 'na_fila':
      return `Na fila para ${nome}`
    case 'baixando':
      if (p?.fase === 'original') return `Baixando o original do Drive${pct}`
      if (p?.fase === 'convertendo') return `Convertendo para ${nome}${pct}`
      return 'Preparando a conversão'
    case 'enviando':
      if (p?.fase === 'pausado') return 'Envio pausado'
      if (p?.fase === 'aguardando') return 'Esperando para enviar'
      return `Enviando para ${t.colecao?.nome || 'o Drive'}${pct}`
    case 'concluindo':
      return 'Finalizando'
    case 'pronto':
      if (t.destino === 'computador') return `Salvo em ${pastaCurta(t.pasta)}`
      if (t.destino === 'ambos') return `Salvo em ${t.colecao?.nome || 'Drive'} e em ${pastaCurta(t.pasta)}`
      return `Salvo em ${t.colecao?.nome || 'Drive'}, ao lado do original`
    case 'cancelado':
      return 'Cancelado'
    case 'erro':
      return t.erro?.mensagem || 'Não deu para converter.'
    default:
      return ''
  }
}

const pastaCurta = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || 'sua pasta'

/** Fração geral (baixar = 0–70%, enviar = 70–100%) para uma barra só. */
export function fracaoGeral(t) {
  const f = t.progresso?.fracao
  if (t.tipo === 'formato') {
    // Original do Drive 0–30%, conversão 30–80% (ou até 100% se não sobe), envio 80–100%.
    const sobe = t.destino !== 'computador'
    const fim = sobe ? 0.8 : 1
    if (t.fase === 'pronto') return 1
    if (t.fase === 'baixando') {
      if (t.progresso?.fase === 'original') return f == null ? null : f * 0.3
      if (t.progresso?.fase === 'convertendo') return f == null ? null : 0.3 + f * (fim - 0.3)
      return null
    }
    if (t.fase === 'enviando') return 0.8 + (f || 0) * 0.2
    if (t.fase === 'concluindo') return 0.99
    return null
  }
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
