// Prévia leve: uma cópia H.264 em 720p (≈ 2,5 Mbit/s, AAC estéreo, faststart) de cada vídeo pesado, gravada em
// `Proxy/<nome>.mp4` ao lado do original no Drive. É o que faz a prévia tocar fluida (no celular, no app e no site da
// produtora), do mesmo jeito que o Google Drive toca a cópia leve que ele mesmo gera. O original nunca muda.
//
// Quem converte (docs/ARCHITECTURE.md, "media/previa.js"):
//  - ffmpeg: o que vem dentro do app (<Resources>/ffmpeg/), o de SOBEDESCE_FFMPEG ou um instalado no sistema.
//    Codificador de vídeo: o do chip/placa quando existe e passa num teste de 1 quadro (Mac: VideoToolbox; Windows:
//    NVENC, Quick Sync, AMF ou Media Foundation), senão libx264 (veryfast, CRF 24, teto de 3 Mbit/s).
//    720p a ≈ 2,5 Mbit/s é a qualidade que o próprio Drive usa para tocar sem engasgar: o proxy é para ver, não para editar.
//  - Mac sem ffmpeg que rode: /usr/bin/avconvert (AVFoundation, acelerado por hardware), só para o que o macOS abre.
//  - Blackmagic RAW: a imagem vem do ajudante nativo (Blackmagic RAW SDK instalado) e o ffmpeg codifica (media/braw.js).
// Tudo com prioridade baixa (nice / BELOW_NORMAL), um por vez, cancelável e com tempo limite proporcional à duração.
// Nada aqui lança para fora sem motivo claro: quem chama recebe { estado, motivo } e segue.
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { abortError } from '../util/backoff.js'
import { argsBrawTranscode, brawInfo, detectarBraw, isBrawName, runPipe } from './braw.js'

const MB = 1e6
const KiB = 1024

/** Nome da subpasta onde a cópia leve fica (a mesma convenção das câmeras Blackmagic: Proxy/<nome>.mp4). */
export const PREVIA_PASTA = 'Proxy'
/** Marca da cópia no Drive (`appProperties`): só o SOBEDESCE escreve e lê; a prévia mostra "Prévia leve". */
export const PREVIA_MARCA = 'previa'
/** Lado maior da cópia (px): 720p, como a reprodução do Drive. */
export const PREVIA_LADO = 1280
/** Lado maior até onde um H.264 leve não precisa de cópia (1080p). */
export const LEVE_LADO = 1920
/** Vídeo H.264 8 bits até 1080p com menos que isto já é leve o bastante. */
export const PEQUENO_BYTES = 50 * MB
/** Acima desta taxa (Mbit/s) o original não toca liso pela rede. */
export const LIMITE_MBPS = 20

/** Extensões de vídeo que valem cópia leve (o resto nem é olhado). */
export const VIDEO_EXTS = Object.freeze([
  '.mp4', '.mov', '.m4v', '.mxf', '.mkv', '.avi', '.mts', '.m2ts', '.ts', '.mpg', '.mpeg', '.m2v', '.wmv', '.webm',
  '.3gp', '.dv', '.flv', '.hevc', '.h265', '.h264', '.264', '.265', '.vob', '.mod', '.tod',
])
/** RAW de câmera: o ffmpeg não decodifica (BRAW, R3D, ARRIRAW, Cinema DNG…); a câmera já grava o proxy dela. */
export const RAW_EXTS = Object.freeze(['.braw', '.r3d', '.ari', '.arx', '.crm', '.cine', '.dng', '.nev', '.mcraw'])
/** Extensões de proxy reconhecidas na mesma pasta ou em Proxy/Proxies (iguais às da prévia). */
export const PROXY_EXTS = Object.freeze(['.mp4', '.mov', '.m4v'])
export const PROXY_DIRS = Object.freeze(['proxy', 'proxies'])
/** O que o macOS (AVFoundation) costuma abrir: o avconvert só tenta estes. */
const AVFOUNDATION_EXTS = new Set(['.mp4', '.mov', '.m4v'])
const WEB_CONTAINERS = new Set(['.mp4', '.m4v', '.mov'])

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(HERE, '..', '..')

const TAIL = 8 * KiB // stderr guardado de cada processo (só para o motivo da falha)
const STALL_MS = 5 * 60_000 // sem nenhuma saída do conversor por esse tempo: travou
const PROBE_TIMEOUT_MS = 60_000
const VERSION_TIMEOUT_MS = 15_000
const TEST_TIMEOUT_MS = 20_000

export function splitExt(name) {
  const s = String(name ?? '')
  const i = s.lastIndexOf('.')
  return i > 0 ? [s.slice(0, i), s.slice(i).toLowerCase()] : [s, '']
}

/** Chave do nome-base para achar o proxy: NFC e sem diferenciar maiúsculas. */
export function baseKey(name) {
  return splitExt(name)[0].normalize('NFC').toLowerCase()
}

