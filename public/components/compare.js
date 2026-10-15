// Tela Comparar: pasta do computador × pasta do Drive. Mostra o que já subiu, o que falta e o que
// só existe no Drive, pasta por pasta, com atalhos para subir/baixar a diferença.
import { html, useEffect, useMemo, useRef, useState } from '/vendor/preact-htm.js'
import { useStore, setCompareJob } from '../lib/store.js'
import { api, attempt, enc } from '../lib/api.js'
import { bytes, count, plural, relTime, tildify, baseName, dirOf } from '../lib/format.js'
import { cx, usePersistentState, useNow } from '../lib/ui.js'
import { announceBatch } from '../lib/actions.js'
import { pickDriveFolder, pickLocal, confirmDialog } from '../lib/modals.js'
import { Icon } from './icons.js'
import { Button, Checkbox, EmptyState, FileIcon, Pill, Segmented, Spinner } from './common.js'
import { useLocalRoots } from './local-picker.js'

// lembra a última comparação enquanto o app está aberto (trocar de tela não perde o resultado)
const mem = { jobId: null, result: null, startedAt: null }

const MODES = [
  { value: 'quick', label: 'Rápido', sub: 'nome e tamanho' },
  { value: 'deep', label: 'Completo', sub: 'confere o conteúdo (MD5)' },
]

const PHASES = [
  { id: 'local', label: 'Lendo a pasta do computador' },
  { id: 'drive', label: 'Lendo a pasta do Drive' },
  { id: 'hash', label: 'Conferindo o conteúdo (MD5)', deepOnly: true },
  { id: 'match', label: 'Cruzando as duas listas' },
]

const STATUS = {
  synced: { label: 'Já no Drive', tone: 'success', icon: 'check' },
  missing: { label: 'Falta subir', tone: 'up', icon: 'arrow-up' },
  different: { label: 'Diferente', tone: 'warning', icon: 'warning' },
  'only-drive': { label: 'Só no Drive', tone: 'neutral', icon: 'cloud' },
  elsewhere: { label: 'Em outro lugar', tone: 'success-soft', icon: 'arrow-turn-up' },
}

const STATE_BADGE = {
  complete: { label: 'Completa', tone: 'success', icon: 'check' },
  partial: { label: 'Parcial', tone: 'warning', icon: null },
  missing: { label: 'Não subiu', tone: 'up', icon: null },
  empty: { label: 'Vazia', tone: 'muted', icon: null },
}

const inDir = (relDir, dir) => dir === '' || relDir === dir || relDir.startsWith(dir + '/')

// ───── fontes ─────

function SourceCard({ side, title, icon, value, sub, onPick, emptyText }) {
  return html`<div class=${cx('src-card card', !value && 'is-empty')}>
    <div class="src-head">
      <span class=${cx('src-icon', `src-${side}`)}><${Icon} name=${icon} size=${18} /></span>
      <span class="eyebrow">${title}</span>
    </div>
    ${value
      ? html`<div class="src-body">
          <div class="src-name" title=${value}>${value}</div>
          <div class="src-path mono-path" title=${sub}>${sub}</div>
        </div>`
      : html`<div class="src-body"><div class="src-empty">${emptyText}</div></div>`}
    <${Button} size="sm" icon="folder" onClick=${onPick}>${value ? 'Trocar pasta…' : 'Escolher pasta…'}</${Button}>
  </div>`
}

// ───── progresso ─────

function Progress({ job, mode, onCancel }) {
  const p = job?.progress || {}
  const phases = PHASES.filter((x) => !x.deepOnly || mode === 'deep')
  const idx = Math.max(0, phases.findIndex((x) => x.id === p.phase))
  return html`<section class="card cmp-progress" aria-live="polite">
    <div class="cmp-progress-head">
      <${Spinner} size=${18} />
      <div>
        <h2>Comparando…</h2>
        <p class="sub">Pode usar o resto do app enquanto isso — a comparação continua.</p>
      </div>
      ${onCancel ? html`<${Button} variant="ghost" size="sm" onClick=${onCancel}>Esconder</${Button}>` : null}
    </div>
    <ol class="phases">
      ${phases.map((ph, i) => {
        const state = i < idx ? 'done' : i === idx ? 'now' : 'next'
        const frac = state === 'now' && p.total ? Math.min(1, (p.done || 0) / p.total) : state === 'done' ? 1 : 0
        return html`<li class=${cx('phase', `is-${state}`)}>
          <span class="phase-dot">${state === 'done' ? html`<${Icon} name="check" size=${12} strokeWidth=${2.2} />` : null}</span>
          <div class="phase-body">
            <div class="phase-label">
              <span>${ph.label}</span>
              ${state === 'now' && p.total ? html`<span class="sub num">${count(p.done || 0)} de ${count(p.total)}</span>` : null}
            </div>
            ${state === 'now'
              ? html`<div class="phase-bar"><i style=${`width:${(frac * 100).toFixed(1)}%`}></i></div>
                  ${p.current ? html`<div class="phase-current mono-path" title=${p.current}>${p.current}</div>` : null}`
              : null}
          </div>
        </li>`
      })}
    </ol>
  </section>`
}

