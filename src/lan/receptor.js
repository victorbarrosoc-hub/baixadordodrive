// "Entre computadores" (docs/LAN.md), lado de quem RECEBE: um servidor HTTP na rede local (porta lanPorta, 4320) que
// só atende quem tem a chave de recepção deste computador (cripto.js). Cada envio é uma "oferta" com a lista de
// arquivos; cada arquivo chega em um ou mais PUT (pedaços de até 1 GB, cifrados), vai para um arquivo parcial em
// "<lanPasta>/.sobedesce-recebendo/" com o xxHash64 calculado no caminho, e no fim é conferido com o de quem mandou,
// sincronizado com o disco e só então ganha o nome final em "<lanPasta>/<pasta da oferta>/<caminho>".
// A conexão caiu? Quem manda pergunta onde parou (POST da oferta de novo) e segue dali.
// Outras contas (lanOutros ligado): o pedido vem cifrado para a chave pública deste computador (cabeçalho x-sd-eph,
// cripto.js) e a oferta fica "pendente" até a pessoa aceitar na tela; aceitando, pode subir tudo pro Drive dela.
import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { abrir, chaveDeOutraConta, decifradorDeDados, ehPublica, lerMeta, selar, VERSAO } from './cripto.js'
import { criarHash } from '../discos/copiar.js'
import { nomeDePasta } from '../discos/planejar.js'

const RECEBENDO = '.sobedesce-recebendo'
const MAX_CONTROLE = 32 * 1024 * 1024 // oferta com 100 mil arquivos cabe
const MAX_ARQUIVOS = 200_000
const OCIOSO_MS = 60_000
const GUARDA_OFERTA_MS = 24 * 60 * 60_000
const MAX_HISTORICO = 20
const MAX_PENDENTES = 3 // pedidos de outras contas esperando resposta ao mesmo tempo
const PENDENTE_MS = 5 * 60_000 // pedido sem resposta some depois disso

export class LanError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'LanError'
    this.status = status
  }
}

