// "Acompanhar pelo celular": manda para a conta SOBEDESCE um retrato curto das transferências deste computador
// (POST /api/dispositivos/status, contrato em docs/CONTAS.md §9). O celular mostra quanto falta e o que já passou, e
// o site avisa no celular quando um lote termina.
//
// Regras: só com a conta SOBEDESCE e o ajuste `acompanharCelular` ligado; nunca atrapalha a fila (tudo em segundo
// plano, erros engolidos); a cada ~10 s enquanto algo anda, logo depois de um arquivo começar/terminar/falhar/pausar
// (agrupando o que acontece junto) e um sinal de vida a cada ~90 s parado. Falhou? Tenta de novo mais tarde, quieto.
import path from 'node:path'
import { HttpError } from '../net/http.js'
import { isAbortError } from '../util/backoff.js'

const SEGUNDO = 1000
const MINUTO = 60 * SEGUNDO
const DIA = 24 * 60 * MINUTO

export const ACOMPANHAR_PADRAO = Object.freeze({
  ativoMs: 10 * SEGUNDO, // retrato a cada 10 s enquanto algo anda
  ociosoMs: 90 * SEGUNDO, // sinal de vida parado (o celular considera ligado até 2 min)
  eventoMs: 1500, // espera depois de um evento, para juntar vários arquivos terminando juntos
  minGapMs: 2 * SEGUNDO, // nunca dois envios mais perto que isso
  maxEsperaMs: 5 * MINUTO, // teto do recuo depois de falhas
  pausaLongaMs: 30 * MINUTO, // site sem a rota (404) ou recusando (403)
  timeoutMs: 15 * SEGUNDO,
  fimTimeoutMs: 2500, // última notícia ao fechar o app
})

export const MAX_ITENS = 50
export const MAX_TERMINADOS = 30
export const MAX_LOTES = 15
export const GUARDA_TERMINADOS_MS = 7 * DIA
export const LIMITE_BYTES = 60 * 1024 // o site aceita até 64 KB
const MAX_NOME = 160

const ATIVOS = new Set(['queued', 'running', 'verifying', 'waiting'])
const OK = new Set(['completed', 'skipped'])

const direcaoDe = r => (r.type === 'upload' ? 'sobe' : 'desce')
const corta = (s, n = MAX_NOME) => {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}
const num = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)
const quandoTerminou = r => Number(r.finishedAt) || Number(r.updatedAt) || 0

function estadoItem(r) {
  if (r.status === 'running') return r.type === 'upload' ? 'enviando' : 'baixando'
  if (r.status === 'verifying') return 'conferindo'
  if (r.status === 'waiting') return 'esperando'
  if (r.status === 'paused') return 'pausado'
  return 'na_fila'
}

const ORDEM_ITEM = { running: 0, verifying: 0, waiting: 1, queued: 2, paused: 3 }

/** Nome da pasta de destino (do lote, quando a interface contou; senão o que dá para saber pelo registro). */
export function destinoDe(r, batch) {
  if (batch?.destino) return corta(batch.destino, 120)
  if (r.type === 'upload') return r.target?.rootId === 'root' && !r.target?.driveId ? 'Meu Drive' : null
  const p = r.dest?.path
  return p ? corta(path.basename(path.dirname(p)), 120) || null : null
}

/**
 * Monta o retrato (formato do contrato) a partir do TransferManager.
 * `rodada` = { id, inicio }: o que terminou desde `inicio` faz parte do total; null = nada andou desde que o app abriu.
 * @param {{ records: Map, batches: Map, get(id): object|null, stats(): object }} manager
 */