// ───── resultado ─────

function Tiles({ summary, files, onPick, active }) {
  const syncedBytes = useMemo(() => files.reduce((a, f) => a + (f.status === 'synced' || f.status === 'elsewhere' ? f.local?.size || 0 : 0), 0), [files])
  const tiles = [
    { id: 'synced', label: 'Já no Drive', n: summary.synced + (summary.elsewhere || 0), b: syncedBytes, tone: 'success', icon: 'check' },
    { id: 'missing', label: 'Falta subir', n: summary.missing, b: summary.missingBytes, tone: 'up', icon: 'arrow-up' },
    { id: 'different', label: 'Diferentes', n: summary.different, b: summary.differentBytes, tone: 'warning', icon: 'warning' },
    { id: 'only-drive', label: 'Só no Drive', n: summary.onlyDrive, b: summary.onlyDriveBytes, tone: 'neutral', icon: 'cloud' },
  ]
  return html`<div class="tiles">
    ${tiles.map(
      (t) => html`<button type="button" class=${cx('tile card', `tile-${t.tone}`, active === t.id && 'is-on', !t.n && 'is-zero')} onClick=${() => onPick(active === t.id ? 'all' : t.id)} aria-pressed=${active === t.id ? 'true' : 'false'}>
        <span class="tile-label"><span class="tile-icon"><${Icon} name=${t.icon} size=${13} strokeWidth=${2} /></span>${t.label}</span>
        <span class="tile-n num">${count(t.n || 0)}</span>
        <span class="tile-b">${t.n ? bytes(t.b || 0) : '—'}</span>
      </button>`,
    )}
  </div>`
}

function MiniStack({ f }) {
  const total = Math.max(1, f.synced + f.missing + f.different + f.onlyDrive)
  const seg = (n, k) => (n ? html`<i class=${k} style=${`width:${((n / total) * 100).toFixed(2)}%`}></i>` : null)
  return html`<span class=${cx('ministack', !f.files && 'is-empty')} aria-hidden="true">
    ${seg(f.synced, 's-synced')}${seg(f.missing, 's-missing')}${seg(f.different, 's-different')}${seg(f.onlyDrive, 's-only')}
  </span>`
}

function folderText(f) {
  if (!f.files) return 'Vazia'
  const pend = f.missing + f.different
  if (f.state === 'complete' && !f.onlyDrive) return `${plural(f.files, 'arquivo', 'arquivos')} · tudo no Drive`
  if (f.state === 'complete') return `${plural(f.files, 'arquivo', 'arquivos')} · ${f.onlyDrive} só no Drive`
  if (!pend) return plural(f.files, 'arquivo', 'arquivos')
  return `faltam ${count(pend)} de ${count(f.files)} · ${bytes(f.missingBytes || 0)}`
}

