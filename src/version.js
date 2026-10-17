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
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { cloudUrl } from './config.js'
import { requestJSON } from './net/http.js'

const BUILD_INFO_FILE = new URL('./build-info.json', import.meta.url)
const FIRST_DELAY_MS = 10_000
const EVERY_MS = 60 * 60_000
const TIMEOUT_MS = 15_000

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
  constructor({ settings, buildInfo, baseUrl, platform = process.platform, fetchJSON, firstDelayMs = FIRST_DELAY_MS, everyMs = EVERY_MS, timeoutMs = TIMEOUT_MS, log = () => {}, updater = null } = {}) {
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
    return this.#emit()
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
   * "Atualizar": o app baixa e instala o build mais novo (src/updater.js). Volta logo; o progresso chega pelo 'status'.
   * Lança Error com `status` (409) se não der: aí a interface oferece o Baixar.
   */
  async update() {
    // A conferência pode ter até 1 h: pergunta de novo antes de baixar (o endereço de download entrega o mais novo).
    if (this.updater && !this.updater.ocupado) await this.check()
    const st = this.status()
    if (!st.disponivel) throw Object.assign(new Error('Não há versão nova para instalar.'), { status: 409 })
    if (!this.updater) throw Object.assign(new Error('Este app não se atualiza sozinho. Use Baixar.'), { status: 409 })
    const recheck = async () => {
      await this.check()
      return this.ultima ? { build: this.ultima.build, sha256: this.ultima.sha256?.[this.plataforma] } : null
    }
    if (!this.updater.ocupado) this.updater.install({ build: this.ultima.build, url: st.baixarUrl, sha256: this.ultima.sha256?.[this.plataforma], recheck })
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
