// Player próprio de vídeo e áudio: play/pause grande, barra de tempo arrastável, tempo, mudo, velocidade
// (1x · 1.5x · 2x) e tela cheia. Toca em streaming pelo service worker (/app/stream/<id>, com Range): nada de
// baixar o arquivo inteiro antes.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js'
import { clock } from '../lib/format.js'
import { Icon } from './icons.js'
import { cx } from './ui.js'

const RATES = [1, 1.5, 2]
const rateLabel = (r) => `${String(r).replace('.', ',')}x`

/** Barra de tempo: arrasta (ponteiro) ou setas do teclado. Mostra o trecho já carregado. */
function Scrubber({ time, dur, buffered, onSeek, onScrub }) {
  const ref = useRef(null)
  const [drag, setDrag] = useState(null) // fração enquanto arrasta
  const frac = drag != null ? drag : dur ? time / dur : 0
  const at = (e) => {
    const r = ref.current.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)))
  }
  const down = (e) => {
    if (!dur) return
    e.preventDefault()
    e.stopPropagation()
    ref.current.setPointerCapture?.(e.pointerId)
    const f = at(e)
    setDrag(f)
    onScrub?.(true, f * dur)
  }
  const move = (e) => {
    if (drag == null) return
    e.stopPropagation()
    const f = at(e)
    setDrag(f)
    onScrub?.(true, f * dur)
  }
  const up = (e) => {
    if (drag == null) return
    e.stopPropagation()
    const f = at(e)
    setDrag(null)
    onScrub?.(false)
    onSeek(f * dur)
  }
  const key = (e) => {
    if (!dur) return
    const step = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -10, ArrowUp: 10 }[e.key]
    if (step == null && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    onSeek(e.key === 'Home' ? 0 : e.key === 'End' ? dur - 0.5 : Math.max(0, Math.min(dur, time + step)))
  }
  return html`<div
    ref=${ref}
    class=${cx('scrub', drag != null && 'is-drag')}
    role="slider"
    tabindex="0"
    aria-label="Posição"
    aria-valuemin="0"
    aria-valuemax=${Math.round(dur || 0)}
    aria-valuenow=${Math.round(frac * (dur || 0))}
    aria-valuetext=${`${clock(frac * (dur || 0))} de ${clock(dur)}`}
    onPointerDown=${down}
    onPointerMove=${move}
    onPointerUp=${up}
    onPointerCancel=${up}
    onKeyDown=${key}
    data-control
  >
    <span class="scrub-track">
      <span class="scrub-buf" style=${`width:${dur ? Math.min(100, (buffered / dur) * 100) : 0}%`}></span>
      <span class="scrub-fill" style=${`width:${frac * 100}%`}></span>
    </span>
    <span class="scrub-knob" style=${`left:${frac * 100}%`}></span>
  </div>`
}

/**
 * kind 'video' | 'audio'. `poster` (miniatura) aparece até o primeiro quadro. onFail(code) quando o navegador não
 * consegue tocar (formato ou rede): quem chama decide o aviso.
 */
