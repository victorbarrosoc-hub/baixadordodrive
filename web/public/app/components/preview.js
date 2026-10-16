// Prévia de um arquivo do Drive, em tela cheia (como as folhas do iOS): vídeo e áudio no player próprio, foto grande
// com pinça, e os dados do arquivo. Baixar fica no topo. Arrastar para baixo fecha; para o lado, passa de arquivo.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js'
import { canDownload, driveUrl, findProxy, getFile, isGoogleDoc, kindOf, mayPlay, showsAsImage, target, wantsProxy } from '../lib/browse.js'
import { loadThumb, streamReady, streamUrl } from '../lib/stream.js'
import { bytes, duration, extOf, fullDate } from '../lib/format.js'
import { toast } from '../lib/state.js'
import { isIOS } from '../lib/platform.js'
import { Icon } from './icons.js'
import { Button, cx, reducedMotion } from './ui.js'
import { MediaPlayer } from './player.js'
import { KindGlyph } from './thumb.js'
import { FileName } from './queue.js'

const BIG = 1e9 // acima disso, avisa antes de baixar no celular
const IMAGE_STREAM_MAX = 60e6 // foto sem miniatura: abre o arquivo em si até este tamanho

const screenPx = () => Math.min(2400, Math.round(Math.max(window.innerWidth, window.innerHeight) * Math.min(3, window.devicePixelRatio || 1)))

function useThumb(file, px) {
  const [url, setUrl] = useState(undefined)
  useEffect(() => {
    let alive = true
    setUrl(undefined)
    if (!file.thumbnailLink) {
      setUrl(null)
      return
    }
    loadThumb(file, px).then((u) => alive && setUrl(u))
    return () => (alive = false)
  }, [file.id, px])
  return url
}

// ───── foto com pinça e toque duplo ─────

