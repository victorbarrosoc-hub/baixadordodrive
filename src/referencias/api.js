// Cliente das rotas /api/referencias/* do site (contrato em docs/REFERENCIAS.md, escrito pela frente web).
// Usa a sessão do computador na conta SOBEDESCE (Bearer do dispositivo, via CloudAuth.request).
//
// Erros viram ReferenciasApiError com `codigo`:
//   'sem_sessao' (não entrou na conta / sessão encerrada), 'plano' (403: recurso fora do plano), 'nao_encontrada' (404),
//   'ocupado' (409: outro computador já pegou o item), 'entrada' (400), 'rede' (sem internet / site fora), 'servidor'.
// Leituras e PATCH/DELETE repetem sozinhos em falha de rede/5xx/429 (são idempotentes). Criar não repete (duplicaria).
import { HttpError } from '../net/http.js'
import { classifyError } from '../google/errors.js'
import { backoffDelay, isAbortError, sleep } from '../util/backoff.js'

export class ReferenciasApiError extends Error {
  constructor(codigo, message, { status = null, transitorio = false } = {}) {
    super(message)
    this.name = 'ReferenciasApiError'
    this.codigo = codigo
    this.status = status
    this.transitorio = transitorio
  }
}

const MSG = {
  sem_sessao: 'Entre na conta SOBEDESCE para usar as Referências.',
  plano: 'As Referências fazem parte do plano Produtora.',
  nao_encontrada: 'Não achei isso na sua conta. Pode ter sido apagado.',
  ocupado: 'Outro computador já está baixando este link.',
  entrada: 'O site não aceitou o pedido.',
  rede: 'Sem conexão com a conta SOBEDESCE. Confira a internet.',
  servidor: 'A conta SOBEDESCE não respondeu agora. Tente de novo em instantes.',
}

const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null)
const idStr = v => (v == null || v === '' ? null : String(v))

/** Coleção do site → formato do app (`contaId` = id da conta no motor: 'nuvem:<contaGoogleId>'). */
export function normalizarColecao(c) {
  if (!c || typeof c !== 'object' || idStr(c.id) == null) return null
  const contaGoogleId = idStr(c.contaGoogleId ?? c.conta_google_id ?? c.conta)
  const link = str(c.link) || str(c.linkIa) || str(c.linkPublico) || null
  return {
    id: idStr(c.id),
    nome: str(c.nome) || 'Sem nome',
    contaGoogleId,
    contaId: contaGoogleId ? `nuvem:${contaGoogleId}` : null,
    driveFolderId: str(c.driveFolderId ?? c.drive_folder_id ?? c.pastaId),
    link: link && /^https?:\/\//i.test(link) ? link : null,
    naFila: Number.isFinite(Number(c.naFila)) ? Number(c.naFila) : 0,
    criadoEm: c.criadoEm ?? c.criado_em ?? null,
  }
}

const STATUS_FILA = new Set(['pendente', 'baixando', 'pronto', 'erro'])

/** Item da fila do site → formato do app. */
export function normalizarItem(i) {
  if (!i || typeof i !== 'object' || idStr(i.id) == null) return null
  const url = str(i.url)
  if (!url) return null
  const colecao = normalizarColecao(i.colecao) || (i.colecaoId != null ? normalizarColecao({ id: i.colecaoId, nome: i.colecaoNome }) : null)
  return {
    id: idStr(i.id),
    url,
    nota: str(i.nota),
    status: STATUS_FILA.has(i.status) ? i.status : 'pendente',
    erro: str(i.erro),
    driveFileId: str(i.driveFileId),
    plataforma: str(i.plataforma),
    colecao,
    // "Também salvar como" escolhido no celular (ids de src/referencias/formatos.js; o serviço confere de novo).
    formatos: Array.isArray(i.formatos) ? i.formatos.filter(f => typeof f === 'string').slice(0, 8) : [],
    criadoEm: i.criadoEm ?? null,
  }
}

function paraErro(err) {
  if (err instanceof ReferenciasApiError || isAbortError(err)) return err
  if (err?.name === 'SobeDesceError' && err.kind === 'reauth') return new ReferenciasApiError('sem_sessao', err.message || MSG.sem_sessao, { status: 401 })
  if (err instanceof HttpError) {
    const b = err.body && typeof err.body === 'object' ? err.body : {}
    const mensagem = str(b.mensagem)
    const s = err.status
    if (s === 401) return new ReferenciasApiError('sem_sessao', mensagem || MSG.sem_sessao, { status: s })
    if (s === 403 && (b.motivo === 'plano' || b.erro === 'plano')) return new ReferenciasApiError('plano', mensagem || MSG.plano, { status: s })
    if (s === 404) return new ReferenciasApiError('nao_encontrada', mensagem || MSG.nao_encontrada, { status: s })
    if (s === 409) return new ReferenciasApiError(str(b.erro) || 'ocupado', mensagem || MSG.ocupado, { status: s })
    if (s === 400 || s === 422) return new ReferenciasApiError('entrada', mensagem || MSG.entrada, { status: s })
    if (s === 429 || s >= 500 || s === 408) return new ReferenciasApiError('servidor', mensagem && s < 500 ? mensagem : MSG.servidor, { status: s, transitorio: true })
    return new ReferenciasApiError(str(b.erro) || 'servidor', mensagem || MSG.servidor, { status: s })
  }
  if (err?.name === 'TimeoutError' || classifyError(err).kind === 'retry') return new ReferenciasApiError('rede', MSG.rede, { transitorio: true })
  return new ReferenciasApiError('servidor', MSG.servidor)
}

