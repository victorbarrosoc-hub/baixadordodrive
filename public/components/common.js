// Peças básicas da interface: botões em pílula, controles no estilo macOS, ícones de arquivo, avatar.
import { html, useEffect, useRef, useState } from '/vendor/preact-htm.js'
import { Icon } from './icons.js'
import { cx, useDismiss } from '../lib/ui.js'
import { fileKind, initials } from '../lib/format.js'

export function Button({ variant = 'secondary', size, icon, iconRight, children, class: klass, loading, disabled, type = 'button', ...rest }) {
  return html`<button
    ...${rest}
    type=${type}
    class=${cx('btn', `btn-${variant}`, size && `btn-${size}`, loading && 'is-loading', klass)}
    disabled=${disabled || loading}
  >
    ${loading ? html`<${Spinner} size=${14} />` : icon ? html`<${Icon} name=${icon} size=${size === 'lg' ? 18 : 16} />` : null}
    ${children != null ? html`<span>${children}</span>` : null}
    ${iconRight ? html`<${Icon} name=${iconRight} size=${14} />` : null}
  </button>`
}

export function LinkButton({ variant = 'secondary', size, icon, iconRight, children, class: klass, ...rest }) {
  return html`<a class=${cx('btn', `btn-${variant}`, size && `btn-${size}`, klass)} ...${rest}>
    ${icon ? html`<${Icon} name=${icon} size=${size === 'lg' ? 18 : 16} />` : null}
    ${children != null ? html`<span>${children}</span>` : null}
    ${iconRight ? html`<${Icon} name=${iconRight} size=${14} />` : null}
  </a>`
}

export function IconButton({ icon, label, class: klass, size = 16, tone, ...rest }) {
  return html`<button type="button" class=${cx('icon-btn', tone && `icon-btn-${tone}`, klass)} aria-label=${label} title=${label} ...${rest}>
    <${Icon} name=${icon} size=${size} />
  </button>`
}

/**
 * Botão que abre um menu pequeno (ex.: "⋯ Mais" na barra do Drive, "Ordenar").
 * items: [{ icon, label, onSelect, title?, busy?, disabled?, checked?, hint? }]. Com `checked` (true/false) o item é uma
 * opção (menuitemradio) com a marca na escolhida e `hint` do lado. `title` (dica do botão) e `heading` (título dentro
 * do menu) são opcionais. Teclado: ↓/↑ andam, Esc fecha e volta o foco ao botão; clicar fora também fecha.
 * Para gatilhos diferentes do botão-pílula: `triggerClass` troca as classes do botão, `icon={null}` tira o ícone,
 * `after` entra depois do texto (um pontinho, uma seta), `ariaLabel` nomeia o botão quando o texto sozinho não basta e
 * `children` entra no fim do conjunto, depois do menu (ex.: o "×" do Filtro).
 */
export function MenuButton({ label, icon = 'more', items, busy, align = 'right', class: klass, menuLabel, title, heading, triggerClass = 'btn btn-secondary', after, ariaLabel, children }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef(null)
  const trigger = useRef(null)
  const list = items.filter(Boolean)
  const close = (focusBack) => {
    setOpen(false)
    if (focusBack) trigger.current?.focus({ preventScroll: true })
  }
  useDismiss(wrap, (e) => close(e?.type === 'keydown'), open)
  useEffect(() => {
    if (open) wrap.current?.querySelector('.menu .menu-item:not(:disabled)')?.focus({ preventScroll: true })
  }, [open])
  const onKey = (e) => {
    const els = [...(wrap.current?.querySelectorAll('.menu .menu-item:not(:disabled)') || [])]
    const i = els.indexOf(document.activeElement)
    if (e.key === 'Escape') {
      // só fecha o menu (a tela não recebe o Esc: no Drive ele também limparia a seleção)
      e.preventDefault()
      e.stopPropagation()
      close(true)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      els[(i + (e.key === 'ArrowDown' ? 1 : els.length - 1)) % els.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      els[e.key === 'Home' ? 0 : els.length - 1]?.focus()
    } else if (e.key === 'Tab') close(false)
  }
  const onTriggerKey = (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
      e.preventDefault()
      setOpen(true)
    }
  }
  if (!list.length) return null
  return html`<div class=${cx('menu-wrap', klass)} ref=${wrap}>
    <button
      type="button"
      class=${cx(triggerClass, 'menu-trigger', open && 'is-open')}
      aria-haspopup="menu"
      aria-expanded=${open ? 'true' : 'false'}
      aria-label=${ariaLabel}
      title=${title}
      ref=${trigger}
      onClick=${() => setOpen(!open)}
      onKeyDown=${onTriggerKey}
    >
      ${busy ? html`<${Spinner} size=${14} />` : icon ? html`<${Icon} name=${icon} size=${16} />` : null}
      <span>${label}</span>
      ${after}
    </button>
    ${open
      ? html`<div class=${cx('menu menu-pop', align === 'left' && 'is-left')} role="menu" aria-label=${menuLabel || label} onKeyDown=${onKey}>
          ${heading ? html`<div class="menu-label" aria-hidden="true">${heading}</div>` : null}
          ${list.map(
            (it) => html`<button
              type="button"
              role=${it.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked=${it.checked === undefined ? undefined : it.checked ? 'true' : 'false'}
              class=${cx('menu-item', it.checked && 'is-checked')}
              title=${it.title}
              disabled=${it.disabled}
              onClick=${() => {
                close(true) // o foco volta ao botão (como num menu do macOS), não some com o item
                it.onSelect()
              }}
            >
              ${it.busy ? html`<${Spinner} size=${14} />` : html`<${Icon} name=${it.icon} size=${15} />`}
              <span class="menu-item-text">${it.label}</span>
              ${it.hint ? html`<span class="menu-item-hint">${it.hint}</span>` : null}
              ${it.checked !== undefined ? html`<span class="menu-item-check" aria-hidden="true">${it.checked ? html`<${Icon} name="check" size=${14} strokeWidth=${2} />` : null}</span>` : null}
            </button>`,
          )}
        </div>`
      : null}
    ${children}
  </div>`
}