/** Vídeo que pode ganhar cópia leve (pela extensão; RAW de câmera fica de fora). */
export function isVideoName(name) {
  const ext = splitExt(name)[1]
  return VIDEO_EXTS.includes(ext) && !RAW_EXTS.includes(ext)
}

export const isRawName = name => RAW_EXTS.includes(splitExt(name)[1])

/**
 * Pode ganhar proxy neste computador? Vídeo comum sempre; .braw só com o ajudante do Blackmagic RAW funcionando
 * (`motor.braw.ok`, de detectarMotor).
 */
export const podeTerProxy = (name, motor) => isVideoName(name) || (isBrawName(name) && !!motor?.braw?.ok)
export { isBrawName }

/** Nome da cópia leve: o mesmo nome-base com .mp4. */
export function previaName(name) {
  return `${splitExt(String(name ?? '').normalize('NFC'))[0] || 'video'}.mp4`
}

/** `cand` serve de proxy de um arquivo chamado `name`? (mesmo nome-base, extensão de vídeo comum). */
export function isProxyName(cand, name) {
  const [, ext] = splitExt(cand)
  return PROXY_EXTS.includes(ext) && baseKey(cand) === baseKey(name)
}

export const isProxyDirName = name => PROXY_DIRS.includes(String(name ?? '').trim().toLowerCase())

// ─────────── leitura do arquivo (ffmpeg -i) ───────────

/** "00:01:02.50" → 62.5 */
function hms(s) {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(s).trim())
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null
}

/** Separa por vírgula fora de parênteses ("yuv420p(tv, bt709), 1920x1080" → 2 partes). */
function splitTop(s) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/**
 * Lê a saída de `ffmpeg -i <arquivo>` (stderr). Sem ffprobe: o ffmpeg sozinho diz tudo o que a decisão precisa.
 * @returns {{ durationS: number|null, bitrate: number|null, video: null|{ codec, profile, pixFmt, bits, width, height,
 *   bitrate, sar }, audio: boolean, rotation: number }}
 */
export function parseProbe(text) {
  const out = { durationS: null, bitrate: null, video: null, audio: false, rotation: 0 }
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const d = /Duration:\s*([\d:.]+|N\/A)(?:,.*?bitrate:\s*(\d+)\s*kb\/s)?/.exec(line)
    if (d && out.durationS == null) {
      out.durationS = d[1] === 'N/A' ? null : hms(d[1])
      if (d[2]) out.bitrate = Number(d[2]) * 1000
      continue
    }
    const s = /Stream #\d+:\d+.*?: (Video|Audio): (.*)$/.exec(line)
    if (!s) {
      const r = /rotation of (-?[\d.]+) degrees/.exec(line) || /^\s*rotate\s*:\s*(-?\d+)/.exec(line)
      if (r && out.video && !out.rotation) out.rotation = Math.round(Number(r[1])) || 0
      continue
    }
    if (s[1] === 'Audio') {
      out.audio = true
      continue
    }
    if (out.video || /attached pic/.test(s[2])) continue
    const parts = splitTop(s[2])
    const head = parts[0] || ''
    const codec = (/^([\w-]+)/.exec(head) || [])[1] || ''
    const profile = (/^[\w-]+\s+\(([^)]+)\)/.exec(head) || [])[1] || null
    const pix = parts[1] && !/^\d+x\d+/.test(parts[1]) ? (/^([\w]+)/.exec(parts[1]) || [])[1] || null : null
    const dims = /(?:^|\s)(\d{2,5})x(\d{2,5})(?:\s|$|\[)/.exec(parts.find(p => /\d{2,5}x\d{2,5}/.test(p)) || '')
    const br = parts.map(p => /^(\d+)\s*kb\/s/.exec(p)).find(Boolean)
    const sar = /SAR (\d+):(\d+)/.exec(s[2])
    const deep = pix ? /p(\d{2})(le|be)?$/.exec(pix) : null
    const bits = deep ? Number(deep[1]) : pix && /^(yuv|yuvj|nv|gray|rgb|bgr)/.test(pix) ? 8 : null
    out.video = {
      codec: codec.toLowerCase(),
      profile,
      pixFmt: pix,
      bits,
      width: dims ? Number(dims[1]) : null,
      height: dims ? Number(dims[2]) : null,
      bitrate: br ? Number(br[1]) * 1000 : null,
      sar: sar && Number(sar[1]) > 0 && Number(sar[2]) > 0 ? [Number(sar[1]), Number(sar[2])] : null,
    }
  }
  return out
}

const CODEC_LABEL = { prores: 'ProRes', dnxhd: 'DNxHD/HR', hevc: 'HEVC', h264: 'H.264', mpeg2video: 'MPEG-2', av1: 'AV1', vp9: 'VP9', mjpeg: 'MJPEG', dvvideo: 'DV', cfhd: 'CineForm' }

