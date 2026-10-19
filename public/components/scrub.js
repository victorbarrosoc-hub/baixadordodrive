// Hover scrub: passar o cursor na miniatura de um vídeo e ver o take correr, como no DaVinci. Usa a tira de quadros
// que o motor gera junto do proxy (src/media/quadros.js): um JPEG com N quadros em grade, apontado pelo original em
// appProperties { quadros: <id>, quadrosGrade: 'n.cols.w.h' }. Sem tira, nada muda (fica a miniatura de sempre).
import { html, useRef, useState } from '/vendor/preact-htm.js'
import { streamUrl } from '../lib/media.js'

/** { n, cols, rows, w, h } da marca no original, ou null. */
export function gradeDe(item) {
  const id = item?.appProperties?.quadros
  const m = /^(\d{1,3})\.(\d{1,2})\.(\d{2,4})\.(\d{2,4})$/.exec(item?.appProperties?.quadrosGrade || '')
  if (!id || !m) return null
  const [n, cols, w, h] = m.slice(1).map(Number)
  if (!(n > 0 && cols > 0 && cols <= n)) return null
  return { id, n, cols, rows: Math.ceil(n / cols), w, h }
}

// Tiras já baixadas nesta sessão (o Image segura a decodificação: voltar ao mesmo card é instantâneo).
const carregadas = new Map() // src -> Promise<boolean>
const TETO = 80

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
    if (carregadas.size > TETO) carregadas.delete(carregadas.keys().next().value)
  }
  return p
}

/** Estilo do quadro `i`: a célula da grade, cobrindo a caixa (como object-fit: cover). */
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

/**
 * Camada por cima da miniatura (dentro de um contêiner `position: relative`). Só para mouse/caneta: o toque do app de
 * desktop é raro e segurar o dedo é do app do celular.
 */
export function Scrub({ accountId, item }) {
  const g = gradeDe(item)
  const ref = useRef(null)
  const [st, setSt] = useState(null) // { frac, pronta, caixa }
  if (!g) return null
  const src = streamUrl(accountId, { id: g.id })
  if (!src) return null
  const mover = (e) => {
    if (e.pointerType === 'touch') return
    const r = ref.current?.getBoundingClientRect()
    if (!r?.width) return
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    setSt((s) => ({ pronta: s?.pronta ?? false, caixa: { w: r.width, h: r.height }, frac }))
  }
  const entrar = (e) => {
    if (e.pointerType === 'touch') return
    mover(e)
    carregar(src).then((ok) => setSt((s) => (s ? { ...s, pronta: ok } : s)))
  }
  const i = st ? Math.min(g.n - 1, Math.floor(st.frac * g.n)) : 0
  return html`<span class="hscrub" ref=${ref} onPointerEnter=${entrar} onPointerMove=${mover} onPointerLeave=${() => setSt(null)} aria-hidden="true">
    ${st?.pronta
      ? html`<span class="hscrub-on">
          <span class="hscrub-frame" style=${`background-image:url("${src}");${quadroStyle(g, i, st.caixa)}`}></span>
          <span class="hscrub-bar" style=${`width:${(st.frac * 100).toFixed(2)}%`}></span>
        </span>`
      : st
        ? html`<span class="hscrub-carregando"></span>`
        : null}
  </span>`
}
