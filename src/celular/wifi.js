// Celular ↔ computador pelo Wi-Fi (docs/CELULAR-WIFI.md), a parte do motor.
//
// O WebRTC roda na janela oculta do Electron (public/celular/p2p.js); aqui fica o resto:
//  - a espera longa no site (GET /api/p2p/espera) enquanto há conta: marca este computador como online e traz as
//    ofertas e respostas dos celulares da conta, que vão para a janela oculta pelo SSE;
//  - a lista de celulares online (GET /api/p2p/aparelhos, a cada ~20 s);
//  - a gravação do que chega: um `.parcial` numa pasta oculta dentro da pasta "SOBEDESCE do celular", escrito na
//    ordem (offset conferido), fsync no fim e o nome final sem colisão ("IMG_0001 (2).HEIC"). Não sobe pro Drive;
//  - o que este computador manda: a lista de arquivos (pastas abertas), lida em pedaços pela janela oculta;
//  - o andamento para a interface (SSE 'celular').
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { isJunkFile, safeLocalName } from '../util/paths.js'
import { MSG_REDE_BLOQUEADA, criarRedeLocal } from './rede-local.js'
import { criarFirewall } from './firewall.js'

export const RECEBENDO = '.sobedesce-recebendo'
const ESPERA_TIMEOUT_MS = 40_000 // o site segura até 25 s; folga para a rede
const APARELHOS_MS = 20_000
const BACKOFF_MIN_MS = 2_000
const BACKOFF_MAX_MS = 60_000
const GUARDA_MS = 24 * 60 * 60_000
const MAX_HISTORICO = 20
const MAX_ARQUIVOS = 2000
const MAX_PUT = 64 * 1024 * 1024
const FOLGA = 64 * 1024 * 1024
const SDP_MAX = 20_000
const JANELA_MS = 45_000 // a janela oculta avisa a cada 20 s que está de pé
const PEDIDO_MS = 110_000 // pedido de outra pessoa sem resposta cai (o celular desiste em ~115 s)
const MAX_PEDIDOS = 3

export class CelularError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'CelularError'
    this.status = status
  }
}

const novoId = (p) => `${p}${crypto.randomBytes(9).toString('base64url')}`
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms).unref?.())

const TIPOS = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic', '.heif': 'image/heif', '.gif': 'image/gif',
  '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.dng': 'image/x-adobe-dng',
  '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.aac': 'audio/aac',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.zip': 'application/zip',
}
export const tipoDe = (nome) => TIPOS[path.extname(nome).toLowerCase()] || 'application/octet-stream'

async function existe(p) {
  try {
    return await fsp.stat(p)
  } catch {
    return null
  }
}

/** "IMG_0001.HEIC" ocupado → "IMG_0001 (2).HEIC". */
export async function nomeLivre(alvo) {
  if (!(await existe(alvo))) return alvo
  const ext = path.extname(alvo)
  const base = alvo.slice(0, alvo.length - ext.length)
  for (let i = 2; i < 10_000; i++) {
    const c = `${base} (${i})${ext}`
    if (!(await existe(c))) return c
  }
  throw new CelularError(409, 'Nomes demais ocupados na pasta.')
}

/** Espaço livre no disco da pasta (ou da primeira pasta acima que existe). null = não deu para saber. */
async function espacoLivre(dir) {
  let d = path.resolve(dir)
  for (let i = 0; i < 64; i++) {
    try {
      const s = await fsp.statfs(d)
      return Number(s.bavail) * Number(s.bsize)
    } catch {
      const pai = path.dirname(d)
      if (pai === d) return null
      d = pai
    }
  }
  return null
}

/** Abre pastas (recursivo), sem lixo de sistema, até `max` arquivos. */
export async function listarArquivos(caminhos, max = MAX_ARQUIVOS) {
  const out = []
  const visitar = async (p) => {
    if (out.length >= max) return
    const st = await fsp.lstat(p).catch(() => null)
    if (!st || st.isSymbolicLink()) return
    if (st.isDirectory()) {
      const nomes = (await fsp.readdir(p).catch(() => [])).sort((a, b) => a.localeCompare(b))
      for (const n of nomes) {
        if (isJunkFile(n) || n === RECEBENDO) continue
        await visitar(path.join(p, n))
      }
    } else if (st.isFile() && !isJunkFile(path.basename(p))) {
      out.push({ caminho: p, nome: path.basename(p), tamanho: st.size, tipo: tipoDe(p) })
    }
  }
  for (const c of caminhos) {
    if (typeof c !== 'string' || !path.isAbsolute(c)) continue
    await visitar(c)
  }
  return out
}

