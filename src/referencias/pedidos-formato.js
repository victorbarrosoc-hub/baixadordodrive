// "Baixar como…" pedido pelo celular (docs/REFERENCIAS.md §7): o celular não tem ffmpeg, então pede ao computador.
// O site guarda o pedido na mesma fila dos pedidos de proxy e de Frames (tipo "formato", ajustes { formato }) e este
// computador, com a mesma conta, pega um por vez, converte pelo serviço das Referências (o original vem do Drive) e
// sobe o convertido ao lado do original. O celular vê o arquivo novo na coleção e salva no aparelho por lá.
//
//   a cada 30 s ──▶ GET /api/proxies/pedidos?status=pendente&tipo=formato ──▶ POST …/pegar (409 = outro levou)
//               ──▶ ReferenciasService.exportar(destino 'drive') ──▶ PATCH pronto { resultado, proxyFileId } | erro
//
// Sem ffmpeg aqui, não pega nada (fica para outro computador). Site antigo (sem o tipo "formato"): pausa 30 min.
import { HttpError } from '../net/http.js'
import { isAbortError } from '../util/backoff.js'
import { FORMATOS, ehFormato } from './formatos.js'

const POLL_MS = 30_000
const VIDA_MS = 5 * 60_000
const SEM_SITE_MS = 30 * 60_000

const corta = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n)

export class PedidosFormato {
  /**
   * @param {object} o
   * @param {{ signedIn: boolean, request(method, path, opts): Promise<{ status, data }> }} o.cloud conta SOBEDESCE
   * @param {() => import('./service.js').ReferenciasService|null} o.referencias
   * Trocáveis nos testes: pollMs, vidaMs, log.
   */
  constructor({ cloud, referencias, pollMs = POLL_MS, vidaMs = VIDA_MS, log } = {}) {
    this.cloud = cloud
    this.referencias = referencias
    this.pollMs = pollMs
    this.vidaMs = vidaMs
    this.log = log || ((...a) => console.warn('[formatos]', ...a))
    this.timer = null
    this.rodando = null
    this.atual = null // { id, jobId }
    this.pausaAte = 0
    this.closed = false
  }

  start() {
    this.#planejar(10_000)
  }

  async close() {
    this.closed = true
    clearTimeout(this.timer)
    this.timer = null
    if (this.atual?.jobId) await this.referencias?.()?.cancelar(this.atual.jobId).catch(() => {})
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

  /** Pega e faz os pedidos pendentes, um por vez (os mais antigos primeiro). Devolve quantos terminaram aqui. */
  async consultar() {
    if (this.rodando) return this.rodando
    this.rodando = (async () => {
      try {
        const svc = this.referencias?.()
        if (this.closed || !svc || !this.cloud?.signedIn || Date.now() < this.pausaAte) return 0
        let pedidos
        try {
          const d = await this.#api('GET', '/api/proxies/pedidos?status=pendente&tipo=formato')
          pedidos = Array.isArray(d.pedidos) ? d.pedidos.filter(p => p?.tipo === 'formato') : []
        } catch (err) {
          if (err instanceof HttpError && [400, 403, 404].includes(err.status)) this.pausaAte = Date.now() + SEM_SITE_MS
          else if (err?.kind !== 'reauth' && !isAbortError(err)) this.log('não consegui ver os pedidos de formato:', err?.message)
          return 0
        }
        if (!pedidos.length) return 0
        const conv = await svc.conversor().catch(() => null)
        if (!conv?.ffmpeg) return 0 // sem conversor aqui: deixa para outro computador
        let feitos = 0
        for (const p of pedidos.slice().reverse()) {
          if (this.closed || !this.cloud.signedIn) break
          if (p.status !== 'pendente' || typeof p.id !== 'string') continue
          if (await this.#fazer(p, svc)) feitos++
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
    await this.#api('PATCH', `/api/proxies/pedidos/${encodeURIComponent(id)}`, corpo).catch(err => this.log('não consegui avisar o site sobre o pedido de formato:', err?.message))
  }

  async #fazer(p, svc) {
    try {
      if (!(await this.#pegar(p.id))) return false
    } catch (err) {
      this.log('não consegui pegar o pedido de formato:', err?.message)
      return false
    }
    const formato = p.ajustes?.formato
    let trabalho
    try {
      if (!ehFormato(formato) || formato === 'original') throw new Error('Formato desconhecido. Atualize o SOBEDESCE do computador.')
      trabalho = await svc.exportar({ accountId: `nuvem:${p.contaGoogleId}`, fileId: p.fileId, formato, destino: 'drive', pedidoId: p.id, origem: 'pedido' })
    } catch (err) {
      await this.#contar(p.id, { status: 'erro', erro: corta(err?.message || 'Não deu para converter.', 300) })
      return true
    }
    this.atual = { id: p.id, jobId: trabalho.id }
    let largado = false
    const vida = setInterval(() => {
      this.#api('PATCH', `/api/proxies/pedidos/${encodeURIComponent(p.id)}`, { status: 'gerando' }).catch(err => {
        if (err instanceof HttpError && (err.status === 404 || err.status === 409)) {
          largado = true // cancelado no celular (ou outro computador levou): para aqui também
          svc.cancelar(trabalho.id).catch(() => {})
        }
      })
    }, this.vidaMs)
    vida.unref?.()
    try {
      const fim = await svc.esperar(trabalho.id)
      if (largado) return false
      if (fim?.fase === 'pronto') {
        const resultado = corta(`${FORMATOS[formato].curto} salvo ao lado do original`, 200)
        await this.#contar(p.id, { status: 'pronto', resultado, proxyFileId: fim.driveFileId || null })
        this.log(`pedido do celular: ${p.nome || p.fileId} → ${resultado}`)
        return true
      }
      if (fim?.fase === 'cancelado') {
        await this.#contar(p.id, this.closed ? { status: 'pendente' } : { status: 'erro', erro: 'Cancelado no computador.' })
        return false
      }
      await this.#contar(p.id, { status: 'erro', erro: corta(fim?.erro?.mensagem || 'Não deu para converter.', 300) })
      return true
    } finally {
      clearInterval(vida)
      this.atual = null
    }
  }
}
