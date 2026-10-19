// "Gerar proxy" pedido pelo celular (docs/CONTAS.md §11): o celular marca vídeos e o site guarda os pedidos; este
// computador, com a conta SOBEDESCE, pega um por vez e gera o proxy 720p e a tira de quadros (o hover scrub) igual ao
// "Gerar proxy" da tela Drive: usa o original que já está aqui (o envio que subiu ele) ou baixa do Drive.
//
//   a cada 30 s ──▶ GET /api/proxies/pedidos?status=pendente ──▶ POST …/pegar (409 = outro computador levou)
//               ──▶ gerarPreviasLote(só aquele arquivo) ──▶ PATCH pronto | erro
//
// Sem conversor (ffmpeg) aqui, não pega nada: outro computador da conta pode ter. Gerando, avisa o site a cada 5 min
// ("ainda estou nisso"); se o pedido sumiu (o celular cancelou) ou outro computador levou, para no meio.
import { HttpError } from '../net/http.js'
import { isAbortError } from '../util/backoff.js'
import { isBrawName, isVideoName } from '../media/previa.js'
import { gerarPreviasLote, originaisLocais } from '../media/previa-lote.js'
import { procurarProxy } from '../media/previa-fila.js'

const POLL_MS = 30_000
const VIDA_MS = 5 * 60_000
const SEM_SITE_MS = 30 * 60_000 // site sem a rota (versão antiga) ou recusando: pergunta de novo depois

const MSG = {
  naoVideo: 'Esse arquivo não é um vídeo.',
  sumiu: 'O arquivo não está mais no Drive.',
  formato: 'O computador não abre esse formato de câmera.',
  falhou: 'Não deu para gerar o proxy.',
  permissao: 'O Drive não deixou criar o proxy nessa pasta (sem permissão de edição).',
}

const corta = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n)

export class PedidosProxy {
  /**
   * @param {object} o
   * @param {{ signedIn: boolean, request(method, path, opts): Promise<{ status, data }> }} o.cloud conta SOBEDESCE
   * @param {object} o.manager TransferManager (driveFor, previas, records)
   * Trocáveis nos testes: pollMs, vidaMs, gerar (gerarPreviasLote), log.
   */
  constructor({ cloud, manager, pollMs = POLL_MS, vidaMs = VIDA_MS, gerar = gerarPreviasLote, log } = {}) {
    this.cloud = cloud
    this.manager = manager
    this.pollMs = pollMs
    this.vidaMs = vidaMs
    this.gerar = gerar
    this.log = log || ((...a) => console.warn('[proxies]', ...a))
    this.timer = null
    this.rodando = null
    this.atual = null // { id, ac }
    this.pausaAte = 0
    this.closed = false
  }

  start() {
    this.#planejar(5_000)
  }

  async close() {
    this.closed = true
    clearTimeout(this.timer)
    this.timer = null
    this.atual?.ac.abort()
    await this.rodando?.catch(() => {})
  }