/**
 * @param {{ settings, cloud: () => object|null, nome?: () => Promise<string>|string, hub?: { send(ev, data): void },
 *           log?: Function, aparelhosMs?: number, redeLocal?: { estado, conferir() } }} o
 */
export class CelularWifi {
  constructor({ settings, cloud, nome = () => 'Computador', hub = null, log = () => {}, aparelhosMs = APARELHOS_MS, redeLocal = criarRedeLocal(), firewall = criarFirewall() } = {}) {
    this.settings = settings
    this.cloud = typeof cloud === 'function' ? cloud : () => cloud
    this.nome = nome
    this.hub = hub
    this.log = log
    this.aparelhosMs = aparelhosMs
    this.redeLocal = redeLocal
    this.firewall = firewall
    this.ultimaFalha = null // a última vez que o celular tentou e a ligação direta não abriu: { quando, erro }
    this.celulares = []
    this.transfers = new Map()
    this.rodando = false
    this.esperando = false
    this.timer = null
    this.janelaEm = 0
    this.pedidos = new Map() // oferta de outra pessoa esperando Aceitar/Recusar: id → { sinal, timer }
    this.onStatus = () => this.#acordar()
  }

  // ───── ciclo de vida ─────

  start() {
    if (this.rodando) return
    this.rodando = true
    this.cloud()?.on?.('status', this.onStatus)
    this.timer = setInterval(() => this.atualizarAparelhos().catch(() => {}), this.aparelhosMs)
    this.timer.unref?.()
    // No macOS 15+, a primeira tentativa também faz o sistema pedir a permissão de Rede Local.
    this.conferirRede().catch(() => {})
    this.#acordar()
  }

  /** Confere a permissão de Rede Local do macOS (rede-local.js) e avisa a tela se mudou. */
  async conferirRede({ forcar = false } = {}) {
    const antes = this.redeLocal.estado
    const fwAntes = JSON.stringify(this.firewall.estado)
    const [r] = await Promise.all([this.redeLocal.conferir({ forcar }), this.firewall.conferir({ forcar }).catch(() => null)])
    if (JSON.stringify(this.firewall.estado) !== fwAntes) {
      if (this.firewall.estado?.atrapalha) this.log('celular: o Firewall do macOS não deixa o SOBEDESCE receber conexões (Ajustes → Rede → Firewall)')
      if (r === antes) this.#avisar()
    }
    if (r !== antes) {
      if (r === 'bloqueada') this.log('celular: o macOS está bloqueando a rede local (Ajustes → Privacidade e Segurança → Rede Local)')
      this.#avisar()
    }
    return r
  }

  async close() {
    this.rodando = false
    clearInterval(this.timer)
    this.timer = null
    this.cloud()?.off?.('status', this.onStatus)
    for (const p of this.pedidos.values()) clearTimeout(p.timer)
    this.pedidos.clear()
    for (const t of this.transfers.values()) if (t.direcao === 'recebendo' && ATIVO.has(t.estado)) await this.#descartar(t).catch(() => {})
  }

