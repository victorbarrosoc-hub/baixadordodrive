// Medidor ao vivo: leitura grande de ↓/↑ e o gráfico dos últimos 2 minutos desenhado como uma
// forma de onda estéreo — download acima da linha central (azul), upload espelhado abaixo (violeta).
import { html, useMemo } from '/vendor/preact-htm.js'
import { useStore } from '../lib/store.js'
import { aprox, bits, bytes, clock, plural, speedParts } from '../lib/format.js'
import { Icon } from './icons.js'
import { Button } from './common.js'
import { cx, memo } from '../lib/ui.js'
import { transferAction } from '../lib/actions.js'
import { meterTotals } from '../lib/transferencias.js'

const W = 1200
const H = 168
const MID = H / 2
const AMP = MID - 10
const SPAN = 120

const NICE = [1, 2, 5, 10, 20, 25, 50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 5000, 10000].map((x) => x * 1e6)

function niceMax(v) {
  for (const n of NICE) if (v <= n * 0.92) return n
  return Math.ceil(v / 1e9) * 1e9
}

/** Curva monotônica (como d3.curveMonotoneX): suave e sem "passar" da linha central. */
function monotone(pts) {
  const n = pts.length
  if (n < 2) return ''
  const sign = (x) => (x < 0 ? -1 : 1)
  const slope = (i) => (pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0] || 1)
  const t = new Array(n)
  t[0] = slope(0)
  t[n - 1] = slope(n - 2)
  for (let i = 1; i < n - 1; i++) {
    const h0 = pts[i][0] - pts[i - 1][0]
    const h1 = pts[i + 1][0] - pts[i][0]
    const s0 = slope(i - 1)
    const s1 = slope(i)
    const p = (s0 * h1 + s1 * h0) / (h0 + h1)
    t[i] = (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(2)}`
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[i + 1]
    const dx = (x1 - x0) / 3
    d += `C${(x0 + dx).toFixed(1)},${(y0 + dx * t[i]).toFixed(2)},${(x1 - dx).toFixed(1)},${(y1 - dx * t[i + 1]).toFixed(2)},${x1.toFixed(1)},${y1.toFixed(2)}`
  }
  return d
}

function buildPaths(history) {
  const pts = history.slice(-SPAN)
  const offset = SPAN - pts.length
  let max = 0
  for (const p of pts) max = Math.max(max, p.down || 0, p.up || 0)
  const top = niceMax(Math.max(max, 1e6))
  const x = (i) => ((i + offset) / (SPAN - 1)) * W
  const down = pts.map((p, i) => [x(i), MID - ((p.down || 0) / top) * AMP])
  const up = pts.map((p, i) => [x(i), MID + ((p.up || 0) / top) * AMP])
  if (pts.length === 1) {
    down.unshift([0, down[0][1]])
    up.unshift([0, up[0][1]])
  }
  const area = (line, first) => `${line}L${W},${MID}L${first[0].toFixed(1)},${MID}Z`
  const dLine = monotone(down)
  const uLine = monotone(up)
  const last = pts[pts.length - 1] || { down: 0, up: 0 }
  return {
    top,
    dLine,
    uLine,
    dArea: dLine ? area(dLine, down[0]) : '',
    uArea: uLine ? area(uLine, up[0]) : '',
    lastDown: last.down ? ((last.down || 0) / top) * AMP : null,
    lastUp: last.up ? ((last.up || 0) / top) * AMP : null,
  }
}

export function Waveform({ history }) {
  const p = useMemo(() => buildPaths(history || []), [history])
  const scale = bytes(p.top).replace(/ /, ' ') + '/s'
  return html`<div class="wave">
    <div class="wave-plot">
    <svg class="wave-svg" viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="wg-down" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style="stop-color:var(--down);stop-opacity:var(--wave-fill, .34)" />
          <stop offset="1" style="stop-color:var(--down);stop-opacity:.02" />
        </linearGradient>
        <linearGradient id="wg-up" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" style="stop-color:var(--up);stop-opacity:var(--wave-fill, .34)" />
          <stop offset="1" style="stop-color:var(--up);stop-opacity:.02" />
        </linearGradient>
        <linearGradient id="wg-fade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#fff" stop-opacity="0" />
          <stop offset="0.12" stop-color="#fff" stop-opacity="1" />
        </linearGradient>
        <mask id="wg-mask"><rect x="0" y="0" width=${W} height=${H} fill="url(#wg-fade)" /></mask>
      </defs>
      ${[0.25, 0.5, 0.75].map((f) => html`<line class="wave-grid" x1=${W * f} x2=${W * f} y1="6" y2=${H - 6} vector-effect="non-scaling-stroke" />`)}
      <g mask="url(#wg-mask)">
        <path d=${p.dArea} fill="url(#wg-down)" />
        <path d=${p.uArea} fill="url(#wg-up)" />
        <path d=${p.dLine} class="wave-line wave-line-down" vector-effect="non-scaling-stroke" />
        <path d=${p.uLine} class="wave-line wave-line-up" vector-effect="non-scaling-stroke" />
      </g>
      <line class="wave-axis" x1="0" x2=${W} y1=${MID} y2=${MID} vector-effect="non-scaling-stroke" />
    </svg>
    ${p.lastDown != null ? html`<span class="wave-dot wave-dot-down" style=${`top:${((MID - p.lastDown) / H) * 100}%`}></span>` : null}
    ${p.lastUp != null ? html`<span class="wave-dot wave-dot-up" style=${`top:${((MID + p.lastUp) / H) * 100}%`}></span>` : null}
    <span class="wave-scale wave-scale-top">${scale}</span>
    <span class="wave-scale wave-scale-bottom">${scale}</span>
    </div>
    <div class="wave-ruler" aria-hidden="true">
      <span>−2:00</span><span>−1:30</span><span>−1:00</span><span>−0:30</span><span>agora</span>
    </div>
  </div>`
}

function Readout({ dir, data }) {
  const s = speedParts(data.speed)
  const idle = !data.speed
  const n = data.active || 0
  const label = dir === 'down' ? 'Baixando' : 'Enviando'
  return html`<div class=${cx('readout', `readout-${dir}`, idle && 'is-idle')}>
    <div class="readout-label">
      <span class="readout-badge"><${Icon} name=${dir === 'down' ? 'arrow-down' : 'arrow-up'} size=${13} strokeWidth=${2} /></span>
      ${label}
    </div>
    <div class="readout-value"><span class="num">${s.value}</span><span class="unit">${s.unit}</span></div>
    <div class="readout-sub">
      ${idle ? (data.queued ? `${plural(data.queued, 'arquivo', 'arquivos')} na fila` : 'Em silêncio') : html`${bits(data.speed)} · ${plural(n, 'arquivo', 'arquivos')}`}
    </div>
  </div>`
}

/**
 * Cabeçalho da tela de transferências. Assina `stats` sozinho (2×/s) para não re-renderizar a lista.
 * Props vêm da lista (mudam só quando as transferências mudam).
 */
export const MeterHero = memo(function MeterHero({ doneCount, totalCount, canPause, canResume }) {
  const stats = useStore((s) => s.stats)
  const lost = useStore((s) => s.conn === 'lost')
  const tot = meterTotals(stats.totals)
  const moving = (stats.down?.speed || 0) + (stats.up?.speed || 0) > 0
  const eta = moving && tot.moving > 0 ? stats.eta : null
  return html`<section class=${cx('hero card', lost && 'is-stale')} aria-label="Velocidade agora" title=${lost ? 'Sem contato com o motor — os números podem estar desatualizados' : undefined}>
    <div class="hero-top">
      <${Readout} dir="down" data=${stats.down || {}} />
      <${Readout} dir="up" data=${stats.up || {}} />
      <div class="hero-actions">
        ${canPause ? html`<${Button} icon="pause" onClick=${() => transferAction('pause', 'all')}>Pausar tudo</${Button}>` : null}
        ${canResume ? html`<${Button} variant=${canPause ? 'secondary' : 'primary'} icon="play" onClick=${() => transferAction('resume', 'all')}>Retomar tudo</${Button}>` : null}
      </div>
    </div>
    <${Waveform} history=${stats.history} />
    <div class="hero-foot">
      <div class="hero-totals">
        ${totalCount
          ? html`<span><b>${doneCount}</b> de ${plural(totalCount, 'arquivo', 'arquivos')}</span>
              ${tot.moving > 0 || !tot.parked
                ? html`<span class="dot-sep"></span><span><b>${bytes(tot.moving)}</b> ${tot.parked ? 'andando' : 'restantes'}</span>`
                : null}
              ${tot.parked
                ? html`<span class="dot-sep"></span><span class="hero-parked" title="Pausados e com problema não andam sozinhos: não entram no tempo que falta">
                    <b>${bytes(tot.parked)}</b> ${tot.parkedCount === 1 ? 'parado' : 'parados'}${tot.problems ? html` <span class="tone-warning">(${tot.problems} com problema)</span>` : null}
                  </span>`
                : null}
              ${eta != null
                ? html`<span class="dot-sep"></span><span title=${`Termina por volta de ${clock(Date.now() + eta * 1000)}`}>faltam <b>${aprox(eta)}</b>${eta >= 600 ? html`<span class="hero-clock"> · ${endsAt(eta)}</span>` : null}</span>`
                : null}`
          : html`<span>Tudo em dia por aqui</span>`}
      </div>
      <${DailyUpload} usage=${stats.usage} />
      ${stats.keepAwake
        ? html`<span class="hero-awake" title="Enquanto houver transferência, o computador não dorme"><${Icon} name="coffee" size=${14} /> Mantendo o computador acordado</span>`
        : null}
    </div>
  </section>`
})

/** "termina ~14:32" ou "termina amanhã ~09:10". */
function endsAt(eta) {
  const c = clock(Date.now() + eta * 1000)
  return c.includes(' às ') ? `termina ${c.replace(' às ', ' ~')}` : `termina ~${c}`
}

const DAILY_UPLOAD = 750e9 // limite do Google por conta, a cada 24 h

/** Quanto a conta em uso já subiu nas últimas 24 h (o Google corta em 750 GB). Só aparece se subiu algo. */
function DailyUpload({ usage }) {
  const accountId = useStore((s) => s.activeAccountId)
  const up = usage?.[accountId]?.up24h || 0
  if (up < 1e9) return null
  const near = up >= DAILY_UPLOAD * 0.9
  return html`<span class=${cx('hero-awake', near && 'is-warn')} title="O Google aceita até 750 GB de upload por conta a cada 24 horas. Passou disso, o SOBEDESCE espera e retoma sozinho.">
    <${Icon} name="arrow-up" size=${14} /> ${bytes(Math.min(up, DAILY_UPLOAD))} de 750 GB enviados em 24 h
  </span>`
}

/** Medidor de nível em "LEDs" para a barra lateral. */
export function LevelMeter({ dir, speed, max }) {
  const SEG = 12
  const lit = speed > 0 ? Math.max(1, Math.round(Math.min(1, speed / (max || 1)) * SEG)) : 0
  const s = speedParts(speed)
  return html`<div class=${cx('level', `level-${dir}`, !speed && 'is-idle')} title=${`${dir === 'down' ? 'Download' : 'Upload'}: ${s.value} ${s.unit} (${bits(speed)})`}>
    <${Icon} name=${dir === 'down' ? 'arrow-down' : 'arrow-up'} size=${12} strokeWidth=${2} />
    <span class="level-leds" aria-hidden="true">
      ${Array.from({ length: SEG }, (_, i) => html`<i class=${i < lit ? 'on' : ''}></i>`)}
    </span>
    <span class="level-num">${s.value}<small> ${s.unit}</small></span>
  </div>`
}