export function montarRetrato(manager, { rodada = null, now = Date.now(), fechado = false } = {}) {
  const membros = []
  const terminados = []
  const inicio = rodada ? rodada.inicio : Infinity
  for (const r of manager.records.values()) {
    if (!r || r.status === 'canceled') continue
    const fim = quandoTerminou(r)
    if ((OK.has(r.status) || r.status === 'failed') && fim >= now - GUARDA_TERMINADOS_MS) terminados.push(r)
    // Pausado conta se foi pausado nesta rodada; terminado, se terminou nela (a prévia leve e a miniatura mexem no
    // updatedAt depois do fim: por isso o finishedAt).
    const naRodada =
      ATIVOS.has(r.status) || (r.status === 'paused' && (Number(r.updatedAt) || 0) > inicio) || ((OK.has(r.status) || r.status === 'failed') && fim > inicio)
    if (rodada && naRodada) membros.push(r)
  }

  const st = safeStats(manager)
  const velSobe = num(st?.up?.speed)
  const velDesce = num(st?.down?.speed)
  const geral = {
    feitoBytes: 0,
    totalBytes: 0,
    feitos: 0,
    total: 0,
    erros: 0,
    velocidade: Math.round(velSobe + velDesce),
    eta: null,
    sobe: { arquivos: 0, velocidade: Math.round(velSobe) },
    desce: { arquivos: 0, velocidade: Math.round(velDesce) },
    fora: 0,
  }
  const vivos = []
  let restante = 0
  let ativos = 0
  let pausados = 0
  let subindo = false
  let descendo = false
  let primeiroAtivo = null
  for (const r of membros) {
    const ao = ATIVOS.has(r.status) ? (r.status === 'running' || r.status === 'verifying' ? liveOf(manager, r) : null) : null
    const size = r.size == null ? null : num(r.size)
    const feito = OK.has(r.status) ? (size ?? num(r.bytesDone)) : Math.min(size ?? Infinity, num(ao?.bytesDone ?? r.bytesDone))
    geral.total++
    geral[direcaoDe(r)].arquivos++
    geral.totalBytes += size ?? 0
    geral.feitoBytes += feito
    if (OK.has(r.status)) geral.feitos++
    else if (r.status === 'failed') geral.erros++
    else {
      vivos.push({ r, ao, feito, size })
      if (r.status === 'paused') pausados++
      else {
        ativos++
        restante += Math.max(0, (size ?? 0) - feito)
        primeiroAtivo ??= r
        if (r.status === 'running' || r.status === 'verifying') {
          if (r.type === 'upload') subindo = true
          else descendo = true
        }
      }
    }
  }
  geral.eta = ativos && geral.velocidade > 0 ? Math.round(restante / geral.velocidade) : null

  let estado = 'parado'
  if (ativos) estado = subindo ? 'enviando' : descendo ? 'baixando' : primeiroAtivo?.type === 'download' ? 'baixando' : 'enviando'
  else if (pausados) estado = 'pausado'
  else if (geral.erros) estado = 'erro'
  else if (geral.total) estado = 'concluido'

  vivos.sort((a, b) => ORDEM_ITEM[a.r.status] - ORDEM_ITEM[b.r.status] || (Number(b.r.priority) || 0) - (Number(a.r.priority) || 0) || (a.r.createdAt || 0) - (b.r.createdAt || 0))
  const itens = vivos.slice(0, MAX_ITENS).map(({ r, ao, feito, size }) => {
    const it = {
      id: corta(r.id, 100),
      nome: corta(r.name || r.relPath || 'arquivo'),
      direcao: direcaoDe(r),
      feito,
      total: size,
      velocidade: Math.round(num(ao?.speed)),
      estado: estadoItem(r),
      destino: destinoDe(r, manager.batches?.get?.(r.batchId)),
    }
    if (r.batchId) it.lote = corta(r.batchId, 80)
    if (r.error?.message && (r.status === 'paused' || r.status === 'waiting')) it.erro = corta(r.error.message, 200)
    return it
  })
  geral.fora = Math.max(0, vivos.length - itens.length)

  terminados.sort((a, b) => quandoTerminou(b) - quandoTerminou(a))
  const fim = terminados.slice(0, MAX_TERMINADOS).map(r => {
    const t = { nome: corta(r.name || r.relPath || 'arquivo'), direcao: direcaoDe(r), total: r.size == null ? null : num(r.size), terminouEm: quandoTerminou(r), ok: r.status !== 'failed' }
    if (r.batchId) t.lote = corta(r.batchId, 80)
    if (r.status === 'failed' && r.error?.message) t.erro = corta(r.error.message, 200)
    return t
  })

  const retrato = { v: 1, estado, rodada: rodada ? rodada.id : null, geral, itens, terminados: fim, lotes: montarLotes(manager, now) }
  if (fechado) retrato.fechado = true
  return caber(retrato)
}

