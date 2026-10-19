// Arrastar o dedo na miniatura de um vídeo para ver o take correr, sem abrir (no computador, passar o cursor).
// Usa a tira de quadros que o app de desktop gera junto do proxy (src/media/quadros.js): um JPEG com N quadros em grade,
// apontado pelo original em appProperties { quadros: <id>, quadrosGrade: 'n.cols.w.h' }. Sem tira, nada muda.
//
// Toque: quem decide é o gesto da miniatura (components/selecao.js useSegurar): arrastar para os lados corre o take
// (`toqueX`), com ou sem segurar antes; para cima e para baixo rola; segurar e soltar seleciona o item. O "voltar"
// arrastando não começa em cima da miniatura de vídeo (data-noswipe). Mouse/caneta: passar por cima, como no computador.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js'
import { streamReady, streamUrl } from '../lib/stream.js'

/** { id, n, cols, rows, w, h } da marca no original, ou null. */
export function gradeDe(f) {
  const id = f?.appProperties?.quadros
  const m = /^(\d{1,3})\.(\d{1,2})\.(\d{2,4})\.(\d{2,4})$/.exec(f?.appProperties?.quadrosGrade || '')
  if (!id || !m) return null
  const [n, cols, w, h] = m.slice(1).map(Number)
  if (!(n > 0 && cols > 0 && cols <= n)) return null
  return { id, n, cols, rows: Math.ceil(n / cols), w, h }
}

const carregadas = new Map() // src -> Promise<boolean>

function carregar(src) {
  let p = carregadas.get(src)
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => resolve(true)
      img.onerror = () => resolve(false)
      img.src = src
    })
    carregadas.set(src, p)
    if (carregadas.size > 60) carregadas.delete(carregadas.keys().next().value)
  }
  return p
}

/** Estilo do quadro `i`: a célula da grade cobrindo a caixa (como object-fit: cover). */
export function quadroStyle(g, i, caixa) {
  const col = i % g.cols
  const row = Math.floor(i / g.cols)
  const px = g.cols > 1 ? (col / (g.cols - 1)) * 100 : 0
  const py = g.rows > 1 ? (row / (g.rows - 1)) * 100 : 0
  const cel = g.w / g.h
  const box = caixa && caixa.w > 0 && caixa.h > 0 ? caixa.w / caixa.h : cel
  const largura = cel > box ? (cel / box) * 100 : 100
  const altura = cel > box ? 100 : (box / cel) * 100
  return [
    `width:${largura.toFixed(3)}%`,
    `height:${altura.toFixed(3)}%`,
    `left:${((100 - largura) / 2).toFixed(3)}%`,
    `top:${((100 - altura) / 2).toFixed(3)}%`,
    `background-size:${g.cols * 100}% ${g.rows * 100}%`,
    `background-position:${px.toFixed(4)}% ${py.toFixed(4)}%`,
  ].join(';')
}

const fileDaTira = (g) => ({ id: g.id, mimeType: 'image/jpeg', name: 'quadros.jpg' })

/**
 * Camada por cima da miniatura (dentro de um contêiner `position: relative`).
 * `toqueX`: posição do dedo (clientX) enquanto o gesto da miniatura está arrastando; null = parado.
 */
export function Scrub({ f, toqueX = null }) {
  const g = gradeDe(f)
  const ref = useRef(null)
  const [mouse, setMouse] = useState(null) // clientX do cursor (mouse/caneta)
  const [pronta, setPronta] = useState(false)
  const x = toqueX ?? mouse
  const src = g ? streamUrl(fileDaTira(g)) : null
  useEffect(() => {
    if (x == null || !src || pronta) return undefined
    let vivo = true
    streamReady()
      .then((ok) => (ok ? carregar(src) : false))
      .then((ok) => vivo && setPronta(ok))
    return () => {
      vivo = false
    }
  }, [x == null, src])
  if (!g) return null
  let st = null
  const r = x != null ? ref.current?.getBoundingClientRect() : null
  if (r?.width) st = { frac: Math.min(1, Math.max(0, (x - r.left) / r.width)), caixa: { w: r.width, h: r.height } }
  const i = st ? Math.min(g.n - 1, Math.floor(st.frac * g.n)) : 0
  const mouseX = (e) => (e.pointerType === 'touch' ? null : e.clientX)
  return html`<span
    class="hscrub"
    ref=${ref}
    aria-hidden="true"
    onPointerEnter=${(e) => setMouse(mouseX(e))}
    onPointerMove=${(e) => e.pointerType !== 'touch' && setMouse(e.clientX)}
    onPointerLeave=${(e) => e.pointerType !== 'touch' && setMouse(null)}
  >
    ${st && pronta
      ? html`<span class="hscrub-on">
          <span class="hscrub-frame" style=${`background-image:url("${src}");${quadroStyle(g, i, st.caixa)}`}></span>
          <span class="hscrub-bar" style=${`width:${(st.frac * 100).toFixed(2)}%`}></span>
        </span>`
      : st
        ? html`<span class="hscrub-carregando"></span>`
        : null}
  </span>`
}