function ZoomImage({ src, low, alt, onZoom, onError }) {
  const box = useRef(null)
  const z = useRef({ s: 1, x: 0, y: 0 })
  const ptrs = useRef(new Map())
  const g = useRef(null)
  const lastTap = useRef(0)
  const [, force] = useState(0)
  const [ready, setReady] = useState(false)

  const apply = (anim) => {
    const el = box.current?.firstElementChild
    if (!el) return
    const { s, x, y } = z.current
    el.style.transition = anim && !reducedMotion() ? 'transform 0.25s cubic-bezier(0.2,0.8,0.2,1)' : 'none'
    el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${s})`
    onZoom?.(s > 1.01)
  }
  const clamp = () => {
    const r = box.current.getBoundingClientRect()
    const { s } = z.current
    const mx = ((s - 1) * r.width) / 2
    const my = ((s - 1) * r.height) / 2
    z.current.x = Math.max(-mx, Math.min(mx, z.current.x))
    z.current.y = Math.max(-my, Math.min(my, z.current.y))
  }
  const zoomAt = (s, cx, cy) => {
    const r = box.current.getBoundingClientRect()
    const ox = cx - (r.left + r.width / 2)
    const oy = cy - (r.top + r.height / 2)
    const k = s / z.current.s
    z.current.x = ox - (ox - z.current.x) * k
    z.current.y = oy - (oy - z.current.y) * k
    z.current.s = s
    clamp()
  }

  const down = (e) => {
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (ptrs.current.size === 2) {
      const [a, b] = [...ptrs.current.values()]
      g.current = { pinch: true, d0: Math.hypot(a.x - b.x, a.y - b.y), s0: z.current.s }
      e.stopPropagation()
    } else if (ptrs.current.size === 1 && z.current.s > 1.01) {
      g.current = { pan: true, x0: e.clientX - z.current.x, y0: e.clientY - z.current.y }
      e.stopPropagation()
    }
  }
  const move = (e) => {
    if (!ptrs.current.has(e.pointerId)) return
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const st = g.current
    if (!st) return
    e.stopPropagation()
    if (st.pinch && ptrs.current.size >= 2) {
      const [a, b] = [...ptrs.current.values()]
      const s = Math.max(1, Math.min(5, (st.s0 * Math.hypot(a.x - b.x, a.y - b.y)) / Math.max(1, st.d0)))
      zoomAt(s, (a.x + b.x) / 2, (a.y + b.y) / 2)
      apply(false)
    } else if (st.pan) {
      z.current.x = e.clientX - st.x0
      z.current.y = e.clientY - st.y0
      clamp()
      apply(false)
    }
  }
  const up = (e) => {
    const had = ptrs.current.delete(e.pointerId)
    if (!had) return
    if (g.current) e.stopPropagation()
    if (ptrs.current.size === 0) {
      const now = performance.now()
      if (!g.current?.pinch && now - lastTap.current < 280) {
        // toque duplo: aproxima onde tocou, ou volta ao normal
        if (z.current.s > 1.01) z.current = { s: 1, x: 0, y: 0 }
        else zoomAt(2.5, e.clientX, e.clientY)
        apply(true)
        lastTap.current = 0
        e.stopPropagation()
      } else lastTap.current = now
      if (z.current.s < 1.02) {
        z.current = { s: 1, x: 0, y: 0 }
        apply(true)
      }
      g.current = null
    }
  }

  return html`<div
    ref=${box}
    class=${cx('zoom', ready && 'is-ready')}
    onPointerDown=${down}
    onPointerMove=${move}
    onPointerUp=${up}
    onPointerCancel=${up}
  >
    <div class="zoom-inner">
      ${low && !ready ? html`<img class="zoom-low" src=${low} alt="" referrerpolicy="no-referrer" draggable="false" />` : null}
      <img
        class="zoom-img"
        src=${src}
        alt=${alt}
        referrerpolicy="no-referrer"
        draggable="false"
        decoding="async"
        onLoad=${() => (setReady(true), force((n) => n + 1))}
        onError=${onError}
      />
    </div>
  </div>`
}

// ───── o que aparece no palco, por tipo ─────

function Unsupported({ file, poster, reason, children }) {
  const kind = kindOf(file)
  return html`<div class="pv-none">
    <div class="pv-none-art">
      ${poster ? html`<img src=${poster} alt="" referrerpolicy="no-referrer" draggable="false" />` : html`<${KindGlyph} kind=${kind} name=${file.name} size=${44} />`}
    </div>
    <p class="pv-none-text">${reason}</p>
    ${children ? html`<div class="pv-none-acts">${children}</div>` : null}
  </div>`
}

/**
 * Vídeo pesado demais para tocar pela rede (ProRes, 4K de câmera): o Drive toca porque usa a cópia leve que ele
 * mesmo gera, e a API só entrega o original. Taxa = tamanho / duração; o limite é menor no celular.
 */
function mbpsOf(file) {
  const ms = Number(file.videoMediaMetadata?.durationMillis || 0)
  const size = Number(file.size || 0)
  return ms > 0 && size > 0 ? (size * 8) / (ms / 1000) / 1e6 : 0
}
const LIMIT_MBPS = () => (window.matchMedia?.('(pointer: coarse)').matches || window.innerWidth < 768 ? 60 : 400)
const isHeavy = (file) => mbpsOf(file) > LIMIT_MBPS()

function HeavyNotice({ file, poster, onTry, stalled }) {
  return html`<${Unsupported}
    file=${file}
    poster=${poster}
    reason=${stalled
      ? 'A rede não está dando conta deste vídeo. O Google Drive toca uma cópia leve dele.'
      : 'Vídeo pesado demais para tocar pela rede. O Google Drive toca uma cópia leve dele.'}
  >
    <a class="btn btn-primary btn-sm" href=${driveUrl(file)} target="_blank" rel="noopener noreferrer">Ver no Google Drive</a>
    <button type="button" class="btn btn-secondary btn-sm" onClick=${onTry}>Tentar mesmo assim</button>
  </${Unsupported}>`
}

/** Pergunta ao SW o que houve quando o <video> falha: formato que não toca, ou acesso/rede. */
async function whyFailed(file) {
  try {
    const r = await fetch(streamUrl(file), { headers: { Range: 'bytes=0-1' }, cache: 'no-store' })
    if (r.ok) return 'format'
    if (r.status === 409) return 'reconnect'
    if (r.status === 401) return 'session'
    if (r.status === 403) return 'denied'
    if (r.status === 404) return 'gone'
    return 'network'
  } catch {
    return 'network'
  }
}

const FAIL_TEXT = {
  format: 'Este formato não toca no navegador. Baixe para ver no app de vídeo, ou abra no Drive.',
  reconnect: 'O Google pediu uma nova autorização. Reconecte o Drive na sua conta.',
  session: 'Sua sessão terminou. Entre de novo para ver a prévia.',
  denied: 'O Google não liberou este arquivo para prévia.',
  gone: 'Não achei este arquivo no Drive. Ele pode ter sido movido.',
  network: 'Não consegui carregar a prévia. Confira a internet.',
  nosw: 'A prévia precisa do app atualizado. Feche e abra o SOBEDESCE de novo.',
}

function MediaStage({ file, kind, siblings, onZoom }) {
  const px = screenPx()
  const poster = useThumb(file, kind === 'image' ? px : Math.min(1600, px))
  const [sw, setSw] = useState(undefined)
  const [fail, setFail] = useState(null)
  // Proxy de câmera: undefined = não precisou; 'look' = procurando; arquivo; null = não achou.
  const [proxy, setProxy] = useState(undefined)
  const [proxyFail, setProxyFail] = useState(false)
  const proxyPoster = useThumb(proxy && proxy !== 'look' ? proxy : { id: '-' }, Math.min(1600, px))
  const playable = kind === 'video' || kind === 'audio' ? mayPlay(file) : false
  // heavy: 'taxa' (pela conta) | 'trava' (travou tocando) | null; forced: a pessoa pediu para tentar mesmo assim.
  const [heavy, setHeavy] = useState(() => (kind === 'video' && isHeavy(file) ? 'taxa' : null))
  const [forced, setForced] = useState(false)
  const needProxy = kind === 'video' && (fail === 'format' || wantsProxy(file) || (heavy && !forced))
  useEffect(() => {
    let alive = true
    setFail(null)
    setProxy(undefined)
    setProxyFail(false)
    setHeavy(kind === 'video' && isHeavy(file) ? 'taxa' : null)
    setForced(false)
    streamReady().then((ok) => alive && setSw(ok))
    return () => (alive = false)
  }, [file.id])
  useEffect(() => {
    if (!needProxy || !sw || proxy !== undefined) return
    let alive = true
    setProxy('look')
    findProxy(file, siblings).then(
      (p) => alive && setProxy(p || null),
      () => alive && setProxy(null),
    )
    return () => (alive = false)
  }, [needProxy, sw, file.id])

  if (kind === 'video' && needProxy && proxy && proxy !== 'look' && !proxyFail) {
    const vm = proxy.videoMediaMetadata || file.videoMediaMetadata
    const ratio = vm?.width && vm?.height ? `${vm.width} / ${vm.height}` : null
    return html`<div class="pv-proxy">
      <${MediaPlayer}
        key=${proxy.id}
        kind="video"
        src=${streamUrl(proxy)}
        poster=${poster || proxyPoster || null}
        title=${`${file.name} (proxy)`}
        ratio=${ratio}
        badge="Proxy"
        onFail=${() => setProxyFail(true)}
      />
      <p class="pv-proxy-note">Prévia em baixa resolução. O Baixar traz o original.</p>
    </div>`
  }
  if (kind === 'video' || kind === 'audio') {
    const art = poster || proxyPoster || null
    if (needProxy && (sw === undefined || proxy === 'look' || (proxy === undefined && sw))) return html`<div class="pv-wait"><span class="spinner"></span></div>`
    if (heavy && !forced && fail !== 'format') return html`<${HeavyNotice} file=${file} poster=${art} stalled=${heavy === 'trava'} onTry=${() => setForced(true)} />`
    if (!playable || fail === 'format') return html`<${Unsupported} file=${file} poster=${art} reason=${FAIL_TEXT.format} />`
    if (sw === false) return html`<${Unsupported} file=${file} poster=${art} reason=${FAIL_TEXT.nosw} />`
    if (fail) return html`<${Unsupported} file=${file} poster=${art} reason=${FAIL_TEXT[fail] || FAIL_TEXT.network} />`
    if (sw === undefined) return html`<div class="pv-wait"><span class="spinner"></span></div>`
    const vm = file.videoMediaMetadata
    const ratio = vm?.width && vm?.height ? `${vm.width} / ${vm.height}` : null
    return html`<${MediaPlayer}
      key=${file.id}
      kind=${kind}
      src=${streamUrl(file)}
      poster=${poster || null}
      title=${file.name}
      ratio=${ratio}
      onFail=${async (code) => setFail(code === 3 || code === 4 ? await whyFailed(file) : 'network')}
      onStall=${kind === 'video' && !forced ? () => setHeavy('trava') : null}
    />`
  }

  if (kind === 'image') {
    return html`<${ImageStage} file=${file} poster=${poster} px=${px} sw=${sw} onZoom=${onZoom} />`
  }

  const reason = isGoogleDoc(file)
    ? 'Documento do Google: abra no Drive para ver e editar.'
    : kind === 'pdf'
      ? 'Sem prévia de PDF aqui. Baixe para abrir no seu leitor, ou abra no Drive.'
      : 'Sem prévia para este tipo de arquivo.'
  return html`<${Unsupported} file=${file} poster=${poster} reason=${reason} />`
}

function ImageStage({ file, poster, px, sw, onZoom }) {
  // Miniatura grande do Google primeiro; se não vier, a própria foto (se o navegador mostra e não for enorme).
  const direct = sw && showsAsImage(file) && Number(file.size || 0) <= IMAGE_STREAM_MAX ? streamUrl(file) : null
  const [step, setStep] = useState(0)
  if (poster === undefined || (!poster && sw === undefined)) return html`<div class="pv-wait"><span class="spinner"></span></div>`
  const src = [poster, direct].filter(Boolean)[step]
  if (!src) return html`<${Unsupported} file=${file} poster=${null} reason=${'Sem prévia para esta foto aqui. Baixe para ver no tamanho original.'} />`
  return html`<${ZoomImage} key=${src} src=${src} alt=${file.name} onZoom=${onZoom} onError=${() => setStep((n) => n + 1)} />`
}

// ───── dados e ações ─────

function Info({ file, kind }) {
  const vm = file.videoMediaMetadata
  const im = file.imageMediaMetadata
  const rows = []
  if (file.size != null) rows.push(['Tamanho', bytes(Number(file.size))])
  if (vm?.durationMillis) rows.push(['Duração', duration(vm.durationMillis)])
  const w = vm?.width || im?.width
  const h = vm?.height || im?.height
  if (w && h) rows.push(['Resolução', `${w} × ${h}`])
  if (im?.cameraMake || im?.cameraModel) rows.push(['Câmera', [im.cameraMake, im.cameraModel].filter(Boolean).join(' ')])
  if (im?.time) rows.push(['Foto tirada', im.time.replace(/^(\d{4}):(\d{2}):(\d{2}).*/, '$3/$2/$1')])
  if (file.modifiedTime) rows.push(['Modificado', fullDate(file.modifiedTime)])
  const ext = extOf(file.name)
  rows.push(['Tipo', isGoogleDoc(file) ? 'Documento do Google' : ext ? ext.toUpperCase() : file.mimeType || '—'])
  return html`<dl class="group pv-meta">
    ${rows.map(([k, v]) => html`<div class="pv-meta-row"><dt>${k}</dt><dd class=${k === 'Duração' || k === 'Resolução' ? 'tc' : ''}>${v}</dd></div>`)}
  </dl>`
}

function startDownload(file) {
  const a = document.createElement('a')
  a.href = streamUrl(file, { download: true })
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  toast(isIOS ? 'Baixando. Fica em Arquivos › Downloads' : 'Baixando', { tone: 'success', ms: 3600 })
}

function BigWarning({ file, onGo, onCancel }) {
  return html`<div class="pv-confirm" role="alertdialog" aria-labelledby="pv-confirm-t" aria-describedby="pv-confirm-d">
    <div class="pv-confirm-card">
      <span class="pv-confirm-icon"><${Icon} name="download" size=${22} /></span>
      <b id="pv-confirm-t">Arquivo grande: ${bytes(Number(file.size))}</b>
      <p id="pv-confirm-d">No celular a tela precisa ficar aberta e a transferência é mais lenta. No computador, o app SOBEDESCE baixa muito mais rápido.</p>
      <${Button} variant="down" size="lg" class="btn-block" icon="download" onClick=${onGo}>Baixar mesmo assim</${Button}>
      <${Button} variant="ghost" class="btn-block" onClick=${onCancel}>Agora não</${Button}>
    </div>
  </div>`
}

// ───── a prévia ─────

export function Preview({ files, index, onIndex, onClose }) {
  const raw = files[index]
  const [resolved, setResolved] = useState(null)
  const file = resolved?.id === target(raw).id ? resolved : target(raw)
  const kind = kindOf(file)
  const [zoomed, setZoomed] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [phase, setPhase] = useState('enter')
  const [dir, setDir] = useState(0)
  const layer = useRef(null)
  const track = useRef(null)
  const gest = useRef(null)
  const lastFocus = useRef(null)

  // Atalho: busca os dados do alvo (tamanho, miniatura) para a prévia funcionar igual.
  useEffect(() => {
    setConfirm(false)
    setZoomed(false)
    if (!raw.shortcut && raw.mimeType !== 'application/vnd.google-apps.shortcut') return
    const ctl = new AbortController()
    getFile(target(raw).id, ctl.signal).then(setResolved, () => {})
    return () => ctl.abort()
  }, [raw.id])

  useEffect(() => {
    lastFocus.current = document.activeElement
    document.documentElement.classList.add('has-preview')
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setPhase('open')))
    layer.current?.focus({ preventScroll: true })
    return () => {
      cancelAnimationFrame(raf)
      document.documentElement.classList.remove('has-preview')
      try {
        lastFocus.current?.focus?.({ preventScroll: true })
      } catch {
        // já saiu da tela
      }
    }
  }, [])

  const close = () => {
    setPhase('leave')
    setTimeout(onClose, reducedMotion() ? 0 : 260)
  }
  const go = (d) => {
    const i = index + d
    if (i < 0 || i >= files.length) return false
    setDir(d)
    onIndex(i)
    return true
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('[role=slider]')) return
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [index, files.length])

  // Gestos no palco: para o lado troca de arquivo; para baixo fecha. Nada disso com a foto ampliada.
  const down = (e) => {
    if (zoomed || !e.isPrimary || e.target.closest('[data-control], button, a, input')) return
    gest.current = { x0: e.clientX, y0: e.clientY, t0: performance.now(), axis: null, dx: 0, dy: 0, id: e.pointerId }
  }
  const move = (e) => {
    const g = gest.current
    if (!g || g.id !== e.pointerId) return
    if (zoomed) return (gest.current = null)
    g.dx = e.clientX - g.x0
    g.dy = e.clientY - g.y0
    if (!g.axis) {
      if (Math.hypot(g.dx, g.dy) < 10) return
      g.axis = Math.abs(g.dx) > Math.abs(g.dy) ? 'x' : g.dy > 0 ? 'y' : 'none'
      if (g.axis !== 'none') e.currentTarget.setPointerCapture?.(e.pointerId)
    }
    if (g.axis === 'x' && track.current) {
      const edge = (g.dx > 0 && index === 0) || (g.dx < 0 && index === files.length - 1)
      track.current.style.transition = 'none'
      track.current.style.transform = `translate3d(${edge ? g.dx / 3 : g.dx}px,0,0)`
    } else if (g.axis === 'y' && layer.current) {
      const dy = Math.max(0, g.dy)
      layer.current.style.transition = 'none'
      layer.current.style.transform = `translate3d(0,${dy}px,0)`
      layer.current.style.setProperty('--pv-fade', String(Math.max(0.3, 1 - dy / 500)))
    }
  }
  const up = (e) => {
    const g = gest.current
    if (!g || g.id !== e.pointerId) return
    gest.current = null
    const dt = Math.max(1, performance.now() - g.t0)
    if (g.axis === 'x' && track.current) {
      track.current.style.transition = ''
      track.current.style.transform = ''
      if (Math.abs(g.dx) > 70 || (Math.abs(g.dx) > 30 && Math.abs(g.dx) / dt > 0.5)) go(g.dx < 0 ? 1 : -1)
    } else if (g.axis === 'y' && layer.current) {
      layer.current.style.transition = ''
      if (g.dy > 120 || (g.dy > 40 && g.dy / dt > 0.6)) {
        close()
      } else {
        layer.current.style.transform = ''
        layer.current.style.removeProperty('--pv-fade')
      }
    }
  }

  const download = () => {
    if (!canDownload(file)) return
    if (Number(file.size) > BIG && !confirm) return setConfirm(true)
    setConfirm(false)
    streamReady().then((ok) => (ok ? startDownload(file) : toast(FAIL_TEXT.nosw, { tone: 'error', ms: 4200 })))
  }
  const share = async () => {
    try {
      await navigator.share({ title: file.name, url: driveUrl(file) })
    } catch {
      // cancelado
    }
  }
  const dl = canDownload(file)
  const media = kind === 'video' || kind === 'image' || kind === 'audio'

  return html`<div class=${cx('pv-layer', `is-${phase}`)}>
    <div class="pv-backdrop" aria-hidden="true"></div>
    <div ref=${layer} class=${cx('pv', `pv-${kind}`)} role="dialog" aria-modal="true" aria-label=${file.name} tabindex="-1">
      <header class="pv-top" onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}>
        <button type="button" class="icon-btn pv-close" onClick=${close} aria-label="Fechar">
          <${Icon} name="chevron-down" size=${22} strokeWidth=${2} />
        </button>
        <div class="pv-titles">
          <${FileName} name=${file.name} class="pv-name" />
          <span class="pv-count">${files.length > 1 ? `${index + 1} de ${files.length}` : file.size != null ? bytes(Number(file.size)) : ''}</span>
        </div>
        ${dl
          ? html`<${Button} variant="down" size="sm" class="pv-dl" icon="download" onClick=${download} aria-label=${`Baixar ${file.name}`}>Baixar</${Button}>`
          : html`<a class="btn btn-secondary btn-sm pv-dl" href=${driveUrl(file)} target="_blank" rel="noopener noreferrer"><span>Abrir</span></a>`}
      </header>

      <div class="pv-scroll">
        <div class=${cx('pv-stage', media && 'is-media')} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up}>
          <div ref=${track} class="pv-track">
            <div key=${file.id} class=${cx('pv-slide', dir > 0 && 'from-right', dir < 0 && 'from-left')}>
              <${MediaStage} file=${file} kind=${kind} siblings=${files} onZoom=${setZoomed} />
            </div>
          </div>
          ${files.length > 1
            ? html`<button type="button" class="pv-nav is-prev" onClick=${() => go(-1)} disabled=${index === 0} aria-label="Arquivo anterior" data-control>
                  <${Icon} name="chevron-left" size=${20} strokeWidth=${2} />
                </button>
                <button type="button" class="pv-nav is-next" onClick=${() => go(1)} disabled=${index === files.length - 1} aria-label="Próximo arquivo" data-control>
                  <${Icon} name="chevron-right" size=${20} strokeWidth=${2} />
                </button>`
            : null}
        </div>

        <section class="pv-info">
          <${Info} file=${file} kind=${kind} />
          <div class="pv-actions">
            <a class="btn btn-secondary pv-act" href=${driveUrl(file)} target="_blank" rel="noopener noreferrer">
              <${Icon} name="external" size=${17} /><span>Abrir no Drive</span>
            </a>
            ${typeof navigator.share === 'function'
              ? html`<${Button} variant="secondary" class="pv-act" icon="share" onClick=${share}>Compartilhar</${Button}>`
              : null}
          </div>
          ${dl && Number(file.size) > BIG
            ? html`<p class="pv-hint"><${Icon} name="laptop" size=${15} /> <span>Arquivo grande. No computador, o app SOBEDESCE baixa muito mais rápido.</span></p>`
            : null}
          ${files.length > 1 ? html`<p class="pv-hint is-soft">Deslize para o lado para ver o próximo.</p>` : null}
        </section>
      </div>

      ${confirm ? html`<${BigWarning} file=${file} onGo=${download} onCancel=${() => setConfirm(false)} />` : null}
    </div>
  </div>`
}