/**
 * Os pedidos (lotes), como a tela Transferências do computador: "Pasta "ZRO" · 8 arquivos · 18,2 GB", quantos andam,
 * na fila, prontos, cancelados, com erro e conferidos (MD5). Os que têm algo andando e os que terminaram nos últimos 7
 * dias, no máximo MAX_LOTES: os andando primeiro, depois o mais recente.
 */
export function montarLotes(manager, now = Date.now()) {
  const por = new Map()
  for (const r of manager.records.values()) {
    if (!r?.batchId) continue
    let l = por.get(r.batchId)
    if (!l) por.set(r.batchId, (l = []))
    l.push(r)
  }
  const out = []
  for (const [id, rs] of por) {
    const b = manager.batches?.get?.(id) || null
    const n = { andando: 0, esperando: 0, naFila: 0, pausados: 0, concluidos: 0, cancelados: 0, erros: 0, conferidos: 0, divergentes: 0 }
    let bytes = 0
    let feito = 0
    let restante = 0
    let velocidade = 0
    let fim = 0
    let sobe = 0
    let desce = 0
    for (const r of rs) {
      if (r.type === 'upload') sobe++
      else desce++
      const size = r.size == null ? 0 : num(r.size)
      if (r.status === 'canceled') {
        n.cancelados++
        continue
      }
      bytes += size
      if (OK.has(r.status)) {
        n.concluidos++
        feito += size || num(r.bytesDone)
        if (r.verify?.state === 'ok') n.conferidos++
        else if (r.verify?.state === 'mismatch') n.divergentes++
        fim = Math.max(fim, quandoTerminou(r))
        continue
      }
      if (r.status === 'failed') {
        n.erros++
        feito += Math.min(size || Infinity, num(r.bytesDone))
        fim = Math.max(fim, quandoTerminou(r))
        continue
      }
      const ao = r.status === 'running' || r.status === 'verifying' ? liveOf(manager, r) : null
      const f = Math.min(size || Infinity, num(ao?.bytesDone ?? r.bytesDone))
      feito += f
      if (r.status === 'running' || r.status === 'verifying') {
        n.andando++
        velocidade += num(ao?.speed)
      } else if (r.status === 'waiting') n.esperando++
      else if (r.status === 'paused') {
        n.pausados++
        if (r.error) n.erros++ // pausado com motivo: precisa de alguém (a tela do computador conta como problema)
        continue
      } else n.naFila++
      restante += Math.max(0, size - f)
    }
    const vivo = n.andando + n.esperando + n.naFila > 0
    if (!vivo && !n.pausados && (!fim || fim < now - GUARDA_TERMINADOS_MS)) continue
    out.push({
      id: corta(id, 80),
      titulo: corta(b?.label || (sobe ? 'Envios' : 'Downloads'), 160),
      direcao: sobe && desce ? 'misto' : sobe ? 'sobe' : 'desce',
      destino: b?.destino ? corta(b.destino, 120) : null,
      arquivos: rs.length,
      bytes,
      feitoBytes: Math.min(bytes, feito),
      ...n,
      velocidade: Math.round(velocidade),
      eta: vivo && velocidade > 0 ? Math.round(restante / velocidade) : null,
      criadoEm: Number(b?.createdAt) || Math.min(...rs.map(r => Number(r.createdAt) || now)),
      terminouEm: vivo || n.pausados ? null : fim || null,
    })
  }
  out.sort((a, b) => Number(b.terminouEm == null) - Number(a.terminouEm == null) || (b.terminouEm ?? b.criadoEm) - (a.terminouEm ?? a.criadoEm))
  return out.slice(0, MAX_LOTES)
}

/** Garante o teto de tamanho do site: tira itens do fim das listas até caber. */
function caber(retrato) {
  let json = JSON.stringify(retrato)
  while (Buffer.byteLength(json) > LIMITE_BYTES && (retrato.itens.length || retrato.terminados.length || retrato.lotes?.length > 3)) {
    if (retrato.lotes?.length > 3 && !retrato.itens.length && retrato.terminados.length <= 5) retrato.lotes.pop()
    else if (retrato.terminados.length > 5 || !retrato.itens.length) retrato.terminados.pop()
    else {
      retrato.itens.pop()
      retrato.geral.fora++
    }
    json = JSON.stringify(retrato)
  }
  return retrato
}