/**
 * Este vídeo precisa de cópia leve? Pesado (taxa > 20 Mbit/s), codec que não é H.264 8 bits 4:2:0 (ProRes, DNx,
 * HEVC 10 bits, XAVC Intra…), maior que 1920 px ou num contêiner que o navegador não abre. H.264 até 1080p com
 * menos de 50 MB fica como está.
 * @param {ReturnType<typeof parseProbe>|null} info null = sem como olhar (só avconvert): decide pelo nome e tamanho
 * @returns {{ gerar: boolean, motivo: string }}
 */
export function precisaPrevia(info, { name = '', size = null } = {}) {
  const ext = splitExt(name)[1]
  if (RAW_EXTS.includes(ext)) return { gerar: false, motivo: 'RAW de câmera (use o proxy da câmera)' }
  if (!info) {
    if (!AVFOUNDATION_EXTS.has(ext)) return { gerar: false, motivo: 'formato que o macOS não converte sem o ffmpeg' }
    if (size != null && size < PEQUENO_BYTES) return { gerar: false, motivo: 'já é leve' }
    return { gerar: true, motivo: 'vídeo grande' }
  }
  const v = info.video
  if (!v) return { gerar: false, motivo: 'sem imagem de vídeo' }
  const long = Math.max(v.width || 0, v.height || 0)
  const bps = v.bitrate || info.bitrate || (size && info.durationS ? (size * 8) / info.durationS : 0)
  const mbps = bps / MB
  const h264 = v.codec === 'h264' && (v.bits == null || v.bits === 8) && (!v.pixFmt || /^(yuvj?420p|nv12)$/.test(v.pixFmt))
  if (h264 && long <= LEVE_LADO && size != null && size < PEQUENO_BYTES) return { gerar: false, motivo: 'já é leve' }
  if (!h264) {
    const label = CODEC_LABEL[v.codec] || v.codec.toUpperCase() || 'codec'
    return { gerar: true, motivo: v.bits && v.bits > 8 ? `${label} ${v.bits} bits` : label }
  }
  if (long > LEVE_LADO) return { gerar: true, motivo: `${v.width}×${v.height}` }
  if (mbps > LIMITE_MBPS) return { gerar: true, motivo: `${Math.round(mbps)} Mbit/s` }
  if (!WEB_CONTAINERS.has(ext)) return { gerar: true, motivo: `${ext.slice(1).toUpperCase()} não toca no navegador` }
  return { gerar: false, motivo: 'já é leve' }
}

// ─────────── argumentos ───────────

/** Codificadores de H.264 por hardware, na ordem de preferência de cada sistema. */
export const HW_ENCODERS = Object.freeze({
  darwin: ['h264_videotoolbox'],
  win32: ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf'],
  linux: ['h264_nvenc', 'h264_qsv'],
})

const ENCODER_LABEL = {
  h264_videotoolbox: 'Usando o chip de vídeo do Mac',
  h264_nvenc: 'Usando a placa de vídeo NVIDIA',
  h264_qsv: 'Usando o vídeo do processador Intel',
  h264_amf: 'Usando a placa de vídeo AMD',
  h264_mf: 'Usando o codificador de vídeo do Windows',
  libx264: 'Usando o ffmpeg',
}

/** Formato de pixel que cada codificador aceita melhor. */
const pixFor = encoder => (encoder === 'h264_qsv' || encoder === 'h264_mf' ? 'nv12' : 'yuv420p')

/** Parâmetros de cada codificador: ≈ 2,5 Mbit/s VBR, teto de 3,5 Mbit/s, perfil High (720p como o Drive toca). */
export function encoderArgs(encoder) {
  const vbr = ['-b:v', '2500k', '-maxrate', '3500k', '-bufsize', '5M']
  switch (encoder) {
    case 'h264_videotoolbox':
      return ['-c:v', encoder, '-b:v', '2500k', '-profile:v', 'high', '-allow_sw', '1', '-realtime', '0']
    case 'h264_nvenc':
      return ['-c:v', encoder, '-preset', 'p5', '-rc', 'vbr', ...vbr, '-profile:v', 'high']
    case 'h264_qsv':
      return ['-c:v', encoder, '-preset', 'medium', ...vbr, '-profile:v', 'high']
    case 'h264_amf':
      return ['-c:v', encoder, '-quality', 'balanced', '-rc', 'vbr_peak', ...vbr, '-profile:v', 'high']
    case 'h264_mf':
      return ['-c:v', encoder, '-hw_encoding', '1', '-rate_control', 'u_vbr', '-b:v', '2500k']
    case 'libx264':
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-maxrate', '3M', '-bufsize', '6M', '-profile:v', 'high']
  }
}

