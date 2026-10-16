// yt-dlp sempre em dia: os sites mudam toda semana e um yt-dlp de dois meses atrás para de baixar do Instagram.
//
// Ao abrir (e no máximo uma vez por dia) pergunta qual é o Release mais novo do yt-dlp no GitHub, baixa o arquivo
// desta máquina para <dados>/yt-dlp/<versão>/ e confere com o SHA2-256SUMS do MESMO Release. Só depois de conferido
// (e de responder `--version`) ele passa a valer no lugar do que veio no app. Binário que não confere nunca roda:
// o hash é conferido de novo a cada uso (o arquivo podia ter sido trocado no disco).
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { fetch as undiciFetch } from 'undici'
import { dispatcherFor } from '../net/http.js'
import { downloadTo } from '../updater.js'
import { readJSON, writeJSONAtomic } from '../util/store.js'
import { compararVersao, isFile, lerVersaoArquivo, versaoValida, ytdlpAsset, ytdlpCandidates, ytdlpExe } from './binarios.js'

export const RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases'
const DIA = 24 * 60 * 60_000
const PRIMEIRA_MS = 20_000 // depois de abrir, espera um pouco (não disputa a rede com o começo do app)
const TIMEOUT_MS = 20_000
const MAX_BYTES = 250 * 1024 * 1024
const SUMS = 'SHA2-256SUMS'

/** Texto do SHA2-256SUMS → Map(nome → sha256 hex). Linhas ruins são ignoradas. */
export function lerSums(texto) {
  const out = new Map()
  for (const linha of String(texto || '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S.*)$/i.exec(linha.trim())
    if (m) out.set(m[2].trim(), m[1].toLowerCase())
  }
  return out
}

/** Versão (tag) no endereço do redirecionamento de /latest/download/… ("…/download/2026.08.19/SHA2-256SUMS"). */
export function tagDoEndereco(loc) {
  const m = /\/download\/([^/]+)\/[^/]+$/.exec(String(loc || ''))
  const tag = m ? decodeURIComponent(m[1]) : ''
  return versaoValida(tag) ? tag : null
}

export async function sha256Arquivo(file) {
  const hash = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(file, { highWaterMark: 1024 * 1024 })
    s.on('data', c => hash.update(c))
    s.on('error', reject)
    s.on('end', resolve)
  })
  return hash.digest('hex')
}

function versaoDoBinario(bin, { timeoutMs = 60_000 } = {}) {
  return new Promise(resolve => {
    try {
      execFile(bin, ['--version'], { timeout: timeoutMs, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, stdout) => {
        const v = String(stdout || '').trim().split(/\r?\n/).pop() || ''
        resolve(!err && versaoValida(v) ? v : null)
      })
    } catch {
      resolve(null)
    }
  })
}

const defaultFetch = (u, o) => undiciFetch(u, { ...o, dispatcher: dispatcherFor(u) })

/**
 * @fires YtdlpUpdater#status
 * status() = { versao, origem: 'atualizado'|'app'|'sistema'|'env'|null, caminho?, ultima, verificadoEm, verificando, erro }
 */
export class YtdlpUpdater extends EventEmitter {
  /**
   * @param {{ dir: string, platform?: string, arch?: string, releasesBase?: string, fetch?: Function, everyMs?: number,
   *   firstDelayMs?: number, candidates?: () => Array, testar?: (bin) => Promise<string|null>, log?: Function, now?: () => number }} o
   */
  constructor({ dir, platform = process.platform, arch = process.arch, releasesBase = RELEASES, fetch = defaultFetch, everyMs = DIA, firstDelayMs = PRIMEIRA_MS, candidates, testar = versaoDoBinario, log = () => {}, now = Date.now } = {}) {
    super()
    if (!dir) throw new Error('YtdlpUpdater: dir é obrigatório')
    this.dir = dir
    this.platform = platform
    this.arch = arch
    this.releasesBase = releasesBase.replace(/\/+$/, '')
    this.fetch = fetch
    this.everyMs = everyMs
    this.firstDelayMs = firstDelayMs
    this.candidates = candidates || (() => ytdlpCandidates({ platform, arch }))
    this.testar = testar
    this.log = log
    this.now = now
    this.estadoFile = path.join(dir, 'estado.json')
    this.estado = null // { versao, arquivo, sha256, tamanho, atualizadoEm, verificadoEm }
    this.verificados = new Map() // caminho -> `${size}:${mtimeMs}` já conferido nesta sessão
    this.verificando = null
    this.erro = null
    this.ultima = null
    this.timer = null
    this.loaded = false
  }

