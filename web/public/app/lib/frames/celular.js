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

/** Erro ao abrir: `formato` (o aparelho não decodifica), `rede` (não chegou) ou `outro`. */
export class ErroVideo extends Error {
  constructor(tipo, message) {
    super(message)
    this.name = 'ErroVideo'
    this.tipo = tipo
  }
}

/**
 * Abre o vídeo (src = blob: da galeria ou /app/stream/… do Drive). Resolve com o elemento já com a duração e o
 * primeiro quadro. O elemento fica na página (escondido): o Safari do iPhone carrega e decodifica melhor assim, e um
 * play()/pause() mudo destrava o primeiro quadro onde ele não vem sozinho.
 */
export function abrirVideo(src, { signal, prazoMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.setAttribute('playsinline', '')
    v.setAttribute('muted', '')
    v.setAttribute('aria-hidden', 'true')
    // Opacidade quase zero, não zero: um vídeo que não é desenhado nunca avisa que o quadro novo chegou (o
    // requestVideoFrameCallback não dispara) e cada pulo esperaria o prazo inteiro.
    v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1'
    document.body.appendChild(v)
    let feito = false
    const fim = (fn, x) => {
      if (feito) return
      feito = true
      clearTimeout(prazo)
      v.removeEventListener('loadedmetadata', meta)
      v.removeEventListener('loadeddata', ok)
      v.removeEventListener('error', erro)
      signal?.removeEventListener('abort', parar)
      if (fn === reject) fechar(v)
      fn(x)
    }
    const meta = () => {
      // Sem o primeiro quadro em alguns iPhones até tocar: toca mudo um instante e pausa.
      if (v.readyState < 2) v.play().then(() => v.pause(), () => {})
    }
    const ok = () =>
      Number.isFinite(v.duration) && v.duration > 0 && v.videoWidth
        ? fim(resolve, v)
        : fim(reject, new ErroVideo('formato', 'Não consegui ler este vídeo no celular.'))
    const erro = () => {
      const c = v.error?.code
      if (c === 2) return fim(reject, new ErroVideo('rede', 'O vídeo não chegou: a internet caiu no meio. Tente de novo.'))
      fim(reject, new ErroVideo(c === 3 || c === 4 ? 'formato' : 'outro', 'O celular não abre este formato de vídeo.'))
    }
    const parar = () => fim(reject, abortado())
    const prazo = setTimeout(() => fim(reject, new ErroVideo('rede', 'O vídeo demorou demais para abrir. A internet está lenta?')), prazoMs)
    v.addEventListener('loadedmetadata', meta)
    v.addEventListener('loadeddata', ok)
    v.addEventListener('error', erro)
    signal?.addEventListener('abort', parar, { once: true })
    v.src = src
    v.load()
  })
}

/** Solta o vídeo (para de baixar e sai da página). */
export function fechar(v) {
  try {
    v.pause()
    v.removeAttribute('src')
    v.load()
  } catch {
    // já fechado
  }
  v.remove()
}

/**
 * Pula para `t` e espera o quadro estar pronto para desenhar. O aviso de quadro novo (requestVideoFrameCallback) é
 * pedido antes do pulo: no Safari, desenhar logo no "seeked" pode pegar o quadro anterior. Se o aparelho não avisa
 * (duas vezes seguidas sem aviso), passa a esperar só dois quadros da tela.
 */
export function pular(v, t, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortado())
    const alvo = Math.max(0, Math.min(v.duration - 0.05, t))
    const avisa = Boolean(v.requestVideoFrameCallback) && (v._semAviso || 0) < 2
    let timer = 0
    let espera = 0
    let pedido = 0
    let veio = false
    let pulou = false
    let feito = false
    const limpar = () => {
      feito = true
      clearTimeout(timer)
      clearTimeout(espera)
      if (pedido) v.cancelVideoFrameCallback?.(pedido)
      v.removeEventListener('seeked', depois)
      signal?.removeEventListener('abort', parar)
    }
    const pronto = () => {
      if (feito) return
      limpar()
      resolve()
    }
    const depois = () => {
      pulou = true
      if (!avisa) return requestAnimationFrame(() => requestAnimationFrame(pronto))
      if (veio) return pronto()
      espera = setTimeout(() => {
        v._semAviso = (v._semAviso || 0) + 1
        pronto()
      }, 250)
    }
    const parar = () => {
      if (feito) return
      limpar()
      reject(abortado())
    }
    if (avisa)
      pedido = v.requestVideoFrameCallback(() => {
        pedido = 0
        veio = true
        v._semAviso = 0
        if (pulou) pronto()
      })
    timer = setTimeout(() => {
      if (feito) return
      limpar()
      reject(new Error('O vídeo demorou demais para responder. A internet está lenta?'))
    }, PULO_MS)
    v.addEventListener('seeked', depois, { once: true })
    signal?.addEventListener('abort', parar, { once: true })
    if (Math.abs(v.currentTime - alvo) < 0.001) v.currentTime = alvo + 0.001
    else v.currentTime = alvo
  })
}

/**
 * Lê o vídeo em amostras pequenas, espalhadas (`porSegundo`, entre 24 e `max` pulos). Devolve o mesmo formato de
 * src/frames/analise.js ({ passo, amostras }) para a escolha ser igual à do computador.
 *
 * `videos`: um <video> ou vários abertos no mesmo endereço. Com vários, cada um lê um trecho seguido do filme ao mesmo
 * tempo: pelo Drive, cada pulo espera a internet, e três esperas juntas custam quase o mesmo que uma.
 */
export async function amostrar(videos, { signal, onProgress, porSegundo = 2, max = MAX_AMOSTRAS } = {}) {
  const vs = Array.isArray(videos) ? videos : [videos]
  const v0 = vs[0]
  const dur = v0.duration
  const n = Math.round(Math.max(MIN_AMOSTRAS, Math.min(max, dur * porSegundo)))
  const passo = dur / n
  const w = LARGURA
  const h = Math.max(8, Math.round((w * v0.videoHeight) / v0.videoWidth / 2) * 2)
  const medidas = new Array(n)
  let feitas = 0
  const trecho = async (v, ini, fim) => {
    const cv = document.createElement('canvas')
    cv.width = w
    cv.height = h
    const ctx = cv.getContext('2d', { willReadFrequently: true })
    const rgb = new Uint8Array(w * h * 3)
    for (let k = ini; k < fim; k++) {
      // Mede no meio do trecho; a escolha soma passo/2 ao t, como no computador.
      await pular(v, (k + 0.5) * passo, signal)
      ctx.drawImage(v, 0, 0, w, h)
      const px = ctx.getImageData(0, 0, w, h).data
      for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
        rgb[j] = px[i]
        rgb[j + 1] = px[i + 1]
        rgb[j + 2] = px[i + 2]
      }
      medidas[k] = medir(rgb, w, h)
      onProgress?.(++feitas / n)
    }
  }
  const partes = Math.min(vs.length, n)
  await Promise.all(vs.slice(0, partes).map((v, i) => trecho(v, Math.floor((i * n) / partes), Math.floor(((i + 1) * n) / partes))))
  const amostras = medidas.map((m, k) => {
    const { y, ...resto } = m
    return { t: k * passo, ...resto, dif: k ? diferenca(y, medidas[k - 1].y) : 0 }
  })
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