/** Filtro de vídeo: pixels quadrados (anamórfico), lado maior ≤ `lado` (1280 = 720p), dimensões pares, 8 bits 4:2:0. */
export function videoFilter(info, encoder, lado = PREVIA_LADO) {
  const f = []
  const sar = info?.video?.sar
  if (sar && sar[0] !== sar[1]) f.push("scale=w='trunc(iw*sar/2)*2':h=ih", 'setsar=1')
  f.push(`scale=w='min(${lado},iw)':h='min(${lado},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`)
  f.push(`format=${pixFor(encoder)}`)
  return f.join(',')
}

/**
 * Linha de comando da conversão (sem shell). A rotação do celular é aplicada na imagem (autorotate do ffmpeg),
 * então a cópia sai em pé. Só a primeira trilha de vídeo e a primeira de áudio (estéreo, AAC 128k).
 */
export function argsTranscode({ input, output, encoder = 'libx264', info = null, hwDecode = false, lado = PREVIA_LADO }) {
  const a = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats']
  if (hwDecode) a.push('-hwaccel', 'videotoolbox')
  a.push('-i', input, '-map', '0:v:0')
  const audio = info ? info.audio : true
  if (audio) a.push('-map', '0:a:0?')
  a.push('-dn', '-sn', '-map_chapters', '-1')
  a.push('-vf', videoFilter(info, encoder, lado))
  a.push(...encoderArgs(encoder), '-g', '60')
  if (audio) a.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2')
  else a.push('-an')
  a.push('-movflags', '+faststart', '-f', 'mp4', output)
  return a
}

/** Teste de 1 quadro: o codificador existe na lista, mas só vale se a máquina tiver o chip/placa e o driver. */
export function argsEncoderTest(encoder) {
  return ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=25:d=0.2', '-frames:v', '3',
    '-vf', `format=${pixFor(encoder)}`, ...encoderArgs(encoder), '-f', 'null', '-']
}

/** Tentativas, da mais rápida para a mais garantida (sem repetir): hardware com decodificação no chip, hardware, libx264. */
export function plano(motor, platform = process.platform) {
  const enc = motor?.encoder?.nome
  const out = []
  const add = (encoder, hwDecode) => {
    if (encoder && !out.some(p => p.encoder === encoder && p.hwDecode === hwDecode)) out.push({ encoder, hwDecode })
  }
  if (enc && enc !== 'libx264') {
    if (platform === 'darwin') add(enc, true)
    add(enc, false)
  }
  if (motor?.encoders?.includes('libx264') || enc === 'libx264') add('libx264', false)
  return out
}

// ─────────── processos ───────────

/**
 * Roda um programa (sem shell) com prioridade baixa. Nunca rejeita.
 * `stallMs`: sem nenhuma saída por esse tempo → mata. `onStdout(texto)` recebe a saída aos pedaços.
 * @returns {Promise<{ code, timedOut, stalled, aborted, error, stdout, stderr }>}
 */
export function runTool(cmd, args, { signal, timeoutMs = 60_000, stallMs = 0, onStdout, lowPriority = true, env } = {}) {
  return new Promise(resolve => {
    let child
    let stdout = ''
    let stderr = ''
    let done = false
    let timedOut = false
    let stalled = false
    let aborted = false
    let stallTimer = null
    const finish = r => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(stallTimer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ stdout, stderr, timedOut, stalled, aborted, ...r })
    }
    const kill = () => {
      try {
        child?.kill('SIGKILL')
      } catch {}
    }
    const onAbort = () => {
      aborted = true
      kill()
      finish({ code: null })
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
      finish({ code: null })
    }, Math.max(1, timeoutMs))
    const poke = () => {
      if (!stallMs) return
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        stalled = true
        kill()
        finish({ code: null })
      }, stallMs)
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: env ? { ...process.env, ...env } : process.env })
    } catch (error) {
      return finish({ code: null, error })
    }
    if (lowPriority && child.pid) {
      // nice 10 no Mac/Linux, BELOW_NORMAL no Windows: só usa o processador que sobra.
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
      } catch {}
    }
    poke()
    child.stdout.on('data', d => {
      poke()
      const s = d.toString('utf8')
      if (stdout.length < 64 * KiB) stdout += s
      try {
        onStdout?.(s)
      } catch {}
    })
    child.stderr.on('data', d => {
      poke()
      stderr = (stderr + d.toString('utf8')).slice(-TAIL)
    })
    child.on('error', error => finish({ code: null, error }))
    child.on('close', code => finish({ code }))
  })
}

/** Última linha útil do stderr (para o motivo da falha). */
function lastLine(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  return (lines[lines.length - 1] || '').slice(0, 200)
}

// ─────────── onde está o ffmpeg ───────────

