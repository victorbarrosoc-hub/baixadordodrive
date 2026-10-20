// Player próprio de vídeo e áudio: play/pause grande, barra de tempo arrastável, tempo, mudo, velocidade
// (1x · 1.5x · 2x) e tela cheia. Toca em streaming pelo service worker (/app/stream/<id>, com Range): nada de
// baixar o arquivo inteiro antes.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js'
import { clock } from '../lib/format.js'
import { nowPlaying } from '../lib/now-playing.js'
import { Icon } from './icons.js'
import { cx } from './ui.js'
import { filtroCor, quadroRgb } from '../lib/cor.js'

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

// ───── carregando: a marca SOBEDESCE como buffer ─────
//
// As duas barras do ícone viram o medidor: a violeta enche de baixo para cima (sobe) e a azul de cima para baixo
// (desce), na proporção do que já chegou dos próximos segundos; um brilho corre dentro delas enquanto chegam bytes.
// Embaixo: a porcentagem e quanto falta para começar, pela velocidade com que o trecho carregado cresce.

const AHEAD_S = 4 // segundos à frente que contam como "pronto para tocar"

/** Medição do buffer enquanto o player quer tocar e ainda não tem dados (ou parou para carregar). */
function useBuffering(media, on) {
  const [b, setB] = useState(null) // null | { pct, eta, phase: 'conectando' | 'carregando' }
  const last = useRef(null)
  useEffect(() => {
    if (!on) {
      last.current = null
      setB(null)
      return
    }
    const tick = () => {
      const m = media.current
      if (!m) return
      // Pausado (o navegador barrou o autoplay, ou a pessoa pausou): some e o botão de play volta.
      if (m.paused) return setB(null)
      const now = performance.now()
      if (m.readyState < 1) return setB({ pct: 0, eta: null, phase: 'conectando' })
      const t = m.currentTime
      let end = t
      for (let i = 0; i < m.buffered.length; i++) if (m.buffered.start(i) <= t + 0.25 && m.buffered.end(i) > end) end = m.buffered.end(i)
      const dur = Number.isFinite(m.duration) ? m.duration : 0
      const target = Math.max(0.5, Math.min(AHEAD_S, dur ? dur - t : AHEAD_S))
      const ahead = Math.max(0, end - t)
      // Velocidade em segundos de vídeo por segundo de relógio (média móvel): dá o "começa em ~N s".
      const prev = last.current
      let rate = prev?.rate ?? 0
      if (prev && now > prev.at) {
        const r = Math.max(0, (ahead - prev.ahead) / ((now - prev.at) / 1000))
        rate = prev.rate == null ? r : prev.rate * 0.7 + r * 0.3
      }
      last.current = { at: now, ahead, rate }
      const left = Math.max(0, target - ahead)
      setB({ pct: Math.min(1, ahead / target), eta: rate > 0.02 ? left / rate : null, phase: 'carregando' })
    }
    tick()
    const id = setInterval(tick, 300)
    return () => clearInterval(id)
  }, [on])
  return b
}

const etaText = (s) => (s < 1.5 ? 'começando…' : s < 60 ? `começa em ~${Math.ceil(s)} s` : `começa em ~${Math.ceil(s / 60)} min`)

function BufferMark({ b }) {
  const pct = Math.round((b?.pct || 0) * 100)
  const h = 12 * (b?.pct || 0) // altura do enchimento das barras (de 12)
  return html`<div class="mp-buf" role="status" aria-live="polite" aria-label=${b?.phase === 'conectando' ? 'Conectando' : `Carregando ${pct}%`} data-control>
    <svg class="mp-buf-mark" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="0.5" y="0.5" width="23" height="23" rx="7" class="mp-buf-bg" />
      <rect x="7.2" y="4.5" width="3.6" height="12" rx="1.8" class="mp-buf-track is-up" />
      <rect x="13.2" y="7.5" width="3.6" height="12" rx="1.8" class="mp-buf-track is-down" />
      <rect x="7.2" y=${4.5 + 12 - h} width="3.6" height=${h} rx="1.8" class="mp-buf-fill is-up" />
      <rect x="13.2" y="7.5" width="3.6" height=${h} rx="1.8" class="mp-buf-fill is-down" />
      <rect x="7.2" y="4.5" width="3.6" height="3" rx="1.5" class="mp-buf-spark is-up" />
      <rect x="13.2" y="16.5" width="3.6" height="3" rx="1.5" class="mp-buf-spark is-down" />
    </svg>
    <span class="mp-buf-pct tc">${b?.phase === 'conectando' ? '' : `${pct}%`}</span>
    <span class="mp-buf-eta">${b?.phase === 'conectando' ? 'conectando…' : b?.eta != null ? etaText(b.eta) : 'carregando…'}</span>
  </div>`
}

/**
 * kind 'video' | 'audio'. `poster` (miniatura) aparece até o primeiro quadro. onFail(code) quando o navegador não
 * consegue tocar (formato ou rede): quem chama decide o aviso.
 */
