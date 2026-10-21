// Barra lateral translúcida: marca, navegação (com contador ao vivo), aviso de versão nova, medidores ↓/↑ e a conta.
import { html, useMemo, useRef, useState } from '/vendor/preact-htm.js'
import { useStore, activeCount, setActiveAccount } from '../lib/store.js'
import { navigate } from '../lib/router.js'
import { bytes, count } from '../lib/format.js'
import { cx, useDismiss } from '../lib/ui.js'
import { Icon, Wordmark } from './icons.js'
import { Avatar } from './common.js'
import { LevelMeter } from './meter.js'
import { useAbout } from './drive-data.js'
import { UpdateCard } from './versao.js'

// O que se usa todo dia em cima; Dispositivos e Ajustes embaixo. Frames e Cartões com item próprio (não ficam escondidos).
const NAV = [
  { id: 'painel', label: 'Início', icon: 'home' },
  { id: 'transferencias', label: 'Transferências', icon: 'transfers' },
  { id: 'drive', label: 'Drive', icon: 'cloud' },
  { id: 'referencias', label: 'Referências', icon: 'bookmark' },
  { id: 'frames', label: 'Frames', icon: 'frames' },
  { id: 'cartoes', label: 'Cartões', icon: 'sdcard' },
  { id: 'comparar', label: 'Comparar', icon: 'compare' },
]
const NAV_BAIXO = [
  { id: 'computadores', label: 'Dispositivos', icon: 'laptop' },
  { id: 'ajustes', label: 'Ajustes', icon: 'sliders' },
]

function NavBadge() {
  const transfers = useStore((s) => s.transfers)
  const n = useMemo(() => activeCount(transfers), [transfers])
  if (!n) return null
  return html`<span class="nav-badge" aria-label=${`${n} em andamento`}>${n > 999 ? '999+' : count(n)}</span>`
}

/** Referências sendo salvas agora (downloads do yt-dlp e envios). */
function RefBadge() {
  const ref = useStore((s) => s.referencias)
  const n = useMemo(() => (ref?.trabalhos || []).filter((t) => ['na_fila', 'baixando', 'enviando', 'concluindo'].includes(t.fase)).length, [ref])
  if (!n) return null
  return html`<span class="nav-badge" aria-label=${`${n} salvando`}>${count(n)}</span>`
}

function Meters() {
  const stats = useStore((s) => s.stats)
  const conn = useStore((s) => s.conn)
  const max = useMemo(() => {
    let m = 0
    for (const p of stats.history || []) m = Math.max(m, p.down || 0, p.up || 0)
    return Math.max(m, stats.down?.speed || 0, stats.up?.speed || 0, 5e6)
  }, [stats])
  return html`<div class="meters" aria-label="Velocidade agora">
    ${conn === 'lost' ? html`<div class="conn-lost" role="status"><span class="pulse"></span>Reconectando ao motor…</div>` : null}
    <${LevelMeter} dir="down" speed=${stats.down?.speed || 0} max=${max} />
    <${LevelMeter} dir="up" speed=${stats.up?.speed || 0} max=${max} />
  </div>`
}

