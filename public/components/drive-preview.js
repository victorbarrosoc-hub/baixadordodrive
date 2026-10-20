// Prévia de arquivos do Drive (como o Quick Look do Mac): vídeo e áudio num player próprio tocando em streaming
// pelo servidor local, foto grande com zoom, metadados para o resto. "Baixar" fica sempre no topo e cria o download
// normal do motor (rápido, retomável). ←/→ passam pelos arquivos da pasta; Esc fecha.
// Formato que o Chromium não toca (BRAW, R3D, MXF, ProRes…): procura o proxy da câmera e toca ele; sem proxy,
// mostra a miniatura grande e "Este formato não toca na prévia".
// Vídeo grande (> 30 MB, qualquer codec): procura antes a cópia leve (Proxy/<nome>.mp4, gerada pelo app ou pela
// câmera) e toca ela, fluida como no Drive; "Original" no canto troca para o arquivo de verdade no mesmo ponto.
// Vídeo em LOG: "Rec.709" no canto direito converte só o que se vê (LUT 3D na placa de vídeo, cor-gl.js). O app lê o
// perfil nos metadados da câmera (ou pela imagem) e já abre convertido; dá para trocar a câmera ou desligar.
import { html, useEffect, useLayoutEffect, useRef, useState } from '/vendor/preact-htm.js'
import { bytes, extOf, fullDate, relTime } from '../lib/format.js'
import { cx } from '../lib/ui.js'
import { toast } from '../lib/toasts.js'
import { copyText } from '../lib/mobile.js'
import { openExternal } from '../lib/desktop.js'
import { driveFileUrl } from '../lib/actions.js'
import { clipTime, findProxy, fullImage, knownProxy, previewKind, proxyWorth, streamUrl, thumbUrl, tryPlayAudio, tryPlayVideo } from '../lib/media.js'
import { isPreviaItem, isVideoName, openProxyArquivo } from './previa.js'
import { withQuery } from '../lib/api.js'
import { PERFIS } from '../lib/cor-lut.js'
import { filtroCor } from '../lib/cor-gl.js'
import { Icon } from './icons.js'
import { Button, IconButton, Spinner, FileIcon } from './common.js'

const SPEEDS = [1, 1.25, 1.5, 2, 0.5]
const KIND_LABEL = { video: 'Vídeo', audio: 'Áudio', image: 'Imagem', other: 'Arquivo' }

// ─────────── player (vídeo e áudio) ───────────

function timecode(sec) {
  return clipTime(sec) || '0:00'
}

/** Acima disso (Mbit/s) o original não toca liso pela rede; o Drive toca uma cópia leve. ProRes 4K passa de 700. */
const HEAVY_MBPS = 400
function mbpsOf(item) {
  const ms = Number(item.video?.durationMs || item.videoMediaMetadata?.durationMillis || 0)
  const size = Number(item.size || 0)
  return ms > 0 && size > 0 ? (size * 8) / (ms / 1000) / 1e6 : 0
}

