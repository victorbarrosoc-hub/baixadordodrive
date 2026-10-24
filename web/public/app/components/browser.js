// Aba Drive: navegar no Meu Drive, Compartilhados comigo e Drives compartilhados, em grade com miniaturas ou em
// lista; ordenar e filtrar por tipo (chips abaixo da busca), buscar por nome, puxar para atualizar e carregar mais ao
// rolar. Os arquivos ._ do Mac ficam ocultos (com a opção de mostrar ou mandar para a lixeira, com confirmação).
// Tocar num arquivo abre a prévia; segurar o dedo (ou o botão direito do mouse) abre o menu do item.
import { html, useEffect, useMemo, useRef, useState } from '../vendor/preact-htm.js'
import {
  FILTERS,
  SCOPES,
  SORTS,
  autoView,
  filterById,
  folderSizes,
  getPrefs,
  isFolder,
  isMacJunk,
  kindOf,
  knownProxy,
  listDrives,
  listPage,
  macJunkIn,
  macJunkTrash,
  matchesFilter,
  needsAll,
  savePrefs,
  serverSort,
  sortChip,
  sortLocal,
  target,
} from '../lib/browse.js'
import { sizeIsBig } from '../lib/tamanho.js'
import { Scrub, gradeDe } from './scrub.js'
import { BarraSelecao, Marca, useSegurar, useSelecao } from './selecao.js'
import { bytes, count, duration, plural, shortDate } from '../lib/format.js'
import { Vazio } from './kit.js'
import { Icon } from './icons.js'
import { Button, SheetHead, cx, reducedMotion } from './ui.js'
import { Preview } from './preview.js'
import { Thumb } from './thumb.js'
import { FileName } from './queue.js'
import { CopyButton } from './copiar.js'
import { MY_DRIVE, closeSheet, getState, openSheet, pushRecent, setState, setTab, toast, useApp } from '../lib/state.js'
import { framesDoDrive } from './criar.js'
import { engine } from '../lib/uploader.js'
import { isIOS } from '../lib/platform.js'
import { LAN } from '../lib/config.js'

// Listas já abertas (voltar para uma pasta não pisca). Vale enquanto a página está aberta.
const lists = new Map()
/** Esquece as listas guardadas de uma pasta (recebeu algo pelo "Mover para…": abre de novo atualizada). */
function esquecer(id) {
  for (const k of [...lists.keys()]) if (k.includes(JSON.stringify(id))) lists.delete(k)
}
// Carregar a pasta toda sozinho (ordem por tipo, "Somar tudo") vai até aqui.
const AUTO_MAX = 3000

// ───── tamanho das pastas (lib/tamanho.js) ─────

const isLive = (v) => v?.status === 'running' || v?.status === 'queued'
const total = (n) => bytes(n, { precise: true })

/** Re-renderiza quando alguma conta de tamanho muda. */
function useFolderSizes() {
  const [, force] = useState(0)
  useEffect(() => folderSizes.subscribe(() => force((n) => n + 1)), [])
}

/** "412,3 GB" pronto; ao vivo, o que já somou. Para o "Pasta · …" das linhas e dos quadros. */
function sizeShort(v) {
  if (!v) return ''
  if (v.status === 'done') return total(v.bytes)
  if (v.status === 'stopped') return `≥ ${bytes(v.bytes)}`
  if (isLive(v)) return v.bytes ? `${bytes(v.bytes)}…` : 'calculando…'
  return ''
}

const folderMeta = (f, base) => {
  const s = sizeShort(folderSizes.get(target(f).id))
  return s ? `${base} · ${s}` : base
}

/**
 * Linha do topo da pasta aberta: "412,3 GB · 1.234 arquivos em 56 pastas" (começa sozinha ao abrir). Com um filtro
 * ligado, a linha mostra o total do filtro (FilterTotal) e esta fica escondida (`hide`), mas a conta segue andando.
 */
function FolderSize({ folder, driveId, active, hide }) {
  useFolderSizes()
  const v = folderSizes.get(folder.id)
  useEffect(() => {
    if (!active) return
    folderSizes.focus(folder.id)
    folderSizes.start({ id: folder.id, driveId: driveId || folder.driveId || null }, { auto: true })
  }, [folder.id, active, !v])
  // Saiu da aba Drive: a conta que andava é esquecida (volta a contar ao abrir de novo).
  useEffect(() => () => folderSizes.focus(null), [])
  useEffect(() => {
    if (!active) folderSizes.focus(null)
  }, [active])
  const again = () => folderSizes.start({ id: folder.id, driveId: driveId || folder.driveId || null }, { refresh: true })
  if (!v || hide) return null
  if (isLive(v)) {
    const big = sizeIsBig(v)
    return html`<div class="dsize is-live" role="status">
      <span class="spinner dsize-spin" aria-hidden="true"></span>
      <span class="dsize-text">Calculando… ${count(v.files)}${big ? '+' : ''} ${v.files === 1 ? 'arquivo' : 'arquivos'} · <b>${bytes(v.bytes)}${big ? '…+' : ''}</b></span>
      ${big ? html`<button type="button" class="dsize-act" onClick=${() => folderSizes.stop(folder.id)}>Parar</button>` : null}
    </div>`
  }
  if (v.status === 'done') {
    return html`<div class="dsize">
      <span class="dsize-text"><b>${total(v.bytes)}</b> · ${plural(v.files, 'arquivo', 'arquivos')}${v.folders ? ` em ${plural(v.folders, 'pasta', 'pastas')}` : ''}${v.docs ? html`<br /><small>Documentos do Google não contam</small>` : null}</span>
      <button type="button" class="dsize-act is-icon" onClick=${again} aria-label="Recalcular o tamanho"><${Icon} name="refresh" size=${16} strokeWidth=${2} /></button>
    </div>`
  }
  if (v.status === 'stopped') {
    return html`<div class="dsize">
      <span class="dsize-text">Pelo menos <b>${bytes(v.bytes)}</b> · ${count(v.files)}+ arquivos</span>
      <button type="button" class="dsize-act" onClick=${again}>Continuar</button>
    </div>`
  }
  return html`<div class="dsize is-error">
    <span class="dsize-text">${v.error || 'Não consegui somar esta pasta.'}</span>
    <button type="button" class="dsize-act" onClick=${again}>Tentar de novo</button>
  </div>`
}

function metaOf(f, kind) {
  if (kind === 'folder') return f.isDrive ? 'Drive compartilhado' : folderMeta(f, 'Pasta')
  if (kind === 'gdoc') return shortDate(f.modifiedTime) || 'Documento do Google'
  const parts = []
  if (f.size != null) parts.push(bytes(Number(f.size)))
  const date = shortDate(f.modifiedTime)
  if (date) parts.push(date)
  return parts.join(' · ')
}

/** Bruto sem miniatura (BRAW, R3D…): usa a do proxy, se ele já é conhecido. */
const thumbSource = (f, kind, siblings) => (kind === 'video' && !f.thumbnailLink ? knownProxy(f, siblings) || f : f)

let avisouSemTira = 0
/** O vídeo ainda não tem a tira de quadros (é o computador que gera, junto do proxy). No máximo a cada 20 s. */
function avisarSemTira() {
  if (Date.now() - avisouSemTira < 20_000) return
  avisouSemTira = Date.now()
  toast('Este vídeo ainda não tem a prévia de arrastar. Selecione e toque em Gerar proxy: o computador cria.', { ms: 6000 })
}

