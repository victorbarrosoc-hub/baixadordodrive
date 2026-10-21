// Tela Transferências: medidor ao vivo, filtros, lotes recolhíveis e linhas com a timeline de clipes.
// Feita para milhares de itens: linhas memoizadas (só a que mudou redesenha) e no máximo ~200 na tela.
import { html, useMemo, useState, useCallback } from '/vendor/preact-htm.js'
import { useStore } from '../lib/store.js'
import { api, attempt } from '../lib/api.js'
import { aprox, bytes, clock, count, dirOf, percent, plural, relTime, speed, timecode, fullDate } from '../lib/format.js'
import { cx, memo, usePersistentState, storage } from '../lib/ui.js'
import { batchAction, cancelBatch, cancelTransfer, driveFileUrl, driveFolderUrl, reveal, transferAction, uploadFlow, uploadPaths } from '../lib/actions.js'
import { bridge, openExternal, revealLabel } from '../lib/desktop.js'
import { copyDriveLink } from './link-share.js'
import { FileDrop } from './drop.js'
import { confirmDialog } from '../lib/modals.js'
import { Icon } from './icons.js'
import { Button, FileIcon, IconButton, Pill } from './common.js'
import { BotaoGrande, Destaque, GraficoVelocidade, Pagina, Passo, Pilulas, Resumo, Stats, Vazio } from './kit.js'
import { SequenceBar, Timeline } from './timeline.js'
import { contaUrl, isCloudAccount } from '../lib/cloud.js'
import { navigate } from '../lib/router.js'
import { PreviaLine } from './previa.js'
import { FILTER_TESTS, batchFolder, batchLocal, integrity, integrityLabel, meterTotals, sortRows } from '../lib/transferencias.js'

/** "Conectar de novo" certo para a conta: OAuth deste computador, o site (Drive da conta) ou entrar na conta. */
function ReauthLink({ t }) {
  if (!isCloudAccount(t.accountId)) return html`<a class="link" href="/api/auth/start">Conectar de novo</a>`
  if (t.error?.reason === 'cloudSignedOut' || t.error?.reason === 'accountNotFound') {
    return html`<button type="button" class="link" onClick=${() => navigate('ajustes')}>Entrar na conta</button>`
  }
  return html`<a class="link" href=${contaUrl()} target="_blank" rel="noopener noreferrer">Reconectar no site</a>`
}

const FILTERS = [
  { value: 'all', label: 'Tudo', test: FILTER_TESTS.all },
  { value: 'active', label: 'Em andamento', test: FILTER_TESTS.active },
  { value: 'queued', label: 'Na fila', test: FILTER_TESTS.queued },
  { value: 'done', label: 'Concluídas', test: FILTER_TESTS.done },
  { value: 'failed', label: 'Com problema', test: FILTER_TESTS.failed },
]

const FINISHED = new Set(['completed', 'skipped', 'canceled'])
const MAX_ROWS = 200
const BIG_BATCH = 40