export class ReferenciasApi {
  /**
   * @param {{ cloud: { request(method, path, opts): Promise<{ status, data }> }, tentativas?: number, retryBaseMs?: number }} o
   */
  constructor({ cloud, tentativas = 3, retryBaseMs = 600 } = {}) {
    this.cloud = cloud
    this.tentativas = tentativas
    this.retryBaseMs = retryBaseMs
  }

  async #call(method, path, { body, expect = [200, 201], repetir = method !== 'POST' } = {}) {
    if (!this.cloud?.request) throw new ReferenciasApiError('sem_sessao', MSG.sem_sessao)
    let ultimo
    const max = repetir ? this.tentativas : 1
    for (let i = 0; i < max; i++) {
      if (i > 0) await sleep(backoffDelay(i - 1, { base: this.retryBaseMs, max: 5000 }))
      try {
        const res = await this.cloud.request(method, path, { body, expect: [...expect, 204] })
        const data = res?.data && typeof res.data === 'object' ? res.data : {}
        if (data.ok === false) throw new HttpError(res.status >= 400 ? res.status : 400, { body: data, method, url: path })
        return data
      } catch (err) {
        ultimo = paraErro(err)
        if (!ultimo.transitorio) throw ultimo
      }
    }
    throw ultimo
  }

  /** @returns {Promise<{ raiz: object|null, colecoes: object[] }>} */
  async listarColecoes() {
    const d = await this.#call('GET', '/api/referencias/colecoes')
    const lista = Array.isArray(d.colecoes) ? d.colecoes.map(normalizarColecao).filter(Boolean) : []
    const raizes = Array.isArray(d.raizes) ? d.raizes.filter(r => r && typeof r === 'object') : []
    return { raiz: d.raiz && typeof d.raiz === 'object' ? d.raiz : null, raizes, colecoes: lista }
  }

  async criarColecao({ nome, contaGoogleId } = {}) {
    const body = { nome }
    if (contaGoogleId) body.contaGoogleId = String(contaGoogleId).replace(/^nuvem:/, '')
    const d = await this.#call('POST', '/api/referencias/colecoes', { body })
    const c = normalizarColecao(d.colecao || d)
    if (!c) throw new ReferenciasApiError('servidor', 'O site respondeu de um jeito inesperado.')
    return c
  }

  /**
   * Renomear e "Link pra IA". `link`: true/'ligar', false/'desligar' ou 'trocar' (link novo; o antigo para de abrir).
   */
  async editarColecao(id, { nome, link } = {}) {
    const body = {}
    if (nome !== undefined) body.nome = nome
    if (link !== undefined) body.link = link === true ? 'ligar' : link === false ? 'desligar' : link
    const d = await this.#call('PATCH', `/api/referencias/colecoes/${encodeURIComponent(id)}`, { body })
    return normalizarColecao(d.colecao || d)
  }

  async apagarColecao(id, { apagarNoDrive = false } = {}) {
    await this.#call('DELETE', `/api/referencias/colecoes/${encodeURIComponent(id)}${apagarNoDrive ? '?apagarNoDrive=1' : ''}`)
    return true
  }

  /** Sem `status`: pendente, baixando e erro. `colecaoId`: só os desta coleção. */
  async listarFila({ status, colecaoId } = {}) {
    const q = new URLSearchParams()
    if (status) q.set('status', status)
    if (colecaoId) q.set('colecao', colecaoId)
    const d = await this.#call('GET', `/api/referencias/fila${q.size ? `?${q}` : ''}`)
    const lista = Array.isArray(d.itens) ? d.itens : Array.isArray(d.fila) ? d.fila : Array.isArray(d.items) ? d.items : []
    return lista.map(normalizarItem).filter(Boolean)
  }

  /** Pega o item para este computador. null = outro computador pegou antes (409) ou o item sumiu (404). */
  async pegar(id) {
    try {
      const d = await this.#call('POST', `/api/referencias/fila/${encodeURIComponent(id)}/pegar`, { body: {}, repetir: true })
      return normalizarItem(d.item || d) || { id: String(id) }
    } catch (err) {
      if (err.codigo === 'ocupado' || err.codigo === 'nao_encontrada') return null
      throw err
    }
  }

  /** status: 'pronto' (com driveFileId), 'erro' (com erro curto) ou 'pendente' (devolve para a fila). */
  async atualizarItem(id, { status, driveFileId, erro } = {}) {
    const body = { status }
    if (driveFileId) body.driveFileId = driveFileId
    if (erro) body.erro = String(erro).slice(0, 300)
    const d = await this.#call('PATCH', `/api/referencias/fila/${encodeURIComponent(id)}`, { body })
    return normalizarItem(d.item || d)
  }

  /** Tira o link da fila (cancelar). */
  async cancelarItem(id) {
    await this.#call('DELETE', `/api/referencias/fila/${encodeURIComponent(id)}`)
    return true
  }

  async adicionarNaFila({ url, colecaoId, nota } = {}) {
    const body = { url, colecaoId }
    if (nota) body.nota = nota
    const d = await this.#call('POST', '/api/referencias/fila', { body })
    return normalizarItem(d.item || d)
  }
}