const osTag = platform => (platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux')

/**
 * Caminhos para tentar, na ordem: SOBEDESCE_FFMPEG, o que vem no app (`<Resources>/ffmpeg/`), o baixado para
 * desenvolvimento (`build/ffmpeg/<mac|win|linux>-<arch>/`) e o do sistema (Homebrew e PATH).
 * @returns {Array<{ path: string, origem: 'env'|'app'|'sistema' }>}
 */
export function ffmpegCandidates({ env = process.env, platform = process.platform, arch = process.arch, resourcesPath = process.resourcesPath, appRoot = APP_ROOT } = {}) {
  const exe = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const P = platform === 'win32' ? path.win32 : path.posix
  const out = []
  const add = (p, origem) => {
    if (p && !out.some(c => c.path === p)) out.push({ path: p, origem })
  }
  if (env.SOBEDESCE_FFMPEG) add(env.SOBEDESCE_FFMPEG, 'env')
  if (resourcesPath) add(P.join(resourcesPath, 'ffmpeg', exe), 'app')
  // Empacotado: o código fica em <Resources>/app.asar (ou app/), o ffmpeg em <Resources>/ffmpeg.
  add(P.join(appRoot, '..', 'ffmpeg', exe), 'app')
  add(P.join(appRoot, 'build', 'ffmpeg', `${osTag(platform)}-${arch}`, exe), 'app')
  // App aberto pelo Finder não herda o PATH do terminal: os lugares do Homebrew entram à mão.
  if (platform === 'darwin') for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) add(p, 'sistema')
  const sep = platform === 'win32' ? ';' : ':'
  for (const dir of String(env.PATH || env.Path || '').split(sep)) if (dir) add(P.join(dir, exe), 'sistema')
  return out
}

async function exists(p) {
  try {
    const st = await fsp.stat(p)
    return st.isFile()
  } catch {
    return false
  }
}

/** Versão do ffmpeg ("9.0.2"), ou null se não roda. */
async function ffmpegVersion(bin, signal) {
  const r = await runTool(bin, ['-hide_banner', '-version'], { timeoutMs: VERSION_TIMEOUT_MS, signal, lowPriority: false })
  if (r.code !== 0) return null
  const m = /ffmpeg version (\S+)/.exec(r.stdout || r.stderr)
  return m ? m[1] : 'desconhecida'
}

/** Nomes dos codificadores de vídeo H.264 que este ffmpeg conhece. */
async function listEncoders(bin, signal) {
  const r = await runTool(bin, ['-hide_banner', '-encoders'], { timeoutMs: VERSION_TIMEOUT_MS, signal, lowPriority: false })
  const names = new Set()
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    const m = /^\s*V\S*\s+(\S+)/.exec(line)
    if (m) names.add(m[1])
  }
  return names
}

/**
 * O que este computador tem para gerar a cópia leve (ffmpeg + codificador testado, ou avconvert no Mac).
 * `braw`: troca o detectarBraw (testes; null não procura o ajudante do Blackmagic RAW).
 * @returns {Promise<{ via: 'ffmpeg'|'avconvert'|null, ffmpeg: null|{ path, versao, origem }, encoder: null|{ nome, hardware },
 *   encoders: string[], avconvert: string|null, braw: null|{ path, ok, motivo }, label: string, aviso: string|null,
 *   testados: object[] }>}
 */
export async function detectarMotor({ env = process.env, platform = process.platform, arch = process.arch, resourcesPath = process.resourcesPath, appRoot = APP_ROOT, signal, avconvertPath = '/usr/bin/avconvert', candidates, braw = detectarBraw } = {}) {
  const out = { via: null, ffmpeg: null, encoder: null, encoders: [], avconvert: null, braw: null, label: '', aviso: null, testados: [] }
  for (const c of candidates ?? ffmpegCandidates({ env, platform, arch, resourcesPath, appRoot })) {
    if (signal?.aborted) throw abortError(signal)
    if (!(await exists(c.path))) continue
    const versao = await ffmpegVersion(c.path, signal)
    if (!versao) {
      out.testados.push({ path: c.path, ok: false })
      continue
    }
    out.ffmpeg = { path: c.path, versao, origem: c.origem }
    break
  }
  if (out.ffmpeg) {
    const names = await listEncoders(out.ffmpeg.path, signal)
    out.encoders = [...names].filter(n => /h264|x264/.test(n))
    for (const enc of HW_ENCODERS[platform] || []) {
      if (!names.has(enc)) continue
      const r = await runTool(out.ffmpeg.path, argsEncoderTest(enc), { timeoutMs: TEST_TIMEOUT_MS, signal, lowPriority: false })
      out.testados.push({ encoder: enc, ok: r.code === 0 })
      if (r.code === 0) {
        out.encoder = { nome: enc, hardware: true }
        break
      }
    }
    if (!out.encoder && names.has('libx264')) out.encoder = { nome: 'libx264', hardware: false }
    if (out.encoder) out.via = 'ffmpeg'
  }
  // Proxy de BRAW: só com o ffmpeg (o avconvert não lê vídeo cru pelo cano).
  if (out.via === 'ffmpeg' && braw) {
    out.braw = await braw({ env, platform, resourcesPath, signal }).catch(err => {
      if (signal?.aborted) throw err
      return null
    })
  }
  if (!out.via && platform === 'darwin' && (await exists(avconvertPath))) {
    out.avconvert = avconvertPath
    out.via = 'avconvert'
  }
  if (out.via === 'ffmpeg') out.label = ENCODER_LABEL[out.encoder.nome] || 'Usando o ffmpeg'
  else if (out.via === 'avconvert') out.label = 'Usando o conversor de vídeo do macOS'
  else {
    out.aviso = out.ffmpeg
      ? 'O ffmpeg deste computador não tem codificador H.264. As prévias leves ficam desligadas.'
      : 'Não encontramos o ffmpeg neste computador. As prévias leves ficam desligadas.'
  }
  return out
}