/** Estado e ações de um <video>/<audio>. */
function useMedia(ref, { onFail }) {
  const [st, setSt] = useState({ playing: false, time: 0, duration: 0, buffered: 0, volume: 1, muted: false, rate: 1, ready: false, waiting: false })
  const frame = useRef(1 / 30)
  const stalled = useRef(false)
  const fail = useRef(onFail)
  fail.current = onFail

  useEffect(() => {
    const m = ref.current
    if (!m) return undefined
    let raf = 0
    const read = () => {
      let buffered = 0
      try {
        for (let i = 0; i < m.buffered.length; i++) if (m.buffered.start(i) <= m.currentTime + 0.5) buffered = Math.max(buffered, m.buffered.end(i))
      } catch {}
      setSt({ playing: !m.paused && !m.ended, time: m.currentTime, duration: Number.isFinite(m.duration) ? m.duration : 0, buffered, volume: m.volume, muted: m.muted, rate: m.playbackRate, ready: m.readyState >= 1, waiting: stalled.current && !m.paused })
    }
    const tick = () => {
      read()
      raf = m.paused ? 0 : requestAnimationFrame(tick)
    }
    const onPlay = () => {
      if (!raf) raf = requestAnimationFrame(tick)
    }
    const onMeta = () => {
      read()
      // Áudio de um vídeo que o Chromium não decodifica (ex.: ProRes): toca som com tela preta. Melhor dizer que não toca.
      if (m.tagName === 'VIDEO' && m.videoWidth === 0 && m.duration > 0) fail.current?.('novideo')
    }
    const onError = () => fail.current?.(m.error?.code === 4 ? 'format' : 'error')
    let stallTimer = 0
    const wait = (on) => () => {
      stalled.current = on
      clearTimeout(stallTimer)
      // Esperando dados por muito tempo com o vídeo tocando: a rede não dá conta do original.
      if (on && m.tagName === 'VIDEO') stallTimer = setTimeout(() => !m.paused && stalled.current && fail.current?.('stall'), 6000)
      read()
    }
    const evs = { play: onPlay, playing: wait(false), pause: read, ended: read, timeupdate: read, durationchange: read, progress: read, volumechange: read, ratechange: read, waiting: wait(true), canplay: wait(false), seeked: wait(false), loadedmetadata: onMeta, error: onError }
    for (const [k, fn] of Object.entries(evs)) m.addEventListener(k, fn)
    // Duração de um quadro (para avançar quadro a quadro): mede pelos quadros apresentados.
    let last = null
    const onFrame = (_, meta) => {
      if (last != null) {
        const d = meta.mediaTime - last
        if (d > 0.004 && d < 0.2) frame.current = d
      }
      last = meta.mediaTime
      if (m.requestVideoFrameCallback && !m.paused) m.requestVideoFrameCallback(onFrame)
    }
    const onPlayFrames = () => m.requestVideoFrameCallback?.(onFrame)
    m.addEventListener('play', onPlayFrames)
    // O <video> começa a carregar no render, antes deste efeito: erro ou metadados podem ter chegado antes dos ouvintes.
    if (m.error) onError()
    else if (m.readyState >= 1) onMeta()
    read()
    return () => {
      clearTimeout(stallTimer)
      cancelAnimationFrame(raf)
      for (const [k, fn] of Object.entries(evs)) m.removeEventListener(k, fn)
      m.removeEventListener('play', onPlayFrames)
    }
  }, [])

  const m = () => ref.current
  const actions = {
    toggle: () => {
      const v = m()
      if (!v) return
      if (v.paused || v.ended) v.play().catch(() => {})
      else v.pause()
    },
    seek: (t) => {
      const v = m()
      if (!v || !Number.isFinite(v.duration)) return
      v.currentTime = Math.max(0, Math.min(v.duration, t))
    },
    nudge: (d) => actions.seek((m()?.currentTime || 0) + d),
    step: (dir) => {
      const v = m()
      if (!v) return
      v.pause()
      actions.seek(v.currentTime + dir * frame.current)
    },
    volume: (x) => {
      const v = m()
      if (!v) return
      v.volume = Math.max(0, Math.min(1, x))
      v.muted = v.volume === 0
    },
    mute: () => {
      const v = m()
      if (v) v.muted = !v.muted
    },
    rate: () => {
      const v = m()
      if (!v) return
      v.playbackRate = SPEEDS[(SPEEDS.indexOf(v.playbackRate) + 1) % SPEEDS.length] || 1
    },
  }
  return [st, actions]
}

function Scrubber({ time, duration, buffered, onSeek }) {
  const ref = useRef(null)
  const [hover, setHover] = useState(null)
  const [drag, setDrag] = useState(false)
  const pos = (e) => {
    const r = ref.current.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
  }
  const pct = duration ? (time / duration) * 100 : 0
  const buf = duration ? Math.min(100, (buffered / duration) * 100) : 0
  return html`<div
    class=${cx('scrub', drag && 'is-drag')}
    ref=${ref}
    role="slider"
    tabindex="0"
    aria-label="Posição"
    aria-valuemin="0"
    aria-valuemax=${Math.round(duration)}
    aria-valuenow=${Math.round(time)}
    aria-valuetext=${`${timecode(time)} de ${timecode(duration)}`}
    onPointerDown=${(e) => {
      if (!duration) return
      e.currentTarget.setPointerCapture(e.pointerId)
      setDrag(true)
      onSeek(pos(e) * duration)
    }}
    onPointerMove=${(e) => {
      if (!duration) return
      const p = pos(e)
      setHover(p)
      if (drag) onSeek(p * duration)
    }}
    onPointerUp=${() => setDrag(false)}
    onPointerCancel=${() => setDrag(false)}
    onPointerLeave=${() => setHover(null)}
    onKeyDown=${(e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        e.stopPropagation()
        onSeek(time + (e.key === 'ArrowRight' ? 5 : -5))
      }
    }}
  >
    <span class="scrub-track"><i class="scrub-buf" style=${`width:${buf}%`}></i><i class="scrub-fill" style=${`width:${pct}%`}></i></span>
    <span class="scrub-knob" style=${`left:${pct}%`}></span>
    ${hover != null && duration ? html`<span class="scrub-tip" style=${`left:${hover * 100}%`}>${timecode(hover * duration)}</span>` : null}
  </div>`
}