function AccountMenu({ accounts, active, onClose }) {
  const ref = useRef(null)
  useDismiss(ref, onClose)
  const about = useAbout(active?.id)
  const q = about?.quota
  const frac = q?.limit ? Math.min(1, (q.usage || 0) / q.limit) : null
  return html`<div class="menu account-menu" role="menu" ref=${ref}>
    ${active
      ? html`<div class="menu-head">
          <${Avatar} name=${active.name} email=${active.email} photoUrl=${active.photoUrl} size=${36} />
          <div class="menu-head-text">
            <b>${active.name || active.email}</b>
            <span>${active.email}</span>
          </div>
        </div>
        ${frac != null
          ? html`<div class="menu-quota">
              <span class="quota-bar"><i style=${`width:${(frac * 100).toFixed(1)}%`}></i></span>
              <span class="sub">${bytes(q.usage)} de ${bytes(q.limit)} no Drive</span>
            </div>`
          : null}`
      : null}
    ${accounts.length > 1
      ? html`<div class="menu-sep"></div>
          <div class="menu-label">Trocar de conta</div>
          ${accounts.map(
            (a) => html`<button
              type="button"
              role="menuitemradio"
              aria-checked=${a.id === active?.id ? 'true' : 'false'}
              class="menu-item"
              onClick=${() => {
                setActiveAccount(a.id)
                // cada conta tem seu próprio Drive: volta para a raiz
                if (location.hash.startsWith('#/drive/')) navigate('drive')
                onClose()
              }}
            >
              <${Avatar} name=${a.name} email=${a.email} photoUrl=${a.photoUrl} size=${22} />
              <span class="menu-item-text">${a.email}</span>
              ${a.source === 'nuvem' ? html`<span class="menu-item-tag" title="Da conta SOBEDESCE"><${Icon} name="cloud" size=${13} /></span>` : null}
              ${a.id === active?.id ? html`<${Icon} name="check" size=${14} />` : null}
              ${a.status === 'reauth' ? html`<${Icon} name="warning" size=${14} class="tone-warning" />` : null}
            </button>`,
          )}`
      : null}
    <div class="menu-sep"></div>
    <button type="button" class="menu-item" role="menuitem" onClick=${() => { navigate('ajustes/contas'); onClose() }}><${Icon} name="cloud" size=${15} /><span class="menu-item-text">Conta e Drives</span></button>
    <button type="button" class="menu-item" role="menuitem" onClick=${() => { navigate('ajustes'); onClose() }}><${Icon} name="sliders" size=${15} /><span class="menu-item-text">Ajustes</span></button>
  </div>`
}

function AccountChip() {
  const accounts = useStore((s) => s.accounts)
  const activeId = useStore((s) => s.activeAccountId)
  const [open, setOpen] = useState(false)
  const active = accounts.find((a) => a.id === activeId) || accounts[0]
  if (!active) return null
  return html`<div class="account">
    ${open ? html`<${AccountMenu} accounts=${accounts} active=${active} onClose=${() => setOpen(false)} />` : null}
    <button type="button" class=${cx('account-chip', open && 'is-open')} aria-haspopup="menu" aria-expanded=${open ? 'true' : 'false'} onClick=${() => setOpen(!open)}>
      <${Avatar} name=${active.name} email=${active.email} photoUrl=${active.photoUrl} size=${28} />
      <span class="account-text">
        <b>${active.name || (active.email || '').split('@')[0]}</b>
        <span>${active.email}</span>
      </span>
      ${active.status === 'reauth' ? html`<${Icon} name="warning" size=${14} class="tone-warning" />` : html`<${Icon} name="chevron-updown" size=${14} />`}
    </button>
  </div>`
}

function NavItem({ n, current }) {
  const on = current === n.id || n.tambem?.includes(current)
  return html`<a href=${`#/${n.id}`} class=${cx('nav-item', on && 'is-on')} aria-current=${on ? 'page' : undefined}>
    <${Icon} name=${n.icon} size=${17} />
    <span>${n.label}</span>
    ${n.id === 'transferencias' ? html`<${NavBadge} />` : null}
    ${n.id === 'referencias' ? html`<${RefBadge} />` : null}
  </a>`
}

export function Sidebar({ current }) {
  return html`<aside class="sidebar">
    <div class="sidebar-brand"><a href="#/painel" aria-label="SOBEDESCE — início"><${Wordmark} size=${22} /></a></div>
    <nav class="nav" aria-label="Principal">
      ${NAV.map((n) => html`<${NavItem} n=${n} current=${current} />`)}
    </nav>
    <nav class="nav nav-baixo" aria-label="Dispositivos e ajustes">
      ${NAV_BAIXO.map((n) => html`<${NavItem} n=${n} current=${current} />`)}
    </nav>
    <div class="sidebar-foot">
      <${UpdateCard} />
      <${Meters} />
      <${AccountChip} />
    </div>
  </aside>`
}
