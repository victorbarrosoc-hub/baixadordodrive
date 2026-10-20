// Prévia de um arquivo do Drive, em tela cheia (como as folhas do iOS): vídeo e áudio no player próprio, foto grande
// com pinça, e os dados do arquivo. Baixar fica no topo. Arrastar para baixo fecha; para o lado, passa de arquivo.
import { html, render, useEffect, useRef, useState } from '../vendor/preact-htm.js'
import { canDownload, driveUrl, findProxy, getFile, isGoogleDoc, isPrevia, kindOf, mayPlay, showsAsImage, target, wantsLite, wantsProxy } from '../lib/browse.js'
import { loadThumb, streamReady, streamUrl } from '../lib/stream.js'
import { linkAccess, openLink, openLinkError } from '../lib/drive.js'
import { nowPlaying, takeName } from '../lib/now-playing.js'
import { bytes, duration, extOf, fullDate } from '../lib/format.js'
import { toast } from '../lib/state.js'
import { isIOS } from '../lib/platform.js'
import { Icon } from './icons.js'
import { Button, cx, reducedMotion } from './ui.js'
import { MediaPlayer } from './player.js'
import { KindGlyph } from './thumb.js'
import { FileName, ShareLink } from './queue.js'
import { PsdPaginas, PsdStage } from './psd.js'
import { podePsd } from '../lib/psd.js'
import { PERFIS_LOG, converte, lembrarPerfil, nomePerfil, pareceLog, perfilLembrado, perfilPelosMetadados } from '../lib/cor.js'

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

/** Referência de vídeo que o app de computador ainda não conferiu para o celular (appProperties.celular). */
const refSemConversao = (f) => f?.appProperties?.sobedesce === 'referencia' && f.appProperties.celular !== 'ok'

const FAIL_TEXT = {
  format: 'Este formato não toca no navegador. Baixe para ver no app de vídeo, ou abra no Drive.',
  // Referência salva antes da conversão (VP9 do Instagram): o app de computador converte sozinho.
  formatRef: 'Este vídeo veio num formato que o iPhone não toca. Com o app SOBEDESCE aberto no computador, ele é convertido sozinho em alguns minutos.',
  // Mesma situação, com a opção de tocar já pelo player do Drive (que converte por conta própria).
  formatRefDrive: 'Este vídeo veio num formato que o iPhone não toca. Dá para tocar já pelo player do Drive, ou esperar o app SOBEDESCE do computador converter.',
  reconnect: 'O Google pediu uma nova autorização. Reconecte o Drive na sua conta.',
  session: 'Sua sessão terminou. Entre de novo para ver a prévia.',
  denied: 'O Google não liberou este arquivo para prévia.',
  gone: 'Não achei este arquivo no Drive. Ele pode ter sido movido.',
  network: 'Não consegui carregar a prévia. Confira a internet.',
  nosw: 'A prévia precisa do app atualizado. Feche e abra o SOBEDESCE de novo.',
}

// ───── vídeo pesado: o player do próprio Drive ─────
//
// O Drive toca rápido porque usa a cópia leve que ele mesmo gera (e se ajusta à internet); a API só entrega o original.
// Vídeo pesado sem proxy, aberto para "qualquer pessoa com o link": a prévia mostra o player do Drive num iframe
// (drive.google.com/file/d/<id>/preview). Fechado: toca o original (o iframe pediria login do Google, que o iPhone não
// leva para dentro do app).

/** Taxa do vídeo em Mbit/s (tamanho / duração); 0 se não dá para saber. */
function mbpsOf(file) {
  const ms = Number(file.videoMediaMetadata?.durationMillis || 0)
  const size = Number(file.size || 0)
  return ms > 0 && size > 0 ? (size * 8) / (ms / 1000) / 1e6 : 0
}
const HEAVY_MBPS = () => (window.matchMedia?.('(pointer: coarse)').matches || window.innerWidth < 768 ? 40 : 200)
const isHeavy = (file) => mbpsOf(file) > HEAVY_MBPS()

/**
 * O player do Drive foi feito para a tela toda: espremido na prévia, os toques caem na engrenagem dele. Então ele abre em
 * tela cheia, fora da prévia (ela tem transform; um nó direto no body), com um X para fechar.
 */
