// Proxy de Blackmagic RAW: o ffmpeg não decodifica BRAW, então a imagem vem do ajudante nativo `sobedesce-raw-frame`
// (Blackmagic RAW SDK já instalado na máquina) e o ffmpeg do app só codifica. O áudio do .braw é PCM comum dentro de
// um QuickTime: o ffmpeg lê direto do arquivo, sem o ajudante.
//
//   sobedesce-raw-frame --frames --input A001.braw --max-side 1280  ──RGBA 8 bits──▶  ffmpeg -f rawvideo -i pipe:0
//                                                                                          -i A001.braw (só o áudio)
//                                                                                          → H.264 720p + AAC (Rec.709)
//
// Contrato do ajudante (o mesmo executável da miniatura, src/native/raw-frame/README.md):
//   --check                                   → 0 = a biblioteca do Blackmagic RAW abriu; 2 = não está instalada
//   --info --input <braw> --max-side <px>     → 0 + JSON numa linha: { width, height, frameRate, frames, outWidth,
//                                               outHeight } (out* = o tamanho que --frames vai mandar)
//   --frames --input <braw> --max-side <px>   → 0 + todos os frames em RGBA 8 bits no stdout, Rec.709, sem cabeçalho
//   código 2 = "este arquivo não tem como" (biblioteca ausente, clipe que ela não abre); outro = falha.
// O ajudante decodifica na menor escala do SDK (1/2, 1/4, 1/8) que ainda dá pelo menos `max-side` no lado maior; o
// ffmpeg reduz o resto.
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { abortError } from '../util/backoff.js'
import { helperCandidates } from './raw-thumb.js'

const KiB = 1024
const TAIL = 8 * KiB
const CHECK_TIMEOUT_MS = 20_000
// Abrir um .braw grande num disco externo leva tempo (o mesmo motivo dos 90 s da miniatura).
const INFO_TIMEOUT_MS = 90_000

/** Extensões que o ajudante converte (R3D e afins ficam de fora: não há SDK aberto aqui). */
export const BRAW_EXTS = Object.freeze(['.braw'])
export const isBrawName = name => BRAW_EXTS.includes(path.extname(String(name ?? '')).toLowerCase())

/** Taxas de quadros NTSC (23,976…) viram frações exatas; o resto, inteiro ou com 3 casas. */
export function fracaoFps(fps) {
  const f = Number(fps)
  if (!(f > 0 && f < 1000)) return null
  for (const base of [24, 30, 48, 60, 120]) {
    const ntsc = (base * 1000) / 1001
    if (Math.abs(f - ntsc) < 0.005) return `${base * 1000}/1001`
  }
  if (Math.abs(f - Math.round(f)) < 0.005) return `${Math.round(f)}/1`
  return `${Math.round(f * 1000)}/1000`
}

/** Valida a linha JSON do --info. null se faltar algo (ajudante de outra versão, saída cortada). */
export function parseInfo(text) {
  let j
  try {
    j = JSON.parse(String(text ?? '').trim().split(/\r?\n/).pop())
  } catch {
    return null
  }
  const int = v => (Number.isInteger(v) && v > 0 ? v : null)
  const out = {
    width: int(j?.width),
    height: int(j?.height),
    frames: int(j?.frames),
    outWidth: int(j?.outWidth),
    outHeight: int(j?.outHeight),
    fps: fracaoFps(j?.frameRate),
    frameRate: Number(j?.frameRate) || null,
  }
  if (!out.outWidth || !out.outHeight || !out.frames || !out.fps) return null
  // Limite de sanidade: 16K e 10 milhões de frames.
  if (out.outWidth > 16384 || out.outHeight > 16384 || out.frames > 1e7) return null
  out.durationS = out.frames / out.frameRate
  return out
}

