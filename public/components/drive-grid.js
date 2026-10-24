// Grade com miniaturas (alternativa à tabela na tela Drive). Mesma seleção estilo Finder: clique, ⌘/Ctrl-clique,
// Shift-clique, setas; duplo clique ou Enter abre a pasta ou a prévia; espaço abre a prévia.
import { html, useEffect, useRef, useState } from '/vendor/preact-htm.js'
import { bytes, count, fullDate, relTime } from '../lib/format.js'
import { cx, memo } from '../lib/ui.js'
import { clipTime } from '../lib/media.js'
import { Icon } from './icons.js'
import { Button, Checkbox } from './common.js'
import { Thumb } from './drive-thumb.js'
import { Scrub } from './scrub.js'
import { isOpenable } from './drive-table.js'
import { sizeShort } from './drive-tamanho.js'
import { comecarArrasto, fimArrasto, idsSoltos, podeSoltar, pontoDoItem, teclaDeMenu } from './drive-menu.js'

const PAGE = 120

const Card = memo(function Card({ item, index, selected, focused, accountId, proxy, h, fsize, hasProxy }) {
  const folderLike = isOpenable(item)
  const dur = item.video?.durationMs ? clipTime(item.video.durationMs / 1000) : ''
  const sub = folderLike ? ['Pasta', sizeShort(fsize)].filter(Boolean).join(' · ') : [item.size != null ? bytes(item.size) : null, item.modifiedTime ? relTime(item.modifiedTime) : null].filter(Boolean).join(' · ')
  // Menu de contexto e arrastar para uma pasta (h.menu = a tela pediu).
  const alvo = h.menu && folderLike && !item.isShortcut && item.canAddChildren !== false
  return html`<div
    class=${cx('gcard', selected && 'is-selected', folderLike && 'is-folder')}
    role="option"
    aria-selected=${selected ? 'true' : 'false'}
    tabindex=${focused ? 0 : -1}
    data-index=${index}
    onClick=${(e) => h.onClick(e, index)}
    onDblClick=${() => h.onDouble(index)}
    onKeyDown=${(e) => h.onKey(e, index)}
    onContextMenu=${h.menu ? (e) => h.onCtx(e, index) : undefined}
    draggable=${h.menu ? 'true' : undefined}
    onDragStart=${h.menu ? (e) => h.onDragStart(e, index) : undefined}
    onDragEnd=${h.menu ? fimArrasto : undefined}
    onDragOver=${alvo ? (e) => h.onDragOver(e, index) : undefined}
    onDragLeave=${alvo ? (e) => e.currentTarget.classList.remove('is-alvo') : undefined}
    onDrop=${alvo ? (e) => h.onDrop(e, index) : undefined}
    title=${`${item.name}${item.modifiedTime ? `\nModificado ${fullDate(item.modifiedTime)}` : ''}`}
  >
    <div class="gthumb">
      <${Thumb} accountId=${accountId} item=${item} proxy=${proxy} folderLike=${folderLike} size=${480} iconSize=${folderLike ? 64 : 44} class="thumb-grid" />
      ${!folderLike ? html`<${Scrub} accountId=${accountId} item=${item} />` : null}
      <span class="gcheck"><${Checkbox} checked=${selected} label=${`Selecionar ${item.name}`} tabIndex=${-1} onChange=${() => h.onCheck(index)} /></span>
      ${dur ? html`<span class="gbadge">${dur}</span>` : null}
      ${item.isGoogleDoc ? html`<span class="gbadge gbadge-left">Doc Google</span>` : null}
      ${hasProxy ? html`<span class="gbadge gbadge-left gbadge-proxy" title="Tem proxy (cópia leve): a prévia toca fluida">Proxy</span>` : null}
      ${!folderLike
        ? html`<button type="button" class="gpeek" tabindex="-1" title="Prévia (espaço)" aria-label=${`Prévia de ${item.name}`} onClick=${(e) => {
            e.stopPropagation()
            h.onPeek(index)
          }}><${Icon} name=${item.video ? 'play' : 'eye'} size=${16} /></button>`
        : null}
    </div>
    <div class="gmeta">
      <span class="gname">${item.name}</span>
      <span class="gsub">${sub}</span>
    </div>
  </div>`
})

/**
 * @param {{ items: any[]|null, sorted: any[], selected: Set<string>, onSelect, onOpen, onPreview, accountId: string,
 *           loading?: boolean, error?: string|null, onRetry?: ()=>void, empty?: any, resetKey?: string, proxies?: Map }} props
 */
