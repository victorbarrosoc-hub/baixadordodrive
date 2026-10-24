// "Gerar proxy" pelo celular (docs/CONTAS.md §11): o site guarda o pedido e o app SOBEDESCE do computador, com a
// mesma conta, pega, gera o proxy 720p e a tira de quadros e sobe em Proxy/, ao lado do original.
import { getState } from './state.js'
import { isPrevia, kindOf } from './browse.js'

export const API = '/api/proxies/pedidos'
export const MAX = 200

/** Vale pedir proxy deste arquivo? (vídeo, inclusive RAW de câmera; não a própria cópia leve). */
export const podeProxy = (f) => kindOf(f) === 'video' && !isPrevia(f)

async function api(path, { method = 'GET', body, signal } = {}) {
  let res
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json', 'x-sobedesce-app': 'celular', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })
  } catch (err) {
    if (signal?.aborted) throw err
    throw Object.assign(new Error('Sem conexão. Confira a internet.'), { status: 0 })
  }
  let json = null
  try {
    json = await res.json()
  } catch {
    // corpo vazio
  }
  if (!res.ok || json?.ok === false) {
    throw Object.assign(new Error(json?.mensagem || 'O SOBEDESCE não respondeu. Tente de novo.'), { status: res.status, code: json?.erro || null })
  }
  return json || {}
}

/** Pede para o computador gerar. Devolve os pedidos (novos e os que já esperavam) e quantos são novos. */
export async function pedirProxies(itens) {
  const conta = getState().drive?.id
  if (!conta) throw new Error('Escolha um Drive primeiro.')
  const body = { contaGoogleId: conta, itens: itens.slice(0, MAX).map((f) => ({ fileId: f.id, nome: f.name, tamanho: f.size != null ? Number(f.size) : undefined })) }
  const r = await api(API, { method: 'POST', body })
  return { pedidos: r.pedidos || [], novos: Number(r.novos) || 0 }
}

/** O pedido mais recente de cada arquivo: Map(fileId → pedido). */
export async function situacao(fileIds, signal) {
  const r = await api(`${API}?fileIds=${fileIds.slice(0, MAX).map(encodeURIComponent).join(',')}`, { signal })
  const out = new Map()
  for (const p of r.pedidos || []) if (!out.has(p.fileId)) out.set(p.fileId, p) // vêm do mais novo para o mais velho
  return out
}

export async function tentarDeNovo(id) {
  return (await api(`${API}/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: 'pendente' } })).pedido
}

export async function cancelar(id) {
  await api(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ───── Frames pedido ao computador (docs/FRAMES.md §Celular): mesma fila, tipo "frames" ─────

/** Pede ao computador os Frames completos (frames, takes, TIFF/ProRes) de um vídeo do Drive. */
export async function pedirFrames(file, ajustes) {
  const conta = getState().drive?.id
  if (!conta) throw new Error('Escolha um Drive primeiro.')
  const body = { contaGoogleId: conta, tipo: 'frames', ajustes, itens: [{ fileId: file.id, nome: file.name, tamanho: file.size != null ? Number(file.size) : undefined }] }
  const r = await api(API, { method: 'POST', body })
  return { pedido: (r.pedidos || [])[0] || null, novo: Number(r.novos) > 0 }
}

/** Os pedidos de Frames deste vídeo, do mais novo para o mais velho. */
export async function framesPedidos(fileId, signal) {
  const r = await api(`${API}?tipo=frames&fileIds=${encodeURIComponent(fileId)}`, { signal })
  return r.pedidos || []
}


// ───── "Baixar como…" de uma referência (docs/REFERENCIAS.md §7): mesma fila, tipo "formato" ─────

/** Pede ao computador o arquivo em outro formato (MP3 320, WAV, MP4 720p…), salvo ao lado do original no Drive. */
export async function pedirFormato(file, formato) {
  const conta = getState().drive?.id
  if (!conta) throw new Error('Escolha um Drive primeiro.')
  const body = { contaGoogleId: conta, tipo: 'formato', ajustes: { formato }, itens: [{ fileId: file.id, nome: file.name, tamanho: file.size != null ? Number(file.size) : undefined }] }
  const r = await api(API, { method: 'POST', body })
  return { pedido: (r.pedidos || [])[0] || null, novo: Number(r.novos) > 0 }
}

/** Os pedidos de formato deste arquivo, do mais novo para o mais velho. */
export async function formatoPedidos(fileId, signal) {
  const r = await api(`${API}?tipo=formato&fileIds=${encodeURIComponent(fileId)}`, { signal })
  return r.pedidos || []
}
