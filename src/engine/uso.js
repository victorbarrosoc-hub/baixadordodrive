// Uso por dia deste computador, para o admin da SOBEDESCE ver como a plataforma está sendo usada
// (POST /api/dispositivos/uso, docs/CONTAS.md §10). Só números: bytes e arquivos que subiram e desceram, erros,
// o maior arquivo e o tempo com algo andando. Nunca nome de arquivo, pasta ou conta do Drive.
//
// Regras: só com a conta SOBEDESCE conectada; nunca atrapalha a fila (erros engolidos); guarda os últimos 14 dias
// em uso.json e manda o que mudou ~1 min depois de abrir, a cada 15 min e ao fechar o app. O site guarda o maior
// valor de cada dia, então mandar de novo o mesmo dia não soma duas vezes.
import { JsonFile } from '../util/store.js'
import { isAbortError } from '../util/backoff.js'

const SEGUNDO = 1000
const MINUTO = 60 * SEGUNDO

export const USO_PADRAO = Object.freeze({
  primeiroMs: MINUTO,
  cadaMs: 15 * MINUTO,
  timeoutMs: 15 * SEGUNDO,
  fimTimeoutMs: 2500,
  /** Entre dois eventos de progresso, no máximo isso conta como "andando" (app suspenso, relógio pulou). */
  passoMaxMs: 15 * SEGUNDO,
})

export const DIAS_GUARDADOS = 14
const CAMPOS = ['enviadosBytes', 'baixadosBytes', 'enviados', 'baixados', 'erros', 'maiorArquivo', 'msAtivo']

/** "2026-10-18" no fuso do computador. */
export function diaLocal(ms) {
  const d = new Date(ms)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const num = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0)

function diaVazio() {
  return Object.fromEntries(CAMPOS.map(c => [c, 0]))
}

/** Só dias válidos e campos conhecidos (arquivo editado à mão ou de outra versão não quebra nada). */
export function limparDias(raw, hoje) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  const dias = Object.keys(raw)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= hoje)
    .sort()
    .slice(-DIAS_GUARDADOS)
  for (const d of dias) {
    const v = diaVazio()
    for (const c of CAMPOS) v[c] = num(raw[d]?.[c])
    out[d] = v
  }
  return out
}

export class UsoDiario {
  /**
   * @param {{ manager: object, cloud: object|null, file: string, log?: Function, now?: () => number } & Partial<typeof USO_PADRAO>} o
   */
  constructor({ manager, cloud, file, log, now = Date.now, ...tempos } = {}) {
    this.manager = manager
    this.cloud = cloud
    this.arquivo = file ? new JsonFile(file, { dias: {} }) : null
    this.t = { ...USO_PADRAO, ...tempos }
    this.now = now
    this.log = log || ((...a) => console.warn('[uso]', ...a))
    this.dias = {}
    this.desde = now()
    this.contados = new Set() // `${id}:${status}` já contados nesta execução
    this.ultimoPasso = null
    this.mudou = false // há números que o site ainda não tem
    this.timer = null
    this.enviando = null
    this.fechado = false
    this.started = false
    this.onTransfers = list => this.notar(list)
    this.onCloud = () => this.#agendar(this.t.primeiroMs)
  }

  async init() {
    if (!this.arquivo) return
    try {
      const raw = await this.arquivo.load()
      this.dias = limparDias(raw?.dias, diaLocal(this.now()))
      this.mudou = raw?.pendente === true
    } catch {
      this.dias = {}
    }
  }

  start() {
    if (this.started) return
    this.started = true
    this.manager.on?.('transfers', this.onTransfers)
    this.cloud?.on?.('status', this.onCloud)
    this.#agendar(this.t.primeiroMs)
  }

  async close({ final = false } = {}) {
    if (this.fechado) return
    clearTimeout(this.timer)
    this.timer = null
    this.manager.off?.('transfers', this.onTransfers)
    this.cloud?.off?.('status', this.onCloud)
    if (final && this.mudou && this.#conectado()) {
      await this.enviando?.catch(() => {})
      await this.#enviar(this.t.fimTimeoutMs).catch(() => {})
    }
    this.fechado = true
    await this.#gravar(true)
  }

