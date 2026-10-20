// "Entre computadores" (docs/LAN.md), lado de quem MANDA: pega no site a lista dos computadores da conta (endereço na
// rede + chave de recepção), acha o endereço que responde (ping cifrado), oferece a lista de arquivos e manda cada um
// em pedaços de até 1 GB cifrados (cripto.js). Lê o arquivo uma vez, calculando o xxHash64 no caminho; no fim o outro
// computador confere com o dele. Caiu a conexão: pergunta onde parou e segue (até 6 tentativas por arquivo).
// Vários arquivos pequenos ao mesmo tempo; um grande por vez.
import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { abrir, BLOCO, chaveParaOutraConta, cifradorDeDados, meta, selar } from './cripto.js'
import { criarHash } from '../discos/copiar.js'
import { scanLocal } from '../local/scan.js'
import { SISTEMA } from '../discos/planejar.js'

export const PEDACO = 1024 * 1024 * 1024 // um PUT leva até 1 GB (retomada e progresso por pedaço)
const SIMULTANEOS = 8
const GRANDE = 64 * 1024 * 1024
const TENTATIVAS = 6
const PING_MS = 2500
const JANELA_MS = 3000
const ESPERA_ACEITE_MS = 3 * 60_000 // outra conta: quanto tempo espera a pessoa aceitar
const CONSULTA_ACEITE_MS = 1500

export class EnvioError extends Error {
  constructor(message, { status = 0, offset = null } = {}) {
    super(message)
    this.name = 'EnvioError'
    this.status = status
    this.offset = offset
  }
}

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms))
/** Espera a rede esvaziar o que foi escrito (ou o pedido fechar), sem deixar ouvintes para trás. */
const esvaziar = (req) =>
  new Promise((ok) => {
    const fim = () => {
      req.off('drain', fim)
      req.off('close', fim)
      ok()
    }
    req.on('drain', fim)
    req.on('close', fim)
  })
const hostDe = (ip) => (ip.includes(':') ? `[${ip}]` : ip)

/** Um pedido ao outro computador. `corpo`: objeto (selado) ou função que escreve o corpo no `req` (dados). */
export function pedir({ agente, endereco, porta, chave, eph = null, metodo, caminho, corpo, extraMeta = {}, timeoutMs = 30_000 }) {
  return new Promise((ok, falha) => {
    const selado = typeof corpo === 'function' || corpo === undefined ? null : selar(chave, corpo, `${metodo} ${caminho}`)
    const req = http.request(
      {
        host: endereco,
        port: porta,
        method: metodo,
        path: caminho,
        agent: agente,
        headers: {
          'x-sd-meta': meta(chave, metodo, caminho, extraMeta),
          ...(eph ? { 'x-sd-eph': eph } : {}),
          'content-type': 'application/octet-stream',
          ...(selado ? { 'content-length': selado.length } : {}),
        },
      },
      (res) => {
        const partes = []
        res.on('data', (p) => partes.push(p))
        res.on('end', () => {
          const buf = Buffer.concat(partes)
          if (res.statusCode === 403) return falha(new EnvioError('O outro computador recusou a chave (saiu da conta ou trocou a chave?).', { status: 403 }))
          let r = null
          try {
            r = buf.length ? abrir(chave, buf, `resp ${metodo} ${caminho}`) : null
          } catch {
            return falha(new EnvioError('Resposta ilegível do outro computador.', { status: res.statusCode }))
          }
          if (res.statusCode >= 400) return falha(new EnvioError(r?.erro || `Erro ${res.statusCode} no outro computador.`, { status: res.statusCode, offset: r?.offset ?? null }))
          ok(r)
        })
        res.on('error', falha)
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new EnvioError('O outro computador parou de responder.')))
    req.on('error', (err) => falha(err instanceof EnvioError ? err : new EnvioError(`Sem conexão com o outro computador (${err.code || err.message}).`)))
    if (typeof corpo === 'function') corpo(req)
    else req.end(selado)
  })
}

/**
 * Junta origens (pastas e arquivos) numa lista. Uma pasta só: o que tem dentro vai direto para a pasta do destino
 * (que já leva o nome dela). Várias: cada pasta entra com o nome ("Cam A/…"); arquivo solto, pelo nome.
 */