function Controls({ st, a, video, onFullscreen, full }) {
  return html`<div class="pctl" onClick=${(e) => e.stopPropagation()} onDblClick=${(e) => e.stopPropagation()}>
    <${Scrubber} time=${st.time} duration=${st.duration} buffered=${st.buffered} onSeek=${a.seek} />
    <div class="pctl-row">
      <button type="button" class="pbtn pbtn-main" onClick=${a.toggle} aria-label=${st.playing ? 'Pausar' : 'Tocar'} title=${st.playing ? 'Pausar (espaço)' : 'Tocar (espaço)'}>
        <${Icon} name=${st.playing ? 'pause-fill' : 'play'} size=${18} />
      </button>
      ${video
        ? html`<button type="button" class="pbtn" onClick=${() => a.step(-1)} aria-label="Quadro anterior" title="Quadro anterior (Alt ←)"><${Icon} name="frame-back" size=${15} /></button>
            <button type="button" class="pbtn" onClick=${() => a.step(1)} aria-label="Próximo quadro" title="Próximo quadro (Alt →)"><${Icon} name="frame-fwd" size=${15} /></button>`
        : null}
      <span class="ptime"><b>${timecode(st.time)}</b> / ${timecode(st.duration)}</span>
      <span class="pspacer"></span>
      <div class="pvol">
        <button type="button" class="pbtn" onClick=${a.mute} aria-label=${st.muted ? 'Ligar o som' : 'Sem som'} title=${st.muted ? 'Ligar o som (M)' : 'Sem som (M)'}>
          <${Icon} name=${st.muted || st.volume === 0 ? 'volume-x' : 'volume'} size=${17} />
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value=${st.muted ? 0 : st.volume}
          aria-label="Volume"
          style=${`--pct:${(st.muted ? 0 : st.volume) * 100}%`}
          onInput=${(e) => a.volume(Number(e.currentTarget.value))}
          onKeyDown=${(e) => e.stopPropagation()}
        />
      </div>
      <button type="button" class="pbtn prate" onClick=${a.rate} aria-label="Velocidade" title="Velocidade">${st.rate}×</button>
      ${onFullscreen
        ? html`<button type="button" class="pbtn" onClick=${onFullscreen} aria-label=${full ? 'Sair da tela cheia' : 'Tela cheia'} title=${full ? 'Sair da tela cheia (F)' : 'Tela cheia (F)'}>
            <${Icon} name=${full ? 'shrink' : 'expand'} size=${16} />
          </button>`
        : null}
    </div>
  </div>`
}

/** Teclas do player. Devolve true quando tratou. */
function playerKeys(e, a, { onFullscreen } = {}) {
  const k = e.key
  if (k === ' ' || k.toLowerCase() === 'k') return a.toggle(), true
  if ((k === 'ArrowLeft' || k === 'ArrowRight') && (e.altKey || e.shiftKey)) {
    const dir = k === 'ArrowRight' ? 1 : -1
    if (e.altKey) a.step(dir)
    else a.nudge(dir * 5)
    return true
  }
  if (k === ',' || k === '.') return a.step(k === '.' ? 1 : -1), true
  if (k.toLowerCase() === 'j' || k.toLowerCase() === 'l') return a.nudge(k.toLowerCase() === 'l' ? 10 : -10), true
  if (k.toLowerCase() === 'm') return a.mute(), true
  if (k.toLowerCase() === 'f' && onFullscreen) return onFullscreen(), true
  return false
}

function VideoPlayer({ src, poster, onFail, keysRef, badge, startAt = 0, timeRef, lut = null, corUi = null }) {
  const vref = useRef(null)
  const box = useRef(null)
  const cref = useRef(null)
  const filtro = useRef(null)
  const [semGl, setSemGl] = useState(false)
  const [st, a] = useMedia(vref, { onFail })
  if (timeRef) timeRef.current = st.time
  const [full, setFull] = useState(false)
  const [idle, setIdle] = useState(false)
  const timer = useRef(0)

  useEffect(() => {
    const v = vref.current
    // Trocou entre a prévia leve e o original: continua do mesmo ponto.
    if (v && startAt > 0) {
      const go = () => (v.currentTime = Math.min(startAt, Number.isFinite(v.duration) ? v.duration : startAt))
      if (v.readyState >= 1) go()
      else v.addEventListener('loadedmetadata', go, { once: true })
    }
    v?.play().catch(() => {}) // abriu por clique ou tecla: o navegador deixa tocar com som
    const onFs = () => setFull(document.fullscreenElement === box.current)
    document.addEventListener('fullscreenchange', onFs)
    return () => {
      document.removeEventListener('fullscreenchange', onFs)
      clearTimeout(timer.current)
      if (document.fullscreenElement === box.current) document.exitFullscreen?.().catch(() => {})
      filtro.current?.fechar()
    }
  }, [])

  // LOG → Rec.709: o filtro nasce na primeira vez que liga e fica até o player fechar.
  useEffect(() => {
    if (!lut && !filtro.current) return
    if (!filtro.current) {
      filtro.current = filtroCor(cref.current, vref.current)
      if (!filtro.current) return setSemGl(true)
    }
    filtro.current.perfil(lut)
  }, [lut])

  const wake = () => {
    setIdle(false)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setIdle(true), 2400)
  }
  const fullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
    else box.current?.requestFullscreen?.().catch(() => {})
  }
  keysRef.current = (e) => {
    const done = playerKeys(e, a, { onFullscreen: fullscreen })
    if (done) wake()
    return done
  }

  return html`<div
    class=${cx('player player-video', st.playing && idle && 'is-idle', !st.playing && 'is-paused')}
    ref=${box}
    onPointerMove=${wake}
    onPointerLeave=${() => st.playing && setIdle(true)}
  >
    <video
      ref=${vref}
      src=${src}
      poster=${poster || undefined}
      preload="auto"
      playsinline
      onClick=${a.toggle}
      onDblClick=${fullscreen}
    ></video>
    <canvas ref=${cref} class=${cx('player-cor', lut && !semGl && 'is-on')} aria-hidden="true"></canvas>
    ${st.waiting && st.ready ? html`<span class="player-wait"><${Spinner} size=${28} /></span>` : null}
    ${!st.ready ? html`<span class="player-wait"><${Spinner} size=${28} /></span>` : null}
    ${!st.playing && st.ready ? html`<button type="button" class="player-bigplay" onClick=${a.toggle} aria-label="Tocar"><${Icon} name="play" size=${30} /></button>` : null}
    ${badge}
    ${semGl ? null : corUi}
    <${Controls} st=${st} a=${a} video onFullscreen=${fullscreen} full=${full} />
  </div>`
}

