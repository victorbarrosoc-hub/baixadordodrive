// Seletor local, no espírito do Finder: lugares à esquerda, barra de caminho editável (dá para colar),
// lista com tamanhos, "Mostrar ocultos". Modos: 'files' (vários arquivos/pastas) e 'folder' (uma pasta).
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from '/vendor/preact-htm.js'
import { api, withQuery } from '../lib/api.js'
import { getState } from '../lib/store.js'
import { bytes, count, fullDate, plural, relTime, tildify, baseName } from '../lib/format.js'
import { cx, memo } from '../lib/ui.js'
import { Icon } from './icons.js'
import { Button, Checkbox, FileIcon, IconButton, SkeletonRows, Switch } from './common.js'
import { Modal } from './modal.js'

let rootsCache = null
let rootsPromise = null
export function loadLocalRoots() {
  if (rootsCache) return Promise.resolve(rootsCache)
  rootsPromise ??= api
    .get('/api/local/roots')
    .then((r) => (rootsCache = { roots: r.roots || [], home: r.home || '', sep: r.sep || '/' }))
    .catch((e) => {
      rootsPromise = null
      throw e
    })
  return rootsPromise
}

export function useLocalRoots() {
  const [data, setData] = useState(rootsCache)
  useEffect(() => {
    if (!rootsCache) loadLocalRoots().then(setData).catch(() => setData({ roots: [], home: '', sep: '/' }))
  }, [])
  return data
}

const ROOT_ICON = { home: 'home', desktop: 'desktop', downloads: 'circle-down', documents: 'doc', movies: 'film', volume: 'disk', drive: 'disk' }

const LocalRow = memo(function LocalRow({ e, index, selected, focused, mode, onClick, onDouble, onKey }) {
  const disabled = mode === 'folder' && !e.isDir
  return html`<div
    class=${cx('drow', selected && 'is-selected', disabled && 'is-disabled', e.isDir && 'is-folder')}
    role="row"
    aria-selected=${selected ? 'true' : 'false'}
    tabindex=${focused ? 0 : -1}
    data-index=${index}
    onClick=${(ev) => onClick(ev, index)}
    onDblClick=${() => onDouble(index)}
    onKeyDown=${(ev) => onKey(ev, index)}
  >
    ${mode === 'files'
      ? html`<span class="drow-check"><${Checkbox} checked=${selected} label=${`Selecionar ${e.name}`} tabIndex=${-1} onChange=${() => onClick({ metaKey: true }, index)} /></span>`
      : null}
    <span class="drow-name">
      <${FileIcon} name=${e.name} isFolder=${e.isDir} size=${26} />
      <span class="name" title=${e.name}>${e.name}</span>
    </span>
    <span class="drow-size">${e.isDir ? '—' : bytes(e.size)}</span>
    <span class="drow-date" title=${fullDate(e.mtimeMs)}>${e.mtimeMs ? relTime(e.mtimeMs) : '—'}</span>
    <span class="drow-go">${e.isDir ? html`<${Icon} name="chevron-right" size=${14} />` : null}</span>
  </div>`
})