export function Spinner({ size = 16 }) {
  return html`<span class="spinner" style=${`width:${size}px;height:${size}px`} role="status" aria-label="Carregando"></span>`
}

/** Controle segmentado (como no macOS). options: [{ value, label, count?, icon? }] */
export function Segmented({ value, options, onChange, size, label, class: klass }) {
  const onKey = (e) => {
    const i = options.findIndex((o) => o.value === value)
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const el = e.currentTarget
      const next = options[(i + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length]
      onChange(next.value)
      requestAnimationFrame(() => el?.querySelector('[aria-checked="true"]')?.focus())
    }
  }
  return html`<div class=${cx('seg', size && `seg-${size}`, klass)} role="radiogroup" aria-label=${label} onKeyDown=${onKey}>
    ${options.map(
      (o) => html`<button
        type="button"
        role="radio"
        aria-checked=${o.value === value ? 'true' : 'false'}
        tabindex=${o.value === value ? 0 : -1}
        class=${cx('seg-item', o.value === value && 'is-on')}
        title=${o.title}
        aria-label=${o.title}
        onClick=${() => onChange(o.value)}
      >
        ${o.icon ? html`<${Icon} name=${o.icon} size=${14} />` : null}
        <span>${o.label}</span>
        ${o.count != null ? html`<span class="seg-count">${o.count}</span>` : null}
      </button>`,
    )}
  </div>`
}

export function Switch({ checked, onChange, label, disabled }) {
  return html`<button
    type="button"
    role="switch"
    aria-checked=${checked ? 'true' : 'false'}
    aria-label=${label}
    class=${cx('switch', checked && 'is-on')}
    disabled=${disabled}
    onClick=${() => onChange(!checked)}
  >
    <span class="switch-knob"></span>
  </button>`
}

export function Stepper({ value, min, max, onChange, label, suffix }) {
  const set = (v) => onChange(Math.max(min, Math.min(max, v)))
  return html`<div class="stepper" role="group" aria-label=${label}>
    <button type="button" class="stepper-btn" aria-label="Menos" disabled=${value <= min} onClick=${() => set(value - 1)}>
      <${Icon} name="minus" size=${14} />
    </button>
    <span class="stepper-value" aria-live="polite">${value}${suffix ? html`<small>${suffix}</small>` : null}</span>
    <button type="button" class="stepper-btn" aria-label="Mais" disabled=${value >= max} onClick=${() => set(value + 1)}>
      <${Icon} name="plus" size=${14} />
    </button>
  </div>`
}

export function Slider({ value, min, max, step = 1, onInput, label, format = (v) => v, marks }) {
  const pct = ((value - min) / (max - min)) * 100
  return html`<div class="slider">
    <input
      type="range"
      min=${min}
      max=${max}
      step=${step}
      value=${value}
      aria-label=${label}
      style=${`--pct:${pct}%`}
      onInput=${(e) => onInput(Number(e.currentTarget.value))}
    />
    <output class="slider-value">${format(value)}</output>
    ${marks ? html`<div class="slider-marks" aria-hidden="true">${marks.map((m) => html`<span style=${`left:${((m.value - min) / (max - min)) * 100}%`}>${m.label}</span>`)}</div>` : null}
  </div>`
}