/** Roda o ajudante e junta a saída (só para --check e --info). Nunca rejeita. */
function runSmall(cmd, args, { timeoutMs, signal }) {
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let child
    let done = false
    const finish = r => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ stdout, stderr, ...r })
    }
    const kill = () => {
      try {
        child?.kill('SIGKILL')
      } catch {}
    }
    const onAbort = () => {
      kill()
      finish({ code: null, aborted: true })
    }
    const timer = setTimeout(() => {
      kill()
      finish({ code: null, timedOut: true })
    }, timeoutMs)
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      return finish({ code: null, error })
    }
    child.stdout.on('data', d => {
      if (stdout.length < 64 * KiB) stdout += d.toString('utf8')
    })
    child.stderr.on('data', d => {
      stderr = (stderr + d.toString('utf8')).slice(-TAIL)
    })
    child.on('error', error => finish({ code: null, error }))
    child.on('close', code => finish({ code }))
  })
}

// A biblioteca do sistema às vezes escreve antes (ex.: o carregador listando onde procurou): a última linha é a nossa.
const lastLine = s => String(s || '').trim().split(/\r?\n/).pop().slice(0, 200)

/**
 * O ajudante deste computador e se a biblioteca do Blackmagic RAW abre.
 * @returns {Promise<null|{ path: string, ok: boolean, motivo: string|null }>} null = sem ajudante no app
 */
export async function detectarBraw({ env = process.env, platform = process.platform, resourcesPath = process.resourcesPath, signal } = {}) {
  for (const p of helperCandidates({ env, platform, resourcesPath })) {
    const st = await fsp.stat(p).catch(() => null)
    if (!st?.isFile()) continue
    const r = await runSmall(p, ['--check'], { timeoutMs: CHECK_TIMEOUT_MS, signal })
    if (r.aborted) throw abortError(signal)
    if (r.code === 0) return { path: p, ok: true, motivo: null }
    if (r.code === 2) return { path: p, ok: false, motivo: 'instale o Blackmagic RAW neste computador' }
    return { path: p, ok: false, motivo: `o ajudante do Blackmagic RAW falhou (${r.timedOut ? 'tempo esgotado' : lastLine(r.stderr) || r.error?.code || `saiu com ${r.code}`})` }
  }
  return null
}

/** Tamanho, taxa e duração do clipe (e o tamanho dos frames que --frames vai mandar). Lança com motivo curto. */
export async function brawInfo(helper, file, { maxSide, signal } = {}) {
  const r = await runSmall(helper, ['--info', '--input', file, '--max-side', String(maxSide)], { timeoutMs: INFO_TIMEOUT_MS, signal })
  if (r.aborted) throw abortError(signal)
  if (r.timedOut) throw new Error('o Blackmagic RAW demorou demais para abrir o arquivo')
  if (r.code === 2) throw Object.assign(new Error(lastLine(r.stderr) || 'o Blackmagic RAW não abriu este arquivo'), { semComo: true })
  if (r.code !== 0) throw new Error(`ajudante do Blackmagic RAW: ${lastLine(r.stderr) || r.error?.code || `saiu com ${r.code}`}`)
  const info = parseInfo(r.stdout)
  if (!info) throw new Error('o ajudante do Blackmagic RAW respondeu algo que não entendi')
  return info
}

/**
 * Argumentos do ffmpeg: vídeo cru do ajudante pelo stdin, áudio do próprio .braw. `video` = o mesmo filtro e
 * codificador da prévia leve (previa.js), com a conversão RGB → YUV em BT.709 e as etiquetas de cor no arquivo.
 */
