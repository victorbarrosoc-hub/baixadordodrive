// Conta SOBEDESCE: o celular usa os Google Drives ligados à conta do site. Aqui ficam as telas antes da principal
// (entrar, conectar um Drive, escolher o Drive, reconectar) e a folha de trocar de Drive.
import { html, useState } from '../vendor/preact-htm.js'
import * as auth from '../lib/auth.js'
import { ACCOUNT } from '../lib/config.js'
import { closeSheet, getState, setState, useApp } from '../lib/state.js'
import { engine } from '../lib/uploader.js'
import { Icon } from './icons.js'
import { Button, Pill, SheetHead, cx } from './ui.js'
import { Avatar } from './main.js'
import { InstallHint } from './install-hint.js'

const asUser = (d) => ({ displayName: d.nome || d.email, emailAddress: d.email, photoLink: d.fotoUrl })

/** Lista dos Drives da conta. O escolhido leva um ✓; quem precisa reconectar, uma pílula. */
export function DriveList({ drives, current, onPick, class: klass }) {
  return html`<ul class=${cx('group menu drive-list', klass)} aria-label="Google Drives da sua conta">
    ${drives.map(
      (d) => html`<li key=${d.id}>
        <button type="button" class="menu-item drive-item" onClick=${() => onPick(d.id)} aria-current=${d.id === current ? 'true' : undefined}>
          <${Avatar} user=${asUser(d)} size=${36} />
          <span class="drive-text">
            <b>${d.nome || d.email}</b>
            ${d.nome ? html`<span class="sub">${d.email}</span>` : null}
          </span>
          ${d.estado === 'reconectar'
            ? html`<${Pill} tone="warning" class="drive-pill">Reconectar</${Pill}>`
            : d.id === current
              ? html`<${Icon} name="check" size=${18} strokeWidth=${2.2} class="drive-check" />`
              : html`<${Icon} name="chevron-right" size=${16} strokeWidth=${2} class="menu-chev" />`}
        </button>
      </li>`,
    )}
  </ul>`
}

/** Troca o Drive deste aparelho. A fila é de um Drive só: com envios na tela, recomeça a página (eles ficam guardados). */
export function switchDrive(id) {
  const cur = getState().drive
  if (cur?.id === id && cur.estado !== 'reconectar' && getState().auth.status === 'signedIn') return closeSheet()
  if (engine.items.length) {
    engine.pauseAll()
    auth.selectDrive(id)
    location.reload()
    return
  }
  setState({ user: null, quota: null, dest: null, sheet: null })
  auth.selectDrive(id)
}

function Hero() {
  return html`<div class="signin-hero" aria-hidden="true">
      <span class="hero-bar hero-up"></span>
      <span class="hero-bar hero-down"></span>
    </div>
    <h1 class="title-xl signin-title"><span class="wordmark-text"><b>SOBE</b><span>DESCE</span></span></h1>`
}

function LinkPill({ href, variant = 'primary', icon, children }) {
  if (variant === 'primary')
    return html`<a class="k-botao" href=${href}>
      ${icon ? html`<${Icon} name=${icon} size=${19} strokeWidth=${2} />` : null}<span>${children}</span>
    </a>`
  return html`<a class=${cx('btn', `btn-${variant}`, 'btn-xl', 'btn-block')} href=${href}>
    ${icon ? html`<${Icon} name=${icon} size=${20} />` : null}<span>${children}</span>
  </a>`
}

/** "Tentar de novo" / "Já conectei": confere a conta outra vez, com o botão ocupado enquanto isso. */
function RecheckButton({ children, variant = 'ghost' }) {
  const [busy, setBusy] = useState(false)
  const run = () => {
    setBusy(true)
    auth.boot().finally(() => setBusy(false))
  }
  return html`<${Button} variant=${variant} size=${variant === 'ghost' ? 'lg' : 'xl'} class=${variant === 'ghost' ? '' : 'btn-block'} icon="refresh" loading=${busy} disabled=${busy} onClick=${run}>
    ${children}
  </${Button}>`
}

