// Download de uma referência com o yt-dlp: linha de comando, progresso, erros em português e a limpeza.
//
// Formato: até 1080p, H.264 + AAC em MP4 quando existe (abre em qualquer editor, no QuickTime e no iPhone), senão o
// melhor MP4 até 1080p. VP9 e AV1 só em último caso: o Instagram manda VP9 em MP4 nos formatos separados e o iPhone
// não toca (o progressivo dele, H.264, vem antes); se ainda assim vier VP9/AV1, src/referencias/celular.js converte. Com ffmpeg (o do app ou do sistema) o yt-dlp junta vídeo + áudio separados (YouTube); sem ffmpeg só
// pede formatos que já vêm juntos (progressivos). Tudo numa pasta de trabalho só deste download (info .json e
// miniatura junto); quem chama apaga a pasta no fim, sempre.
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn as nodeSpawn, execFile } from 'node:child_process'
import { abortError } from '../util/backoff.js'
import { nomeDaPlataforma } from './plataformas.js'
import { limparTitulo } from './metadados.js'

export const MAX_ALTURA = 1080
const KiB = 1024
const TAIL = 16 * KiB // stderr guardado (só para o motivo do erro)
export const TIMEOUT_MS = 30 * 60_000 // um download inteiro
export const STALL_MS = 3 * 60_000 // sem nenhuma saída do yt-dlp por esse tempo: travou
const INFO_MAX = 8 * 1024 * 1024
const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm'])
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const PROG = 'SDPROG'

/** Codec que o iPhone toca (ou desconhecido: o progressivo do Instagram não diz, e é H.264). */
const TOCA = '[vcodec!^=?vp][vcodec!^=?av01]'

/**
 * Formato pedido ao yt-dlp. Com ffmpeg: vídeo + áudio separados (juntados em MP4); sem: só progressivos.
 * Ordem: H.264 separado (YouTube) → progressivo MP4 que toca no iPhone (Instagram, TikTok; vertical até 1920 de
 * altura) → MP4 separado que toca → qualquer MP4 (VP9/AV1, convertido depois) → o que houver.
 */
export function formato({ ffmpeg = true, altura = MAX_ALTURA } = {}) {
  const h = `[height<=${altura}]`
  const vertical = `[height<=?${Math.round((altura * 16) / 9)}]`
  if (ffmpeg) return `bv*${h}[vcodec^=avc1]+ba[ext=m4a]/b${vertical}[ext=mp4]${TOCA}/bv*${h}[ext=mp4]${TOCA}+ba[ext=m4a]/bv*${h}[ext=mp4]+ba[ext=m4a]/b${h}[ext=mp4]/b${h}/b`
  return `b${vertical}[ext=mp4]${TOCA}/b${h}[ext=mp4]/b[ext=mp4]/b${h}/b`
}

/**
 * Argumentos do yt-dlp (sem shell). Arquivos na pasta `workDir`: media.<ext>, info.info.json e a miniatura.
 * @param {{ url: string, workDir: string, ffmpeg?: string|null, cookies?: string|null, cacheDir?: string|null,
 *   jsRuntime?: { nome: string, path: string }|null, altura?: number, maxBytes?: string }} o
 */
export function montarArgs({ url, workDir, ffmpeg = null, cookies = null, cacheDir = null, jsRuntime = null, altura = MAX_ALTURA, maxBytes = '4G' }) {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error('link inválido')
  const args = [
    '--ignore-config',
    '--no-playlist',
    '--newline',
    '--color', 'never',
    '--no-mtime',
    '--encoding', 'utf-8',
    '--socket-timeout', '30',
    '--retries', '3',
    '--fragment-retries', '5',
    '--max-filesize', maxBytes,
    '-f', formato({ ffmpeg: Boolean(ffmpeg), altura }),
    '--write-info-json',
    '--write-thumbnail',
    '-P', workDir,
    '-o', 'media.%(ext)s',
    '-o', 'infojson:info',
    '-o', 'thumbnail:media.%(ext)s',
    '--progress-delta', '0.5',
    '--progress-template',
    `download:${PROG} %(progress.status)s %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s`,
  ]
  if (ffmpeg) args.push('--ffmpeg-location', ffmpeg, '--merge-output-format', 'mp4', '--convert-thumbnails', 'jpg')
  if (cookies) args.push('--cookies', cookies)
  args.push(cacheDir ? '--cache-dir' : '--no-cache-dir', ...(cacheDir ? [cacheDir] : []))
  // O YouTube exige um interpretador de JavaScript (desafios da página). O app passa o Node que ele mesmo tem.
  if (jsRuntime?.path) args.push('--js-runtimes', `${jsRuntime.nome || 'node'}:${jsRuntime.path}`)
  args.push('--', url)
  return args
}