function Tile({ f, siblings, onOpen, selecionando = false, marcado = false, onMarcar, onMenu }) {
  const kind = kindOf(f)
  const dur = f.videoMediaMetadata?.durationMillis
  // Miniatura de vídeo: arrastar para os lados corre o take (sem segurar; o "voltar" sai de fora dela). Sem a tira
  // de quadros, o arrasto explica de onde ela vem. Segurar e soltar seleciona.
  const [toqueX, setToqueX] = useState(null)
  const video = kind === 'video'
  const tira = video && Boolean(gradeDe(f))
  // Segurar e soltar: o menu do item (com a seleção ligada, marca e desmarca).
  const gesto = useSegurar({
    onSegurar: onMarcar ? () => (selecionando || !onMenu ? onMarcar(f) : onMenu(f)) : null,
    onMenu: onMenu && !selecionando ? () => onMenu(f) : null,
    onArrastar: tira ? setToqueX : video ? (x) => x != null && avisarSemTira() : null,
    direto: video,
  })
  return html`<li>
    <button
      type="button"
      class=${cx('tile', selecionando && 'is-selecting', marcado && 'is-marked', kind === 'video' && 'is-video', isFolder(f) && 'is-pasta')}
      ref=${gesto.ref}
      onPointerDown=${gesto.onPointerDown}
      onPointerMove=${gesto.onPointerMove}
      onPointerUp=${gesto.onPointerUp}
      onPointerCancel=${gesto.onPointerCancel}
      onClickCapture=${gesto.onClickCapture}
      onContextMenu=${gesto.onContextMenu}
      onClick=${() => (selecionando ? onMarcar?.(f) : onOpen(f))}
      aria-pressed=${selecionando ? (marcado ? 'true' : 'false') : undefined}
      aria-label=${`${f.name}${kind === 'folder' ? ', pasta' : ''}`}
    >
      <span class=${cx('tile-media', video && 'arrasta')} data-noswipe=${video ? '' : undefined}>
        <${Thumb} file=${f} from=${thumbSource(f, kind, siblings)} px=${128} kind=${kind} />
        ${kind === 'video' ? html`<${Scrub} f=${f} toqueX=${toqueX} />` : null}
        ${dur ? html`<span class="tile-badge">${duration(dur)}</span>` : null}
        ${kind === 'video' && !dur && f.thumbnailLink ? html`<span class="tile-badge is-icon"><${Icon} name="play" size=${10} /></span>` : null}
        ${selecionando ? html`<${Marca} on=${marcado} />` : null}
      </span>
      ${kind === 'folder' ? html`<span class="tile-name">${f.name}</span>` : html`<${FileName} name=${f.name} class="tile-name is-file" />`}
      <span class="tile-meta">${kind === 'folder' ? (f.isDrive ? 'Drive' : folderMeta(f, 'Pasta')) : f.size != null ? bytes(Number(f.size)) : shortDate(f.modifiedTime)}</span>
    </button>
  </li>`
}

function Row({ f, siblings, onOpen, driveId, selecionando = false, marcado = false, onMarcar, onMenu }) {
  const kind = kindOf(f)
  const dur = f.videoMediaMetadata?.durationMillis
  // Pasta: "Calcular" ao lado soma o que tem dentro (sob pedido; o Drive não guarda o tamanho de pastas).
  const t = kind === 'folder' && !f.isDrive ? target(f) : null
  const calc = !selecionando && t && !folderSizes.get(t.id)
  const gesto = useSegurar({
    onSegurar: onMarcar ? () => (selecionando || !onMenu ? onMarcar(f) : onMenu(f)) : null,
    onMenu: onMenu && !selecionando ? () => onMenu(f) : null,
  })
  return html`<li class=${calc ? 'has-calc' : undefined}>
    <button
      type="button"
      class=${cx('lrow', selecionando && 'is-selecting', marcado && 'is-marked', kind === 'video' && 'is-video', isFolder(f) && 'is-pasta')}
      ref=${gesto.ref}
      onPointerDown=${gesto.onPointerDown}
      onPointerMove=${gesto.onPointerMove}
      onPointerUp=${gesto.onPointerUp}
      onPointerCancel=${gesto.onPointerCancel}
      onClickCapture=${gesto.onClickCapture}
      onContextMenu=${gesto.onContextMenu}
      onClick=${() => (selecionando ? onMarcar?.(f) : onOpen(f))}
      aria-pressed=${selecionando ? (marcado ? 'true' : 'false') : undefined}
    >
      ${selecionando ? html`<${Marca} on=${marcado} />` : null}
      <span class="lrow-media"><${Thumb} file=${f} from=${thumbSource(f, kind, siblings)} px=${48} kind=${kind} small /></span>
      <span class="lrow-text">
        <${FileName} name=${f.name} class="lrow-name" />
        <span class="lrow-meta">${metaOf(f, kind)}${dur ? html` · <span class="tc">${duration(dur)}</span>` : null}</span>
      </span>
      ${kind === 'folder' && !selecionando ? html`<${Icon} name="chevron-right" size=${16} strokeWidth=${2} class="lrow-chev" />` : null}
    </button>
    ${calc
      ? html`<button type="button" class="lrow-calc" onClick=${() => folderSizes.start({ id: t.id, driveId: driveId || f.driveId || null })} aria-label=${`Calcular o tamanho de ${f.name}`}>
          Calcular
        </button>`
      : null}
  </li>`
}

/**
 * Destino de envio para a pasta aberta na aba Drive, no mesmo formato do seletor de destino (lib/state.js MY_DRIVE):
 * caminho a partir da raiz do drive. Em "Comigo" o caminho começa na pasta compartilhada.
 */
function destOf(scope, path) {
  const folder = path[path.length - 1]
  if (!folder) return null
  const trail = path.map((p) => ({ id: p.id, name: p.name }))
  return {
    id: folder.id,
    name: folder.name,
    driveId: scope === 'drives' ? path[0].id : folder.driveId || null,
    path: scope === 'mine' ? [...MY_DRIVE.path, ...trail] : trail,
  }
}

/**
 * "Enviar aqui": a pasta aberta vira o destino e o seletor de arquivos abre na hora (o toque no rótulo é o gesto que
 * o iPhone exige). Escolhidos os arquivos, a fila começa e o app vai para a aba Início, onde se vê o andamento.
 */
export function enviarPara(files, dest) {
  const account = getState().user?.emailAddress
  setState({ dest })
  pushRecent(dest, account)
  const r = engine.addFiles(files, dest)
  setTab('send')
  const n = r.added + r.resumed
  if (n) toast(n === 1 ? `Enviando para ${dest.name}` : `${n} arquivos indo para ${dest.name}`, { tone: 'success' })
  if (r.dupes) toast(r.dupes === 1 ? 'Esse arquivo já está na fila' : `${r.dupes} arquivos já estavam na fila`)
}

function SendHere({ scope, path }) {
  const dest = destOf(scope, path)
  if (!dest) return null
  const id = 'drive-send-input'
  const onChange = (e) => {
    const files = [...(e.currentTarget.files || [])]
    e.currentTarget.value = ''
    if (!files.length) return
    enviarPara(files, dest)
  }
  return html`<span class="dhere">
    <input id=${id} class="offscreen" type="file" multiple onChange=${onChange} />
    <label for=${id} class="btn btn-sm dhere-btn" aria-label=${`Enviar arquivos para ${dest.name}`}>
      <${Icon} name="upload" size=${16} strokeWidth=${2} /><span>Enviar aqui</span>
    </label>
  </span>`
}

function SkeletonGrid({ view }) {
  const n = view === 'grid' ? 12 : 8
  return html`<ul class=${cx(view === 'grid' ? 'tiles' : 'group lrows', 'is-skeleton')} aria-hidden="true">
    ${Array.from({ length: n }, (_, i) =>
      view === 'grid'
        ? html`<li key=${i}><span class="tile"><span class="tile-media skeleton"></span><span class="skeleton skeleton-line" style=${`width:${55 + ((i * 23) % 35)}%`}></span></span></li>`
        : html`<li key=${i}><span class="lrow"><span class="lrow-media skeleton"></span><span class="skeleton skeleton-line" style=${`width:${40 + ((i * 17) % 40)}%`}></span></span></li>`,
    )}
  </ul>`
}

/**
 * Lista de um lugar: primeira página, mais páginas ao rolar e recarregar. A chave leva a ordem que vai para o Drive
 * (a ordem por tipo é feita aqui e não muda a chave) e o filtro por tipo (o `q` muda). more({ big }) pede páginas de
 * 200 (quando a tela precisa da pasta toda ou está procurando o que o filtro esconde).
 */