function FolderTree({ folders, selected, onSelect, onUpload, busy }) {
  const [collapsed, setCollapsed] = useState(() => {
    const s = new Set()
    if (folders.length > 40) for (const f of folders) if (f.depth >= 2) s.add(f.relDir)
    return s
  })
  const hasKids = useMemo(() => {
    const set = new Set()
    for (const f of folders) if (f.relDir) set.add(dirOf(f.relDir))
    return set
  }, [folders])
  const hiddenBy = (rel) => {
    if (!rel) return false
    let d = dirOf(rel)
    while (true) {
      if (collapsed.has(d)) return true
      if (!d) return false
      d = dirOf(d)
    }
  }
  const toggle = (rel) =>
    setCollapsed((s) => {
      const n = new Set(s)
      n.has(rel) ? n.delete(rel) : n.add(rel)
      return n
    })
  const rows = folders.filter((f) => !hiddenBy(f.relDir))
  return html`<div class="tree" role="tree" aria-label="Pastas">
    ${rows.map((f) => {
      const open = !collapsed.has(f.relDir)
      const kids = hasKids.has(f.relDir)
      const badge = STATE_BADGE[f.state] || STATE_BADGE.partial
      const pend = f.missing + f.different
      return html`<div
        class=${cx('tree-row', selected === f.relDir && 'is-selected', `state-${f.state}`)}
        role="treeitem"
        aria-level=${f.depth + 1}
        aria-expanded=${kids ? (open ? 'true' : 'false') : undefined}
        aria-selected=${selected === f.relDir ? 'true' : 'false'}
        tabindex="0"
        onClick=${() => onSelect(selected === f.relDir ? null : f.relDir)}
        onKeyDown=${(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect(selected === f.relDir ? null : f.relDir)
          } else if (e.key === 'ArrowRight' && kids && !open) toggle(f.relDir)
          else if (e.key === 'ArrowLeft' && kids && open) toggle(f.relDir)
          else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const sib = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling
            sib?.focus()
          }
        }}
      >
        <span class="tree-name" style=${`--depth:${f.depth}`}>
          ${kids
            ? html`<button type="button" class=${cx('tree-twisty', open && 'is-open')} tabindex="-1" aria-label=${open ? 'Recolher' : 'Expandir'} onClick=${(e) => { e.stopPropagation(); toggle(f.relDir) }}>
                <${Icon} name="chevron-right" size=${12} strokeWidth=${2} />
              </button>`
            : html`<span class="tree-twisty"></span>`}
          <${FileIcon} isFolder size=${22} />
          <span class="name" title=${f.relDir || f.name}>${f.name}</span>
        </span>
        <${MiniStack} f=${f} />
        <span class="tree-text">${folderText(f)}</span>
        <span class="tree-badge"><${Pill} tone=${badge.tone} icon=${badge.icon}>${badge.label}</${Pill}></span>
        <span class="tree-action">
          ${pend > 0 && f.missing > 0
            ? html`<button type="button" class="chip-btn" disabled=${busy} onClick=${(e) => { e.stopPropagation(); onUpload(f) }}><${Icon} name="upload" size=${13} /> Subir esta pasta</button>`
            : null}
        </span>
      </div>`
    })}
  </div>`
}

const FileRow = ({ f }) => {
  const st = STATUS[f.status] || STATUS.missing
  const size = f.local?.size ?? f.remote?.size
  let detail = f.relDir || ''
  if (f.status === 'elsewhere' && f.remote?.path) detail = `Já está em: ${f.remote.path}`
  else if (f.status === 'different') {
    detail = f.note || (f.local && f.remote ? `No computador ${bytes(f.local.size)} · no Drive ${bytes(f.remote.size)}` : 'Conteúdo diferente')
    if (f.relDir) detail = `${f.relDir} — ${detail}`
  } else if (f.note) detail = `${f.relDir ? f.relDir + ' — ' : ''}${f.note}`
  return html`<div class=${cx('frow', `is-${f.status}`)}>
    <${FileIcon} name=${f.name} size=${28} />
    <div class="frow-main">
      <span class="name" title=${f.relPath}>${f.name}</span>
      ${detail ? html`<span class="path" title=${detail}>${detail}</span>` : null}
    </div>
    <span class="frow-size">${bytes(size)}</span>
    <span class="frow-status"><${Pill} tone=${st.tone} icon=${st.icon}>${st.label}</${Pill}></span>
  </div>`
}