export async function listarOrigens(origens, { signal } = {}) {
  const arquivos = []
  const vistos = new Set()
  for (const o of origens) {
    const lido = await scanLocal(o, { signal })
    const prefixo = lido.root.isDir && origens.length > 1 ? lido.root.name : ''
    for (const f of lido.files) {
      if (SISTEMA.test(f.relPath)) continue
      const rel = prefixo ? `${prefixo}/${f.relPath}` : f.relPath
      if (vistos.has(rel.toLowerCase())) continue
      vistos.add(rel.toLowerCase())
      arquivos.push({ relPath: rel, caminho: f.path, size: f.size, mtimeMs: f.mtimeMs })
    }
  }
  return arquivos.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
}

export class LanEnviador {
  /**
   * @param {{ cloud: { request: Function }, nome: () => Promise<string>|string, onChange?: Function,
   *           subirDrive?: (o: { caminhos: string[], accountId: string, folderId: string, folderName?: string }) => Promise<object>,
   *           log?: Function }} o
   */
  constructor({ cloud, nome, pessoa = () => null, onChange = () => {}, subirDrive = null, log = null, pedaco = PEDACO }) {
    this.pedaco = pedaco
    this.pessoa = pessoa
    this.cloud = cloud
    this.nome = nome
    this.onChange = onChange
    this.subirDrive = subirDrive
    this.log = log || (() => {})
    this.envio = null
    this.ultimoAviso = 0
    this.timer = null
  }

  /**
   * Os computadores da conta com a recepção ligada e os de outras contas por perto (mesma rede, aceitam pedidos).
   * As chaves ficam aqui dentro; a tela recebe só nome, plataforma e dono.
   */
  async computadores() {
    if (!this.cloud?.signedIn) return { conectado: false, computadores: [], porPerto: [] }
    const [minha, perto] = await Promise.all([
      this.cloud.request('GET', '/api/lan/computadores'),
      this.cloud.request('GET', '/api/lan/proximos').catch(() => ({ data: { computadores: [] } })),
    ])
    const daConta = (minha.data?.computadores || []).map((c) => ({ ...c, tipo: 'conta' }))
    const outros = (perto.data?.computadores || []).map((c) => ({ ...c, tipo: 'outro' }))
    this.cache = new Map([...daConta, ...outros].map((c) => [c.id, c]))
    const limpar = ({ chave, chavePublica, ...c }) => c
    return { conectado: true, computadores: daConta.map(limpar), porPerto: outros.map(limpar) }
  }

