// Referências no motor: salvar vídeos e fotos de referência nas coleções do Drive (SOBEDESCE Referências/<Coleção>/).
//
//   salvar(link) ──▶ yt-dlp (até 2 por vez, pasta de trabalho só dele) ──▶ arquivo pronto em <dados>/referencias/envios/
//                ──▶ envio normal da fila (TransferManager: retomável, aparece em Transferências) com descrição e
//                    appProperties já na criação ──▶ miniatura (contentHints) ──▶ "Salvo em <Coleção>"
//   fila do celular: a cada 60 s (e quando o app volta ao foco) pega os links pendentes da conta, um computador por item
//                    (POST …/pegar; 409 = outro pegou), baixa e marca pronto/erro no site.
//
// Os trabalhos ficam em <dados>/referencias.json: fechar o app no meio não perde nada (o download recomeça; o envio
// continua de onde parou, como qualquer envio). Temporários são apagados sempre (deu certo, deu erro, cancelou).
import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { request } from 'undici'
import { dispatcherFor } from '../net/http.js'
import { newId } from '../util/ids.js'
import { isAbortError } from '../util/backoff.js'
import { JsonFile } from '../util/store.js'
import { BROWSE_FIELDS, escapeQueryValue, toDriveItem } from '../google/drive.js'
import { ReferenciasApi, ReferenciasApiError } from './api.js'
import { detectar, dominiosDeCookies, limparUrl, nomeDaPlataforma } from './plataformas.js'
import { appProperties, descricao, lerReferencia, nomeDoArquivo } from './metadados.js'
import { apagarCookies, gravarCookies } from './cookies.js'
import { baixarVideo, YtdlpError } from './ytdlp.js'
import { ffmpegCandidates, jsRuntimePadrao, primeiro } from './binarios.js'
import { YtdlpUpdater } from './ytdlp-update.js'
import { CELULAR_OK, ConsertoCelular, MARCA_CELULAR, paraCelular } from './celular.js'
import { detectarMotor } from '../media/previa.js'
import { UploadTask } from '../engine/upload.js'

const POLL_MS = 30_000 // fila do celular: o contrato pede ~30 s com o app aberto
const VIDA_MS = 5 * 60_000 // item pego da fila: "ainda estou baixando" (sem notícia por 30 min, o site libera o item)
const PLANO_PAUSA_MS = 60 * 60_000 // recurso fora do plano: pergunta de novo só depois de 1 h
const CONCORRENCIA = 2
const MANTER_FEITOS = 80 // trabalhos terminados guardados para a tela
const COLECOES_TTL_MS = 60_000
const ITENS_TTL_MS = 60_000
const IMAGEM_MAX = 40 * 1024 * 1024
const terminando = new WeakSet() // trabalhos já no #terminar (ele espera apagar os temporários antes de gravar o fim)
const MINIATURA_MAX = 2 * 1024 * 1024
const ATIVAS = new Set(['na_fila', 'baixando', 'enviando', 'concluindo'])
const FINAIS = new Set(['pronto', 'erro', 'cancelado'])
const EVENTO_MS = 250

const MSG = {
  semConta: 'Entre na conta SOBEDESCE para usar as Referências.',
  semColecao: 'Esta coleção não existe mais. Escolha outra.',
  semDrive: 'O Drive desta coleção não está conectado neste computador. Confira em sobedesce.com/conta.',
  semYtdlp: 'O baixador de vídeos (yt-dlp) não está neste computador. Atualize o SOBEDESCE.',
  linkInvalido: 'Esse link não parece um endereço da web.',
  cancelado: 'Cancelado no computador.',
  envioFalhou: 'Não consegui enviar para o Drive.',
  imagem: 'Não consegui baixar a imagem.',
}

/** Cabeçalho Cookie para `url` a partir de cookies do Electron (domínio, caminho e "secure" conferidos). */
export function cabecalhoCookie(cookies, url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return ''
  }
  const host = u.hostname.toLowerCase()
  const out = []
  for (const c of cookies || []) {
    if (!c?.name || /[;\u0000-\u001f\u007f]/.test(`${c.name}${c.value}`)) continue
    const d = String(c.domain || '').toLowerCase().replace(/^\./, '')
    if (!d) continue
    const ok = c.hostOnly ? host === d : host === d || host.endsWith(`.${d}`)
    if (!ok || (c.secure && u.protocol !== 'https:')) continue
    const p = c.path || '/'
    if (!u.pathname.startsWith(p)) continue
    out.push(`${c.name}=${c.value ?? ''}`)
  }
  return out.join('; ')
}

const EXT_IMAGEM = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/avif': 'avif' }

/**
 * Baixa uma imagem (até 40 MB) com os cookies do navegador de referências e o Referer da página.
 * @returns {Promise<{ buffer: Buffer, mime: string, ext: string }>}
 */
export async function baixarImagem(url, { cookie = '', referer = null, signal, maxBytes = IMAGEM_MAX } = {}) {
  let alvo = new URL(url)
  if (alvo.protocol === 'data:') {
    const m = /^data:(image\/[\w.+-]+);base64,(.*)$/i.exec(url)
    if (!m) throw new Error('imagem embutida inválida')
    const buffer = Buffer.from(m[2], 'base64')
    if (buffer.length > maxBytes) throw new Error('imagem grande demais')
    const mime = m[1].toLowerCase()
    return { buffer, mime, ext: EXT_IMAGEM[mime] || 'jpg' }
  }
  for (let hop = 0; hop < 5; hop++) {
    if (alvo.protocol !== 'https:' && alvo.protocol !== 'http:') throw new Error('endereço de imagem inválido')
    const headers = { accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' }
    if (cookie && hop === 0) headers.cookie = cookie
    if (referer) headers.referer = referer
    const res = await request(alvo, { method: 'GET', headers, signal: signal ?? AbortSignal.timeout(60_000), dispatcher: dispatcherFor(alvo) })
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.body.destroy()
      alvo = new URL(res.headers.location, alvo)
      continue
    }
    if (res.statusCode !== 200) {
      res.body.destroy()
      throw new Error(`o site respondeu ${res.statusCode}`)
    }
    const mime = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (!mime.startsWith('image/')) {
      res.body.destroy()
      throw new Error('o endereço não é de uma imagem')
    }
    const chunks = []
    let size = 0
    for await (const c of res.body) {
      size += c.length
      if (size > maxBytes) {
        res.body.destroy()
        throw new Error('imagem grande demais')
      }
      chunks.push(c)
    }
    return { buffer: Buffer.concat(chunks), mime, ext: EXT_IMAGEM[mime] || 'jpg' }
  }
  throw new Error('redirecionamentos demais')
}

