// Tabela de itens do Drive (usada na tela Drive e no seletor de pasta). Pastas primeiro,
// seleção estilo Finder (clique, ⌘/Ctrl-clique, Shift-clique), duplo clique ou Enter abre a pasta.
import { html, useMemo, useRef, useState, useEffect } from '/vendor/preact-htm.js'
import { bytes, count, fullDate, relTime } from '../lib/format.js'
import { cx, memo } from '../lib/ui.js'
import { Icon } from './icons.js'
import { Checkbox, FileIcon, SkeletonRows, Button } from './common.js'
import { Thumb } from './drive-thumb.js'
import { FolderSizeCell } from './drive-tamanho.js'

const PAGE = 200

export function compare(key, dir) {
  const m = dir === 'desc' ? -1 : 1
  return (a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1
    let r = 0
    if (key === 'size') r = (a.size ?? -1) - (b.size ?? -1)
    else if (key === 'modified') r = Date.parse(a.modifiedTime || 0) - Date.parse(b.modifiedTime || 0)
    if (!r) r = a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' })
    return r * m
  }
}

export const isOpenable = (it) => it.isFolder || (it.isShortcut && it.shortcutTargetMimeType === 'application/vnd.google-apps.folder')

const Row = memo(function Row({ item, index, selected, focused, mode, onRowClick, onRowDouble, onCheck, onKey, accountId, proxy, onPreview, fsize, onCalcSize, hasProxy, onLink }) {
  const folderLike = isOpenable(item)
  const disabled = mode === 'folder' && !folderLike
  return html`<div
    class=${cx('drow', selected && 'is-selected', disabled && 'is-disabled', folderLike && 'is-folder')}
    role="row"
    aria-selected=${selected ? 'true' : 'false'}
    aria-disabled=${disabled ? 'true' : undefined}
    tabindex=${focused ? 0 : -1}
    data-index=${index}
    onClick=${(e) => onRowClick(e, index)}
    onDblClick=${() => onRowDouble(index)}
    onKeyDown=${(e) => onKey(e, index)}
  >
    ${mode !== 'folder'
      ? html`<span class="drow-check" role="gridcell"><${Checkbox} checked=${selected} label=${`Selecionar ${item.name}`} tabIndex=${-1} onChange=${() => onCheck(index)} /></span>`
      : null}
    <span class="drow-name" role="gridcell">
      ${accountId
        ? html`<${Thumb} accountId=${accountId} item=${item} proxy=${proxy} folderLike=${folderLike} size=${64} iconSize=${28} class="thumb-row" />`
        : html`<${FileIcon} name=${item.name} mimeType=${item.mimeType} isFolder=${folderLike} size=${28} shortcut=${item.isShortcut} />`}
      <span class="name" title=${item.name}>${item.name}</span>
      ${item.isGoogleDoc ? html`<span class="tag" title="Documento nativo do Google: é exportado (.docx, .xlsx, .pptx) ao baixar">Doc Google</span>` : null}
      ${hasProxy ? html`<span class="tag tag-proxy" title="Tem proxy (cópia leve): a prévia toca fluida">Proxy</span>` : null}
      ${onLink
        ? html`<button type="button" class="drow-act" tabindex="-1" title="Copiar link" aria-label=${`Copiar o link de ${item.name}`} onClick=${(e) => {
            e.stopPropagation()
            onLink(index)
          }} onDblClick=${(e) => e.stopPropagation()}><${Icon} name="link" size=${14} /></button>`
        : null}
    </span>
    <span class="drow-size" role="gridcell">${folderLike
      ? onCalcSize || fsize
        ? html`<${FolderSizeCell} v=${fsize} name=${item.name} onCalc=${onCalcSize ? () => onCalcSize(index) : null} />`
        : '—'
      : item.size == null
        ? '—'
        : bytes(item.size)}</span>
    <span class="drow-date" role="gridcell" title=${fullDate(item.modifiedTime)}>${item.modifiedTime ? relTime(item.modifiedTime) : '—'}</span>
    ${folderLike
      ? html`<span class="drow-go" aria-hidden="true"><${Icon} name="chevron-right" size=${14} /></span>`
      : onPreview
        ? html`<button type="button" class="drow-go drow-peek" tabindex="-1" title="Prévia (espaço)" aria-label=${`Prévia de ${item.name}`} onClick=${(e) => {
            e.stopPropagation()
            onPreview(index)
          }}><${Icon} name="eye" size=${15} /></button>`
        : html`<span class="drow-go"></span>`}
  </div>`
})