const num = v => {
  if (v == null || v === 'NA' || v === 'None' || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Linha de progresso (`SDPROG status baixado total estimado velocidade eta`) → objeto, ou null. */
export function lerProgresso(linha) {
  const m = new RegExp(`^${PROG} (\\S+) (\\S+) (\\S+) (\\S+) (\\S+) (\\S+)\\s*$`).exec(String(linha).trim())
  if (!m) return null
  const baixado = num(m[2])
  const total = num(m[3]) ?? num(m[4])
  return {
    status: m[1],
    baixado: baixado ?? 0,
    total: total && total > 0 ? total : null,
    velocidade: num(m[5]),
    eta: num(m[6]),
    fracao: m[1] === 'finished' ? 1 : baixado != null && total ? Math.min(1, baixado / total) : null,
  }
}

/** "[info] abc: Downloading 1 format(s): 137+140" → 2 partes (vídeo e áudio separados). */
export function contarPartes(linha) {
  const m = /Downloading \d+ format\(s\):\s*(\S+)/.exec(String(linha))
  return m ? m[1].split('+').length : null
}

/**
 * Acompanha a saída do yt-dlp e devolve o progresso geral (as partes de vídeo e áudio somadas).
 * `onProgress({ fase: 'preparando'|'baixando'|'juntando', fracao: 0..1|null, baixado, total, velocidade })`
 */
export class Progresso {
  constructor(onProgress) {
    this.onProgress = onProgress || (() => {})
    this.partes = 1
    this.parte = 0
    this.fase = 'preparando'
    this.feitas = 0 // bytes das partes que já terminaram
    this.ultimo = null
  }

  linha(l) {
    const s = String(l)
    const n = contarPartes(s)
    if (n) {
      this.partes = n
      return
    }
    if (/^\[Merger\]|^\[VideoConvertor\]|^\[FixupM3u8\]|^\[ExtractAudio\]/.test(s)) {
      this.fase = 'juntando'
      return this.#emit({ fracao: 1 })
    }
    const p = lerProgresso(s)
    if (!p) return
    this.fase = 'baixando'
    if (p.status === 'finished') {
      this.feitas += p.total || p.baixado || 0
      this.parte = Math.min(this.partes, this.parte + 1)
      return this.#emit({ fracao: this.parte / this.partes, velocidade: null })
    }
    const parcial = p.fracao == null ? null : (Math.min(this.parte, this.partes - 1) + p.fracao) / this.partes
    this.#emit({ fracao: parcial, baixado: this.feitas + p.baixado, total: p.total != null ? this.feitas + p.total : null, velocidade: p.velocidade })
  }

  #emit(extra) {
    const info = { fracao: null, baixado: null, total: null, velocidade: null, ...this.ultimo, ...extra, fase: this.fase }
    this.ultimo = info
    try {
      this.onProgress(info)
    } catch {}
  }
}

// ─────────── erros ───────────

/** Erro do yt-dlp com motivo curto para a pessoa (`message`) e a última linha técnica (`detalhe`, só para o log). */
export class YtdlpError extends Error {
  constructor(codigo, message, { detalhe = '', transitorio = false } = {}) {
    super(message)
    this.name = 'YtdlpError'
    this.codigo = codigo
    this.detalhe = detalhe
    this.transitorio = transitorio
  }
}

/** Últimas linhas "ERROR:" do stderr (ou a última linha útil). */
export function linhaDeErro(stderr) {
  const linhas = String(stderr || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const erros = linhas.filter(l => /^ERROR:/.test(l))
  return (erros[erros.length - 1] || linhas[linhas.length - 1] || '').slice(0, 400)
}

/**
 * stderr do yt-dlp → YtdlpError com mensagem humana. `plataforma`: chave de plataformas.js (para "O Instagram pediu login").
 */
export function classificarErro(stderr, { plataforma = '' } = {}) {
  const det = linhaDeErro(stderr)
  const t = String(stderr || '')
  const nome = nomeDaPlataforma(plataforma) || 'site'
  const site = plataforma && plataforma !== 'web' ? nome : 'site'
  const art = site === 'site' ? 'O site' : `O ${site}`
  const ondeEntrar = site === 'site' ? 'entre no site pelo navegador de referências' : `entre no ${site} pelo navegador de referências`
  const e = (codigo, msg, transitorio = false) => new YtdlpError(codigo, msg, { detalhe: det, transitorio })
  if (/ffmpeg (?:is )?not (?:found|installed)|ffmpeg could not be found|ffprobe and ffmpeg not found/i.test(t)) return e('ffmpeg', 'Faltou o ffmpeg para juntar vídeo e áudio.')
  if (/requested format is not available/i.test(t)) return e('formato', 'Este vídeo não tem um formato que dê para baixar aqui.')
  if (/no video (?:in|could be found)|there is no video|no video formats found|this post (?:has|contains) no video|no media found/i.test(t)) {
    return e('sem_video', 'Esse post não tem vídeo. Para salvar a foto, abra no navegador de referências e use “Salvar imagem como referência”.')
  }
  if (/sign in to confirm|not a bot|login required|log ?in required|logged[- ]in|use --cookies|cookies-from-browser|rate-limit reached or login|requires? (?:a )?login|only available for registered users|account is private|you need to log in|age[- ]restricted|confirm your age|inappropriate for some users/i.test(t)) {
    return e('login', `${art} pediu login: ${ondeEntrar}.`)
  }
  if (/private video|video unavailable|has been removed|no longer available|was deleted|does not exist|this (?:post|content|video|page) (?:is|isn.t) (?:unavailable|available)|content isn.t available|HTTP Error 404|HTTP Error 410|not found/i.test(t)) {
    return e('indisponivel', 'Vídeo privado ou removido.')
  }
  if (/not available in your country|geo.?restrict|blocked it in your country/i.test(t)) return e('regiao', 'Este vídeo não está disponível no Brasil.')
  if (/unsupported url/i.test(t)) return e('nao_suportado', 'Esse link não é de um vídeo que dê para salvar.')
  if (/larger than max-filesize|file is larger than/i.test(t)) return e('grande', 'O vídeo é grande demais para uma referência (mais de 4 GB).')
  if (/HTTP Error 429|too many requests|rate.?limit/i.test(t)) return e('limite', `${art} limitou os downloads agora. Tente de novo daqui a pouco.`, true)
  if (/HTTP Error 403|forbidden/i.test(t)) return e('recusado', `${art} recusou o download agora. Tente de novo mais tarde.`, true)
  if (/unable to download (?:webpage|json|api)|getaddrinfo|name or service not known|nodename nor servname|timed? ?out|connection (?:refused|reset|aborted)|network is unreachable|temporary failure in name resolution|ssl|certificate/i.test(t)) {
    return e('rede', 'Sem conexão com o site do vídeo. Confira a internet.', true)
  }
  return e('erro', 'Não deu para baixar este vídeo.')
}

// ─────────── rodar ───────────

/** Mata o yt-dlp e o que ele abriu (ffmpeg; no Mac/Windows o yt-dlp empacotado também é dois processos). */
export function matarArvore(child, platform = process.platform) {
  if (!child?.pid || child.exitCode != null) return
  if (platform === 'win32') {
    try {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    } catch {}
    try {
      child.kill('SIGKILL')
    } catch {}
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL') // grupo inteiro (spawn com detached: true)
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {}
  }
}

/** Arquivos que o yt-dlp deixou na pasta: o vídeo (o maior), a miniatura e o info .json. */
export async function acharArquivos(workDir) {
  const nomes = await fs.readdir(workDir).catch(() => [])
  let video = null
  let miniatura = null
  let info = null
  for (const n of nomes) {
    if (/\.(part|ytdl|temp|tmp)$/i.test(n) || /\.part-Frag\d+/i.test(n)) continue
    const p = path.join(workDir, n)
    const ext = path.extname(n).toLowerCase()
    if (n.endsWith('.info.json')) info = p
    else if (VIDEO_EXTS.has(ext)) {
      const st = await fs.stat(p).catch(() => null)
      if (st?.isFile() && (!video || st.size > video.size)) video = { path: p, size: st.size, ext: ext.slice(1) }
    } else if (IMAGE_EXTS.has(ext)) {
      // Prefere o .jpg convertido (o Drive aceita JPEG/PNG/GIF na miniatura).
      if (!miniatura || ext === '.jpg') miniatura = p
    }
  }
  return { video, miniatura, info }
}

/** Lê o info .json (tolerante: lixo vira {}). */
export async function lerInfo(file) {
  if (!file) return {}
  try {
    const st = await fs.stat(file)
    if (st.size > INFO_MAX) return {}
    const data = JSON.parse(await fs.readFile(file, 'utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch {
    return {}
  }
}

/** O que importa do info .json para o nome e a descrição. */
export function resumoInfo(info, url) {
  const s = v => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const autor = s(info.uploader) || s(info.channel) || s(info.creator) || s(info.uploader_id) || s(info.artist)
  let titulo = s(info.title) || s(info.fulltitle)
  // Instagram/TikTok: o "título" costuma ser "Video by fulano" ou a legenda inteira; a legenda vai na descrição.
  if (titulo && /^(video|post|reel) by /i.test(titulo)) titulo = null
  const legenda = s(info.description) || ''
  if (!titulo && legenda) titulo = legenda.split(/\r?\n/).find(l => l.trim()) || null
  if (titulo) titulo = limparTitulo(titulo) || null
  return {
    id: s(info.id) || s(info.display_id),
    titulo,
    autor,
    legenda,
    extrator: s(info.extractor_key) || s(info.extractor),
    pagina: s(info.webpage_url) || url,
    duracao: Number.isFinite(Number(info.duration)) ? Number(info.duration) : null,
    largura: Number(info.width) || null,
    altura: Number(info.height) || null,
  }
}

/**
 * Roda o yt-dlp. Resolve com os arquivos e o resumo; rejeita com YtdlpError (motivo humano) ou AbortError.
 * Nunca deixa processo para trás: tempo limite, travamento e cancelamento matam a árvore inteira.
 * @param {{ bin: string, url: string, workDir: string, plataforma?: string, ffmpeg?: string|null, cookies?: string|null,
 *   cacheDir?: string|null, jsRuntime?: { nome, path, env? }|null, signal?: AbortSignal, onProgress?: Function,
 *   timeoutMs?: number, stallMs?: number, spawn?: Function, env?: object, log?: Function }} o
 */
export async function baixarVideo(o) {
  const { bin, url, workDir, plataforma = '', signal, onProgress, timeoutMs = TIMEOUT_MS, stallMs = STALL_MS, spawn = nodeSpawn, log = () => {} } = o
  if (signal?.aborted) throw abortError(signal)
  await fs.mkdir(workDir, { recursive: true, mode: 0o700 })
  const args = montarArgs(o)
  const prog = new Progresso(onProgress)
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...(o.jsRuntime?.env || {}), ...(o.env || {}) }
  const r = await new Promise(resolve => {
    let child
    let stderr = ''
    let resto = ''
    let done = false
    let motivo = null
    let stall = null
    const finish = res => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(stall)
      signal?.removeEventListener('abort', onAbort)
      resolve({ stderr, motivo, ...res })
    }
    const stop = m => {
      motivo ??= m
      matarArvore(child)
      // O 'close' pode demorar (netos segurando o pipe): não espera por ele.
      setTimeout(() => finish({ code: null }), 2000).unref?.()
    }
    const onAbort = () => stop('abort')
    const timer = setTimeout(() => stop('timeout'), Math.max(1, timeoutMs))
    const poke = () => {
      clearTimeout(stall)
      stall = setTimeout(() => stop('stall'), Math.max(1, stallMs))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      child = spawn(bin, args, { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32', env })
    } catch (error) {
      return finish({ code: null, error })
    }
    poke()
    child.stdout.on('data', d => {
      poke()
      const text = resto + d.toString('utf8')
      const linhas = text.split(/\r?\n/)
      resto = linhas.pop() || ''
      for (const l of linhas) prog.linha(l)
    })
    child.stderr.on('data', d => {
      poke()
      stderr = (stderr + d.toString('utf8')).slice(-TAIL)
    })
    child.on('error', error => finish({ code: null, error }))
    child.on('close', code => {
      if (resto) prog.linha(resto)
      finish({ code })
    })
  })
  if (r.motivo === 'abort') throw abortError(signal)
  if (r.motivo === 'timeout') throw new YtdlpError('tempo', 'O download demorou demais e foi interrompido.', { transitorio: true })
  if (r.motivo === 'stall') throw new YtdlpError('travou', 'O download parou de andar. Tente de novo.', { transitorio: true })
  if (r.error) throw new YtdlpError('sem_ytdlp', 'Não consegui abrir o yt-dlp neste computador.', { detalhe: String(r.error.code || r.error.message) })
  if (r.code !== 0) {
    const err = classificarErro(r.stderr, { plataforma })
    log('yt-dlp falhou:', err.codigo, err.detalhe)
    throw err
  }
  const arquivos = await acharArquivos(workDir)
  if (!arquivos.video) throw new YtdlpError('sem_video', 'O download terminou sem nenhum vídeo. Esse link tem vídeo?', { detalhe: linhaDeErro(r.stderr) })
  const info = await lerInfo(arquivos.info)
  return { ...arquivos, info, resumo: resumoInfo(info, url) }
}
