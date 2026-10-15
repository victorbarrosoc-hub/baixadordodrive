// Tela Transferências: medidor ao vivo, filtros, lotes recolhíveis e linhas com a timeline de clipes.
// Feita para milhares de itens: linhas memoizadas (só a que mudou redesenha) e no máximo ~200 na tela.
import { html, useMemo, useState, useCallback } from '/vendor/preact-htm.js'
import { useStore } from '../lib/store.js'
import { api, attempt } from '../lib/api.js'
import { bytes, clock, count, dirOf, percent, plural, relTime, speed, timecode, fullDate } from '../lib/format.js'
import { cx, memo, usePersistentState, storage } from '../lib/ui.js'
import { batchAction, cancelBatch, cancelTransfer, driveFileUrl, reveal, transferAction, uploadFlow, uploadPaths } from '../lib/actions.js'
import { bridge, revealLabel } from '../lib/desktop.js'
import { FileDrop } from './drop.js'
import { confirmDialog } from '../lib/modals.js'
import { Icon } from './icons.js'
import { Button, EmptyState, FileIcon, IconButton, LinkButton, Pill, Segmented } from './common.js'
import { MeterHero } from './meter.js'
import { SequenceBar, Timeline } from './timeline.js'

const FILTERS = [
  { value: 'all', label: 'Tudo', test: () => true },
  { value: 'active', label: 'Em andamento', test: (t) => t.status === 'running' || t.status === 'verifying' || t.status === 'waiting' || t.status === 'paused' },
  { value: 'queued', label: 'Na fila', test: (t) => t.status === 'queued' },
  { value: 'done', label: 'Concluídas', test: (t) => t.status === 'completed' || t.status === 'skipped' },
  { value: 'failed', label: 'Com problema', test: (t) => t.status === 'failed' || t.verify?.state === 'mismatch' },
]

const RANK = { running: 0, verifying: 0, failed: 1, waiting: 2, paused: 3, queued: 4, completed: 5, skipped: 5, canceled: 6 }
const FINISHED = new Set(['completed', 'skipped', 'canceled'])
const MAX_ROWS = 200
const BIG_BATCH = 40

function sortRows(a, b) {
  const r = (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9)
  if (r) return r
  if (a.status === 'queued') {
    const p = (b.priority || 0) - (a.priority || 0)
    if (p) return p
  }
  return (a.createdAt || 0) - (b.createdAt || 0) || (a.name < b.name ? -1 : 1)
}

export function statusInfo(t) {
  const up = t.type === 'upload'
  switch (t.status) {
    case 'running':
      return { tone: up ? 'up' : 'down', label: up ? 'Enviando' : 'Baixando', icon: up ? 'arrow-up' : 'arrow-down' }
    case 'verifying':
      return { tone: up ? 'up' : 'down', label: 'Verificando', icon: 'shield' }
    case 'queued':
      return { tone: 'neutral', label: 'Na fila', icon: 'clock' }
    case 'paused':
      return { tone: t.error ? 'warning' : 'muted', label: t.error ? 'Pausado · precisa de você' : 'Pausado', icon: 'pause' }
    case 'waiting':
      return { tone: 'warning', label: 'Aguardando cota', icon: 'clock', sub: t.retryAt ? `retoma às ${clock(t.retryAt)}` : null }
    case 'completed':
      return t.verify?.state === 'mismatch'
        ? { tone: 'warning', label: 'Chegou diferente', icon: 'warning' }
        : { tone: 'success', label: 'Concluído', icon: 'check' }
    case 'skipped':
      return { tone: 'success-soft', label: t.note || 'Já estava no Drive', icon: 'check' }
    case 'failed':
      return { tone: 'error', label: 'Com problema', icon: 'warning' }
    case 'canceled':
      return { tone: 'muted', label: 'Cancelado', icon: 'x' }
    default:
      return { tone: 'neutral', label: t.status, icon: null }
  }
}

// ───── linha ─────