  #planejar(ms = this.pollMs) {
    if (this.closed) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      this.consultar().catch(() => {})
    }, ms)
    this.timer.unref?.()
  }

  async #api(method, path, body) {
    const res = await this.cloud.request(method, path, { body, expect: [200, 201] })
    return res?.data && typeof res.data === 'object' ? res.data : {}
  }

  /** Pega e gera os pedidos pendentes, um por vez. Devolve quantos terminaram aqui (prontos ou com erro). */
  async consultar() {
    if (this.rodando) return this.rodando
    this.rodando = (async () => {
      try {
        if (this.closed || !this.cloud?.signedIn || Date.now() < this.pausaAte) return 0
        const gerador = this.manager?.previas
        if (!gerador?.gerarESubir) return 0
        let pedidos
        try {
          const d = await this.#api('GET', '/api/proxies/pedidos?status=pendente')
          pedidos = Array.isArray(d.pedidos) ? d.pedidos : []
        } catch (err) {
          if (err instanceof HttpError && [403, 404].includes(err.status)) this.pausaAte = Date.now() + SEM_SITE_MS
          else if (err?.kind !== 'reauth' && !isAbortError(err)) this.log('não consegui ver os pedidos de proxy:', err?.message)
          return 0
        }
        if (!pedidos.length) return 0
        const motor = await gerador.motor().catch(() => null)
        if (!motor?.via) return 0 // sem conversor aqui: deixa para outro computador
        let feitos = 0
        // O site manda os mais novos primeiro; gera na ordem em que o celular pediu.
        for (const p of pedidos.slice().reverse()) {
          if (this.closed || !this.cloud.signedIn) break
          if (p?.status !== 'pendente' || typeof p.id !== 'string') continue
          if (await this.#fazer(p, gerador)) feitos++
        }
        return feitos
      } finally {
        this.rodando = null
        this.#planejar()
      }
    })()
    return this.rodando
  }

  async #pegar(id) {
    try {
      await this.#api('POST', `/api/proxies/pedidos/${encodeURIComponent(id)}/pegar`, {})
      return true
    } catch (err) {
      if (err instanceof HttpError && (err.status === 409 || err.status === 404)) return false
      throw err
    }
  }

  async #contar(id, corpo) {
    await this.#api('PATCH', `/api/proxies/pedidos/${encodeURIComponent(id)}`, corpo).catch(err => this.log('não consegui avisar o site sobre o pedido de proxy:', err?.message))
  }

  /** Um pedido: pega, gera e conta. false = não era para este computador (outro levou, ou falha de rede ao pegar). */
  async #fazer(p, gerador) {
    try {
      if (!(await this.#pegar(p.id))) return false
    } catch (err) {
      this.log('não consegui pegar o pedido de proxy:', err?.message)
      return false
    }
    const ac = new AbortController()
    this.atual = { id: p.id, ac }
    // Sinal de vida; pedido cancelado no celular (404) ou levado por outro (409): para.
    const vida = setInterval(() => {
      this.#api('PATCH', `/api/proxies/pedidos/${encodeURIComponent(p.id)}`, { status: 'gerando' }).catch(err => {
        if (err instanceof HttpError && (err.status === 404 || err.status === 409)) ac.abort()
      })
    }, this.vidaMs)
    vida.unref?.()
    try {
      const r = await this.#gerar(p, gerador, ac.signal)
      if (ac.signal.aborted) return false
      await this.#contar(p.id, r.ok ? { status: 'pronto', resultado: r.resultado, proxyFileId: r.proxyFileId } : { status: 'erro', erro: r.erro })
      this.log(`pedido do celular: ${p.nome || p.fileId} → ${r.ok ? r.resultado : r.erro}`)
      return true
    } catch (err) {
      if (ac.signal.aborted || isAbortError(err)) {
        // Fechando o app: devolve para a fila (outro computador ou este, ao abrir de novo).
        if (this.closed) await this.#contar(p.id, { status: 'pendente' })
        return false
      }
      const semPermissao = err?.status === 403
      await this.#contar(p.id, { status: 'erro', erro: semPermissao ? MSG.permissao : corta(err?.message || MSG.falhou, 300) })
      return true
    } finally {
      clearInterval(vida)
      this.atual = null
    }
  }

  async #gerar(p, gerador, signal) {
    const accountId = `nuvem:${p.contaGoogleId}`
    const drive = this.manager.driveFor(accountId)
    let item
    try {
      item = await drive.getItem(p.fileId, { signal, media: true })
    } catch (err) {
      if (err?.status === 404) return { ok: false, erro: MSG.sumiu }
      throw err
    }
    if (item.isFolder || !(isVideoName(item.name) || isBrawName(item.name))) return { ok: false, erro: MSG.naoVideo }
    const parentId = item.parents?.[0]
    if (!parentId) return { ok: false, erro: MSG.sumiu }
    const s = await this.gerar({
      drive,
      gerador,
      driveFolderId: parentId,
      recursive: false,
      somente: [item.id],
      forcar: true,
      baixar: true,
      dicas: originaisLocais(this.manager, accountId),
      signal,
    })
    if (s.feitos > 0) return { ok: true, resultado: 'Proxy pronto', proxyFileId: s.feitosIds?.[0] || null }
    if (s.jaTinham > 0) {
      const found = await procurarProxy(drive, { parentId, name: item.name, driveId: item.driveId, excludeId: item.id, signal }).catch(() => ({ proxy: null }))
      return { ok: true, resultado: s.quadros > 0 ? 'Já tinha proxy; quadros prontos' : 'Já tinha proxy', proxyFileId: found.proxy?.id || null }
    }
    if (s.falhou > 0) return { ok: false, erro: corta(s.falhas?.[0]?.reason || MSG.falhou, 300) }
    if (s.total === 0) return { ok: false, erro: MSG.formato }
    return { ok: false, erro: MSG.falhou }
  }
}
