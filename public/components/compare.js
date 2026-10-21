// Tela Comparar: pasta do computador × pasta do Drive. Mostra o que já subiu, o que falta e o que
// só existe no Drive, pasta por pasta, com atalhos para subir/baixar a diferença.
// "Entre discos" (discos.js): cartão/SSD → outros discos, comparando antes e conferindo o checksum.
// Visual no padrão do kit (docs/UI-KIT.md): passos numerados, resumo colorido ao lado e o botão grande.
import { html, useEffect, useMemo, useRef, useState } from '/vendor/preact-htm.js'
import { useStore, setCompareJob } from '../lib/store.js'
import { api, attempt, enc } from '../lib/api.js'
import { bytes, count, plural, relTime, tildify, baseName, dirOf } from '../lib/format.js'
import { cx, usePersistentState, useNow } from '../lib/ui.js'
import { announceBatch } from '../lib/actions.js'
import { pickDriveFolder, confirmDialog } from '../lib/modals.js'
import { bridge, pickFolderPath } from '../lib/desktop.js'
import { Icon } from './icons.js'
import { Button, Checkbox, FileIcon, Pill } from './common.js'
import { Barra, BotaoGrande, Destaque, Opcoes, Pagina, Passo, Pilulas, Resumo } from './kit.js'
import { useLocalRoots } from './local-picker.js'
import { DiscosPanel } from './discos.js'
import { Fonte, Rota } from './comparar-partes.js'

// lembra a última comparação enquanto o app está aberto (trocar de tela não perde o resultado)
const mem = { jobId: null, result: null, startedAt: null }