export function AccountScreen() {
  const { a, account, drives, drive } = useApp((s) => ({ a: s.auth, account: s.account, drives: s.drives, drive: s.drive }))
  let head = null
  let lead = null
  let body = null
  let foot = 'Os arquivos vão direto deste aparelho para o Google.'

  switch (a.status) {
    case 'loading':
      body = html`<span class="spinner signin-spinner" role="status" aria-label="Abrindo sua conta"></span>`
      foot = null
      break
    case 'signedOut':
      head = 'Entre na sua conta SOBEDESCE'
      lead = 'Os Drives da sua conta já ficam prontos aqui. Vídeos no tamanho original, direto para o Google.'
      body = html`<${LinkPill} href=${ACCOUNT.signIn}>Entrar</${LinkPill}>
        <${LinkPill} href=${ACCOUNT.signUp} variant="secondary">Criar conta</${LinkPill}>`
      break
    case 'noDrive':
      head = 'Conecte um Google Drive na sua conta'
      lead = 'É uma vez só, na página da sua conta. Depois volte para cá.'
      body = html`<${LinkPill} href=${ACCOUNT.manage} icon="drive">Abrir minha conta</${LinkPill}>
        <${RecheckButton}>Já conectei</${RecheckButton}>`
      break
    case 'choose':
      head = 'Para qual Drive?'
      lead = 'Sua conta tem mais de um Google Drive. Este aparelho lembra a escolha.'
      body = html`<${DriveList} drives=${drives} current=${drive?.id} onPick=${switchDrive} />
        <a class="link-btn signin-more" href=${ACCOUNT.manage}><${Icon} name="plus" size=${15} /> Conectar outro Drive</a>`
      break
    case 'reconnect':
      head = 'Reconecte o Google Drive'
      lead = `O Google pediu uma nova autorização para ${drive?.email || 'este Drive'}. Leva um minuto na sua conta.`
      body = html`<${LinkPill} href=${ACCOUNT.manage} icon="drive">Abrir minha conta</${LinkPill}>
        ${drives.length > 1 ? html`<${Button} variant="secondary" size="xl" class="btn-block" onClick=${() => auth.chooseDrive()}>Usar outro Drive</${Button}>` : null}
        <${RecheckButton}>Já reconectei</${RecheckButton}>`
      break
    default:
      head = 'Não consegui abrir sua conta'
      lead = a.error || 'Confira a internet e tente de novo.'
      body = html`<${RecheckButton} variant="primary">Tentar de novo</${RecheckButton}>`
  }

  const error = a.status !== 'error' ? a.error : null
  return html`<div class=${cx('screen', 'signin', `is-${a.status}`)}>
    <main class="signin-main">
      <div class="signin-topo k-entra" style="--i:0"><${Hero} /></div>
      ${head ? html`<h2 class="signin-head k-entra" style="--i:1">${head}</h2>` : null}
      ${lead ? html`<p class="lead signin-lead k-entra" style="--i:2">${lead}</p>` : null}
      <div class="signin-actions k-entra" style="--i:3">
        ${body}
        ${error ? html`<p class="form-error" role="alert"><${Icon} name="warning" size=${16} /> <span>${error}</span></p>` : null}
      </div>
    </main>
    ${foot
      ? html`<footer class="signin-foot">
          ${account ? html`<p class="sub">Conta ${account.email}</p>` : null}
          <p class="sub">${foot}</p>
        </footer>`
      : null}
    ${a.status === 'signedOut' ? html`<${InstallHint} early />` : null}
  </div>`
}

/** Folha "Trocar Drive" (a partir dos Ajustes). */
export function DrivesSheet() {
  const { drives, drive } = useApp((s) => ({ drives: s.drives, drive: s.drive }))
  const [confirm, setConfirm] = useState(null)
  const pick = (id) => {
    if (id !== drive?.id && engine.hasWork() && confirm !== id) return setConfirm(id)
    switchDrive(id)
  }
  return html`<${SheetHead} title="Google Drive" right=${html`<button type="button" class="link-btn is-strong" onClick=${closeSheet}>OK</button>`} />
    <div class="sheet-body sheet-scroll settings">
      <${DriveList} drives=${drives} current=${drive?.id} onPick=${pick} />
      ${confirm
        ? html`<p class="group-foot is-warn" role="alert">Os envios pausam e ficam guardados neste aparelho. Toque de novo para trocar.</p>`
        : html`<p class="group-foot">Os envios vão para o Drive marcado. A escolha fica neste aparelho.</p>`}
      <div class="k-linhas drives-more">
        <a class="k-linha is-botao" href=${ACCOUNT.manage}>
          <span class="k-linha-ic" style="--c:var(--down)"><${Icon} name="plus" size=${17} strokeWidth=${2} /></span>
          <span class="k-linha-txt"><b>Conectar outro Drive</b><span>Na página da sua conta</span></span>
          <span class="k-linha-ctl"><${Icon} name="chevron-right" size=${16} strokeWidth=${2} /></span>
        </a>
      </div>
    </div>`
}
DrivesSheet.label = 'Google Drive'
DrivesSheet.tall = false