// ─────────── olhar e converter ───────────

/** `ffmpeg -i` (sem saída: o ffmpeg sai com erro, mas o stderr tem tudo). null se nem abriu. */
export async function probe(motor, file, { signal } = {}) {
  if (!motor?.ffmpeg) return null
  const r = await runTool(motor.ffmpeg.path, ['-hide_banner', '-nostdin', '-i', file], { timeoutMs: PROBE_TIMEOUT_MS, signal })
  if (r.aborted) throw abortError(signal)
  const info = parseProbe(r.stderr)
  return info.video || info.durationS != null ? info : null
}

/** Tempo limite: 10 min + 8× a duração (um Intel antigo convertendo 4K no processador). Sem duração: 6 h. */
export function timeoutFor(durationS) {
  return durationS > 0 ? Math.round(10 * 60_000 + durationS * 8000) : 6 * 3600_000
}

class PreviaError extends Error {
  constructor(message, { retry = true } = {}) {
    super(message)
    this.name = 'PreviaError'
    this.retry = retry
  }
}

/** Uma conversão com ffmpeg. Lança PreviaError (motivo curto) ou AbortError. */
async function ffmpegOnce(motor, { input, output, info, encoder, hwDecode, signal, onProgress, timeoutMs, lado }) {
  const dur = info?.durationS || 0
  let buf = ''
  const r = await runTool(motor.ffmpeg.path, argsTranscode({ input, output, encoder, info, hwDecode, lado }), {
    signal,
    timeoutMs,
    stallMs: STALL_MS,
    onStdout: s => {
      buf += s
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim())
        if (m && dur > 0) onProgress?.(Math.min(0.999, Number(m[1]) / 1e6 / dur))
      }
    },
  })
  if (r.aborted) throw abortError(signal)
  if (r.timedOut) throw new PreviaError('tempo esgotado', { retry: false })
  if (r.stalled) throw new PreviaError('o conversor travou', { retry: false })
  if (r.error) throw new PreviaError(`não consegui rodar o ffmpeg (${r.error.code || r.error.message})`, { retry: false })
  if (r.code !== 0) throw new PreviaError(`${encoder}${hwDecode ? ' + decodificação no chip' : ''}: ${lastLine(r.stderr) || `saiu com ${r.code}`}`)
}

/** Mac sem ffmpeg: avconvert (AVFoundation). Só .mov/.mp4/.m4v. */
async function avconvertOnce(motor, { input, output, signal, onProgress, timeoutMs }) {
  let buf = ''
  const r = await runTool(motor.avconvert, ['--source', input, '--output', output, '--preset', 'Preset1280x720', '--progress'], {
    signal,
    timeoutMs,
    stallMs: STALL_MS,
    onStdout: s => {
      buf = (buf + s).slice(-256)
      const all = [...buf.matchAll(/(\d+(?:\.\d+)?)\s*%/g)]
      if (all.length) onProgress?.(Math.min(0.999, Number(all[all.length - 1][1]) / 100))
    },
  })
  if (r.aborted) throw abortError(signal)
  if (r.timedOut) throw new PreviaError('tempo esgotado', { retry: false })
  if (r.stalled) throw new PreviaError('o conversor travou', { retry: false })
  if (r.error) throw new PreviaError(`não consegui rodar o avconvert (${r.error.code || r.error.message})`, { retry: false })
  if (r.code !== 0) throw new PreviaError(`avconvert: ${lastLine(r.stderr) || lastLine(r.stdout) || `saiu com ${r.code}`}`, { retry: false })
}