const MODES = [
  { value: 'quick', titulo: 'Rápido', sub: 'Nome e tamanho, em segundos', icone: 'bolt' },
  { value: 'deep', titulo: 'Completo', sub: 'Confere o conteúdo de cada arquivo (MD5)', icone: 'shield' },
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

// ───── a escolha do modo (em cima, nos dois modos) ─────

const TIPOS = [
  { value: 'drive', titulo: 'Computador × Drive', sub: 'O que já subiu e o que ainda falta', icone: 'cloud' },
  { value: 'discos', titulo: 'Entre discos', sub: 'Cartão ou SSD para outro disco, conferido', icone: 'disk', up: true },
]

function Modo({ tipo, setTipo }) {
  return html`<div class="k-entra" style="--i:1"><${Opcoes} label="O que comparar" valor=${tipo} onEscolher=${setTipo} itens=${TIPOS} colunas=${2} /></div>`
}

// ───── progresso ─────

function Progresso({ job, mode, onEsconder, onCancelar }) {
  const p = job?.progress || {}
  const phases = PHASES.filter((x) => !x.deepOnly || mode === 'deep')
  const idx = Math.max(0, phases.findIndex((x) => x.id === p.phase))
  return html`<${Passo} icone="refresh" cor="down" titulo="Comparando" frase="Pode usar o resto do app enquanto isso: a comparação continua." i=${4} acao=${html`<div class="cp-acoes-topo"><${Button} variant="ghost" size="sm" onClick=${onEsconder}>Esconder</${Button}><${Button} size="sm" icon="x" onClick=${onCancelar}>Cancelar</${Button}></div>`}>
    <ol class="cp-fases" aria-live="polite">
      ${phases.map((ph, i) => {
        const state = i < idx ? 'done' : i === idx ? 'now' : 'next'
        const frac = state === 'now' && p.total ? Math.min(1, (p.done || 0) / p.total) : state === 'done' ? 1 : 0
        return html`<li class=${cx('cp-fase', `is-${state}`)}>
          <span class="cp-fase-dot">${state === 'done' ? html`<${Icon} name="check" size=${12} strokeWidth=${2.4} />` : i + 1}</span>
          <div class="cp-fase-corpo">
            <div class="cp-fase-tit">
              <span>${ph.label}</span>
              ${state === 'now' && p.total ? html`<span class="sub num">${count(p.done || 0)} de ${count(p.total)}</span>` : null}
            </div>
            ${state === 'now' ? html`<${Barra} p=${p.total ? frac : null} label=${ph.label} />` : null}
            ${state === 'now' && p.current ? html`<div class="cp-fase-atual mono-path" title=${p.current}>${p.current}</div>` : null}
          </div>
        </li>`
      })}
    </ol>
  </${Passo}>`
}

/** 0–1: quanto da comparação já andou (fases feitas + a fração da atual). */
function andou(job, mode) {
  const p = job?.progress || {}
  const phases = PHASES.filter((x) => !x.deepOnly || mode === 'deep')
  const idx = Math.max(0, phases.findIndex((x) => x.id === p.phase))
  const frac = p.total ? Math.min(1, (p.done || 0) / p.total) : 0
  return Math.min(1, (idx + frac) / phases.length)
}

// ───── resultado ─────

function Numeros({ summary, files, onPick, active }) {
  const syncedBytes = useMemo(() => files.reduce((a, f) => a + (f.status === 'synced' || f.status === 'elsewhere' ? f.local?.size || 0 : 0), 0), [files])
  const tiles = [
    { id: 'synced', label: 'Já no Drive', n: summary.synced + (summary.elsewhere || 0), b: syncedBytes, tom: 'ok', icon: 'check' },
    { id: 'missing', label: 'Falta subir', n: summary.missing, b: summary.missingBytes, tom: 'up', icon: 'arrow-up' },
    { id: 'different', label: 'Diferentes', n: summary.different, b: summary.differentBytes, tom: 'warn', icon: 'warning' },
    { id: 'only-drive', label: 'Só no Drive', n: summary.onlyDrive, b: summary.onlyDriveBytes, tom: 'down', icon: 'cloud' },
  ]
  return html`<div class="k-stats cp-stats" style="--n:4">
    ${tiles.map(
      (t, i) => html`<button
        type="button"
        class=${cx('k-stat cp-stat', t.tom !== 'down' && `is-${t.tom}`, active === t.id && 'is-on', !t.n && 'is-zero')}
        style=${`--i:${i}`}
        onClick=${() => onPick(active === t.id ? 'all' : t.id)}
        aria-pressed=${active === t.id ? 'true' : 'false'}
      >
        <span class="k-stat-ic"><${Icon} name=${t.icon} size=${15} strokeWidth=${2} /></span>
        <b class="num">${count(t.n || 0)}</b>
        <span>${t.label}${t.n ? html` · <span class="num">${bytes(t.b || 0)}</span>` : null}</span>
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
  if (onlyOnDrive(f)) return `${plural(f.files, 'arquivo', 'arquivos')} só no Drive`
  if (!f.missing && !f.different) {
    return f.onlyDrive ? `${plural(f.files, 'arquivo', 'arquivos')} · ${count(f.onlyDrive)} só no Drive` : `${plural(f.files, 'arquivo', 'arquivos')} · tudo no Drive`
  }
  const parts = []
  if (f.missing) parts.push(`${f.missing === 1 ? 'falta' : 'faltam'} ${count(f.missing)}${f.different ? '' : ` de ${count(f.files)}`}`)
  if (f.different) parts.push(`${count(f.different)} ${f.different === 1 ? 'diferente' : 'diferentes'}${f.missing ? '' : ` de ${count(f.files)}`}`)
  if (f.missingBytes) parts.push(bytes(f.missingBytes))
  return parts.join(' · ')
}

const onlyOnDrive = (f) => f.files > 0 && f.onlyDrive === f.files

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
  return html`<div class="tree cp-tree" role="tree" aria-label="Pastas">
    ${rows.map((f) => {
      const open = !collapsed.has(f.relDir)
      const kids = hasKids.has(f.relDir)
      const badge = onlyOnDrive(f) ? { label: 'Só no Drive', tone: 'neutral', icon: 'cloud' } : STATE_BADGE[f.state] || STATE_BADGE.partial
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

function Resultado({ result, onLimpar, busy, includeDiff, setIncludeDiff, onUpload, onDownload }) {
  const now = useNow(30_000)
  const roots = useLocalRoots()
  const [folder, setFolder] = useState(null)
  const [status, setStatus] = useState('all')
  const [limit, setLimit] = useState(60)
  const listRef = useRef(null)
  const s = result.summary

  useEffect(() => setLimit(60), [folder, status])

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

  const pickTile = (id) => {
    setStatus(id)
    requestAnimationFrame(() => listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const folderName = folder == null ? null : folder === '' ? result.folders.find((f) => f.relDir === '')?.name || baseName(result.localPath) : folder
  const chips = [
    { value: 'all', label: 'Todos' },
    { value: 'missing', label: 'Falta subir' },
    { value: 'different', label: 'Diferentes' },
    { value: 'only-drive', label: 'Só no Drive' },
    { value: 'synced', label: 'Já no Drive' },
  ].map((c) => {
    const n = c.value === 'synced' ? counts.synced + counts.elsewhere : counts[c.value]
    return { value: c.value, label: c.label, conta: n ? count(n) : null }
  })

  return html`
    <${Passo}
      id="cp-resultado"
      icone="compare"
      cor="up"
      titulo=${baseName(result.localPath)}
      sub=${`comparado ${relTime(result.createdAt, now)}`}
      frase=${html`<span class="cp-par"><span class="mono-path">${tildify(result.localPath, roots?.home)}</span><${Icon} name="arrow-right" size=${12} /><span class="mono-path">${result.drive?.path || result.drive?.name}</span></span>`}
      i=${5}
      acao=${html`<div class="cp-acoes-topo"><${Pill} tone="neutral">${result.mode === 'deep' ? 'Completo · MD5' : 'Rápido'}</${Pill}><${Button} size="sm" icon="trash" onClick=${onLimpar}>Limpar comparação</${Button}></div>`}
    >
      <${Numeros} summary=${s} files=${result.files} onPick=${pickTile} active=${status} />
      ${s.elsewhere
        ? html`<p class="k-nota"><${Icon} name="info" size=${14} /> ${plural(s.elsewhere, 'arquivo já está', 'arquivos já estão')} no Drive, mas em outra pasta: contam como “Já no Drive”.
            <button type="button" class="link" onClick=${() => pickTile('synced')}>Ver quais</button></p>`
        : null}
      ${s.proxies
        ? html`<p class="k-nota"><${Icon} name="film" size=${14} /> ${plural(s.proxies, 'proxy gerado', 'proxies gerados')} pelo SOBEDESCE (pasta Proxy) ${s.proxies === 1 ? 'ficou' : 'ficaram'} de fora do “Só no Drive”.</p>`
        : null}
      ${s.different || s.onlyDrive
        ? html`<div class="cp-extras">
            ${s.different
              ? html`<label class="cp-check">
                  <${Checkbox} checked=${includeDiff} onChange=${setIncludeDiff} label="Incluir os diferentes" />
                  <span><b>Incluir os diferentes</b><span class="sub"> · ganham uma versão nova no Drive</span></span>
                </label>`
              : null}
            ${s.onlyDrive
              ? html`<${Button} icon="download" onClick=${() => onDownload(folder)} disabled=${busy}>
                  Baixar o que só está no Drive · ${plural(folder ? counts['only-drive'] : s.onlyDrive, 'arquivo', 'arquivos')}
                </${Button}>`
              : null}
          </div>`
        : null}
    </${Passo}>

    <${Passo}
      icone="folder"
      cor="down"
      titulo="Pastas"
      frase="Toque numa pasta para ver só os arquivos dela."
      i=${6}
      acao=${html`<span class="legend" aria-hidden="true">
        <span><i class="s-synced"></i>no Drive</span><span><i class="s-missing"></i>falta</span><span><i class="s-different"></i>diferente</span><span><i class="s-only"></i>só no Drive</span>
      </span>`}
    >
      <${FolderTree} folders=${result.folders} selected=${folder} onSelect=${setFolder} busy=${busy} onUpload=${(f) => onUpload({ relDirs: [f.relDir], statuses: ['missing'] })} />
    </${Passo}>

    <div ref=${listRef} class="cp-ancora">
      <${Passo}
        icone="doc"
        cor="down"
        titulo="Arquivos"
        sub=${folderName != null ? null : `${count(filtered.length)} de ${count(counts.all)}`}
        i=${7}
        acao=${folderName != null
          ? html`<button type="button" class="filter-chip" onClick=${() => setFolder(null)} title="Mostrar todas as pastas">
              <${Icon} name="folder" size=${13} /> ${folderName} <${Icon} name="x" size=${12} />
            </button>`
          : null}
      >
        <${Pilulas} label="Filtrar arquivos" valor=${status} onEscolher=${setStatus} itens=${chips} />
        ${filtered.length
          ? html`<div class="flist cp-flist">
              ${filtered.slice(0, limit).map((f) => html`<${FileRow} key=${f.relPath + f.status} f=${f} />`)}
              ${filtered.length > limit
                ? html`<button type="button" class="more-row" onClick=${() => setLimit((l) => l + 200)}>Mostrar mais ${count(Math.min(200, filtered.length - limit))} <span class="sub">· de ${count(filtered.length)}</span></button>`
                : null}
            </div>`
          : html`<p class="k-nota cp-vazio-lista">Nenhum arquivo com esse filtro${folderName != null ? ' nesta pasta' : ''}.</p>`}
      </${Passo}>
    </div>`
}

// ───── tela ─────

export function CompareScreen() {
  const [tipo, setTipo] = usePersistentState('compare.tipo', 'drive')
  const topo = html`<${Modo} tipo=${tipo} setTipo=${setTipo} />`
  if (tipo === 'discos') return html`<${DiscosPanel} topo=${topo} />`
  return html`<${CompareDrive} topo=${topo} />`
}

function CompareDrive({ topo }) {
  const accountId = useStore((s) => s.activeAccountId)
  const roots = useLocalRoots()
  const [local, setLocal] = usePersistentState('compare.local', null)
  const [remote, setRemote] = usePersistentState('compare.remote', null)
  const [mode, setMode] = usePersistentState('compare.mode', 'quick')
  const [jobId, setJobId] = useState(mem.jobId)
  const [result, setResult] = useState(mem.result)
  const [starting, setStarting] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [includeDiff, setIncludeDiff] = useState(false)
  const [busy, setBusy] = useState(false)
  const job = useStore((s) => (jobId ? s.compare[jobId] : null))
  const status = result ? 'done' : job?.status || (jobId ? 'running' : null)
  const failed = status === 'error' || status === 'failed' || status === 'canceled'
  const canceled = status === 'canceled'
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

  // O resultado aparece embaixo dos passos: quando chega, a tela rola até ele.
  const temResultado = !!result
  useEffect(() => {
    if (temResultado && mem.rolar) {
      mem.rolar = false
      requestAnimationFrame(() => document.getElementById('cp-resultado')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  }, [temResultado])

  const start = async () => {
    if (!local || !remote || !accountId) return
    setStarting(true)
    const res = await attempt(api.post('/api/compare', { accountId, localPath: local, driveFolderId: remote.id, mode }))
    setStarting(false)
    if (!res?.jobId) return
    mem.jobId = res.jobId
    mem.result = null
    mem.rolar = true
    setCompareJob(res.jobId, { status: 'running', progress: { phase: 'local', done: 0, total: 0 } })
    setJobId(res.jobId)
    setResult(null)
    setHidden(false)
    setIncludeDiff(false)
  }

  // Cancelar: o motor para de ler (e de calcular o MD5) na hora; a tela mostra "cancelada".
  const cancelar = () => jobId && attempt(api.del(`/api/compare/${enc(jobId)}`))

  // Limpar: apaga o resultado (memória e disco do motor) e as duas pastas escolhidas; volta ao passo 1 vazio.
  const limpar = async () => {
    const id = jobId
    mem.jobId = null
    mem.result = null
    setJobId(null)
    setResult(null)
    setHidden(false)
    setIncludeDiff(false)
    setLocal(null)
    setRemote(null)
    requestAnimationFrame(() => document.querySelector('.page-compare')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    if (id) await attempt(api.post(`/api/compare/${enc(id)}/limpar`, {}))
  }

  const chooseLocal = async () => {
    const p = await pickFolderPath({ title: 'Qual pasta do computador?', defaultPath: local || undefined, subtitle: 'Escolha a pasta “mãe” do projeto: as subpastas entram junto.' })
    if (p) setLocal(p)
  }
  const chooseRemote = async () => {
    const f = await pickDriveFolder({ accountId, title: 'Qual pasta do Drive?', initialFolderId: remote?.id || 'root' })
    if (f) setRemote(f)
  }

  const s = result?.summary
  const upCount = s ? s.missing + (includeDiff ? s.different : 0) : 0
  const upBytes = s ? s.missingBytes + (includeDiff ? s.differentBytes : 0) : 0
  const allGood = s && s.missing === 0 && s.different === 0

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

  const download = async (folder) => {
    setBusy(true)
    const res = await attempt(api.post(`/api/compare/${enc(jobId)}/download`, folder != null && folder !== '' ? { relDirs: [folder] } : {}))
    setBusy(false)
    announceBatch(res, 'para baixar')
  }

  // ── coluna da direita: o que vai acontecer / agora / resultado, e o botão grande ──
  let destaque = null
  if (running) {
    const p = andou(job, mode)
    const fase = PHASES.find((x) => x.id === job?.progress?.phase)
    destaque = html`<${Destaque} titulo="Comparando" numero=${Math.floor(p * 100)} unidade="%" progresso=${p} linha=${fase?.label || 'Começando'} vivo />`
  } else if (canceled) {
    destaque = html`<${Destaque} tom="erro" titulo="Cancelada" linha="Nada foi gravado. Compare de novo quando quiser." />`
  } else if (failed) {
    destaque = html`<${Destaque} tom="erro" titulo="Não terminou" linha=${job?.error || 'Algo deu errado no caminho.'} />`
  } else if (s && allGood) {
    destaque = html`<${Destaque} tom="ok" titulo="Tudo no Drive" numero=${count(s.synced + (s.elsewhere || 0))} unidade=${s.synced + (s.elsewhere || 0) === 1 ? 'arquivo já está lá' : 'arquivos já estão lá'} linha=${s.onlyDrive ? `O Drive ainda tem ${plural(s.onlyDrive, 'arquivo', 'arquivos')} que não estão aqui.` : 'As duas pastas batem.'} />`
  } else if (s) {
    destaque = html`<${Destaque} titulo="Falta subir" numero=${count(upCount)} unidade=${upCount === 1 ? 'arquivo' : 'arquivos'} linha=${`${bytes(upBytes)}${s.different && !includeDiff ? ` · ${plural(s.different, 'diferente', 'diferentes')} de fora` : ''}`} />`
  }

  const dica = !local ? 'Falta escolher a pasta do computador' : !remote ? 'Falta escolher a pasta do Drive' : mode === 'deep' ? 'Confere o conteúdo de cada arquivo (MD5)' : 'Cruza nomes e tamanhos, pasta por pasta'
  const botao =
    s && !allGood
      ? html`<${BotaoGrande} icone="upload" onClick=${() => upload()} disabled=${busy || !upCount} dica=${html`<b>${plural(upCount, 'arquivo', 'arquivos')}</b> · ${bytes(upBytes)} vão para a fila de Transferências`}>Subir o que falta</${BotaoGrande}>
          <${Button} icon="compare" onClick=${start} loading=${starting} disabled=${!local || !remote || running} class="cp-de-novo">Comparar de novo</${Button}>`
      : html`<${BotaoGrande} icone="compare" onClick=${start} disabled=${!local || !remote || running || starting} dica=${running ? 'Comparando…' : dica}>${running || starting ? 'Comparando…' : result || failed ? 'Comparar de novo' : 'Comparar'}</${BotaoGrande}>`
  const extra = running
    ? html`<${Button} icon="x" onClick=${cancelar} class="cp-lado-btn">Cancelar a comparação</${Button}>`
    : result || failed || local || remote
      ? html`<${Button} icon="trash" onClick=${limpar} class="cp-lado-btn">Limpar comparação</${Button}>`
      : null

  const lado = html`<${Resumo} titulo=${result ? 'Resultado' : running ? 'Agora' : 'O que vai acontecer'}>
      ${destaque}
      <${Rota} de=${local ? baseName(local) : null} para=${remote ? remote.name : null} deIcone="laptop" paraIcone="cloud" />
      ${!result && !running
        ? html`<p class="cp-resumo-txt">${mode === 'deep' ? 'Lê cada arquivo do disco e compara o MD5 com o do Drive. Mais lento na primeira vez.' : 'Mostra, pasta por pasta, o que já está no Drive e o que falta subir.'}</p>`
        : null}
    </${Resumo}>
    ${botao}
    ${extra}`

  return html`<${Pagina}
    titulo="Comparar"
    frase="Veja o que já subiu e o que ainda falta, pasta por pasta."
    class=${cx('page-compare', (result || running || failed) && 'cp-lado-antes')}
    lado=${lado}
  >
    ${topo}
    <${Passo} n="1" titulo="De onde" sub="no computador" frase="A pasta do projeto. As subpastas entram junto." i=${2}>
      <${Fonte}
        icone="laptop"
        tom="down"
        valor=${local ? baseName(local) : null}
        caminho=${local ? tildify(local, roots?.home) : ''}
        vazio="Escolher a pasta do computador"
        dica=${bridge ? 'Ou arraste a pasta para cá' : 'A pasta do projeto no seu disco'}
        onTrocar=${chooseLocal}
        onSoltarPasta=${setLocal}
        onTirar=${local && !running ? () => setLocal(null) : null}
        tirarLabel="Tirar a pasta do computador"
      />
    </${Passo}>
    <${Passo} n="2" titulo="Para onde" sub="no Drive" frase="A pasta correspondente no Google Drive." i=${3}>
      <${Fonte} icone="cloud" tom="drive" valor=${remote ? remote.name : null} caminho=${remote ? remote.path : ''} vazio="Escolher a pasta do Drive" dica="Onde o projeto deveria estar" onTrocar=${chooseRemote} onTirar=${remote && !running ? () => setRemote(null) : null} tirarLabel="Tirar a pasta do Drive" />
    </${Passo}>
    <${Passo} n="3" titulo="Como conferir" i=${4}>
      <${Opcoes} label="Como comparar" valor=${mode} onEscolher=${setMode} itens=${MODES} colunas=${2} />
      ${mode === 'deep' ? html`<p class="k-nota"><${Icon} name="info" size=${14} /> Em pastas de vários terabytes, ler cada arquivo leva um tempo. Só na primeira vez: depois o resultado fica guardado.</p>` : null}
    </${Passo}>

    ${running && !hidden ? html`<${Progresso} job=${job} mode=${mode} onEsconder=${() => setHidden(true)} onCancelar=${cancelar} />` : null}
    ${canceled
      ? html`<${Passo} id="cp-resultado" icone="x" cor="warn" titulo="Comparação cancelada" frase="Parou no meio e nada foi gravado. Compare de novo quando quiser." i=${5} acao=${html`<div class="cp-acoes-topo"><${Button} onClick=${limpar} icon="trash">Limpar</${Button}><${Button} onClick=${start} icon="retry" disabled=${!local || !remote}>Comparar de novo</${Button}></div>`} />`
      : failed
        ? html`<${Passo} id="cp-resultado" icone="warning" cor="err" titulo="A comparação não terminou" frase=${job?.error || 'Algo deu errado no caminho.'} i=${5} acao=${html`<${Button} onClick=${start} icon="retry">Tentar de novo</${Button}>`} />`
        : null}
    ${result
      ? html`<${Resultado}
          result=${result}
          onLimpar=${limpar}
          busy=${busy}
          includeDiff=${includeDiff}
          setIncludeDiff=${setIncludeDiff}
          onUpload=${upload}
          onDownload=${download}
        />`
      : null}
  </${Pagina}>`
}