function FullDrive({ file, now, onClose }) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const key = (e) => e.key === 'Escape' && close.current()
    document.addEventListener('keydown', key)
    const clear = now ? nowPlaying(now) : () => {}
    render(
      html`<div class="gfull" role="dialog" aria-modal="true" aria-label=${file.name}>
        <iframe
          src=${`https://drive.google.com/file/d/${encodeURIComponent(file.id)}/preview`}
          title=${file.name}
          allow="autoplay; fullscreen; picture-in-picture"
          allowfullscreen
          referrerpolicy="strict-origin-when-cross-origin"
        ></iframe>
        <button type="button" class="gfull-x" onClick=${() => close.current()} aria-label="Fechar">
          <${Icon} name="x" size=${22} strokeWidth=${2.2} />
        </button>
      </div>`,
      host,
    )
    return () => {
      clear()
      document.removeEventListener('keydown', key)
      render(null, host)
      host.remove()
    }
  }, [file.id])
  return null
}

function DrivePlayer({ file, poster, ratio, now, onOriginal }) {
  const [full, setFull] = useState(false)
  return html`<div class="pv-proxy pv-gdrive">
    <button type="button" class="pv-gposter" style=${ratio ? `aspect-ratio:${ratio}` : ''} onClick=${() => setFull(true)} aria-label=${`Tocar ${file.name}`}>
      ${poster ? html`<img src=${poster} alt="" referrerpolicy="no-referrer" draggable="false" />` : null}
      <span class="mp-big" aria-hidden="true"><${Icon} name="play" size=${30} /></span>
    </button>
    <p class="pv-proxy-note">
      <span>Reprodução em baixa resolução.</span>
      ${onOriginal ? html`<button type="button" class="link-btn pv-gdrive-orig" onClick=${onOriginal}>Tocar o original</button>` : null}
    </p>
    ${full ? html`<${FullDrive} file=${file} now=${now} onClose=${() => setFull(false)} />` : null}
  </div>`
}

/**
 * Referência que o iPhone não toca (VP9 do Instagram, ainda não convertida pelo computador): o player do Drive toca,
 * porque o Google converte por conta própria. Ele só abre dentro do app com o link liberado ("qualquer pessoa com o
 * link", sem aparecer em buscas). Liberar este vídeo ou a coleção inteira (as próximas herdam), sempre com confirmação.
 */
function RefLiberar({ file, onOpen }) {
  const [step, setStep] = useState(null) // null | 'confirm' | 'busy'
  const [err, setErr] = useState(null)
  const colecao = file.parents?.[0] || null
  const liberar = async (id) => {
    setStep('busy')
    setErr(null)
    try {
      await openLink(id)
      window.dispatchEvent(new CustomEvent('sd-link-aberto', { detail: { id: file.id } }))
      onOpen()
    } catch (e) {
      setErr(openLinkError(e))
      setStep('confirm')
    }
  }
  if (!step) return html`<${Button} variant="primary" icon="play" onClick=${() => setStep('confirm')}>Tocar pelo Drive</${Button}>`
  return html`<div class="share-confirm pv-ref-liberar">
    <p>Para tocar aqui, o vídeo precisa estar liberado para <b>quem tiver o link</b>. Ele não aparece em buscas e continua no seu Drive.</p>
    ${err ? html`<p class="share-err" role="alert">${err.text}</p>` : null}
    <div class="share-confirm-acts">
      ${colecao
        ? html`<${Button} variant="primary" size="sm" loading=${step === 'busy'} disabled=${step === 'busy'} onClick=${() => liberar(colecao)}>Liberar a coleção</${Button}>`
        : null}
      <${Button} variant=${colecao ? 'secondary' : 'primary'} size="sm" disabled=${step === 'busy'} onClick=${() => liberar(file.id)}>Só este vídeo</${Button}>
      <${Button} variant="ghost" size="sm" disabled=${step === 'busy'} onClick=${() => (setStep(null), setErr(null))}>Cancelar</${Button}>
    </div>
    ${colecao ? html`<p class="pv-ref-nota">Liberar a coleção vale para todas as referências dela, inclusive as próximas.</p>` : null}
  </div>`
}

/** "Prévia leve | Original" no canto do player (o primeiro diz se é a cópia do app ou o proxy da câmera). */
function LiteSwitch({ proxy, on, canOriginal, onPick }) {
  return html`<div class="mp-switch" role="group" aria-label="O que tocar">
    <button type="button" class=${cx(on && 'is-on')} aria-pressed=${on ? 'true' : 'false'} onClick=${(e) => (e.stopPropagation(), !on && onPick(true))}>
      Proxy
    </button>
    ${canOriginal
      ? html`<button type="button" class=${cx(!on && 'is-on')} aria-pressed=${!on ? 'true' : 'false'} onClick=${(e) => (e.stopPropagation(), on && onPick(false))}>Original</button>`
      : null}
  </div>`
}

/** "Rec.709" no canto do player: liga/desliga a conversão do LOG e escolhe a câmera (só a prévia muda). */
function CorSwitch({ ligado, perfil, doArquivo, onLigar, onPerfil }) {
  return html`<div class=${cx('mp-switch mp-cor-switch', ligado && 'is-on')} role="group" aria-label="Cor da prévia">
    <button type="button" class=${cx(ligado && 'is-on')} aria-pressed=${ligado ? 'true' : 'false'} onClick=${(e) => (e.stopPropagation(), onLigar(!ligado))}>
      <span class="mp-cor-dot" aria-hidden="true"></span>Rec.709
    </button>
    ${ligado
      ? html`<label class="mp-cor-cam">
          <select value=${perfil} aria-label="LOG da câmera" onClick=${(e) => e.stopPropagation()} onChange=${(e) => onPerfil(e.currentTarget.value)}>
            ${PERFIS_LOG.map(([k, p]) => html`<option value=${k}>${p.nome}${doArquivo === k ? ' · do arquivo' : ''}</option>`)}
          </select>
          <span class="mp-cor-nome" aria-hidden="true">${nomePerfil(perfil).replace(/ · .*/, '')}</span>
          <${Icon} name="chevron-down" size=${13} strokeWidth=${2.2} />
        </label>`
      : null}
  </div>`
}

/**
 * Cor da prévia de um vídeo: lê o perfil nos metadados da câmera e, sem eles, pelos quadros que o player manda.
 * `lut` = perfil a aplicar (null = como está); `ui` = o botão; `onQuadros` só enquanto o metadado não decidiu.
 */
function useCor(file, ativo) {
  const [meta, setMeta] = useState(undefined) // undefined = lendo; null = sem metadado; ou o perfil
  const [img, setImg] = useState(null)
  const [escolha, setEscolha] = useState(null) // null = automático; 'off'; ou um perfil
  useEffect(() => {
    setMeta(undefined)
    setImg(null)
    setEscolha(null)
    if (!ativo) return undefined
    const ac = new AbortController()
    perfilPelosMetadados(file, ac.signal).then(
      (p) => !ac.signal.aborted && setMeta(p ?? null),
      () => !ac.signal.aborted && setMeta(null),
    )
    return () => ac.abort()
  }, [file.id, ativo])
  const auto = meta ? (converte(meta) ? meta : null) : meta === null ? img : null
  const lut = escolha === 'off' ? null : escolha || auto
  const ui = ativo
    ? html`<${CorSwitch}
        ligado=${Boolean(lut)}
        perfil=${lut || auto || perfilLembrado()}
        doArquivo=${converte(meta) ? meta : null}
        onLigar=${(on) => setEscolha(on ? auto || perfilLembrado() : 'off')}
        onPerfil=${(p) => (setEscolha(p), lembrarPerfil(p))}
      />`
    : null
  // O metadado disse Rec.709 (ou outro perfil): a imagem não manda. Sem metadado, "parece LOG" vira LOG genérico.
  const onQuadros = ativo && !meta ? (qs) => setImg(pareceLog(qs)) : undefined
  return { lut, ui, onQuadros }
}

function MediaStage({ file, kind, siblings, album, onZoom }) {
  const px = screenPx()
  const poster = useThumb(file, kind === 'image' ? px : Math.min(1600, px))
  const [sw, setSw] = useState(undefined)
  const [fail, setFail] = useState(null)
  // Proxy de câmera: undefined = não precisou; 'look' = procurando; arquivo; null = não achou.
  const [proxy, setProxy] = useState(undefined)
  const [proxyFail, setProxyFail] = useState(false)
  const proxyPoster = useThumb(proxy && proxy !== 'look' ? proxy : { id: '-' }, Math.min(1600, px))
  // Tela bloqueada do celular: o take, a pasta e a miniatura.
  const now = { title: takeName(file.name), album, art: poster || proxyPoster || null }
  const playable = kind === 'video' || kind === 'audio' ? mayPlay(file) : false
  // Vídeo pesado (4K de câmera) toca o original direto, sem aviso: se travar, o player espera carregar.
  const needProxy = kind === 'video' && (fail === 'format' || wantsProxy(file))
  // Cópia leve (vídeo grande, qualquer codec): undefined = não olhou; 'look'; arquivo; null = não tem.
  const lite = kind === 'video' && wantsLite(file)
  const [liteP, setLiteP] = useState(undefined)
  const [liteFail, setLiteFail] = useState(false)
  const [orig, setOrig] = useState(false) // a pessoa tocou em "Original"
  // Vídeo pesado: o arquivo está aberto para qualquer pessoa com o link? (undefined = conferindo). E a pessoa pediu o original?
  const heavy = kind === 'video' && isHeavy(file)
  const [pub, setPub] = useState(undefined)
  const [wantOrig, setWantOrig] = useState(false)
  // Referência que o iPhone não toca: o link dela (ou da coleção) já está liberado? undefined = conferindo.
  const refFmt = kind === 'video' && refSemConversao(file) && (!playable || fail === 'format')
  const [refAcc, setRefAcc] = useState(undefined)
  const at = useRef(0)
  const [startAt, setStartAt] = useState(0)
  const cor = useCor(file, kind === 'video')
  const corProps = { lut: cor.lut, corUi: cor.ui, onQuadros: cor.onQuadros }
  const pick = (leve) => {
    setStartAt(at.current || 0)
    setOrig(!leve)
  }
  useEffect(() => {
    let alive = true
    setFail(null)
    setProxy(undefined)
    setProxyFail(false)
    setLiteP(undefined)
    setLiteFail(false)
    setOrig(false)
    setStartAt(0)
    setPub(undefined)
    setWantOrig(false)
    setRefAcc(undefined)
    streamReady().then((ok) => alive && setSw(ok))
    // Junto com a busca do proxy: o player do Drive só entra se não houver proxy.
    if (kind === 'video' && isHeavy(file)) {
      linkAccess(file.id).then(
        (a) => alive && setPub(a?.open === true),
        () => alive && setPub(false),
      )
    }
    return () => (alive = false)
  }, [file.id])
  useEffect(() => {
    if (!refFmt || refAcc !== undefined) return
    let alive = true
    linkAccess(file.id).then(
      (a) => alive && setRefAcc({ open: a?.open === true, canShare: a?.canShare !== false }),
      () => alive && setRefAcc({ open: false, canShare: true }),
    )
    return () => (alive = false)
  }, [refFmt, file.id])
  useEffect(() => {
    const on = (e) => e.detail?.id === file.id && setPub(true)
    window.addEventListener('sd-link-aberto', on)
    return () => window.removeEventListener('sd-link-aberto', on)
  }, [file.id])
  useEffect(() => {
    if (!lite || !sw || liteP !== undefined) return
    let alive = true
    setLiteP('look')
    findProxy(file, siblings).then(
      (p) => alive && setLiteP(p || null),
      () => alive && setLiteP(null),
    )
    return () => (alive = false)
  }, [lite, sw, file.id])
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

  // Vídeo grande com cópia leve (ou proxy da câmera): toca ela por padrão, fluida; "Original" troca no mesmo ponto.
  if (lite && (sw === undefined || liteP === 'look' || (liteP === undefined && sw))) return html`<div class="pv-wait"><span class="spinner"></span></div>`
  if (lite && liteP && !liteFail) {
    const canOriginal = mayPlay(file)
    const switcher = html`<${LiteSwitch} proxy=${liteP} on=${!orig} canOriginal=${canOriginal} onPick=${pick} />`
    if (!orig || !canOriginal) {
      const vm = liteP.videoMediaMetadata || file.videoMediaMetadata
      const ratio = vm?.width && vm?.height ? `${vm.width} / ${vm.height}` : null
      return html`<div class="pv-proxy">
        <${MediaPlayer}
          key=${'l' + liteP.id}
          kind="video"
          src=${streamUrl(liteP)}
          poster=${poster || null}
          title=${`${file.name} (proxy)`}
          ratio=${ratio}
          corner=${switcher}
          startAt=${startAt}
          timeRef=${at}
          onFail=${() => setLiteFail(true)}
          autoPlay
          now=${now}
          ...${corProps}
        />
        <p class="pv-proxy-note">${isPrevia(liteP) ? 'Proxy (cópia leve 720p), para tocar sem travar. O Baixar traz o original.' : 'Prévia em baixa resolução. O Baixar traz o original.'}</p>
      </div>`
    }
    const vm = file.videoMediaMetadata
    const ratio = vm?.width && vm?.height ? `${vm.width} / ${vm.height}` : null
    return html`<div class="pv-proxy">
      <${MediaPlayer}
        key=${'o' + file.id}
        kind="video"
        src=${streamUrl(file)}
        poster=${poster || null}
        title=${file.name}
        ratio=${ratio}
        corner=${switcher}
        startAt=${startAt}
        timeRef=${at}
        onFail=${() => (setStartAt(at.current || 0), setOrig(false))}
        autoPlay
        now=${now}
        ...${corProps}
      />
      <p class="pv-proxy-note">Original: pode travar se a rede não der conta.</p>
    </div>`
  }

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
        autoPlay
        now=${now}
        ...${corProps}
      />
      <p class="pv-proxy-note">${isPrevia(proxy) ? 'Proxy (cópia leve 720p). O Baixar traz o original.' : 'Prévia em baixa resolução. O Baixar traz o original.'}</p>
    </div>`
  }
  if (kind === 'video' || kind === 'audio') {
    const art = poster || proxyPoster || null
    if (needProxy && (sw === undefined || proxy === 'look' || (proxy === undefined && sw))) return html`<div class="pv-wait"><span class="spinner"></span></div>`
    if (heavy && !wantOrig && fail !== 'format') {
      const vm = file.videoMediaMetadata
      const ratio = vm?.width && vm?.height ? `${vm.width} / ${vm.height}` : null
      if (pub === undefined) return html`<div class="pv-wait"><span class="spinner"></span></div>`
      if (pub) return html`<${DrivePlayer} file=${file} poster=${art} ratio=${ratio} now=${now} onOriginal=${playable ? () => setWantOrig(true) : null} />`
    }
    if (refFmt) {
      const vm = file.videoMediaMetadata
      const ratio = vm?.width && vm?.height ? `${vm.width} / ${vm.height}` : null
      if (refAcc === undefined) return html`<div class="pv-wait"><span class="spinner"></span></div>`
      if (refAcc.open) return html`<${DrivePlayer} file=${file} poster=${art} ratio=${ratio} now=${now} />`
      if (!refAcc.canShare) return html`<${Unsupported} file=${file} poster=${art} reason=${FAIL_TEXT.formatRef} />`
      return html`<${Unsupported} file=${file} poster=${art} reason=${FAIL_TEXT.formatRefDrive}>
        <${RefLiberar} file=${file} onOpen=${() => setRefAcc({ open: true, canShare: true })} />
      </${Unsupported}>`
    }
    if (!playable || fail === 'format') return html`<${Unsupported} file=${file} poster=${art} reason=${FAIL_TEXT.format} />`
    if (sw === false) return html`<${Unsupported} file=${file} poster=${art} reason=${FAIL_TEXT.nosw} />`
    if (fail) return html`<${Unsupported} file=${file} poster=${art} reason=${FAIL_TEXT[fail] || FAIL_TEXT.network} />`
    if (sw === undefined) return html`<div class="pv-wait"><span class="spinner"></span></div>`
    const vm = file.videoMediaMetadata
    const ratio = vm?.width && vm?.height ? `${vm.width} / ${vm.height}` : null
    const player = html`<${MediaPlayer}
      key=${file.id}
      kind=${kind}
      src=${streamUrl(file)}
      poster=${poster || null}
      title=${file.name}
      ratio=${ratio}
      onFail=${async (code) => setFail(code === 3 || code === 4 ? await whyFailed(file) : 'network')}
      autoPlay
      now=${now}
      ...${kind === 'video' ? corProps : {}}
    />`
    return player
  }

  if (kind === 'image') {
    if (podePsd(file)) return html`<${PsdStage} file=${file} poster=${poster} Zoom=${ZoomImage} onZoom=${onZoom} />`
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

export function Preview({ files, index, onIndex, onClose, extra, album }) {
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
              <${MediaStage} file=${file} kind=${kind} siblings=${files} album=${album} onZoom=${setZoomed} />
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
          ${extra ? extra(raw) : null}
          ${podePsd(file) ? html`<${PsdPaginas} key=${file.id} file=${file} />` : null}
          <${Info} file=${file} kind=${kind} />
          <${ShareLink} key=${file.id} id=${file.id} name=${file.name} class="pv-share">
            <a class="btn btn-secondary pv-act" href=${driveUrl(file)} target="_blank" rel="noopener noreferrer">
              <${Icon} name="external" size=${17} /><span>Abrir no Drive</span>
            </a>
          </${ShareLink}>
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