export function MediaPlayer({ kind, src, poster, title, ratio, badge, corner, startAt = 0, timeRef, onFail, onStall }) {
  const wrap = useRef(null)
  const media = useRef(null)
  const hideTimer = useRef(0)
  const [s, set] = useState({ playing: false, time: 0, dur: 0, buffered: 0, waiting: false, muted: false, rate: 1, started: false, ended: false })
  const [ui, setUi] = useState(true)
  const [scrub, setScrub] = useState(null)
  const patch = (p) => set((o) => ({ ...o, ...p }))
  // Quem troca de fonte (prévia leve ↔ original) lê onde estava e manda `startAt` para a nova continuar dali.
  if (timeRef) timeRef.current = s.time

  const sync = () => {
    const m = media.current
    if (!m) return
    let buf = 0
    for (let i = 0; i < m.buffered.length; i++) if (m.buffered.start(i) <= m.currentTime + 0.5) buf = Math.max(buf, m.buffered.end(i))
    patch({ time: m.currentTime, dur: Number.isFinite(m.duration) ? m.duration : 0, buffered: buf })
  }

  const showUi = () => {
    setUi(true)
    clearTimeout(hideTimer.current)
    if (kind === 'video') hideTimer.current = setTimeout(() => !media.current?.paused && setUi(false), 2800)
  }
  useEffect(() => () => clearTimeout(hideTimer.current), [])

  const toggle = (e) => {
    e?.stopPropagation()
    const m = media.current
    if (!m) return
    if (m.paused || m.ended) {
      const p = m.play()
      p?.catch?.(() => {})
    } else m.pause()
    showUi()
  }
  const seek = (t) => {
    const m = media.current
    if (!m) return
    m.currentTime = Math.max(0, Math.min(t, (m.duration || t) - 0.05))
    sync()
    showUi()
  }
  const mute = (e) => {
    e.stopPropagation()
    const m = media.current
    if (m) m.muted = !m.muted
    showUi()
  }
  const cycleRate = (e) => {
    e.stopPropagation()
    const m = media.current
    if (!m) return
    m.playbackRate = RATES[(RATES.indexOf(s.rate) + 1) % RATES.length]
    showUi()
  }
  const full = (e) => {
    e.stopPropagation()
    const m = media.current
    const w = wrap.current
    try {
      if (document.fullscreenElement) return document.exitFullscreen()
      if (w?.requestFullscreen && document.fullscreenEnabled) return w.requestFullscreen()
      if (m?.webkitEnterFullscreen) return m.webkitEnterFullscreen() // iPhone: só o <video> vai para tela cheia
    } catch {
      // sem tela cheia aqui
    }
  }

  // Travou: em espera por mais de 4 s, ou o tempo anda sem quadro novo (a imagem congela e o relógio segue).
  const stallTimer = useRef(0)
  const lastFrame = useRef({ media: 0, at: 0 })
  useEffect(() => {
    const m = media.current
    if (!onStall || kind !== 'video' || !m || !m.requestVideoFrameCallback) return
    let id = 0
    const tick = (_now, meta) => {
      lastFrame.current = { media: meta.mediaTime, at: m.currentTime }
      id = m.requestVideoFrameCallback(tick)
    }
    id = m.requestVideoFrameCallback(tick)
    return () => m.cancelVideoFrameCallback?.(id)
  }, [onStall, kind, src])
  const stall = () => {
    clearTimeout(stallTimer.current)
    media.current?.pause()
    onStall?.()
  }
  useEffect(() => () => clearTimeout(stallTimer.current), [])
  const checkFrames = () => {
    const m = media.current
    if (!onStall || kind !== 'video' || !m || m.paused || !m.requestVideoFrameCallback) return
    if (m.currentTime - lastFrame.current.at > 3) stall()
  }

  const onError = () => {
    const err = media.current?.error
    onFail?.(err?.code || 0)
  }

  const Media = kind === 'video' ? 'video' : 'audio'
  const playing = s.playing
  const showTime = scrub != null ? scrub : s.time
  const canFull = kind === 'video'
  return html`<div
    ref=${wrap}
    class=${cx('mp', `mp-${kind}`, ui || !playing ? 'is-ui' : 'is-bare', s.waiting && 'is-waiting', s.started && 'is-started')}
    style=${kind === 'video' && ratio ? `--ratio:${ratio}` : ''}
    onClick=${(e) => {
      if (e.target.closest('[data-control]')) return
      if (kind === 'video') {
        if (!s.started) toggle(e)
        else if (ui && playing) setUi(false)
        else showUi()
      }
    }}
  >
    <${Media}
      ref=${media}
      class="mp-media"
      src=${src}
      preload="metadata"
      playsinline
      webkit-playsinline
      x-webkit-airplay="allow"
      disablepictureinpicture=${kind === 'audio' ? true : undefined}
      aria-label=${title}
      onLoadedMetadata=${() => {
        const m = media.current
        if (m && startAt > 0) {
          m.currentTime = Math.min(startAt, Number.isFinite(m.duration) ? Math.max(0, m.duration - 0.1) : startAt)
          m.play()?.catch?.(() => {})
        }
        sync()
      }}
      onDurationChange=${sync}
      onTimeUpdate=${() => {
        if (scrub == null) sync()
        checkFrames()
      }}
      onProgress=${sync}
      onPlay=${() => (patch({ playing: true, started: true, ended: false }), showUi())}
      onPause=${() => (patch({ playing: false }), setUi(true))}
      onPlaying=${() => patch({ waiting: false, playing: true, started: true })}
      onWaiting=${() => {
        patch({ waiting: true })
        clearTimeout(stallTimer.current)
        if (onStall && kind === 'video') stallTimer.current = setTimeout(stall, 4000)
      }}
      onSeeked=${() => {
        // Depois de pular, o próximo quadro ainda não chegou: não conta como travado.
        lastFrame.current.at = media.current?.currentTime ?? 0
      }}
      onCanPlay=${() => {
        patch({ waiting: false })
        clearTimeout(stallTimer.current)
      }}
      onEnded=${() => (patch({ playing: false, ended: true }), setUi(true))}
      onVolumeChange=${() => patch({ muted: media.current?.muted })}
      onRateChange=${() => patch({ rate: media.current?.playbackRate || 1 })}
      onError=${onError}
    />
    ${kind === 'video' && poster && !s.started ? html`<img class="mp-poster" src=${poster} alt="" referrerpolicy="no-referrer" draggable="false" />` : null}
    ${badge ? html`<span class="mp-badge">${badge}</span>` : null}
    ${corner ? html`<div class="mp-corner" data-control>${corner}</div>` : null}
    ${kind === 'audio' ? html`<div class="mp-art">${poster ? html`<img src=${poster} alt="" referrerpolicy="no-referrer" draggable="false" />` : html`<span class="mp-art-glyph"><${Icon} name="music" size=${46} strokeWidth=${1.3} /></span>`}</div>` : null}

    <button type="button" class="mp-big" onClick=${toggle} aria-label=${playing ? 'Pausar' : 'Reproduzir'} data-control>
      ${s.waiting && playing ? html`<span class="spinner mp-spin" aria-hidden="true"></span>` : html`<${Icon} name=${playing ? 'pause-fill' : 'play'} size=${kind === 'video' ? 30 : 28} />`}
    </button>

    <div class="mp-bar" data-control>
      <div class="mp-times">
        <span class="tc">${clock(showTime)}</span>
        <span class="tc mp-left">${s.dur ? `-${clock(Math.max(0, s.dur - showTime))}` : '--:--'}</span>
      </div>
      <${Scrubber} time=${s.time} dur=${s.dur} buffered=${s.buffered} onSeek=${seek} onScrub=${(on, t) => setScrub(on ? t : null)} />
      <div class="mp-row">
        <button type="button" class="mp-btn" onClick=${mute} aria-label=${s.muted ? 'Ligar o som' : 'Sem som'} aria-pressed=${s.muted ? 'true' : 'false'}>
          <${Icon} name=${s.muted ? 'volume-off' : 'volume'} size=${20} />
        </button>
        <button type="button" class="mp-btn mp-rate" onClick=${cycleRate} aria-label=${`Velocidade ${rateLabel(s.rate)}`}>${rateLabel(s.rate)}</button>
        ${canFull
          ? html`<button type="button" class="mp-btn" onClick=${full} aria-label="Tela cheia">
              <${Icon} name="expand" size=${19} />
            </button>`
          : html`<span class="mp-btn" aria-hidden="true"></span>`}
      </div>
    </div>
  </div>`
}
