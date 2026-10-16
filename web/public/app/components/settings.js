// Conta e Ajustes: qual Drive recebe, espaço nele, a conta SOBEDESCE, quantos arquivos sobem juntos e o tamanho do
// pedaço.
import { html, useState } from '../vendor/preact-htm.js'
import { ACCOUNT, CHUNK_OPTIONS, CONCURRENCY_OPTIONS, DEV, LAN, VERSION, getSettings, saveSettings } from '../lib/config.js'
import { bytes } from '../lib/format.js'
import { closeSheet, openSheet, useApp } from '../lib/state.js'
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
  const { user, quota, lan, account, drives } = useApp((s) => ({ user: s.user, quota: s.quota, lan: s.lan, account: s.account, drives: s.drives }))
  const [settings, setSettings] = useState(getSettings())

  const update = (patch) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    saveSettings(next)
    engine.pump()
  }

  return html`<${SheetHead}
      title="Ajustes"
      right=${html`<button type="button" class="link-btn is-strong" onClick=${closeSheet}>OK</button>`}
    />
    <div class="sheet-body sheet-scroll settings">
      <section class="group account">
        <${Avatar} user=${user} size=${48} />
        <div class="account-text">
          <b>${user?.displayName || 'Google Drive'}</b>
          <span class="sub">${user?.emailAddress || ''}</span>
          ${LAN ? html`<span class="sub lan-via"><${Icon} name="wifi" size=${13} /> pelo ${LAN.label} “${lan?.mac || LAN.mac}”</span>` : null}
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

      ${LAN
        ? html`<h3 class="list-label">Wi-Fi</h3>
            <p class="group-foot lan-explain">
              Os arquivos vão deste celular para o ${LAN.label} pela rede local, e o SOBEDESCE de lá sobe pro Drive na conta
              acima${lan?.deleteAfterUpload ? ' (e apaga a cópia do computador depois de conferir)' : ''}. A pasta padrão e a conta
              se trocam no computador, em Ajustes → Celular.
            </p>`
        : html`<h3 class="list-label">Conta SOBEDESCE</h3>
      <ul class="group menu">
        <li>
          <button type="button" class="menu-item" onClick=${() => openSheet('drives')}>
            <${Icon} name="drive" /><span>${drives.length > 1 ? 'Trocar de Google Drive' : 'Google Drive'}</span><${Icon} name="chevron-right" size=${16} strokeWidth=${2} class="menu-chev" />
          </button>
        </li>
        <li>
          <a class="menu-item" href=${ACCOUNT.manage}>
            <${Icon} name="user" /><span class="menu-text">Minha conta${account?.email ? html`<small>${account.email}</small>` : null}</span><${Icon} name="chevron-right" size=${16} strokeWidth=${2} class="menu-chev" />
          </a>
        </li>
      </ul>
      <p class="group-foot">Drives, computadores conectados e sair ficam na sua conta.</p>`}

      <p class="foot">
        SOBEDESCE Celular ${VERSION}${DEV ? ' · modo de teste' : LAN ? ' · pelo Wi-Fi' : ''}<br />${LAN
          ? 'Nada passa pela internet até o computador; de lá, direto pro Google.'
          : 'Os arquivos vão direto deste aparelho para o Google.'}
      </p>
    </div>`
}
SettingsSheet.label = 'Ajustes'
SettingsSheet.tall = false