export function DriveGrid({ items, sorted, selected, onSelect, onOpen, onPreview, accountId, loading, error, onRetry, empty, resetKey, proxies, sizeOf, comProxy, onMenu, onSoltar }) {
  const [limit, setLimit] = useState(PAGE)
  const [focus, setFocus] = useState(0)
  const anchor = useRef(null)
  const ref = useRef(null)

  useEffect(() => {
    setLimit(PAGE)
    setFocus(0)
    anchor.current = null
  }, [resetKey])

  const shown = sorted.slice(0, limit)

  const columns = () => {
    const cards = ref.current?.querySelectorAll('.gcard')
    if (!cards || cards.length < 2) return 1
    const top = cards[0].offsetTop
    let n = 0
    for (const c of cards) {
      if (c.offsetTop !== top) break
      n++
    }
    return Math.max(1, n)
  }

  const focusCard = (i) => {
    const n = Math.max(0, Math.min(shown.length - 1, i))
    setFocus(n)
    requestAnimationFrame(() => ref.current?.querySelector(`[data-index="${n}"]`)?.focus())
    return n
  }

  const range = (a, b) => {
    const s = new Set()
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) s.add(shown[i].id)
    return s
  }

  const onClick = (e, i) => {
    const it = shown[i]
    setFocus(i)
    if (e.shiftKey && anchor.current != null) return onSelect(range(anchor.current, i))
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

  const onDouble = (i) => {
    const it = shown[i]
    if (isOpenable(it)) onOpen(it)
    else onPreview(it)
  }

  const onPeek = (i) => {
    setFocus(i)
    onPreview(shown[i])
  }

  const onKey = (e, i) => {
    const it = shown[i]
    const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns(), ArrowUp: -columns() }
    if (moves[e.key] != null) {
      e.preventDefault()
      const n = focusCard(i + moves[e.key])
      if (e.shiftKey) onSelect(range(anchor.current ?? i, n))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onDouble(i)
    } else if (e.key === ' ') {
      e.preventDefault()
      if (isOpenable(it)) onCheck(i)
      else onPreview(it)
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      onSelect(new Set(sorted.map((x) => x.id))) // tudo o que está visível
    } else if (onMenu && teclaDeMenu(e)) {
      e.preventDefault()
      abrirMenu(i, pontoDoItem(e.currentTarget))
    } else if (e.key === 'Escape' && selected.size) {
      e.stopPropagation()
      onSelect(new Set())
    }
  }

  // Botão direito: o cartão clicado entra na seleção (se ainda não estava, fica só ele), como na lista.
  const abrirMenu = (i, ponto) => {
    const it = shown[i]
    if (!it) return
    setFocus(i)
    if (!selected.has(it.id)) {
      anchor.current = i
      onSelect(new Set([it.id]))
    }
    onMenu?.(it, ponto)
  }
  const onCtx = (e, i) => {
    e.preventDefault()
    abrirMenu(i, { x: e.clientX, y: e.clientY })
  }
  const onDragStart = (e, i) => {
    const it = shown[i]
    const ids = selected.has(it.id) ? sorted.filter((x) => selected.has(x.id)).map((x) => x.id) : [it.id]
    comecarArrasto(e, ids, it.name)
  }
  const onDragOver = (e, i) => {
    if (!podeSoltar(e, shown[i].id)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    e.currentTarget.classList.add('is-alvo')
  }
  const onDrop = (e, i) => {
    if (!podeSoltar(e, shown[i].id)) return
    e.preventDefault()
    const ids = idsSoltos(e)
    fimArrasto()
    if (ids.length) onSoltar?.(ids, shown[i])
  }

  const live = useRef({})
  live.current = { onClick, onCheck, onDouble, onKey, onPeek, onCtx, onDragStart, onDragOver, onDrop }
  const h = useRef(null)
  if (!h.current)
    h.current = {
      onClick: (e, i) => live.current.onClick(e, i),
      onCheck: (i) => live.current.onCheck(i),
      onDouble: (i) => live.current.onDouble(i),
      onKey: (e, i) => live.current.onKey(e, i),
      onPeek: (i) => live.current.onPeek(i),
      onCtx: (e, i) => live.current.onCtx(e, i),
      onDragStart: (e, i) => live.current.onDragStart(e, i),
      onDragOver: (e, i) => live.current.onDragOver(e, i),
      onDrop: (e, i) => live.current.onDrop(e, i),
    }
  h.current.menu = !!onMenu

  if (loading && !items)
    return html`<div class="dgrid is-skeleton" aria-hidden="true">
      ${Array.from({ length: 10 }, () => html`<div class="gcard"><div class="gthumb sk"></div><div class="gmeta"><span class="sk sk-line" style="width:70%"></span></div></div>`)}
    </div>`
  if (error && !items)
    return html`<div class="table-msg is-error">
      <${Icon} name="warning" size=${18} />
      <span>${error}</span>
      ${onRetry ? html`<${Button} size="sm" onClick=${onRetry}>Tentar de novo</${Button}>` : null}
    </div>`
  if (!sorted.length) return html`<div class="table-msg">${empty || 'Pasta vazia'}</div>`

  return html`<div class=${cx('dgrid-wrap', loading && 'is-refreshing')}>
    <div class="dgrid" role="listbox" aria-multiselectable="true" aria-label="Arquivos" ref=${ref}>
      ${shown.map(
        (it, i) => html`<${Card}
          key=${it.id}
          item=${it}
          hasProxy=${!!comProxy?.has(it.id)}
          index=${i}
          selected=${selected.has(it.id)}
          focused=${i === focus}
          accountId=${accountId}
          proxy=${proxies?.get(it.id)}
          h=${h.current}
          fsize=${sizeOf && isOpenable(it) ? sizeOf(it) : null}
        />`,
      )}
    </div>
    ${sorted.length > limit
      ? html`<button type="button" class="more-row" onClick=${() => setLimit((l) => l + PAGE)}>
          Mostrar mais ${count(Math.min(PAGE, sorted.length - limit))} <span class="sub">· de ${count(sorted.length)}</span>
        </button>`
      : null}
  </div>`
}