function safeStats(manager) {
  try {
    return manager.stats()
  } catch {
    return null
  }
}

function liveOf(manager, r) {
  try {
    return manager.get(r.id)
  } catch {
    return null
  }
}

function temAtivo(manager) {
  for (const r of manager.records.values()) if (r && ATIVOS.has(r.status)) return true
  return false
}

/**
 * Mantém o retrato no site em dia.
 * Opções (testes): intervalos de ACOMPANHAR_PADRAO, `now`, `log`.
 */
export class AcompanharCelular {
  /**
   * @param {{ manager: object, cloud: object|null, settings: object, log?: Function, now?: () => number } & Partial<typeof ACOMPANHAR_PADRAO>} o
   */
  constructor({ manager, cloud, settings, log, now = Date.now, ...tempos } = {}) {
    this.manager = manager
    this.cloud = cloud
    this.settings = settings
    this.t = { ...ACOMPANHAR_PADRAO, ...tempos }
    this.now = now
    this.log = log || ((...a) => console.warn('[acompanhar]', ...a))
    this.rodada = null
    this.desde = now()
    this.ultimoOcioso = null
    this.status = new Map() // id -> status do último retrato (para notar começo/fim/erro/pausa)
    this.timer = null
    this.proximoEm = 0
    this.enviando = null
    this.ultimoEnvio = 0
    this.falhas = 0
    this.pausadoAte = 0
    this.publicado = false // há retrato deste computador no site (para apagar ao desligar)
    this.enviados = 0
    this.fechado = false
    this.started = false
    this.onTransfers = list => this.#notar(list)
    this.onRemoved = () => this.#agendar(this.t.eventoMs)
    this.onCloud = () => this.#reavaliar()
    this.onSettings = (_next, changed = []) => {
      if (changed.includes('acompanharCelular')) this.#reavaliar(true)
    }
  }

  ligado() {
    try {
      return !this.fechado && !!this.settings?.get?.().acompanharCelular && !!this.cloud?.status?.().conectado
    } catch {
      return false
    }
  }

  start() {
    if (this.started) return
    this.started = true
    this.manager.on?.('transfers', this.onTransfers)
    this.manager.on?.('removed', this.onRemoved)
    this.cloud?.on?.('status', this.onCloud)
    this.settings?.on?.('change', this.onSettings)
    this.#agendar(this.t.eventoMs)
  }

  /** Para de mandar. `final`: antes, manda a última notícia ("o app foi fechado"), com tempo curto. */
  async close({ final = false } = {}) {
    if (this.fechado) return
    if (final && this.publicado && this.ligado()) {
      await this.enviando?.catch(() => {})
      await this.#enviar({ fechado: true, timeoutMs: this.t.fimTimeoutMs }).catch(() => {})
    }
    this.fechado = true
    clearTimeout(this.timer)
    this.timer = null
    this.manager.off?.('transfers', this.onTransfers)
    this.manager.off?.('removed', this.onRemoved)
    this.cloud?.off?.('status', this.onCloud)
    this.settings?.off?.('change', this.onSettings)
  }

  /** Manda agora (testes e "começou um lote"). Nunca lança. */
  async agora() {
    clearTimeout(this.timer)
    this.timer = null
    await this.#ciclo()
  }

  /** O retrato que seria mandado agora (sem mandar). */
  retrato({ fechado = false } = {}) {
    const now = this.now()
    if (temAtivo(this.manager)) {
      this.#abrirRodada(now)
    } else {
      this.ultimoOcioso = now
      // A rodada continua aparecendo ("concluído", "parou com erro") até a próxima começar.
      if (this.rodada) this.rodada.encerrada = true
    }
    return montarRetrato(this.manager, { rodada: this.rodada, now, fechado })
  }