const TransferRow = memo(function TransferRow({ t, platform }) {
  const st = statusInfo(t)
  const dir = dirOf(t.relPath || '')
  const running = t.status === 'running'
  const done = t.status === 'completed' || t.status === 'skipped'
  const localPath = t.type === 'download' ? (t.status === 'completed' ? t.dest?.path : null) : t.local?.path
  const driveId = t.type === 'upload' ? t.target?.fileId : null
  const verifyOk = t.verify?.state === 'ok'
  const mismatch = t.verify?.state === 'mismatch'

  let numbers
  if (done) numbers = html`<span>${bytes(t.size)}</span><span class="sub" title=${fullDate(t.finishedAt)}>${t.finishedAt ? relTime(t.finishedAt) : ''}</span>`
  else if (t.status === 'verifying') numbers = html`<span>${bytes(t.size)}</span><span class="sub">conferindo…</span>`
  else if (t.size == null) numbers = html`<span>—</span><span class="sub">${running ? speed(t.speed) : ''}</span>`
  else if (t.bytesDone > 0)
    numbers = html`<span>${bytes(t.bytesDone, { fixed: running })} <span class="of">de ${bytes(t.size)}</span></span><span class="sub">${running ? speed(t.speed) : percent(t.bytesDone / t.size)}</span>`
  else numbers = html`<span>${bytes(t.size)}</span><span class="sub">${running ? speed(t.speed) : ''}</span>`

  let message = null
  if (t.status === 'failed') {
    message = html`<div class="trow-msg is-error">
      <span>${t.error?.message || 'Algo deu errado nesta transferência.'}</span>
      <button type="button" class="link" onClick=${() => transferAction('retry', [t.id])}>Tentar de novo</button>
    </div>`
  } else if (mismatch) {
    message = html`<div class="trow-msg is-warning"><span>O conteúdo não bate com o original (MD5). Vale transferir de novo.</span>
      <button type="button" class="link" onClick=${() => transferAction('retry', [t.id])}>Tentar de novo</button></div>`
  } else if (t.status === 'verifying') {
    message = html`<div class="trow-msg is-quiet"><span class="shimmer-text">Verificando integridade…</span></div>`
  } else if (t.status === 'paused' && t.error) {
    message = html`<div class="trow-msg is-warning"><span>${t.error.message}</span>
      ${t.error.kind === 'reauth' ? html`<a class="link" href="/api/auth/start">Conectar de novo</a>` : null}</div>`
  } else if (t.status === 'waiting' && t.error?.message) {
    message = html`<div class="trow-msg is-quiet"><span>${t.error.message}</span></div>`
  }

  const actions = []
  if (t.status === 'queued') actions.push(html`<${IconButton} icon="prioritize" label="Passar na frente" onClick=${() => transferAction('prioritize', [t.id])} />`)
  if (t.status === 'running' || t.status === 'queued' || t.status === 'waiting')
    actions.push(html`<${IconButton} icon="pause" label="Pausar" onClick=${() => transferAction('pause', [t.id])} />`)
  if (t.status === 'paused') actions.push(html`<${IconButton} icon="play" label="Retomar" onClick=${() => transferAction('resume', [t.id])} />`)
  if (t.status === 'waiting') actions.push(html`<${IconButton} icon="retry" label="Tentar agora" onClick=${() => transferAction('retry', [t.id])} />`)
  if (t.status === 'failed' || t.status === 'canceled') actions.push(html`<${IconButton} icon="retry" label="Tentar de novo" onClick=${() => transferAction('retry', [t.id])} />`)
  if (done && localPath) actions.push(html`<${IconButton} icon="reveal" label=${revealLabel(platform)} onClick=${() => reveal(localPath)} />`)
  if (done && driveId)
    actions.push(html`<a class="icon-btn" href=${driveFileUrl(driveId)} target="_blank" rel="noopener" aria-label="Abrir no Drive" title="Abrir no Drive"><${Icon} name="external" /></a>`)
  if (!FINISHED.has(t.status) && t.status !== 'failed')
    actions.push(html`<${IconButton} icon="x" label="Cancelar" tone="danger" onClick=${() => cancelTransfer(t)} />`)
  else if (t.status !== 'running' && t.status !== 'verifying')
    actions.push(html`<${IconButton} icon="minus" label="Tirar da lista" onClick=${() => transferAction('remove', [t.id])} />`)

  return html`<div class=${cx('trow', `is-${t.status}`)} data-id=${t.id}>
    <${FileIcon} name=${t.name} mimeType=${t.source?.mimeType} size=${32} />
    <div class="trow-main">
      <div class="trow-name">
        <span class="name" title=${t.relPath || t.name}>${t.name}</span>
        ${dir ? html`<span class="path" title=${dir}>${dir}</span>` : null}
        ${verifyOk && done ? html`<span class="tag tag-ok" title="O conteúdo confere com o original (MD5)"><${Icon} name="shield" size=${12} strokeWidth=${1.7} />Íntegro</span>` : null}
        ${t.note && t.status !== 'skipped' ? html`<span class="tag">${t.note}</span>` : null}
      </div>
      <${Timeline} t=${t} size="sm" />
      ${message}
    </div>
    <div class="trow-nums">${numbers}</div>
    <div class="trow-eta" title=${running ? 'Tempo restante' : undefined}>
      ${running ? html`<span class="tc">${timecode(t.eta)}</span>` : null}
    </div>
    <div class="trow-status">
      <${Pill} tone=${st.tone} icon=${st.icon} title=${st.sub ? `${st.label} — ${st.sub}` : st.label}>${st.label}</${Pill}>
      ${st.sub ? html`<span class="status-sub">${st.sub}</span>` : null}
    </div>
    <div class="trow-actions">${actions}</div>
  </div>`
})

