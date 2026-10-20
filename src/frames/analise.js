// Frames (docs/FRAMES.md): a leitura do vídeo final para escolher os melhores quadros e takes.
//
// Um passe só pelo vídeo, pequeno (256 px de largura, ~4 amostras por segundo, RGB pelo cano do ffmpeg), e para cada
// amostra: nitidez (variância do Laplaciano), exposição (média e quanto estourou ou fechou), contraste, cor (calor e
// saturação), uma impressão digital (dHash, para não escolher dois quadros iguais) e a diferença para a anterior
// (movimento e corte de cena). O resto (escolher, extrair em alta) trabalha em cima disso.
import { spawn } from 'node:child_process'
import { parseProbe, runTool } from '../media/previa.js'
import { cenas, diferenca, distanciaHash, medir } from './medidas.js'

export { cenas, distanciaHash, medir }

export const LARGURA = 256
const MAX_AMOSTRAS = 4000

/** Dados do vídeo: duração, tamanho, quadros por segundo, rotação, se tem áudio. */
export async function sondar(ffmpeg, arquivo, { signal } = {}) {
  const r = await runTool(ffmpeg, ['-hide_banner', '-nostdin', '-i', arquivo], { timeoutMs: 60_000, signal })
  const texto = r.stderr || ''
  const info = parseProbe(texto)
  if (!info.video || !info.durationS) throw Object.assign(new Error('Não consegui ler este vídeo (o ffmpeg não reconheceu o formato).'), { status: 400 })
  const fps = /,\s*([\d.]+)\s*fps/.exec(texto.split(/\r?\n/).find((l) => /Stream #.*Video:/.test(l)) || '')
  info.fps = fps ? Number(fps[1]) : 25
  return info
}

/**
 * Lê o vídeo inteiro em amostras pequenas.
 * @returns {Promise<{ info, w, h, passo: number, amostras: object[] }>} amostras: { t, media, desvio, nitidez, escuros,
 *   estourados, calor, saturacao, hash, dif } (dif = diferença média para a amostra anterior, 0–255)
 */
export async function amostrar(ffmpeg, arquivo, { info, signal, onProgress } = {}) {
  info ??= await sondar(ffmpeg, arquivo, { signal })
  const dur = info.durationS
  const fps = Math.max(0.5, Math.min(4, MAX_AMOSTRAS / dur))
  const vw = info.video.width || 1920
  const vh = info.video.height || 1080
  const rot = Math.abs(info.rotation || 0) % 180 === 90
  const [ow, oh] = rot ? [vh, vw] : [vw, vh]
  const sar = info.video.sar ? info.video.sar[0] / info.video.sar[1] : 1
  const w = LARGURA
  const h = Math.max(8, Math.round((w * oh) / (ow * sar) / 2) * 2)
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', arquivo, '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', `fps=${fps.toFixed(4)},scale=${w}:${h}:flags=area,format=rgb24`, '-f', 'rawvideo', '-']
  const amostras = []
  const tam = w * h * 3
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let resto = Buffer.alloc(0)
    let anterior = null
    let erro = ''
    const parar = () => p.kill('SIGKILL')
    signal?.addEventListener('abort', parar, { once: true })
    p.stderr.on('data', (d) => (erro = (erro + d).slice(-2000)))
    p.stdout.on('data', (d) => {
      resto = resto.length ? Buffer.concat([resto, d]) : d
      while (resto.length >= tam) {
        const quadro = resto.subarray(0, tam)
        resto = resto.subarray(tam)
        const m = medir(quadro, w, h)
        const t = amostras.length / fps
        m.dif = anterior ? diferenca(m.y, anterior) : 0
        anterior = m.y
        amostras.push({ t, ...m, y: undefined })
        if (amostras.length % 20 === 0) onProgress?.(Math.min(1, t / dur))
      }
    })
    p.on('error', reject)
    p.on('close', (code) => {
      signal?.removeEventListener('abort', parar)
      if (signal?.aborted) return reject(Object.assign(new Error('parado'), { name: 'AbortError' }))
      if (code !== 0 && !amostras.length) return reject(new Error(`o ffmpeg não conseguiu ler o vídeo: ${erro.trim().split('\n').pop() || code}`))
      resolve()
    })
  })
  for (const a of amostras) delete a.y
  onProgress?.(1)
  return { info, w, h, passo: 1 / fps, amostras }
}
