// Pilha de avisos no canto inferior direito.
import { html } from '/vendor/preact-htm.js'
import { dismiss, holdToast, releaseToast, useToasts } from '../lib/toasts.js'
import { Icon } from './icons.js'
import { LinkShareCard } from './link-share.js'

const ICONS = { success: 'circle-check', error: 'warning', warning: 'warning', info: 'info' }

export function Toasts() {
  const list = useToasts()
  return html`<div class="toasts" aria-live="polite" aria-relevant="additions">
    <${LinkShareCard} />
    ${list.map(
      (t) => html`<div
        key=${t.id}
        class=${`toast toast-${t.kind}`}
        role=${t.kind === 'error' ? 'alert' : 'status'}
        onMouseEnter=${() => holdToast(t.id)}
        onMouseLeave=${() => releaseToast(t.id)}
      >
        <span class="toast-icon"><${Icon} name=${ICONS[t.kind] || 'info'} size=${17} /></span>
        <div class="toast-text">
          ${t.title ? html`<b>${t.title}</b>` : null}
          <span>${t.message}</span>
          ${t.action
            ? t.action.href
              ? html`<a class="toast-action" href=${t.action.href} onClick=${() => dismiss(t.id)}>${t.action.label} <${Icon} name="arrow-right" size=${12} /></a>`
              : html`<button type="button" class="toast-action" onClick=${() => { t.action.onClick?.(); dismiss(t.id) }}>${t.action.label}</button>`
            : null}
        </div>
        <button type="button" class="toast-close" aria-label="Fechar aviso" onClick=${() => dismiss(t.id)}><${Icon} name="x" size=${13} /></button>
      </div>`,
    )}
  </div>`
}