function AudioPlayer({ src, item, art, onFail, keysRef }) {
  const aref = useRef(null)
  const [st, a] = useMedia(aref, { onFail })
  useEffect(() => {
    aref.current?.play().catch(() => {})
  }, [])
  keysRef.current = (e) => playerKeys(e, a)
  return html`<div class="player player-audio">
    <div class="paudio-art">
      ${art ? html`<img src=${art} alt="" />` : html`<${FileIcon} name=${item.name} mimeType=${item.mimeType} size=${96} />`}
      <span class=${cx('paudio-bars', st.playing && 'is-on')} aria-hidden="true">${[0, 1, 2, 3, 4].map((i) => html`<i style=${`--d:${i * 0.13}s`}></i>`)}</span>
    </div>
    <div class="paudio-name">${item.name}</div>
    <audio ref=${aref} src=${src} preload="auto"></audio>
    <${Controls} st=${st} a=${a} />
  </div>`
}

// ─────────── foto ───────────

function ImageView({ item, low, full }) {
  const [src, setSrc] = useState(low || full)
  const [zoom, setZoom] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const box = useRef(null)
  const drag = useRef(null)
  useEffect(() => {
    if (!full || full === src) return undefined
    // A miniatura grande aparece na hora; o original (JPG/PNG/WebP) troca quando chegar.
    const img = new Image()
    img.onload = () => setSrc(full)
    img.src = full
    return () => (img.onload = null)
  }, [full])
  if (!src) return html`<${Other} item=${item} />`
  const toggle = (e) => {
    if (drag.current?.moved) return
    const el = box.current
    const r = el.getBoundingClientRect()
    const fx = (e.clientX - r.left) / r.width
    const fy = (e.clientY - r.top) / r.height
    setZoom((z) => !z)
    requestAnimationFrame(() => {
      if (!el) return
      el.scrollLeft = fx * el.scrollWidth - r.width / 2
      el.scrollTop = fy * el.scrollHeight - r.height / 2
    })
  }
  return html`<div class="pimage-wrap"><div
    class=${cx('pimage', zoom && 'is-zoom', loaded && 'is-loaded')}
    ref=${box}
    onPointerDown=${(e) => {
      if (!zoom) return
      drag.current = { x: e.clientX, y: e.clientY, l: box.current.scrollLeft, t: box.current.scrollTop, moved: false }
    }}
    onPointerMove=${(e) => {
      const d = drag.current
      if (!d || !(e.buttons & 1)) return
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true
      box.current.scrollLeft = d.l - (e.clientX - d.x)
      box.current.scrollTop = d.t - (e.clientY - d.y)
    }}
    onPointerUp=${() => setTimeout(() => (drag.current = null), 0)}
  >
    <img src=${src} alt=${item.name} draggable="false" onLoad=${() => setLoaded(true)} onClick=${toggle} />
  </div>
    <button type="button" class="pzoom" onClick=${() => setZoom((z) => !z)} aria-label=${zoom ? 'Ajustar à tela' : 'Ampliar'} title=${zoom ? 'Ajustar à tela' : 'Ampliar'}>
      <${Icon} name=${zoom ? 'zoom-out' : 'zoom-in'} size=${16} />
    </button>
  </div>`
}

// ─────────── sem prévia ───────────

function Other({ item, poster, title, text, actions }) {
  return html`<div class=${cx('pother', poster && 'has-poster')}>
    ${poster ? html`<img class="pother-poster" src=${poster} alt="" />` : html`<${FileIcon} name=${item.name} mimeType=${item.mimeType} size=${112} />`}
    <div class="pother-text">
      <b>${title || 'Sem prévia para este tipo de arquivo'}</b>
      <span>${text || 'Baixe para abrir no programa certo.'}</span>
    </div>
    ${actions || null}
  </div>`
}

// ─────────── conteúdo de um item ───────────

/** Acima disso (bytes) a prévia procura antes a cópia leve, mesmo que o original toque. */
const LITE_MIN = 30e6