/** Caminho relativo seguro ("A/B/c.mov"): sem "..", sem raiz, sem controle; caracteres que o Windows recusa viram "_". */
export function caminhoSeguro(rel) {
  const partes = String(rel ?? '')
    .split(/[\\/]+/)
    .filter((p) => p !== '' && p !== '.')
  if (!partes.length || partes.length > 64) return null
  const out = []
  for (const p of partes) {
    if (p === '..') return null
    const limpo = p
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[<>:"|?*]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 255)
    if (!limpo || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(limpo)) return null
    out.push(limpo)
  }
  return out.join('/')
}

async function existe(p) {
  try {
    return await fsp.stat(p)
  } catch {
    return null
  }
}

/** "C0001.MP4" ocupado por outro conteúdo → "C0001 (2).MP4". */
async function nomeLivre(alvo) {
  if (!(await existe(alvo))) return alvo
  const ext = path.extname(alvo)
  const base = alvo.slice(0, alvo.length - ext.length)
  for (let i = 2; i < 1000; i++) {
    const c = `${base} (${i})${ext}`
    if (!(await existe(c))) return c
  }
  throw new LanError(409, 'Nomes demais ocupados no destino.')
}

export class LanReceptor {
  /**
   * @param {{ settings: { get(): object }, chave: () => string, nome: () => Promise<string>|string, plataforma?: string,
   *           onChange?: Function, onFim?: Function, log?: Function }} o
   */
  constructor({ settings, chave, par = null, aceitaOutros = () => false, nome, plataforma = process.platform, onChange = () => {}, onFim = () => {}, onPedido = () => {}, onSubirDrive = null, log = null }) {
    this.settings = settings
    this.chave = chave
    this.par = par
    this.aceitaOutros = aceitaOutros
    this.onPedido = onPedido
    this.onSubirDrive = onSubirDrive
    this.chavesEfemeras = new Map() // efêmera → chave do envio (conta feita uma vez)
    this.nome = nome
    this.plataforma = plataforma
    this.onChange = onChange
    this.onFim = onFim
    this.log = log || (() => {})
    this.ofertas = new Map()
    this.server = null
    this.porta = null
    this.timer = null
    this.ultimoAviso = 0
  }

  get rodando() {
    return !!this.server
  }

  async iniciar() {
    if (this.server) return this.porta
    const srv = http.createServer((req, res) => this.#atender(req, res))
    srv.requestTimeout = 0 // um pedaço de 1 GB pelo Wi-Fi demora; quem para de mandar cai no timeout de ociosidade
    srv.headersTimeout = 30_000
    srv.keepAliveTimeout = 30_000
    srv.on('connection', (s) => s.setTimeout(OCIOSO_MS, () => s.destroy()))
    const quer = Number(this.settings.get().lanPorta) || 4320
    this.porta = await new Promise((ok, falha) => {
      const tentar = (porta, ultima) => {
        srv.once('error', (err) => (!ultima && err.code === 'EADDRINUSE' ? tentar(0, true) : falha(err)))
        srv.listen(porta, '0.0.0.0', () => ok(srv.address().port))
      }
      tentar(quer, false)
    })
    this.server = srv
    this.#limparParciais().catch(() => {})
    return this.porta
  }

  async parar() {
    const srv = this.server
    this.server = null
    this.porta = null
    if (!srv) return
    await new Promise((ok) => {
      srv.close(() => ok())
      srv.closeAllConnections?.()
    })
  }

  // ───── estado para a tela ─────

  view() {
    const todas = [...this.ofertas.values()].sort((a, b) => b.criadaEm - a.criadaEm)
    const lista = todas.filter((o) => o.estado !== 'pendente' && o.estado !== 'recusada').slice(0, MAX_HISTORICO)
    return {
      rodando: this.rodando,
      porta: this.porta,
      pasta: this.settings.get().lanPasta,
      pedidos: todas
        .filter((o) => o.estado === 'pendente')
        .map((o) => ({ id: o.id, de: o.de, pessoa: o.pessoa, pasta: o.pasta, arquivos: o.arquivos.length, bytes: o.total, criadaEm: o.criadaEm })),
      recebendo: lista.map((o) => ({
        id: o.id,
        de: o.de,
        pasta: o.pasta,
        caminho: o.dir,
        arquivos: o.arquivos.length,
        prontos: o.arquivos.filter((a) => a.estado === 'pronto' || a.estado === 'igual').length,
        erros: o.arquivos.filter((a) => a.estado === 'erro').length,
        bytes: o.total,
        recebidos: o.arquivos.reduce((s, a) => s + (a.estado === 'igual' ? 0 : a.offset), 0),
        estado: o.estado,
        outra: !!o.eph,
        pessoa: o.pessoa || null,
        drive: o.drive ? { pasta: o.drive.folderName || null, estado: o.driveEstado || null } : null,
        criadaEm: o.criadaEm,
        fimEm: o.fimEm || null,
      })),
    }
  }

  #mudou(forcar = false) {
    const agora = Date.now()
    if (!forcar && agora - this.ultimoAviso < 300) {
      if (!this.timer) this.timer = setTimeout(() => ((this.timer = null), this.#mudou(true)), 300)
      return
    }
    this.ultimoAviso = agora
    try {
      this.onChange(this.view())
    } catch {}
  }

  // ───── HTTP ─────

  async #atender(req, res) {
    const url = new URL(req.url, 'http://x')
    const caminho = url.pathname
    // A chave deste pedido: a de recepção (mesma conta) ou a combinada com a efêmera de quem manda (outra conta).
    const eph = req.headers['x-sd-eph']
    let chave = null
    if (eph === undefined) chave = this.chave()
    else if (this.aceitaOutros() && this.par && ehPublica(eph)) {
      chave = this.chavesEfemeras.get(eph)
      if (!chave) {
        try {
          chave = chaveDeOutraConta(this.par(), eph)
          if (this.chavesEfemeras.size > 500) this.chavesEfemeras.clear()
          this.chavesEfemeras.set(eph, chave)
        } catch {
          chave = null
        }
      }
    }
    const ctx = { chave, eph: eph === undefined ? null : eph }
    const responder = (status, obj) => {
      const corpo = obj === undefined || !chave ? null : selar(chave, obj, `resp ${req.method} ${caminho}`)
      res.writeHead(status, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', ...(corpo ? { 'content-length': corpo.length } : {}) })
      res.end(corpo)
    }
    try {
      // Sem a chave certa: 403 sem dizer nada (e sem ler o corpo).
      const m = chave ? lerMeta(chave, req.headers['x-sd-meta'], req.method, caminho) : null
      if (!m) {
        res.writeHead(403, { connection: 'close' })
        return res.end()
      }
      const r = /^\/lan\/v1\/(ping|ofertas)(?:\/([A-Za-z0-9-]{8,64})(?:\/(\d{1,7}))?(\/fim)?)?$/.exec(caminho)
      if (!r) throw new LanError(404, 'Rota desconhecida.')
      const [, tipo, ofertaId, n, fim] = r
      if (req.method === 'POST' && tipo === 'ping' && !ofertaId) {
        await this.#corpo(req, caminho, 1024, chave)
        return responder(200, { versao: VERSAO, nome: await this.nome(), plataforma: this.plataforma })
      }
      if (tipo === 'ofertas' && req.method === 'POST' && !ofertaId) return responder(200, await this.#oferta(await this.#corpo(req, caminho, MAX_CONTROLE, chave), ctx))
      if (tipo === 'ofertas' && req.method === 'PUT' && ofertaId && n != null && !fim) return responder(200, await this.#dados(req, ofertaId, Number(n), m, ctx))
      if (tipo === 'ofertas' && req.method === 'POST' && ofertaId && n != null && fim) return responder(200, await this.#fimArquivo(ofertaId, Number(n), await this.#corpo(req, caminho, 4096, chave), ctx))
      if (tipo === 'ofertas' && req.method === 'POST' && ofertaId && n == null && fim) return responder(200, await this.#fimOferta(ofertaId, await this.#corpo(req, caminho, 4096, chave), ctx))
      throw new LanError(405, 'Método não aceito.')
    } catch (err) {
      const status = err instanceof LanError ? err.status : 500
      if (!(err instanceof LanError)) this.log('lan: receber', err)
      if (!res.headersSent) responder(status, { erro: err.message, ...(err.offset != null ? { offset: err.offset } : {}) })
      else res.destroy()
    }
  }

  async #corpo(req, caminho, limite, chave) {
    const partes = []
    let n = 0
    for await (const p of req) {
      n += p.length
      if (n > limite) throw new LanError(413, 'Pedido grande demais.')
      partes.push(p)
    }
    try {
      return abrir(chave, Buffer.concat(partes), `${req.method} ${caminho}`)
    } catch {
      throw new LanError(400, 'Pedido ilegível.')
    }
  }

  // ───── oferta ─────

  async #oferta(o, ctx) {
    if (typeof o?.id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(o.id)) throw new LanError(400, 'Oferta sem id.')
    if (!Array.isArray(o.arquivos) || !o.arquivos.length || o.arquivos.length > MAX_ARQUIVOS) throw new LanError(400, 'Lista de arquivos inválida.')
    let oferta = this.ofertas.get(o.id)
    if (oferta && oferta.eph !== ctx.eph) throw new LanError(404, 'Oferta desconhecida.')
    if (!oferta) {
      this.#esquecerPendentesVelhos()
      if (ctx.eph && [...this.ofertas.values()].filter((x) => x.estado === 'pendente').length >= MAX_PENDENTES) throw new LanError(429, 'Este computador já tem pedidos esperando resposta. Tente daqui a pouco.')
      const base = this.settings.get().lanPasta
      const pasta = nomeDePasta(o.pasta) || 'Recebidos'
      const dir = path.join(base, pasta)
      const vistos = new Set()
      const arquivos = o.arquivos.map((a, n) => {
        const rel = caminhoSeguro(a?.relPath)
        const size = Number(a?.size)
        if (!rel || !Number.isSafeInteger(size) || size < 0) throw new LanError(400, `Arquivo inválido na lista (${n}).`)
        if (vistos.has(rel.toLowerCase())) throw new LanError(400, `Arquivo repetido na lista: ${rel}.`)
        vistos.add(rel.toLowerCase())
        return { n, relPath: rel, size, mtimeMs: Number.isFinite(a.mtimeMs) ? a.mtimeMs : null, estado: 'novo', offset: 0, hash: null, ocupado: false }
      })
      const total = arquivos.reduce((s, a) => s + a.size, 0)
      // Espaço: confere antes de aceitar.
      await fsp.mkdir(base, { recursive: true })
      try {
        const st = await fsp.statfs(base)
        const livre = Number(st.bavail) * Number(st.bsize)
        if (total > livre) throw new LanError(507, `Não cabe neste computador: precisa de ${(total / 1e9).toFixed(1)} GB e tem ${(livre / 1e9).toFixed(1)} GB livres.`)
      } catch (err) {
        if (err instanceof LanError) throw err
      }
      // O que já está na pasta com o mesmo tamanho não vem de novo.
      for (const a of arquivos) {
        const st = await existe(path.join(dir, ...a.relPath.split('/')))
        if (st?.isFile() && st.size === a.size) a.estado = 'igual'
      }
      oferta = {
        id: o.id,
        de: String(o.de || 'Outro computador').slice(0, 120),
        pessoa: typeof o.pessoa === 'string' ? o.pessoa.slice(0, 60) : null,
        eph: ctx.eph,
        pasta,
        dir,
        parcial: path.join(base, RECEBENDO, o.id),
        arquivos,
        total,
        // Outra conta: espera a pessoa aceitar. A própria conta: entra direto.
        estado: ctx.eph ? 'pendente' : 'recebendo',
        criadaEm: Date.now(),
      }
      this.ofertas.set(o.id, oferta)
      this.#esquecerVelhas()
      this.#mudou(true)
      if (oferta.estado === 'pendente') {
        try {
          this.onPedido({ id: oferta.id, de: oferta.de, pessoa: oferta.pessoa, arquivos: arquivos.length, bytes: total })
        } catch {}
      }
    }
    oferta.vistaEm = Date.now()
    if (oferta.estado === 'pendente') return { aceita: false, aguardando: true, pasta: oferta.pasta }
    if (oferta.estado === 'recusada') return { aceita: false, recusada: true }
    return { aceita: true, pasta: oferta.pasta, arquivos: oferta.arquivos.map((a) => ({ n: a.n, estado: a.estado, offset: a.offset })) }
  }

  /**
   * A pessoa respondeu um pedido de outra conta. `drive`: { accountId, folderId, folderName?, driveId? } para subir o
   * que chegar pro Drive dela.
   */
  responder(id, aceitar, { drive = null } = {}) {
    const oferta = this.ofertas.get(id)
    if (!oferta || oferta.estado !== 'pendente') throw new LanError(404, 'Esse pedido não está mais esperando.')
    oferta.estado = aceitar ? 'recebendo' : 'recusada'
    oferta.drive = aceitar ? drive : null
    oferta.fimEm = aceitar ? null : Date.now()
    this.#mudou(true)
    return this.view()
  }

  #esquecerPendentesVelhos() {
    const corte = Date.now() - PENDENTE_MS
    for (const [id, o] of this.ofertas) if (o.estado === 'pendente' && (o.vistaEm || o.criadaEm) < corte) this.ofertas.delete(id)
  }

  #esquecerVelhas() {
    const corte = Date.now() - GUARDA_OFERTA_MS
    for (const [id, o] of this.ofertas) if ((o.vistaEm || o.criadaEm) < corte && o.estado !== 'recebendo') this.ofertas.delete(id)
  }

  #arquivo(ofertaId, n, ctx) {
    const oferta = this.ofertas.get(ofertaId)
    if (!oferta || oferta.eph !== ctx.eph) throw new LanError(404, 'Oferta desconhecida (o outro computador reiniciou?). Mande de novo.')
    if (oferta.estado === 'pendente' || oferta.estado === 'recusada') throw new LanError(403, 'Ainda não foi aceito.')
    const a = oferta.arquivos[n]
    if (!a) throw new LanError(404, 'Arquivo desconhecido.')
    return { oferta, a }
  }

  // ───── dados ─────

  async #dados(req, ofertaId, n, m, ctx) {
    const { oferta, a } = this.#arquivo(ofertaId, n, ctx)
    if (a.estado === 'pronto' || a.estado === 'igual') throw new LanError(409, 'Este arquivo já chegou.')
    if (a.ocupado) throw new LanError(409, 'Este arquivo já está chegando por outra conexão.')
    if (typeof m.sessao !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(m.sessao)) throw new LanError(400, 'Sessão inválida.')
    // Retomada: só continua de onde este computador parou (e com o xxHash do começo ainda na memória).
    if (m.offset !== a.offset || (a.offset > 0 && !a.hash)) {
      const err = new LanError(409, 'Posição diferente; continue de onde parei.')
      err.offset = a.hash || a.offset === 0 ? a.offset : 0
      if (!a.hash) a.offset = 0
      throw err
    }
    a.ocupado = true
    a.estado = 'recebendo'
    await fsp.mkdir(oferta.parcial, { recursive: true })
    const arq = path.join(oferta.parcial, `${n}.parcial`)
    if (a.offset === 0) a.hash = await criarHash('xxh64')
    const fh = await fsp.open(arq, a.offset === 0 ? 'w' : 'r+')
    const dec = decifradorDeDados(ctx.chave, { oferta: ofertaId, sessao: m.sessao, arquivo: n, offset: a.offset })
    try {
      for await (const pedaco of req) {
        for (const bloco of dec.empurrar(pedaco)) {
          if (a.offset + bloco.length > a.size) throw new LanError(400, 'Veio mais do que o tamanho do arquivo.')
          let feito = 0
          while (feito < bloco.length) feito += (await fh.write(bloco, feito, bloco.length - feito, a.offset + feito)).bytesWritten
          a.hash.update(bloco)
          a.offset += bloco.length
          this.#mudou()
        }
      }
    } catch (err) {
      if (err instanceof LanError) throw err
      // Bloco adulterado ou chave errada: este pedaço não vale; o arquivo recomeça do zero (o xxHash não volta atrás).
      a.offset = 0
      a.hash = null
      throw new LanError(400, 'Dados que não abrem com a chave (adulterados?). O arquivo recomeça.')
    } finally {
      await fh.close().catch(() => {})
      a.ocupado = false
    }
    return { offset: a.offset }
  }

  async #fimArquivo(ofertaId, n, corpo, ctx) {
    const { oferta, a } = this.#arquivo(ofertaId, n, ctx)
    if (a.estado === 'pronto' || a.estado === 'igual') return { ok: true, hash: a.hashFinal || null, caminho: a.destino || null }
    if (a.offset !== a.size) {
      const err = new LanError(409, `Chegou ${a.offset} de ${a.size} bytes.`)
      err.offset = a.offset
      throw err
    }
    const arq = path.join(oferta.parcial, `${n}.parcial`)
    if (a.size === 0 && !a.hash) {
      a.hash = await criarHash('xxh64')
      await fsp.mkdir(oferta.parcial, { recursive: true })
      await fsp.writeFile(arq, Buffer.alloc(0))
    }
    const hash = a.hash.hex()
    if (typeof corpo?.hash !== 'string' || corpo.hash !== hash) {
      a.estado = 'erro'
      a.offset = 0
      a.hash = null
      await fsp.rm(arq, { force: true }).catch(() => {})
      this.#mudou(true)
      return { ok: false, erro: 'O conteúdo que chegou não bate com o de origem (xxHash64). Mande de novo.' }
    }
    const fh = await fsp.open(arq, 'r+')
    await fh.sync()
    await fh.close()
    const alvo = path.join(oferta.dir, ...a.relPath.split('/'))
    await fsp.mkdir(path.dirname(alvo), { recursive: true })
    const final = await nomeLivre(alvo)
    await fsp.rename(arq, final)
    if (Number.isFinite(a.mtimeMs)) await fsp.utimes(final, new Date(), new Date(a.mtimeMs)).catch(() => {})
    a.estado = 'pronto'
    a.hashFinal = hash
    a.destino = final
    a.hash = null
    this.#mudou(true)
    return { ok: true, hash, caminho: path.relative(oferta.dir, final).split(path.sep).join('/') }
  }

  async #fimOferta(ofertaId, corpo, ctx) {
    const oferta = this.ofertas.get(ofertaId)
    if (!oferta || oferta.eph !== ctx.eph) throw new LanError(404, 'Oferta desconhecida.')
    if (oferta.estado === 'pendente' || oferta.estado === 'recusada') return { ok: true, faltam: oferta.arquivos.length }
    const faltam = oferta.arquivos.filter((a) => a.estado !== 'pronto' && a.estado !== 'igual').length
    oferta.estado = corpo?.cancelada ? 'cancelada' : faltam ? 'incompleta' : 'pronta'
    oferta.fimEm = Date.now()
    await fsp.rm(oferta.parcial, { recursive: true, force: true }).catch(() => {})
    await fsp.rmdir(path.dirname(oferta.parcial)).catch(() => {}) // a pasta escondida some quando fica vazia (no Windows ela aparece)
    // Quem aceitou com "subir pro meu Drive": a pasta que chegou vai para a fila de envio (o motor de sempre).
    if (oferta.drive && this.onSubirDrive && oferta.arquivos.some((a) => a.estado === 'pronto')) {
      oferta.driveEstado = 'na-fila'
      Promise.resolve(this.onSubirDrive({ caminhos: [oferta.dir], ...oferta.drive })).then(
        () => ((oferta.driveEstado = 'na-fila'), this.#mudou(true)),
        (err) => ((oferta.driveEstado = `erro: ${err.message}`), this.#mudou(true)),
      )
    }
    this.#mudou(true)
    try {
      this.onFim({ ...this.view().recebendo.find((x) => x.id === ofertaId) })
    } catch {}
    return { ok: true, faltam }
  }

  /** Parciais de mais de um dia (envio que nunca terminou) saem da pasta escondida. */
  async #limparParciais() {
    const dir = path.join(this.settings.get().lanPasta, RECEBENDO)
    const itens = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const d of itens) {
      const p = path.join(dir, d.name)
      const st = await existe(p)
      if (st && Date.now() - st.mtimeMs > GUARDA_OFERTA_MS && !this.ofertas.has(d.name)) await fsp.rm(p, { recursive: true, force: true }).catch(() => {})
    }
  }
}