// ───── lote ─────

function summarize(items) {
  let size = 0
  let done = 0
  let spd = 0
  const by = {}
  for (const t of items) {
    by[t.status] = (by[t.status] || 0) + 1
    if (t.status === 'canceled') continue
    size += t.size || 0
    done += t.status === 'completed' || t.status === 'skipped' ? t.size || 0 : t.bytesDone || 0
    if (t.status === 'running') spd += t.speed || 0
  }
  return { size, done, speed: spd, by }
}

function batchSubline(type, by) {
  const parts = []
  const verb = type === 'upload' ? 'enviando' : 'baixando'
  if (by.running) parts.push(`${by.running} ${verb}`)
  if (by.verifying) parts.push(`${by.verifying} verificando`)
  if (by.queued) parts.push(`${count(by.queued)} na fila`)
  if (by.waiting) parts.push(`${by.waiting} aguardando cota`)
  if (by.paused) parts.push(`${count(by.paused)} ${by.paused === 1 ? 'pausado' : 'pausados'}`)
  if (by.failed) parts.push(`${by.failed} com problema`)
  const fin = (by.completed || 0) + (by.skipped || 0)
  if (fin) parts.push(`${count(fin)} ${fin === 1 ? 'concluído' : 'concluídos'}`)
  if (by.canceled) parts.push(`${by.canceled} ${by.canceled === 1 ? 'cancelado' : 'cancelados'}`)
  return parts.join(' · ')
}

function BatchGroup({ group, rows, expanded, onToggle, limit, onMore, platform }) {
  const { batch, items, sum } = group
  const type = batch.type || items[0]?.type || 'download'
  const hidden = rows.length - Math.min(rows.length, limit)
  const shown = expanded ? rows.slice(0, limit) : []
  const active = (sum.by.running || 0) + (sum.by.queued || 0) + (sum.by.waiting || 0) + (sum.by.verifying || 0)
  const paused = sum.by.paused || 0
  const finished = items.every((t) => FINISHED.has(t.status))
  const remaining = Math.max(0, sum.size - sum.done)
  const seqItems = useMemo(() => items.map((t) => ({ size: t.size || 0, done: t.status === 'completed' || t.status === 'skipped' ? t.size || 0 : t.bytesDone || 0, status: t.status })), [items])
  const id = `batch-${batch.id}`

  return html`<section class=${cx('batch card', !expanded && 'is-collapsed', finished && 'is-finished')} aria-labelledby=${id}>
    <header class="batch-head">
      <button type="button" class="batch-toggle" aria-expanded=${expanded ? 'true' : 'false'} aria-controls=${id + '-rows'} onClick=${onToggle} title=${expanded ? 'Recolher' : 'Mostrar arquivos'}>
        <${Icon} name="chevron-right" size=${14} strokeWidth=${2} />
      </button>
      <span class=${cx('dir-badge', type === 'upload' ? 'is-up' : 'is-down')} title=${type === 'upload' ? 'Envio para o Drive' : 'Download do Drive'}>
        <${Icon} name=${type === 'upload' ? 'arrow-up' : 'arrow-down'} size=${14} strokeWidth=${2} />
      </span>
      <div class="batch-info">
        <div class="batch-title">
          <h3 id=${id} onClick=${onToggle}>${batch.label || 'Lote'}</h3>
          <span class="batch-meta">${plural(items.length, 'arquivo', 'arquivos')} · ${bytes(sum.size)}</span>
        </div>
        <${SequenceBar} items=${seqItems} type=${type} />
        <div class="batch-sub">${batchSubline(type, sum.by)}</div>
      </div>
      <div class="batch-stats">
        <span class="batch-pct">${percent(sum.size ? sum.done / sum.size : finished ? 1 : 0)}</span>
        ${sum.speed > 0 ? html`<span class="tc">${timecode(remaining / sum.speed)}</span>` : html`<span class="sub">${finished ? relTime(batch.createdAt) : ' '}</span>`}
      </div>
      <div class="batch-actions">
        ${active ? html`<${IconButton} icon="pause" label="Pausar lote" onClick=${() => batchAction('pause', batch.id)} />` : null}
        ${paused ? html`<${IconButton} icon="play" label="Retomar lote" onClick=${() => batchAction('resume', batch.id)} />` : null}
        ${!finished ? html`<${IconButton} icon="x" label="Cancelar lote" tone="danger" onClick=${() => cancelBatch(batch, items.filter((t) => !FINISHED.has(t.status)).length)} />` : null}
      </div>
    </header>
    ${expanded
      ? html`<div class="batch-rows" id=${id + '-rows'}>
          ${shown.map((t) => html`<${TransferRow} key=${t.id} t=${t} platform=${platform} />`)}
          ${hidden > 0
            ? html`<button type="button" class="more-row" onClick=${onMore}>
                Mostrar mais ${count(Math.min(100, hidden))} <span class="sub">· faltam ${count(hidden)}</span>
              </button>`
            : null}
        </div>`
      : null}
  </section>`
}

