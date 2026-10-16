// Abas do app (embaixo, como no iOS): Enviar (violeta) e Drive (azul). No modo Wi-Fi não há aba Drive: lá o
// celular não tem token do Google.
import { html, useRef } from '../vendor/preact-htm.js'
import { setTab, useApp } from '../lib/state.js'
import { engine, summarize } from '../lib/uploader.js'
import { Icon } from './icons.js'
import { cx, useEngine } from './ui.js'
import { MainScreen } from './main.js'
import { DriveScreen } from './browser.js'

function TabBar({ tab }) {
  useEngine()
  const sum = summarize(engine.items)
  const busy = sum.pending > 0
  return html`<nav class="tabbar" aria-label="Seções">
    <button type="button" class=${cx('tab', 'tab-up', tab === 'send' && 'is-on')} aria-current=${tab === 'send' ? 'page' : undefined} onClick=${() => setTab('send')}>
      <span class="tab-icon">
        <${Icon} name="upload" size=${24} strokeWidth=${tab === 'send' ? 2 : 1.7} />
        ${busy ? html`<span class="tab-dot" aria-label="Enviando"></span>` : null}
      </span>
      <span class="tab-label">Enviar</span>
    </button>
    <button type="button" class=${cx('tab', 'tab-down', tab === 'drive' && 'is-on')} aria-current=${tab === 'drive' ? 'page' : undefined} onClick=${() => setTab('drive')}>
      <span class="tab-icon"><${Icon} name="drive" size=${24} strokeWidth=${tab === 'drive' ? 2 : 1.7} /></span>
      <span class="tab-label">Drive</span>
    </button>
  </nav>`
}

/** As duas telas ficam montadas (a do Drive só depois da primeira visita): trocar de aba não perde nada. */
export function Tabs() {
  const tab = useApp((s) => s.tab)
  const seen = useRef(false)
  if (tab === 'drive') seen.current = true
  return html`<div class="tabs">
    <div class="tab-pane" hidden=${tab !== 'send'}><${MainScreen} /></div>
    ${seen.current ? html`<div class="tab-pane" hidden=${tab !== 'drive'}><${DriveScreen} active=${tab === 'drive'} /></div>` : null}
    <${TabBar} tab=${tab} />
  </div>`
}
