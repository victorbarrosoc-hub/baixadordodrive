// Peças comuns: botão, pílula, controle segmentado, sheet (folha que sobe de baixo, como no iOS) e avisos.
import { html, useEffect, useReducer, useRef, useState } from '../vendor/preact-htm.js'
import { closeSheet, useApp } from '../lib/state.js'
import { engine } from '../lib/uploader.js'
import { Icon } from './icons.js'

export const cx = (...xs) => xs.filter(Boolean).join(' ')

export const reducedMotion = () => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** Redesenha quando o motor de envio muda (já vem limitado a ~5×/s). */
export function useEngine() {
  const [, force] = useReducer((x) => x + 1, 0)
  useEffect(() => engine.subscribe(force), [])
  return engine
}

export function Button({ variant = 'secondary', size, icon, iconRight, loading, class: klass, children, ...rest }) {
  return html`<button type="button" class=${cx('btn', `btn-${variant}`, size && `btn-${size}`, loading && 'is-loading', klass)} ...${rest}>
    ${loading ? html`<span class="spinner" aria-hidden="true"></span>` : icon ? html`<${Icon} name=${icon} size=${size === 'xl' ? 20 : 17} />` : null}
    ${children != null ? html`<span>${children}</span>` : null}
    ${iconRight ? html`<${Icon} name=${iconRight} size=${15} />` : null}
  </button>`
}

export function Pill({ tone = 'neutral', icon, children, class: klass }) {
  return html`<span class=${cx('pill', `pill-${tone}`, klass)}>
    ${icon ? html`<${Icon} name=${icon} size=${12} strokeWidth=${2} />` : null}<span class="pill-text">${children}</span>
  </span>`
}

export function Segmented({ label, value, options, onChange, format = (v) => v }) {
  return html`<div class="segmented" role="radiogroup" aria-label=${label}>
    ${options.map(
      (opt) => html`<button
        type="button"
        role="radio"
        aria-checked=${opt === value ? 'true' : 'false'}
        class=${cx('segmented-opt', opt === value && 'is-on')}
        onClick=${() => onChange(opt)}
      >
        ${format(opt)}
      </button>`,
    )}
  </div>`
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.className = 'offscreen'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

// ───── sheet ─────

/**
 * Mostra a sheet pedida em state.sheet, com entrada/saída animadas. `registry` mapeia nome → componente.
 * Fecha tocando no fundo, arrastando a alça para baixo ou com Esc.
 */
export function SheetHost({ registry }) {
  const sheet = useApp((s) => s.sheet)
  const [shown, setShown] = useState(sheet)
  const [phase, setPhase] = useState(sheet ? 'open' : 'closed')

  useEffect(() => {
    if (sheet) {
      setShown(sheet)
      if (phase === 'closed' || phase === 'leave') {
        setPhase('enter')
        const raf = requestAnimationFrame(() => requestAnimationFrame(() => setPhase('open')))
        return () => cancelAnimationFrame(raf)
      }
    } else if (shown) {
      setPhase('leave')
      const t = setTimeout(
        () => {
          setShown(null)
          setPhase('closed')
        },
        reducedMotion() ? 0 : 300,
      )
      return () => clearTimeout(t)
    }
  }, [sheet])

  useEffect(() => {
    document.documentElement.classList.toggle('has-sheet', Boolean(shown))
  }, [shown])

  if (!shown) return null
  const Comp = registry[shown.name]
  if (!Comp) return null
  return html`<${SheetFrame} phase=${phase} label=${Comp.label || ''} tall=${Comp.tall}>
    <${Comp} ...${shown.props} />
  </${SheetFrame}>`
}

function SheetFrame({ phase, label, tall, children }) {
  const ref = useRef(null)
  const drag = useRef(null)
  const lastFocus = useRef(null)

  useEffect(() => {
    lastFocus.current = document.activeElement
    const onKey = (e) => {
      if (e.key === 'Escape') closeSheet()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      try {
        lastFocus.current?.focus?.({ preventScroll: true })
      } catch {
        // elemento já saiu da tela
      }
    }
  }, [])

  useEffect(() => {
    if (phase === 'open') ref.current?.focus({ preventScroll: true })
  }, [phase])

  const onPointerDown = (e) => {
    if (!e.target.closest('[data-drag]') || e.target.closest('button, input, a')) return
    drag.current = { y0: e.clientY, t0: performance.now(), dy: 0, id: e.pointerId }
    ref.current.setPointerCapture?.(e.pointerId)
    ref.current.classList.add('is-dragging')
  }
  const onPointerMove = (e) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    d.dy = Math.max(0, e.clientY - d.y0)
    ref.current.style.transform = `translate3d(0, ${d.dy}px, 0)`
  }
  const onPointerUp = (e) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    const el = ref.current
    el.classList.remove('is-dragging')
    const v = d.dy / Math.max(1, performance.now() - d.t0)
    el.style.transform = ''
    if (d.dy > 120 || (d.dy > 40 && v > 0.6)) closeSheet()
  }

  return html`<div class=${cx('sheet-layer', `is-${phase}`)}>
    <div class="sheet-backdrop" onClick=${closeSheet} aria-hidden="true"></div>
    <div
      ref=${ref}
      class=${cx('sheet', tall && 'sheet-tall')}
      role="dialog"
      aria-modal="true"
      aria-label=${label}
      tabindex="-1"
      onPointerDown=${onPointerDown}
      onPointerMove=${onPointerMove}
      onPointerUp=${onPointerUp}
      onPointerCancel=${onPointerUp}
    >
      <div class="sheet-grab" data-drag aria-hidden="true"><span></span></div>
      ${children}
    </div>
  </div>`
}

/** Cabeçalho padrão de sheet: ação à esquerda, título no centro, ação à direita. Arrastável. */
export function SheetHead({ title, left, right }) {
  return html`<header class="sheet-head" data-drag>
    <div class="sheet-head-side">${left}</div>
    <h2 class="sheet-title">${title}</h2>
    <div class="sheet-head-side is-right">${right}</div>
  </header>`
}

// ───── avisos ─────

export function Toasts() {
  const toasts = useApp((s) => s.toasts)
  return html`<div class="toasts" role="status" aria-live="polite">
    ${toasts.map(
      (t) => html`<div key=${t.id} class=${cx('toast', `toast-${t.tone}`)}>
        ${t.tone === 'success' ? html`<${Icon} name="circle-check" size=${17} />` : t.tone === 'error' ? html`<${Icon} name="warning" size=${17} />` : null}
        <span>${t.text}</span>
      </div>`,
    )}
  </div>`
}