/** Espaço livre no disco de `dir` (bytes) ou null. */
async function freeBytes(dir) {
  try {
    const s = await fsp.statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/**
 * Gera a cópia leve de um arquivo local numa pasta temporária. Quem chama sobe e depois chama `limpar()`.
 * Nunca deixa temporário para trás quando lança.
 * @param {string} file caminho local do original
 * @param {object} opts
 * @param {object} opts.motor resultado de detectarMotor
 * @param {string} [opts.name] nome do original (decisão pela extensão)
 * @param {number} [opts.size] tamanho do original
 * @param {boolean} [opts.forcar] gera mesmo que já seja leve (refazer)
 * @param {(fase: 'analisando'|'gerando', frac?: number) => void} [opts.onProgress]
 * @returns {Promise<{ estado: 'pronta', path, size, encoder, motivo, limpar(): Promise<void> } | { estado: 'dispensada', motivo }>}
 */
export async function gerarPrevia(file, { motor, name, size, forcar = false, signal, onProgress, tmpRoot = os.tmpdir(), log = () => {} } = {}) {
  if (signal?.aborted) throw abortError(signal)
  if (!motor?.via) return { estado: 'dispensada', motivo: motor?.aviso || 'sem conversor neste computador' }
  const st = await fsp.stat(file).catch(() => null)
  if (!st?.isFile()) return { estado: 'dispensada', motivo: 'arquivo local não encontrado' }
  const nome = name || path.basename(file)
  if (isBrawName(nome)) return gerarPreviaBraw(file, { motor, signal, onProgress, tmpRoot, log })
  onProgress?.('analisando')
  const info = motor.via === 'ffmpeg' ? await probe(motor, file, { signal }) : null
  if (motor.via === 'ffmpeg' && !info) return { estado: 'dispensada', motivo: 'o ffmpeg não abriu este arquivo' }
  const decision = precisaPrevia(info, { name: nome, size: size ?? st.size })
  if (!decision.gerar && !(forcar && info?.video)) return { estado: 'dispensada', motivo: decision.motivo }
  if (motor.via === 'avconvert' && !AVFOUNDATION_EXTS.has(splitExt(nome)[1])) return { estado: 'dispensada', motivo: decision.motivo }

  // Espaço para a cópia: ~5,3 Mbit/s × duração, com folga.
  const estimate = info?.durationS ? (info.durationS * 5.4e6) / 8 : (size ?? st.size) * 0.1
  const free = await freeBytes(tmpRoot)
  if (free != null && free < estimate * 1.5 + 200 * MB) return { estado: 'dispensada', motivo: 'pouco espaço livre no disco do sistema' }

  const dir = await fsp.mkdtemp(path.join(tmpRoot, 'sobedesce-previa-'))
  const output = path.join(dir, 'previa.mp4')
  const limpar = () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  try {
    onProgress?.('gerando', 0)
    const timeoutMs = timeoutFor(info?.durationS)
    const progress = f => onProgress?.('gerando', f)
    let used = null
    if (motor.via === 'avconvert') {
      await avconvertOnce(motor, { input: file, output, signal, onProgress: progress, timeoutMs })
      used = 'avconvert'
    } else {
      used = await transcodificar(motor, { input: file, output, info, signal, onProgress: progress, timeoutMs, log })
    }
    const out = await fsp.stat(output).catch(() => null)
    if (!out || out.size < 1024) throw new PreviaError('a cópia saiu vazia')
    // Cópia quase do tamanho do original não ajuda em nada: fica sem.
    if (!forcar && out.size >= st.size * 0.9) {
      await limpar()
      return { estado: 'dispensada', motivo: 'a cópia não ficou menor que o original' }
    }
    onProgress?.('gerando', 1)
    return { estado: 'pronta', path: output, size: out.size, encoder: used, motivo: decision.motivo, limpar }
  } catch (err) {
    await limpar()
    throw err
  }
}

export { PreviaError }

/** Proxy de .braw: ajudante do Blackmagic RAW → ffmpeg (media/braw.js). Mesmo retorno do gerarPrevia. */
async function gerarPreviaBraw(file, { motor, signal, onProgress, tmpRoot, log }) {
  if (motor.via !== 'ffmpeg') return { estado: 'dispensada', motivo: 'o proxy de BRAW precisa do ffmpeg' }
  if (!motor.braw) return { estado: 'dispensada', motivo: 'este app ainda não tem o decodificador de Blackmagic RAW' }
  if (!motor.braw.ok) return { estado: 'dispensada', motivo: `BRAW: ${motor.braw.motivo}` }
  onProgress?.('analisando')
  let info
  try {
    info = await brawInfo(motor.braw.path, file, { maxSide: PREVIA_LADO, signal })
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') throw err
    if (err?.semComo) return { estado: 'dispensada', motivo: `BRAW: ${err.message}` }
    throw new PreviaError(err?.message || String(err), { retry: false })
  }
  const estimate = (info.durationS * 5.4e6) / 8
  const free = await freeBytes(tmpRoot)
  if (free != null && free < estimate * 1.5 + 200 * MB) return { estado: 'dispensada', motivo: 'pouco espaço livre no disco do sistema' }

  const dir = await fsp.mkdtemp(path.join(tmpRoot, 'sobedesce-previa-'))
  const output = path.join(dir, 'previa.mp4')
  const limpar = () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  try {
    onProgress?.('gerando', 0)
    const progress = f => onProgress?.('gerando', f)
    // Decodificar BRAW na CPU é mais lento que um vídeo comum: o dobro do tempo limite.
    const timeoutMs = timeoutFor(info.durationS) * 2
    let used = null
    let last = null
    for (const t of plano(motor).filter(p => !p.hwDecode)) {
      try {
        await fsp.rm(output, { force: true })
        await brawOnce(motor, { input: file, output, info, encoder: t.encoder, signal, onProgress: progress, timeoutMs })
        used = t.encoder
        break
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') throw err
        last = err
        log(`conversão (BRAW): ${err.message}`)
        if (err.retry === false) break
      }
    }
    if (!used) throw last || new PreviaError('nenhum codificador funcionou')
    const out = await fsp.stat(output).catch(() => null)
    if (!out || out.size < 1024) throw new PreviaError('a cópia saiu vazia')
    onProgress?.('gerando', 1)
    return { estado: 'pronta', path: output, size: out.size, encoder: used, motivo: 'Blackmagic RAW', limpar }
  } catch (err) {
    await limpar()
    throw err
  }
}

/** Uma conversão de BRAW com um codificador. Lança PreviaError (motivo curto) ou AbortError. */
async function brawOnce(motor, { input, output, info, encoder, signal, onProgress, timeoutMs }) {
  const vf = videoFilter(null, encoder).replace('force_divisible_by=2', 'force_divisible_by=2:out_color_matrix=bt709:out_range=tv')
  let buf = ''
  const r = await runPipe({
    helper: motor.braw.path,
    helperArgs: ['--frames', '--input', input, '--max-side', String(PREVIA_LADO)],
    ffmpeg: motor.ffmpeg.path,
    ffmpegArgs: argsBrawTranscode({ input, output, info, vf, encoderArgs: encoderArgs(encoder) }),
    signal,
    timeoutMs,
    stallMs: STALL_MS,
    onStdout: s => {
      buf += s
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim())
        if (m) onProgress?.(Math.min(0.999, Number(m[1]) / 1e6 / info.durationS))
      }
    },
  })
  if (r.aborted) throw abortError(signal)
  if (r.timedOut) throw new PreviaError('tempo esgotado', { retry: false })
  if (r.stalled) throw new PreviaError('o conversor travou', { retry: false })
  if (r.error) throw new PreviaError(`não consegui rodar o conversor de BRAW (${r.error.code || r.error.message})`, { retry: false })
  // O ajudante falhou: trocar de codificador não ajuda.
  if (r.helperCode !== 0) throw new PreviaError(`ajudante do Blackmagic RAW: ${lastLine(r.helperStderr) || `saiu com ${r.helperCode}`}`, { retry: false })
  if (r.code !== 0) throw new PreviaError(`${encoder}: ${lastLine(r.stderr) || `saiu com ${r.code}`}`)
}