function Results({ jobId, result, onReset }) {
  const now = useNow(30_000)
  const roots = useLocalRoots()
  const [folder, setFolder] = useState(null)
  const [status, setStatus] = useState('all')
  const [includeDiff, setIncludeDiff] = useState(false)
  const [limit, setLimit] = useState(200)
  const [busy, setBusy] = useState(false)
  const listRef = useRef(null)
  const s = result.summary

  useEffect(() => setLimit(200), [folder, status])

  const filtered = useMemo(() => {
    return result.files.filter((f) => (folder == null || inDir(f.relDir, folder)) && (status === 'all' || f.status === status || (status === 'synced' && f.status === 'elsewhere')))
  }, [result, folder, status])

  const counts = useMemo(() => {
    const c = { all: 0, missing: 0, different: 0, 'only-drive': 0, synced: 0, elsewhere: 0 }
    for (const f of result.files) {
      if (folder != null && !inDir(f.relDir, folder)) continue
      c.all++
      c[f.status] = (c[f.status] || 0) + 1
    }
    return c
  }, [result, folder])

  const upCount = s.missing + (includeDiff ? s.different : 0)
  const upBytes = s.missingBytes + (includeDiff ? s.differentBytes : 0)

  const upload = async ({ relDirs, statuses } = {}) => {
    const st = statuses || (includeDiff ? ['missing', 'different'] : ['missing'])
    if (st.includes('different')) {
      const ok = await confirmDialog({
        title: 'Substituir os diferentes no Drive?',
        message: `${plural(s.different, 'arquivo diferente vai', 'arquivos diferentes vão')} ganhar uma nova versão no Drive com o conteúdo deste computador. O Google guarda a versão anterior no histórico.`,
        confirmLabel: 'Subir e substituir',
      })
      if (!ok) return
    }
    setBusy(true)
    const res = await attempt(api.post(`/api/compare/${enc(jobId)}/upload`, { statuses: st, ...(relDirs ? { relDirs } : {}) }))
    setBusy(false)
    announceBatch(res, 'para enviar')
  }

  const download = async () => {
    setBusy(true)
    const res = await attempt(api.post(`/api/compare/${enc(jobId)}/download`, folder != null && folder !== '' ? { relDirs: [folder] } : {}))
    setBusy(false)
    announceBatch(res, 'para baixar')
  }

  const pickTile = (id) => {
    setStatus(id)
    requestAnimationFrame(() => listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const allGood = s.missing === 0 && s.different === 0
  const folderName = folder == null ? null : folder === '' ? result.folders.find((f) => f.relDir === '')?.name || baseName(result.localPath) : folder
  const chips = [
    { value: 'all', label: 'Todos' },
    { value: 'missing', label: 'Falta subir' },
    { value: 'different', label: 'Diferentes' },
    { value: 'only-drive', label: 'Só no Drive' },
    { value: 'synced', label: 'Já no Drive' },
  ].map((c) => ({ ...c, count: c.value === 'synced' ? counts.synced + counts.elsewhere : counts[c.value] }))

  return html`<div class="cmp-results">
    <div class="cmp-meta">
      <div>
        <h2>${baseName(result.localPath)}</h2>
        <p class="sub">
          <span class="mono-path">${tildify(result.localPath, roots?.home)}</span>
          <${Icon} name="compare" size=${13} />
          <span class="mono-path">${result.drive?.path || result.drive?.name}</span>
        </p>
      </div>
      <div class="cmp-meta-right">
        <${Pill} tone="neutral">${result.mode === 'deep' ? 'Completo · MD5' : 'Rápido · nome e tamanho'}</${Pill}>
        <span class="sub">comparado ${relTime(result.createdAt, now)}</span>
        <${Button} size="sm" variant="ghost" icon="x" onClick=${onReset}>Fechar</${Button}>
      </div>
    </div>

    <${Tiles} summary=${s} files=${result.files} onPick=${pickTile} active=${status} />
    ${s.elsewhere
      ? html`<p class="cmp-note"><${Icon} name="info" size=${14} /> ${plural(s.elsewhere, 'arquivo já está', 'arquivos já estão')} no Drive, mas em outra pasta — contam como “Já no Drive”.
          <button type="button" class="link" onClick=${() => pickTile('synced')}>Ver quais</button></p>`
      : null}

    <section class=${cx('card cmp-actions', allGood && 'is-good')}>
      ${allGood
        ? html`<div class="cmp-good">
            <span class="cmp-good-icon"><${Icon} name="circle-check" size=${22} /></span>
            <div><b>Tudo daqui já está no Drive.</b><span class="sub">${s.onlyDrive ? `O Drive ainda tem ${plural(s.onlyDrive, 'arquivo', 'arquivos')} que não estão neste computador.` : 'As duas pastas batem.'}</span></div>
          </div>`
        : html`<div class="cmp-primary">
            <${Button} variant="primary" size="lg" icon="upload" onClick=${() => upload()} loading=${busy} disabled=${!upCount}>
              Subir o que falta · ${plural(upCount, 'arquivo', 'arquivos')} · ${bytes(upBytes)}
            </${Button}>
            ${s.different
              ? html`<label class="check-label">
                  <${Checkbox} checked=${includeDiff} onChange=${setIncludeDiff} label="Incluir os diferentes" />
                  <span>Incluir os diferentes <span class="sub">(substitui no Drive)</span></span>
                </label>`
              : null}
          </div>`}
      ${s.onlyDrive
        ? html`<${Button} icon="download" onClick=${download} disabled=${busy}>
            Baixar o que só está no Drive · ${plural(folder ? counts['only-drive'] : s.onlyDrive, 'arquivo', 'arquivos')}
          </${Button}>`
        : null}
    </section>

    <section class="card cmp-tree">
      <header class="card-head">
        <h3>Pastas</h3>
        <span class="legend" aria-hidden="true">
          <span><i class="s-synced"></i>no Drive</span><span><i class="s-missing"></i>falta</span><span><i class="s-different"></i>diferente</span><span><i class="s-only"></i>só no Drive</span>
        </span>
      </header>
      <${FolderTree} folders=${result.folders} selected=${folder} onSelect=${setFolder} busy=${busy} onUpload=${(f) => upload({ relDirs: [f.relDir], statuses: ['missing'] })} />
    </section>

    <section class="card cmp-files" ref=${listRef}>
      <header class="card-head">
        <h3>Arquivos</h3>
        ${folderName != null
          ? html`<button type="button" class="filter-chip" onClick=${() => setFolder(null)} title="Mostrar todas as pastas">
              <${Icon} name="folder" size=${13} /> ${folderName} <${Icon} name="x" size=${12} />
            </button>`
          : null}
        <div class="card-head-right">
          <${Segmented} size="sm" label="Filtrar arquivos" value=${status} onChange=${setStatus} options=${chips.map((c) => ({ value: c.value, label: c.label, count: c.count ? count(c.count) : null }))} />
        </div>
      </header>
      ${filtered.length
        ? html`<div class="flist">
            ${filtered.slice(0, limit).map((f) => html`<${FileRow} key=${f.relPath + f.status} f=${f} />`)}
            ${filtered.length > limit
              ? html`<button type="button" class="more-row" onClick=${() => setLimit((l) => l + 200)}>Mostrar mais ${count(Math.min(200, filtered.length - limit))} <span class="sub">· de ${count(filtered.length)}</span></button>`
              : null}
          </div>`
        : html`<div class="table-msg">Nenhum arquivo com esse filtro${folderName != null ? ' nesta pasta' : ''}.</div>`}
    </section>
  </div>`
}

// ───── tela ─────

export function CompareScreen() {
  const accountId = useStore((s) => s.activeAccountId)
  const roots = useLocalRoots()
  const [local, setLocal] = usePersistentState('compare.local', null)
  const [remote, setRemote] = usePersistentState('compare.remote', null)
  const [mode, setMode] = usePersistentState('compare.mode', 'quick')
  const [jobId, setJobId] = useState(mem.jobId)
  const [result, setResult] = useState(mem.result)
  const [starting, setStarting] = useState(false)
  const [hidden, setHidden] = useState(false)
  const job = useStore((s) => (jobId ? s.compare[jobId] : null))
  const status = result ? 'done' : job?.status || (jobId ? 'running' : null)
  const failed = status === 'error' || status === 'failed' || status === 'canceled'
  const running = jobId && !result && !failed

  // ao terminar, busca o resultado completo; enquanto roda, consulta de vez em quando caso o SSE falhe
  useEffect(() => {
    if (!jobId || result) return undefined
    let alive = true
    const fetchJob = async () => {
      try {
        const res = await api.get(`/api/compare/${enc(jobId)}`)
        if (!alive) return
        setCompareJob(jobId, { status: res.status, progress: res.progress, error: res.error || null })
        if (res.result) {
          mem.result = res.result
          setResult(res.result)
        }
      } catch (err) {
        if (alive && err.status === 404) setCompareJob(jobId, { status: 'error', error: err.message })
      }
    }
    if (job?.status === 'done') fetchJob()
    const t = setInterval(fetchJob, 2500)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [jobId, result, job?.status])

  const start = async () => {
    if (!local || !remote || !accountId) return
    setStarting(true)
    const res = await attempt(api.post('/api/compare', { accountId, localPath: local, driveFolderId: remote.id, mode }))
    setStarting(false)
    if (!res?.jobId) return
    mem.jobId = res.jobId
    mem.result = null
    setCompareJob(res.jobId, { status: 'running', progress: { phase: 'local', done: 0, total: 0 } })
    setJobId(res.jobId)
    setResult(null)
    setHidden(false)
  }

  const reset = () => {
    mem.jobId = null
    mem.result = null
    setJobId(null)
    setResult(null)
  }

  const chooseLocal = async () => {
    const p = await pickLocal({ mode: 'folder', title: 'Qual pasta do computador?', confirmLabel: undefined, initialPath: local || undefined, subtitle: 'Escolha a pasta “mãe” do projeto — subpastas entram junto.' })
    if (p) setLocal(p)
  }
  const chooseRemote = async () => {
    const f = await pickDriveFolder({ accountId, title: 'Qual pasta do Drive?', initialFolderId: remote?.id || 'root' })
    if (f) setRemote(f)
  }

  return html`<div class="page page-compare">
    <header class="page-head">
      <div>
        <h1>Comparar</h1>
        <p class="page-lead">Veja o que já subiu e o que ainda falta — pasta por pasta.</p>
      </div>
    </header>

    <section class="cmp-setup">
      <div class="src-row">
        <${SourceCard}
          side="local"
          title="No computador"
          icon="laptop"
          value=${local ? baseName(local) : null}
          sub=${local ? tildify(local, roots?.home) : ''}
          onPick=${chooseLocal}
          emptyText="Escolha a pasta do projeto no seu disco"
        />
        <span class="src-vs" aria-hidden="true"><${Icon} name="compare" size=${18} /></span>
        <${SourceCard}
          side="drive"
          title="No Drive"
          icon="cloud"
          value=${remote ? remote.name : null}
          sub=${remote ? remote.path : ''}
          onPick=${chooseRemote}
          emptyText="Escolha a pasta correspondente no Drive"
        />
      </div>
      <div class="cmp-go">
        <div class="mode-pick" role="radiogroup" aria-label="Como comparar">
          ${MODES.map(
            (m) => html`<button type="button" role="radio" aria-checked=${mode === m.value ? 'true' : 'false'} class=${cx('mode-opt', mode === m.value && 'is-on')} onClick=${() => setMode(m.value)}>
              <span class="mode-radio"></span>
              <span><b>${m.label}</b> <span class="sub">· ${m.sub}</span></span>
            </button>`,
          )}
        </div>
        <${Button} variant="primary" size="lg" icon="compare" onClick=${start} loading=${starting} disabled=${!local || !remote || running}>
          ${running ? 'Comparando…' : result ? 'Comparar de novo' : 'Comparar'}
        </${Button}>
      </div>
      ${mode === 'deep' ? html`<p class="cmp-hint"><${Icon} name="info" size=${14} /> O modo completo lê cada arquivo do disco para calcular o MD5. Em pastas de vários terabytes isso leva um tempo — mas só na primeira vez.</p>` : null}
    </section>

    ${running && !hidden ? html`<${Progress} job=${job} mode=${mode} onCancel=${() => setHidden(true)} />` : null}
    ${failed
      ? html`<section class="card cmp-error" role="alert">
          <${Icon} name="warning" size=${20} />
          <div><b>A comparação não terminou.</b><span class="sub">${job?.error || 'Algo deu errado no caminho.'}</span></div>
          <${Button} onClick=${start} icon="retry">Tentar de novo</${Button}>
        </section>`
      : null}
    ${result ? html`<${Results} jobId=${jobId} result=${result} onReset=${reset} />` : null}
    ${!running && !result && !failed
      ? html`<${EmptyState}
          compact
          art=${html`<div class="cmp-art" aria-hidden="true"><span class="src-icon src-local"><${Icon} name="laptop" size=${20} /></span><span class="cmp-art-line"></span><span class="src-icon src-drive"><${Icon} name="cloud" size=${20} /></span></div>`}
          title="Escolha as duas pastas"
        >
          O SOBEDESCE cruza os nomes${mode === 'deep' ? ' e o conteúdo' : ' e tamanhos'} e mostra, pasta por pasta, o que já está no Drive e o que falta subir.
        </${EmptyState}>`
      : null}
  </div>`
}