// ───── tela ─────

export function TransfersScreen() {
  const transfers = useStore((s) => s.transfers)
  const batches = useStore((s) => s.batches)
  const appPlatform = useStore((s) => s.app?.platform)
  const platform = bridge?.platform || appPlatform
  const accountId = useStore((s) => s.activeAccountId)
  const [filter, setFilter] = usePersistentState('transfers.filter', 'all')
  const [toggled, setToggled] = useState({}) // batchId -> boolean (escolha do usuário)
  const [limits, setLimits] = useState({}) // batchId -> linhas visíveis

  const data = useMemo(() => {
    const all = [...transfers.values()]
    const counts = Object.fromEntries(FILTERS.map((f) => [f.value, 0]))
    let doneCount = 0
    let totalCount = 0
    let canPause = false
    let canResume = false
    let finished = 0
    const byBatch = new Map()
    for (const t of all) {
      for (const f of FILTERS) if (f.test(t)) counts[f.value]++
      if (t.status !== 'canceled') totalCount++
      if (t.status === 'completed' || t.status === 'skipped') doneCount++
      if (FINISHED.has(t.status)) finished++
      if (t.status === 'running' || t.status === 'queued' || t.status === 'waiting') canPause = true
      if (t.status === 'paused') canResume = true
      let list = byBatch.get(t.batchId)
      if (!list) byBatch.set(t.batchId, (list = []))
      list.push(t)
    }
    const meta = new Map(batches.map((b) => [b.id, b]))
    const groups = []
    for (const [batchId, items] of byBatch) {
      const batch = meta.get(batchId) || { id: batchId || 'sem-lote', label: 'Outras transferências', type: items[0]?.type, createdAt: Math.min(...items.map((t) => t.createdAt || 0)) }
      const sum = summarize(items)
      const isActive = items.some((t) => !FINISHED.has(t.status))
      // ordem: lotes andando, depois na fila, depois parados (pausa/problema) — na ordem da fila (mais antigo
      // primeiro, como o motor processa) — e por fim os concluídos, do mais recente para o mais antigo
      const rank = sum.by.running ? 0 : sum.by.queued || sum.by.waiting || sum.by.verifying ? 1 : isActive ? 2 : 3
      groups.push({ batch, items, sum, isActive, rank })
    }
    groups.sort((a, b) => a.rank - b.rank || (a.rank === 3 ? -1 : 1) * ((a.batch.createdAt || 0) - (b.batch.createdAt || 0)))
    return { all, counts, doneCount, totalCount, canPause, canResume, finished, groups }
  }, [transfers, batches])

  const f = FILTERS.find((x) => x.value === filter) || FILTERS[0]
  const anyActive = data.groups.some((g) => g.isActive)

  // monta os grupos visíveis respeitando o orçamento de linhas
  let budget = MAX_ROWS
  const visible = []
  for (const g of data.groups) {
    const rows = (filter === 'all' ? g.items.slice() : g.items.filter(f.test)).sort(sortRows)
    if (!rows.length) continue
    const id = g.batch.id
    const defaultLimit = rows.length > BIG_BATCH ? 12 : BIG_BATCH
    const limit = limits[id] ?? defaultLimit
    const autoExpanded = budget > 0 && !(filter === 'all' && !g.isActive && anyActive)
    const expanded = toggled[id] ?? autoExpanded
    if (expanded) budget -= Math.min(rows.length, limit)
    visible.push({ g, rows, expanded, limit })
  }

  const toggle = useCallback((id, cur) => setToggled((s) => ({ ...s, [id]: !cur })), [])
  const more = useCallback((id, cur) => setLimits((s) => ({ ...s, [id]: cur + 100 })), [])

  const clearFinished = async () => {
    if (data.finished > 50) {
      const ok = await confirmDialog({ title: 'Limpar concluídas?', message: `${plural(data.finished, 'item sai', 'itens saem')} da lista. Os arquivos continuam onde estão.`, confirmLabel: 'Limpar' })
      if (!ok) return
    }
    attempt(api.post('/api/transfers/clear', {}))
  }

  // soltar arquivos aqui envia para a última pasta aberta no Drive (ou Meu Drive)
  const last = storage.get('drive.last', null)
  const dropDest = last && last.accountId === accountId ? last : { id: 'root', name: 'Meu Drive', driveId: null }
  const drop = html`<${FileDrop}
    label=${dropDest.name}
    enabled=${!!accountId}
    onPaths=${(paths) => uploadPaths({ accountId, paths, destFolderId: dropDest.id, driveId: dropDest.driveId })}
  />`

  if (!data.all.length) {
    return html`<div class="page">
      ${drop}
      <header class="page-head"><h1>Transferências</h1></header>
      <${EmptyState}
        art=${html`<${QuietArt} />`}
        title="Tudo em dia por aqui"
        actions=${html`
          <${LinkButton} variant="primary" icon="cloud" href="#/drive">Abrir o Drive</${LinkButton}>
          <${Button} icon="upload" onClick=${(e) => uploadFlow({ anchor: e.currentTarget })}>Enviar uma pasta</${Button}>
        `}
      >
        Nada transferindo agora. Escolha arquivos no Drive ou envie uma pasta${bridge ? ' — ou arraste para cá' : ''}.
      </${EmptyState}>
    </div>`
  }

  return html`<div class="page">
    ${drop}
    <header class="page-head">
      <h1>Transferências</h1>
      <div class="page-head-actions">
        <${Button} icon="upload" onClick=${(e) => uploadFlow({ anchor: e.currentTarget })}>Enviar</${Button}>
      </div>
    </header>
    <${MeterHero} doneCount=${data.doneCount} totalCount=${data.totalCount} canPause=${data.canPause} canResume=${data.canResume} />
    <div class="toolbar">
      <${Segmented}
        label="Filtrar transferências"
        value=${f.value}
        onChange=${setFilter}
        options=${FILTERS.map((x) => ({ value: x.value, label: x.label, count: x.value === 'all' ? null : data.counts[x.value] ? count(data.counts[x.value]) : null }))}
      />
      <div class="toolbar-right">
        ${data.finished ? html`<${Button} variant="ghost" size="sm" icon="check" onClick=${clearFinished}>Limpar concluídas</${Button}>` : null}
      </div>
    </div>
    ${visible.length
      ? html`<div class="batches">
          ${visible.map(
            ({ g, rows, expanded, limit }) => html`<${BatchGroup}
              key=${g.batch.id}
              group=${g}
              rows=${rows}
              expanded=${expanded}
              limit=${limit}
              platform=${platform}
              onToggle=${() => toggle(g.batch.id, expanded)}
              onMore=${() => more(g.batch.id, limit)}
            />`,
          )}
        </div>`
      : html`<${EmptyState} compact title=${EMPTY_FILTER[f.value] || 'Nada aqui por enquanto'}>
          <button type="button" class="link" onClick=${() => setFilter('all')}>Ver tudo</button>
        </${EmptyState}>`}
  </div>`
}

const EMPTY_FILTER = {
  active: 'Nada em andamento agora',
  queued: 'A fila está vazia',
  done: 'Nada concluído ainda',
  failed: 'Nenhum problema. Tudo certo por aqui',
}

/** Ilustração do vazio: uma linha de onda quase parada. */
function QuietArt() {
  return html`<svg class="quiet-art" viewBox="0 0 240 72" width="240" height="72" aria-hidden="true">
    <path class="qa-line qa-down" d="M0 36 C 20 36, 30 36, 44 36 S 64 26, 74 26 S 92 46, 104 46 S 122 18, 134 18 S 152 40, 164 40 S 182 33, 196 33 S 220 36, 240 36" />
    <path class="qa-line qa-up" d="M0 36 C 22 36, 40 36, 56 36 S 76 42, 88 42 S 106 30, 118 30 S 138 50, 150 50 S 170 34, 182 34 S 214 36, 240 36" />
    <line class="qa-axis" x1="0" x2="240" y1="36" y2="36" />
  </svg>`
}
