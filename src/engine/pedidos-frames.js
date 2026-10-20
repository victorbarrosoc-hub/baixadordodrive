// "Frames" pedido pelo celular (docs/FRAMES.md §Celular): o celular escolhe um vídeo do Drive e pede ao computador o
// trabalho completo (frames em alta, takes em 9:16 ou ProRes, TIFF); o site guarda o pedido (tipo "frames", na mesma
// fila dos pedidos de proxy) e este computador, com a mesma conta, pega um por vez, faz pelo Frames (src/frames/) e
// sobe a pasta pronta ao lado do vídeo no Drive.
//
//   a cada 30 s ──▶ GET /api/proxies/pedidos?status=pendente&tipo=frames ──▶ POST …/pegar (409 = outro levou)
//               ──▶ FramesService.iniciar(vídeo do Drive, subir 'junto') ──▶ PATCH pronto | erro
//
// Se a pessoa estiver fazendo Frames na tela deste computador, espera a vez. Sem conversor (ffmpeg), não pega nada.
import { HttpError } from '../net/http.js'
import { isAbortError } from '../util/backoff.js'

const POLL_MS = 30_000
const VIDA_MS = 5 * 60_000
const SEM_SITE_MS = 30 * 60_000

const corta = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n)
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`

/** Ajustes do pedido → ajustes do Frames (o site já confere; aqui confere de novo, com os padrões da tela). */
export function ajustesDoPedido(a) {
  const f = a?.frames || {}
  const q = Number.isInteger(f.quantidade) && f.quantidade >= 1 && f.quantidade <= 300 ? f.quantidade : 24
  const frames = { quantidade: q, formato: ['jpg', 'png', 'tiff'].includes(f.formato) ? f.formato : 'jpg', logo: false }
  let takes = null
  const t = a?.takes
  if (t && Number.isInteger(t.quantidade) && t.quantidade > 0) {
    takes = {
      quantidade: Math.min(60, t.quantidade),
      duracao: Math.max(1, Math.min(15, Number(t.duracao) || 3)),
      formato: ['original', '9:16', '4:5', '1:1'].includes(t.formato) ? t.formato : 'original',
      foco: 0.5,
      audio: t.audio !== false,
      fade: true,
      codec: t.codec === 'prores' ? 'prores' : 'h264',
      logo: false,
    }
  }
  return { frames, takes, logo: null, destino: null, subir: 'junto' }
}

export class PedidosFrames {
  /**
   * @param {object} o
   * @param {{ signedIn: boolean, request(method, path, opts): Promise<{ status, data }> }} o.cloud conta SOBEDESCE
   * @param {() => import('../frames/servico.js').FramesService|null} o.frames o serviço do Frames (vem com o servidor)
   * Trocáveis nos testes: pollMs, vidaMs, log.
   */
  constructor({ cloud, frames, pollMs = POLL_MS, vidaMs = VIDA_MS, log } = {}) {
    this.cloud = cloud
    this.frames = frames
    this.pollMs = pollMs
    this.vidaMs = vidaMs
    this.log = log || ((...a) => console.warn('[frames]', ...a))
    this.timer = null
    this.rodando = null
    this.atual = null // { id, jobId }
    this.pausaAte = 0
    this.closed = false
  }

  start() {
    this.#planejar(8_000)
  }

  async close() {
    this.closed = true
    clearTimeout(this.timer)
    this.timer = null
    const svc = this.frames?.()
    if (this.atual?.jobId) svc?.cancelar(this.atual.jobId)
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

  /** Pega e faz os pedidos pendentes, um por vez. Devolve quantos terminaram aqui. */
  async consultar() {
    if (this.rodando) return this.rodando
    this.rodando = (async () => {
      try {
        const svc = this.frames?.()
        if (this.closed || !svc || !this.cloud?.signedIn || Date.now() < this.pausaAte) return 0
        if (svc.job?.status === 'running') return 0 // a pessoa está usando o Frames aqui: espera a vez
        let pedidos
        try {
          const d = await this.#api('GET', '/api/proxies/pedidos?status=pendente&tipo=frames')
          pedidos = Array.isArray(d.pedidos) ? d.pedidos.filter((p) => p?.tipo === 'frames') : []
        } catch (err) {
          if (err instanceof HttpError && [400, 403, 404].includes(err.status)) this.pausaAte = Date.now() + SEM_SITE_MS
          else if (err?.kind !== 'reauth' && !isAbortError(err)) this.log('não consegui ver os pedidos de frames:', err?.message)
          return 0
        }
        if (!pedidos.length) return 0
        const motor = await svc.motor().catch(() => null)
        if (!motor?.ffmpeg?.path) return 0 // sem conversor aqui: deixa para outro computador
        let feitos = 0
        for (const p of pedidos.slice().reverse()) {
          if (this.closed || !this.cloud.signedIn) break
          if (p.status !== 'pendente' || typeof p.id !== 'string') continue
          if (svc.job?.status === 'running') break
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
    await this.#api('PATCH', `/api/proxies/pedidos/${encodeURIComponent(id)}`, corpo).catch((err) => this.log('não consegui avisar o site sobre o pedido de frames:', err?.message))
  }

  async #fazer(p, svc) {
    try {
      if (!(await this.#pegar(p.id))) return false
    } catch (err) {
      this.log('não consegui pegar o pedido de frames:', err?.message)
      return false
    }
    let jobId
    try {
      jobId = svc.iniciar({ origem: { tipo: 'drive', accountId: `nuvem:${p.contaGoogleId}`, fileId: p.fileId }, ajustes: ajustesDoPedido(p.ajustes) })
    } catch (err) {
      // Começou um trabalho na tela neste meio-tempo: devolve para a fila.
      await this.#contar(p.id, { status: 'pendente' })
      this.log('pedido de frames devolvido:', err?.message)
      return false
    }
    this.atual = { id: p.id, jobId }
    let largado = false
    const vida = setInterval(() => {
      this.#api('PATCH', `/api/proxies/pedidos/${encodeURIComponent(p.id)}`, { status: 'gerando' }).catch((err) => {
        if (err instanceof HttpError && (err.status === 404 || err.status === 409)) {
          largado = true
          svc.cancelar(jobId)
        }
      })
    }, this.vidaMs)
    vida.unref?.()
    try {
      const fim = await svc.esperar(jobId)
      if (largado) return false
      if (fim?.status === 'done') {
        const m = fim.manifestoId ? await svc.manifesto(fim.manifestoId).catch(() => null) : null
        const nf = m ? m.frames.filter((f) => !f.descartado).length : 0
        const nt = m ? m.takes.filter((t) => !t.descartado).length : 0
        const resultado = corta(`${plural(nf, 'frame', 'frames')}${nt ? ` e ${plural(nt, 'take', 'takes')}` : ''}, subindo para a pasta do vídeo`, 200)
        await this.#contar(p.id, { status: 'pronto', resultado })
        this.log(`pedido do celular: ${p.nome || p.fileId} → ${resultado}`)
        return true
      }
      if (fim?.status === 'canceled') {
        if (this.closed) await this.#contar(p.id, { status: 'pendente' })
        return false
      }
      await this.#contar(p.id, { status: 'erro', erro: corta(fim?.erro || 'Não deu para fazer os frames.', 300) })
      return true
    } finally {
      clearInterval(vida)
      this.atual = null
    }
  }
}