  #acordar() {
    if (!this.rodando || this.esperando || !this.cloud()?.signedIn) return
    this.esperando = true
    this.atualizarAparelhos().catch(() => {})
    this.#laco().finally(() => {
      this.esperando = false
    })
  }

  async #laco() {
    let espera = BACKOFF_MIN_MS
    while (this.rodando && this.cloud()?.signedIn) {
      try {
        const nome = await this.nome()
        const outros = this.settings.get().celularOutros ? '&outros=1' : ''
        const { data } = await this.cloud().request('GET', `/api/p2p/espera?nome=${encodeURIComponent(String(nome || '').slice(0, 60))}${outros}`, { timeoutMs: ESPERA_TIMEOUT_MS })
        espera = BACKOFF_MIN_MS
        for (const s of Array.isArray(data?.sinais) ? data.sinais : []) await this.tratarSinal(s).catch((err) => this.log('celular: sinal', err?.message || err))
      } catch (err) {
        if (err?.kind === 'reauth' || err?.reason === 'cloudSignedOut') return
        this.log('celular: espera', err?.message || err)
        await sleep(espera)
        espera = Math.min(BACKOFF_MAX_MS, espera * 2)
      }
    }
  }

  async atualizarAparelhos() {
    const c = this.cloud()
    if (!c?.signedIn) {
      if (this.celulares.length) (this.celulares = []), this.#avisar()
      return this.celulares
    }
    const { data } = await c.request('GET', '/api/p2p/aparelhos')
    const lista = (Array.isArray(data?.aparelhos) ? data.aparelhos : []).filter((a) => a?.tipo === 'celular' && typeof a.id === 'string')
    const novo = lista.map((a) => ({
      id: a.id,
      nome: String(a.nome || 'Celular').slice(0, 60),
      mesmaRede: !!a.mesmaRede,
      conta: a.conta === 'outra' ? 'outra' : 'minha',
      dono: a.conta === 'outra' && typeof a.dono === 'string' ? a.dono.slice(0, 60) : null,
    }))
    if (JSON.stringify(novo) !== JSON.stringify(this.celulares)) {
      this.celulares = novo
      this.#avisar()
    }
    return this.celulares
  }

  /** A janela oculta do WebRTC (só no app de computador) avisou que está de pé há pouco. */
  janela() {
    const antes = this.janelaPronta()
    this.janelaEm = Date.now()
    if (!antes) this.#avisar()
    return { ok: true }
  }

  janelaPronta() {
    return Date.now() - this.janelaEm < JANELA_MS
  }

  // ───── sinais (site) ─────

  async tratarSinal(s) {
    if (!s || typeof s.id !== 'string' || typeof s.tipo !== 'string') return
    if (s.tipo === 'oferta') {
      if (s.de?.tipo && s.de.tipo !== 'celular') return
      const st = this.settings.get()
      const outra = s.de?.conta === 'outra'
      const rede = st.celularReceber ? await this.conferirRede().catch(() => null) : null
      const motivo = !st.celularReceber
        ? 'Este computador não está recebendo do celular. Ligue em Dispositivos, no app do computador.'
        : outra && !st.celularOutros
          ? 'Este computador não aceita arquivos de outras pessoas.'
          : rede === 'bloqueada'
            ? MSG_REDE_BLOQUEADA
            : !this.janelaPronta()
            ? 'O app do computador não está pronto para receber agora. Feche e abra o SOBEDESCE no computador.'
            : outra && this.pedidos.size >= MAX_PEDIDOS
              ? 'O computador tem pedidos demais esperando. Tente daqui a pouco.'
              : null
      if (motivo) {
        await this.sinal({ para: s.de?.id, tipo: 'recusa', oferta: s.id, motivo }).catch(() => {})
        return
      }
      // Da mesma conta: aceita sozinho. De outra pessoa: só depois de Aceitar na tela.
      if (!outra) return void this.hub?.send('celular-oferta', s)
      const timer = setTimeout(() => {
        if (!this.pedidos.delete(s.id)) return
        this.#avisar()
        this.sinal({ para: s.de.id, tipo: 'recusa', oferta: s.id, motivo: 'Ninguém respondeu no computador.' }).catch(() => {})
      }, PEDIDO_MS)
      timer.unref?.()
      this.pedidos.set(s.id, { sinal: s, timer })
      this.hub?.send('celular-pedido', this.#pedidoPublico(s))
      this.#avisar()
      return
    }
    const t = [...this.transfers.values()].find((x) => x.oferta && x.oferta === s.oferta)
    if (s.tipo === 'resposta') {
      if (t && t.estado === 'esperando') this.#mudar(t, { estado: 'conectando' })
      this.hub?.send('celular-sinal', s)
    } else if (s.tipo === 'recusa') {
      if (t && ATIVO.has(t.estado)) this.#mudar(t, { estado: 'erro', erro: s.motivo || 'O celular recusou.', fim: Date.now() })
      this.hub?.send('celular-sinal', s)
    } else if (s.tipo === 'cancela') {
      const p = this.pedidos.get(s.oferta)
      if (p) {
        clearTimeout(p.timer)
        this.pedidos.delete(s.oferta)
        this.#avisar()
      }
      if (t && ATIVO.has(t.estado)) await this.#encerrar(t, 'cancelado', s.motivo || 'O celular cancelou.')
      this.hub?.send('celular-cancelar', { oferta: s.oferta, tid: t?.id ?? null })
    }
  }

  /** Pedido de outra pessoa: Aceitar entrega a oferta à janela oculta; Recusar avisa o celular. */
  async responder(id, aceitar) {
    const p = this.pedidos.get(id)
    if (!p) throw new CelularError(404, 'Esse pedido não está mais esperando.')
    clearTimeout(p.timer)
    this.pedidos.delete(id)
    this.#avisar()
    if (aceitar) {
      if (!this.janelaPronta()) throw new CelularError(409, 'O app do computador não está pronto para receber agora. Feche e abra o SOBEDESCE.')
      this.hub?.send('celular-oferta', p.sinal)
    } else {
      await this.sinal({ para: p.sinal.de.id, tipo: 'recusa', oferta: id, motivo: 'Recusado no computador.' }).catch(() => {})
    }
    return this.view()
  }

  #pedidoPublico(s) {
    const r = s.resumo || {}
    return {
      id: s.id,
      nome: String(s.de?.nome || 'Celular').slice(0, 60),
      dono: typeof s.de?.dono === 'string' ? s.de.dono.slice(0, 60) : null,
      arquivos: Math.max(0, Number(r.arquivos) || 0),
      bytes: Math.max(0, Number(r.bytes) || 0),
      nomes: Array.isArray(r.nomes) ? r.nomes.filter((n) => typeof n === 'string').slice(0, 5) : [],
    }
  }

  /** Oferta, resposta, recusa ou cancela pelo site (a janela oculta chama). `tid` liga a oferta à transferência. */
  async sinal({ para, tipo, sdp, oferta, resumo, motivo, tid } = {}) {
    const c = this.cloud()
    if (!c?.signedIn) throw new CelularError(409, 'Entre na sua conta SOBEDESCE para falar com o celular.')
    if (typeof para !== 'string' || !para || para.length > 100) throw new CelularError(400, 'Celular inválido.')
    if (!['oferta', 'resposta', 'recusa', 'cancela'].includes(tipo)) throw new CelularError(400, 'Sinal inválido.')
    if (sdp != null && (typeof sdp !== 'string' || sdp.length > SDP_MAX)) throw new CelularError(400, 'Sinal inválido.')
    const body = { para, tipo }
    if (sdp) body.sdp = sdp
    if (typeof oferta === 'string' && oferta) body.oferta = oferta
    if (typeof motivo === 'string' && motivo) body.motivo = motivo.slice(0, 300)
    if (tipo === 'oferta' && resumo && typeof resumo === 'object') {
      body.resumo = {
        arquivos: Math.max(0, Math.floor(Number(resumo.arquivos) || 0)),
        bytes: Math.max(0, Math.floor(Number(resumo.bytes) || 0)),
        nomes: (Array.isArray(resumo.nomes) ? resumo.nomes : []).filter((n) => typeof n === 'string').slice(0, 5).map((n) => n.slice(0, 120)),
      }
    }
    // O site responde 201 (Criado) ao guardar o sinal
    const { data } = await c.request('POST', '/api/p2p/sinal', { body, expect: [200, 201] })
    const id = typeof data?.id === 'string' ? data.id : null
    if (tipo === 'oferta' && tid) {
      const t = this.transfers.get(tid)
      if (t) this.#mudar(t, { oferta: id, estado: 'esperando' })
    }
    if (tipo === 'resposta' && tid) {
      const t = this.transfers.get(tid)
      if (t) t.oferta = oferta
    }
    return { id }
  }

  // ───── mandar para o celular ─────

  async enviar({ para, caminhos } = {}) {
    if (!this.cloud()?.signedIn) throw new CelularError(409, 'Entre na sua conta SOBEDESCE para mandar para o celular.')
    if (typeof para !== 'string' || !para) throw new CelularError(400, 'Escolha o celular.')
    const lista = Array.isArray(caminhos) ? caminhos.filter((c) => typeof c === 'string' && c && path.isAbsolute(c)).slice(0, 500) : []
    if (!lista.length) throw new CelularError(400, 'Escolha o que mandar.')
    if ((await this.conferirRede().catch(() => null)) === 'bloqueada') throw new CelularError(409, MSG_REDE_BLOQUEADA)
    const arquivos = await listarArquivos(lista)
    if (!arquivos.length) throw new CelularError(400, 'Não achei arquivos para mandar nessa escolha.')
    const cel = this.celulares.find((c) => c.id === para)
    const t = this.#nova({ direcao: 'enviando', aparelho: { id: para, nome: cel?.nome || 'Celular', dono: cel?.dono || null }, arquivos, pasta: null })
    this.hub?.send('celular-enviar', { tid: t.id, para, nome: t.aparelho.nome, arquivos: arquivos.map(({ nome, tamanho, tipo }) => ({ nome, tamanho, tipo })) })
    return { tid: t.id, arquivos: arquivos.length, bytes: t.total }
  }

  /** Arquivo `i` de um envio, para a janela oculta ler. */
  arquivoParaLer(tid, i) {
    const t = this.transfers.get(tid)
    if (!t || t.direcao !== 'enviando') throw new CelularError(404, 'Envio não encontrado.')
    const a = t.arquivos[Number(i)]
    if (!a?.caminho) throw new CelularError(404, 'Arquivo não encontrado.')
    return a
  }

  // ───── receber do celular ─────

  /** O celular quer mandar: confere ajuste, pasta e espaço. Devolve { aceito: true } ou { aceito: false, motivo }. */
  async receber({ tid, de, arquivos, oferta } = {}) {
    const st = this.settings.get()
    if (!st.celularReceber) return { aceito: false, motivo: 'Este computador não está recebendo do celular.' }
    if (typeof tid !== 'string' || !/^[\w-]{6,64}$/.test(tid)) throw new CelularError(400, 'Transferência inválida.')
    if (this.transfers.has(tid)) throw new CelularError(409, 'Transferência repetida.')
    if (!Array.isArray(arquivos) || !arquivos.length || arquivos.length > MAX_ARQUIVOS) throw new CelularError(400, 'Lista de arquivos inválida.')
    const lista = arquivos.map((a, i) => ({
      nome: safeLocalName(String(a?.nome || `arquivo-${i + 1}`).slice(0, 255)),
      tamanho: Math.max(0, Math.floor(Number(a?.tamanho) || 0)),
      tipo: String(a?.tipo || '').slice(0, 100),
    }))
    const total = lista.reduce((s, a) => s + a.tamanho, 0)
    const pasta = st.celularPasta
    const livre = await espacoLivre(pasta)
    if (livre != null && livre < total + FOLGA) return { aceito: false, motivo: `Falta espaço no computador (precisa de ${Math.ceil((total + FOLGA) / 1e9)} GB).` }
    try {
      await fsp.mkdir(path.join(pasta, RECEBENDO), { recursive: true })
    } catch (err) {
      return { aceito: false, motivo: `Não deu para usar a pasta ${pasta} (${err.code || err.message}).` }
    }
    const dono = de?.conta === 'outra' && typeof de?.dono === 'string' ? de.dono.slice(0, 60) : null
    const aparelho = { id: typeof de?.id === 'string' ? de.id : '', nome: String(de?.nome || 'Celular').slice(0, 60), dono }
    const t = this.#nova({ id: tid, direcao: 'recebendo', aparelho, arquivos: lista, pasta, estado: 'andando' })
    if (typeof oferta === 'string' && oferta.length <= 100) t.oferta = oferta // o celular cancelar pelo site acha esta
    return { aceito: true }
  }

  /** Grava um pedaço do arquivo `i` a partir de `offset` (precisa ser exatamente onde parou). */
  async escrever(tid, i, offset, origem) {
    const t = this.transfers.get(tid)
    if (!t || t.direcao !== 'recebendo') throw new CelularError(404, 'Transferência não encontrada.')
    if (!ATIVO.has(t.estado)) throw new CelularError(409, 'Essa transferência já terminou.')
    const a = t.arquivos[Number(i)]
    if (!a || a.final) throw new CelularError(404, 'Arquivo não encontrado.')
    a.gravado ??= 0
    if (offset !== a.gravado) throw new CelularError(409, `Pedaço fora de ordem (esperava ${a.gravado}).`)
    if (a.ocupado) throw new CelularError(409, 'Esse arquivo já está sendo gravado.')
    a.ocupado = true
    try {
      if (!a.parcial) a.parcial = path.join(t.pasta, RECEBENDO, `${t.id}-${i}.parcial`)
      const out = fs.createWriteStream(a.parcial, { flags: offset === 0 ? 'w' : 'a' })
      let n = 0
      const limite = new Transform({
        transform(chunk, _enc, cb) {
          n += chunk.length
          if (n > MAX_PUT || a.gravado + n > a.tamanho) return cb(new CelularError(413, `${a.nome} veio maior do que o anunciado.`))
          cb(null, chunk)
        },
      })
      try {
        await pipeline(origem, limite, out)
      } catch (err) {
        // O que entrou deste pedaço não vale: volta ao último ponto confirmado (o próximo PUT continua dali).
        await fsp.truncate(a.parcial, a.gravado).catch(() => {})
        throw err
      }
      a.gravado += n
      t.feitos += n
      this.#andou(t)
      return { offset: a.gravado }
    } finally {
      a.ocupado = false
    }
  }

  /** Arquivo `i` completo: fsync e o nome final sem colisão. */
  async fecharArquivo(tid, i) {
    const t = this.transfers.get(tid)
    if (!t || t.direcao !== 'recebendo') throw new CelularError(404, 'Transferência não encontrada.')
    const a = t.arquivos[Number(i)]
    if (!a) throw new CelularError(404, 'Arquivo não encontrado.')
    if (a.final) return { nome: path.basename(a.final) }
    if ((a.gravado ?? 0) !== a.tamanho) throw new CelularError(409, `${a.nome} chegou incompleto.`)
    if (!a.parcial) {
      a.parcial = path.join(t.pasta, RECEBENDO, `${t.id}-${i}.parcial`)
      await fsp.writeFile(a.parcial, '')
    }
    const fh = await fsp.open(a.parcial, 'r+')
    try {
      await fh.sync()
    } finally {
      await fh.close()
    }
    const alvo = await nomeLivre(path.join(t.pasta, a.nome))
    await fsp.rename(a.parcial, alvo)
    a.final = alvo
    a.parcial = null
    t.prontos++
    if (t.prontos === t.arquivos.length) await this.#encerrar(t, 'pronto')
    else this.#avisar()
    return { nome: path.basename(alvo) }
  }

  // ───── andamento (os dois sentidos) ─────

  /** A janela oculta conta como está: { estado: 'conectando'|'andando'|'pronto'|'erro', bytes?, erro? }. */
  async estado(tid, { estado, bytes, erro } = {}) {
    const t = this.transfers.get(tid)
    if (!t) throw new CelularError(404, 'Transferência não encontrada.')
    if (!ATIVO.has(t.estado)) return this.#publico(t)
    if (t.direcao === 'enviando' && Number.isFinite(Number(bytes))) {
      t.feitos = Math.max(0, Math.min(t.total, Math.floor(Number(bytes))))
      this.#andou(t)
    }
    if (estado === 'conectando' || estado === 'andando') {
      if (t.estado !== estado) this.#mudar(t, { estado })
    } else if (estado === 'pronto') {
      if (t.direcao === 'enviando') {
        t.feitos = t.total
        t.prontos = t.arquivos.length
        await this.#encerrar(t, 'pronto')
      }
    } else if (estado === 'erro') {
      // Não conectou: talvez o macOS tenha passado a bloquear a rede local; confere de novo para a tela avisar.
      this.conferirRede({ forcar: true }).catch(() => {})
      await this.#encerrar(t, 'erro', typeof erro === 'string' && erro ? erro.slice(0, 300) : 'A transferência parou.')
    }
    return this.#publico(t)
  }

  async cancelar(tid) {
    const t = this.transfers.get(tid)
    if (!t) throw new CelularError(404, 'Transferência não encontrada.')
    if (!ATIVO.has(t.estado)) return this.#publico(t)
    const avisarSite = t.oferta && t.estado === 'esperando' && t.direcao === 'enviando'
    await this.#encerrar(t, 'cancelado', 'Cancelado.')
    this.hub?.send('celular-cancelar', { tid: t.id, oferta: t.oferta || null })
    if (avisarSite) await this.sinal({ para: t.aparelho.id, tipo: 'cancela', oferta: t.oferta }).catch(() => {})
    return this.#publico(t)
  }

  /** A janela oculta conta que um celular tentou e a ligação direta não abriu (com o que cada lado anunciou). */
  falha(erro) {
    this.ultimaFalha = { quando: Date.now(), erro: String(erro || 'Não deu para conectar.').slice(0, 400) }
    this.log('celular: não conectou', this.ultimaFalha.erro)
    this.conferirRede({ forcar: true }).catch(() => {})
    this.#avisar()
    return { ok: true }
  }

  /** Tira da lista o que já terminou. */
  limpar() {
    for (const [id, t] of this.transfers) if (!ATIVO.has(t.estado)) this.transfers.delete(id)
    this.#avisar()
    return this.view()
  }

  view() {
    const st = this.settings.get()
    const agora = Date.now()
    for (const [id, t] of this.transfers) if (!ATIVO.has(t.estado) && agora - (t.fim || t.inicio) > GUARDA_MS) this.transfers.delete(id)
    const lista = [...this.transfers.values()].sort((a, b) => b.inicio - a.inicio).slice(0, MAX_HISTORICO)
    return {
      receber: !!st.celularReceber,
      pasta: st.celularPasta,
      conectado: !!this.cloud()?.signedIn,
      // Sem a janela oculta (npm start, teste), o computador não fala com o celular.
      pronto: this.janelaPronta(),
      outros: !!st.celularOutros,
      // macOS 15+: 'bloqueada' = sem a permissão de Rede Local (a tela mostra como ligar); null fora do Mac ou sem saber.
      redeLocal: this.redeLocal.estado,
      // macOS: Firewall ligado sem "Permitir" para o SOBEDESCE (firewall.js); null fora do Mac.
      firewall: this.firewall.estado,
      ultimaFalha: this.ultimaFalha && Date.now() - this.ultimaFalha.quando < 30 * 60_000 ? this.ultimaFalha : null,
      celulares: this.celulares,
      pedidos: [...this.pedidos.values()].map((p) => this.#pedidoPublico(p.sinal)),
      transferencias: lista.map((t) => this.#publico(t)),
    }
  }

  // ───── interno ─────

  #nova({ id, direcao, aparelho, arquivos, pasta, estado = 'conectando' }) {
    const t = {
      id: id || novoId('cel'),
      direcao,
      aparelho,
      arquivos,
      pasta,
      total: arquivos.reduce((s, a) => s + a.tamanho, 0),
      feitos: 0,
      prontos: 0,
      estado,
      erro: null,
      oferta: null,
      inicio: Date.now(),
      fim: null,
      velocidade: 0,
      amostra: { at: Date.now(), bytes: 0 },
    }
    this.transfers.set(t.id, t)
    this.#avisar()
    return t
  }

  #andou(t) {
    if (t.estado === 'conectando' || t.estado === 'esperando') t.estado = 'andando'
    const agora = Date.now()
    const dt = agora - t.amostra.at
    if (dt >= 500) {
      const v = ((t.feitos - t.amostra.bytes) * 1000) / dt
      t.velocidade = t.velocidade ? t.velocidade * 0.6 + v * 0.4 : v
      t.amostra = { at: agora, bytes: t.feitos }
      this.#avisar()
    }
  }

  #mudar(t, patch) {
    Object.assign(t, patch)
    this.#avisar()
  }

  async #encerrar(t, estado, erro = null) {
    t.estado = estado
    t.erro = erro
    t.fim = Date.now()
    t.velocidade = 0
    if (t.direcao === 'recebendo' && estado !== 'pronto') await this.#descartar(t).catch(() => {})
    if (estado === 'pronto') {
      const n = t.arquivos.length
      const quem = t.aparelho.dono ? `${t.aparelho.nome} (${t.aparelho.dono})` : t.aparelho.nome
      const msg = t.direcao === 'recebendo' ? `${n === 1 ? '1 arquivo' : `${n} arquivos`} do ${quem} chegaram em ${path.basename(t.pasta)}.` : `${n === 1 ? '1 arquivo foi' : `${n} arquivos foram`} para o ${quem}.`
      this.hub?.send('toast', { kind: 'success', message: msg })
    }
    this.#avisar()
  }

  async #descartar(t) {
    for (const a of t.arquivos) {
      if (a.parcial) await fsp.rm(a.parcial, { force: true }).catch(() => {})
      a.parcial = null
    }
  }

  #publico(t) {
    return {
      id: t.id,
      direcao: t.direcao,
      aparelho: t.aparelho.nome,
      dono: t.aparelho.dono || null,
      arquivos: t.arquivos.length,
      prontos: t.prontos,
      total: t.total,
      feitos: t.feitos,
      velocidade: Math.round(t.velocidade || 0),
      estado: t.estado,
      erro: t.erro,
      pasta: t.pasta,
      primeiro: t.arquivos[0]?.final || null,
      nomes: t.arquivos.slice(0, 3).map((a) => (a.final ? path.basename(a.final) : a.nome)),
      inicio: t.inicio,
      fim: t.fim,
    }
  }

  #avisar() {
    this.hub?.send('celular', this.view())
  }
}

const ATIVO = new Set(['esperando', 'conectando', 'andando'])