function useListing(where, prefs, filter) {
  const srv = serverSort(prefs.sort, prefs.flip)
  const key = JSON.stringify([where.scope, where.folder?.id || null, where.driveId || null, where.search || '', srv.sort, srv.flip, filter])
  const [st, setSt] = useState(() => lists.get(key) || { files: null, next: null, loading: true, error: null })
  const ctl = useRef(null)
  const keyRef = useRef(key)
  keyRef.current = key

  const put = (k, patch) => {
    const merged = { ...(lists.get(k) || { files: null, next: null }), ...patch }
    lists.set(k, merged)
    if (keyRef.current === k) setSt(merged)
  }

  const load = (k, { more = false, big = false } = {}) => {
    const cur = lists.get(k) || {}
    if (more && (!cur.next || cur.loadingMore)) return
    ctl.current?.abort()
    const c = new AbortController()
    ctl.current = c
    put(k, more ? { loadingMore: true, error: null } : { loading: true, error: null })
    const atDrivesRoot = where.scope === 'drives' && !where.folder && !where.search
    const p = atDrivesRoot
      ? listDrives(c.signal).then((files) => ({ files, next: null }))
      : listPage(where, { sort: srv.sort, flip: srv.flip, filter, pageToken: more ? cur.next : undefined, pageSize: big ? 200 : undefined, signal: c.signal })
    return p.then(
      (r) => {
        if (c.signal.aborted) return
        put(k, { files: more ? [...(cur.files || []), ...r.files] : r.files, next: r.next, loading: false, loadingMore: false, error: null, at: Date.now() })
      },
      (err) => {
        if (c.signal.aborted) return
        put(k, { loading: false, loadingMore: false, error: err })
      },
    )
  }

  useEffect(() => {
    const cached = lists.get(key)
    if (cached?.files) {
      setSt(cached)
      // Lista antiga (mais de 2 min): atualiza por trás, sem esqueleto.
      if (Date.now() - (cached.at || 0) > 120_000) load(key)
    } else {
      setSt({ files: null, next: null, loading: true, error: null })
      load(key)
    }
    return () => ctl.current?.abort()
  }, [key])

  return {
    ...st,
    reload: () => load(key),
    more: (opts) => load(key, { more: true, ...opts }),
    /** Tira itens (foram para a lixeira) de todas as listas guardadas, sem recarregar. */
    drop: (ids) => {
      const gone = new Set(ids)
      for (const [k, v] of lists) if (v.files) lists.set(k, { ...v, files: v.files.filter((f) => !gone.has(f.id)) })
      if (lists.get(keyRef.current)) setSt(lists.get(keyRef.current))
    },
  }
}

