// Aviso de versão nova: descobre que saiu um build mais novo e a interface mostra "Atualizar" (o app empacotado
// baixa, confere o SHA-256 e se troca sozinho; src/updater.js) ou "Baixar" (abre o instalador no navegador).
//
//  - O build deste app vem de src/build-info.json, gravado pelo GitHub Actions (scripts/build-info.mjs).
//    build 0 = versão de desenvolvimento (npm start, demo, testes): nunca pergunta nada ao site.
//  - O site responde GET <site>/baixar/versao com o build mais novo do Release de teste (o versao.json, que só sobe
//    depois dos dois instaladores). Confere ~10 s depois de abrir e a cada 1 h; sem internet ou resposta estranha,
//    fica quieto e tenta na próxima.
//  - "Depois" guarda o build dispensado nos ajustes (versaoDispensada): o aviso só volta com um build ainda mais novo.
//  - O versao.json traz o SHA-256 de cada instalador (sha256Mac/sha256Windows). Sem ele, só o Baixar.
//  - App que se atualiza sozinho (src/updater.js): assim que vê um build novo (não dispensado), já baixa, confere e
//    prepara em segundo plano; o aviso mostra o progresso e, no fim, "Atualizar agora". Falhou por rede ou porque a
//    versão ainda estava subindo? Tenta de novo sozinho (2, 4, 8… até 30 min). O download pede o instalador daquele
//    build (/baixar/<plataforma>?build=N), o mesmo do SHA-256 conferido.
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { cloudUrl } from './config.js'
import { requestJSON } from './net/http.js'

const BUILD_INFO_FILE = new URL('./build-info.json', import.meta.url)
const FIRST_DELAY_MS = 10_000
const EVERY_MS = 60 * 60_000
const TIMEOUT_MS = 15_000
const RETRY_BASE_MS = 2 * 60_000
const RETRY_MAX_MS = 30 * 60_000

const PLATAFORMAS = { darwin: 'mac', win32: 'windows' }

function cleanInfo(raw) {
  const build = Number(raw?.build)
  if (!Number.isSafeInteger(build) || build < 0) return null
  const commit = typeof raw?.commit === 'string' && /^[0-9a-f]{4,40}$/i.test(raw.commit) ? raw.commit.slice(0, 12).toLowerCase() : ''
  const ms = typeof raw?.data === 'string' ? Date.parse(raw.data) : NaN
  return { build, commit, data: Number.isFinite(ms) ? new Date(ms).toISOString() : null }
}

/** O build deste app. Arquivo ausente ou estragado = versão de desenvolvimento (build 0). */
export function readBuildInfo(file = BUILD_INFO_FILE) {
  try {
    return cleanInfo(JSON.parse(fs.readFileSync(file, 'utf8'))) || { build: 0, commit: '', data: null }
  } catch {
    return { build: 0, commit: '', data: null }
  }
}

const hex64 = v => (typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : null)

/** Resposta do site → { build, commit, data, sha256: { mac, windows } }, ou null se não for uma versão de verdade. */
export function parseRemote(body) {
  const info = cleanInfo(body)
  if (!info || info.build <= 0) return null
  return { ...info, sha256: { mac: hex64(body.sha256Mac), windows: hex64(body.sha256Windows) } }
}

/**
 * @fires VersionChecker#status  VersionStatus a cada mudança (vira o evento SSE 'versao')
 *
 * VersionStatus = { atual: { build, commit, data }, ultima: { build, commit, data } | null,
 *   disponivel (tem build mais novo, mesmo dispensado), nova (disponível e não dispensado: mostra o aviso),
 *   dispensada (build dispensado com "Depois"), plataforma: 'mac'|'windows'|null, baixarUrl, site,
 *   verificando, verificadaEm (ISO da última resposta boa), falhou (a última tentativa não deu certo),
 *   podeAtualizar (o app consegue instalar este build sozinho: "Atualizar"), atualizacao (Updater.status() ou null) }
 */
