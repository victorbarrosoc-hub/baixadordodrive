// Contas Google: login OAuth (loopback + PKCE), tokens em cache e renovação.
// Tokens nunca vão para logs nem para a UI. Só o refresh token fica no disco (accounts.json, modo 0600);
// o access token vive só na memória.
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import { dataPaths, endpoints, DRIVE_SCOPE } from '../config.js'
import { ArquivoSecreto } from '../util/segredos.js'
import { requestJSON, HttpError } from '../net/http.js'
import { backoffDelay, sleep } from '../util/backoff.js'
import { classifyError, SobeDesceError } from './errors.js'
import { CLOUD_PREFIX } from './cloud-auth.js'

const CLIENT_SUFFIX = '.apps.googleusercontent.com'
const LOGIN_TTL_MS = 15 * 60_000 // o verifier de um login começado vale 15 min
const MAX_PENDING_LOGINS = 20 // alguém clicando "conectar" sem parar não enche a memória
const REFRESH_MARGIN_MS = 120_000 // renova se faltar menos que isso (uploads longos não pegam token vencendo)
const TOKEN_TRIES = 3
const TOKEN_RETRY_BASE_MS = 500
const TOKEN_TIMEOUT_MS = 30_000 // endpoint de token pendurado não pode travar o app por minutos
const REVOKE_TIMEOUT_MS = 10_000
const DEFAULT_TTL_SEC = 3600
const DAY_MS = 86_400_000
const ABOUT_USER_FIELDS = 'user(displayName,emailAddress,permissionId,photoLink)'

function badInput(message) {
  const err = new Error(message)
  err.status = 400
  return err
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64url')
}

