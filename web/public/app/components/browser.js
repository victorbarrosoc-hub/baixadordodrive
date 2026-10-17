// Aba Drive: navegar no Meu Drive, Compartilhados comigo e Drives compartilhados, em grade com miniaturas ou em
// lista; ordenar, buscar por nome, puxar para atualizar e carregar mais ao rolar. Tocar num arquivo abre a prévia.
import { html, useEffect, useMemo, useRef, useState } from '../vendor/preact-htm.js'
import { SCOPES, SORTS, folderSizes, getPrefs, isFolder, kindOf, knownProxy, listDrives, listPage, savePrefs, target } from '../lib/browse.js'
import { sizeIsBig } from '../lib/tamanho.js'
import { bytes, count, duration, plural, shortDate } from '../lib/format.js'
import { Icon } from './icons.js'
import { Button, cx } from './ui.js'
import { Preview } from './preview.js'
import { KindGlyph, Thumb } from './thumb.js'
import { FileName } from './queue.js'
import { MY_DRIVE, getState, pushRecent, setState, setTab, toast } from '../lib/state.js'
import { engine } from '../lib/uploader.js'

// Listas já abertas (voltar para uma pasta não pisca). Vale enquanto a página está aberta.
const lists = new Map()

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

/** Linha do topo da pasta aberta: "412,3 GB · 1.234 arquivos em 56 pastas" (começa sozinha ao abrir). */
function FolderSize({ folder, driveId, active }) {
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
  if (!v) return null
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

function Tile({ f, siblings, onOpen }) {
  const kind = kindOf(f)
  const dur = f.videoMediaMetadata?.durationMillis
  return html`<li>
    <button type="button" class="tile" onClick=${() => onOpen(f)} aria-label=${`${f.name}${kind === 'folder' ? ', pasta' : ''}`}>
      <span class="tile-media">
        <${Thumb} file=${f} from=${thumbSource(f, kind, siblings)} px=${128} kind=${kind} />
        ${dur ? html`<span class="tile-badge">${duration(dur)}</span>` : null}
        ${kind === 'video' && !dur && f.thumbnailLink ? html`<span class="tile-badge is-icon"><${Icon} name="play" size=${10} /></span>` : null}
      </span>
      ${kind === 'folder' ? html`<span class="tile-name">${f.name}</span>` : html`<${FileName} name=${f.name} class="tile-name is-file" />`}
      <span class="tile-meta">${kind === 'folder' ? (f.isDrive ? 'Drive' : folderMeta(f, 'Pasta')) : f.size != null ? bytes(Number(f.size)) : shortDate(f.modifiedTime)}</span>
    </button>
  </li>`
}

function Row({ f, siblings, onOpen, driveId }) {
  const kind = kindOf(f)
  const dur = f.videoMediaMetadata?.durationMillis
  // Pasta: "Calcular" ao lado soma o que tem dentro (sob pedido; o Drive não guarda o tamanho de pastas).
  const t = kind === 'folder' && !f.isDrive ? target(f) : null
  const calc = t && !folderSizes.get(t.id)
  return html`<li class=${calc ? 'has-calc' : undefined}>
    <button type="button" class="lrow" onClick=${() => onOpen(f)}>
      <span class="lrow-media"><${Thumb} file=${f} from=${thumbSource(f, kind, siblings)} px=${48} kind=${kind} small /></span>
      <span class="lrow-text">
        <${FileName} name=${f.name} class="lrow-name" />
        <span class="lrow-meta">${metaOf(f, kind)}${dur ? html` · <span class="tc">${duration(dur)}</span>` : null}</span>
      </span>
      ${kind === 'folder' ? html`<${Icon} name="chevron-right" size=${16} strokeWidth=${2} class="lrow-chev" />` : null}
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
 * o iPhone exige). Escolhidos os arquivos, a fila começa e o app vai para a aba Enviar, onde se vê o andamento.
 */
function SendHere({ scope, path }) {
  const dest = destOf(scope, path)
  if (!dest) return null
  const id = 'drive-send-input'
  const onChange = (e) => {
    const files = [...(e.currentTarget.files || [])]
    e.currentTarget.value = ''
    if (!files.length) return
    const account = getState().user?.emailAddress
    setState({ dest })
    pushRecent(dest, account)
    const r = engine.addFiles(files, dest)
    setTab('send')
    const n = r.added + r.resumed
    if (n) toast(n === 1 ? `Enviando para ${dest.name}` : `${n} arquivos indo para ${dest.name}`, { tone: 'success' })
    if (r.dupes) toast(r.dupes === 1 ? 'Esse arquivo já está na fila' : `${r.dupes} arquivos já estavam na fila`)
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

/** Lista de um lugar: primeira página, mais páginas ao rolar e recarregar. */
function useListing(where, prefs) {
  const key = JSON.stringify([where.scope, where.folder?.id || null, where.driveId || null, where.search || '', prefs.sort, prefs.flip])
  const [st, setSt] = useState(() => lists.get(key) || { files: null, next: null, loading: true, error: null })
  const ctl = useRef(null)
  const keyRef = useRef(key)
  keyRef.current = key

  const put = (k, patch) => {
    const merged = { ...(lists.get(k) || { files: null, next: null }), ...patch }
    lists.set(k, merged)
    if (keyRef.current === k) setSt(merged)
  }

  const load = (k, { more = false } = {}) => {
    const cur = lists.get(k) || {}
    if (more && (!cur.next || cur.loadingMore)) return
    ctl.current?.abort()
    const c = new AbortController()
    ctl.current = c
    put(k, more ? { loadingMore: true, error: null } : { loading: true, error: null })
    const atDrivesRoot = where.scope === 'drives' && !where.folder && !where.search
    const p = atDrivesRoot
      ? listDrives(c.signal).then((files) => ({ files, next: null }))
      : listPage(where, { sort: prefs.sort, flip: prefs.flip, pageToken: more ? cur.next : undefined, signal: c.signal })
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
    more: () => load(key, { more: true }),
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
  const hint = { name: prefs.flip ? 'Z → A' : 'A → Z', date: prefs.flip ? 'Mais antigos' : 'Mais recentes', size: prefs.flip ? 'Menores' : 'Maiores' }
  return html`<div class="sort-menu" role="menu" aria-label="Ordenar por">
    <p class="sort-menu-label">Ordenar por</p>
    ${Object.entries(SORTS).map(
      ([id, s]) => html`<button
        type="button"
        role="menuitemradio"
        aria-checked=${prefs.sort === id ? 'true' : 'false'}
        class=${cx('sort-opt', prefs.sort === id && 'is-on')}
        onClick=${() => onChange(prefs.sort === id ? { flip: !prefs.flip } : { sort: id, flip: false })}
      >
        <span class="sort-check">${prefs.sort === id ? html`<${Icon} name="check" size=${16} strokeWidth=${2.2} />` : null}</span>
        <span class="sort-text">${s.label}${prefs.sort === id ? html`<small>${hint[id]}</small>` : null}</span>
        ${prefs.sort === id ? html`<${Icon} name=${prefs.flip ? 'chevron-up' : 'chevron-down'} size=${15} strokeWidth=${2} />` : null}
      </button>`,
    )}
  </div>`
}

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
      if (window.scrollY > 0 || e.touches.length !== 1 || busy || e.target.closest('input, .sort-menu')) return
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

export function DriveScreen({ active }) {
  const [prefs, setPrefs] = useState(getPrefs)
  const [nav, setNav] = useState({ scope: 'mine', path: [] })
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [menu, setMenu] = useState(false)
  const [preview, setPreview] = useState(null) // { files, index }
  const root = useRef(null)
  const sentinel = useRef(null)
  const crumbsRef = useRef(null)

  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 350)
    return () => clearTimeout(t)
  }, [query])

  const folder = nav.path[nav.path.length - 1] || null
  const driveId = nav.scope === 'drives' && nav.path[0] ? nav.path[0].id : null
  const where = useMemo(() => ({ scope: nav.scope, folder: search ? null : folder, driveId, search }), [nav, search])
  const list = useListing(where, prefs)
  useFolderSizes()
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
  const go = (scope, path) => {
    setNav({ scope, path })
    setQuery('')
    setSearch('')
    window.scrollTo(0, 0)
  }
  const open = (f) => {
    if (isFolder(f)) {
      const t = target(f)
      const base = search ? [] : nav.path
      // canAdd: o Google diz se dá para pôr arquivos ali (sem isso, "Enviar aqui" não aparece).
      const entry = { id: t.id, name: f.name, driveId: f.driveId || null, canAdd: Boolean(t.shortcut) || f.capabilities?.canAddChildren !== false }
      // Dentro de um resultado de busca: a pasta vira o novo começo da trilha.
      go(nav.scope, f.isDrive ? [entry] : [...base, entry])
      return
    }
    const files = (list.files || []).filter((x) => !isFolder(x))
    setPreview({ files, index: Math.max(0, files.findIndex((x) => x.id === f.id)) })
  }

  const scopeLabel = SCOPES.find((s) => s.id === nav.scope)?.aria
  const title = search ? 'Busca' : folder ? folder.name : scopeLabel
  // A busca não fica na pasta aberta: em Meu Drive procura em tudo o que a conta vê; num Drive compartilhado, nele todo.
  const placeholder =
    nav.scope === 'mine' ? 'Buscar no Drive todo' : nav.scope === 'drives' && nav.path[0] ? `Buscar em todo o “${nav.path[0].name}”` : `Buscar em ${scopeLabel}`
  const files = list.files || []
  const empty = !list.loading && !list.error && list.files && !files.length

  return html`<div class=${cx('screen', 'drive-screen', prefs.view === 'list' && 'is-list')} ref=${root}>
    <header class="topbar dtop">
      <div class="dtop-row">
        ${nav.path.length && !search
          ? html`<button type="button" class="icon-btn dtop-back" onClick=${() => go(nav.scope, nav.path.slice(0, -1))} aria-label="Voltar">
              <${Icon} name="chevron-left" size=${22} strokeWidth=${2} />
            </button>`
          : null}
        <h1 class="dtop-title">${title}</h1>
        <div class="dtop-actions">
          <button
            type="button"
            class=${cx('icon-btn sort-btn', menu && 'is-on')}
            onClick=${() => setMenu(!menu)}
            aria-label=${`Ordenar por ${SORTS[prefs.sort].label}`}
            aria-expanded=${menu ? 'true' : 'false'}
          >
            <${Icon} name="chevron-updown" size=${19} strokeWidth=${1.9} />
          </button>
          <button
            type="button"
            class="icon-btn"
            onClick=${() => changePrefs({ view: prefs.view === 'grid' ? 'list' : 'grid' })}
            aria-label=${prefs.view === 'grid' ? 'Ver em lista' : 'Ver em grade'}
          >
            <${Icon} name=${prefs.view === 'grid' ? 'list' : 'grid'} size=${20} />
          </button>
        </div>
        ${menu ? html`<${SortMenu} prefs=${prefs} onChange=${(p) => changePrefs(p)} onClose=${() => setMenu(false)} />` : null}
      </div>
      ${nav.path.length && !search
        ? html`<nav class="crumbs dcrumbs" aria-label="Caminho" ref=${crumbsRef}>
            <button type="button" class="crumb" onClick=${() => go(nav.scope, [])}>${SCOPES.find((s) => s.id === nav.scope)?.label}</button>
            ${nav.path.map(
              (p, i) => html`<${Icon} name="chevron-right" size=${12} strokeWidth=${2} class="crumb-sep" />
                <button
                  type="button"
                  class=${cx('crumb', i === nav.path.length - 1 && 'is-here')}
                  onClick=${() => go(nav.scope, nav.path.slice(0, i + 1))}
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
                onClick=${() => go(s.id, [])}
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
          ? html`<button type="button" class="search-x" onClick=${() => go(nav.scope, nav.path)} aria-label="Limpar busca">
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
      ${folder && !search
        ? html`<div class="dfolder">
            <${FolderSize} folder=${folder} driveId=${driveId} active=${active} />
            ${folder.canAdd !== false ? html`<${SendHere} scope=${nav.scope} path=${nav.path} />` : null}
          </div>`
        : null}
      ${search ? html`<p class="drive-note">${list.loading ? 'Buscando…' : `${files.length}${list.next ? '+' : ''} ${files.length === 1 ? 'resultado' : 'resultados'} para “${search}”`}</p>` : null}
      ${list.loading && !list.files ? html`<${SkeletonGrid} view=${prefs.view} />` : null}
      ${list.error && !list.files
        ? html`<div class="drive-msg" role="alert">
            <${Icon} name="warning" size=${26} />
            <b>${list.error?.status === 0 ? 'Sem conexão com o Google' : list.error?.reconnect ? 'Reconecte o Google Drive' : 'Não consegui abrir este lugar'}</b>
            <p>${list.error?.reconnect ? 'O Google pediu uma nova autorização. Abra sua conta para reconectar.' : 'Confira a internet e tente de novo.'}</p>
            <${Button} size="sm" variant="secondary" icon="refresh" onClick=${list.reload}>Tentar de novo</${Button}>
          </div>`
        : null}
      ${empty
        ? html`<div class="drive-msg is-empty">
            <${KindGlyph} kind="folder" size=${34} />
            <b>${search ? 'Nada encontrado' : nav.scope === 'drives' && !nav.path.length ? 'Nenhum Drive compartilhado' : nav.scope === 'shared' && !nav.path.length ? 'Nada compartilhado com você' : 'Pasta vazia'}</b>
            <p>${search ? 'A busca procura pelo começo das palavras do nome.' : nav.scope === 'drives' && !nav.path.length ? 'Os Drives de equipe que você participa aparecem aqui.' : 'Quando chegar algo, aparece aqui.'}</p>
          </div>`
        : null}
      ${files.length
        ? prefs.view === 'grid'
          ? html`<ul class="tiles">${files.map((f) => html`<${Tile} key=${f.id} f=${f} siblings=${files} onOpen=${open} />`)}</ul>`
          : html`<ul class="group lrows">${files.map((f) => html`<${Row} key=${f.id} f=${f} siblings=${files} onOpen=${open} driveId=${driveId} />`)}</ul>`
        : null}
      ${list.error && list.files ? html`<p class="drive-note is-error">Não consegui carregar mais. <button type="button" class="link-btn" onClick=${list.more}>Tentar de novo</button></p>` : null}
      <div ref=${sentinel} class="drive-sentinel">${list.loadingMore ? html`<span class="spinner" aria-label="Carregando mais"></span>` : null}</div>
      ${files.length && !list.next && !list.loading ? html`<p class="foot drive-foot">${files.length === 1 ? '1 item' : `${files.length} itens`}</p>` : null}
    </main>

    ${preview
      ? html`<${Preview}
          files=${preview.files}
          index=${preview.index}
          onIndex=${(i) => setPreview({ ...preview, index: i })}
          onClose=${() => setPreview(null)}
        />`
      : null}
  </div>`
}
