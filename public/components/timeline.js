// Barra de progresso como timeline de edição: cada segmento do download é um clipe na trilha,
// preenchido até onde já chegou; os ativos têm um "playhead" fino na posição atual.
import { html } from '/vendor/preact-htm.js'
import { cx, memo } from '../lib/ui.js'

const clamp01 = (x) => (x > 1 ? 1 : x < 0 ? 0 : x)
const pct = (x) => `${(x * 100).toFixed(3)}%`

/**
 * Props: t (PublicTransfer) e size ('sm' | 'md').
 * Memoizado: só redesenha quando o objeto da transferência muda.
 */
export const Timeline = memo(function Timeline({ t, size = 'md' }) {
  const total = t.size || 0
  const status = t.status
  const done = status === 'completed' || status === 'skipped'
  const verifying = status === 'verifying'
  const running = status === 'running'
  const klass = cx(
    'tl',
    `tl-${size}`,
    t.type === 'upload' ? 'tl-up' : 'tl-down',
    status === 'paused' && 'is-paused',
    status === 'waiting' && 'is-paused',
    status === 'queued' && 'is-queued',
    status === 'failed' && 'is-failed',
    status === 'canceled' && 'is-canceled',
    done && 'is-done',
    status === 'skipped' && 'is-skipped',
    verifying && 'is-verifying',
  )
  const label = done ? 'Concluído' : `${Math.floor(clamp01(total ? t.bytesDone / total : 0) * 100)}% transferido`

  let clips
  if (done || verifying || !total) {
    clips = [{ left: 0, width: 1, fill: done || verifying ? 1 : 0, head: null }]
  } else if (t.type === 'download' && Array.isArray(t.segments) && t.segments.length) {
    clips = t.segments
      .slice()
      .sort((a, b) => a.start - b.start)
      .map((s) => {
        const len = s.end - s.start + 1
        const fill = clamp01((s.pos - s.start) / len)
        const active = running && (s.active ?? true) && s.pos <= s.end
        return { left: s.start / total, width: len / total, fill, head: active ? fill : null }
      })
  } else {
    const fill = clamp01(t.bytesDone / total)
    // Chegando do celular e subindo junto: o que já chegou aparece atrás, como o "carregado" de um player.
    const recv = t.receive ? clamp01(t.receive.bytes / total) : null
    clips = [{ left: 0, width: 1, fill, head: running ? fill : null, recv }]
  }

  return html`<div class=${klass} role="progressbar" aria-label=${label} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(clamp01(total ? t.bytesDone / total : done ? 1 : 0) * 100)}>
    ${clips.map(
      (c) => html`<div class="tl-clip" style=${`left:${pct(c.left)};width:${pct(c.width)}`}>
        ${c.recv != null ? html`<div class="tl-recv" style=${`width:${pct(c.recv)}`}></div>` : null}
        <div class="tl-fill" style=${`width:${pct(c.fill)}`}></div>
        ${c.head != null ? html`<div class="tl-head" style=${`left:${pct(c.head)}`}></div>` : null}
      </div>`,
    )}
  </div>`
})

/**
 * Timeline de um lote: cada arquivo é um clipe proporcional ao tamanho (como clipes numa sequência).
 * Lotes enormes são agrupados em até `maxClips` blocos para não pesar.
 */
export const SequenceBar = memo(function SequenceBar({ items, type, maxClips = 96 }) {
  // items: [{ size, done, status }]
  const total = items.reduce((a, x) => a + (x.size || 0), 0) || 1
  let groups = items
  if (items.length > maxClips) {
    const per = Math.ceil(items.length / maxClips)
    groups = []
    for (let i = 0; i < items.length; i += per) {
      const chunk = items.slice(i, i + per)
      groups.push({
        size: chunk.reduce((a, x) => a + (x.size || 0), 0),
        done: chunk.reduce((a, x) => a + (x.done || 0), 0),
        status: chunk.some((x) => x.status === 'running') ? 'running' : chunk.every((x) => x.status === 'completed' || x.status === 'skipped') ? 'completed' : chunk.some((x) => x.status === 'failed') ? 'failed' : 'other',
      })
    }
  }
  let left = 0
  return html`<div class=${cx('seq', type === 'upload' ? 'tl-up' : 'tl-down')} aria-hidden="true">
    ${groups.map((g) => {
      const w = (g.size || 0) / total
      const style = `left:${pct(left)};width:${pct(w)}`
      left += w
      const f = clamp01(g.size ? g.done / g.size : g.status === 'completed' ? 1 : 0)
      return html`<div class=${cx('seq-clip', g.status === 'running' && 'is-running', g.status === 'failed' && 'is-failed')} style=${style}>
        <div class="seq-fill" style=${`width:${pct(f)}`}></div>
      </div>`
    })}
  </div>`
})