export class VersionChecker extends EventEmitter {
  /**
   * @param {{ settings: import('./config.js').Settings, buildInfo?: object, baseUrl?: string, platform?: string,
   *   fetchJSON?: (url: string, opts: { signal: AbortSignal }) => Promise<any>, firstDelayMs?: number,
   *   everyMs?: number, timeoutMs?: number, log?: Function, updater?: import('./updater.js').Updater | null }} opts
   */
  constructor({ settings, buildInfo, baseUrl, platform = process.platform, fetchJSON, firstDelayMs = FIRST_DELAY_MS, everyMs = EVERY_MS, timeoutMs = TIMEOUT_MS, log = () => {}, updater = null, autoBaixar = true, retryBaseMs = RETRY_BASE_MS, retryMaxMs = RETRY_MAX_MS } = {}) {
    super()
    this.settings = settings
    this.atual = cleanInfo(buildInfo) || readBuildInfo()
    this.baseUrl = String(baseUrl || cloudUrl()).replace(/\/+$/, '')
    this.plataforma = PLATAFORMAS[platform] || null
    this.fetchJSON = fetchJSON || ((url, opts) => requestJSON(url, { ...opts, headers: { 'cache-control': 'no-cache' } }))
    this.firstDelayMs = firstDelayMs
    this.everyMs = everyMs
    this.timeoutMs = timeoutMs
    this.log = log
    this.ultima = null
    this.verificadaEm = null
    this.falhou = false
    this.inflight = null
    this.timer = null
    this.stopped = false
    this.onSettings = (_s, changed) => {
      if (changed?.includes('versaoDispensada')) this.#emit()
    }
    settings?.on?.('change', this.onSettings)
    this.updater = updater
    this.onUpdater = () => this.#emit()
    updater?.on('change', this.onUpdater)
    this.autoBaixar = autoBaixar
    this.retryBaseMs = retryBaseMs
    this.retryMaxMs = retryMaxMs
    this.tentativas = 0
    this.retryTimer = null
  }

  /** Versão de desenvolvimento não confere nada. */
  get enabled() {
    return this.atual.build > 0
  }

  start() {
    if (!this.enabled || this.stopped || this.timer) return
    this.#schedule(this.firstDelayMs)
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = null
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.settings?.off?.('change', this.onSettings)
    this.updater?.off('change', this.onUpdater)
  }