/** Trabalho público (o que a interface vê). */
function publico(j) {
  return {
    id: j.id,
    tipo: j.tipo,
    url: j.url,
    plataforma: j.plataforma,
    plataformaNome: nomeDaPlataforma(j.plataforma),
    colecao: j.colecao ? { id: j.colecao.id, nome: j.colecao.nome } : null,
    nota: j.nota || null,
    fase: j.fase,
    progresso: j.progresso || null,
    erro: j.erro || null,
    nome: j.nome || null,
    transferId: j.transferId || null,
    driveFileId: j.driveFileId || null,
    filaId: j.filaId || null,
    origem: j.origem,
    criadoEm: j.criadoEm,
    atualizadoEm: j.atualizadoEm,
  }
}

export class ReferenciasService extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.paths dataPaths()
   * @param {object} o.settings Settings
   * @param {object} o.auth AuthManager (contas 'nuvem:<id>')
   * @param {object} o.manager TransferManager (envios e driveFor)
   * Peças trocáveis (testes): cloud, api, updater, baixar (baixarVideo), baixarImagem, ffmpeg (() => caminho|null),
   * jsRuntime, cookies (async (dominios) => Cookie[]), pollMs, concorrencia, log, motor (async () => conversor de vídeo),
   * converter (paraCelular), conserto (false desliga a passada das antigas; src/referencias/celular.js), criarUpload.
   */
  constructor({ paths, settings, auth, manager, cloud = auth?.cloud ?? null, api, updater, baixar = baixarVideo, baixarImg = baixarImagem, ffmpeg, jsRuntime, cookies = null, pollMs = POLL_MS, vidaMs = VIDA_MS, concorrencia = CONCORRENCIA, log, autoStart = true, motor, converter = paraCelular, conserto = true, criarUpload = (rec, ctx) => new UploadTask(rec, ctx) } = {}) {
    super()
    this.paths = paths
    this.settings = settings
    this.auth = auth
    this.manager = manager
    this.cloud = cloud
    this.api = api || new ReferenciasApi({ cloud })
    this.dir = path.join(paths.root, 'referencias')
    this.tmpDir = path.join(this.dir, 'tmp')
    this.enviosDir = path.join(this.dir, 'envios')
    this.updater = updater === undefined ? new YtdlpUpdater({ dir: path.join(paths.root, 'yt-dlp'), log: (...a) => this.log(...a) }) : updater
    this.baixar = baixar
    this.baixarImg = baixarImg
    this.ffmpeg = ffmpeg || (() => primeiro(ffmpegCandidates())?.path || null)
    // JavaScript dos desafios do YouTube: o Node fora do Electron, o QuickJS que vem no app de desktop (binarios.js).
    this.jsRuntime = jsRuntime === undefined ? jsRuntimePadrao() : jsRuntime
    this.cookieProvider = cookies
    this.pollMs = pollMs
    this.vidaMs = vidaMs
    this.concorrencia = concorrencia
    this.log = log || ((...a) => console.warn('[referencias]', ...a))
    this.autoStart = autoStart
    // Vídeo que o iPhone não toca (VP9/AV1 do Instagram) vira H.264 antes de subir; as antigas, numa passada só.
    this.motor = motor || (() => this.manager?.previas?.motor?.() ?? detectarMotor())
    this.converter = converter
    this.criarUpload = criarUpload
    this.conserto = conserto
      ? new ConsertoCelular({
          service: this,
          settings,
          manager,
          motor: () => this.motor(),
          converter,
          substituir: (drive, item, localPath, signal) => this.#substituir(drive, item, localPath, signal),
          marcar: (drive, fileId, signal) => this.#marcarCelular(drive, fileId, signal),
          log: (...a) => this.log(...a),
        })
      : null
    this.file = new JsonFile(path.join(paths.root, 'referencias.json'), { versao: 1, trabalhos: [] })
    this.file.serialize = () => ({ versao: 1, trabalhos: [...this.jobs.values()].map(j => ({ ...j, progresso: undefined })) })
    this.jobs = new Map() // id -> trabalho
    this.running = new Map() // id -> AbortController (download em andamento)
    this.vida = new Map() // jobId -> relógio do sinal de vida (itens da fila do celular)
    this.byTransfer = new Map() // transferId -> jobId
    this.colecoesCache = null // { at, raiz, colecoes }
    this.itensCache = new Map() // colecaoId -> { at, itens }
    this.motivo = null // null | 'sem_conta' | 'plano'
    this.aviso = null
    this.planoAte = 0
    this.pollTimer = null
    this.polling = null
    this.closed = false
    this.versoes = {} // colecaoId -> contador (a interface relê os itens quando muda)
    this.emitTimer = null
    this.onTransfers = list => this.#transfersChanged(list)
    this.onRemoved = ids => this.#transfersRemoved(ids)
    this.onCloud = () => this.#cloudChanged()
  }

  // ─────────── ciclo de vida ───────────

  async init() {
    const raw = await this.file.load().catch(() => null)
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    // Restos de downloads de uma abertura anterior (queda, app fechado no meio): sempre fora.
    await fs.rm(this.tmpDir, { recursive: true, force: true }).catch(() => {})
    for (const j of Array.isArray(raw?.trabalhos) ? raw.trabalhos : []) {
      if (!j || typeof j.id !== 'string' || !j.url) continue
      this.jobs.set(j.id, j)
      if (j.transferId) this.byTransfer.set(j.transferId, j.id)
    }
    this.manager?.on?.('transfers', this.onTransfers)
    this.manager?.on?.('removed', this.onRemoved)
    this.cloud?.on?.('status', this.onCloud)
    await this.#reconciliar()
    await this.#limparEnvios()
    this.#cloudChanged()
    this.#agendar()
  }

  close() {
    this.closed = true
    clearTimeout(this.pollTimer)
    clearTimeout(this.emitTimer)
    this.updater?.stop?.()
    this.conserto?.stop()
    for (const ac of this.running.values()) ac.abort()
    for (const t of this.vida.values()) clearInterval(t)
    this.vida.clear()
    this.manager?.off?.('transfers', this.onTransfers)
    this.manager?.off?.('removed', this.onRemoved)
    this.cloud?.off?.('status', this.onCloud)
    return this.file.flush().catch(() => {})
  }

  /** O app de desktop passa como pegar os cookies do navegador de referências (async (dominios) => Cookie[]). */
  setCookieProvider(fn) {
    this.cookieProvider = typeof fn === 'function' ? fn : null
    this.#emit()
  }

  get ativo() {
    return Boolean(this.cloud?.signedIn) && this.motivo !== 'plano'
  }

  #cloudChanged() {
    const logado = Boolean(this.cloud?.signedIn)
    if (!logado) this.motivo = 'sem_conta'
    else if (this.motivo === 'sem_conta') this.motivo = null
    if (!logado) this.colecoesCache = null
    if (this.ativo && this.autoStart) {
      this.updater?.start?.()
      if (!this.pollTimer && !this.polling) this.#planejarConsulta(2000)
      if (logado) this.conserto?.agendar()
    }
    this.#emit()
  }

  status() {
    const jobs = [...this.jobs.values()].sort((a, b) => b.criadoEm - a.criadoEm).map(publico)
    return {
      ativo: this.ativo,
      motivo: this.motivo,
      aviso: this.aviso,
      navegador: Boolean(this.cookieProvider),
      trabalhos: jobs,
      versoes: { ...this.versoes },
      ytdlp: this.updater?.status?.() ?? null,
    }
  }

  #emit() {
    if (this.emitTimer || this.closed) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emit('status', this.status())
    }, EVENTO_MS)
    this.emitTimer.unref?.()
  }

  #touch(j, patch = {}) {
    Object.assign(j, patch, { atualizadoEm: Date.now() })
    this.file.saveSoon?.()
    this.#emit()
  }

  #bump(colecaoId) {
    if (!colecaoId) return
    this.versoes[colecaoId] = (this.versoes[colecaoId] || 0) + 1
    this.itensCache.delete(colecaoId)
  }

  #toast(kind, message) {
    this.emit('toast', { kind, message })
  }

  // ─────────── conta e coleções ───────────

  #semConta() {
    if (!this.cloud?.signedIn) throw new ReferenciasApiError('sem_sessao', MSG.semConta, { status: 401 })
  }

  #apiFalhou(err) {
    if (err?.codigo === 'plano') {
      this.motivo = 'plano'
      this.planoAte = Date.now() + PLANO_PAUSA_MS
      this.#emit()
    }
    throw err
  }

  async listarColecoes({ forcar = false } = {}) {
    this.#semConta()
    const c = this.colecoesCache
    if (!forcar && c && Date.now() - c.at < COLECOES_TTL_MS) return { raiz: c.raiz, colecoes: c.colecoes }
    let res
    try {
      res = await this.api.listarColecoes()
    } catch (err) {
      this.#apiFalhou(err)
    }
    if (this.motivo === 'plano') {
      this.motivo = null
      this.#emit()
    }
    this.colecoesCache = { at: Date.now(), ...res }
    return res
  }

  async #colecao(id, { forcar = false } = {}) {
    let { colecoes } = await this.listarColecoes({ forcar })
    let c = colecoes.find(x => x.id === id)
    if (!c && !forcar) {
      colecoes = (await this.listarColecoes({ forcar: true })).colecoes
      c = colecoes.find(x => x.id === id)
    }
    if (!c) throw new ReferenciasApiError('nao_encontrada', MSG.semColecao, { status: 404 })
    return c
  }

  async criarColecao({ nome, contaId } = {}) {
    this.#semConta()
    let conta = typeof contaId === 'string' && contaId.startsWith('nuvem:') ? contaId : null
    if (!conta) conta = this.#contaPadrao()
    let c
    try {
      c = await this.api.criarColecao({ nome, contaGoogleId: conta })
    } catch (err) {
      this.#apiFalhou(err)
    }
    this.colecoesCache = null
    return c
  }

  /** Conta padrão para coleções novas: a do Drive da coleção mais recente, senão o primeiro Drive da conta. */
  #contaPadrao() {
    const cols = this.colecoesCache?.colecoes || []
    if (cols[0]?.contaId) return cols[0].contaId
    return (this.auth?.listAccounts?.() || []).find(a => a.source === 'nuvem' && a.status === 'ok')?.id || null
  }

  async editarColecao(id, patch) {
    this.#semConta()
    let c
    try {
      c = await this.api.editarColecao(id, patch)
    } catch (err) {
      this.#apiFalhou(err)
    }
    this.colecoesCache = null
    return c
  }

  async apagarColecao(id, { apagarNoDrive = false } = {}) {
    this.#semConta()
    try {
      await this.api.apagarColecao(id, { apagarNoDrive })
    } catch (err) {
      this.#apiFalhou(err)
    }
    this.colecoesCache = null
    this.itensCache.delete(id)
    return true
  }

  #contaDaColecao(c) {
    const acc = (this.auth?.listAccounts?.() || []).find(a => a.id === c.contaId)
    if (!acc || !c.driveFolderId) throw new ReferenciasApiError('sem_drive', MSG.semDrive, { status: 409 })
    return acc
  }

  /**
   * Arquivos da coleção no Drive (mais novos primeiro), cada um com `referencia` (link, autor, legenda…).
   * @returns {Promise<{ colecao, itens: object[], accountId: string }>}
   */
  async itens(colecaoId, { forcar = false, signal } = {}) {
    const c = await this.#colecao(colecaoId)
    const acc = this.#contaDaColecao(c)
    const hit = this.itensCache.get(colecaoId)
    if (!forcar && hit && Date.now() - hit.at < ITENS_TTL_MS) return { colecao: c, itens: hit.itens, accountId: acc.id }
    const drive = this.manager.driveFor(acc.id)
    const itens = []
    let pageToken
    do {
      const r = await drive.api('GET', 'files', {
        query: {
          q: `'${escapeQueryValue(c.driveFolderId)}' in parents and trashed = false`,
          fields: `nextPageToken,files(${BROWSE_FIELDS},description,appProperties,createdTime)`,
          orderBy: 'createdTime desc',
          pageSize: 1000,
          includeItemsFromAllDrives: 'true',
          supportsAllDrives: 'true',
          pageToken,
        },
        signal,
      })
      for (const f of r.files || []) {
        const it = toDriveItem(f)
        if (it.isFolder) continue
        it.createdTime = f.createdTime ?? null
        it.referencia = lerReferencia(f)
        itens.push(it)
      }
      pageToken = r.nextPageToken
    } while (pageToken)
    itens.sort((a, b) => String(b.createdTime || b.modifiedTime || '').localeCompare(String(a.createdTime || a.modifiedTime || '')))
    this.itensCache.set(colecaoId, { at: Date.now(), itens })
    return { colecao: c, itens, accountId: acc.id }
  }

  /** Links da fila do site (celular) desta coleção que ainda não viraram arquivo: pendentes e com erro. */
  async pendentesDaColecao(colecaoId) {
    let fila = []
    try {
      fila = await this.api.listarFila({ colecaoId })
    } catch {
      return []
    }
    const locais = new Set([...this.jobs.values()].filter(j => j.filaId).map(j => j.filaId))
    return fila.filter(i => i.colecao?.id === colecaoId && (i.status === 'pendente' || i.status === 'erro' || i.status === 'baixando') && !locais.has(i.id))
  }

  /** Tira um link da fila do site (cancelar um pendente que veio do celular). */
  async cancelarItemDaFila(filaId) {
    this.#semConta()
    await this.api.cancelarItem(filaId)
    return true
  }

  async tentarItemDaFila(filaId) {
    this.#semConta()
    await this.api.atualizarItem(filaId, { status: 'pendente' })
    this.#planejarConsulta(500)
    return true
  }

  // ─────────── salvar ───────────

  /**
   * Salva um vídeo/post (o yt-dlp baixa, o envio sobe). Volta na hora com o trabalho; o resto é em segundo plano.
   * @param {{ url: string, colecaoId: string, nota?: string, origem?: 'navegador'|'colar'|'fila', filaId?: string, colecao?: object }} o
   */
  async salvar({ url, colecaoId, nota = '', origem = 'colar', filaId = null, colecao = null } = {}) {
    this.#semConta()
    const limpo = limparUrl(url)
    if (!limpo) throw new ReferenciasApiError('entrada', MSG.linkInvalido, { status: 400 })
    const c = colecao?.driveFolderId && colecao?.contaId ? colecao : await this.#colecao(colecaoId)
    this.#contaDaColecao(c)
    const job = this.#novo({ tipo: 'video', url: limpo, colecao: c, nota, origem, filaId })
    this.#proximo()
    return publico(job)
  }

  /**
   * Salva uma imagem (menu "Salvar imagem como referência" do navegador de referências).
   * @param {{ imagemUrl: string, paginaUrl?: string, titulo?: string, colecaoId: string, nota?: string }} o
   */
  async salvarImagem({ imagemUrl, paginaUrl = '', titulo = '', colecaoId, nota = '' } = {}) {
    this.#semConta()
    const isData = typeof imagemUrl === 'string' && /^data:image\//i.test(imagemUrl)
    if (!isData && !limparUrl(imagemUrl)) throw new ReferenciasApiError('entrada', 'Endereço de imagem inválido.', { status: 400 })
    const c = await this.#colecao(colecaoId)
    this.#contaDaColecao(c)
    const pagina = limparUrl(paginaUrl) || (isData ? '' : imagemUrl)
    const job = this.#novo({ tipo: 'imagem', url: pagina || imagemUrl.slice(0, 200), imagemUrl, titulo: String(titulo || '').slice(0, 300), colecao: c, nota, origem: 'navegador' })
    this.#proximo()
    return publico(job)
  }

  #novo({ tipo, url, imagemUrl, titulo, colecao, nota, origem, filaId }) {
    const now = Date.now()
    const job = {
      id: newId('ref'),
      tipo,
      url,
      imagemUrl: imagemUrl || null,
      tituloPagina: titulo || null,
      plataforma: detectar(url).plataforma || 'web',
      colecao: { id: colecao.id, nome: colecao.nome, driveFolderId: colecao.driveFolderId, contaId: colecao.contaId },
      nota: String(nota || '').trim().slice(0, 2000),
      origem,
      filaId: filaId || null,
      fase: 'na_fila',
      progresso: null,
      erro: null,
      criadoEm: now,
      atualizadoEm: now,
    }
    this.jobs.set(job.id, job)
    this.file.saveSoon?.()
    this.#emit()
    return job
  }

  /** Cancela: para o download ou o envio, apaga os temporários e avisa o site (item da fila → erro "Cancelado"). */
  async cancelar(id) {
    const j = this.jobs.get(id)
    if (!j) return false
    if (!ATIVAS.has(j.fase) || j.fase === 'concluindo') return true
    this.running.get(id)?.abort()
    if (j.fase === 'enviando' && j.transferId) await this.manager.cancel([j.transferId]).catch(() => {})
    await this.#terminar(j, 'cancelado', { codigo: 'cancelado', mensagem: MSG.cancelado })
    return true
  }

  /** Tenta de novo um trabalho que deu erro (ou foi cancelado). */
  async tentarDeNovo(id) {
    const j = this.jobs.get(id)
    if (!j || ATIVAS.has(j.fase)) return j ? publico(j) : null
    if (j.filaId) {
      // Item do celular: volta para a fila do site e o consumidor pega de novo.
      await this.api.atualizarItem(j.filaId, { status: 'pendente' }).catch(() => {})
      this.jobs.delete(j.id)
      this.file.saveSoon?.()
      this.#planejarConsulta(300)
      this.#emit()
      return null
    }
    this.#touch(j, { fase: 'na_fila', erro: null, progresso: null, transferId: null, driveFileId: null })
    this.#proximo()
    return publico(j)
  }

  remover(id) {
    const j = this.jobs.get(id)
    if (!j || ATIVAS.has(j.fase)) return false
    this.jobs.delete(id)
    if (j.transferId) this.byTransfer.delete(j.transferId)
    this.file.saveSoon?.()
    this.#emit()
    return true
  }

  // ─────────── execução ───────────

  #proximo() {
    if (this.closed) return
    for (const j of [...this.jobs.values()].sort((a, b) => a.criadoEm - b.criadoEm)) {
      if (this.running.size >= this.concorrencia) return
      if (j.fase !== 'na_fila' || this.running.has(j.id)) continue
      const ac = new AbortController()
      this.running.set(j.id, ac)
      this.#rodar(j, ac.signal)
        .catch(err => this.log('trabalho falhou sem tratamento:', err?.stack || err))
        .finally(() => {
          this.running.delete(j.id)
          this.#proximo()
        })
    }
  }

  async #rodar(j, signal) {
    const work = path.join(this.tmpDir, j.id)
    const envio = path.join(this.enviosDir, j.id)
    let cookiesFile = null
    // Temporários fora ANTES de anunciar o fim (quem olha o estado final nunca vê sobra).
    const limpar = async () => {
      await apagarCookies(cookiesFile)
      cookiesFile = null
      await fs.rm(work, { recursive: true, force: true }).catch(() => {})
    }
    this.#touch(j, { fase: 'baixando', erro: null, progresso: { fase: 'preparando', fracao: null } })
    this.#sinalDeVida(j)
    try {
      await fs.mkdir(work, { recursive: true, mode: 0o700 })
      await fs.mkdir(envio, { recursive: true, mode: 0o700 })
      let pronto
      if (j.tipo === 'imagem') pronto = await this.#prepararImagem(j, envio, signal)
      else {
        const bin = await this.updater?.resolver?.()
        if (!bin) throw new YtdlpError('sem_ytdlp', MSG.semYtdlp)
        const dominios = dominiosDeCookies(j.url)
        if (this.cookieProvider && dominios.length) {
          const cookies = await Promise.resolve(this.cookieProvider(dominios)).catch(err => {
            this.log('não consegui ler os cookies do navegador:', err?.message)
            return []
          })
          cookiesFile = await gravarCookies(path.join(work, '.c'), cookies)
        }
        let ultimo = 0
        const r = await this.baixar({
          bin: bin.path,
          url: j.url,
          workDir: work,
          plataforma: j.plataforma,
          ffmpeg: this.ffmpeg(),
          cookies: cookiesFile,
          cacheDir: path.join(this.paths.root, 'yt-dlp', 'cache'),
          jsRuntime: this.jsRuntime,
          signal,
          log: (...a) => this.log(...a),
          onProgress: p => {
            j.progresso = p
            const now = Date.now()
            if (now - ultimo > EVENTO_MS) {
              ultimo = now
              this.#emit()
            }
          },
        })
        await apagarCookies(cookiesFile)
        cookiesFile = null
        pronto = await this.#prepararVideo(j, r, envio)
        await this.#paraCelular(j, pronto, signal)
      }
      await limpar()
      if (signal.aborted) throw Object.assign(new Error('cancelado'), { name: 'AbortError' })
      await this.#enviar(j, pronto)
    } catch (err) {
      await limpar()
      if (isAbortError(err) || signal.aborted) {
        if (this.closed) return // app fechando: na próxima abertura o download recomeça
        if (ATIVAS.has(j.fase)) await this.#terminar(j, 'cancelado', { codigo: 'cancelado', mensagem: MSG.cancelado })
        return
      }
      const codigo = err?.codigo || 'erro'
      const mensagem = err instanceof YtdlpError || err instanceof ReferenciasApiError ? err.message : j.tipo === 'imagem' ? MSG.imagem : 'Não deu para salvar esta referência.'
      if (!(err instanceof YtdlpError)) this.log('referência falhou:', err?.message)
      await fs.rm(envio, { recursive: true, force: true }).catch(() => {})
      await this.#terminar(j, 'erro', { codigo, mensagem })
    } finally {
      await limpar()
    }
  }

  /** Move o vídeo para a pasta de envio com o nome final e prepara descrição, appProperties e miniatura. */
  async #prepararVideo(j, r, envio) {
    const res = r.resumo || {}
    const plataforma = j.plataforma !== 'web' ? j.plataforma : res.extrator || detectar(res.pagina || j.url).nome
    const nome = nomeDoArquivo({ autor: res.autor, titulo: res.titulo, plataforma, id: res.id, ext: r.video.ext === 'mp4' ? 'mp4' : r.video.ext })
    const destino = path.join(envio, 'arquivo')
    await fs.rename(r.video.path, destino)
    let miniatura = null
    if (r.miniatura && /\.(jpe?g|png)$/i.test(r.miniatura)) {
      const st = await fs.stat(r.miniatura).catch(() => null)
      if (st && st.size > 0 && st.size <= MINIATURA_MAX) {
        miniatura = path.join(envio, `miniatura${path.extname(r.miniatura).toLowerCase()}`)
        await fs.rename(r.miniatura, miniatura).catch(() => (miniatura = null))
      }
    }
    const meta = {
      description: descricao({ url: j.url, titulo: res.titulo, autor: res.autor, plataforma, salvoEm: new Date(), nota: j.nota, legenda: res.legenda }),
      appProperties: appProperties({ url: j.url, plataforma, autor: res.autor, titulo: res.titulo, fila: j.filaId }),
    }
    return { arquivo: destino, nome, miniatura, meta }
  }

  /**
   * VP9/AV1 (o iPhone não toca) vira H.264 antes de subir. Sem conversor ou se a conversão falhar, sobe como veio
   * (sem a marca do celular: a passada das antigas tenta de novo depois).
   */
  async #paraCelular(j, pronto, signal) {
    let r
    try {
      const motor = await this.motor()
      r = await this.converter(pronto.arquivo, {
        motor,
        signal,
        tmpRoot: this.tmpDir,
        log: (...a) => this.log(...a),
        onProgress: frac => {
          j.progresso = { fase: 'convertendo', fracao: frac ?? null }
          this.#emit()
        },
      })
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) throw err
      this.log('não converti a referência para o celular; vai como veio:', err?.message)
      return
    }
    if (r.estado === 'convertido') {
      try {
        await fs.copyFile(r.path, pronto.arquivo)
      } finally {
        await r.limpar()
      }
      if (!/\.mp4$/i.test(pronto.nome)) pronto.nome = pronto.nome.replace(/\.[a-z0-9]+$/i, '') + '.mp4'
    }
    if (r.estado === 'convertido' || r.estado === 'ok') pronto.meta.appProperties = { ...pronto.meta.appProperties, [MARCA_CELULAR]: CELULAR_OK }
  }

  /** Troca o conteúdo de um arquivo do Drive (mesmo id) pelo vídeo convertido, já com a marca do celular. */
  async #substituir(drive, item, localPath, signal) {
    const st = await fs.stat(localPath)
    const up = {
      id: newId('cel'),
      type: 'upload',
      status: 'running',
      name: item.name,
      size: st.size,
      bytesDone: 0,
      attempts: 0,
      note: null,
      verify: null,
      local: { path: localPath, size: st.size, mtimeMs: st.mtimeMs },
      target: { rootId: item.parents?.[0] || 'root', relDir: '', parentId: item.parents?.[0] || null, driveId: null, replaceFileId: item.id, fileId: null, appProperties: { [MARCA_CELULAR]: CELULAR_OK } },
      session: null,
    }
    const ctx = {
      drive,
      settings: { get: () => ({ ...(this.settings?.get?.() ?? {}), verifyChecksums: false }) },
      limiter: this.manager?.limiters?.upload ?? null,
      hasher: null,
      persist: () => {},
      onBytes: () => {},
      log: (...a) => this.log(...a),
    }
    await this.criarUpload(up, ctx).run(signal)
    // Arquivo apagado no meio do caminho: o envio pode ter criado outro. Nada de cópia solta na coleção.
    if (up.target.fileId && up.target.fileId !== item.id) {
      await drive.trash(up.target.fileId).catch(() => {})
      throw new Error('o arquivo original sumiu do Drive durante a conversão')
    }
  }

  /** Marca no Drive que esta referência já toca no iPhone (não confere de novo). */
  async #marcarCelular(drive, fileId, signal) {
    await drive.api('PATCH', `files/${encodeURIComponent(fileId)}`, {
      query: { supportsAllDrives: 'true', fields: 'id' },
      body: { appProperties: { [MARCA_CELULAR]: CELULAR_OK } },
      signal,
    })
  }

  /** As coleções olhadas pela passada do celular mudaram: a interface relê os itens. */
  recarregar() {
    for (const id of [...this.itensCache.keys()]) this.#bump(id)
    this.#emit()
  }

  async #prepararImagem(j, envio, signal) {
    j.progresso = { fase: 'baixando', fracao: null }
    let cookie = ''
    if (this.cookieProvider && /^https?:/i.test(j.imagemUrl)) {
      const host = new URL(j.imagemUrl).hostname
      const cookies = await Promise.resolve(this.cookieProvider(dominiosDeCookies(`https://${host}/`))).catch(() => [])
      cookie = cabecalhoCookie(cookies, j.imagemUrl)
    }
    let img
    try {
      img = await this.baixarImg(j.imagemUrl, { cookie, referer: /^https?:/i.test(j.url) ? j.url : null, signal })
    } catch (err) {
      if (isAbortError(err)) throw err
      throw new YtdlpError('imagem', `${MSG.imagem} ${err?.message ? `(${err.message})` : ''}`.trim())
    }
    const destino = path.join(envio, 'arquivo')
    await fs.writeFile(destino, img.buffer, { mode: 0o600 })
    const plataforma = j.plataforma !== 'web' ? j.plataforma : detectar(j.url).nome
    const autor = autorDoTitulo(j.tituloPagina)
    const titulo = tituloDaPagina(j.tituloPagina)
    const nome = nomeDoArquivo({ autor, titulo, plataforma, id: 'Imagem', ext: img.ext })
    const meta = {
      description: descricao({ url: j.url, titulo, autor, plataforma, salvoEm: new Date(), nota: j.nota, legenda: j.imagemUrl && !j.imagemUrl.startsWith('data:') ? `Imagem: ${j.imagemUrl}` : '' }),
      appProperties: appProperties({ url: j.url, plataforma, autor, titulo }),
    }
    return { arquivo: destino, nome, miniatura: null, meta }
  }

  /** Põe o arquivo na fila de envios (aparece em Transferências) com os metadados na criação do arquivo no Drive. */
  async #enviar(j, pronto) {
    const st = await fs.stat(pronto.arquivo)
    const now = Date.now()
    const batch = { id: newId('b'), type: 'upload', label: `Referência · ${j.colecao.nome}`, createdAt: now, accountId: j.colecao.contaId, quiet: true }
    const rec = {
      id: newId('t'),
      type: 'upload',
      accountId: j.colecao.contaId,
      batchId: batch.id,
      status: 'queued',
      name: pronto.nome,
      relPath: pronto.nome,
      size: st.size,
      bytesDone: 0,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
      error: null,
      retryAt: null,
      attempts: 0,
      verify: null,
      note: null,
      conflict: 'skip',
      local: { path: pronto.arquivo, size: st.size, mtimeMs: st.mtimeMs },
      target: { rootId: j.colecao.driveFolderId, relDir: '', parentId: j.colecao.driveFolderId, driveId: null, replaceFileId: null, fileId: null, meta: pronto.meta },
      session: null,
      referencia: { jobId: j.id, colecao: j.colecao.nome },
    }
    this.byTransfer.set(rec.id, j.id)
    this.#touch(j, { fase: 'enviando', nome: pronto.nome, transferId: rec.id, miniatura: pronto.miniatura, progresso: { fase: 'enviando', fracao: 0 } })
    const added = await this.manager.add({ batch, records: [rec] })
    if (!added.records.length) throw new Error('o envio não entrou na fila')
  }

  // ─────────── fim dos envios (eventos da fila de transferências) ───────────

  #transfersChanged(list) {
    for (const t of list || []) {
      const jobId = t?.referencia?.jobId || this.byTransfer.get(t?.id)
      const j = jobId && this.jobs.get(jobId)
      if (!j || j.transferId !== t.id || j.fase !== 'enviando') continue
      if (t.status === 'completed' || t.status === 'skipped') {
        const fileId = t.target?.fileId
        if (fileId) this.#concluir(j, fileId).catch(err => this.log('não consegui concluir a referência:', err?.message))
        continue
      }
      if (t.status === 'canceled') {
        this.#terminar(j, 'cancelado', { codigo: 'cancelado', mensagem: MSG.cancelado }).catch(() => {})
        continue
      }
      if (t.status === 'failed') {
        this.#terminar(j, 'erro', { codigo: 'envio', mensagem: t.error?.message || MSG.envioFalhou }).catch(() => {})
        continue
      }
      const size = Number(t.size) || 0
      j.progresso = { fase: t.status === 'running' || t.status === 'verifying' ? 'enviando' : t.status === 'paused' ? 'pausado' : 'aguardando', fracao: size ? Math.min(1, (Number(t.bytesDone) || 0) / size) : null, velocidade: t.speed || null }
      this.#emit()
    }
  }

  #transfersRemoved(ids) {
    for (const id of ids || []) {
      const jobId = this.byTransfer.get(id)
      const j = jobId && this.jobs.get(jobId)
      if (j && j.fase === 'enviando' && j.transferId === id) this.#terminar(j, 'cancelado', { codigo: 'cancelado', mensagem: MSG.cancelado }).catch(() => {})
    }
  }

  async #concluir(j, fileId) {
    if (j.fase !== 'enviando') return
    j.fase = 'concluindo' // evita concluir duas vezes (vários eventos da mesma transferência)
    const miniatura = j.miniatura
    if (miniatura) {
      // Miniatura na hora (o Drive gera a dele para MP4, mas demora): melhor esforço, nunca atrapalha o "Salvo".
      try {
        const img = await fs.readFile(miniatura)
        await this.manager.driveFor(j.colecao.contaId).setThumbnail(fileId, img, /\.png$/i.test(miniatura) ? 'image/png' : 'image/jpeg', { retries: 2 })
      } catch (err) {
        this.log('miniatura da referência:', err?.message)
      }
    }
    await this.#terminar(j, 'pronto', null, { driveFileId: fileId })
    this.#toast('success', `Salvo em ${j.colecao.nome}`)
  }

  /** Estado final: grava, apaga os temporários e avisa o site quando o trabalho veio da fila do celular. */
  async #terminar(j, fase, erro, extra = {}) {
    if (!this.jobs.has(j.id) || FINAIS.has(j.fase) || terminando.has(j)) return
    terminando.add(j)
    clearInterval(this.vida.get(j.id))
    this.vida.delete(j.id)
    const daFila = j.filaId
    // Apaga os temporários antes de anunciar o fim: quem vê "pronto" (a tela, os testes) não encontra resto.
    if (fase === 'pronto' || fase === 'cancelado' || fase === 'erro') await fs.rm(path.join(this.enviosDir, j.id), { recursive: true, force: true }).catch(() => {})
    this.#touch(j, { fase, erro, progresso: null, miniatura: null, ...extra })
    terminando.delete(j) // daqui em diante a fase final barra; "Tentar de novo" reusa o mesmo trabalho
    if (j.transferId && fase !== 'enviando') this.byTransfer.delete(j.transferId)
    if (fase === 'pronto') this.#bump(j.colecao.id)
    if (fase === 'erro' && j.origem !== 'fila') this.#toast('error', `${j.colecao?.nome ? `${j.colecao.nome}: ` : ''}${erro?.mensagem || 'não deu para salvar.'}`)
    if (daFila) {
      const patch = fase === 'pronto' ? { status: 'pronto', driveFileId: j.driveFileId } : { status: 'erro', erro: erro?.mensagem || 'Não deu para salvar.' }
      await this.api.atualizarItem(daFila, patch).catch(err => this.log('não consegui avisar o site sobre o item da fila:', err?.message))
      this.#bump(j.colecao?.id)
    }
    this.#podar()
    this.#emit()
  }

  /** Item pego da fila: a cada 5 min avisa o site que ainda está baixando/enviando (download e envio longos). */
  #sinalDeVida(j) {
    if (!j.filaId || this.vida.has(j.id)) return
    const t = setInterval(() => {
      if (!ATIVAS.has(j.fase) || this.closed) return
      this.api.atualizarItem(j.filaId, { status: 'baixando' }).catch(err => this.log('sinal de vida da fila:', err?.message))
    }, this.vidaMs)
    t.unref?.()
    this.vida.set(j.id, t)
  }

  #podar() {
    const feitos = [...this.jobs.values()].filter(j => !ATIVAS.has(j.fase)).sort((a, b) => b.atualizadoEm - a.atualizadoEm)
    for (const j of feitos.slice(MANTER_FEITOS)) this.jobs.delete(j.id)
  }

  /** Depois de abrir: download pela metade recomeça; envio continua (o registro está na fila de transferências). */
  async #reconciliar() {
    for (const j of this.jobs.values()) {
      if (j.fase === 'baixando' || j.fase === 'concluindo') j.fase = j.fase === 'concluindo' ? 'enviando' : 'na_fila'
      j.progresso = null
      if (j.fase !== 'enviando') continue
      const t = j.transferId ? this.manager?.get?.(j.transferId) : null
      if (!t) {
        await this.#terminar(j, 'erro', { codigo: 'envio', mensagem: 'O envio sumiu da fila. Tente de novo.' })
        continue
      }
      this.byTransfer.set(t.id, j.id)
      this.#transfersChanged([t])
    }
    this.file.saveSoon?.()
  }

  /** Pastas de envio sem trabalho ativo (sobras): fora. */
  async #limparEnvios() {
    const vivos = new Set([...this.jobs.values()].filter(j => ATIVAS.has(j.fase)).map(j => j.id))
    const nomes = await fs.readdir(this.enviosDir).catch(() => [])
    for (const n of nomes) if (!vivos.has(n)) await fs.rm(path.join(this.enviosDir, n), { recursive: true, force: true }).catch(() => {})
  }

  #agendar() {
    this.#proximo()
  }

  // ─────────── fila do celular ───────────

  #planejarConsulta(ms = this.pollMs) {
    if (this.closed || !this.autoStart) return
    clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      this.consultarFila().catch(() => {})
    }, ms)
    this.pollTimer.unref?.()
  }

  /**
   * Pega os links pendentes da fila do site e começa a baixar. Um computador por item: quem perde a corrida (409)
   * só segue para o próximo. Chamado a cada 60 s, quando o app volta ao foco e pelo botão da tela.
   */
  async consultarFila() {
    if (this.polling) return this.polling
    this.polling = (async () => {
      try {
        if (!this.cloud?.signedIn) return { pegos: 0 }
        if (this.motivo === 'plano' && Date.now() < this.planoAte) return { pegos: 0 }
        let fila
        try {
          fila = await this.api.listarFila({ status: 'pendente' })
        } catch (err) {
          if (err?.codigo === 'plano') {
            this.motivo = 'plano'
            this.planoAte = Date.now() + PLANO_PAUSA_MS
            this.#emit()
          } else if (err?.codigo !== 'sem_sessao') this.log('fila de referências:', err?.message)
          return { pegos: 0 }
        }
        if (this.motivo === 'plano') {
          this.motivo = null
          this.#emit()
        }
        const locais = new Set([...this.jobs.values()].filter(j => j.filaId && ATIVAS.has(j.fase)).map(j => j.filaId))
        let pegos = 0
        for (const item of fila) {
          if (this.closed) break
          if (item.status !== 'pendente' || locais.has(item.id)) continue
          let meu
          try {
            meu = await this.api.pegar(item.id)
          } catch (err) {
            this.log('não consegui pegar o item da fila:', err?.message)
            continue
          }
          if (!meu) continue // outro computador pegou antes
          const colecaoInfo = item.colecao?.driveFolderId && item.colecao.contaId ? item.colecao : null
          try {
            await this.salvar({ url: item.url, colecaoId: item.colecao?.id, colecao: colecaoInfo, nota: item.nota || '', origem: 'fila', filaId: item.id })
            pegos++
          } catch (err) {
            // Link ruim, coleção apagada, Drive desconectado: o celular fica sabendo pelo erro do item.
            await this.api.atualizarItem(item.id, { status: 'erro', erro: err?.message || 'Não deu para salvar.' }).catch(() => {})
          }
        }
        return { pegos }
      } finally {
        this.polling = null
        if (this.ativo) this.#planejarConsulta()
      }
    })()
    return this.polling
  }
}

/** "Fulano no Instagram: “legenda”" / "Fulano (@fulano) • Instagram" → "Fulano". */
export function autorDoTitulo(t) {
  const s = String(t || '').trim()
  const m = /^(.{1,80}?)\s+(?:on|no|em)\s+(?:Instagram|TikTok|Pinterest|X|Twitter|Facebook)\b/i.exec(s) || /^(.{1,80}?)\s+\(@[\w.]+\)/.exec(s)
  return m ? m[1].trim() : ''
}

/** Título da página sem o nome do site no fim (" - YouTube", " | Pinterest"). */
export function tituloDaPagina(t) {
  const s = String(t || '').trim()
  const legenda = /:\s*["“](.+?)["”]\s*$/.exec(s)
  if (legenda) return legenda[1]
  return s.replace(/\s*[-|•·]\s*(YouTube|Instagram|TikTok|Pinterest|Vimeo|X|Twitter|Facebook)\s*$/i, '').trim()
}
