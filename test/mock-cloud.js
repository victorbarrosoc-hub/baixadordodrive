// Site de contas SOBEDESCE falso (docs/CONTAS.md §5), para os testes e o modo demo.
// Só o que o app de computador usa: fluxo de dispositivo, /api/eu, /api/drive/contas, /api/drive/token e sair.
// Os access tokens saem do Google Drive falso (test/mock-drive.js), então funcionam de verdade nele.
import http from 'node:http'
import crypto from 'node:crypto'

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // sem letras ambíguas (como o site)
const CODE_TTL_MS = 10 * 60_000

function code() {
  let s = ''
  for (let i = 0; i < 8; i++) s += LETTERS[crypto.randomInt(LETTERS.length)]
  return `${s.slice(0, 4)}-${s.slice(4)}`
}

const sha = s => crypto.createHash('sha256').update(s).digest('hex')

/**
 * @param {{ drive?: object, user?: object, contas?: object[], intervalo?: number, tokenTtlMs?: number, autoApprove?: boolean }} [opts]
 *   `drive`: MockDrive que emite os access tokens (sem ele, tokens de mentira).
 *   `autoApprove`: abrir /dispositivo?codigo=… no navegador já aprova (útil no demo).
 */
export async function startMockCloud(opts = {}) {
  const m = new MockCloud(opts)
  await m.listen()
  return m
}

class MockCloud {
  constructor({ drive = null, user, contas, intervalo = 3, tokenTtlMs = 60 * 60_000, autoApprove = false } = {}) {
    this.drive = drive
    this.user = { id: 'u_ana', email: 'ana@sobedesce.app', nome: 'Ana Montadora', ...(user || {}) }
    this.contas = (contas || [
      { id: 'g1', email: 'ana.montadora@gmail.com', nome: 'Ana Montadora', fotoUrl: null, estado: 'ok' },
      { id: 'g2', email: 'producao@estudio.com', nome: 'Produção', fotoUrl: null, estado: 'ok' },
    ]).map(c => ({ ...c }))
    this.intervalo = intervalo
    this.tokenTtlMs = tokenTtlMs
    this.autoApprove = autoApprove
    this.codes = new Map() // segredoHash -> { codigo, nome, plataforma, aprovado, usado, expiraEm }
    this.sessions = new Map() // tokenHash -> { nome, plataforma, revogada }
    this.issued = new Map() // contaId -> { accessToken, expiraEm }
    this.down = false // true = derruba toda conexão (rede fora)
    this.stats = { iniciar: 0, aguardar: 0, eu: 0, contas: 0, token: 0, renovar: 0, sair: 0, unauthorized: 0 }
    this.server = null
    this.url = null
  }

