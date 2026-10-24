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
  constructor({ drive = null, user, contas, intervalo = 3, tokenTtlMs = 60 * 60_000, autoApprove = false, referencias = true } = {}) {
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
    this.stats = { iniciar: 0, aguardar: 0, eu: 0, contas: 0, token: 0, renovar: 0, sair: 0, unauthorized: 0, fila: 0, pegar: 0, colecoes: 0 }
    // Referências (docs/REFERENCIAS.md): false = a conta não tem o recurso (403 motivo 'plano').
    this.referenciasPermitidas = referencias
    this.colecoes = [] // { id, nome, contaGoogleId, driveFolderId, link, criadoEm }
    this.fila = [] // { id, url, nota, status, erro, driveFileId, colecaoId, dispositivo, criadoEm }
    this.raizes = new Map() // contaGoogleId -> id da pasta "SOBEDESCE Referências" no Drive falso
    // Acompanhar pelo celular (docs/CONTAS.md §9): os retratos que o computador mandou.
    this.andamento = [] // { metodo, corpo, nome }
    this.builds = [] // cabeçalho x-sobedesce-build de cada pedido
    this.uso = [] // corpos de POST /api/dispositivos/uso
    this.seq = 0
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

  // ─────────── Referências ───────────

  #raiz(contaGoogleId) {
    let id = this.raizes.get(contaGoogleId)
    if (!id) {
      id = this.drive ? this.drive.addFolder('SOBEDESCE Referências', 'root').id : `raiz_${contaGoogleId}`
      this.raizes.set(contaGoogleId, id)
    }
    return id
  }

  /** Cria uma coleção (com a pasta no Drive falso, como o site faz). */
  addColecao(nome, { contaGoogleId = this.contas[0]?.id, link = null } = {}) {
    const driveFolderId = this.drive ? this.drive.addFolder(nome, this.#raiz(contaGoogleId)).id : `pasta_${++this.seq}`
    const c = { id: `col_${++this.seq}`, nome, contaGoogleId, driveFolderId, link, criadoEm: new Date().toISOString() }
    this.colecoes.push(c)
    return c
  }

  /** Põe um link na fila (como o celular). */
  addFila(url, colecaoId, { nota = null, status = 'pendente', erro = null, formatos = null } = {}) {
    const i = { id: `fila_${++this.seq}`, url, nota, status, erro, driveFileId: null, colecaoId, dispositivo: null, formatos, criadoEm: new Date().toISOString() }
    this.fila.push(i)
    return i
  }

  #colecaoPublica(c) {
    const naFila = this.fila.filter(i => i.colecaoId === c.id && ['pendente', 'baixando', 'erro'].includes(i.status)).length
    return { id: c.id, nome: c.nome, contaGoogleId: c.contaGoogleId, driveFolderId: c.driveFolderId, link: c.link, naFila, criadoEm: c.criadoEm }
  }

  #itemPublico(i) {
    const c = this.colecoes.find(x => x.id === i.colecaoId)
    return { id: i.id, url: i.url, nota: i.nota, status: i.status, erro: i.erro, driveFileId: i.driveFileId, formatos: i.formatos ?? null, criadoEm: i.criadoEm, colecao: c ? { id: c.id, nome: c.nome, driveFolderId: c.driveFolderId, contaGoogleId: c.contaGoogleId } : null }
  }

  async #referencias(req, res, url, session) {
    const p = url.pathname
    const method = req.method
    const ok = (body = {}, status = 200) => this.#send(res, status, { ok: true, ...body })
    const falha = (status, erro, mensagem, extra = {}) => this.#send(res, status, { ok: false, erro, mensagem, ...extra })
    if (!this.referenciasPermitidas) return falha(403, 'plano', 'As Referências fazem parte do plano Produtora.', { motivo: 'plano' })
    let m
    if (method === 'GET' && p === '/api/referencias/colecoes') {
      this.stats.colecoes++
      const raizes = [...this.raizes].map(([contaGoogleId, driveFolderId]) => ({ contaGoogleId, driveFolderId }))
      return ok({ raiz: raizes[0] || null, raizes, colecoes: [...this.colecoes].reverse().map(c => this.#colecaoPublica(c)) })
    }
    if (method === 'POST' && p === '/api/referencias/colecoes') {
      const body = await this.#body(req)
      const nome = String(body?.nome || '').trim()
      if (!nome) return falha(400, 'entrada', 'Dê um nome para a coleção.')
      if (this.colecoes.some(c => c.nome.toLowerCase() === nome.toLowerCase())) return falha(409, 'existe', 'Já existe uma coleção com esse nome.')
      const conta = body.contaGoogleId && this.contas.some(x => x.id === body.contaGoogleId) ? body.contaGoogleId : this.contas[0]?.id
      return ok({ colecao: this.#colecaoPublica(this.addColecao(nome, { contaGoogleId: conta })) }, 201)
    }
    if ((m = /^\/api\/referencias\/colecoes\/([^/]+)$/.exec(p))) {
      const c = this.colecoes.find(x => x.id === decodeURIComponent(m[1]))
      if (!c) return falha(404, 'nao_encontrada', 'Esta coleção não existe mais.')
      if (method === 'PATCH') {
        const body = await this.#body(req)
        if (typeof body?.nome === 'string' && body.nome.trim()) c.nome = body.nome.trim()
        if (body?.link !== undefined && !['ligar', 'desligar', 'trocar'].includes(body.link)) return falha(400, 'entrada', 'Pedido incompleto.')
        if (body?.link === 'ligar' && !c.link) c.link = `${this.url}/r/${crypto.randomBytes(9).toString('base64url')}`
        if (body?.link === 'trocar') c.link = `${this.url}/r/${crypto.randomBytes(9).toString('base64url')}`
        if (body?.link === 'desligar') c.link = null
        return ok({ colecao: this.#colecaoPublica(c) })
      }
      if (method === 'DELETE') {
        this.colecoes = this.colecoes.filter(x => x !== c)
        this.fila = this.fila.filter(i => i.colecaoId !== c.id)
        return ok({ apagadaNoDrive: url.searchParams.get('apagarNoDrive') === '1' })
      }
    }
    if (method === 'GET' && p === '/api/referencias/fila') {
      this.stats.fila++
      // Sem status: pendente, baixando e erro (como o site). Vírgulas e 'todos' também valem.
      const st = (url.searchParams.get('status') || 'pendente,baixando,erro').split(',')
      const col = url.searchParams.get('colecao')
      return ok({ itens: this.fila.filter(i => (st.includes('todos') || st.includes(i.status)) && (!col || i.colecaoId === col)).map(i => this.#itemPublico(i)) })
    }
    if (method === 'POST' && p === '/api/referencias/fila') {
      const body = await this.#body(req)
      if (!body?.url || !this.colecoes.some(c => c.id === body.colecaoId)) return falha(400, 'entrada', 'Pedido incompleto.')
      return ok({ item: this.#itemPublico(this.addFila(String(body.url), body.colecaoId, { nota: body.nota || null, formatos: Array.isArray(body.formatos) ? body.formatos : null })) }, 201)
    }
    if ((m = /^\/api\/referencias\/fila\/([^/]+)\/pegar$/.exec(p)) && method === 'POST') {
      this.stats.pegar++
      const i = this.fila.find(x => x.id === decodeURIComponent(m[1]))
      if (!i) return falha(404, 'nao_encontrada', 'Este link não está mais na fila.')
      if (i.status !== 'pendente') return falha(409, 'ocupado', 'Outro computador já pegou este link.')
      i.status = 'baixando'
      i.dispositivo = session.nome
      return ok({ item: this.#itemPublico(i) })
    }
    if ((m = /^\/api\/referencias\/fila\/([^/]+)$/.exec(p)) && method === 'DELETE') {
      const n = this.fila.length
      this.fila = this.fila.filter(x => x.id !== decodeURIComponent(m[1]))
      return n === this.fila.length ? falha(404, 'nao_encontrada', 'Este link não está mais na fila.') : ok()
    }
    if ((m = /^\/api\/referencias\/fila\/([^/]+)$/.exec(p)) && method === 'PATCH') {
      const i = this.fila.find(x => x.id === decodeURIComponent(m[1]))
      if (!i) return falha(404, 'nao_encontrada', 'Este link não está mais na fila.')
      const body = await this.#body(req)
      if (!['pendente', 'baixando', 'pronto', 'erro'].includes(body?.status)) return falha(400, 'entrada', 'Pedido incompleto.')
      if (body.status === 'pronto' && !body.driveFileId) return falha(400, 'entrada', 'Falta o driveFileId.')
      if (body.status === 'baixando') {
        i.vidaEm = Date.now()
        return ok({ item: this.#itemPublico(i) })
      }
      i.status = body.status
      i.erro = body.status === 'erro' ? String(body.erro || 'Erro') : null
      i.driveFileId = body.status === 'pronto' ? body.driveFileId || null : null
      if (body.status === 'pendente') i.dispositivo = null
      return ok({ item: this.#itemPublico(i) })
    }
    return falha(404, 'nao_encontrada', 'Rota não encontrada.')
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
    this.builds.push(req.headers['x-sobedesce-build'] ?? null)
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

    if (p.startsWith('/api/referencias/')) return this.#referencias(req, res, url, session)

    if (p === '/api/dispositivos/uso' && method === 'POST') {
      this.uso.push(await this.#body(req))
      return this.#send(res, 200, { ok: true })
    }

    if (p === '/api/dispositivos/status' && (method === 'POST' || method === 'DELETE')) {
      const corpo = method === 'POST' ? await this.#body(req) : null
      this.andamento.push({ metodo: method, corpo, nome: session.nome })
      if (method === 'DELETE') {
        res.writeHead(204, { 'cache-control': 'no-store' })
        return res.end()
      }
      return this.#send(res, 200, { ok: true, avisados: 0 })
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
