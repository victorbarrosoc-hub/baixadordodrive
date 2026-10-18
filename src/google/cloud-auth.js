// Conta SOBEDESCE neste computador (docs/CONTAS.md §5 e §7).
//
// O computador entra na conta pelo fluxo de dispositivo: pede um código (POST /api/dispositivo/iniciar), a pessoa
// aprova no navegador e o app recebe um token de dispositivo (`sdd_...`). Com ele, o site entrega access tokens dos
// Google Drives vinculados à conta (POST /api/drive/token). O refresh token do Google fica só no servidor.
//
// O token do dispositivo fica em `cloud.json` (modo 0600, gravação atômica) junto com a última lista de Drives,
// para o app abrir sem internet e as transferências da fila acharem a conta delas.
// Ids das contas da nuvem no motor: `nuvem:<id>` (o AuthManager encaminha esses ids para cá).
import os from 'node:os'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { dataPaths, cloudUrl } from '../config.js'
import { ArquivoSecreto } from '../util/segredos.js'
import { httpRequest, HttpError } from '../net/http.js'
import { backoffDelay, isAbortError, sleep } from '../util/backoff.js'
import { classifyError, SobeDesceError } from './errors.js'
import { readBuildInfo } from '../version.js'

export const CLOUD_PREFIX = 'nuvem:'

const TOKEN_MARGIN_MS = 5 * 60_000 // usa o access token guardado até faltar isso para vencer
const MIN_REUSE_MS = 30_000 // token que já chega quase vencendo (relógio torto) vale ao menos isso, sem martelar o site
const REQUEST_TIMEOUT_MS = 20_000
const LOGOUT_TIMEOUT_MS = 8_000
const TOKEN_TRIES = 3
const REFRESH_EVERY_MS = 5 * 60_000
const DEFAULT_INTERVAL_S = 3
const MAX_INTERVAL_MS = 15_000
const DEFAULT_LOGIN_TTL_MS = 10 * 60_000
const READY_SHOWN_MS = 60_000 // "Pronto. Seus Drives apareceram aqui." fica na tela só esse tempo depois de entrar

export const MSG_RECONNECT = 'Reconecte este Drive em sobedesce.com/conta'
const MSG_SIGNED_OUT = 'Sua sessão na conta SOBEDESCE terminou. Entre de novo para usar seus Drives.'
const MSG_NOT_SIGNED_IN = 'Entre na conta SOBEDESCE para usar este Drive.'
const MSG_GONE = 'Este Drive saiu da sua conta SOBEDESCE. Confira em sobedesce.com/conta.'
const MSG_OFFLINE = 'Sem conexão com a conta SOBEDESCE. Tentando de novo…'
const MSG_SERVER = 'A conta SOBEDESCE não respondeu agora. Tentando de novo…'

/** 'darwin' → 'mac', 'win32' → 'windows', resto → 'linux' (o que o site entende). */
export function platformName(p = process.platform) {
  if (p === 'darwin') return 'mac'
  if (p === 'win32') return 'windows'
  return 'linux'
}

function execText(cmd, args) {
  return new Promise(resolve => {
    try {
      execFile(cmd, args, { timeout: 2000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout || '').trim()))
    } catch {
      resolve('')
    }
  })
}

/** Nome do computador como a pessoa o reconhece ("MacBook Pro de Victor"); cai no hostname. */
export async function computerName(platform = process.platform) {
  let name = ''
  if (platform === 'darwin') name = await execText('scutil', ['--get', 'ComputerName'])
  if (!name) name = os.hostname().replace(/\.(local|lan|home|localdomain)$/i, '')
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
  return name || 'Computador'
}

function normalizeConta(raw) {
  if (!raw || typeof raw !== 'object' || raw.id == null || raw.id === '') return null
  return {
    id: String(raw.id),
    email: typeof raw.email === 'string' ? raw.email : null,
    nome: typeof raw.nome === 'string' ? raw.nome : null,
    fotoUrl: typeof raw.fotoUrl === 'string' && /^https:\/\//i.test(raw.fotoUrl) ? raw.fotoUrl : null,
    estado: raw.estado === 'reconectar' ? 'reconectar' : 'ok',
  }
}