/** Botões "Prévia leve | Original" no canto do player (o selo diz se é a nossa cópia ou o proxy da câmera). */
function LiteSwitch({ proxy, on, canOriginal, onPick }) {
  const label = 'Proxy'
  return html`<div class="lite-switch" role="group" aria-label="O que tocar" onClick=${(e) => e.stopPropagation()} onDblClick=${(e) => e.stopPropagation()}>
    <button type="button" class=${cx(on && 'is-on')} aria-pressed=${on ? 'true' : 'false'} onClick=${() => !on && onPick(true)} title=${isPreviaItem(proxy) ? 'Proxy (cópia leve 720p): toca fluido' : 'Proxy da câmera: toca fluido'}>${label}</button>
    ${canOriginal ? html`<button type="button" class=${cx(!on && 'is-on')} aria-pressed=${!on ? 'true' : 'false'} onClick=${() => on && onPick(false)} title="Tocar o arquivo original (pesado: pode travar pela rede)">Original</button>` : null}
  </div>`
}

const lembrado = () => {
  try {
    const p = localStorage.getItem('previa.perfil')
    return PERFIS[p]?.curva ? p : 'slog3-cine'
  } catch {
    return 'slog3-cine'
  }
}

/** "Rec.709" no canto do player: liga/desliga a conversão e escolhe o LOG da câmera. */
function CorSwitch({ ligado, perfil, detectado, onLigar, onPerfil }) {
  const nome = PERFIS[perfil]?.nome || 'LOG'
  return html`<div class=${cx('cor-switch', ligado && 'is-on')} onClick=${(e) => e.stopPropagation()} onDblClick=${(e) => e.stopPropagation()}>
    <button
      type="button"
      aria-pressed=${ligado ? 'true' : 'false'}
      onClick=${() => onLigar(!ligado)}
      title=${ligado ? `Vendo em Rec.709, convertido de ${nome}. Só a prévia muda; o arquivo fica como está.` : 'Gravou em LOG? Veja em Rec.709 (só a prévia muda)'}
    >
      <span class="cor-dot"></span>Rec.709
    </button>
    ${ligado
      ? html`<select value=${perfil} aria-label="LOG da câmera" onChange=${(e) => onPerfil(e.currentTarget.value)} onKeyDown=${(e) => e.stopPropagation()}>
          ${Object.entries(PERFIS)
            .filter(([, p]) => p.curva)
            .map(([k, p]) => html`<option value=${k}>${p.nome}${detectado === k ? ' · do arquivo' : ''}</option>`)}
        </select>`
      : null}
  </div>`
}