/**
 * Converte para H.264 + AAC em MP4 com o ffmpeg, tentando os codificadores do plano (hardware primeiro, libx264 por
 * último). `lado`: lado maior da saída (padrão: 1280, a prévia leve). Devolve o codificador usado; lança PreviaError.
 */
export async function transcodificar(motor, { input, output, info = null, signal, onProgress, timeoutMs = timeoutFor(info?.durationS), lado = PREVIA_LADO, log = () => {} }) {
  let last = null
  for (const t of plano(motor)) {
    try {
      await fsp.rm(output, { force: true })
      await ffmpegOnce(motor, { input, output, info, ...t, signal, onProgress, timeoutMs, lado })
      return t.encoder
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err
      last = err
      log(`conversão: ${err.message}`)
      if (err.retry === false) break
    }
  }
  throw last || new PreviaError('nenhum codificador funcionou')
}

/** Codecs que o iPhone (Safari) não toca dentro de um MP4: o VP9 e o AV1 que o Instagram manda, e o VP8. */
export const CODECS_SEM_IPHONE = Object.freeze(['vp8', 'vp9', 'av1'])
export const tocaNoIphone = info => !info?.video || !CODECS_SEM_IPHONE.includes(info.video.codec)

/** Texto curto para logs e para a interface. */
export function motorResumo(m) {
  if (!m) return 'verificando…'
  if (!m.via) return m.aviso || 'sem conversor'
  if (m.via === 'avconvert') return 'avconvert do macOS'
  const braw = m.braw?.ok ? ' · BRAW' : ''
  return `ffmpeg ${m.ffmpeg?.versao || ''} · ${m.encoder?.nome}${m.ffmpeg?.origem === 'sistema' ? ' (do sistema)' : ''}${braw}`.trim()
}