/** Aceita o JSON do Console (objeto ou texto) ou { clientId, clientSecret }. Lança Error PT-BR. */
export function parseClientCredentials(input) {
  let data = input
  if (typeof data === 'string') {
    const text = data.trim()
    if (!text) throw badInput('Cole o JSON baixado do Google Cloud ou informe o Client ID e o segredo.')
    try {
      data = JSON.parse(text)
    } catch {
      throw badInput('Não consegui ler esse JSON. Cole o conteúdo inteiro do arquivo baixado do Google Cloud.')
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw badInput('Cole o JSON baixado do Google Cloud ou informe o Client ID e o segredo.')
  }
  if (!data.installed && data.web) {
    throw badInput('Este é um cliente do tipo Aplicativo Web; crie um do tipo "App para computador".')
  }
  const src = data.installed && typeof data.installed === 'object' ? data.installed : data
  const clientId = String(src.client_id ?? src.clientId ?? '').trim()
  const clientSecret = String(src.client_secret ?? src.clientSecret ?? '').trim()
  if (!clientId) throw badInput('Falta o Client ID.')
  if (!clientId.endsWith(CLIENT_SUFFIX) || clientId.length <= CLIENT_SUFFIX.length || /\s/.test(clientId)) {
    throw badInput('Esse Client ID não parece certo: ele precisa terminar em .apps.googleusercontent.com. Confira se copiou inteiro.')
  }
  if (!clientSecret) {
    throw badInput('Falta o segredo do cliente (client secret). O Google só mostra o segredo ao criar o cliente: se o JSON veio sem ele, crie um novo segredo no Google Cloud e baixe o JSON de novo.')
  }
  return { clientId, clientSecret }
}

function noClientError() {
  return new SobeDesceError('fatal', 'Configure a chave do Google (Client ID) antes de conectar uma conta.', { reason: 'noClientCredentials' })
}

/** Erro devolvido pelo Google no retorno do login (?error=...). */
function callbackError(code) {
  const c = String(code)
  if (c === 'access_denied') {
    return new SobeDesceError('fatal', 'O login foi cancelado ou o Google negou o acesso. Se o app está em modo Teste, adicione seu e-mail em Público-alvo → Usuários de teste e tente de novo.', { reason: c })
  }
  const info = classifyError(new HttpError(400, { body: { error: c } }))
  const known = info.message !== c
  return new SobeDesceError('fatal', known ? info.message : `O Google não concluiu o login (${c}). Tente conectar de novo.`, { reason: c })
}

/** Falha ao trocar o código por tokens → mensagem para a pessoa. */
function exchangeError(err) {
  const info = classifyError(err)
  if (info.kind === 'abort') return err
  const opts = { reason: info.reason, status: info.status }
  if (info.reason === 'invalid_grant') return new SobeDesceError('fatal', 'O código de login expirou ou já foi usado. Tente conectar de novo.', opts)
  if (info.reason === 'redirect_uri_mismatch') return new SobeDesceError('fatal', 'O endereço de retorno do login não bateu. Tente conectar de novo.', opts)
  if (info.reason === 'invalid_request') return new SobeDesceError('fatal', 'O Google recusou o pedido de login. Confira a chave (Client ID e segredo) em Ajustes.', opts)
  if (info.kind === 'retry') return new SobeDesceError('retry', 'Não consegui falar com o Google para concluir o login. Confira a internet e tente de novo.', opts)
  return new SobeDesceError(info.kind === 'reauth' ? 'fatal' : info.kind, info.message, opts)
}

function normalizeAccount(raw) {
  return {
    id: String(raw.id),
    email: raw.email ?? null,
    name: raw.name ?? null,
    photoUrl: raw.photoUrl ?? null,
    refreshToken: raw.refreshToken,
    addedAt: Number(raw.addedAt) || Date.now(),
    consentedAt: Number(raw.consentedAt) || Number(raw.addedAt) || null,
    status: raw.status === 'reauth' ? 'reauth' : 'ok',
    reauthAt: Number(raw.reauthAt) || null,
    reauthReason: raw.reauthReason ?? null,
    clientId: raw.clientId ?? null, // cliente OAuth que emitiu o refresh token
  }
}

/** Id de conta que vem da conta SOBEDESCE ('nuvem:<id>')? */
export function isCloudAccountId(id) {
  return typeof id === 'string' && id.startsWith(CLOUD_PREFIX)
}

export class AuthManager extends EventEmitter {
  /**
   * @param {{ paths?: ReturnType<typeof dataPaths>, cloud?: import('./cloud-auth.js').CloudAuth|null }} [opts]
   *   `cloud`: contas da conta SOBEDESCE. Aparecem junto das locais (ids 'nuvem:<id>', source 'nuvem') e os
   *   tokens delas vêm do site. Sem `cloud`, só as contas conectadas neste computador.
   *   `segredos`: guarda do sistema (src/util/segredos.js; no app de desktop, o safeStorage do Electron). Com ela,
   *   accounts.json e credentials.json viram accounts.cifrado.json e credentials.cifrado.json. Sem ela, JSON 0600.
   */
  constructor({ paths = dataPaths(), cloud = null, segredos = null } = {}) {
    super()
    this.paths = paths
    this.cloud = cloud
    this.arquivoContas = new ArquivoSecreto(paths.accounts, { guarda: segredos })
    this.arquivoCliente = new ArquivoSecreto(paths.credentials, { guarda: segredos })
    this.protecao = 'arquivo'
    cloud?.on('accounts', () => this.emit('accounts', this.listAccounts()))
    this.client = null // { clientId, clientSecret }
    this.accounts = [] // com refreshToken: nunca sai daqui sem passar por publicAccount()
    this.tokens = new Map() // accountId -> { token, expiresAt }
    this.refreshing = new Map() // accountId -> Promise<string> (renovação única por conta)
    this.pending = new Map() // state -> { verifier, redirectUri, createdAt }
    this.loaded = false
    this.loading = null
  }

  async init() {
    if (this.loaded) return
    this.loading ??= (async () => {
      const cred = await this.arquivoCliente.ler(null)
      try {
        this.client = cred ? parseClientCredentials(cred) : null
      } catch {
        this.client = null
      }
      const raw = await this.arquivoContas.ler(null)
      const list = Array.isArray(raw?.accounts) ? raw.accounts : []
      this.accounts = list.filter(a => a && a.id != null && typeof a.refreshToken === 'string' && a.refreshToken && !isCloudAccountId(String(a.id))).map(normalizeAccount)
      // Onde os segredos ficam (para Ajustes → Avançado): 'sistema' (Keychain/DPAPI) ou 'arquivo' (JSON 0600).
      this.protecao = await this.arquivoContas.protecao()
      await this.cloud?.init()
      this.loaded = true
    })().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  async #ready() {
    if (!this.loaded) await this.init()
  }

  // ─────────── cliente OAuth ───────────

  hasClientCredentials() {
    return Boolean(this.client)
  }

  getClientInfo() {
    const id = this.client?.clientId
    return { configured: Boolean(id), clientIdHint: id ? `${id.slice(0, 4)}…${CLIENT_SUFFIX.slice(1)}` : null }
  }

  async setClientCredentials(input) {
    await this.#ready()
    const next = parseClientCredentials(input)
    const previous = this.client?.clientId ?? null
    await this.arquivoCliente.gravar(next)
    this.client = next
    // Refresh token só vale com o cliente que o emitiu: com outra chave, a conta precisa reconectar.
    // Se a pessoa voltar para a chave antiga, as contas dela voltam a funcionar.
    let touched = false
    const now = Date.now()
    for (const acc of this.accounts) {
      const issuer = acc.clientId ?? previous
      if (issuer && issuer !== next.clientId) {
        if (acc.status === 'reauth' && acc.reauthReason === 'clientChanged') continue
        acc.clientId = issuer
        acc.status = 'reauth'
        acc.reauthAt = now
        acc.reauthReason = 'clientChanged'
        this.tokens.delete(acc.id)
        touched = true
      } else if (acc.status === 'reauth' && acc.reauthReason === 'clientChanged') {
        acc.status = 'ok'
        acc.reauthAt = null
        acc.reauthReason = null
        touched = true
      }
    }
    if (touched) {
      await this.#save()
      this.emit('accounts', this.listAccounts())
    }
    return this.getClientInfo()
  }

  // ─────────── contas ───────────

  #find(id) {
    return this.accounts.find(a => a.id === String(id)) || null
  }

  #publicAccount(a) {
    return { id: a.id, email: a.email, name: a.name, photoUrl: a.photoUrl, addedAt: a.addedAt, consentedAt: a.consentedAt, status: a.status, source: 'local' }
  }

  /** Contas conectadas neste computador e, depois, as da conta SOBEDESCE (se houver). Nunca expõe tokens. */
  listAccounts() {
    const local = this.accounts.map(a => this.#publicAccount(a))
    return this.cloud ? local.concat(this.cloud.listAccounts()) : local
  }

  /** Para o relógio da conta SOBEDESCE (ao fechar o app). */
  close() {
    this.cloud?.close()
  }

  async #save() {
    const data = {
      accounts: this.accounts.map(a => ({
        id: a.id,
        email: a.email,
        name: a.name,
        photoUrl: a.photoUrl,
        refreshToken: a.refreshToken,
        addedAt: a.addedAt,
        consentedAt: a.consentedAt,
        status: a.status,
        reauthAt: a.reauthAt,
        reauthReason: a.reauthReason,
        clientId: a.clientId,
      })),
    }
    await this.arquivoContas.gravar(data)
  }

  // ─────────── login ───────────

  #prunePending() {
    const now = Date.now()
    for (const [state, p] of this.pending) if (now - p.createdAt > LOGIN_TTL_MS) this.pending.delete(state)
    while (this.pending.size >= MAX_PENDING_LOGINS) this.pending.delete(this.pending.keys().next().value)
  }

  /** Monta a URL de consentimento (PKCE S256). Guarda o verifier pelo `state` por 15 min. */
  beginLogin(redirectUri) {
    if (!this.client) throw noClientError()
    if (!redirectUri) throw badInput('Falta o endereço de retorno do login.')
    this.#prunePending()
    const verifier = base64url(crypto.randomBytes(64))
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
    const state = base64url(crypto.randomBytes(24))
    this.pending.set(state, { verifier, redirectUri: String(redirectUri), createdAt: Date.now() })
    const url = new URL(endpoints().oauthAuth)
    const p = url.searchParams
    p.set('client_id', this.client.clientId)
    p.set('redirect_uri', String(redirectUri))
    p.set('response_type', 'code')
    p.set('scope', DRIVE_SCOPE)
    p.set('code_challenge', challenge)
    p.set('code_challenge_method', 'S256')
    p.set('state', state)
    p.set('access_type', 'offline')
    p.set('prompt', 'consent')
    return { url: url.toString(), state }
  }

  /** Conclui o login com o que voltou no callback. Devolve a conta pública (sem tokens). */
  async completeLogin({ code, state, error } = {}) {
    await this.#ready()
    const now = Date.now()
    const pending = state ? this.pending.get(String(state)) : null
    if (!pending || now - pending.createdAt > LOGIN_TTL_MS) {
      if (state) this.pending.delete(String(state))
      throw new SobeDesceError('fatal', 'Este login expirou ou não foi iniciado por este app. Tente conectar de novo.', { reason: 'stateMismatch' })
    }
    this.pending.delete(String(state)) // uso único, dê certo ou não
    if (error) throw callbackError(error)
    if (!code) throw new SobeDesceError('fatal', 'O Google não devolveu o código de login. Tente conectar de novo.', { reason: 'missingCode' })
    if (!this.client) throw noClientError()

    const t0 = Date.now()
    let tok
    try {
      // O Google exige na troca o mesmo redirect_uri do consentimento: vale o guardado, não o que veio no callback.
      tok = await this.#tokenRequest({ grant_type: 'authorization_code', code: String(code), redirect_uri: pending.redirectUri, code_verifier: pending.verifier })
    } catch (err) {
      throw exchangeError(err)
    }
    // Consentimento granular: a pessoa pode desmarcar a caixa do Drive e mesmo assim o Google devolve tokens.
    const granted = String(tok.scope || '').split(/\s+/)
    if (!granted.includes(DRIVE_SCOPE)) {
      throw new SobeDesceError('fatal', 'Marque a permissão do Google Drive na tela do Google ("Ver, editar, criar e excluir todos os seus arquivos do Google Drive") e conecte de novo.', { reason: 'scopeNotGranted' })
    }
    if (!tok.refresh_token) {
      throw new SobeDesceError('fatal', 'O Google não liberou o acesso contínuo (refresh token). Remova o SOBEDESCE em myaccount.google.com/permissions e conecte de novo.', { reason: 'noRefreshToken' })
    }
    if (!tok.access_token) throw new SobeDesceError('fatal', 'O Google não devolveu um token de acesso. Tente conectar de novo.', { reason: 'noAccessToken' })

    const user = await this.#fetchUser(tok.access_token)
    const id = user.permissionId != null ? String(user.permissionId) : ''
    if (!id) throw new SobeDesceError('fatal', 'O Google não informou qual é a conta. Tente conectar de novo.', { reason: 'noPermissionId' })

    const at = Date.now()
    const fields = {
      email: user.emailAddress ?? null,
      name: user.displayName ?? user.emailAddress ?? null,
      photoUrl: user.photoLink ?? null,
      refreshToken: tok.refresh_token,
      consentedAt: at,
      status: 'ok',
      reauthAt: null,
      reauthReason: null,
      clientId: this.client.clientId,
    }
    let account = this.#find(id)
    if (account) Object.assign(account, fields)
    else {
      account = normalizeAccount({ id, ...fields, addedAt: at })
      this.accounts.push(account)
    }
    this.tokens.set(id, { token: tok.access_token, expiresAt: t0 + ttlMs(tok.expires_in) })
    await this.#save()
    this.emit('accounts', this.listAccounts())
    return this.#publicAccount(account)
  }

  async #fetchUser(accessToken) {
    const url = new URL(`${endpoints().driveApi.replace(/\/+$/, '')}/about`)
    url.searchParams.set('fields', ABOUT_USER_FIELDS)
    for (let attempt = 0; ; attempt++) {
      try {
        const about = await requestJSON(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) })
        return about?.user || {}
      } catch (raw) {
        const err = timeoutToNetwork(raw)
        const info = classifyError(err)
        if (info.kind === 'retry' && attempt + 1 < TOKEN_TRIES) {
          await sleep(backoffDelay(attempt, { base: TOKEN_RETRY_BASE_MS }))
          continue
        }
        if (info.kind === 'auth' || info.kind === 'reauth') {
          throw new SobeDesceError('fatal', 'O Google recusou o acesso recém-liberado. Tente conectar de novo.', { reason: info.reason, status: info.status })
        }
        throw new SobeDesceError(info.kind, info.message, { reason: info.reason, status: info.status })
      }
    }
  }

  // ─────────── tokens ───────────

  /** POST no endpoint de token, SEMPRE com client_secret. Rede/5xx: até 3 tentativas com recuo. */
  async #tokenRequest(params) {
    if (!this.client) throw noClientError()
    const body = new URLSearchParams({ ...params, client_id: this.client.clientId, client_secret: this.client.clientSecret })
    let last = null
    for (let attempt = 0; attempt < TOKEN_TRIES; attempt++) {
      if (attempt > 0) await sleep(backoffDelay(attempt - 1, { base: TOKEN_RETRY_BASE_MS }))
      try {
        return await requestJSON(endpoints().oauthToken, { method: 'POST', body, expect: [200], signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) })
      } catch (raw) {
        const err = timeoutToNetwork(raw)
        if (classifyError(err).kind !== 'retry') throw err
        last = err
      }
    }
    throw last
  }

  /**
   * Access token válido da conta. Cache em memória; renova se faltar < 120 s.
   * Renovações simultâneas da mesma conta compartilham a mesma requisição.
   * `rejectedToken` (opcional): token que levou 401 — se o cache já tem outro, devolve esse sem renovar de novo.
   */
  async getAccessToken(accountId, { forceRefresh = false, rejectedToken = null } = {}) {
    await this.#ready()
    if (isCloudAccountId(String(accountId))) {
      if (!this.cloud) throw new SobeDesceError('reauth', 'Entre na conta SOBEDESCE para usar este Drive.', { reason: 'cloudSignedOut' })
      return this.cloud.getAccessToken(String(accountId).slice(CLOUD_PREFIX.length), { forceRefresh, rejectedToken })
    }
    const account = this.#find(accountId)
    if (!account) throw new SobeDesceError('reauth', 'Esta conta não está mais conectada. Conecte a conta de novo.', { reason: 'accountNotFound' })
    if (account.status === 'reauth') throw this.#reauthError(account)
    const id = account.id
    const cached = this.tokens.get(id)
    const fresh = Boolean(cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS)
    if (fresh && !forceRefresh) return cached.token
    if (fresh && rejectedToken && cached.token !== rejectedToken) return cached.token
    const inflight = this.refreshing.get(id)
    if (inflight) return inflight
    const p = this.#refresh(account).finally(() => {
      if (this.refreshing.get(id) === p) this.refreshing.delete(id)
    })
    this.refreshing.set(id, p)
    return p
  }

  async #refresh(account) {
    const id = account.id
    const used = account.refreshToken
    const t0 = Date.now()
    let res
    try {
      res = await this.#tokenRequest({ grant_type: 'refresh_token', refresh_token: used })
    } catch (err) {
      if (classifyError(err).kind !== 'reauth') throw err
      const current = this.#find(id)
      // Reconectou enquanto renovávamos: o token antigo morreu, mas existe um novo.
      if (current && current.status === 'ok' && current.refreshToken !== used) return this.#refresh(current)
      if (current && current.status === 'ok' && current.refreshToken === used) await this.#markReauth(current, 'invalidGrant')
      throw this.#reauthError(current ?? account)
    }
    if (!res?.access_token) throw new SobeDesceError('retry', 'O Google não devolveu um token de acesso. Tentando de novo…', { reason: 'noAccessToken' })
    const current = this.#find(id)
    if (current && current.refreshToken === used && current.status === 'ok') {
      this.tokens.set(id, { token: res.access_token, expiresAt: t0 + ttlMs(res.expires_in) })
      if (res.refresh_token && res.refresh_token !== used) {
        current.refreshToken = res.refresh_token
        // Falha de disco aqui não pode derrubar a transferência; o dado fica na memória e vai na próxima gravação.
        await this.#save().catch(() => {})
      }
    }
    return res.access_token
  }

  async #markReauth(account, reason) {
    account.status = 'reauth'
    account.reauthAt = Date.now()
    account.reauthReason = reason
    this.tokens.delete(account.id)
    await this.#save().catch(() => {})
    this.emit('accounts', this.listAccounts())
  }

  #reauthError(account) {
    const reason = account.reauthReason === 'clientChanged' ? 'clientChanged' : 'invalid_grant'
    return new SobeDesceError('reauth', this.#reauthMessage(account), { reason })
  }

  #reauthMessage(account) {
    const who = account.email ? `à conta ${account.email}` : 'à conta'
    if (account.reauthReason === 'clientChanged') return `A chave do Google mudou e o acesso ${who} precisa ser renovado. Conecte a conta de novo.`
    const at = account.reauthAt ?? Date.now()
    const days = account.consentedAt ? (at - account.consentedAt) / DAY_MS : null
    if (days != null && days >= 6 && days <= 8) {
      return `O acesso ${who} expirou 7 dias depois de conectar. Isso acontece quando o app está em modo Teste no Google Cloud: publique o app em Público-alvo → Publicar app, ou reconecte toda semana. Conecte a conta de novo para continuar.`
    }
    return `O acesso ${who} expirou ou foi revogado. Conecte a conta de novo.`
  }

  /** Revoga (melhor esforço) e apaga a conta. Devolve a lista atualizada. */
  async removeAccount(accountId) {
    await this.#ready()
    if (isCloudAccountId(String(accountId))) {
      throw badInput('Este Drive vem da sua conta SOBEDESCE. Para tirar, use sobedesce.com/conta.')
    }
    const account = this.#find(accountId)
    if (!account) return this.listAccounts()
    this.accounts = this.accounts.filter(a => a !== account)
    this.tokens.delete(account.id)
    await this.#save()
    this.emit('accounts', this.listAccounts())
    await this.#revoke(account.refreshToken)
    return this.listAccounts()
  }

  async #revoke(token) {
    if (!token) return
    try {
      // Token no corpo, nunca na URL (URLs acabam em logs).
      await requestJSON(endpoints().oauthRevoke, { method: 'POST', body: new URLSearchParams({ token }), expect: [200], signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS) })
    } catch {
      // melhor esforço: a conta sai do app de qualquer jeito
    }
  }
}

function ttlMs(expiresIn) {
  const n = Number(expiresIn)
  return (Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_SEC) * 1000
}

/** Timeout do AbortSignal.timeout vira erro de rede (classifyError trata como 'retry'). */
function timeoutToNetwork(err) {
  if (err?.name !== 'TimeoutError') return err
  const e = new Error('O Google demorou demais para responder.')
  e.code = 'ETIMEDOUT'
  return e
}