export function MediaPlayer({ kind, src, poster, title, ratio, badge, corner, startAt = 0, timeRef, onFail, onStall, autoPlay = false, now, lut = null, corUi = null, onQuadros }) {
  const wrap = useRef(null)
  const media = useRef(null)
  const tela = useRef(null)
  const filtro = useRef(null)
  const [semGl, setSemGl] = useState(false)
  // Tela cheia "de mentira" (iPhone): a tela cheia dele é só do <video>, sem a conversão Rec.709 por cima.
  const [cheio, setCheio] = useState(false)
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
      if (cheio || (lut && !semGl)) return setCheio(!cheio) // Rec.709 ligado: ocupa a tela sem perder a conversão
      if (m?.webkitEnterFullscreen) return m.webkitEnterFullscreen() // iPhone: só o <video> vai para tela cheia
    } catch {
      // sem tela cheia aqui
    }
  }

  // Começa a tocar assim que abre (e já vai carregando: preload auto). Sem som se o navegador barrar o som
  // automático (iPhone sem toque recente): o botão de som fica à mão na barra.
  useEffect(() => {
    const m = media.current
    if (!autoPlay || !m) return
    m.play()?.catch?.((err) => {
      if (err?.name !== 'NotAllowedError' || !media.current) return
      media.current.muted = true
      media.current.play()?.catch?.(() => {})
    })
  }, [src])

  // LOG → Rec.709: o filtro nasce na primeira vez que liga e vive até o player sair.
  useEffect(() => {
    if (kind !== 'video' || (!lut && !filtro.current)) return
    if (!filtro.current) {
      filtro.current = filtroCor(tela.current, media.current)
      if (!filtro.current) return setSemGl(true)
    }
    filtro.current.perfil(lut)
  }, [lut])
  useEffect(() => () => filtro.current?.fechar(), [])

  // Sem metadado de cor: 3 quadros espaçados (≥ 1,5 s de vídeo) para ver se parece LOG; o que tiver em 8 s.
  const quadrosCb = useRef(onQuadros)
  quadrosCb.current = onQuadros
  useEffect(() => {
    const m = media.current
    if (!onQuadros || kind !== 'video' || !m) return undefined
    const qs = []
    let ultimo = -9
    let fim = false
    const entregar = () => {
      fim = true
      if (qs.length) quadrosCb.current?.(qs)
    }
    const pegar = () => {
      if (fim || m.readyState < 2 || (qs.length && Math.abs(m.currentTime - ultimo) < 1.5)) return
      const q = quadroRgb(m)
      if (!q) return
      qs.push(q)
      ultimo = m.currentTime
      if (qs.length >= 3) entregar()
    }
    const evs = ['loadeddata', 'timeupdate', 'seeked']
    for (const e of evs) m.addEventListener(e, pegar)
    const t = setTimeout(() => !fim && entregar(), 8000)
    return () => {
      fim = true
      clearTimeout(t)
      for (const e of evs) m.removeEventListener(e, pegar)
    }
  }, [src, Boolean(onQuadros)])

  // Tela bloqueada: nome do take, pasta e miniatura (os botões de lá comandam este player).
  useEffect(() => (now && media.current ? nowPlaying(now, media.current) : undefined), [src, now?.title, now?.album, now?.art])

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

  // Quer tocar e ainda não dá: autoplay esperando os primeiros dados, ou parou no meio para carregar.
  const buffering = kind === 'video' && ((autoPlay && !s.started && !s.ended) || (s.waiting && (s.playing || !s.started)))
  const buf = useBuffering(media, buffering)

  const Media = kind === 'video' ? 'video' : 'audio'
  const playing = s.playing
  const showTime = scrub != null ? scrub : s.time
  const canFull = kind === 'video'
  return html`<div
    ref=${wrap}
    class=${cx('mp', `mp-${kind}`, ui || !playing ? 'is-ui' : 'is-bare', s.waiting && 'is-waiting', s.started && 'is-started', buf && 'is-buffering', cheio && 'is-cheio')}
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
      preload=${autoPlay ? 'auto' : 'metadata'}
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
    ${kind === 'video' ? html`<canvas ref=${tela} class=${cx('mp-cor', lut && !semGl && 'is-on')} aria-hidden="true"></canvas>` : null}
    ${kind === 'video' && poster && !s.started ? html`<img class="mp-poster" src=${poster} alt="" referrerpolicy="no-referrer" draggable="false" />` : null}
    ${badge ? html`<span class="mp-badge">${badge}</span>` : null}
    ${corner ? html`<div class="mp-corner" data-control>${corner}</div>` : null}
    ${corUi && !semGl ? html`<div class="mp-corner mp-corner-dir" data-control>${corUi}</div>` : null}
    ${kind === 'audio' ? html`<div class="mp-art">${poster ? html`<img src=${poster} alt="" referrerpolicy="no-referrer" draggable="false" />` : html`<span class="mp-art-glyph"><${Icon} name="music" size=${46} strokeWidth=${1.3} /></span>`}</div>` : null}

    ${buf ? html`<${BufferMark} b=${buf} />` : null}
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
              <${Icon} name=${cheio ? 'shrink' : 'expand'} size=${19} />
            </button>`
          : html`<span class="mp-btn" aria-hidden="true"></span>`}
      </div>
    </div>
  </div>`
}