export function Select({ value, options, onChange, label, class: klass }) {
  return html`<div class=${cx('select', klass)}>
    <select aria-label=${label} value=${String(value)} onChange=${(e) => onChange(e.currentTarget.value)}>
      ${options.map((o) => html`<option value=${String(o.value)} selected=${String(o.value) === String(value)}>${o.label}</option>`)}
    </select>
    <${Icon} name="chevron-updown" size=${14} />
  </div>`
}

export function Checkbox({ checked, indeterminate, onChange, label, class: klass, tabIndex }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate
  }, [indeterminate])
  return html`<input
    ref=${ref}
    type="checkbox"
    class=${cx('check', klass)}
    checked=${!!checked}
    aria-label=${label}
    tabindex=${tabIndex}
    onClick=${(e) => e.stopPropagation()}
    onChange=${(e) => onChange(e.currentTarget.checked, e)}
  />`
}

export function Pill({ tone = 'neutral', icon, children, title, class: klass }) {
  return html`<span class=${cx('pill', `pill-${tone}`, klass)} title=${title}>
    ${icon ? html`<${Icon} name=${icon} size=${12} strokeWidth=${1.8} />` : null}
    <span class="pill-text">${children}</span>
  </span>`
}

const KIND_ICON = { video: 'film', audio: 'music', image: 'photo', project: 'project', archive: 'archive', doc: 'doc', generic: 'doc' }

export function FileIcon({ name, mimeType, isFolder, size = 32, shortcut }) {
  if (isFolder) {
    return html`<span class="ficon ficon-folder" style=${`--s:${size}px`} aria-hidden="true">
      <svg viewBox="0 0 24 24" width=${size * 0.72} height=${size * 0.72}>
        <path class="folder-back" d="M2.5 6.25A1.75 1.75 0 0 1 4.25 4.5h4.4c.5 0 .97.21 1.3.58L11.2 6.5h8.55a1.75 1.75 0 0 1 1.75 1.75v9.5a1.75 1.75 0 0 1-1.75 1.75H4.25A1.75 1.75 0 0 1 2.5 17.75z" />
        <path class="folder-front" d="M2.5 9.25c0-.97.78-1.75 1.75-1.75h15.5c.97 0 1.75.78 1.75 1.75v8.5a1.75 1.75 0 0 1-1.75 1.75H4.25A1.75 1.75 0 0 1 2.5 17.75z" />
      </svg>
      ${shortcut ? html`<span class="ficon-badge"><${Icon} name="arrow-turn-up" size=${10} strokeWidth=${2} /></span>` : null}
    </span>`
  }
  const kind = fileKind(name, mimeType)
  return html`<span class=${`ficon ficon-${kind}`} style=${`--s:${size}px`} aria-hidden="true">
    <${Icon} name=${KIND_ICON[kind]} size=${Math.round(size * 0.52)} />
    ${shortcut ? html`<span class="ficon-badge"><${Icon} name="arrow-turn-up" size=${10} strokeWidth=${2} /></span>` : null}
  </span>`
}

function hue(str = '') {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360
  return h
}

// Fotos que já falharam (sem internet, proxy da empresa, link expirado): não tenta de novo a cada desenho.
const brokenPhotos = new Set()

export function Avatar({ name, email, photoUrl, size = 28 }) {
  const h = hue(email || name)
  const [, setBroken] = useState(0)
  if (photoUrl && !brokenPhotos.has(photoUrl)) {
    // Se a foto do Google não carregar, ficam as iniciais em vez do ícone de imagem quebrada.
    const onError = () => {
      brokenPhotos.add(photoUrl)
      setBroken((n) => n + 1)
    }
    return html`<img class="avatar" src=${photoUrl} alt="" width=${size} height=${size} style=${`--s:${size}px`} referrerpolicy="no-referrer" onError=${onError} />`
  }
  return html`<span class="avatar" style=${`--s:${size}px;--h:${h}`} aria-hidden="true">${initials(name, email)}</span>`
}

export function EmptyState({ art, title, children, actions, compact }) {
  return html`<div class=${cx('empty', compact && 'empty-compact')}>
    ${art ? html`<div class="empty-art">${art}</div>` : null}
    <h2 class="empty-title">${title}</h2>
    ${children ? html`<p class="empty-body">${children}</p>` : null}
    ${actions ? html`<div class="empty-actions">${actions}</div>` : null}
  </div>`
}

/** Linhas fantasma enquanto carrega. */
export function SkeletonRows({ rows = 6 }) {
  return html`<div class="skeleton" aria-hidden="true">
    ${Array.from({ length: rows }, (_, i) => html`<div class="skeleton-row">
      <span class="sk sk-icon"></span>
      <span class="sk sk-line" style=${`width:${38 + ((i * 17) % 40)}%`}></span>
      <span class="sk sk-short"></span>
    </div>`)}
  </div>`
}

export function Kbd({ children }) {
  return html`<kbd class="kbd">${children}</kbd>`
}