export function argsBrawTranscode({ input, output, info, vf, encoderArgs }) {
  return [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${info.outWidth}x${info.outHeight}`, '-framerate', info.fps, '-i', 'pipe:0',
    '-i', input,
    '-map', '0:v:0', '-map', '1:a:0?', '-dn', '-sn', '-map_chapters', '-1',
    '-vf', vf,
    ...encoderArgs, '-g', '60',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    // O áudio às vezes passa alguns ms do último frame: corta no vídeo.
    '-shortest',
    '-movflags', '+faststart', '-f', 'mp4', output,
  ]
}

/**
 * Ajudante → ffmpeg por um cano. Mata os dois no cancelamento, no tempo limite e quando nada sai por `stallMs`.
 * Nunca rejeita: { code, helperCode, timedOut, stalled, aborted, error, stderr, helperStderr }.
 */
export function runPipe({ helper, helperArgs, ffmpeg, ffmpegArgs, signal, timeoutMs, stallMs = 0, onStdout, lowPriority = true }) {
  return new Promise(resolve => {
    let h
    let f
    let stderr = ''
    let helperStderr = ''
    let helperCode
    let ffmpegCode
    let done = false
    let timedOut = false
    let stalled = false
    let aborted = false
    let error = null
    let stallTimer = null
    const killAll = () => {
      for (const c of [h, f]) {
        try {
          c?.kill('SIGKILL')
        } catch {}
      }
    }
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(stallTimer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code: ffmpegCode ?? null, helperCode: helperCode ?? null, timedOut, stalled, aborted, error, stderr, helperStderr })
    }
    // Termina quando os dois saíram (ou quando um problema já matou os dois).
    const maybeFinish = () => {
      if (helperCode !== undefined && ffmpegCode !== undefined) finish()
    }
    const stop = flag => {
      if (flag === 'aborted') aborted = true
      else if (flag === 'timedOut') timedOut = true
      else if (flag === 'stalled') stalled = true
      killAll()
      // Se algum nem chegou a abrir, não vai haver 'close' dele.
      if (!h?.pid) helperCode ??= null
      if (!f?.pid) ffmpegCode ??= null
      maybeFinish()
    }
    const onAbort = () => stop('aborted')
    const timer = setTimeout(() => stop('timedOut'), Math.max(1, timeoutMs))
    const poke = () => {
      if (!stallMs) return
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => stop('stalled'), stallMs)
    }
    if (signal?.aborted) {
      aborted = true
      helperCode = null
      ffmpegCode = null
      return finish()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      f = spawn(ffmpeg, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      h = spawn(helper, helperArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      error = err
      return stop('error')
    }
    if (lowPriority) {
      for (const c of [h, f]) {
        try {
          if (c.pid) os.setPriority(c.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
        } catch {}
      }
    }
    poke()
    // ffmpeg saiu antes (erro): o ajudante recebe EPIPE e sai também; o erro do cano não derruba o app.
    f.stdin.on('error', () => {})
    h.stdout.on('error', () => {})
    h.stdout.on('data', poke)
    h.stdout.pipe(f.stdin)
    f.stdout.on('data', d => {
      poke()
      try {
        onStdout?.(d.toString('utf8'))
      } catch {}
    })
    f.stderr.on('data', d => {
      stderr = (stderr + d.toString('utf8')).slice(-TAIL)
    })
    h.stderr.on('data', d => {
      helperStderr = (helperStderr + d.toString('utf8')).slice(-TAIL)
    })
    h.on('error', err => {
      error ??= err
      helperCode ??= null
      // Sem ajudante não há frames: o ffmpeg ficaria esperando o stdin para sempre.
      try {
        f.stdin.end()
      } catch {}
      maybeFinish()
    })
    f.on('error', err => {
      error ??= err
      ffmpegCode ??= null
      try {
        h.kill('SIGKILL')
      } catch {}
      maybeFinish()
    })
    h.on('close', code => {
      helperCode = code
      // Ajudante falhou no meio: o ffmpeg não pode fechar um arquivo "pronto" com metade do vídeo.
      if (code !== 0) {
        try {
          f.kill('SIGKILL')
        } catch {}
      }
      maybeFinish()
    })
    f.on('close', code => {
      ffmpegCode = code
      if (code !== 0) {
        try {
          h.kill('SIGKILL')
        } catch {}
      }
      maybeFinish()
    })
  })
}
