// Conta e Ajustes: quem está conectado, espaço no Drive, quantos arquivos sobem juntos e o tamanho do pedaço.
import { html, useState } from '../vendor/preact-htm.js'
import * as auth from '../lib/auth.js'
import { CHUNK_OPTIONS, CONCURRENCY_OPTIONS, DEV, VERSION, getSettings, saveSettings } from '../lib/config.js'
import { bytes } from '../lib/format.js'
import { closeSheet, setState, useApp } from '../lib/state.js'
import { engine } from '../lib/uploader.js'
import { Icon } from './icons.js'
import { Segmented, SheetHead, cx } from './ui.js'
import { Avatar } from './main.js'

function Storage({ quota }) {
  if (!quota) return null
  const usage = Number(quota.usage) || 0
  const limit = quota.limit != null ? Number(quota.limit) : null
  const frac = limit ? Math.min(1, usage / limit) : 0
  return html`<div class="storage">
    <div class="storage-text">
      <span>${limit ? `${bytes(usage)} de ${bytes(limit)} usados` : `${bytes(usage)} usados`}</span>
      ${limit ? html`<span class="sub">${bytes(Math.max(0, limit - usage))} livres</span>` : html`<span class="sub">sem limite</span>`}
    </div>
    ${limit
      ? html`<div class=${cx('storage-bar', frac > 0.9 && 'is-full')} role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(frac * 100)} aria-label="Espaço usado no Drive">
          <span style=${`width:${(frac * 100).toFixed(2)}%`}></span>
        </div>`
      : null}
  </div>`
}

export function SettingsSheet() {
  const { user, quota } = useApp((s) => ({ user: s.user, quota: s.quota }))
  const [settings, setSettings] = useState(getSettings())
  const [confirmOut, setConfirmOut] = useState(false)

  const update = (patch) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    saveSettings(next)
    engine.pump()
  }

  const signOut = () => {
    if (engine.hasWork() && !confirmOut) {
      setConfirmOut(true)
      return
    }
    engine.pauseAll()
    closeSheet()
    auth.signOut()
  }

  return html`<${SheetHead}
      title="Ajustes"
      right=${html`<button type="button" class="link-btn is-strong" onClick=${closeSheet}>OK</button>`}
    />
    <div class="sheet-body sheet-scroll settings">
      <section class="group account">
        <${Avatar} user=${user} size=${48} />
        <div class="account-text">
          <b>${user?.displayName || 'Conta Google'}</b>
          <span class="sub">${user?.emailAddress || ''}</span>
        </div>
      </section>
      ${quota ? html`<section class="group"><${Storage} quota=${quota} /></section>` : null}

      <h3 class="list-label">Envio</h3>
      <section class="group form-group">
        <div class="setting">
          <div class="setting-text">
            <b>Arquivos ao mesmo tempo</b>
            <span class="sub">Mais arquivos juntos enchem melhor um Wi-Fi rápido.</span>
          </div>
          <${Segmented} label="Arquivos ao mesmo tempo" value=${settings.concurrency} options=${CONCURRENCY_OPTIONS} onChange=${(v) => update({ concurrency: v })} />
        </div>
        <div class="setting">
          <div class="setting-text">
            <b>Tamanho de cada pedaço</b>
            <span class="sub">Maior rende mais com rede boa; menor perde menos quando a rede oscila.</span>
          </div>
          <${Segmented}
            label="Tamanho de cada pedaço"
            value=${settings.chunkMiB}
            options=${CHUNK_OPTIONS}
            format=${(v) => html`${v}<small> MiB</small>`}
            onChange=${(v) => update({ chunkMiB: v })}
          />
        </div>
      </section>

      <h3 class="list-label">Conta</h3>
      <ul class="group menu">
        <li>
          <button
            type="button"
            class="menu-item"
            onClick=${() => {
              closeSheet()
              setState({ screen: 'setup' })
            }}
            disabled=${Boolean(DEV)}
          >
            <${Icon} name="key" /><span>Trocar ID do cliente</span><${Icon} name="chevron-right" size=${16} strokeWidth=${2} class="menu-chev" />
          </button>
        </li>
        <li>
          <button type="button" class="menu-item is-danger" onClick=${signOut}>
            <${Icon} name="logout" /><span>${confirmOut ? 'Sair e pausar os envios' : 'Sair'}</span>
          </button>
        </li>
      </ul>
      ${confirmOut
        ? html`<p class="group-foot">Os envios pausam e ficam guardados neste aparelho. Ao entrar de novo, é só escolher os arquivos para continuar.</p>`
        : null}

      <p class="foot">SOBEDESCE Celular ${VERSION}${DEV ? ' · modo de teste' : ''}<br />Os arquivos vão direto deste aparelho para o Google.</p>
    </div>`
}
SettingsSheet.label = 'Ajustes'
SettingsSheet.tall = false