function SortMenu({ prefs, onChange, onClose }) {
  useEffect(() => {
    const onDoc = (e) => !e.target.closest('.sort-menu, .sort-btn') && onClose()
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('pointerdown', onDoc, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDoc, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [])
  return html`<div class="sort-menu" role="menu" aria-label="Ordenar por">
    <p class="sort-menu-label">Ordenar por</p>
    ${Object.entries(SORTS).map(([id, s]) => {
      const on = prefs.sort === id
      return html`<button
        type="button"
        role="menuitemradio"
        aria-checked=${on ? 'true' : 'false'}
        class=${cx('sort-opt', on && 'is-on')}
        onClick=${() => {
          onChange(on ? { flip: !prefs.flip } : { sort: id, flip: false })
          if (!on) onClose()
        }}
      >
        <span class="sort-check">${on ? html`<${Icon} name="check" size=${16} strokeWidth=${2.2} />` : null}</span>
        <span class="sort-text">${s.label}<small>${s.hint[on && prefs.flip ? 1 : 0]}</small></span>
        ${on ? html`<${Icon} name=${prefs.flip ? 'chevron-up' : 'chevron-down'} size=${15} strokeWidth=${2} />` : null}
      </button>`
    })}
    <p class="sort-menu-foot">Toque de novo para inverter. Pastas sempre primeiro.</p>
  </div>`
}

/** Chips abaixo da busca: a ordem atual (abre o menu) e o filtro por tipo. A fileira rola de lado. */
function DriveTools({ prefs, filter, menu, setMenu, onPrefs, onFilter }) {
  return html`<div class="dtools">
    <div class="dchips">
      <button
        type="button"
        class=${cx('dchip sort-btn', menu && 'is-open')}
        onClick=${() => setMenu(!menu)}
        aria-haspopup="menu"
        aria-expanded=${menu ? 'true' : 'false'}
        aria-label=${`Ordem: ${sortChip(prefs.sort, prefs.flip)}. Mudar a ordem`}
      >
        <${Icon} name="chevron-updown" size=${15} strokeWidth=${2} />
        <span>${sortChip(prefs.sort, prefs.flip)}</span>
      </button>
      <span class="dchips-sep" aria-hidden="true"></span>
      <div class="dchips-group" role="radiogroup" aria-label="Mostrar">
        ${FILTERS.map(
          (x) => html`<button
            type="button"
            role="radio"
            aria-checked=${filter === x.id ? 'true' : 'false'}
            class=${cx('dchip', filter === x.id && 'is-on')}
            onClick=${() => onFilter(x.id)}
          >
            <span>${x.label}</span>
          </button>`,
        )}
      </div>
    </div>
    ${menu ? html`<${SortMenu} prefs=${prefs} onChange=${onPrefs} onClose=${() => setMenu(false)} />` : null}
  </div>`
}

/** Soma do que está à mostra: "12 vídeos · 380 GB". Sem a pasta toda carregada, diz "até aqui" e oferece somar tudo. */
function filterSummary(files, filter) {
  const x = filterById(filter)
  const n = files.length
  const sum = files.reduce((t, f) => t + (isFolder(f) ? 0 : Number(f.size) || 0), 0)
  const hasSize = files.some((f) => !isFolder(f) && f.size != null)
  return { label: `${count(n)} ${n === 1 ? x.one : x.many}`, size: hasSize ? total(sum) : null }
}

function FilterTotal({ files, filter, partial, busy, onAll }) {
  const { label, size } = filterSummary(files, filter)
  return html`<div class="dsize">
    <span class="dsize-text"><b>${label}</b>${size ? html` · ${size}` : null}${partial ? html` <small>até aqui</small>` : null}</span>
    ${partial
      ? busy
        ? html`<span class="spinner dsize-spin" aria-label="Somando"></span>`
        : html`<button type="button" class="dsize-act" onClick=${onAll}>Somar tudo</button>`
      : null}
  </div>`
}

/** Linha discreta dos arquivos do Mac: "38 arquivos do Mac ocultos · Mostrar · Limpar". */
function MacLine({ n, more, shown, onToggle, onClean }) {
  if (!n) return null
  const what = `${count(n)}${more ? '+' : ''} ${n === 1 ? 'arquivo' : 'arquivos'} do Mac`
  return html`<div class="dmac">
    <${Icon} name=${shown ? 'eye' : 'eye-off'} size=${15} strokeWidth=${1.9} />
    <span class="dmac-text">${shown ? `${what} à mostra` : `${what} ${n === 1 ? 'oculto' : 'ocultos'}`}</span>
    <button type="button" class="dmac-act" onClick=${onToggle}>${shown ? 'Ocultar' : 'Mostrar'}</button>
    ${onClean ? html`<button type="button" class="dmac-act" onClick=${onClean}>Limpar</button>` : null}
  </div>`
}

/**
 * Folha de confirmação: arquivos ._ desta pasta para a lixeira do Drive. Procura na pasta toda (não só no que a tela
 * carregou), mostra quantos e quanto, e só mexe depois do toque em "Mover para a lixeira". Fechar no meio para de
 * mandar os próximos (os que já foram ficam na lixeira, recuperáveis).
 */
export function MacJunkSheet({ folder, driveId, onDone }) {
  const [st, setSt] = useState({ phase: 'scan' })
  const ctl = useRef(null)
  useEffect(() => {
    const c = new AbortController()
    ctl.current = c
    macJunkIn(folder, { driveId, signal: c.signal }).then(
      (items) => !c.signal.aborted && setSt({ phase: 'ready', items }),
      (err) => !c.signal.aborted && setSt({ phase: 'error', error: err }),
    )
    return () => c.abort()
  }, [])

  const run = async () => {
    const items = st.items.filter((f) => f.canTrash)
    setSt({ ...st, phase: 'busy', done: 0, total: items.length })
    const r = await macJunkTrash(items, {
      signal: ctl.current.signal,
      onProgress: (p) => !ctl.current.signal.aborted && setSt((cur) => ({ ...cur, done: p.done })),
    })
    // Mesmo parada no meio (folha fechada), a tela tira da lista os que já foram.
    if (r.moved.length) onDone?.(r.moved)
    if (ctl.current.signal.aborted) return
    setSt({ ...st, phase: 'done', result: { ...r, refused: r.refused + (st.items.length - items.length) } })
  }

  const head = (title, right) => html`<${SheetHead}
    title=${title}
    left=${st.phase === 'done' ? null : html`<button type="button" class="link-btn" onClick=${closeSheet}>${st.phase === 'busy' ? 'Parar' : 'Cancelar'}</button>`}
    right=${right}
  />`
  const explain = html`<p class="rexplain">
    Esses são arquivos de controle do Mac (._) que vieram junto com os originais. Os vídeos não são afetados. Vão para a lixeira do Drive e podem ser recuperados por 30 dias.
  </p>`

  if (st.phase === 'scan') {
    return html`${head('Arquivos do Mac')}
      <div class="sheet-body rsheet">
        ${explain}
        <div class="mjunk-wait" role="status"><span class="spinner" aria-hidden="true"></span> Procurando os arquivos ._ em “${folder.name}”…</div>
      </div>`
  }
  if (st.phase === 'error') {
    return html`${head('Arquivos do Mac')}
      <div class="sheet-body rsheet">
        <div class="ritem is-error"><${Icon} name="warning" size=${22} /><div><b>Não consegui ler a pasta</b><p>${st.error?.status === 0 ? 'Sem conexão com o Google. Confira a internet.' : 'Tente de novo daqui a pouco.'}</p></div></div>
      </div>`
  }
  const items = st.items || []
  const can = items.filter((f) => f.canTrash)
  if (st.phase === 'ready') {
    if (!items.length) {
      return html`${head('Arquivos do Mac')}
        <div class="sheet-body rsheet">
          <div class="ritem is-ok"><${Icon} name="circle-check" size=${22} /><div><b>Nada para limpar</b><p>Não há arquivos ._ pequenos nesta pasta. Os .DS_Store só ficam ocultos.</p></div></div>
        </div>`
    }
    const sample = items[0].name
    return html`${head(`${count(items.length)} ${items.length === 1 ? 'arquivo' : 'arquivos'} do Mac`)}
      <div class="sheet-body rsheet">
        ${explain}
        <div class="mjunk-list">
          <span class="mono">${sample}</span>
          <span>${items.length > 1 ? `e mais ${count(items.length - 1)} · ` : ''}${total(items.reduce((t, f) => t + f.size, 0))} no total</span>
        </div>
        ${can.length < items.length
          ? html`<p class="group-foot mjunk-warn">${can.length ? `${count(items.length - can.length)} deles você não pode mover: falta permissão nesta pasta.` : 'Você não tem permissão para mover estes arquivos para a lixeira. Peça a quem é dono da pasta (ou a quem gerencia o Drive compartilhado).'}</p>`
          : null}
        ${can.length
          ? html`<${Button} variant="secondary" class="btn-block btn-lg is-danger" icon="trash" onClick=${run}>
              ${`Mover ${can.length === 1 ? '1 arquivo' : `${count(can.length)} arquivos`} para a lixeira`}
            </${Button}>
            <p class="group-foot rdel-foot">Só os que começam com “._” e têm menos de 4 MB.</p>`
          : null}
      </div>`
  }
  if (st.phase === 'busy') {
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0
    return html`${head('Movendo para a lixeira')}
      <div class="sheet-body rsheet">
        <div class="mjunk-prog" role="progressbar" aria-valuemin="0" aria-valuemax=${st.total} aria-valuenow=${st.done} aria-label="Movendo para a lixeira">
          <span style=${`width:${pct}%`}></span>
        </div>
        <p class="mjunk-count">${count(st.done)} de ${count(st.total)}</p>
      </div>`
  }
  const r = st.result
  const n = r.moved.length
  const refusedText = r.refused
    ? `${count(r.refused)} não ${r.refused === 1 ? 'foi' : 'foram'}: sem permissão nesta pasta. Num Drive compartilhado, só quem gerencia o conteúdo pode mandar para a lixeira.`
    : null
  return html`${head(n ? 'Pronto' : 'Não deu', html`<button type="button" class="link-btn is-strong" onClick=${closeSheet}>OK</button>`)}
    <div class="sheet-body rsheet">
      <div class=${cx('ritem', n ? 'is-ok' : 'is-error')}>
        <${Icon} name=${n ? 'circle-check' : 'warning'} size=${22} />
        <div>
          <b>${n ? `${n === 1 ? '1 arquivo foi' : `${count(n)} arquivos foram`} para a lixeira do Drive` : 'Nenhum arquivo foi para a lixeira'}</b>
          <p>${[n ? 'Dá para recuperar por 30 dias, na lixeira do Drive.' : null, refusedText, r.failed ? `${count(r.failed)} falharam (conexão). Tente de novo.` : null].filter(Boolean).join(' ')}</p>
        </div>
      </div>
    </div>`
}
MacJunkSheet.label = 'Arquivos do Mac'

/** Puxar para atualizar (a página rola no documento; só começa com a rolagem no topo). */
function usePull(ref, active, onRefresh) {
  const [pull, setPull] = useState(0)
  const [busy, setBusy] = useState(false)
  const st = useRef(null)
  const cb = useRef(onRefresh)
  cb.current = onRefresh
  useEffect(() => {
    const el = ref.current
    if (!el || !active) return
    const start = (e) => {
      if (window.scrollY > 0 || e.touches.length !== 1 || busy || e.target.closest('input, .sort-menu, .dchips')) return
      st.current = { y0: e.touches[0].clientY, x0: e.touches[0].clientX, d: 0, on: false }
    }
    const move = (e) => {
      const s = st.current
      if (!s) return
      const dy = e.touches[0].clientY - s.y0
      const dx = e.touches[0].clientX - s.x0
      if (!s.on) {
        if (dy < 8 || Math.abs(dx) > dy || window.scrollY > 0) {
          if (dy < -4 || Math.abs(dx) > 10) st.current = null
          return
        }
        s.on = true
      }
      e.preventDefault()
      s.d = Math.min(120, (dy - 8) * 0.5)
      setPull(s.d)
    }
    const end = () => {
      const s = st.current
      st.current = null
      if (!s?.on) return
      if (s.d >= 64) {
        setBusy(true)
        setPull(56)
        Promise.resolve(cb.current()).finally(() => {
          setBusy(false)
          setPull(0)
        })
      } else setPull(0)
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end)
    el.addEventListener('touchcancel', end)
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
    }
  }, [active, busy])
  return { pull, busy }
}

// ───── voltar de pasta: histórico e gesto da borda ─────
//
// Cada pasta aberta vira uma entrada do histórico (history.pushState com o caminho). Assim o gesto nativo do Safari
// e o botão voltar do Android voltam a pasta em vez de sair do app; o popstate leva à pasta da entrada. A prévia
// aberta também é uma entrada (voltar fecha). As entradas da aba Drive levam { sd: 'drive', scope, path, base }:
// `base` é a menor profundidade da corrente de entradas nossas, seguidas, logo abaixo desta (abrir uma pasta pela
// busca começa uma corrente nova). Voltar pela tela (seta, trilha, gesto) usa history.go quando a corrente está
// inteira; senão, empilha uma entrada nova (nunca volta para fora do app).
//
// useSwipeBack faz o voltar arrastando de qualquer ponto da tela para a direita, como no iPhone. A faixa da borda
// esquerda fica para o gesto do sistema (Safari, app da Tela de Início no iOS 26, Android), que vira popstate: com os
// dois juntos apareciam duas telas por trás e a pasta podia voltar duas vezes. Os dois caminhos acabam no mesmo
// history.go.

const samePath = (a, b) => a.length === b.length && a.every((p, i) => p.id === b[i].id)
const ours = (st, nav) => st?.sd === 'drive' && st.scope === nav.scope && Array.isArray(st.path) && samePath(st.path, nav.path)
const slim = (path) => path.map((p) => ({ id: p.id, name: p.name, driveId: p.driveId || null, canAdd: p.canAdd }))
const historyState = () => {
  try {
    return history.state
  } catch {
    return null
  }
}

/** Tela de toque (iPhone, iPad, Android): o arrasto vale. Com mouse, não. */
const swipeHere = () => {
  if (isIOS) return true
  try {
    return matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
}
const isStandalone = () => typeof navigator !== 'undefined' && navigator.standalone === true

const EDGE = 24 // px da borda esquerda (depois da área segura) que ficam para o gesto do sistema
// O dedo parado mais que isso antes de travar no voltar = é um segurar (seleção, correr o take), não um voltar.
const SEGURAR_ANTES_MS = 250
let safeLeftPx = null
function safeLeft() {
  if (safeLeftPx != null) return safeLeftPx
  try {
    const el = document.createElement('div')
    el.style.cssText = 'position:fixed;left:0;top:0;height:0;visibility:hidden;width:env(safe-area-inset-left,0px)'
    document.body.appendChild(el)
    safeLeftPx = el.getBoundingClientRect().width || 0
    el.remove()
  } catch {
    safeLeftPx = 0
  }
  return safeLeftPx
}

/** O toque começou em algo que usa o arrasto lateral (campo de texto, controle, faixa já rolada)? */
function ownsDrag(target) {
  for (let el = target; el && el.nodeType === 1 && el !== document.body; el = el.parentElement) {
    if (el.matches('input, textarea, select, [contenteditable="true"], [data-noswipe]')) return true
    if (el.scrollLeft > 0 && el.scrollWidth > el.clientWidth) return true // arrastar para a direita rola ela de volta
  }
  return false
}

/**
 * Arrastar para a direita, de qualquer ponto da tela, volta uma pasta. Só a faixa de EDGE px da borda esquerda fica de
 * fora (é do sistema), e o toque que ficou parado antes de andar (segurar: seleção e correr o take na miniatura). O dedo precisa andar mais para o lado do que para baixo; só então a rolagem é segurada
 * (touchmove não passivo, com preventDefault só depois de travar no gesto). Para a esquerda ou na vertical, não é com a
 * gente. A tela atual acompanha o dedo (transform direto no elemento, sem redesenhar) e a de cima aparece por trás,
 * deslocada e escurecida. Soltou depois de 35% da largura ou rápido (> 0,5 px/ms): termina com --spring e volta; senão,
 * desliza de volta. Se o sistema voltar no meio (popstate), o nosso desiste sem voltar de novo.
 * Com "reduzir movimento": nada se mexe no arrasto; ao soltar além do limite, só volta.
 */
function useSwipeBack({ enabled, screenRef, behindRef, onStart, onEnd, onBack }) {
  const cb = useRef({ onStart, onEnd, onBack })
  cb.current = { onStart, onEnd, onBack }
  useEffect(() => {
    if (!enabled) return
    let g = null
    let anim = null // a tela deslizando depois de soltar
    const W = () => window.innerWidth || 390
    const paint = (dx) => {
      const el = screenRef.current
      const bh = behindRef.current
      const p = Math.max(0, Math.min(1, dx / W()))
      if (el) el.style.transform = dx > 0 ? `translate3d(${dx}px,0,0)` : ''
      if (bh) {
        bh.style.transform = `translate3d(${(-30 * (1 - p)).toFixed(2)}%,0,0)`
        const dim = bh.querySelector('.dswipe-dim')
        if (dim) dim.style.opacity = String((1 - p).toFixed(3))
      }
    }
    const transition = (on) => {
      const v = on ? 'transform 0.38s var(--spring), opacity 0.38s var(--spring)' : ''
      if (screenRef.current) screenRef.current.style.transition = v
      if (behindRef.current) {
        behindRef.current.style.transition = v
        const dim = behindRef.current.querySelector('.dswipe-dim')
        if (dim) dim.style.transition = v
      }
    }
    const reset = () => {
      transition(false)
      const el = screenRef.current
      if (el) {
        el.style.transform = ''
        el.classList.remove('is-swiping')
      }
      document.documentElement.classList.remove('is-dswipe')
      cb.current.onEnd()
    }
    const start = (e) => {
      if (g || e.touches.length !== 1) return
      const t = e.touches[0]
      if (t.clientX <= safeLeft() + EDGE) return
      if (document.documentElement.classList.contains('has-sheet')) return
      if (ownsDrag(e.target)) return
      g = { x0: t.clientX, y0: t.clientY, t0: performance.now(), dx: 0, on: false, samples: [{ x: t.clientX, t: performance.now() }] }
    }
    const move = (e) => {
      if (!g) return
      const t = e.touches[0]
      const dx = t.clientX - g.x0
      const dy = t.clientY - g.y0
      if (!g.on) {
        // Segurou antes de andar (o segurar e arrastar da miniatura, a seleção): não é voltar. O voltar de verdade sai
        // andando na hora; o gesto da miniatura também marca o evento (preventDefault) quando é dele.
        if (e.defaultPrevented) return void (g = null)
        if (!g.andou && Math.hypot(dx, dy) > 10) {
          if (performance.now() - g.t0 > SEGURAR_ANTES_MS) return void (g = null)
          g.andou = true
        }
        if (dx < -10 || (Math.abs(dy) > 10 && Math.abs(dy) > dx)) return void (g = null) // para a esquerda ou rolagem
        if (dx < 12 || dx < Math.abs(dy) * 1.4) return
        g.on = true
        g.reduced = reducedMotion()
        g.x0 = t.clientX - 1 // sem salto: o arrasto começa de onde travou
        screenRef.current?.classList.add('is-swiping')
        document.documentElement.classList.add('is-dswipe')
        cb.current.onStart()
      }
      e.preventDefault()
      g.dx = Math.max(0, t.clientX - g.x0)
      const now = performance.now()
      g.samples.push({ x: t.clientX, t: now })
      while (g.samples.length > 2 && now - g.samples[0].t > 100) g.samples.shift()
      if (!g.reduced) paint(g.dx)
    }
    const end = (e) => {
      const cur = g
      g = null
      if (!cur?.on) return
      const s0 = cur.samples[0]
      const s1 = cur.samples[cur.samples.length - 1]
      const v = s1.t > s0.t ? (s1.x - s0.x) / (s1.t - s0.t) : 0
      const done = e.type !== 'touchcancel' && (cur.dx > W() * 0.35 || (v > 0.5 && cur.dx > 24))
      if (cur.reduced) {
        if (done) cb.current.onBack()
        return reset()
      }
      transition(true)
      paint(done ? W() : 0)
      const a = { over: false }
      anim = a
      const finish = () => {
        if (a.over) return
        a.over = true
        anim = null
        if (done) {
          cb.current.onBack()
          // a pasta de cima entra no lugar antes de a tela voltar para o zero (sem piscar a pasta que saiu)
          requestAnimationFrame(() => requestAnimationFrame(reset))
        } else reset()
      }
      screenRef.current?.addEventListener('transitionend', finish, { once: true })
      setTimeout(finish, 450)
    }
    // O sistema voltou (gesto da borda, botão do Android) com o nosso no meio: desiste sem voltar outra vez.
    const abort = () => {
      if (!g?.on && !anim) return
      if (anim) anim.over = true
      anim = null
      g = null
      reset()
    }
    document.addEventListener('touchstart', start, { passive: true })
    document.addEventListener('touchmove', move, { passive: false })
    document.addEventListener('touchend', end)
    document.addEventListener('touchcancel', end)
    window.addEventListener('popstate', abort)
    return () => {
      document.removeEventListener('touchstart', start)
      document.removeEventListener('touchmove', move)
      document.removeEventListener('touchend', end)
      document.removeEventListener('touchcancel', end)
      window.removeEventListener('popstate', abort)
      abort()
    }
  }, [enabled])
}

/** A pasta de cima, por trás da atual durante o gesto: o que já está carregado dela (ou o esqueleto). */
function SwipeBehind({ scope, path, prefs, innerRef }) {
  const folder = path[path.length - 1] || null
  const driveId = scope === 'drives' && path[0] ? path[0].id : null
  let files = null
  for (const [k, v] of lists) {
    let key
    try {
      key = JSON.parse(k)
    } catch {
      continue
    }
    if (key[0] !== scope || key[1] !== (folder?.id || null) || key[2] !== (driveId || null) || key[3] !== '' || !v.files) continue
    if (!files || key[6] === 'all') files = v.files
  }
  const shown = files ? files.filter((f) => !isMacJunk(f)).slice(0, 24) : null
  const view = prefs.view || (shown ? autoView(shown) : 'list')
  const title = folder ? folder.name : SCOPES.find((x) => x.id === scope)?.aria
  const size = folder ? folderSizes.get(folder.id) : null // só o que já foi somado (aqui não começa conta nenhuma)
  const noop = () => {}
  return html`<div class="dswipe-behind" ref=${innerRef} aria-hidden="true" inert>
    <div class=${cx('screen', 'drive-screen', view === 'list' && 'is-list')}>
      <header class="topbar dtop">
        <div class="dtop-row">
          ${folder ? html`<span class="icon-btn dtop-back"><${Icon} name="chevron-left" size=${22} strokeWidth=${2} /></span>` : null}
          <h1 class="dtop-title">${title}</h1>
          <div class="dtop-actions"><span class="icon-btn"><${Icon} name=${view === 'grid' ? 'list' : 'grid'} size=${20} /></span></div>
        </div>
        ${path.length
          ? html`<nav class="crumbs dcrumbs">
              <span class="crumb">${SCOPES.find((x) => x.id === scope)?.label}</span>
              ${path.map(
                (p, i) => html`<${Icon} name="chevron-right" size=${12} strokeWidth=${2} class="crumb-sep" />
                  <span class=${cx('crumb', i === path.length - 1 && 'is-here')}>${p.name}</span>`,
              )}
            </nav>`
          : html`<div class="scopes">
              ${SCOPES.map((x) => html`<span class=${cx('scope', scope === x.id && 'is-on')}>${x.label}</span>`)}
            </div>`}
        <div class="search">
          <${Icon} name="search" size=${17} />
          <input type="search" tabindex="-1" readonly placeholder=${scope === 'mine' ? 'Buscar no Drive todo' : scope === 'drives' && path[0] ? `Buscar em todo o “${path[0].name}”` : `Buscar em ${SCOPES.find((x) => x.id === scope)?.aria}`} />
        </div>
      </header>
      <main class="drive-body">
        ${scope === 'drives' && !path.length
          ? null
          : html`<${DriveTools} prefs=${prefs} filter="all" menu=${false} setMenu=${noop} onPrefs=${noop} onFilter=${noop} />`}
        ${folder
          ? html`<div class="dfolder">
              ${size?.status === 'done'
                ? html`<div class="dsize">
                    <span class="dsize-text"><b>${total(size.bytes)}</b> · ${plural(size.files, 'arquivo', 'arquivos')}${size.folders ? ` em ${plural(size.folders, 'pasta', 'pastas')}` : ''}</span>
                    <span class="dsize-act is-icon"><${Icon} name="refresh" size=${16} strokeWidth=${2} /></span>
                  </div>`
                : size && isLive(size)
                  ? html`<div class="dsize is-live"><span class="spinner dsize-spin"></span><span class="dsize-text">Calculando… <b>${bytes(size.bytes)}</b></span></div>`
                  : null}
              ${folder.canAdd !== false && destOf(scope, path)
                ? html`<span class="dhere"><span class="btn btn-sm dhere-btn"><${Icon} name="upload" size=${16} strokeWidth=${2} /><span>Enviar aqui</span></span></span>`
                : null}
            </div>`
          : null}
        ${shown
          ? view === 'grid'
            ? html`<ul class="tiles">${shown.map((f) => html`<${Tile} key=${f.id} f=${f} siblings=${files} onOpen=${noop} />`)}</ul>`
            : html`<ul class="group lrows">${shown.map((f) => html`<${Row} key=${f.id} f=${f} siblings=${files} onOpen=${noop} driveId=${driveId} />`)}</ul>`
          : html`<${SkeletonGrid} view=${view} />`}
      </main>
    </div>
    <div class="dswipe-dim"></div>
  </div>`
}

export function DriveScreen({ active }) {
  const [prefs, setPrefs] = useState(getPrefs)
  const [nav, setNav] = useState({ scope: 'mine', path: [] })
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [menu, setMenu] = useState(false)
  // Filtro por tipo e arquivos do Mac à mostra: valem para o lugar aberto (voltam ao padrão ao trocar de pasta).
  const [filter, setFilter] = useState('all')
  const [showMac, setShowMac] = useState(false)
  const [wantAll, setWantAll] = useState(false) // "Somar tudo": carregar a pasta toda
  const [preview, setPreview] = useState(null) // { files, index }
  const sel = useSelecao()
  const escolher = useApp((s) => s.escolher)
  // Saiu da aba Drive no meio da escolha: desiste dela.
  useEffect(() => {
    if (!active && escolher) setState({ escolher: null })
  }, [active])
  const root = useRef(null)
  const behindRef = useRef(null)
  const [swipe, setSwipe] = useState(false) // gesto da borda em andamento (mostra a pasta de cima por trás)
  const sentinel = useRef(null)
  const crumbsRef = useRef(null)

  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 350)
    return () => clearTimeout(t)
  }, [query])

  const folder = nav.path[nav.path.length - 1] || null
  const driveId = nav.scope === 'drives' && nav.path[0] ? nav.path[0].id : null
  const where = useMemo(() => ({ scope: nav.scope, folder: search ? null : folder, driveId, search }), [nav, search])
  const list = useListing(where, prefs, filter)
  useFolderSizes()

  // O que vai para a tela: sem os arquivos do Mac (a não ser que a pessoa peça), só o tipo escolhido e, na ordem por
  // tipo, agrupado aqui (o Drive não ordena por extensão).
  const raw = list.files || []
  const files = useMemo(() => {
    const shown = raw.filter((f) => (showMac || !isMacJunk(f)) && matchesFilter(f, filter))
    return needsAll(prefs.sort) ? sortLocal(shown, prefs.sort, prefs.flip) : shown
  }, [raw, showMac, filter, prefs.sort, prefs.flip])
  const macN = useMemo(() => raw.filter(isMacJunk).length, [raw])
  // Seleção: o que saiu da tela (busca, filtro, lixeira) sai da seleção também.
  useEffect(() => {
    if (sel.ativa) sel.manter(files)
  }, [files])

  // Carregar mais sem rolar: a ordem por tipo e o "Somar tudo" precisam da pasta toda; e quando o filtro daqui (tipo
  // pela extensão, arquivos do Mac) esconde quase tudo, uma página pode vir sem nada para mostrar: segue procurando até
  // encher a tela ou acabar a pasta. Erro para tudo (aparece "Tentar de novo"). A pasta toda só até AUTO_MAX itens
  // (uma busca no Drive todo pode ter dezenas de milhares): dali em diante, mais páginas só rolando, como sempre.
  const hidden = files.length < raw.length
  const whole = (needsAll(prefs.sort) || wantAll) && raw.length < AUTO_MAX
  const hunting = Boolean(list.next) && !list.error && !list.loading && (whole || (hidden && files.length < 24))
  useEffect(() => {
    if (hunting && !list.loadingMore) list.more({ big: true })
  }, [hunting, list.loadingMore, list.files])

  // Grade ou lista: o que a pessoa escolheu; sem escolha, pelo conteúdo (só pastas → lista; foto ou vídeo → grade).
  // Enquanto carrega, fica a vista da última pasta (o esqueleto não pula de forma).
  const lastAuto = useRef('list')
  if (list.files && files.length) lastAuto.current = autoView(files)
  const view = prefs.view || lastAuto.current
  const { pull, busy } = usePull(root, active && !preview, () => list.reload())

  useEffect(() => {
    const el = crumbsRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [nav])

  // Mais páginas ao chegar perto do fim.
  useEffect(() => {
    const el = sentinel.current
    if (!el || !list.next || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && list.more(), { rootMargin: '800px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [list.next, list.files])

  const changePrefs = (patch) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    savePrefs(next)
  }
  const changeFilter = (id) => {
    setFilter(id)
    setWantAll(false)
  }
  // Trocar de lugar sem mexer no histórico (o popstate usa direto).
  const apply = (scope, path) => {
    setNav({ scope, path })
    setQuery('')
    setSearch('')
    setFilter('all')
    setShowMac(false)
    setWantAll(false)
    setMenu(false)
    setPreview(null)
    sel.sair()
    window.scrollTo(0, 0)
  }
  const navRef = useRef(nav)
  navRef.current = nav
  const previewRef = useRef(preview)
  previewRef.current = preview
  const ignorePop = useRef(0)
  /** how: 'push' (abrir pasta: nova entrada), 'replace' (trocar de lugar na raiz) ou 'none'. */
  const go = (scope, path, how = 'push') => {
    const cur = navRef.current
    apply(scope, path)
    try {
      if (how === 'none') return
      const st = historyState()
      if (how === 'replace') return history.replaceState({ ...(st || {}), sd: 'drive', scope, path: slim(path), base: 0, preview: false }, '')
      // Uma pasta abaixo da atual continua a corrente (base de baixo); qualquer outro salto começa uma nova.
      const child = scope === cur.scope && path.length === cur.path.length + 1 && samePath(path.slice(0, -1), cur.path)
      const base = child && ours(st, cur) ? st.base : child && !cur.path.length && st?.sd !== 'drive' ? 0 : path.length
      history.pushState({ sd: 'drive', scope, path: slim(path), base }, '')
    } catch {
      // histórico indisponível: segue só na tela
    }
  }
  /** Volta para a profundidade `depth` (0 = raiz do lugar): pelo histórico quando dá, senão empilha. */
  const up = (depth) => {
    const cur = navRef.current
    if (depth < 0 || depth >= cur.path.length) return
    const st = historyState()
    if (ours(st, cur) && !st.preview && depth >= (st.base ?? cur.path.length)) {
      apply(cur.scope, cur.path.slice(0, depth))
      ignorePop.current++
      history.go(depth - cur.path.length)
      return
    }
    go(cur.scope, cur.path.slice(0, depth), 'push')
  }
  // Voltar/avançar do navegador (gesto do Safari, botão do Android): a pasta da entrada; sem entrada nossa, a raiz.
  useEffect(() => {
    const onPop = (e) => {
      if (ignorePop.current > 0) {
        ignorePop.current--
        return
      }
      const st = e.state
      const cur = navRef.current
      const scope = st?.sd === 'drive' ? st.scope : cur.scope
      const path = st?.sd === 'drive' && Array.isArray(st.path) ? st.path : []
      if (previewRef.current && !st?.preview && scope === cur.scope && samePath(path, cur.path)) return setPreview(null)
      if (scope === cur.scope && samePath(path, cur.path)) return
      apply(scope, path)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const open = (f) => {
    // Escolhendo para os Frames (aba Criar → Do Drive): tocar no vídeo leva para lá.
    if (escolher && !isFolder(f)) {
      if (kindOf(f) === 'video') framesDoDrive(f)
      else toast('Escolha um vídeo', { ms: 2000 })
      return
    }
    if (isFolder(f)) {
      const t = target(f)
      const base = search ? [] : nav.path
      // canAdd: o Google diz se dá para pôr arquivos ali (sem isso, "Enviar aqui" não aparece).
      const entry = { id: t.id, name: f.name, driveId: f.driveId || null, canAdd: Boolean(t.shortcut) || f.capabilities?.canAddChildren !== false }
      // Dentro de um resultado de busca: a pasta vira o novo começo da trilha.
      go(nav.scope, f.isDrive ? [entry] : [...base, entry])
      return
    }
    const pv = files.filter((x) => !isFolder(x))
    setPreview({ files: pv, index: Math.max(0, pv.findIndex((x) => x.id === f.id)) })
    // A prévia também é uma entrada: voltar (gesto do Safari, botão do Android) fecha ela.
    try {
      history.pushState({ ...(historyState() || {}), preview: true }, '')
    } catch {
      // segue sem
    }
  }
  const closePreview = () => {
    setPreview(null)
    if (historyState()?.preview) {
      ignorePop.current++
      history.back()
    }
  }
  // No app da Tela de Início, a página não balança para os lados (o arrasto de voltar é o único movimento lateral).
  useEffect(() => {
    if (isIOS && isStandalone()) document.documentElement.classList.add('is-ios-app')
  }, [])
  const marcar = (f) => sel.alternar(f.id)
  // Segurar um item: o menu dele (components/item-menu.js). A pasta que vira destino de envio e onde o "Mover para…" abre
  // seguem o caminho de agora (numa busca, a pasta achada começa a trilha).
  const abrirMenu = (f) => {
    if (escolher) return
    const t = target(f)
    const pasta = isFolder(f)
    const entry = { id: t.id, name: f.name, driveId: f.driveId || null }
    const base = search || f.isDrive ? [] : nav.path
    const podeEnviar = pasta && (Boolean(t.shortcut) || f.capabilities?.canAddChildren !== false)
    openSheet('itemMenu', {
      f,
      driveId,
      onAbrir: () => open(f),
      onSelecionar: () => sel.alternar(f.id),
      dest: podeEnviar ? destOf(nav.scope, [...base, entry]) : null,
      inicio: folder && !search ? destOf(nav.scope, nav.path) : null,
      onMudou: ({ removidos, destId, recarregar } = {}) => {
        if (removidos?.length) list.drop(removidos)
        if (destId) esquecer(destId)
        if (recarregar) list.reload()
        if (folder && removidos?.length) folderSizes.start({ id: folder.id, driveId: driveId || folder.driveId || null }, { refresh: true })
      },
    })
  }
  const canSwipe = active && !preview && !sel.ativa && !search && nav.path.length > 0 && swipeHere()
  useSwipeBack({
    enabled: canSwipe,
    screenRef: root,
    behindRef,
    onStart: () => setSwipe(true),
    onEnd: () => setSwipe(false),
    onBack: () => up(navRef.current.path.length - 1),
  })
  const cleanMac =
    folder && !search
      ? () =>
          openSheet('macJunk', {
            folder: { id: folder.id, name: folder.name, driveId: driveId || folder.driveId || null },
            driveId: driveId || folder.driveId || null,
            onDone: (ids) => {
              list.drop(ids)
              folderSizes.start({ id: folder.id, driveId: driveId || folder.driveId || null }, { refresh: true })
            },
          })
      : null

  const scopeLabel = SCOPES.find((s) => s.id === nav.scope)?.aria
  const title = search ? 'Busca' : folder ? folder.name : scopeLabel
  // A busca não fica na pasta aberta: em Meu Drive procura em tudo o que a conta vê; num Drive compartilhado, nele todo.
  const placeholder =
    nav.scope === 'mine' ? 'Buscar no Drive todo' : nav.scope === 'drives' && nav.path[0] ? `Buscar em todo o “${nav.path[0].name}”` : `Buscar em ${scopeLabel}`
  const atDrivesRoot = nav.scope === 'drives' && !nav.path.length && !search
  const filtering = filter !== 'all'
  const done = !list.loading && !list.error && Boolean(list.files)
  const empty = done && !raw.length
  // Tem coisa no lugar, mas o filtro (ou o ocultar do Mac) esconde tudo e a pasta já acabou.
  const emptyHere = done && raw.length > 0 && !files.length && !list.next
  const partial = Boolean(list.next)
  const huntNote = hunting || (list.loadingMore && (whole || hidden))
  const huntText = needsAll(prefs.sort) ? 'Carregando a pasta toda para agrupar por tipo…' : wantAll ? 'Somando tudo…' : 'Procurando…'

  return html`${swipe ? html`<${SwipeBehind} scope=${nav.scope} path=${nav.path.slice(0, -1)} prefs=${prefs} innerRef=${behindRef} />` : null}
  <div class=${cx('screen', 'drive-screen', view === 'list' && 'is-list', sel.ativa && 'is-selecting', escolher && 'is-escolhendo')} ref=${root}>
    <header class="topbar dtop">
      ${escolher
        ? html`<div class="escolher-faixa" role="status">
            <${Icon} name="sparkle" size=${16} />
            <span><b>Escolha o vídeo para os Frames</b><small>Abra a pasta e toque no vídeo</small></span>
            <button type="button" class="link-btn" onClick=${() => (setState({ escolher: null }), setTab('criar'))}>Cancelar</button>
          </div>`
        : null}
      <div class="dtop-row">
        ${nav.path.length && !search
          ? html`<button type="button" class="icon-btn dtop-back" onClick=${() => up(nav.path.length - 1)} aria-label="Voltar">
              <${Icon} name="chevron-left" size=${22} strokeWidth=${2} />
            </button>`
          : null}
        <h1 class="dtop-title">${title}</h1>
        <div class="dtop-actions">
          ${LAN
            ? null
            : html`<${CopyButton}
                dest=${nav.scope !== 'shared' && !search ? destOf(nav.scope, nav.path) : null}
                source=${nav.scope === 'shared' && !search ? nav.path[nav.path.length - 1] || null : null}
              />`}
          <button
            type="button"
            class="icon-btn"
            onClick=${() => changePrefs({ view: view === 'grid' ? 'list' : 'grid' })}
            aria-label=${view === 'grid' ? 'Ver em lista' : 'Ver em grade'}
          >
            <${Icon} name=${view === 'grid' ? 'list' : 'grid'} size=${20} />
          </button>
        </div>
      </div>
      ${nav.path.length && !search
        ? html`<nav class="crumbs dcrumbs" aria-label="Caminho" ref=${crumbsRef}>
            <button type="button" class="crumb" onClick=${() => up(0)}>${SCOPES.find((s) => s.id === nav.scope)?.label}</button>
            ${nav.path.map(
              (p, i) => html`<${Icon} name="chevron-right" size=${12} strokeWidth=${2} class="crumb-sep" />
                <button
                  type="button"
                  class=${cx('crumb', i === nav.path.length - 1 && 'is-here')}
                  onClick=${() => up(i + 1)}
                  aria-current=${i === nav.path.length - 1 ? 'location' : undefined}
                >
                  ${p.name}
                </button>`,
            )}
          </nav>`
        : html`<div class="scopes" role="tablist" aria-label="Lugares">
            ${SCOPES.map(
              (s) => html`<button
                type="button"
                role="tab"
                aria-selected=${nav.scope === s.id ? 'true' : 'false'}
                aria-label=${s.aria}
                class=${cx('scope', nav.scope === s.id && 'is-on')}
                onClick=${() => go(s.id, [], 'replace')}
              >
                ${s.label}
              </button>`,
            )}
          </div>`}
      <label class="search">
        <${Icon} name="search" size=${17} />
        <input
          type="search"
          placeholder=${placeholder}
          aria-label=${placeholder}
          value=${query}
          enterkeyhint="search"
          autocomplete="off"
          autocorrect="off"
          spellcheck=${false}
          onInput=${(e) => setQuery(e.currentTarget.value)}
          onKeyDown=${(e) => e.key === 'Enter' && (setSearch(query.trim()), e.currentTarget.blur())}
        />
        ${query
          ? html`<button type="button" class="search-x" onClick=${() => go(nav.scope, nav.path, 'none')} aria-label="Limpar busca">
              <${Icon} name="circle-x" size=${17} />
            </button>`
          : null}
      </label>
    </header>

    <div class=${cx('ptr', (pull > 0 || busy) && 'is-on')} style=${`height:${pull}px`} aria-hidden=${busy ? undefined : 'true'}>
      <span class=${cx('ptr-spin', busy && 'is-busy')} style=${`transform:rotate(${pull * 4}deg);opacity:${Math.min(1, pull / 56)}`}>
        <${Icon} name="refresh" size=${18} strokeWidth=${2} />
      </span>
      ${busy ? html`<span class="offscreen" role="status">Atualizando</span>` : null}
    </div>

    <main class="drive-body" aria-busy=${list.loading ? 'true' : 'false'}>
      ${atDrivesRoot
        ? null
        : html`<${DriveTools} prefs=${prefs} filter=${filter} menu=${menu} setMenu=${setMenu} onPrefs=${changePrefs} onFilter=${changeFilter} />`}
      ${folder && !search
        ? html`<div class="dfolder">
            <${FolderSize} folder=${folder} driveId=${driveId} active=${active} hide=${filtering} />
            ${filtering && list.files
              ? html`<${FilterTotal} files=${files} filter=${filter} partial=${partial} busy=${wantAll || hunting} onAll=${() => setWantAll(true)} />`
              : null}
            ${folder.canAdd !== false ? html`<${SendHere} scope=${nav.scope} path=${nav.path} />` : null}
          </div>`
        : null}
      ${search
        ? html`<p class="drive-note">
            ${list.loading
              ? 'Buscando…'
              : `${files.length}${list.next ? '+' : ''} ${files.length === 1 ? 'resultado' : 'resultados'} para “${search}”${filtering ? ` em ${filterById(filter).label}` : ''}`}
          </p>`
        : null}
      ${!search && !folder && filtering && list.files
        ? html`<${FilterTotal} files=${files} filter=${filter} partial=${partial} busy=${wantAll || hunting} onAll=${() => setWantAll(true)} />`
        : null}
      <${MacLine} n=${macN} more=${partial} shown=${showMac} onToggle=${() => setShowMac(!showMac)} onClean=${cleanMac} />
      ${list.loading && !list.files ? html`<${SkeletonGrid} view=${view} />` : null}
      ${list.error && !list.files
        ? html`<div class="drive-vazio is-erro" role="alert"><${Vazio}
            icone="warning"
            titulo=${list.error?.status === 0 ? 'Sem conexão com o Google' : list.error?.reconnect ? 'Reconecte o Google Drive' : 'Não consegui abrir este lugar'}
            acoes=${html`<${Button} size="sm" variant="secondary" icon="refresh" onClick=${list.reload}>Tentar de novo</${Button}>`}
          >${list.error?.reconnect ? 'O Google pediu uma nova autorização. Abra sua conta para reconectar.' : 'Confira a internet e tente de novo.'}</${Vazio}></div>`
        : null}
      ${empty
        ? html`<div class="drive-vazio"><${Vazio}
            icone=${search ? 'search' : filtering ? 'sliders' : 'folder'}
            titulo=${
              filtering
                ? filterById(filter).none
                : search
                  ? 'Nada encontrado'
                  : nav.scope === 'drives' && !nav.path.length
                    ? 'Nenhum Drive compartilhado'
                    : nav.scope === 'shared' && !nav.path.length
                      ? 'Nada compartilhado com você'
                      : 'Pasta vazia'
            }
            acoes=${filtering ? html`<${Button} size="sm" variant="secondary" onClick=${() => changeFilter('all')}>Ver tudo</${Button}>` : null}
          >${filtering ? null : search ? 'A busca procura pelo começo das palavras do nome.' : nav.scope === 'drives' && !nav.path.length ? 'Os Drives de equipe que você participa aparecem aqui.' : 'Quando chegar algo, aparece aqui.'}</${Vazio}></div>`
        : null}
      ${emptyHere
        ? html`<div class="drive-vazio"><${Vazio}
            icone=${filtering ? 'sliders' : 'laptop'}
            titulo=${filtering ? filterById(filter).none : 'Só arquivos do Mac aqui'}
            acoes=${filtering ? html`<${Button} size="sm" variant="secondary" onClick=${() => changeFilter('all')}>Ver tudo</${Button}>` : null}
          >${filtering ? null : 'Estão ocultos. Toque em Mostrar, acima, para ver.'}</${Vazio}></div>`
        : null}
      ${huntNote && !files.length ? html`<p class="drive-note dhunt" role="status"><span class="spinner" aria-hidden="true"></span>${huntText} <small>${count(raw.length)} vistos</small></p>` : null}
      ${files.length
        ? view === 'grid'
          ? html`<ul class="tiles">${files.map((f) => html`<${Tile} key=${f.id} f=${f} siblings=${raw} onOpen=${open} selecionando=${sel.ativa} marcado=${sel.tem(f.id)} onMarcar=${marcar} onMenu=${abrirMenu} />`)}</ul>`
          : html`<ul class="group lrows">${files.map((f) => html`<${Row} key=${f.id} f=${f} siblings=${raw} onOpen=${open} driveId=${driveId} selecionando=${sel.ativa} marcado=${sel.tem(f.id)} onMarcar=${marcar} onMenu=${abrirMenu} />`)}</ul>`
        : null}
      ${list.error && list.files ? html`<p class="drive-note is-error">Não consegui carregar mais. <button type="button" class="link-btn" onClick=${() => list.more()}>Tentar de novo</button></p>` : null}
      <div ref=${sentinel} class="drive-sentinel">
        ${list.loadingMore
          ? huntNote && files.length
            ? html`<span class="drive-note dhunt" role="status"><span class="spinner" aria-hidden="true"></span>${huntText} <small>${count(raw.length)} vistos</small></span>`
            : html`<span class="spinner" aria-label="Carregando mais"></span>`
          : null}
      </div>
      ${files.length && !list.next && !list.loading ? html`<p class="foot drive-foot">${files.length === 1 ? '1 item' : `${count(files.length)} itens`}</p>` : null}
    </main>

    ${sel.ativa && !preview
      ? html`<${BarraSelecao}
          sel=${sel}
          visiveis=${files}
          onSair=${sel.sair}
          onRemovidos=${(ids) => {
            list.drop(ids)
            if (folder) folderSizes.start({ id: folder.id, driveId: driveId || folder.driveId || null }, { refresh: true })
          }}
        />`
      : null}
    ${preview
      ? html`<${Preview}
          files=${preview.files}
          index=${preview.index}
          onIndex=${(i) => setPreview({ ...preview, index: i })}
          onClose=${closePreview}
          album=${folder?.name || scopeLabel}
        />`
      : null}
  </div>`
}