  /** Acha um endereço que responde com a chave certa (todos ao mesmo tempo; vale o primeiro). */
  async #alcancar(c, chave, eph) {
    const tentativas = c.enderecos.map((ip) =>
      pedir({ endereco: ip, porta: c.porta, chave, eph, metodo: 'POST', caminho: '/lan/v1/ping', corpo: {}, timeoutMs: PING_MS }).then((r) => ({ ip, r })),
    )
    try {
      return await Promise.any(tentativas)
    } catch (err) {
      const recusou = err.errors?.find((e) => e.status === 403)
      if (recusou && c.tipo === 'outro') throw new EnvioError(`${c.nome} não está aceitando pedidos de outras contas agora.`)
      throw new EnvioError(recusou ? recusou.message : `${c.nome} não respondeu nesta rede. Os dois computadores estão na mesma rede (Wi-Fi ou cabo)?`)
    }
  }

  view() {
    const e = this.envio
    if (!e) return { envio: null }
    const agora = Date.now()
    while (e.amostras.length > 1 && agora - e.amostras[0].t > JANELA_MS) e.amostras.shift()
    const a = e.amostras
    const janela = a.length > 1 ? (a.at(-1).b - a[0].b) / ((a.at(-1).t - a[0].t) / 1000) : 0
    const decorrido = Math.max(0.001, ((e.fim || agora) - e.inicio) / 1000)
    const media = e.enviados / decorrido
    const ritmo = janela > 0 ? 0.5 * janela + 0.5 * media : media
    return {
      envio: {
        id: e.id,
        para: e.para,
        dono: e.dono,
        endereco: e.endereco,
        pasta: e.pasta,
        fase: e.fase,
        erro: e.erro,
        arquivos: e.lista.length,
        prontos: e.prontos,
        iguais: e.iguais,
        falhas: e.falhas,
        bytes: e.total,
        enviados: e.enviados,
        atual: e.atual,
        inicio: e.inicio,
        decorrido,
        velocidade: Math.round(janela),
        velocidadeMedia: Math.round(media),
        restante: e.fim ? 0 : ritmo > 0 ? Math.round(Math.max(0, e.total - e.enviados) / ritmo) : null,
        drive: e.drive,
      },
    }
  }

  #mudou(forcar = false) {
    const agora = Date.now()
    if (!forcar && agora - this.ultimoAviso < 250) {
      if (!this.timer) this.timer = setTimeout(() => ((this.timer = null), this.#mudou(true)), 250)
      return
    }
    this.ultimoAviso = agora
    try {
      this.onChange(this.view())
    } catch {}
  }

  /**
   * @param {{ para: string, origens: string[], pasta?: string, drive?: { accountId: string, folderId: string, folderName?: string } }} o
   */
  async enviar({ para, origens, pasta, drive = null }) {
    if (this.envio?.fase === 'enviando' || this.envio?.fase === 'preparando') throw new EnvioError('Já tem um envio em andamento.', { status: 409 })
    if (!this.cache?.has(para)) await this.computadores()
    const c = this.cache?.get(para)
    if (!c) throw new EnvioError('Esse computador não está com a recepção ligada (ou saiu da conta).', { status: 404 })
    if (!Array.isArray(origens) || !origens.length) throw new EnvioError('Escolha o que mandar.', { status: 400 })
    const e = {
      id: crypto.randomUUID(),
      para: c.nome,
      dono: c.tipo === 'outro' ? c.dono : null,
      paraId: c.id,
      endereco: null,
      pasta: String(pasta || '').trim() || path.basename(origens[0]) || 'Arquivos',
      fase: 'preparando',
      erro: null,
      lista: [],
      total: 0,
      enviados: 0,
      prontos: 0,
      iguais: 0,
      falhas: [],
      atual: null,
      inicio: Date.now(),
      fim: null,
      amostras: [{ t: Date.now(), b: 0 }],
      drive: drive ? { pedido: true, ok: null, erro: null } : null,
      ac: new AbortController(),
    }
    this.envio = e
    this.#mudou(true)
    this.rodando = this.#rodar(e, c, origens, drive).catch((err) => {
      e.fase = e.ac.signal.aborted ? 'cancelado' : 'erro'
      e.erro = e.ac.signal.aborted ? null : err.message
      e.fim = Date.now()
      this.#mudou(true)
    })
    return this.view()
  }

  cancelar() {
    this.envio?.ac.abort()
    return this.view()
  }

  /** Tira o envio terminado da tela. */
  limpar() {
    if (this.envio && ['preparando', 'enviando'].includes(this.envio.fase)) throw new EnvioError('Pare o envio antes.', { status: 409 })
    this.envio = null
    this.#mudou(true)
    return this.view()
  }

  async #rodar(e, c, origens, drive) {
    // Outra conta: chave só deste envio, combinada com a chave pública dela (só aquele computador abre).
    const { chave, efemera } = c.tipo === 'outro' ? chaveParaOutraConta(c.chavePublica) : { chave: c.chave, efemera: null }
    const { ip } = await this.#alcancar(c, chave, efemera)
    e.endereco = ip
    e.lista = await listarOrigens(origens, { signal: e.ac.signal })
    if (!e.lista.length) throw new EnvioError('Nada para mandar (pasta vazia?).')
    e.total = e.lista.reduce((s, a) => s + a.size, 0)
    // O Drive ao mesmo tempo: os mesmos arquivos entram na fila de subida (o motor de sempre, retomável).
    if (drive && this.subirDrive) {
      this.subirDrive({ caminhos: origens, ...drive }).then(
        () => (e.drive.ok = true),
        (err) => ((e.drive.ok = false), (e.drive.erro = err.message)),
      )
    }
    const agente = new http.Agent({ keepAlive: true, maxSockets: SIMULTANEOS })
    const alvo = { agente, endereco: ip, porta: c.porta, chave, eph: efemera }
    e.de = String((await this.nome()) || 'Outro computador')
    const pessoa = (await Promise.resolve(this.pessoa?.()).catch(() => null)) || null
    const lista = e.lista.map((a) => ({ relPath: a.relPath, size: a.size, mtimeMs: a.mtimeMs }))
    // A mesma oferta de novo devolve onde cada arquivo parou (retomada).
    const oferecer = () => pedir({ ...alvo, metodo: 'POST', caminho: '/lan/v1/ofertas', corpo: { id: e.id, de: e.de, pessoa, pasta: e.pasta, arquivos: lista } })
    try {
      let of = await oferecer()
      // Outra conta: a pessoa precisa aceitar na tela dela. Pergunta de novo até aceitar, recusar ou cansar.
      if (of.aguardando) {
        e.fase = 'aguardando'
        this.#mudou(true)
        const limite = Date.now() + ESPERA_ACEITE_MS
        while (of.aguardando) {
          if (e.ac.signal.aborted) throw new EnvioError('Cancelado.')
          if (Date.now() > limite) throw new EnvioError(`${c.dono || c.nome} não respondeu a tempo.`)
          await esperar(CONSULTA_ACEITE_MS)
          of = await oferecer()
        }
      }
      if (of.recusada) throw new EnvioError(`${c.dono || c.nome} recusou o envio.`)
      e.pasta = of.pasta || e.pasta
      e.fase = 'enviando'
      const pular = new Set(of.arquivos.filter((x) => x.estado === 'igual' || x.estado === 'pronto').map((x) => x.n))
      for (const n of pular) {
        e.iguais++
        e.total -= e.lista[n].size
      }
      this.#mudou(true)

      let livres = SIMULTANEOS
      const fila = []
      const pegar = (peso) => new Promise((ok) => {
        const t = () => (livres >= peso ? ((livres -= peso), ok(), true) : false)
        if (!fila.length && t()) return
        fila.push(t)
      })
      const soltar = (peso) => {
        livres += peso
        while (fila.length && fila[0]()) fila.shift()
      }
      const rodando = new Set()
      for (let n = 0; n < e.lista.length; n++) {
        if (pular.has(n)) continue
        const peso = e.lista[n].size >= GRANDE ? SIMULTANEOS : 1
        await pegar(peso)
        if (e.ac.signal.aborted) {
          soltar(peso)
          break
        }
        const t = this.#umArquivo(e, alvo, n, oferecer).finally(() => (rodando.delete(t), soltar(peso)))
        rodando.add(t)
      }
      await Promise.all(rodando)
      await pedir({ ...alvo, metodo: 'POST', caminho: `/lan/v1/ofertas/${e.id}/fim`, corpo: { cancelada: e.ac.signal.aborted } }).catch(() => {})
      e.fase = e.ac.signal.aborted ? 'cancelado' : e.falhas.length ? 'com-falhas' : 'pronto'
      e.fim = Date.now()
      e.atual = null
      this.#mudou(true)
    } finally {
      agente.destroy()
    }
  }

  /** Um arquivo: pedaços de até 1 GB; se cair, pergunta onde parou e segue. O xxHash64 é do arquivo inteiro. */
  async #umArquivo(e, alvo, n, oferecer) {
    const a = e.lista[n]
    e.atual = a.relPath
    let contado = 0 // bytes deste arquivo já somados no progresso
    const somar = (b) => {
      e.enviados += b - contado
      contado = b
      e.amostras.push({ t: Date.now(), b: e.enviados })
      if (e.amostras.length > 400) e.amostras.splice(0, 200)
      this.#mudou()
    }
    let offset = 0
    for (let tentativa = 1; ; tentativa++) {
      if (e.ac.signal.aborted) return
      try {
        const hash = await this.#mandar(e, alvo, n, a, offset, somar)
        const fim = await pedir({ ...alvo, metodo: 'POST', caminho: `/lan/v1/ofertas/${e.id}/${n}/fim`, corpo: { hash } })
        if (!fim.ok) throw new EnvioError(fim.erro || 'O outro computador não confirmou.', { offset: 0 })
        e.prontos++
        somar(a.size)
        return
      } catch (err) {
        if (e.ac.signal.aborted) return
        if (tentativa >= TENTATIVAS || err.status === 403 || err.status === 507) {
          e.falhas.push({ relPath: a.relPath, erro: err.message })
          somar(a.size) // o progresso anda (o total fecha); a falha fica na lista
          return
        }
        await esperar(Math.min(8000, 500 * 2 ** tentativa))
        // Onde o outro parou: a oferta de novo devolve a posição de cada arquivo (ou o 409 do PUT já disse).
        if (err.offset != null) offset = err.offset
        else {
          const of = await oferecer().catch(() => null)
          offset = of?.arquivos?.[n]?.offset ?? 0
        }
        somar(offset)
      }
    }
  }

  /** Manda de `offset` até o fim (em pedaços); devolve o xxHash64 do arquivo inteiro. */
  async #mandar(e, alvo, n, a, offset, somar) {
    const hash = await criarHash('xxh64')
    const fh = await fsp.open(a.caminho, 'r')
    try {
      // Retomada: o começo (que o outro já tem) só passa pelo xxHash.
      const buf = Buffer.allocUnsafe(Math.min(BLOCO, Math.max(64 * 1024, a.size)))
      let pos = 0
      while (pos < offset) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, offset - pos), pos)
        if (!bytesRead) throw new EnvioError('O arquivo diminuiu no meio do envio.')
        hash.update(buf.subarray(0, bytesRead))
        pos += bytesRead
      }
      while (pos < a.size) {
        const fimPedaco = Math.min(a.size, pos + this.pedaco)
        const sessao = crypto.randomBytes(16).toString('base64url')
        const cifrar = cifradorDeDados(alvo.chave, { oferta: e.id, sessao, arquivo: n, offset: pos })
        const inicio = pos
        const r = await pedir({
          ...alvo,
          metodo: 'PUT',
          caminho: `/lan/v1/ofertas/${e.id}/${n}`,
          extraMeta: { sessao, offset: inicio },
          timeoutMs: 60_000,
          corpo: (req) => {
            ;(async () => {
              try {
                // Dois buffers: o próximo bloco vem do disco enquanto o atual é cifrado e vai pela rede (a cifra copia,
                // então o buffer volta livre logo depois).
                const bufs = [Buffer.allocUnsafe(Math.min(BLOCO, Math.max(1, fimPedaco - pos))), Buffer.allocUnsafe(Math.min(BLOCO, Math.max(1, fimPedaco - pos)))]
                let q = 0
                const ler = (p) => fh.read(bufs[q], 0, Math.min(bufs[q].length, fimPedaco - p), p)
                let leitura = ler(pos)
                while (pos < fimPedaco) {
                  if (e.ac.signal.aborted) throw new Error('cancelado')
                  const { bytesRead, buffer } = await leitura
                  if (!bytesRead) throw new EnvioError('O arquivo diminuiu no meio do envio.')
                  const parte = buffer.subarray(0, bytesRead)
                  pos += bytesRead
                  q ^= 1
                  leitura = pos < fimPedaco ? ler(pos) : null
                  hash.update(parte)
                  const ok = req.write(cifrar(parte))
                  somar(pos)
                  // Espera a rede esvaziar; se o pedido morreu (o outro respondeu antes, a conexão caiu), para.
                  if (!ok) await esvaziar(req)
                  if (req.destroyed) {
                    await leitura?.catch(() => {})
                    return
                  }
                }
                req.end()
              } catch (err) {
                req.destroy(err)
              }
            })()
          },
        })
        if (r.offset !== fimPedaco) throw new EnvioError('O outro computador não guardou tudo.', { offset: r.offset })
      }
      return hash.hex()
    } finally {
      await fh.close().catch(() => {})
    }
  }

  async close() {
    this.envio?.ac.abort()
    clearTimeout(this.timer)
    await this.rodando?.catch(() => {})
  }
}
