// Miniaturas do Drive (carregamento preguiçoso, reserva no ícone do tipo) e o glifo de cada tipo de arquivo.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js'
import { loadThumb, thumbNow } from '../lib/stream.js'
import { miniaturaPsd, miniaturaPsdAgora, podePsd } from '../lib/psd.js'
import { extOf } from '../lib/format.js'
import { Icon } from './icons.js'
import { cx } from './ui.js'

const KIND_GLYPH = { folder: 'folder', video: 'film', audio: 'music', image: 'photo', pdf: 'doc', gdoc: 'doc', archive: 'archive', doc: 'doc', generic: 'doc' }
const dpr = () => Math.min(3, window.devicePixelRatio || 1)

/** Glifo do tipo, quando não há miniatura: pasta azul, o resto em tom neutro com a extensão. */
export function KindGlyph({ kind, name, size = 30, label = true }) {
  const ext = kind === 'folder' || kind === 'gdoc' ? '' : extOf(name || '').toUpperCase().slice(0, 5)
  return html`<span class=${cx('glyph', `k-${kind}`)} aria-hidden="true">
    <${Icon} name=${KIND_GLYPH[kind] || 'doc'} size=${size} strokeWidth=${1.4} />
    ${label && ext ? html`<span class="glyph-ext">${ext}</span>` : null}
  </span>`
}

/** Miniatura com carregamento preguiçoso (IntersectionObserver) e reserva no ícone do tipo. */
export function Thumb({ file, from = file, px, kind, small = false }) {
  const ref = useRef(null)
  const size = Math.round(px * dpr())
  // PSD sem miniatura do Google: a que o Photoshop grava dentro do arquivo (lib/psd.js).
  const psd = !from.thumbnailLink && podePsd(file)
  const agora = () => (from.thumbnailLink ? thumbNow(from, size) : psd ? miniaturaPsdAgora(file) : null)
  const [src, setSrc] = useState(agora)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    const now = agora()
    setSrc(now)
    setLoaded(false)
    if (now !== undefined) return
    let alive = true
    const el = ref.current
    const start = () => (psd ? miniaturaPsd(file) : loadThumb(from, size)).then((u) => alive && setSrc(u))
    if (!el || typeof IntersectionObserver === 'undefined') {
      start()
      return () => (alive = false)
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect()
          start()
        }
      },
      { rootMargin: '400px 0px' },
    )
    io.observe(el)
    return () => {
      alive = false
      io.disconnect()
    }
  }, [from.id, from.thumbnailLink, size])
  return html`<span ref=${ref} class=${cx('thumb', `k-${kind}`, src && 'has-img', src && loaded && 'is-loaded', src === undefined && 'is-wait')}>
    ${src ? null : html`<${KindGlyph} kind=${kind} name=${file.name} size=${small ? 20 : kind === 'folder' ? 40 : 30} label=${!small} />`}
    ${src
      ? html`<img src=${src} alt="" referrerpolicy="no-referrer" decoding="async" draggable="false" onLoad=${() => setLoaded(true)} onError=${() => setSrc(null)} />`
      : null}
  </span>`
}