function normalizeUsuario(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    id: raw.id != null ? String(raw.id) : null,
    email: typeof raw.email === 'string' ? raw.email : null,
    nome: typeof raw.nome === 'string' ? raw.nome : null,
  }
}

function webUrl(value, base) {
  try {
    const u = new URL(String(value), base)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}

/** Erro de rede/servidor da nuvem já classificado ('retry' mantém o código de rede: o DriveClient decide pela razão). */
function transient(err) {
  if (err?.name === 'TimeoutError') return new SobeDesceError('retry', MSG_OFFLINE, { reason: 'ETIMEDOUT' })
  if (err instanceof HttpError) {
    if (err.status === 429) return new SobeDesceError('retry', MSG_SERVER, { reason: 'cloudRateLimit', status: 429, retryAfterMs: err.retryAfterMs })
    if (err.status >= 500 || err.status === 408) return new SobeDesceError('retry', MSG_SERVER, { reason: err.body?.erro || `cloud${err.status}`, status: err.status })
    return null
  }
  const info = classifyError(err)
  if (info.kind === 'retry') return new SobeDesceError('retry', MSG_OFFLINE, { reason: info.reason })
  return null
}

/** Mensagem do site ({ erro, mensagem }) ou um texto padrão. */
function siteMessage(err, fallback) {
  const m = err?.body && typeof err.body === 'object' ? err.body.mensagem : null
  return typeof m === 'string' && m.trim() ? m.trim() : fallback
}

/**
 * Cliente da conta SOBEDESCE com a mesma cara do AuthManager para o motor: listAccounts(), getAccessToken(id, opts),
 * evento 'accounts'. Os ids aqui são os do site (sem o prefixo); o AuthManager põe e tira o `nuvem:`.
 *
 * Eventos: 'accounts' (lista pública, quando muda), 'status' (CloudStatus, a cada mudança — vai para a interface),
 * 'signedOut' ({ reason, message }) quando a sessão é revogada no site.
 */
export class CloudAuth extends EventEmitter {
  /**
   * @param {{ paths?: object, baseUrl?: string, deviceName?: string, platform?: string,
   *   refreshEveryMs?: number, retryBaseMs?: number, pollMs?: number|null, readyShownMs?: number, log?: Function }} [opts]
   *   `pollMs`: intervalo fixo entre consultas do login (só testes; o normal é o `intervalo` do site, mínimo 1 s).
   *   `readyShownMs`: por quanto tempo o login fica "pronto" (o aviso de sucesso) antes de voltar a "nenhum".
   */
  constructor({ paths = dataPaths(), baseUrl, deviceName = null, platform = process.platform, build = readBuildInfo().build, refreshEveryMs = REFRESH_EVERY_MS, retryBaseMs = 400, pollMs = null, readyShownMs = READY_SHOWN_MS, log, segredos = null } = {}) {
    super()
    this.paths = paths
    this.file = paths.cloud
    // Com a guarda do sistema (app de desktop), a sessão fica em cloud.cifrado.json (src/util/segredos.js).
    this.arquivo = new ArquivoSecreto(paths.cloud, { guarda: segredos })
    this.baseUrl = String(baseUrl || cloudUrl()).replace(/\/+$/, '')
    this.deviceName = deviceName
    this.platform = platform
    // Vai em todo pedido ao site (x-sobedesce-build): o admin vê qual versão do app cada computador usa.
    this.build = Number.isSafeInteger(build) && build >= 0 ? build : 0
    this.refreshEveryMs = refreshEveryMs
    this.retryBaseMs = retryBaseMs
    this.pollMs = pollMs
    this.readyShownMs = readyShownMs
    this.readyTimer = null
    this.log = log || ((...args) => console.warn('[conta]', ...args))
    this.session = null // { token, usuario, contas, entrouEm, atualizadoEm }
    this.tokens = new Map() // contaId -> { token, expiresAt, at }
    this.inflight = new Map() // contaId -> Promise (uma requisição de token por vez por conta)
    this.login = null // { estado, codigo, url, expiraEm, intervaloMs, segredo, ac, mensagem }
    this.lastError = null // texto da última falha ao atualizar a lista (sem internet etc.)
    this.notice = null // aviso para a tela (ex.: sessão revogada)
    this.refreshing = null
    this.timer = null
    this.closed = false
    this.loaded = false
    this.loading = null
    this.signingOut = null
  }

  // ─────────── ciclo de vida ───────────

  async init() {
    if (this.loaded) return
    this.loading ??= (async () => {
      const raw = await this.arquivo.ler(null).catch(() => null)
      // Token de outro servidor (ex.: um teste apontou para o site falso) não vale aqui.
      if (raw && typeof raw.token === 'string' && raw.token.startsWith('sdd_') && (!raw.servidor || raw.servidor === this.baseUrl)) {
        this.session = {
          token: raw.token,
          usuario: normalizeUsuario(raw.usuario),
          contas: (Array.isArray(raw.contas) ? raw.contas : []).map(normalizeConta).filter(Boolean),
          entrouEm: Number(raw.entrouEm) || Date.now(),
          atualizadoEm: Number(raw.atualizadoEm) || null,
        }
      }
      this.loaded = true
      if (this.session) {
        this.#startTimer()
        // Ao abrir o app: atualiza a lista em segundo plano (sem internet, fica a última lista conhecida).
        this.refresh({ full: true }).catch(() => {})
      }
    })().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  async #ready() {
    if (!this.loaded) await this.init()
  }

  close() {
    this.closed = true
    this.#stopTimer()
    clearTimeout(this.readyTimer)
    this.login?.ac.abort()
  }

  #startTimer() {
    this.#stopTimer()
    if (!this.refreshEveryMs || this.closed) return
    this.timer = setInterval(() => this.refresh().catch(() => {}), this.refreshEveryMs)
    this.timer.unref?.()
  }

  #stopTimer() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // ─────────── estado público ───────────

  get signedIn() {
    return Boolean(this.session)
  }

  #publicConta(c) {
    return { id: `${CLOUD_PREFIX}${c.id}`, email: c.email, name: c.nome || c.email, photoUrl: c.fotoUrl, addedAt: null, status: c.estado === 'reconectar' ? 'reauth' : 'ok', source: 'nuvem' }
  }

  /** Contas no formato do AuthManager (id `nuvem:<id>`, status 'ok'|'reauth', source 'nuvem'). */
  listAccounts() {
    return this.session ? this.session.contas.map(c => this.#publicConta(c)) : []
  }

  #publicLogin() {
    const l = this.login
    if (!l) return { estado: 'nenhum' }
    return { estado: l.estado, codigo: l.codigo ?? null, url: l.url ?? null, expiraEm: l.expiraEm ?? null, ...(l.mensagem ? { mensagem: l.mensagem } : {}) }
  }

  /** O que a interface mostra. Nunca leva tokens nem o segredo do login. */
  status() {
    const s = this.session
    return {
      conectado: Boolean(s),
      site: this.baseUrl,
      contaUrl: `${this.baseUrl}/conta`,
      usuario: s?.usuario ?? null,
      contas: this.listAccounts(),
      login: this.#publicLogin(),
      atualizadoEm: s?.atualizadoEm ?? null,
      erro: s ? this.lastError : null,
      aviso: this.notice,
    }
  }

  #emitStatus() {
    this.emit('status', this.status())
  }

  #emitAccounts() {
    this.emit('accounts', this.listAccounts())
  }

  async #save() {
    const s = this.session
    if (!s) return
    await this.arquivo.gravar({ versao: 1, servidor: this.baseUrl, token: s.token, usuario: s.usuario, contas: s.contas, entrouEm: s.entrouEm, atualizadoEm: s.atualizadoEm })
  }

  // ─────────── HTTP ───────────

  /**
   * Chamada à API do site. Devolve { status, data }. Erros: HttpError (status fora de `expect`), rede, timeout.
   * `auth: true` manda o Bearer do dispositivo; nunca manda cookie.
   */
  async #call(method, path, { body, auth = true, expect = [200], timeoutMs = REQUEST_TIMEOUT_MS, token } = {}) {
    const headers = { accept: 'application/json', 'x-sobedesce-build': String(this.build) }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (auth) {
      const t = token ?? this.session?.token
      if (!t) throw new SobeDesceError('reauth', MSG_NOT_SIGNED_IN, { reason: 'cloudSignedOut' })
      headers.authorization = `Bearer ${t}`
    }
    const res = await httpRequest(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      expect,
      maxRedirects: 0,
      signal: AbortSignal.timeout(timeoutMs),
    })
    let text = ''
    try {
      text = await res.body.text()
    } catch {
      text = ''
    }
    let data = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
    }
    return { status: res.status, data }
  }

  /**
   * Chamada autenticada à API do site para outras partes do app (Referências: src/referencias/api.js).
   * Devolve { status, data }. Status fora de `expect` → HttpError (com o corpo { erro, mensagem } lido em `body`).
   * 401 com o token deste computador = sessão revogada: sai da conta (como nas outras chamadas) e lança 'reauth'.
   */
  async request(method, path, { body, expect = [200], timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    await this.#ready()
    const s = this.session
    if (!s) throw new SobeDesceError('reauth', MSG_NOT_SIGNED_IN, { reason: 'cloudSignedOut' })
    try {
      return await this.#call(method, path, { body, expect, timeoutMs, token: s.token })
    } catch (err) {
      if (this.#isRevoked(err, s.token)) {
        await this.#revoked()
        throw new SobeDesceError('reauth', MSG_SIGNED_OUT, { reason: 'cloudSignedOut', status: 401 })
      }
      throw err
    }
  }

  /** 401 numa chamada com o token do dispositivo: a sessão foi revogada no site (ou venceu). */
  #isRevoked(err, token) {
    return err instanceof HttpError && err.status === 401 && token && this.session?.token === token
  }

  // ─────────── entrar (fluxo de dispositivo) ───────────

  /** Pede um código e começa a esperar a aprovação. Devolve o estado público do login ({ estado, codigo, url, expiraEm }). */
  async beginLogin() {
    await this.#ready()
    this.login?.ac.abort()
    this.login = null
    this.notice = null
    const nome = this.deviceName || (await computerName(this.platform))
    let res
    try {
      res = await this.#call('POST', '/api/dispositivo/iniciar', { auth: false, body: { nome, plataforma: platformName(this.platform) } })
    } catch (err) {
      if (isAbortError(err)) throw err
      const t = transient(err)
      if (t) throw new SobeDesceError('retry', 'Não consegui falar com sobedesce.com. Confira a internet e tente de novo.', { reason: t.reason })
      throw new SobeDesceError('fatal', siteMessage(err, 'O site não deixou começar o login agora. Tente de novo.'), { reason: err?.body?.erro || null, status: err?.status })
    }
    const d = res.data || {}
    const codigo = typeof d.codigo === 'string' ? d.codigo : ''
    const segredo = typeof d.segredo === 'string' ? d.segredo : ''
    if (!codigo || !segredo) throw new SobeDesceError('fatal', 'O site respondeu de um jeito inesperado. Tente de novo.', { reason: 'badDeviceStart' })
    const fallbackUrl = `${this.baseUrl}/dispositivo?codigo=${encodeURIComponent(codigo)}`
    const url = webUrl(d.url, this.baseUrl) || fallbackUrl
    const ttl = Number(d.expiraEm)
    const login = {
      estado: 'pendente',
      codigo,
      url,
      expiraEm: Number.isFinite(ttl) && ttl > Date.now() ? ttl : Date.now() + DEFAULT_LOGIN_TTL_MS,
      intervaloMs: this.pollMs ?? Math.max(1, Number(d.intervalo) || DEFAULT_INTERVAL_S) * 1000,
      segredo,
      ac: new AbortController(),
      mensagem: null,
    }
    this.login = login
    this.#emitStatus()
    this.#poll(login).catch(err => this.log('espera do login falhou:', err?.message))
    return this.#publicLogin()
  }

  /** Para de esperar a aprovação (o código continua no site até vencer, mas ninguém mais vai buscá-lo). */
  cancelLogin() {
    if (this.login && this.login.estado === 'pendente') this.login.ac.abort()
    this.login = null
    this.#emitStatus()
    return this.status()
  }

  #finishLogin(login, estado, mensagem = null) {
    if (this.login !== login) return
    login.estado = estado
    login.mensagem = mensagem
    login.segredo = null
    // O aviso de sucesso é para a hora em que entrou: depois de um tempo o login volta a "nenhum" sozinho
    // (antes ficava "pronto" até sair da conta e o aviso aparecia em Ajustes horas depois).
    if (estado === 'pronto') {
      clearTimeout(this.readyTimer)
      this.readyTimer = setTimeout(() => {
        if (this.login !== login || login.estado !== 'pronto') return
        this.login = null
        this.#emitStatus()
      }, this.readyShownMs)
      this.readyTimer.unref?.()
    }
    this.#emitStatus()
  }

  async #poll(login) {
    const signal = login.ac.signal
    for (;;) {
      try {
        await sleep(login.intervaloMs, signal)
      } catch {
        return // cancelado
      }
      if (this.login !== login || this.closed) return
      if (Date.now() > login.expiraEm) return this.#finishLogin(login, 'expirado', 'O código venceu. Peça um novo.')
      let res
      try {
        res = await this.#call('POST', '/api/dispositivo/aguardar', { auth: false, body: { segredo: login.segredo }, expect: [200, 202] })
      } catch (err) {
        if (this.login !== login || signal.aborted) return
        if (err instanceof HttpError && err.status === 410) return this.#finishLogin(login, 'expirado', 'O código venceu. Peça um novo.')
        if (err instanceof HttpError && err.status === 429) {
          login.intervaloMs = Math.min(MAX_INTERVAL_MS, login.intervaloMs + 2000)
          continue
        }
        if (transient(err)) continue // sem internet por um instante: segue tentando até o código vencer
        return this.#finishLogin(login, 'erro', siteMessage(err, 'Não deu para concluir o login. Peça um novo código.'))
      }
      if (this.login !== login || signal.aborted) return
      if (res.status === 202) continue
      const token = res.data?.token
      if (typeof token !== 'string' || !token.startsWith('sdd_')) return this.#finishLogin(login, 'erro', 'O site respondeu de um jeito inesperado. Peça um novo código.')
      // "pronto" antes da lista nova chegar: a interface mostra a confirmação em vez de pular de tela.
      login.estado = 'pronto'
      login.segredo = null
      await this.#signedIn(token, res.data?.usuario)
      return this.#finishLogin(login, 'pronto')
    }
  }

  async #signedIn(token, usuario) {
    const old = this.session
    this.session = { token, usuario: normalizeUsuario(usuario), contas: old?.contas ?? [], entrouEm: Date.now(), atualizadoEm: null }
    this.tokens.clear()
    this.notice = null
    this.lastError = null
    try {
      await this.#save()
    } catch (err) {
      this.log('não consegui guardar a sessão da conta:', err?.message) // vale enquanto o app estiver aberto
    }
    this.#startTimer()
    await this.refresh({ full: true }).catch(() => {})
    this.#emitAccounts()
  }

  // ─────────── sair ───────────

  /** Sai da conta: avisa o site (melhor esforço), apaga o token deste computador. */
  async signOut() {
    await this.#ready()
    const s = this.session
    if (s) {
      try {
        await this.#call('POST', '/api/dispositivo/sair', { body: {}, expect: [200, 204], timeoutMs: LOGOUT_TIMEOUT_MS, token: s.token })
      } catch {
        // sem internet ou sessão já revogada: sai deste computador de qualquer jeito
      }
    }
    await this.#clear(null)
    return this.status()
  }

  async #clear(notice) {
    const had = Boolean(this.session)
    this.session = null
    this.tokens.clear()
    this.lastError = null
    this.notice = notice
    this.#stopTimer()
    if (this.login?.estado === 'pronto') this.login = null
    await this.arquivo.apagar().catch(err => this.log('não consegui apagar a sessão da conta:', err?.message))
    if (had) this.#emitAccounts()
    this.#emitStatus()
  }

  /** O site disse 401 para o token deste computador: sai e avisa uma vez. */
  async #revoked() {
    this.signingOut ??= (async () => {
      if (!this.session) return
      await this.#clear(MSG_SIGNED_OUT)
      this.emit('signedOut', { reason: 'revoked', message: MSG_SIGNED_OUT })
    })().finally(() => {
      this.signingOut = null
    })
    return this.signingOut
  }

  // ─────────── lista de Drives ───────────

  /**
   * Atualiza a lista de Drives da conta. `full` também relê os dados da pessoa (GET /api/eu).
   * Nunca lança por falta de internet: guarda o motivo em status().erro e mantém a última lista.
   */
  async refresh({ full = false } = {}) {
    await this.#ready()
    if (!this.session) return this.status()
    if (this.refreshing) {
      await this.refreshing
      return this.status()
    }
    this.refreshing = this.#doRefresh(full).finally(() => {
      this.refreshing = null
    })
    await this.refreshing
    return this.status()
  }

  async #doRefresh(full) {
    const s = this.session
    const token = s.token
    let res
    try {
      res = await this.#call('GET', full || !s.usuario ? '/api/eu' : '/api/drive/contas', { token })
    } catch (err) {
      if (this.session !== s) return
      if (this.#isRevoked(err, token)) return this.#revoked()
      const t = transient(err)
      this.lastError = t ? t.message.replace(' Tentando de novo…', '.') : siteMessage(err, 'Não consegui atualizar a lista de Drives.')
      this.#emitStatus()
      return
    }
    if (this.session !== s) return
    const list = Array.isArray(res.data?.contas) ? res.data.contas.map(normalizeConta).filter(Boolean) : null
    if (!list) {
      this.lastError = 'O site respondeu de um jeito inesperado.'
      this.#emitStatus()
      return
    }
    if (res.data?.usuario) s.usuario = normalizeUsuario(res.data.usuario)
    const before = JSON.stringify(s.contas)
    s.contas = list
    s.atualizadoEm = Date.now()
    this.lastError = null
    for (const id of [...this.tokens.keys()]) {
      const c = list.find(x => x.id === id)
      if (!c || c.estado !== 'ok') this.tokens.delete(id)
    }
    await this.#save().catch(err => this.log('não consegui guardar a lista de Drives:', err?.message))
    this.#emitStatus()
    if (JSON.stringify(list) !== before) this.#emitAccounts()
  }

  async #setEstado(contaId, estado) {
    const c = this.session?.contas.find(x => x.id === contaId)
    if (!c || c.estado === estado) return
    c.estado = estado
    if (estado !== 'ok') this.tokens.delete(contaId)
    await this.#save().catch(() => {})
    this.#emitAccounts()
    this.#emitStatus()
  }

  // ─────────── tokens ───────────

  /**
   * Access token do Google para a conta (id do site, sem `nuvem:`). Cache até faltar ~5 min para vencer.
   * `forceRefresh` (o Google recusou o token) pede `renovar: true`; se o cache já tem outro token que não o
   * `rejectedToken`, devolve esse. Erros: 'reauth' (reconectar no site / sessão encerrada), 'retry' (rede, site fora).
   */
  async getAccessToken(contaId, { forceRefresh = false, rejectedToken = null } = {}) {
    await this.#ready()
    const id = String(contaId)
    if (!this.session) throw new SobeDesceError('reauth', MSG_NOT_SIGNED_IN, { reason: 'cloudSignedOut' })
    for (let round = 0; ; round++) {
      const cached = this.tokens.get(id)
      const now = Date.now()
      const fresh = Boolean(cached && (cached.expiresAt - now > TOKEN_MARGIN_MS || (now - cached.at < MIN_REUSE_MS && cached.expiresAt > now)))
      if (fresh && !forceRefresh) return cached.token
      if (fresh && rejectedToken && cached.token !== rejectedToken) return cached.token
      const running = this.inflight.get(id)
      if (!running || round >= 3) break
      // Uma requisição por vez por conta: espera a que está em andamento e decide de novo.
      const token = await running.catch(() => null)
      if (token && (!forceRefresh || (rejectedToken && token !== rejectedToken))) return token
    }
    const p = this.#fetchToken(id, forceRefresh).finally(() => {
      if (this.inflight.get(id) === p) this.inflight.delete(id)
    })
    this.inflight.set(id, p)
    return p
  }

  async #fetchToken(id, renovar) {
    let last = null
    for (let attempt = 0; attempt < TOKEN_TRIES; attempt++) {
      if (attempt > 0) await sleep(backoffDelay(attempt - 1, { base: this.retryBaseMs, max: 4000 }))
      const s = this.session
      if (!s) throw new SobeDesceError('reauth', MSG_SIGNED_OUT, { reason: 'cloudSignedOut' })
      const t0 = Date.now()
      let res
      try {
        res = await this.#call('POST', '/api/drive/token', { body: renovar ? { conta: id, renovar: true } : { conta: id }, token: s.token })
      } catch (err) {
        if (isAbortError(err)) throw err
        if (this.#isRevoked(err, s.token)) {
          await this.#revoked()
          throw new SobeDesceError('reauth', MSG_SIGNED_OUT, { reason: 'cloudSignedOut', status: 401 })
        }
        if (err instanceof HttpError && err.status === 401) throw new SobeDesceError('reauth', MSG_SIGNED_OUT, { reason: 'cloudSignedOut', status: 401 })
        if (err instanceof HttpError && err.status === 409) {
          await this.#setEstado(id, 'reconectar')
          throw new SobeDesceError('reauth', MSG_RECONNECT, { reason: 'cloudReconnect', status: 409 })
        }
        if (err instanceof HttpError && err.status === 404) {
          this.refresh().catch(() => {})
          throw new SobeDesceError('reauth', MSG_GONE, { reason: 'cloudAccountNotFound', status: 404 })
        }
        const t = transient(err)
        if (!t) throw new SobeDesceError('fatal', siteMessage(err, 'A conta SOBEDESCE recusou o pedido.'), { reason: err?.body?.erro || null, status: err?.status ?? null })
        last = t
        continue
      }
      const token = res.data?.accessToken
      if (typeof token !== 'string' || !token) {
        last = new SobeDesceError('retry', MSG_SERVER, { reason: 'cloudNoToken' })
        continue
      }
      const exp = Number(res.data?.expiraEm)
      const expiresAt = Number.isFinite(exp) && exp > 0 ? exp : t0 + 50 * 60_000
      if (this.session === s) {
        this.tokens.set(id, { token, expiresAt, at: Date.now() })
        const c = s.contas.find(x => x.id === id)
        if (c?.estado === 'reconectar') await this.#setEstado(id, 'ok')
      }
      return token
    }
    throw last
  }
}