export function LocalPicker({ mode = 'files', title, subtitle, confirmLabel, initialPath, onClose }) {
  const roots = useLocalRoots()
  const settings = getState().settings
  const platform = getState().app?.platform
  const [cwd, setCwd] = useState(null)
  const [pathText, setPathText] = useState('')
  const [listing, setListing] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [hidden, setHidden] = useState(!!settings?.showHiddenFiles)
  const [selected, setSelected] = useState(() => new Map()) // path -> entry
  const [focus, setFocus] = useState(0)
  const [hist, setHist] = useState({ list: [], i: -1 })
  const listRef = useRef(null)
  const seq = useRef(0)
  const editing = useRef(false) // não sobrescreve o que a pessoa está digitando na barra de caminho
  const pathInput = useRef(null)

  const load = async (p, { push = true } = {}) => {
    const my = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const res = await api.get(withQuery('/api/local/list', { path: p, hidden: hidden ? '1' : '' }))
      if (my !== seq.current) return
      setListing(res)
      setCwd(res.path)
      if (!editing.current) setPathText(res.path)
      setFocus(0)
      if (mode === 'folder') setSelected(new Map())
      if (push) setHist((h) => ({ list: [...h.list.slice(0, h.i + 1), res.path], i: h.i + 1 }))
    } catch (err) {
      if (my !== seq.current) return
      setError(err.message)
      if (!editing.current) setPathText(cwd || p || '')
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }

  // Caminho novo com a barra em foco (ex.: clicou nela para colar enquanto a pasta inicial carregava):
  // deixa tudo selecionado, senão o que a pessoa colar vai parar depois do caminho antigo.
  useLayoutEffect(() => {
    const el = pathInput.current
    if (el && document.activeElement === el && !editing.current) el.select()
  }, [pathText])

  // primeira pasta: a pedida, senão Downloads/Início
  useEffect(() => {
    if (!roots) return
    const start = initialPath || (mode === 'folder' ? settings?.downloadDir : null) || roots.home || roots.roots[0]?.path || '/'
    load(start)
  }, [roots])

  // trocar "Mostrar ocultos" recarrega a mesma pasta
  const firstHidden = useRef(true)
  useEffect(() => {
    if (firstHidden.current) {
      firstHidden.current = false
      return
    }
    if (cwd) load(cwd, { push: false })
  }, [hidden])

  const entries = listing?.entries || []
  const go = (p) => p && p !== cwd && load(p)
  const back = () => hist.i > 0 && (setHist((h) => ({ ...h, i: h.i - 1 })), load(hist.list[hist.i - 1], { push: false }))
  const fwd = () => hist.i < hist.list.length - 1 && (setHist((h) => ({ ...h, i: h.i + 1 })), load(hist.list[hist.i + 1], { push: false }))
  const up = () => listing?.parent && load(listing.parent)

  const focusRow = (i) => {
    const n = Math.max(0, Math.min(entries.length - 1, i))
    setFocus(n)
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-index="${n}"]`)?.focus())
  }

  const toggle = (e) => {
    setSelected((prev) => {
      const next = new Map(prev)
      if (mode === 'folder') {
        const had = next.has(e.path)
        next.clear()
        if (!had) next.set(e.path, e)
      } else if (next.has(e.path)) next.delete(e.path)
      else next.set(e.path, e)
      return next
    })
  }

  const onClick = (ev, i) => {
    const e = entries[i]
    setFocus(i)
    if (mode === 'folder' && !e.isDir) return
    toggle(e)
  }
  const onDouble = (i) => {
    const e = entries[i]
    if (e.isDir) go(e.path)
  }

  const folderChoice = mode === 'folder' ? [...selected.values()][0]?.path || cwd : null
  const canConfirm = mode === 'folder' ? !!folderChoice : selected.size > 0
  const confirm = () => {
    if (!canConfirm) return
    onClose(mode === 'folder' ? folderChoice : [...selected.keys()])
  }

  const onKey = (ev, i) => {
    const e = entries[i]
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      focusRow(i + (ev.key === 'ArrowDown' ? 1 : -1))
    } else if ((ev.key === 'ArrowRight' || (ev.metaKey && ev.key === 'ArrowDown')) && e?.isDir) {
      ev.preventDefault()
      go(e.path)
    } else if (ev.key === 'ArrowLeft' || (ev.metaKey && ev.key === 'ArrowUp')) {
      ev.preventDefault()
      up()
    } else if (ev.key === ' ') {
      ev.preventDefault()
      onClick(ev, i)
    }
  }

  const onModalKey = (ev) => {
    if (ev.key === 'Enter' && ev.target.tagName !== 'INPUT' && ev.target.tagName !== 'BUTTON' && ev.target.tagName !== 'A') {
      ev.preventDefault()
      confirm()
    }
  }

  // resumo da seleção
  const sel = [...selected.values()]
  const selFiles = sel.filter((x) => !x.isDir)
  const selDirs = sel.length - selFiles.length
  const selBytes = selFiles.reduce((a, x) => a + (x.size || 0), 0)
  const summaryParts = []
  if (selFiles.length) summaryParts.push(plural(selFiles.length, 'arquivo', 'arquivos'))
  if (selDirs) summaryParts.push(plural(selDirs, 'pasta', 'pastas'))
  const label =
    confirmLabel ||
    (mode === 'folder'
      ? selected.size
        ? `Escolher “${baseName(folderChoice)}”`
        : 'Escolher esta pasta'
      : selected.size
        ? `Enviar ${plural(selected.size, 'item', 'itens')}`
        : 'Enviar')

  const allSel = mode === 'files' && entries.length > 0 && entries.every((e) => selected.has(e.path))
  const someSel = mode === 'files' && !allSel && entries.some((e) => selected.has(e.path))
  const pastePlaceholder =
    platform === 'win32' ? 'Cole um caminho (Shift + clique direito → Copiar como caminho)' : platform === 'darwin' || !platform ? 'Cole um caminho — no Finder, ⌥⌘C copia o caminho do item' : 'Cole um caminho e tecle Enter'

  const favorites = (roots?.roots || []).filter((r) => r.kind !== 'volume' && r.kind !== 'drive')
  const volumes = (roots?.roots || []).filter((r) => r.kind === 'volume' || r.kind === 'drive')

  // mantém o foco nas linhas ao abrir uma pasta
  const sorted = useMemo(() => entries, [entries])

  return html`<${Modal}
    size="xl"
    class="picker"
    title=${title || (mode === 'folder' ? 'Escolha uma pasta' : 'Escolha o que enviar')}
    subtitle=${subtitle || (mode === 'folder' ? 'Clique numa pasta para escolher, ou dê dois cliques para entrar.' : 'Marque arquivos e pastas — pastas vão com tudo dentro. Dá para marcar itens de lugares diferentes.')}
    onClose=${() => onClose(null)}
    onKeyDown=${onModalKey}
    footer=${html`
      <div class="picker-summary">
        ${mode === 'folder'
          ? html`<${Icon} name="folder" size=${15} /><span class="mono-path" title=${folderChoice}>${tildify(folderChoice, roots?.home)}</span>`
          : selected.size
            ? html`<b>${summaryParts.join(' e ')}</b>${selBytes ? html`<span class="sub">· ${bytes(selBytes)}${selDirs ? ' + pastas' : ''}</span>` : null}
                <button type="button" class="link" onClick=${() => setSelected(new Map())}>Limpar</button>`
            : html`<span class="sub">Nada marcado ainda</span>`}
      </div>
      <${Button} onClick=${() => onClose(null)}>Cancelar</${Button}>
      <${Button} variant="primary" onClick=${confirm} disabled=${!canConfirm}>${label}</${Button}>
    `}
  >
    <div class="picker-grid">
      <aside class="picker-side" aria-label="Lugares">
        ${favorites.length ? html`<div class="side-label">Favoritos</div>` : null}
        ${favorites.map(
          (r) => html`<button type="button" class=${cx('side-item', cwd === r.path && 'is-on')} onClick=${() => go(r.path)} title=${r.path}>
            <${Icon} name=${ROOT_ICON[r.kind] || 'folder'} size=${16} /><span>${r.name}</span>
          </button>`,
        )}
        ${volumes.length ? html`<div class="side-label">Locais</div>` : null}
        ${volumes.map(
          (r) => html`<button type="button" class=${cx('side-item', cwd === r.path && 'is-on')} onClick=${() => go(r.path)} title=${r.path}>
            <${Icon} name="disk" size=${16} /><span>${r.name}</span>
          </button>`,
        )}
      </aside>
      <section class="picker-main">
        <div class="picker-bar">
          <div class="nav-btns">
            <${IconButton} icon="chevron-left" label="Voltar" onClick=${back} disabled=${hist.i <= 0} />
            <${IconButton} icon="chevron-right" label="Avançar" onClick=${fwd} disabled=${hist.i >= hist.list.length - 1} />
            <${IconButton} icon="folder-up" label="Pasta de cima" onClick=${up} disabled=${!listing?.parent} />
          </div>
          <form
            class="path-field"
            onSubmit=${(e) => {
              e.preventDefault()
              editing.current = false
              const p = (e.currentTarget.querySelector('input')?.value ?? pathText).trim().replace(/^["']|["']$/g, '')
              if (p) load(p.startsWith('~') && roots?.home ? roots.home + p.slice(1) : p)
            }}
          >
            <${Icon} name="folder" size=${14} />
            <input
              ref=${pathInput}
              class="path-input"
              type="text"
              value=${pathText}
              onInput=${(e) => {
                editing.current = true
                setPathText(e.currentTarget.value)
              }}
              onBlur=${() => (editing.current = false)}
              onKeyDown=${(e) => {
                if (e.key === 'Escape' && pathText !== cwd) {
                  e.stopPropagation()
                  editing.current = false
                  setPathText(cwd || '')
                }
              }}
              placeholder=${pastePlaceholder}
              aria-label="Caminho da pasta"
              spellcheck="false"
              autocomplete="off"
            />
          </form>
          <label class="hidden-toggle" title="Mostrar arquivos ocultos">
            <span>Ocultos</span>
            <${Switch} checked=${hidden} onChange=${setHidden} label="Mostrar ocultos" />
          </label>
        </div>
        ${error ? html`<div class="picker-error"><${Icon} name="warning" size=${15} /> ${error}</div>` : null}
        <div class=${cx('dtable', 'is-compact', mode === 'folder' && 'is-folder-mode', loading && listing && 'is-refreshing')} role="grid">
          <div class="dhead" role="row">
            ${mode === 'files'
              ? html`<span class="drow-check"><${Checkbox}
                  checked=${allSel}
                  indeterminate=${someSel}
                  label="Marcar tudo nesta pasta"
                  onChange=${(v) =>
                    setSelected((prev) => {
                      const next = new Map(prev)
                      for (const e of entries) v ? next.set(e.path, e) : next.delete(e.path)
                      return next
                    })}
                /></span>`
              : null}
            <span class="dhead-btn drow-name">Nome</span>
            <span class="dhead-btn drow-size">Tamanho</span>
            <span class="dhead-btn drow-date">Modificado</span>
            <span class="drow-go"></span>
          </div>
          <div class="dbody" ref=${listRef}>
            ${loading && !listing
              ? html`<${SkeletonRows} rows=${7} />`
              : sorted.length
                ? sorted.slice(0, 500).map(
                    (e, i) => html`<${LocalRow}
                      key=${e.path}
                      e=${e}
                      index=${i}
                      mode=${mode}
                      selected=${selected.has(e.path)}
                      focused=${i === focus}
                      onClick=${onClick}
                      onDouble=${onDouble}
                      onKey=${onKey}
                    />`,
                  )
                : html`<div class="table-msg">${hidden ? 'Pasta vazia' : 'Pasta vazia (ou só com itens ocultos)'}</div>`}
            ${sorted.length > 500 ? html`<div class="table-msg sub">Mostrando 500 de ${count(sorted.length)} itens. Cole o caminho de uma subpasta para ir direto.</div>` : null}
          </div>
        </div>
      </section>
    </div>
  </${Modal}>`
}

// Os handlers das linhas mudam a cada render; o memo raso re-renderiza só as linhas desta pasta (≤ 500).