  /**
   * Algo anda depois de tudo parado: rodada nova. Conta o que terminou desde a última vez que vimos tudo parado
   * (ou, logo ao abrir o app, desde que o lote em andamento foi criado).
   */
  #abrirRodada(now) {
    if (this.rodada && !this.rodada.encerrada) return
    let inicio = this.ultimoOcioso
    if (inicio == null) {
      inicio = Math.min(now, this.desde)
      for (const r of this.manager.records.values()) if (r && ATIVOS.has(r.status)) inicio = Math.min(inicio, (Number(r.createdAt) || now) - 1)
    }
    this.rodada = { id: `r${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, inicio }
  }

  #notar(list) {
    if (!Array.isArray(list)) return
    let mudou = false
    let ativo = false
    const corte = this.ultimoOcioso ?? this.desde
    for (const t of list) {
      if (!t?.id) continue
      if (ATIVOS.has(t.status)) ativo = true
      // Terminou entre dois retratos (começou e acabou antes de vermos andando) também abre a rodada.
      else if (t.status !== 'paused' && t.status !== 'canceled' && this.status.get(t.id) !== t.status) {
        const r = this.manager.records?.get?.(t.id)
        if (r && quandoTerminou(r) > corte) ativo = true
      }
      if (this.status.get(t.id) !== t.status) {
        this.status.set(t.id, t.status)
        mudou = true
      }
    }
    // Um lote pequeno pode começar e terminar antes do próximo retrato: a rodada abre aqui, na hora.
    if (ativo) this.#abrirRodada(this.now())
    if (mudou) this.#agendar(this.t.eventoMs)
  }

  async #reavaliar(ajuste = false) {
    if (this.fechado) return
    if (this.ligado()) return this.#agendar(this.t.eventoMs)
    clearTimeout(this.timer)
    this.timer = null
    // Ajuste desligado com a conta ainda ativa: o retrato deste computador sai do site.
    if (ajuste && this.publicado && this.cloud?.status?.().conectado) {
      this.publicado = false
      try {
        await this.cloud.request('DELETE', '/api/dispositivos/status', { expect: [200, 204, 404], timeoutMs: this.t.timeoutMs })
      } catch (err) {
        this.log('não consegui apagar o andamento no site:', err?.message)
      }
    }
  }

  /** Marca o próximo envio para daqui a `ms` (se não houver um antes). */
  #agendar(ms) {
    if (this.fechado || !this.started) return
    const now = this.now()
    const quando = Math.max(now + ms, this.ultimoEnvio + this.t.minGapMs, this.pausadoAte)
    if (this.timer && this.proximoEm <= quando) return
    clearTimeout(this.timer)
    this.proximoEm = quando
    this.timer = setTimeout(() => {
      this.timer = null
      this.#ciclo()
    }, Math.max(0, quando - now))
    this.timer.unref?.()
  }

  async #ciclo() {
    if (this.fechado) return
    if (!this.ligado()) return // volta quando a conta entrar ou o ajuste ligar (eventos)
    if (this.enviando) {
      await this.enviando.catch(() => {})
    } else {
      await this.#enviar().catch(() => {})
    }
    if (this.fechado || this.timer) return
    const base = temAtivo(this.manager) ? this.t.ativoMs : this.t.ociosoMs
    const recuo = this.falhas ? Math.min(this.t.maxEsperaMs, this.t.ativoMs * 2 ** Math.min(this.falhas, 6)) : 0
    this.#agendar(Math.max(base, recuo))
  }

  #enviar({ fechado = false, timeoutMs = this.t.timeoutMs } = {}) {
    const p = (async () => {
      let retrato
      try {
        retrato = this.retrato({ fechado })
      } catch (err) {
        this.log('não consegui montar o andamento:', err?.message)
        return
      }
      this.ultimoEnvio = this.now()
      try {
        await this.cloud.request('POST', '/api/dispositivos/status', { body: retrato, expect: [200, 201, 204], timeoutMs })
        this.falhas = 0
        this.publicado = true
        this.enviados++
      } catch (err) {
        if (isAbortError(err)) return
        this.falhas++
        const s = err instanceof HttpError ? err.status : null
        if (s === 404 || s === 403 || s === 413 || s === 400) this.pausadoAte = this.now() + this.t.pausaLongaMs
        if (this.falhas === 1 || this.falhas % 20 === 0) this.log(`não consegui mandar o andamento (${s ?? err?.reason ?? err?.code ?? 'rede'}); tento de novo depois.`)
      }
    })()
    this.enviando = p
    return p.finally(() => {
      if (this.enviando === p) this.enviando = null
    })
  }
}
