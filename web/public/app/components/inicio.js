// Início (aba de entrada): a saudação, os atalhos para as outras abas, o espaço no Drive e as pastas recentes.
// Fica em cima do botão de enviar quando nada está subindo; com a fila andando, some para a fila aparecer sem rolar.
import { html } from '../vendor/preact-htm.js'
import { bytes } from '../lib/format.js'
import { folderTrail, getRecents, setState, setTab, toast, useApp } from '../lib/state.js'
import { Icon } from './icons.js'
import { cx } from './ui.js'

function saudacao(agora = new Date()) {
  const h = agora.getHours()
  return h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'
}

export function Saudacao({ user }) {
  const account = useApp((s) => s.account)
  const nome = (account?.nome || user?.displayName || '').trim().split(/\s+/)[0]
  const data = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
  return html`<div class="ini-ola ini-entra" style="--i:0">
    <p class="ini-data">${data}</p>
    <h1>${saudacao()}${nome ? `, ${nome}` : ''}</h1>
  </div>`
}

/** Atalhos para as outras abas, em blocos grandes de um toque. */
export function Atalhos() {
  const refsOn = useApp((s) => Boolean(s.recursos?.referencias))
  const itens = [
    { tab: 'drive', icon: 'drive', nome: 'Drive', sub: 'Ver e baixar', tom: 'down' },
    refsOn ? { tab: 'refs', icon: 'bookmark', nome: 'Referências', sub: 'Salvos', tom: 'refs' } : null,
    { tab: 'criar', icon: 'sparkle', nome: 'Criar', sub: 'Frames e mais', tom: 'criar' },
  ].filter(Boolean)
  return html`<nav class=${cx('ini-atalhos', `n-${itens.length}`)} aria-label="Atalhos">
    ${itens.map(
      (a, i) => html`<button key=${a.tab} type="button" class=${cx('ini-atalho', 'ini-entra', `tom-${a.tom}`)} style=${`--i:${i + 3}`} onClick=${() => setTab(a.tab)}>
        <span class="ini-atalho-icon"><${Icon} name=${a.icon} size=${20} /></span>
        <b>${a.nome}</b>
        <span>${a.sub}</span>
      </button>`,
    )}
  </nav>`
}

/** Espaço no Drive escolhido: uma barra e o quanto sobra. */
export function Espaco() {
  const quota = useApp((s) => s.quota)
  const limit = quota?.limit != null ? Number(quota.limit) : null
  // Sem limite (conta corporativa) não tem o que mostrar: fica de fora para não encher a tela.
  if (!limit) return null
  const usage = Number(quota.usage) || 0
  const frac = Math.min(1, usage / limit)
  return html`<section class="ini-espaco ini-entra" style="--i:6" aria-label="Espaço no Drive">
    <div class="ini-espaco-txt">
      <span class="ini-rotulo">Espaço no Drive</span>
      <b>${bytes(Math.max(0, limit - usage))} livres</b>
    </div>
    <div class=${cx('ini-espaco-barra', frac > 0.9 && 'is-cheio')} role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(frac * 100)} aria-label="Espaço usado">
      <span style=${`--f:${frac.toFixed(4)}`}></span>
    </div>
    <span class="ini-espaco-sub">${bytes(usage)} de ${bytes(limit)}</span>
  </section>`
}

/** As últimas pastas usadas: um toque e o próximo envio vai para lá. */
export function Recentes({ user, dest }) {
  const lista = getRecents(user?.emailAddress).filter((r) => r.id !== dest?.id).slice(0, 4)
  if (!lista.length) return null
  return html`<section class="ini-recentes ini-entra" style="--i:7" aria-label="Pastas recentes">
    <h2 class="ini-rotulo">Pastas recentes</h2>
    <ul>
      ${lista.map(
        (r) => html`<li key=${r.id}>
          <button type="button" onClick=${() => {
            setState({ dest: { id: r.id, name: r.name, driveId: r.driveId || null, path: r.path || [] } })
            toast(`Próximo envio vai para ${r.name}`, { tone: 'success' })
          }}>
            <span class="ini-pasta-icon"><${Icon} name=${r.id === 'root' ? 'disk' : 'folder'} size=${17} /></span>
            <span class="ini-pasta-txt"><b>${r.name}</b>${folderTrail(r, { skipLast: true }) ? html`<span>${folderTrail(r, { skipLast: true })}</span>` : null}</span>
            <${Icon} name="chevron-right" size=${15} strokeWidth=${2} class="ini-pasta-ir" />
          </button>
        </li>`,
      )}
    </ul>
  </section>`
}
