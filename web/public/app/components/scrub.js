// Segurar e arrastar na miniatura de um vídeo para ver o take correr, sem abrir (no computador, passar o cursor).
// Usa a tira de quadros que o app de desktop gera junto do proxy (src/media/quadros.js): um JPEG com N quadros em grade,
// apontado pelo original em appProperties { quadros: <id>, quadrosGrade: 'n.cols.w.h' }. Sem tira, nada muda.
//
// Toque: segurar ~0,3 s liga (vibra no Android) e, daí em diante, arrastar para os lados corre o take; a lista não
// rola enquanto isso e soltar não abre o arquivo. Mexeu o dedo antes de ligar = era rolagem, nada acontece.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js'
import { streamReady, streamUrl } from '../lib/stream.js'

const SEGURAR_MS = 300
const FOLGA_PX = 10

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

/** Camada por cima da miniatura (dentro de um contêiner `position: relative`). */
export function Scrub({ f }) {
  const g = gradeDe(f)
  const ref = useRef(null)
  const [st, setSt] = useState(null) // { frac, pronta, caixa }
  const t = useRef({ timer: 0, ativo: false, x: 0, y: 0, engolir: 0 })

  // A rolagem só é impedida com o toque ligado (touchmove não passivo; os eventos de ponteiro não bastam no iOS).
  useEffect(() => {
    const el = ref.current
    if (!el || !g) return undefined
    const onMove = (e) => {
      if (t.current.ativo && e.cancelable) e.preventDefault()
    }
    el.addEventListener('touchmove', onMove, { passive: false })
    return () => {
      el.removeEventListener('touchmove', onMove)
      clearTimeout(t.current.timer)
    }
  }, [!!g])

  if (!g) return null
  const src = streamUrl(fileDaTira(g))

  const posicao = (clientX) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r?.width) return null
    return { frac: Math.min(1, Math.max(0, (clientX - r.left) / r.width)), caixa: { w: r.width, h: r.height } }
  }
  const ligar = (clientX) => {
    const p = posicao(clientX)
    if (!p) return
    setSt({ ...p, pronta: false })
    streamReady()
      .then((ok) => (ok ? carregar(src) : false))
      .then((ok) => setSt((s) => (s ? { ...s, pronta: ok } : s)))
  }
  const mover = (clientX) => {
    const p = posicao(clientX)
    if (p) setSt((s) => (s ? { ...s, ...p } : s))
  }
  const desligar = () => {
    clearTimeout(t.current.timer)
    if (t.current.ativo) t.current.engolir = Date.now() + 500
    t.current.ativo = false
    setSt(null)
  }

  const onPointerDown = (e) => {
    if (e.pointerType !== 'touch') return
    const c = t.current
    clearTimeout(c.timer)
    c.x = e.clientX
    c.y = e.clientY
    const x = e.clientX
    c.timer = setTimeout(() => {
      c.ativo = true
      navigator.vibrate?.(8)
      ligar(x)
    }, SEGURAR_MS)
  }
  const onPointerMove = (e) => {
    const c = t.current
    if (e.pointerType === 'touch') {
      if (c.ativo) mover(e.clientX)
      else if (Math.hypot(e.clientX - c.x, e.clientY - c.y) > FOLGA_PX) clearTimeout(c.timer)
      return
    }
    if (st) mover(e.clientX)
  }
  const onPointerEnter = (e) => {
    if (e.pointerType !== 'touch') ligar(e.clientX)
  }
  const onPointerLeave = (e) => {
    if (e.pointerType !== 'touch') setSt(null)
  }
  // Soltar depois de correr o take não abre o arquivo.
  const onClickCapture = (e) => {
    if (Date.now() < t.current.engolir) {
      e.preventDefault()
      e.stopPropagation()
    }
  }
  const onContextMenu = (e) => {
    if (t.current.ativo || st) e.preventDefault()
  }

  const i = st ? Math.min(g.n - 1, Math.floor(st.frac * g.n)) : 0
  return html`<span
    class="hscrub"
    ref=${ref}
    aria-hidden="true"
    onPointerDown=${onPointerDown}
    onPointerMove=${onPointerMove}
    onPointerUp=${desligar}
    onPointerCancel=${desligar}
    onPointerEnter=${onPointerEnter}
    onPointerLeave=${onPointerLeave}
    onClickCapture=${onClickCapture}
    onContextMenu=${onContextMenu}
  >
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