export function statusInfo(t) {
  const up = t.type === 'upload'
  switch (t.status) {
    case 'running':
      return { tone: up ? 'up' : 'down', label: up ? 'Enviando' : 'Baixando', icon: up ? 'arrow-up' : 'arrow-down' }
    case 'verifying':
      return { tone: up ? 'up' : 'down', label: 'Verificando', icon: 'shield' }
    case 'queued':
      // Envio em fluxo do celular parado no meio: volta sozinho quando o celular mandar o resto.
      if (t.receive) return { tone: 'neutral', label: 'Esperando o celular', icon: 'clock' }
      return { tone: 'neutral', label: 'Na fila', icon: 'clock' }
    case 'paused':
      return { tone: t.error ? 'warning' : 'muted', label: t.error ? 'Precisa de você' : 'Pausado', icon: 'pause' }
    case 'waiting':
      // Cota do Google (750 GB/dia, arquivo muito baixado) ou internet fora do ar: nos dois casos volta sozinho.
      return { tone: 'warning', label: t.error?.kind === 'quota' ? 'Aguardando cota' : 'Sem conexão', icon: 'clock', sub: t.retryAt ? `retoma às ${clock(t.retryAt)}` : null }
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
      ${t.error.kind === 'reauth' ? html`<${ReauthLink} t=${t} />` : null}</div>`
  } else if (t.status === 'waiting' && t.error?.message) {
    message = html`<div class="trow-msg is-quiet"><span>${t.error.message}</span></div>`
  } else if (t.receive && t.receive.size > 0) {
    // Recebendo do celular e subindo ao mesmo tempo: a barra mostra os dois (chegou, atrás; subiu, na frente).
    message = html`<div class="trow-msg is-quiet"><span>Chegando do celular: ${bytes(t.receive.bytes)} <span class="of">de ${bytes(t.receive.size)}</span> (${percent(t.receive.bytes / t.receive.size)}) · sobe junto</span></div>`
  }

  // A ação principal do estado fica sempre à vista (as outras aparecem ao passar o mouse). Com problema e
  // acesso vencido já têm a sua na mensagem ("Tentar de novo", "Reconectar no site").
  const actions = []
  const reauth = t.status === 'paused' && t.error?.kind === 'reauth'
  if (t.status === 'queued') actions.push(html`<${IconButton} icon="prioritize" label="Passar na frente" onClick=${() => transferAction('prioritize', [t.id])} />`)
  if (t.status === 'running' || t.status === 'queued' || t.status === 'waiting')
    actions.push(html`<${IconButton} icon="pause" label="Pausar" onClick=${() => transferAction('pause', [t.id])} />`)
  if (t.status === 'paused')
    actions.push(html`<${IconButton} icon="play" label="Retomar" class=${reauth ? null : 'is-primary'} onClick=${() => transferAction('resume', [t.id])} />`)
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
      <${PreviaLine} t=${t} />
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
  if (by.waiting) parts.push(`${by.waiting} esperando para retomar`)
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
  const check = finished ? integrity(items) : null
  const checkText = check ? integrityLabel(check) : null
  // Envio: a pasta no Drive (abrir desde o começo; o link para mandar ao cliente, quando termina).
  const pasta = type === 'upload' ? batchFolder(items, batch) : null
  // Download: a pasta do computador onde os arquivos estão caindo (antes, durante e depois).
  const local = type === 'download' ? batchLocal(items) : null

  return html`<section class=${cx('batch tl-lote', `is-${type === 'upload' ? 'up' : 'down'}`, !expanded && 'is-collapsed', finished && 'is-finished')} aria-labelledby=${id}>
    <header class="batch-head">
      <button type="button" class="batch-toggle" aria-expanded=${expanded ? 'true' : 'false'} aria-controls=${id + '-rows'} onClick=${onToggle} title=${expanded ? 'Recolher' : 'Mostrar arquivos'}>
        <${Icon} name="chevron-right" size=${14} strokeWidth=${2} />
      </button>
      <span class="tl-dir" title=${type === 'upload' ? 'Envio para o Drive' : 'Download do Drive'}>
        <${Icon} name=${type === 'upload' ? 'arrow-up' : 'arrow-down'} size=${17} strokeWidth=${2} />
      </span>
      <div class="batch-info">
        <div class="batch-title">
          <h3 id=${id} onClick=${onToggle}>${batch.label || 'Lote'}</h3>
          <span class="batch-meta">${plural(items.length, 'arquivo', 'arquivos')} · ${bytes(sum.size)}</span>
        </div>
        <${SequenceBar} items=${seqItems} type=${type} />
        <div class="batch-sub">
          ${batchSubline(type, sum.by)}
          ${checkText
            ? html`<span class=${cx('batch-check', check.checked === check.total ? 'is-ok' : check.mismatch ? 'is-warn' : 'is-partial')} title=${check.checked === check.total ? 'Todos os arquivos conferem com o original (MD5)' : 'Sem conferência: MD5 desligado em Ajustes, Doc Google ou arquivo sem MD5 no Drive'}>
                <${Icon} name="shield" size=${12} strokeWidth=${1.7} />${checkText}
              </span>`
            : null}
        </div>
      </div>
      <div class="batch-stats">
        <span class="batch-pct">${percent(sum.size ? sum.done / sum.size : finished ? 1 : 0)}</span>
        ${sum.speed > 0 ? html`<span class="tc">${timecode(remaining / sum.speed)}</span>` : html`<span class="sub">${finished ? relTime(batch.createdAt) : ' '}</span>`}
      </div>
      <div class="batch-actions">
        ${local
          ? html`<div class="batch-share">
              <${Button} size="sm" variant=${finished ? 'secondary' : 'ghost'} icon="reveal" title=${`Abrir ${local.dir}`} onClick=${() => reveal(local.target)}>${revealLabel(platform)}</${Button}>
            </div>`
          : null}
        ${pasta
        ? html`<div class="batch-share">
            ${finished && check?.total && pasta.id !== 'root'
              ? html`<${Button} size="sm" icon="link" title=${`Copiar o link de “${pasta.name}” para mandar`} onClick=${() => copyDriveLink({ accountId: pasta.accountId, id: pasta.id, name: pasta.name, isFolder: true })} aria-label="Copiar link da pasta">Copiar link<span class="batch-share-long"> da pasta</span></${Button}>`
              : null}
            <${Button} size="sm" variant="ghost" icon="external" aria-label="Abrir no Drive" title=${`Abrir “${pasta.name}” no Google Drive`} onClick=${() => openExternal(pasta.id === 'root' ? 'https://drive.google.com/drive/my-drive' : driveFolderUrl(pasta.id))}>Abrir no Drive</${Button}>
          </div>`
        : null}
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

/** "termina ~14:32" ou "termina amanhã ~09:10". */
function terminaAs(eta) {
  const c = clock(Date.now() + eta * 1000)
  return c.includes(' às ') ? `termina ${c.replace(' às ', ' ~')}` : `termina ~${c}`
}

const DAILY_UPLOAD = 750e9 // limite do Google por conta, a cada 24 h

/**
 * A coluna da direita: o que está andando agora (número grande), o gráfico de velocidade, os números e a ação
 * principal. Assina `stats` sozinha (2×/s) para a lista não ser redesenhada a cada atualização de velocidade.
 */
const PainelAgora = memo(function PainelAgora({ geral, canPause, canResume, falta, problemas }) {
  const stats = useStore((s) => s.stats)
  const lost = useStore((s) => s.conn === 'lost')
  const accountId = useStore((s) => s.activeAccountId)
  const tot = meterTotals(stats.totals)
  const down = stats.down?.speed || 0
  const up = stats.up?.speed || 0
  const moving = down + up > 0
  const eta = moving && tot.moving > 0 ? stats.eta : null
  const pronto = geral.total > 0 && geral.feitos === geral.total
  const frac = geral.size ? geral.done / geral.size : pronto ? 1 : 0
  const titulo = moving ? (down && up ? 'Subindo e descendo' : up ? 'Enviando agora' : 'Baixando agora') : pronto ? 'Tudo pronto' : canResume && !canPause ? 'Parado' : 'Na fila'
  const linha =
    eta != null
      ? html`faltam <b>${aprox(eta)}</b>${eta >= 600 ? ` · ${terminaAs(eta)}` : ''}`
      : html`${count(geral.feitos)} de ${plural(geral.total, 'arquivo', 'arquivos')}${tot.parked ? ` · ${bytes(tot.parked)} ${tot.parkedCount === 1 ? 'parado' : 'parados'}` : ''}`
  const historico = (stats.history || []).slice(-120)
  const up24 = stats.usage?.[accountId]?.up24h || 0

  return html`<${Resumo} titulo="Agora">
    <div class=${cx('tl-destaque', lost && 'is-velho')} title=${lost ? 'Sem contato com o motor: os números podem estar desatualizados' : undefined}>
      <${Destaque}
        titulo=${titulo}
        numero=${Math.floor(frac * 100)}
        unidade=${`% de ${bytes(geral.size)}`}
        progresso=${frac}
        linha=${linha}
        tom=${pronto ? 'ok' : 'grad'}
        vivo=${moving}
      />
    </div>
    <div class="k-caixa">
      <div class="tl-graf-topo">
        <span class="k-rot">Velocidade</span>
        <span class="tl-legenda">
          <span class="is-down" title=${stats.down?.active ? `Baixando ${plural(stats.down.active, 'arquivo', 'arquivos')}` : 'Baixando'}><i></i>${down ? speed(down) : '—'}</span>
          <span class="is-up" title=${stats.up?.active ? `Enviando ${plural(stats.up.active, 'arquivo', 'arquivos')}` : 'Enviando'}><i></i>${up ? speed(up) : '—'}</span>
        </span>
      </div>
      <${GraficoVelocidade} pontos=${historico} altura=${96} label="Velocidade nos últimos 2 minutos" />
      <div class="tl-graf-regua" aria-hidden="true"><span>−2 min</span><span>agora</span></div>
    </div>
    <${Stats}
      colunas=${2}
      itens=${[
        { icone: 'clock', valor: count(falta), rotulo: falta === 1 ? 'arquivo falta' : 'arquivos faltam', tom: 'neutro' },
        { icone: problemas ? 'warning' : 'check', valor: count(problemas), rotulo: 'com problema', tom: problemas ? 'erro' : 'ok' },
      ]}
    />
    ${canPause
      ? html`<${BotaoGrande} icone="pause" onClick=${() => transferAction('pause', 'all')}>Pausar tudo</${BotaoGrande}>`
      : canResume
        ? html`<${BotaoGrande} icone="play" onClick=${() => transferAction('resume', 'all')}>Retomar tudo</${BotaoGrande}>`
        : html`<${BotaoGrande} icone="upload" onClick=${(e) => uploadFlow({ anchor: e.currentTarget })}>Enviar arquivos</${BotaoGrande}>`}
    ${canPause && canResume ? html`<${Button} icon="play" onClick=${() => transferAction('resume', 'all')}>Retomar os pausados</${Button}>` : null}
    ${stats.keepAwake || up24 >= 1e9
      ? html`<div class="tl-notas">
          ${stats.keepAwake ? html`<p class="k-nota"><${Icon} name="coffee" size=${14} />Mantendo o computador acordado</p>` : null}
          ${up24 >= 1e9
            ? html`<p class=${cx('k-nota', up24 >= DAILY_UPLOAD * 0.9 && 'is-warn')} title="O Google aceita até 750 GB de upload por conta a cada 24 horas. Passou disso, o SOBEDESCE espera e retoma sozinho.">
                <${Icon} name="arrow-up" size=${14} />${bytes(Math.min(up24, DAILY_UPLOAD))} de 750 GB enviados em 24 h
              </p>`
            : null}
        </div>`
      : null}
  </${Resumo}>`
})

/** Seções da lista: o que anda, o que está parado e o que terminou. */
const SECOES = [
  { id: 'agora', ranks: [0, 1], icone: 'transfers', cor: 'down', titulo: 'Agora', frase: 'Subindo e descendo, na ordem da fila.' },
  { id: 'parados', ranks: [2], icone: 'pause', cor: 'warn', titulo: 'Parados', frase: 'Pausados ou esperando você.' },
  { id: 'terminados', ranks: [3], icone: 'check', cor: 'ok', titulo: 'Terminados', frase: 'O que já chegou. Os arquivos continuam onde estão.' },
]

const FRASE = 'O que sobe para o Drive e o que desce para o computador, arquivo por arquivo.'

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
    let size = 0
    let done = 0
    const byBatch = new Map()
    for (const t of all) {
      for (const f of FILTERS) if (f.test(t)) counts[f.value]++
      if (t.status !== 'canceled') {
        totalCount++
        size += t.size || 0
        done += t.status === 'completed' || t.status === 'skipped' ? t.size || 0 : t.bytesDone || 0
      }
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
    const geral = { size, done, total: totalCount, feitos: doneCount }
    return { all, counts, doneCount, totalCount, canPause, canResume, finished, groups, geral }
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
    onPaths=${(paths) => uploadPaths({ accountId, paths, destFolderId: dropDest.id, driveId: dropDest.driveId, destName: dropDest.name })}
  />`

  if (!data.all.length) {
    return html`<${Pagina} titulo="Transferências" frase=${FRASE} class="tl">
      ${drop}
      <section class="k-passo tl-vazio k-entra" style="--i:1">
        <${Vazio} icone="transfers" titulo="Tudo em dia por aqui">
          Nada transferindo agora. Comece por um dos caminhos abaixo.
        </${Vazio}>
        <div class="tl-caminhos">
          <button type="button" class="k-opcao tl-caminho k-entra" style="--i:2" onClick=${() => navigate('drive')}>
            <span class="k-opcao-ic"><${Icon} name="arrow-down" size=${17} strokeWidth=${1.9} /></span>
            <b>Baixar do Drive</b>
            <span>Abra o Drive e escolha pastas ou arquivos</span>
          </button>
          <button type="button" class="k-opcao is-up tl-caminho k-entra" style="--i:3" onClick=${(e) => uploadFlow({ anchor: e.currentTarget })}>
            <span class="k-opcao-ic"><${Icon} name="arrow-up" size=${17} strokeWidth=${1.9} /></span>
            <b>Enviar para o Drive</b>
            <span>Uma pasta ou arquivos do computador</span>
          </button>
          ${bridge
            ? html`<div class="k-opcao tl-caminho is-soltar k-entra" style="--i:4">
                <span class="k-opcao-ic"><${Icon} name="drop" size=${17} strokeWidth=${1.9} /></span>
                <b>Arrastar para cá</b>
                <span>Solte aqui: vai para ${dropDest.name}</span>
              </div>`
            : null}
        </div>
        <${QuietArt} />
      </section>
    </${Pagina}>`
  }

  const problemas = data.counts.failed || 0
  const falta = Math.max(0, data.totalCount - data.doneCount)
  const lado = html`<${PainelAgora} geral=${data.geral} canPause=${data.canPause} canResume=${data.canResume} falta=${falta} problemas=${problemas} />`
  const acoes = html`<${Button} icon="upload" onClick=${(e) => uploadFlow({ anchor: e.currentTarget })}>Enviar</${Button}>`
  const secoes = SECOES.map((sec) => ({ ...sec, itens: visible.filter((v) => sec.ranks.includes(v.g.rank)) })).filter((sec) => sec.itens.length)

  return html`<${Pagina} titulo="Transferências" frase=${FRASE} acoes=${acoes} lado=${lado} class="tl">
    ${drop}
    <div class="tl-filtros k-entra" style="--i:1">
      <${Pilulas}
        label="Filtrar transferências"
        valor=${f.value}
        onEscolher=${setFilter}
        itens=${FILTERS.map((x) => ({ value: x.value, label: x.label, conta: x.value === 'all' || !data.counts[x.value] ? null : count(data.counts[x.value]) }))}
      />
    </div>
    ${secoes.length
      ? secoes.map(
          (sec, i) => html`<${Passo}
            key=${sec.id}
            icone=${sec.icone}
            cor=${sec.cor}
            titulo=${sec.titulo}
            sub=${plural(sec.itens.length, 'lote', 'lotes')}
            frase=${sec.frase}
            i=${2 + i}
            acao=${sec.id === 'terminados' && data.finished ? html`<${Button} variant="ghost" size="sm" icon="check" onClick=${clearFinished}>Limpar concluídas</${Button}>` : null}
          >
            <div class="batches tl-lotes">
              ${sec.itens.map(
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
            </div>
          </${Passo}>`,
        )
      : html`<section class="k-passo k-entra" style="--i:2">
          <${Vazio} icone=${f.value === 'failed' ? 'check' : 'transfers'} titulo=${EMPTY_FILTER[f.value] || 'Nada aqui por enquanto'} acoes=${html`<${Button} onClick=${() => setFilter('all')}>Ver tudo</${Button}>`} />
        </section>`}
  </${Pagina}>`
}

const EMPTY_FILTER = {
  active: 'Nada em andamento agora',
  queued: 'A fila está vazia',
  done: 'Nada concluído ainda',
  failed: 'Nenhum problema. Tudo certo por aqui',
}

/** Ilustração do vazio: uma linha de onda quase parada. */
function QuietArt() {
  return html`<svg class="quiet-art tl-onda" viewBox="0 0 240 72" width="240" height="72" aria-hidden="true">
    <path class="qa-line qa-down" d="M0 36 C 20 36, 30 36, 44 36 S 64 26, 74 26 S 92 46, 104 46 S 122 18, 134 18 S 152 40, 164 40 S 182 33, 196 33 S 220 36, 240 36" />
    <path class="qa-line qa-up" d="M0 36 C 22 36, 40 36, 56 36 S 76 42, 88 42 S 106 30, 118 30 S 138 50, 150 50 S 170 34, 182 34 S 214 36, 240 36" />
    <line class="qa-axis" x1="0" x2="240" y1="36" y2="36" />
  </svg>`
}
