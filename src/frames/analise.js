// Frames (docs/FRAMES.md): a leitura do vídeo final para escolher os melhores quadros e takes.
//
// Um passe só pelo vídeo, pequeno (256 px de largura, ~4 amostras por segundo, RGB pelo cano do ffmpeg), e para cada
// amostra: nitidez (variância do Laplaciano), exposição (média e quanto estourou ou fechou), contraste, cor (calor e
// saturação), uma impressão digital (dHash, para não escolher dois quadros iguais) e a diferença para a anterior
// (movimento e corte de cena). O resto (escolher, extrair em alta) trabalha em cima disso.
import { spawn } from 'node:child_process'
import { parseProbe, runTool } from '../media/previa.js'

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

function luma(r, g, b) {
  return (r * 77 + g * 150 + b * 29) >> 8
}

/** Métricas de uma amostra (RGB `w`×`h`). */
export function medir(rgb, w, h) {
  const n = w * h
  const y = new Uint8Array(n)
  let soma = 0
  let soma2 = 0
  let escuros = 0
  let estourados = 0
  let quente = 0
  let sat = 0
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const r = rgb[p]
    const g = rgb[p + 1]
    const b = rgb[p + 2]
    const l = luma(r, g, b)
    y[i] = l
    soma += l
    soma2 += l * l
    if (l < 12) escuros++
    else if (l > 245) estourados++
    quente += r - b
    const mx = Math.max(r, g, b)
    sat += mx ? (mx - Math.min(r, g, b)) / mx : 0
  }
  const media = soma / n
  const desvio = Math.sqrt(Math.max(0, soma2 / n - media * media))
  // Nitidez: variância do Laplaciano (4 vizinhos) no miolo.
  let ls = 0
  let ls2 = 0
  let k = 0
  for (let yy = 1; yy < h - 1; yy++) {
    for (let x = 1; x < w - 1; x++) {
      const i = yy * w + x
      const lap = 4 * y[i] - y[i - 1] - y[i + 1] - y[i - w] - y[i + w]
      ls += lap
      ls2 += lap * lap
      k++
    }
  }
  const nitidez = ls2 / k - (ls / k) ** 2
  // dHash 64 bits (9×8 de médias), em dois inteiros de 32.
  const hash = [0, 0]
  const cw = w / 9
  const ch = h / 8
  const cel = (cx, cy) => {
    let s = 0
    let c = 0
    for (let yy = Math.floor(cy * ch); yy < Math.floor((cy + 1) * ch); yy++)
      for (let x = Math.floor(cx * cw); x < Math.floor((cx + 1) * cw); x++) {
        s += y[yy * w + x]
        c++
      }
    return c ? s / c : 0
  }
  let bit = 0
  for (let cy = 0; cy < 8; cy++) {
    let ant = cel(0, cy)
    for (let cx = 1; cx < 9; cx++) {
      const v = cel(cx, cy)
      if (v > ant) hash[bit >> 5] |= 1 << (bit & 31)
      ant = v
      bit++
    }
  }
  return {
    y,
    media,
    desvio,
    nitidez,
    escuros: escuros / n,
    estourados: estourados / n,
    calor: quente / n, // > 0 quente, < 0 frio
    saturacao: sat / n,
    hash,
  }
}

export function distanciaHash(a, b) {
  let d = 0
  for (let i = 0; i < 2; i++) {
    let x = (a[i] ^ b[i]) >>> 0
    while (x) {
      x &= x - 1
      d++
    }
  }
  return d
}

function diferenca(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return s / a.length
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

/**
 * Cenas: corte onde a imagem muda de uma vez (diferença bem acima do normal do vídeo). Cena curta demais (< 0,6 s)
 * junta com a vizinha. Devolve [{ i, ini, fim, de, ate }] (de/ate = índices das amostras).
 */
export function cenas(amostras, passo) {
  if (!amostras.length) return []
  const difs = amostras.map((a) => a.dif).slice(1)
  const ord = difs.slice().sort((a, b) => a - b)
  const mediana = ord[Math.floor(ord.length / 2)] || 0
  const p90 = ord[Math.floor(ord.length * 0.9)] || 0
  const limiar = Math.max(18, mediana * 4, p90 * 1.6)
  const cortes = [0]
  for (let k = 1; k < amostras.length; k++) {
    const a = amostras[k]
    // Corte: salto grande e isolado (o vizinho seguinte não continua mudando tanto = não é só movimento).
    // Ou a luz/cor mudou de uma vez (corte para uma cena de muito movimento, onde o vizinho também muda muito).
    const prox = amostras[k + 1]?.dif ?? 0
    const ant = amostras[k - 1]
    const depois = amostras[k + 1] ?? a
    const mudouCor = Math.abs(a.media - ant.media) > 14 && Math.abs(depois.media - ant.media) > 14 || Math.abs(a.saturacao - ant.saturacao) > 0.14 && Math.abs(depois.saturacao - ant.saturacao) > 0.14 || Math.abs(a.calor - ant.calor) > 18 && Math.abs(depois.calor - ant.calor) > 18
    if ((a.dif > limiar && a.dif > prox * 1.5) || (mudouCor && a.dif > Math.max(18, limiar * 0.5))) cortes.push(k)
  }
  const min = Math.ceil(0.6 / passo)
  const limpos = [0]
  for (const c of cortes.slice(1)) {
    if (c - limpos[limpos.length - 1] >= min) limpos.push(c)
  }
  const out = []
  for (let i = 0; i < limpos.length; i++) {
    const de = limpos[i]
    const ate = (limpos[i + 1] ?? amostras.length) - 1
    if (ate - de + 1 < min && out.length) {
      out[out.length - 1].ate = ate
      out[out.length - 1].fim = (ate + 1) * passo
      continue
    }
    out.push({ i: out.length, de, ate, ini: de * passo, fim: (ate + 1) * passo })
  }
  return out.map((c, i) => ({ ...c, i }))
}