/**
 * @param {{ items: any[], mode?: 'browse'|'folder', selected: Set<string>, onSelect: (s:Set<string>)=>void,
 *           onOpen: (item)=>void, loading?: boolean, error?: string|null, onRetry?: ()=>void, empty?: any, resetKey?: string }} props
 */
export function DriveTable({ items, mode = 'browse', selected, onSelect, onOpen, loading, error, onRetry, empty, resetKey, compact, accountId, onPreview, proxies, sort: sortProp, onSort, sizeOf, onCalcSize, comProxy, onCopyLink }) {
  const [sortLocal, setSortLocal] = useState({ key: 'name', dir: 'asc' })
  const sort = sortProp || sortLocal
  const setSort = onSort || setSortLocal
  const [limit, setLimit] = useState(PAGE)
  const [focus, setFocus] = useState(0)
  const anchor = useRef(null)
  const bodyRef = useRef(null)

  useEffect(() => {
    setLimit(PAGE)
    setFocus(0)
    anchor.current = null
  }, [resetKey])

  const sorted = useMemo(() => (items || []).slice().sort(compare(sort.key, sort.dir)), [items, sort])
  const shown = sorted.slice(0, limit)
  const selectable = (it) => (mode === 'folder' ? isOpenable(it) : true)

  const focusRow = (i) => {
    const n = Math.max(0, Math.min(shown.length - 1, i))
    setFocus(n)
    requestAnimationFrame(() => bodyRef.current?.querySelector(`[data-index="${n}"]`)?.focus())
    return n
  }

  const range = (a, b) => {
    const s = new Set()
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (selectable(shown[i])) s.add(shown[i].id)
    return s
  }

  const onRowClick = (e, i) => {
    const it = shown[i]
    setFocus(i)
    if (!selectable(it)) return
    if (mode === 'folder') {
      onSelect(selected.has(it.id) ? new Set() : new Set([it.id]))
      return
    }
    if (e.shiftKey && anchor.current != null) {
      onSelect(range(anchor.current, i))
      return
    }
    anchor.current = i
    if (e.metaKey || e.ctrlKey) {
      const s = new Set(selected)
      s.has(it.id) ? s.delete(it.id) : s.add(it.id)
      onSelect(s)
    } else onSelect(selected.size === 1 && selected.has(it.id) ? new Set() : new Set([it.id]))
  }

  const onCheck = (i) => {
    const it = shown[i]
    anchor.current = i
    const s = new Set(selected)
    s.has(it.id) ? s.delete(it.id) : s.add(it.id)
    onSelect(s)
  }

  const onRowDouble = (i) => {
    const it = shown[i]
    if (isOpenable(it)) onOpen(it)
    else if (onPreview && mode !== 'folder') onPreview(it)
  }

  const onKey = (e, i) => {
    const it = shown[i]
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = focusRow(i + (e.key === 'ArrowDown' ? 1 : -1))
      if (e.shiftKey && mode !== 'folder') onSelect(range(anchor.current ?? i, n))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (isOpenable(it)) onOpen(it)
      else if (onPreview && mode !== 'folder') onPreview(it)
    } else if (e.key === ' ') {
      e.preventDefault()
      // Espaço = prévia (como o Quick Look do Mac); em pastas marca/desmarca
      if (mode === 'folder') onRowClick({}, i)
      else if (onPreview && !isOpenable(it)) onPreview(it)
      else onCheck(i)
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && mode !== 'folder') {
      e.preventDefault()
      onSelect(new Set(shown.map((x) => x.id)))
    } else if (e.key === 'Escape' && selected.size) {
      e.stopPropagation()
      onSelect(new Set())
    } else if (e.key === 'Backspace' && (e.metaKey || e.altKey)) {
      // ⌘⌫ não faz nada aqui (não apagamos nada do Drive)
    }
  }

  // handlers estáveis para as linhas memoizadas (sempre chamam a versão mais nova)
  const live = useRef({})
  const onPeek = (i) => {
    setFocus(i)
    onPreview?.(shown[i])
  }
  const onCalc = (i) => onCalcSize?.(shown[i])
  const onLink = (i) => onCopyLink?.(shown[i])
  live.current = { onRowClick, onRowDouble, onCheck, onKey, onPeek, onCalc, onLink }
  const stable = useRef(null)
  if (!stable.current)
    stable.current = {
      onRowClick: (e, i) => live.current.onRowClick(e, i),
      onRowDouble: (i) => live.current.onRowDouble(i),
      onCheck: (i) => live.current.onCheck(i),
      onKey: (e, i) => live.current.onKey(e, i),
      onPeek: (i) => live.current.onPeek(i),
      onCalc: (i) => live.current.onCalc(i),
      onLink: (i) => live.current.onLink(i),
    }
  const h = stable.current

  const allSel = mode !== 'folder' && shown.length > 0 && shown.every((x) => selected.has(x.id))
  const someSel = mode !== 'folder' && !allSel && shown.some((x) => selected.has(x.id))

  const header = (key, label, klass) => {
    const on = sort.key === key
    return html`<button
      type="button"
      class=${cx('dhead-btn', klass, on && 'is-on')}
      onClick=${() => setSort({ key, dir: on && sort.dir === 'asc' ? 'desc' : 'asc' })}
      aria-sort=${on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      ${label}${on ? html`<${Icon} name=${sort.dir === 'asc' ? 'chevron-down' : 'chevron-up'} size=${12} strokeWidth=${2} />` : null}
    </button>`
  }

  let body
  if (loading && !items) body = html`<${SkeletonRows} rows=${compact ? 6 : 8} />`
  else if (error && !items)
    body = html`<div class="table-msg is-error">
      <${Icon} name="warning" size=${18} />
      <span>${error}</span>
      ${onRetry ? html`<${Button} size="sm" onClick=${onRetry}>Tentar de novo</${Button}>` : null}
    </div>`
  else if (!sorted.length) body = html`<div class="table-msg">${empty || 'Pasta vazia'}</div>`
  else
    body = html`${shown.map(
      (it, i) => html`<${Row}
        key=${it.id}
        item=${it}
        hasProxy=${!!comProxy?.has(it.id)}
        index=${i}
        mode=${mode}
        selected=${selected.has(it.id)}
        focused=${i === focus}
        onRowClick=${h.onRowClick}
        onRowDouble=${h.onRowDouble}
        onCheck=${h.onCheck}
        onKey=${h.onKey}
        accountId=${accountId}
        proxy=${proxies?.get(it.id)}
        onPreview=${onPreview && mode !== 'folder' ? h.onPeek : null}
        fsize=${sizeOf && isOpenable(it) ? sizeOf(it) : null}
        onCalcSize=${onCalcSize && mode !== 'folder' ? h.onCalc : null}
        onLink=${onCopyLink && mode !== 'folder' ? h.onLink : null}
      />`,
    )}
    ${sorted.length > limit
      ? html`<button type="button" class="more-row" onClick=${() => setLimit((l) => l + PAGE)}>
          Mostrar mais ${count(Math.min(PAGE, sorted.length - limit))} <span class="sub">· de ${count(sorted.length)}</span>
        </button>`
      : null}`

  return html`<div class=${cx('dtable', mode === 'folder' && 'is-folder-mode', compact && 'is-compact', loading && items && 'is-refreshing')} role="grid" aria-busy=${loading ? 'true' : 'false'}>
    <div class="dhead" role="row">
      ${mode !== 'folder'
        ? html`<span class="drow-check"><${Checkbox}
            checked=${allSel}
            indeterminate=${someSel}
            label="Selecionar tudo"
            onChange=${(v) => onSelect(v ? new Set(shown.map((x) => x.id)) : new Set())}
          /></span>`
        : null}
      ${header('name', 'Nome', 'drow-name')}
      ${header('size', 'Tamanho', 'drow-size')}
      ${header('modified', 'Modificado', 'drow-date')}
      <span class="drow-go"></span>
    </div>
    <div class="dbody" ref=${bodyRef}>${body}</div>
  </div>`
}
