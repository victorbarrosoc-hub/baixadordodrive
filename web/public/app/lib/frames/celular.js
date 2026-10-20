// Frames no celular (docs/FRAMES.md §Celular): o mesmo bom senso do computador (medidas.js e escolha.js são cópias
// idênticas das de src/frames/), mas sem ffmpeg. O vídeo toca num <video> escondido, que vem da galeria ou direto do
// Drive (/app/stream/<id>, pelo service worker: mesma origem, então o canvas pode ler os pixels). Cada amostra é um
// pulo no vídeo desenhado pequeno (256 px). Os frames escolhidos saem do vídeo no tamanho dele, em JPEG ou PNG.
import { cenas, diferenca, medir } from './medidas.js'
import { escolherFrames, etiquetas } from './escolha.js'

export const LARGURA = 256
const MAX_AMOSTRAS = 240
const MIN_AMOSTRAS = 24
const PULO_MS = 12_000

const abortado = () => Object.assign(new Error('parado'), { name: 'AbortError' })

/** Abre o vídeo (src = blob: da galeria ou /app/stream/… do Drive). Resolve com o elemento já com a duração. */
export function abrirVideo(src, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.setAttribute('playsinline', '')
    const fim = (fn, x) => {
      v.removeEventListener('loadeddata', ok)
      v.removeEventListener('error', erro)
      signal?.removeEventListener('abort', parar)
      fn(x)
    }
    const ok = () => (Number.isFinite(v.duration) && v.duration > 0 && v.videoWidth ? fim(resolve, v) : fim(reject, new Error('Não consegui ler este vídeo no celular.')))
    const erro = () => fim(reject, new Error('O celular não abre este formato de vídeo. Peça ao computador.'))
    const parar = () => {
      v.removeAttribute('src')
      v.load()
      fim(reject, abortado())
    }
    v.addEventListener('loadeddata', ok)
    v.addEventListener('error', erro)
    signal?.addEventListener('abort', parar, { once: true })
    v.src = src
  })
}

/** Pula para `t` e espera o quadro estar pronto para desenhar. */
export function pular(v, t, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortado())
    const alvo = Math.max(0, Math.min(v.duration - 0.05, t))
    let timer = 0
    const pronto = () => {
      clearTimeout(timer)
      v.removeEventListener('seeked', depois)
      signal?.removeEventListener('abort', parar)
      resolve()
    }
    // Depois do "seeked", espera o quadro chegar à tela (no Safari, desenhar antes pode pegar o anterior).
    const depois = () => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(() => pronto()) && setTimeout(pronto, 250) : requestAnimationFrame(() => pronto()))
    const parar = () => {
      clearTimeout(timer)
      v.removeEventListener('seeked', depois)
      reject(abortado())
    }
    timer = setTimeout(() => {
      v.removeEventListener('seeked', depois)
      signal?.removeEventListener('abort', parar)
      reject(new Error('O vídeo demorou demais para responder. A internet está lenta?'))
    }, PULO_MS)
    v.addEventListener('seeked', depois, { once: true })
    signal?.addEventListener('abort', parar, { once: true })
    if (Math.abs(v.currentTime - alvo) < 0.001) v.currentTime = alvo + 0.001
    else v.currentTime = alvo
  })
}

/**
 * Lê o vídeo em amostras pequenas: entre 24 e 240 pulos, espalhados. Devolve o mesmo formato de src/frames/analise.js
 * ({ passo, amostras }) para a escolha ser igual à do computador.
 */
export async function amostrar(v, { signal, onProgress } = {}) {
  const dur = v.duration
  const n = Math.round(Math.max(MIN_AMOSTRAS, Math.min(MAX_AMOSTRAS, dur * 2)))
  const passo = dur / n
  const w = LARGURA
  const h = Math.max(8, Math.round((w * v.videoHeight) / v.videoWidth / 2) * 2)
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  const rgb = new Uint8Array(w * h * 3)
  const amostras = []
  let anterior = null
  for (let k = 0; k < n; k++) {
    // Mede no meio do trecho; a escolha soma passo/2 ao t, como no computador.
    await pular(v, (k + 0.5) * passo, signal)
    ctx.drawImage(v, 0, 0, w, h)
    const px = ctx.getImageData(0, 0, w, h).data
    for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
      rgb[j] = px[i]
      rgb[j + 1] = px[i + 1]
      rgb[j + 2] = px[i + 2]
    }
    const m = medir(rgb, w, h)
    m.dif = anterior ? diferenca(m.y, anterior) : 0
    anterior = m.y
    const { y, ...resto } = m
    amostras.push({ t: k * passo, ...resto })
    onProgress?.((k + 1) / n)
  }
  return { passo, amostras, w, h }
}

/** Escolhe com as regras do computador. Devolve as cenas (com etiquetas) e os frames. */
export function escolher({ passo, amostras }, quantidade) {
  const cs = cenas(amostras, passo)
  const r = escolherFrames({ amostras, cenas: cs, passo }, quantidade)
  return {
    cenas: cs.map((c) => ({ n: c.i + 1, ini: c.ini, fim: c.fim, tags: etiquetas(amostras, c), nome: null })),
    frames: r.frames.map((f) => ({ t: f.t, cena: f.cena + 1, nota: f.nota })),
    descartes: r.descartes,
  }
}

/** Um frame no tamanho do vídeo. `tipo`: 'image/jpeg' (qualidade 0,95) ou 'image/png'. Também uma miniatura. */
export async function tirar(v, t, { tipo = 'image/jpeg', signal } = {}) {
  await pular(v, t, signal)
  const cv = document.createElement('canvas')
  cv.width = v.videoWidth
  cv.height = v.videoHeight
  const ctx = cv.getContext('2d')
  ctx.drawImage(v, 0, 0)
  const blob = await new Promise((ok) => cv.toBlob(ok, tipo, 0.95))
  if (!blob) throw new Error('O celular não conseguiu gravar a imagem (memória cheia?).')
  const mw = 480
  const mini = document.createElement('canvas')
  mini.width = mw
  mini.height = Math.round((mw * cv.height) / cv.width)
  mini.getContext('2d').drawImage(cv, 0, 0, mini.width, mini.height)
  const miniBlob = await new Promise((ok) => mini.toBlob(ok, 'image/jpeg', 0.8))
  cv.width = cv.height = 0 // devolve a memória já (o Safari segura canvas grandes)
  return { blob, mini: miniBlob, largura: v.videoWidth, altura: v.videoHeight }
}

// ── nomes (iguais aos do computador: src/frames/servico.js e extracao.js)

const dd = (n, w = 2) => String(n).padStart(w, '0')

export function baseDoNome(nome) {
  const stem = String(nome || 'video').replace(/\.[^.]{1,6}$/, '')
  const b = stem
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48)
  return b || 'video'
}

export function timecode(t, fps = 30) {
  const q = Math.round(t * fps)
  const f = Math.round(fps)
  const fr = q % f
  let s = Math.floor(q / f)
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  return `${dd(h)}-${dd(m)}-${dd(s)}-${dd(fr)}`
}

export function pastaDaCena(n, rotulo) {
  const r = String(rotulo || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return r ? `Cena ${dd(n)} — ${r}` : `Cena ${dd(n)}`
}

export function nomeDoFrame(base, f, ext) {
  return `${base}_C${dd(f.cena)}_${f.id}_${f.tc}.${ext}`
}