  #conectado() {
    try {
      return !!this.cloud?.status?.().conectado
    } catch {
      return false
    }
  }

  #hoje() {
    const d = diaLocal(this.now())
    this.dias[d] ??= diaVazio()
    return this.dias[d]
  }

  /** Lista do evento 'transfers' do TransferManager (registros públicos). */
  notar(list) {
    if (!Array.isArray(list) || this.fechado) return
    const agora = this.now()
    let mexeu = false
    // Tempo com algo andando (para a velocidade média): soma o intervalo entre eventos enquanto um arquivo corre.
    const andando = list.some(t => t?.status === 'running')
    if (andando && this.ultimoPasso != null) {
      const passo = Math.min(this.t.passoMaxMs, Math.max(0, agora - this.ultimoPasso))
      if (passo > 0) {
        this.#hoje().msAtivo += passo
        mexeu = true
      }
    }
    this.ultimoPasso = andando ? agora : null
    for (const t of list) {
      if (!t?.id || (t.status !== 'completed' && t.status !== 'failed')) continue
      const chave = `${t.id}:${t.status}`
      if (this.contados.has(chave)) continue
      // O que terminou antes de o app abrir já foi contado (ou é de antes desta função existir).
      const fim = Number(t.finishedAt) || Number(t.updatedAt) || 0
      if (fim < this.desde) continue
      this.contados.add(chave)
      const d = this.#hoje()
      if (t.status === 'failed') {
        d.erros++
      } else {
        const bytes = num(t.size)
        if (t.type === 'upload') {
          d.enviados++
          d.enviadosBytes += bytes
        } else {
          d.baixados++
          d.baixadosBytes += bytes
        }
        if (bytes > d.maiorArquivo) d.maiorArquivo = bytes
      }
      mexeu = true
    }
    if (mexeu) {
      this.mudou = true
      this.#gravar()
    }
  }

  /** O que vai para o site: os dias guardados, do mais antigo ao de hoje. */
  corpo() {
    const hoje = diaLocal(this.now())
    this.dias = limparDias(this.dias, hoje)
    return { dias: Object.entries(this.dias).map(([dia, v]) => ({ dia, ...v })) }
  }

  async agora() {
    clearTimeout(this.timer)
    this.timer = null
    await this.#ciclo()
  }

  #gravar(ja = false) {
    if (!this.arquivo) return Promise.resolve()
    this.arquivo.data = { dias: this.dias, pendente: this.mudou }
    if (ja) return this.arquivo.save().catch(() => {})
    this.arquivo.saveSoon(5 * SEGUNDO)
    return Promise.resolve()
  }

  #agendar(ms) {
    if (this.fechado || !this.started) return
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.#ciclo()
    }, ms)
    this.timer.unref?.()
  }

  async #ciclo() {
    if (this.fechado) return
    if (this.mudou && this.#conectado()) {
      if (this.enviando) await this.enviando.catch(() => {})
      else await this.#enviar(this.t.timeoutMs).catch(() => {})
    }
    this.#agendar(this.t.cadaMs)
  }

  #enviar(timeoutMs) {
    const p = (async () => {
      const body = this.corpo()
      if (!body.dias.length) {
        this.mudou = false
        return
      }
      // O que chegar durante o envio continua pendente para o próximo.
      this.mudou = false
      try {
        await this.cloud.request('POST', '/api/dispositivos/uso', { body, expect: [200, 204], timeoutMs })
        await this.#gravar()
      } catch (err) {
        this.mudou = true
        if (!isAbortError(err)) this.log('não consegui mandar o uso do dia; tento mais tarde:', err?.status ?? err?.reason ?? err?.message)
      }
    })()
    this.enviando = p
    return p.finally(() => {
      if (this.enviando === p) this.enviando = null
    })
  }
}
