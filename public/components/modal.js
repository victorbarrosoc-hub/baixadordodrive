// Janela modal (com foco preso, Esc fecha), diálogos de confirmação/texto e o host que desenha a pilha.
import { html, useEffect, useLayoutEffect, useRef, useState } from '/vendor/preact-htm.js'
import { closeAllModals, closeModal, registeredModal, useModalStack } from '../lib/modals.js'
import { cx } from '../lib/ui.js'
import { Icon } from './icons.js'
import { Button, IconButton } from './common.js'
import { LocalPicker } from './local-picker.js'
import { DrivePicker } from './drive-picker.js'

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function Modal({ title, subtitle, onClose, children, footer, size = 'md', class: klass, onKeyDown, icon }) {
  const ref = useRef(null)
  const titleId = useRef(`m-${Math.random().toString(36).slice(2, 8)}`).current
  const downOnBackdrop = useRef(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const target = el.querySelector('[data-autofocus]') || el.querySelector('.modal-body ' + FOCUSABLE) || el.querySelector(FOCUSABLE)
    target?.focus({ preventScroll: true })
  }, [])

  const keydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key === 'Tab') {
      const nodes = [...ref.current.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null)
      if (!nodes.length) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    onKeyDown?.(e)
  }

  return html`<div
    class="modal-backdrop"
    onMouseDown=${(e) => (downOnBackdrop.current = e.target === e.currentTarget)}
    onClick=${(e) => {
      if (e.target === e.currentTarget && downOnBackdrop.current) onClose()
    }}
  >
    <div class=${cx('modal', `modal-${size}`, klass)} role="dialog" aria-modal="true" aria-labelledby=${titleId} ref=${ref} onKeyDown=${keydown}>
      <header class="modal-head">
        ${icon ? html`<span class="modal-icon">${icon}</span>` : null}
        <div class="modal-titles">
          <h2 id=${titleId}>${title}</h2>
          ${subtitle ? html`<p>${subtitle}</p>` : null}
        </div>
        <${IconButton} icon="x" label="Fechar" onClick=${onClose} class="modal-close" />
      </header>
      <div class="modal-body">${children}</div>
      ${footer ? html`<footer class="modal-foot">${footer}</footer>` : null}
    </div>
  </div>`
}

function ConfirmDialog({ title, message, confirmLabel = 'Confirmar', cancelLabel = 'Voltar', danger, onClose }) {
  return html`<${Modal}
    size="sm"
    class="dialog"
    title=${title}
    onClose=${() => onClose(false)}
    icon=${danger ? html`<${Icon} name="warning" size=${20} />` : null}
    onKeyDown=${(e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
        e.preventDefault()
        onClose(true)
      }
    }}
    footer=${html`
      <${Button} onClick=${() => onClose(false)}>${cancelLabel}</${Button}>
      <${Button} variant=${danger ? 'danger' : 'primary'} onClick=${() => onClose(true)} data-autofocus>${confirmLabel}</${Button}>
    `}
  >
    ${message ? html`<p class="dialog-text">${message}</p>` : null}
  </${Modal}>`
}

function PromptDialog({ title, label, placeholder, initial = '', confirmLabel = 'OK', hint, onClose }) {
  const [value, setValue] = useState(initial)
  const submit = (e) => {
    e?.preventDefault()
    const v = value.trim()
    if (v) onClose(v)
  }
  return html`<${Modal}
    size="sm"
    class="dialog"
    title=${title}
    onClose=${() => onClose(null)}
    footer=${html`
      <${Button} onClick=${() => onClose(null)}>Cancelar</${Button}>
      <${Button} variant="primary" onClick=${submit} disabled=${!value.trim()}>${confirmLabel}</${Button}>
    `}
  >
    <form onSubmit=${submit} class="field">
      <label class="field-label" for="prompt-input">${label}</label>
      <input id="prompt-input" class="input" type="text" value=${value} placeholder=${placeholder} onInput=${(e) => setValue(e.currentTarget.value)} data-autofocus autocomplete="off" spellcheck="false" />
      ${hint ? html`<span class="field-hint">${hint}</span>` : null}
    </form>
  </${Modal}>`
}

/** Menu pequeno ancorado num botão (ex.: "Arquivos… / Pasta…" no Windows). Devolve o value escolhido. */
function ChoiceMenu({ title, options, anchorRect, foot, onClose }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    ref.current?.querySelector('.menu-item')?.focus({ preventScroll: true })
  }, [])
  const W = 288
  let style
  if (anchorRect) {
    const left = Math.max(12, Math.min(window.innerWidth - W - 12, anchorRect.right - W))
    const below = anchorRect.bottom + 6
    style = below + 200 > window.innerHeight ? `left:${left}px;bottom:${window.innerHeight - anchorRect.top + 6}px` : `left:${left}px;top:${below}px`
  } else style = `left:calc(50% - ${W / 2}px);top:30%`
  const onKey = (e) => {
    const items = [...ref.current.querySelectorAll('.menu-item')]
    const i = items.indexOf(document.activeElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose(null)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length]?.focus()
    }
  }
  return html`<div class="popover-backdrop" onMouseDown=${(e) => e.target === e.currentTarget && onClose(null)}>
    <div class="menu choice-menu" role="menu" aria-label=${title} style=${`${style};width:${W}px`} ref=${ref} onKeyDown=${onKey}>
      ${title ? html`<div class="menu-label">${title}</div>` : null}
      ${options.map(
        (o) => html`<button type="button" role="menuitem" class="menu-item choice-item" onClick=${() => onClose(o.value)}>
          <span class="choice-icon"><${Icon} name=${o.icon || 'doc'} size=${16} /></span>
          <span class="choice-text"><b>${o.label}</b>${o.hint ? html`<span>${o.hint}</span>` : null}</span>
        </button>`,
      )}
      ${foot ? html`<div class="menu-sep"></div><div class="menu-foot">${foot}</div>` : null}
    </div>
  </div>`
}

const TYPES = { local: LocalPicker, drive: DrivePicker, confirm: ConfirmDialog, prompt: PromptDialog, choice: ChoiceMenu }

export function ModalHost() {
  const stack = useModalStack()
  useEffect(() => {
    document.documentElement.classList.toggle('has-modal', stack.length > 0)
  }, [stack.length])
  useEffect(() => {
    window.addEventListener('hashchange', closeAllModals)
    return () => window.removeEventListener('hashchange', closeAllModals)
  }, [])
  return html`${stack.map((m, i) => {
    const C = TYPES[m.type] || registeredModal(m.type)
    if (!C) return null
    return html`<div key=${m.id} class=${cx('modal-layer', i < stack.length - 1 && 'is-under')}>
      <${C} ...${m.props} onClose=${(v) => closeModal(m.id, v)} />
    </div>`
  })}`
}