/** Escolhe o que mostrar: cópia leve, original, proxy (procura quando o original não toca) ou "não toca". */
function Content({ accountId, item, keysRef, onDownload, inicio = 0 }) {
  const kind = previewKind(item)
  const ext = extOf(item.name).toUpperCase()
  const original = streamUrl(accountId, item)
  // Pesado: taxa (tamanho/duração) alta demais para tocar pela rede, ou travou tocando.
  const [heavy, setHeavy] = useState(() => kind === 'video' && mbpsOf(item) > HEAVY_MBPS)
  const known = knownProxy(accountId, item.id)
  // Vídeo grande: a cópia leve primeiro ('lite-look' procura; 'lite' toca). Sem cópia, segue as regras de antes.
  const wantsLite = kind === 'video' && Number(item.size || 0) > LITE_MIN && !isPreviaItem(item)
  const baseMode = () => {
    if (kind === 'video') return tryPlayVideo(item) && !(mbpsOf(item) > HEAVY_MBPS) ? 'play' : 'proxy'
    if (kind === 'audio') return tryPlayAudio(item) ? 'play' : 'fail'
    return 'show'
  }
  const [mode, setMode] = useState(() => (wantsLite ? (known ? 'lite' : known === null ? baseMode() : 'lite-look') : baseMode()))
  const [proxy, setProxy] = useState(() => known ?? undefined)
  const [forced, setForced] = useState(false)
  const at = useRef(inicio) // onde o player estava (para trocar entre leve e original no mesmo ponto)
  const [startAt, setStartAt] = useState(inicio) // `inicio`: abriu de um resultado da busca por cena
  const pick = (lite) => {
    setStartAt(at.current || 0)
    if (lite) setMode('lite')
    else {
      setForced(true)
      setMode('play')
    }
  }

  useEffect(() => {
    if (mode !== 'lite-look') return undefined
    let alive = true
    findProxy(accountId, item).then((p) => {
      if (!alive) return
      setProxy(p)
      setMode(p ? 'lite' : baseMode())
    })
    return () => {
      alive = false
    }
  }, [mode])

  useEffect(() => {
    if (mode !== 'proxy') return undefined
    let alive = true
    if (!proxyWorth(item) && !heavy) {
      setMode('fail')
      return undefined
    }
    findProxy(accountId, item).then((p) => {
      if (!alive) return
      setProxy(p)
      // Formato que o navegador nunca toca (BRAW, R3D…) é 'fail' mesmo pesado: "Tentar mesmo assim" não teria como dar certo.
      setMode(p ? 'proxy-play' : heavy && tryPlayVideo(item) ? 'heavy' : 'fail')
    })
    return () => {
      alive = false
    }
  }, [mode])

  // Perfil de cor do original (o proxy da câmera grava no mesmo LOG). null = automático; 'off' = desligado.
  const [corAuto, setCorAuto] = useState(null)
  const [corEscolha, setCorEscolha] = useState(null)
  useEffect(() => {
    if (kind !== 'video' || !accountId) return undefined
    const ac = new AbortController()
    fetch(withQuery('/api/cor/perfil', { accountId, fileId: item.id }), { headers: { accept: 'application/json' }, cache: 'no-store', signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((r) => r?.perfil && setCorAuto({ perfil: r.perfil, origem: r.origem }))
      .catch(() => {})
    return () => ac.abort()
  }, [])
  const perfilAuto = PERFIS[corAuto?.perfil]?.curva ? corAuto.perfil : null
  const lut = corEscolha === 'off' ? null : corEscolha || perfilAuto
  const corUi =
    kind === 'video'
      ? html`<${CorSwitch}
          ligado=${!!lut}
          perfil=${lut || perfilAuto || lembrado()}
          detectado=${corAuto?.origem === 'metadados' ? corAuto.perfil : null}
          onLigar=${(on) => setCorEscolha(on ? perfilAuto || lembrado() : 'off')}
          onPerfil=${(p) => {
            setCorEscolha(p)
            try {
              localStorage.setItem('previa.perfil', p)
            } catch {}
          }}
        />`
      : null

  const bigPoster = thumbUrl(accountId, item, 1600) || (proxy ? thumbUrl(accountId, proxy, 1600) : null)
  keysRef.current = null

  if (kind === 'video' && mode === 'lite' && proxy) {
    return html`<${VideoPlayer}
      key=${'l' + proxy.id}
      src=${streamUrl(accountId, proxy)}
      poster=${thumbUrl(accountId, item, 1280) || thumbUrl(accountId, proxy, 1280)}
      keysRef=${keysRef}
      startAt=${startAt}
      timeRef=${at}
      lut=${lut}
      corUi=${corUi}
      onFail=${(why) => why !== 'stall' && setMode(baseMode())}
      badge=${html`<${LiteSwitch} proxy=${proxy} on=${true} canOriginal=${tryPlayVideo(item)} onPick=${pick} />`}
    />`
  }
  if (kind === 'video' && mode === 'lite-look') {
    return html`<div class="pother has-poster">
      ${bigPoster ? html`<img class="pother-poster" src=${bigPoster} alt="" />` : html`<${FileIcon} name=${item.name} mimeType=${item.mimeType} size=${112} />`}
      <div class="pother-text"><span class="pwait"><${Spinner} size=${14} /> Procurando o proxy…</span></div>
    </div>`
  }
  if (kind === 'video' && mode === 'play') {
    return html`<${VideoPlayer}
      key=${'o' + item.id}
      src=${original}
      poster=${thumbUrl(accountId, item, 1280)}
      keysRef=${keysRef}
      startAt=${startAt}
      timeRef=${at}
      lut=${lut}
      corUi=${corUi}
      badge=${wantsLite && proxy ? html`<${LiteSwitch} proxy=${proxy} on=${false} canOriginal=${true} onPick=${pick} />` : null}
      onFail=${(why) => {
        if (why === 'stall') {
          if (forced) return
          setHeavy(true)
        }
        setMode('proxy')
      }}
    />`
  }
  if (kind === 'video' && mode === 'proxy-play' && proxy) {
    return html`<${VideoPlayer}
      key=${'p' + proxy.id}
      src=${streamUrl(accountId, proxy)}
      poster=${thumbUrl(accountId, proxy, 1280) || thumbUrl(accountId, item, 1280)}
      keysRef=${keysRef}
      lut=${lut}
      corUi=${corUi}
      onFail=${(why) => why !== 'stall' && setMode('fail')}
      badge=${isPreviaItem(proxy)
        ? html`<div class="proxy-note"><span class="proxy-tag is-previa">Proxy</span><span>Cópia leve em 720p. O Baixar traz o original.</span></div>`
        : html`<div class="proxy-note"><span class="proxy-tag">Proxy</span><span>Prévia em baixa resolução. O Baixar traz o original.</span></div>`}
    />`
  }
  if (kind === 'video' && mode === 'proxy') {
    return html`<div class="pother has-poster">
      ${bigPoster ? html`<img class="pother-poster" src=${bigPoster} alt="" />` : html`<${FileIcon} name=${item.name} mimeType=${item.mimeType} size=${112} />`}
      <div class="pother-text"><span class="pwait"><${Spinner} size=${14} /> Procurando o proxy da câmera…</span></div>
    </div>`
  }
  // Sem proxy para tocar: gerar um aqui mesmo (cópia leve 720p na pasta Proxy) ou baixar o original.
  // RAW de câmera (BRAW, R3D…) fica de fora: o ffmpeg não decodifica; o proxy dele é o que a câmera grava.
  const gerar = kind === 'video' && isVideoName(item.name) && !isPreviaItem(item) && !proxy
    ? html`<${Button} variant="secondary" icon="film" onClick=${() => openProxyArquivo({ accountId, item })} title="Proxy (cópia leve 720p, na pasta Proxy) para a prévia tocar fluida">Gerar proxy</${Button}>`
    : null
  const sizeText = `${ext || 'Arquivo'}${item.size != null ? ` · ${bytes(item.size)}` : ''}`
  if (kind === 'video' && mode === 'heavy') {
    return html`<${Other}
      item=${item}
      poster=${bigPoster}
      title="Vídeo pesado demais para tocar pela rede"
      text=${`${sizeText}. Gere um proxy para a prévia tocar fluida, ou baixe o original.`}
      actions=${html`<div class="pother-acts">
        <${Button} variant="primary" class="btn-down" icon="download" onClick=${onDownload}>Baixar original</${Button}>
        ${gerar}
        <${Button}
          variant="ghost"
          onClick=${() => {
            setForced(true)
            setMode('play')
          }}
          >Tentar mesmo assim</${Button}
        >
      </div>`}
    />`
  }
  if ((kind === 'video' || kind === 'audio') && mode === 'fail') {
    return html`<${Other}
      item=${item}
      poster=${bigPoster}
      title="Este formato não toca na prévia"
      text=${gerar
        ? `${sizeText}. Gere um proxy para ver aqui, ou baixe o original para abrir no seu editor.`
        : kind === 'video' && !isVideoName(item.name)
          ? `${sizeText}. RAW de câmera: a prévia toca o proxy da câmera quando ele está no Drive. Baixe o original para abrir no seu editor.`
          : `${sizeText}. Baixe para abrir no seu editor.`}
      actions=${html`<div class="pother-acts">
        <${Button} variant="primary" class="btn-down" icon="download" onClick=${onDownload}>Baixar original</${Button}>
        ${gerar}
      </div>`}
    />`
  }
  if (kind === 'audio') {
    return html`<${AudioPlayer} key=${item.id} src=${original} item=${item} art=${thumbUrl(accountId, item, 640)} keysRef=${keysRef} onFail=${() => setMode('fail')} />`
  }
  if (kind === 'image') {
    return html`<${ImageView} key=${item.id} item=${item} low=${thumbUrl(accountId, item, 2000)} full=${fullImage(item) ? original : null} />`
  }
  return html`<${Other} item=${item} poster=${thumbUrl(accountId, item, 1600)} title=${item.isGoogleDoc ? 'Documento do Google' : undefined} text=${item.isGoogleDoc ? 'Ao baixar, vira arquivo do Office (.docx, .xlsx, .pptx).' : undefined} />`
}

// ─────────── informações ───────────

function infoRows(item) {
  const rows = []
  const kind = previewKind(item)
  const ext = extOf(item.name).toUpperCase()
  rows.push(['Tipo', item.isGoogleDoc ? 'Documento do Google' : `${KIND_LABEL[kind]}${ext ? ` ${ext}` : ''}`])
  if (item.size != null) rows.push(['Tamanho', bytes(item.size)])
  const v = item.video
  const im = item.image
  const w = v?.width || im?.width
  const h = v?.height || im?.height
  if (w && h) rows.push(['Resolução', `${w} × ${h}`])
  if (v?.durationMs) rows.push(['Duração', clipTime(v.durationMs / 1000)])
  if (im?.camera) rows.push(['Câmera', im.camera])
  const expo = [im?.exposureTime ? (im.exposureTime < 1 ? `1/${Math.round(1 / im.exposureTime)} s` : `${im.exposureTime} s`) : null, im?.aperture ? `f/${im.aperture}` : null, im?.isoSpeed ? `ISO ${im.isoSpeed}` : null, im?.focalLength ? `${im.focalLength} mm` : null].filter(Boolean)
  if (expo.length) rows.push(['Exposição', expo.join(' · ')])
  if (item.modifiedTime) rows.push(['Modificado', fullDate(item.modifiedTime)])
  if (item.owner?.name || item.owner?.email) rows.push(['Dono', item.owner.name || item.owner.email])
  return rows
}

// ─────────── janela ───────────

/**
 * @param {{ accountId: string, items: any[], index: number, onIndex: (i:number)=>void, onClose: ()=>void,
 *           onDownload: (item)=>Promise<boolean>, dest: string, destLabel?: string, onChangeDest: ()=>void,
 *           extra?: (item)=>any, inicioDe?: (item)=>number }} props   `extra`: bloco a mais no painel de informações
 *           (Referências: origem, autor, legenda); `inicioDe`: em que segundo o vídeo começa (busca por cena)
 */
export function DrivePreview({ accountId, items, index, onIndex, onClose, onDownload, dest, destLabel, onChangeDest, extra, inicioDe }) {
  const item = items[index]
  const root = useRef(null)
  const keys = useRef(null)
  const [busy, setBusy] = useState(false)
  const [queued, setQueued] = useState(null) // id que acabou de ir para a fila

  useLayoutEffect(() => {
    const opener = document.activeElement
    root.current?.focus({ preventScroll: true })
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
      try {
        if (opener && document.contains(opener)) opener.focus({ preventScroll: true })
      } catch {}
    }
  }, [])

  if (!item) return null
  const link = item.webViewLink || driveFileUrl(item.id)
  const hasPrev = index > 0
  const hasNext = index < items.length - 1

  const download = async () => {
    if (busy) return
    setBusy(true)
    const ok = await onDownload(item)
    setBusy(false)
    if (ok) {
      setQueued(item.id)
      setTimeout(() => setQueued((q) => (q === item.id ? null : q)), 2600)
    }
  }

  const copy = async () => {
    const ok = await copyText(link)
    toast(ok ? 'success' : 'error', ok ? 'Link copiado.' : 'Não consegui copiar o link.')
  }

  const onKeyDown = (e) => {
    const t = e.target
    if (t?.tagName === 'INPUT' || t?.tagName === 'SELECT' || t?.tagName === 'TEXTAREA') return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (document.fullscreenElement) return
      return onClose()
    }
    if (e.metaKey || e.ctrlKey) return
    if (keys.current?.(e)) {
      e.preventDefault()
      return
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const n = index + (e.key === 'ArrowRight' ? 1 : -1)
      if (n >= 0 && n < items.length) onIndex(n)
      return
    }
    if (e.key === ' ' && t?.tagName !== 'BUTTON') {
      // como o Quick Look: espaço fecha (no player, tocar/pausar já foi tratado acima)
      e.preventDefault()
      onClose()
    }
  }

  const meta = [item.size != null ? bytes(item.size) : null, KIND_LABEL[previewKind(item)], item.modifiedTime ? relTime(item.modifiedTime) : null].filter(Boolean).join(' · ')
  const rows = infoRows(item)

  return html`<div class="qlook-backdrop" onMouseDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="qlook" role="dialog" aria-modal="true" aria-label=${`Prévia de ${item.name}`} tabindex="-1" ref=${root} onKeyDown=${onKeyDown}>
      <header class="qlook-head">
        <div class="qlook-title">
          <${FileIcon} name=${item.name} mimeType=${item.mimeType} size=${30} />
          <div class="qlook-titles">
            <h2 title=${item.name}>${item.name}</h2>
            <p>${meta}</p>
          </div>
        </div>
        <div class="qlook-actions">
          <span class="qlook-count" aria-live="polite">${index + 1} de ${items.length}</span>
          <${IconButton} icon="link" label="Copiar link" onClick=${copy} />
          <${IconButton} icon="external" label="Abrir no Drive" onClick=${() => openExternal(link)} />
          <button type="button" class="dest-chip qlook-dest" onClick=${onChangeDest} title=${`Baixar em ${dest}`}>
            <${Icon} name="folder" size=${14} />
            <span class="dest-label">Para</span>
            <span class="dest-name">${destLabel || dest || 'Escolher…'}</span>
          </button>
          <${Button} variant="primary" class=${cx('btn-down', queued === item.id && 'is-done')} icon=${queued === item.id ? 'check' : 'download'} loading=${busy} onClick=${download}>
            ${queued === item.id ? 'Na fila' : 'Baixar'}
          </${Button}>
          <${IconButton} icon="x" label="Fechar (Esc)" onClick=${onClose} class="qlook-close" />
        </div>
      </header>
      <div class="qlook-main">
        <div class="qlook-stage">
          <${Content} key=${`${item.id}:${inicioDe?.(item) || 0}`} accountId=${accountId} item=${item} keysRef=${keys} onDownload=${download} inicio=${inicioDe?.(item) || 0} />
          ${hasPrev ? html`<button type="button" class="qlook-nav is-prev" onClick=${() => onIndex(index - 1)} aria-label="Anterior" title="Anterior (←)"><${Icon} name="chevron-left" size=${20} /></button>` : null}
          ${hasNext ? html`<button type="button" class="qlook-nav is-next" onClick=${() => onIndex(index + 1)} aria-label="Próximo" title="Próximo (→)"><${Icon} name="chevron-right" size=${20} /></button>` : null}
        </div>
        <aside class="qlook-info" aria-label="Informações">
          ${typeof extra === 'function' ? extra(item) : null}
          <dl>
            ${rows.map(([k, v]) => html`<div class="qrow"><dt>${k}</dt><dd>${v}</dd></div>`)}
          </dl>
          <p class="qlook-keys">
            <span><kbd class="kbd">←</kbd> <kbd class="kbd">→</kbd> outro arquivo</span>
            ${previewKind(item) === 'video' || previewKind(item) === 'audio' ? html`<span><kbd class="kbd">espaço</kbd> tocar ou pausar</span>` : null}
            ${previewKind(item) === 'video' ? html`<span><kbd class="kbd">Alt ←→</kbd> quadro a quadro</span><span><kbd class="kbd">Shift ←→</kbd> 5 segundos</span>` : null}
            <span><kbd class="kbd">Esc</kbd> fechar</span>
          </p>
        </aside>
      </div>
    </div>
  </div>`
}