  async init() {
    if (this.loaded) return
    this.loaded = true
    const raw = await readJSON(this.estadoFile, null).catch(() => null)
    if (raw && versaoValida(raw.versao) && /^[0-9a-f]{64}$/.test(raw.sha256 || '') && typeof raw.arquivo === 'string') this.estado = raw
    else if (raw) this.estado = { verificadoEm: Number(raw.verificadoEm) || 0 }
  }

  /** Liga a verificação: agora (se faz mais de um dia) e uma vez por dia. */
  start() {
    if (this.timer) return
    const tick = () => this.verificar().catch(err => this.log('yt-dlp: verificação falhou:', err?.message))
    const primeira = setTimeout(tick, this.firstDelayMs)
    primeira.unref?.()
    this.timer = setInterval(tick, Math.max(60_000, this.everyMs))
    this.timer.unref?.()
    this.primeira = primeira
  }

  stop() {
    clearInterval(this.timer)
    clearTimeout(this.primeira)
    this.timer = null
  }

  #exeAtualizado() {
    const e = this.estado
    return e?.versao && e.arquivo ? path.join(this.dir, e.versao, e.arquivo) : null
  }

  /** O binário atualizado, se existir e o SHA-256 ainda bater (senão é apagado e esquecido). */
  async #atualizadoConferido() {
    const exe = this.#exeAtualizado()
    if (!exe || !isFile(exe)) return null
    const st = await fsp.stat(exe)
    const marca = `${st.size}:${st.mtimeMs}`
    if (this.verificados.get(exe) === marca) return exe
    const sha = await sha256Arquivo(exe).catch(() => null)
    if (sha !== this.estado.sha256) {
      this.log('yt-dlp atualizado não confere com o SHA-256 gravado: apagando')
      await fsp.rm(path.dirname(exe), { recursive: true, force: true }).catch(() => {})
      this.estado = { verificadoEm: this.estado?.verificadoEm || 0 }
      await this.#gravar()
      return null
    }
    this.verificados.set(exe, marca)
    return exe
  }

  /**
   * Qual yt-dlp usar agora: SOBEDESCE_YTDLP; o atualizado (conferido) se for mais novo que o do app; o do app; o do sistema.
   * @returns {Promise<{ path: string, versao: string|null, origem: string }|null>}
   */
  async resolver() {
    await this.init()
    const cands = this.candidates()
    const env = cands.find(c => c.origem === 'env' && isFile(c.path))
    if (env) return { path: env.path, versao: null, origem: 'env' }
    const app = cands.find(c => c.origem === 'app' && isFile(c.path))
    const appVersao = app ? lerVersaoArquivo(app.versaoArquivo) : null
    const atualizado = await this.#atualizadoConferido()
    if (atualizado && (!app || !appVersao || compararVersao(this.estado.versao, appVersao) > 0)) return { path: atualizado, versao: this.estado.versao, origem: 'atualizado' }
    if (app) return { path: app.path, versao: appVersao, origem: 'app' }
    const sis = cands.find(c => c.origem === 'sistema' && isFile(c.path))
    if (sis) return { path: sis.path, versao: null, origem: 'sistema' }
    return null
  }

  status() {
    return {
      versao: this.estado?.versao || null,
      ultima: this.ultima,
      verificadoEm: this.estado?.verificadoEm || null,
      atualizadoEm: this.estado?.atualizadoEm || null,
      verificando: Boolean(this.verificando),
      erro: this.erro,
    }
  }

  async #gravar() {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 })
    await writeJSONAtomic(this.estadoFile, this.estado || {})
  }

  async #get(url, { manual = false } = {}) {
    return this.fetch(url, { redirect: manual ? 'manual' : 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'SOBEDESCE', accept: '*/*' } })
  }

  /** Tag do Release mais novo (pelo redirecionamento de /latest/download/SHA2-256SUMS: sem a API e o limite dela). */
  async ultimaVersao() {
    const res = await this.#get(`${this.releasesBase}/latest/download/${SUMS}`, { manual: true })
    await res.body?.cancel?.().catch?.(() => {})
    const loc = res.headers.get('location')
    const tag = res.status >= 300 && res.status < 400 ? tagDoEndereco(loc) : null
    if (!tag) throw new Error(`não consegui saber a versão mais nova (${res.status})`)
    return tag
  }

  /**
   * Confere se há yt-dlp mais novo e, se houver, baixa e confere. Nunca roda junto com outra verificação.
   * @param {{ forcar?: boolean }} [o] forcar = ignora o "uma vez por dia"
   * @returns {Promise<object>} status()
   */
  async verificar({ forcar = false } = {}) {
    await this.init()
    if (this.verificando) return this.verificando
    const ultimaVez = this.estado?.verificadoEm || 0
    if (!forcar && this.now() - ultimaVez < this.everyMs) return this.status()
    this.verificando = this.#verificar().finally(() => {
      this.verificando = null
      this.emit('status', this.status())
    })
    this.emit('status', this.status())
    return this.verificando
  }

  async #verificar() {
    const asset = ytdlpAsset(this.platform, this.arch)
    if (!asset) return this.status()
    try {
      const tag = await this.ultimaVersao()
      this.ultima = tag
      const atual = await this.resolver().catch(() => null)
      const atualVersao = atual?.origem === 'atualizado' || atual?.origem === 'app' ? atual.versao : null
      if (atualVersao && compararVersao(tag, atualVersao) <= 0) {
        this.erro = null
        this.estado = { ...(this.estado || {}), verificadoEm: this.now() }
        await this.#gravar()
        return this.status()
      }
      await this.#instalar(tag, asset)
      this.erro = null
    } catch (err) {
      this.erro = err?.message || String(err)
      this.log('yt-dlp: não atualizou:', this.erro)
      // Falhou: tenta de novo na próxima abertura (não grava verificadoEm).
    }
    return this.status()
  }

  async #instalar(tag, asset) {
    const sumsRes = await this.#get(`${this.releasesBase}/download/${encodeURIComponent(tag)}/${SUMS}`)
    if (!sumsRes.ok) throw new Error(`a lista de SHA-256 do yt-dlp ${tag} não abriu (${sumsRes.status})`)
    const sums = lerSums(await sumsRes.text())
    const esperado = sums.get(asset)
    if (!esperado) throw new Error(`o Release ${tag} não tem ${asset} na lista de SHA-256`)
    const pasta = path.join(this.dir, tag)
    const exe = path.join(pasta, ytdlpExe(this.platform))
    const tmp = `${exe}.baixando`
    await fsp.mkdir(pasta, { recursive: true, mode: 0o700 })
    let sha
    try {
      sha = await downloadTo(`${this.releasesBase}/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`, tmp, { fetch: this.fetch, maxBytes: MAX_BYTES })
    } catch (err) {
      await fsp.rm(pasta, { recursive: true, force: true }).catch(() => {})
      throw new Error(`o download do yt-dlp ${tag} falhou: ${err?.message || err}`)
    }
    if (sha !== esperado) {
      await fsp.rm(pasta, { recursive: true, force: true }).catch(() => {})
      throw new Error(`o yt-dlp ${tag} baixado não confere com o SHA-256 do Release (veio ${sha.slice(0, 12)}…)`)
    }
    await fsp.chmod(tmp, 0o755)
    await fsp.rename(tmp, exe)
    // Conferido: agora pode rodar. Se não responder a versão, não serve.
    const v = await this.testar(exe)
    if (!v) {
      await fsp.rm(pasta, { recursive: true, force: true }).catch(() => {})
      throw new Error(`o yt-dlp ${tag} baixado não abriu neste computador`)
    }
    const st = await fsp.stat(exe)
    const antigo = this.estado?.versao && this.estado.versao !== tag ? path.join(this.dir, this.estado.versao) : null
    this.estado = { versao: tag, arquivo: path.basename(exe), sha256: sha, tamanho: st.size, atualizadoEm: this.now(), verificadoEm: this.now() }
    this.verificados.set(exe, `${st.size}:${st.mtimeMs}`)
    await this.#gravar()
    if (antigo) await fsp.rm(antigo, { recursive: true, force: true }).catch(() => {})
    this.log(`yt-dlp atualizado para ${tag}`)
  }
}