  async listen() {
    this.server = http.createServer((req, res) => this.#handle(req, res).catch(err => this.#send(res, 500, { erro: 'interno', mensagem: String(err?.message || err) })))
    await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${this.server.address().port}`
  }

  async close() {
    await new Promise(resolve => {
      this.server.close(() => resolve())
      this.server.closeAllConnections?.()
    })
  }

  // ─────────── atalhos para os testes ───────────

  /** Aprova o código (como se a pessoa clicasse "Liberar" em /dispositivo). */
  approve(codigo) {
    for (const c of this.codes.values()) if (c.codigo === codigo) c.aprovado = true
  }

  /** Faz o código vencer. */
  expire(codigo) {
    for (const c of this.codes.values()) if (c.codigo === codigo) c.expiraEm = Date.now() - 1
  }

  pendingCodes() {
    return [...this.codes.values()].filter(c => !c.usado && !c.aprovado).map(c => c.codigo)
  }

  /** Desconecta todos os computadores (sessões revogadas → 401). */
  revokeSessions() {
    for (const s of this.sessions.values()) s.revogada = true
  }

  activeSessions() {
    return [...this.sessions.values()].filter(s => !s.revogada)
  }

  setEstado(contaId, estado) {
    const c = this.contas.find(x => x.id === contaId)
    if (c) c.estado = estado
    if (estado !== 'ok') this.issued.delete(contaId)
  }

  // ─────────── HTTP ───────────

  #send(res, status, body) {
    const data = body === undefined ? '' : JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data) })
    res.end(data)
  }

  async #body(req) {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text) return {}
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  #session(req) {
    const m = /^Bearer\s+(sdd_\S+)$/i.exec(req.headers.authorization || '')
    const s = m && this.sessions.get(sha(m[1]))
    return s && !s.revogada ? s : null
  }

  #conta(c) {
    return { id: c.id, email: c.email, nome: c.nome, fotoUrl: c.fotoUrl ?? null, estado: c.estado }
  }

  async #handle(req, res) {
    if (this.down) return req.socket.destroy()
    const url = new URL(req.url, this.url)
    const p = url.pathname
    const method = req.method

    if (method === 'GET' && p === '/dispositivo') {
      const codigo = url.searchParams.get('codigo') || ''
      if (this.autoApprove) this.approve(codigo)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(`<!doctype html><meta charset="utf-8"><title>Liberar computador</title><h1>${this.autoApprove ? 'Computador liberado' : 'Liberar computador'}</h1><p>${codigo.replace(/[^A-Z0-9-]/g, '')}</p>`)
    }

    if (method === 'POST' && p === '/api/dispositivo/iniciar') {
      this.stats.iniciar++
      const body = await this.#body(req)
      const segredo = crypto.randomBytes(24).toString('base64url')
      const codigo = code()
      const expiraEm = Date.now() + CODE_TTL_MS
      this.codes.set(sha(segredo), { codigo, nome: String(body?.nome || ''), plataforma: body?.plataforma ?? null, aprovado: false, usado: false, expiraEm })
      return this.#send(res, 200, { codigo, segredo, url: `${this.url}/dispositivo?codigo=${codigo}`, intervalo: this.intervalo, expiraEm })
    }

    if (method === 'POST' && p === '/api/dispositivo/aguardar') {
      this.stats.aguardar++
      const body = await this.#body(req)
      const c = body?.segredo ? this.codes.get(sha(String(body.segredo))) : null
      if (!c || c.usado || c.expiraEm < Date.now()) return this.#send(res, 410, { erro: 'expirado', mensagem: 'O código venceu.' })
      if (!c.aprovado) return this.#send(res, 202, { estado: 'pendente' })
      c.usado = true
      const token = `sdd_${crypto.randomBytes(32).toString('base64url')}`
      this.sessions.set(sha(token), { nome: c.nome, plataforma: c.plataforma, revogada: false })
      return this.#send(res, 200, { estado: 'pronto', token, usuario: { ...this.user } })
    }

    const session = this.#session(req)
    if (!session) {
      this.stats.unauthorized++
      return this.#send(res, 401, { erro: 'sem_sessao', mensagem: 'Entre na sua conta.' })
    }

    if (method === 'GET' && p === '/api/eu') {
      this.stats.eu++
      return this.#send(res, 200, { usuario: { ...this.user }, contas: this.contas.map(c => this.#conta(c)) })
    }

    if (method === 'GET' && p === '/api/drive/contas') {
      this.stats.contas++
      return this.#send(res, 200, { contas: this.contas.map(c => this.#conta(c)) })
    }

    if (method === 'POST' && p === '/api/drive/token') {
      this.stats.token++
      const body = await this.#body(req)
      const c = this.contas.find(x => x.id === String(body?.conta ?? ''))
      if (!c) return this.#send(res, 404, { erro: 'nao_encontrada', mensagem: 'Drive não encontrado.' })
      if (c.estado === 'reconectar') return this.#send(res, 409, { erro: 'reconectar', mensagem: 'Reconecte este Drive.' })
      if (body.renovar) this.stats.renovar++
      let t = this.issued.get(c.id)
      if (!t || body.renovar || t.expiraEm - Date.now() < 5 * 60_000) {
        const accessToken = this.drive ? this.drive.issueTokens().accessToken : `ya29.nuvem-${crypto.randomBytes(12).toString('hex')}`
        t = { accessToken, expiraEm: Date.now() + this.tokenTtlMs }
        this.issued.set(c.id, t)
      }
      return this.#send(res, 200, { accessToken: t.accessToken, expiraEm: t.expiraEm, email: c.email })
    }

    if (method === 'POST' && p === '/api/dispositivo/sair') {
      this.stats.sair++
      session.revogada = true
      res.writeHead(204, { 'cache-control': 'no-store' })
      return res.end()
    }

    return this.#send(res, 404, { erro: 'nao_encontrada', mensagem: 'Rota não encontrada.' })
  }
}