  #schedule(ms) {
    clearTimeout(this.timer)
    if (this.stopped) return
    this.timer = setTimeout(async () => {
      this.timer = null
      await this.check().catch(() => {})
      if (!this.stopped && !this.timer) this.#schedule(this.everyMs)
    }, ms)
    this.timer.unref?.()
  }

  /** Pergunta ao site agora. Nunca lança: falha vira `falhou: true` e fica o que já se sabia. */
  check() {
    if (!this.enabled) return Promise.resolve(this.status())
    if (this.inflight) return this.inflight
    this.inflight = this.#run()
    this.#emit() // verificando: true
    return this.inflight
  }

  async #run() {
    try {
      const body = await this.fetchJSON(`${this.baseUrl}/baixar/versao`, { signal: AbortSignal.timeout(this.timeoutMs) })
      const remote = parseRemote(body)
      if (!remote) throw new Error('resposta sem versão')
      this.ultima = remote
      this.verificadaEm = new Date().toISOString()
      this.falhou = false
    } catch (err) {
      this.falhou = true
      this.log('não consegui ver se há versão nova:', err?.code || err?.message || err)
    } finally {
      this.inflight = null
    }
    const st = this.#emit()
    this.#baixarSozinho()
    return st
  }

  /** O que o Updater precisa para baixar o build mais novo conhecido. */
  #pedido() {
    const build = this.ultima.build
    const recheck = async () => {
      await this.check()
      return this.ultima ? { build: this.ultima.build, sha256: this.ultima.sha256?.[this.plataforma] } : null
    }
    return { build, url: `${this.baseUrl}/baixar/${this.plataforma}?build=${build}`, sha256: this.ultima.sha256?.[this.plataforma], recheck }
  }

  /**
   * Build novo (não dispensado) e o app se atualiza sozinho: baixa, confere e prepara já, em segundo plano. No fim o
   * aviso mostra "Atualizar agora". Nunca lança. `forcar`: tentativa marcada depois de um erro que passa sozinho.
   */
  #baixarSozinho(forcar = false) {
    const up = this.updater
    if (!up || !this.autoBaixar || this.stopped) return
    const st = this.status()
    if (!st.podeAtualizar || !st.nova) return
    const build = this.ultima.build
    if (up.ocupado || up.prontoPara(build) || up.fase === 'reiniciando') return
    // Erro neste mesmo build: só a tentativa marcada (ou o "Tentar de novo" da pessoa) volta a baixar.
    if (up.fase === 'erro' && up.build === build && !forcar) return
    if (up.build !== build) this.tentativas = 0
    let job
    try {
      job = up.preparar(this.#pedido())
    } catch {
      return
    }
    job
      .then(fim => {
        if (fim?.fase === 'pronto') this.tentativas = 0
        else if (fim?.fase === 'erro' && fim.deNovo) this.#tentarDeNovo()
      })
      .catch(() => {})
  }

  #tentarDeNovo() {
    if (this.stopped || this.retryTimer) return
    const ms = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** this.tentativas)
    this.tentativas++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.#baixarSozinho(true)
    }, ms)
    this.retryTimer.unref?.()
  }

  /** "Depois": não mostra mais este build (o padrão é o mais novo conhecido). Lança Error com `status` se não fizer sentido. */
  async dismiss(build = this.ultima?.build) {
    const b = Number(build)
    if (!this.ultima) throw Object.assign(new Error('Não há versão nova para deixar para depois.'), { status: 409 })
    if (!Number.isSafeInteger(b) || b <= 0 || b > this.ultima.build) throw Object.assign(new Error('Versão inválida.'), { status: 400 })
    const atual = Number(this.settings.get().versaoDispensada) || 0
    if (b > atual) await this.settings.update({ versaoDispensada: b })
    return this.#emit()
  }

  /**
   * "Atualizar agora": com a versão nova já baixada e preparada, fecha o app e troca; senão baixa e troca no fim (ou
   * troca assim que o download em andamento acabar). Volta logo; o progresso chega pelo 'status'.
   * Lança Error com `status` (409) se não der: aí a interface oferece o Baixar.
   */
  async update() {
    const up = this.updater
    // A conferência pode ter até 1 h: pergunta de novo antes de baixar (a não ser que já esteja baixando ou pronto).
    if (up && !up.ocupado && !(this.ultima && up.prontoPara(this.ultima.build))) {
      const auto = this.autoBaixar
      this.autoBaixar = false // o download desta vez é o pedido abaixo, com a troca no fim
      try {
        await this.check()
      } finally {
        this.autoBaixar = auto
      }
    }
    const st = this.status()
    if (!st.disponivel) throw Object.assign(new Error('Não há versão nova para instalar.'), { status: 409 })
    if (!up) throw Object.assign(new Error('Este app não se atualiza sozinho. Use Baixar.'), { status: 409 })
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    up.preparar({ ...this.#pedido(), aplicar: true })?.catch?.(() => {})
    return this.#emit()
  }

  /** "Tentar de novo" depois de um erro: baixa de novo em segundo plano (sem trocar no fim). */
  async baixar() {
    if (!this.updater) throw Object.assign(new Error('Este app não se atualiza sozinho. Use Baixar.'), { status: 409 })
    if (!this.updater.ocupado) await this.check()
    if (!this.status().podeAtualizar) throw Object.assign(new Error('Não há versão nova para baixar pelo app. Use Baixar.'), { status: 409 })
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.tentativas = 0
    this.#baixarSozinho(true)
    return this.#emit()
  }

  status() {
    const dispensada = Number(this.settings?.get?.().versaoDispensada) || 0
    const disponivel = this.enabled && !!this.ultima && this.ultima.build > this.atual.build && !!this.plataforma
    const up = this.updater
    const podeAtualizar = disponivel && !!up && up.podeInstalar(this.ultima.build) && !!this.ultima.sha256?.[this.plataforma]
    return {
      atual: { ...this.atual },
      ultima: this.ultima ? { ...this.ultima, sha256: { ...this.ultima.sha256 } } : null,
      disponivel,
      nova: disponivel && this.ultima.build > dispensada,
      dispensada,
      plataforma: this.plataforma,
      baixarUrl: this.plataforma ? `${this.baseUrl}/baixar/${this.plataforma}` : null,
      site: this.baseUrl,
      verificando: !!this.inflight,
      verificadaEm: this.verificadaEm,
      falhou: this.falhou,
      podeAtualizar,
      atualizacao: up && (up.fase || up.ocupado) ? up.status() : null,
    }
  }

  #emit() {
    const st = this.status()
    this.emit('status', st)
    return st
  }
}
