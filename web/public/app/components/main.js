// Tela principal (aba Início): a saudação, o destino, o botão grande de escolher arquivos, os atalhos, o espaço no
// Drive, as pastas recentes e a fila. Com a fila andando, o topo encolhe e fica só o que importa para o envio.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js'
import * as auth from '../lib/auth.js'
import { ACCOUNT, DEV, LAN, local } from '../lib/config.js'
import { about, isRetryable } from '../lib/drive.js'
import { lanInfo } from '../lib/lan.js'
import { bytes, initials, plural, speed, timecode } from '../lib/format.js'
import { MY_DRIVE, folderTrail, getRecents, getState, openSheet, pushRecent, setState, toast, useApp } from '../lib/state.js'
import { NET_MSG, engine, summarize } from '../lib/uploader.js'
import { Icon, Wordmark } from './icons.js'
import { Button, cx, useEngine } from './ui.js'
import { BatchCards, FileName, QueueRow, SequenceBar } from './queue.js'
import { InstallHint } from './install-hint.js'
import { isIOS } from '../lib/platform.js'
import { ComputerCard } from './computador.js'
import { Atalhos, Espaco, Recentes, Saudacao } from './inicio.js'
import { P2pAndamentoCompacto } from './p2p.js'

export function Avatar({ user, size = 32 }) {
  const [broken, setBroken] = useState(false)
  const photo = !DEV && !broken ? user?.photoLink : null
  return html`<span class="avatar" style=${`width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px`}>
    ${photo
      ? html`<img src=${photo} alt="" width=${size} height=${size} referrerpolicy="no-referrer" onError=${() => setBroken(true)} />`
      : initials(user?.displayName, user?.emailAddress)}
  </span>`
}

/** A barra do topo (marca e conta) nas abas sem barra própria (Referências, Criar), igual à do Início. */
export function TopoMarca() {
  const user = useApp((s) => s.user)
  return html`<header class="topbar">
    <div class="topbar-row">
      <${Wordmark} size=${24} />
      <button type="button" class="avatar-btn" onClick=${() => openSheet('settings')} aria-label="Conta e ajustes">
        <${Avatar} user=${user} size=${32} />
      </button>
    </div>
  </header>`
}

/** Modo Wi-Fi: a conta e a pasta padrão vêm do computador (GET /m/api/info). Sem resposta, tenta de novo sozinho. */
function useLanAccount() {
  const user = useApp((s) => s.user)
  const [tries, setTries] = useState(0)
  useEffect(() => {
    if (!LAN || user) return
    const ctl = new AbortController()
    let timer = 0
    lanInfo(ctl.signal).then(
      (info) => {
        const email = info.account?.email || null
        setState({
          user: { displayName: info.account?.name || email || 'Sem conta', emailAddress: email || '' },
          quota: null,
          lan: { mac: info.mac?.name || LAN.mac, noAccount: !info.account, deleteAfterUpload: !!info.deleteAfterUpload, error: null, badCode: false },
        })
        engine.setAccount(email)
        if (!getState().dest) setState({ dest: getRecents(email)[0] || info.folder || MY_DRIVE })
        engine.restore()
      },
      (err) => {
        if (ctl.signal.aborted) return
        setState({ lan: { ...(getState().lan || {}), error: err.message, badCode: err.status === 401 } })
        if (err.status !== 401) timer = setTimeout(() => setTries((n) => n + 1), 4000)
      },
    )
    return () => {
      ctl.abort()
      clearTimeout(timer)
    }
  }, [user, tries])
  return user
}

/** Quem é o dono do Drive escolhido e quanto espaço tem (/about, com o token que a conta entrega). */
function useAccount() {
  const { user, driveId } = useApp((s) => ({ user: s.user, driveId: s.drive?.id }))
  useEffect(() => {
    if (user || LAN || !driveId) return
    const ctl = new AbortController()
    about(ctl.signal).then(
      (r) => {
        if (getState().drive?.id !== driveId) return
        const u = r.user || {}
        setState({ user: u, quota: r.storageQuota || null })
        engine.setAccount(u.emailAddress)
        if (!getState().dest) setState({ dest: getRecents(u.emailAddress)[0] || MY_DRIVE })
        engine.restore()
      },
      (err) => {
        if (ctl.signal.aborted || err?.signedOut) return
        if (err?.status === 401 || (err?.status === 403 && !isRetryable(err))) {
          auth.needsReconnect('O Google não liberou o acesso a este Drive. Reconecte na sua conta.')
        } else {
          toast('Não consegui falar com o Google. Confira a internet.', { tone: 'error', ms: 4000 })
          setState({ dest: getState().dest || MY_DRIVE })
        }
      },
    )
    return () => ctl.abort()
  }, [user, driveId])
  return user
}

function Header({ user, sum, items, waiting, awake }) {
  const active = sum.pending + sum.paused > 0
  const allPaused = sum.pending === 0 && sum.paused > 0
  const label = allPaused ? 'Pausado' : sum.speed > 0 ? speed(sum.speed) : waiting ? 'Esperando a conta' : 'Preparando…'
  return html`<header class=${cx('topbar', active && 'is-active')}>
    <div class="topbar-row">
      <${Wordmark} size=${24} />
      <button type="button" class="avatar-btn" onClick=${() => openSheet('settings')} aria-label="Conta e ajustes">
        <${Avatar} user=${user} size=${32} />
      </button>
    </div>
    ${active
      ? html`<div class="meter" aria-label="Progresso total">
          <div class="meter-main">
            <div class="meter-left">
              <p class="meter-speed">
                <${Icon} name="arrow-up" size=${15} strokeWidth=${2.2} />
                <span>${label}</span>
              </p>
              <p class="meter-sub">${sum.finished} de ${sum.total} · ${bytes(sum.remaining)} restantes</p>
            </div>
            <span class="tc meter-tc" aria-label="tempo restante">${allPaused || !sum.speed ? '--:--:--' : timecode(sum.eta)}</span>
            <button
              type="button"
              class="icon-btn meter-btn"
              onClick=${() => (allPaused ? engine.resumeAll() : engine.pauseAll())}
              aria-label=${allPaused ? 'Retomar tudo' : 'Pausar tudo'}
            >
              <${Icon} name=${allPaused ? 'play' : 'pause'} size=${16} strokeWidth=${2} />
            </button>
          </div>
          <${SequenceBar} items=${items} />
          ${engine.net.bad && !allPaused
            ? html`<p class="meter-net" role="status">
                <${Icon} name="wifi" size=${14} strokeWidth=${2.2} />
                <span>${NET_MSG}</span>
              </p>`
            : null}
          ${sum.running
            ? html`<p class="meter-awake" role="status">
                <span class="awake-dot" aria-hidden="true"></span>
                <span><b>Mantenha esta tela aberta</b> · ${awake ? 'ela fica acesa sozinha' : 'se bloquear, o envio pausa'}</span>
              </p>`
            : null}
        </div>`
      : null}
  </header>`
}

function Destination({ dest, compact }) {
  if (!dest) {
    return html`<div class=${cx('dest', 'is-loading', compact && 'is-compact')} aria-busy="true"><span class="skeleton skeleton-line"></span></div>`
  }
  const trail = folderTrail(dest, { skipLast: true })
  const isShared = Boolean(dest.driveId)
  const icon = dest.id === 'root' ? 'disk' : isShared && dest.path?.length === 1 ? 'shared-drive' : 'folder'
  if (compact) {
    return html`<button type="button" class="dest is-compact" onClick=${() => openSheet('folders')} aria-label=${`Destino: ${folderTrail(dest)}. Trocar pasta`}>
      <span class="dest-icon" aria-hidden="true"><${Icon} name=${icon} size=${18} /></span>
      <span class="dest-text">
        <span class="dest-eyebrow">Enviar para</span>
        <span class="dest-name">${dest.name}</span>
      </span>
      <${Icon} name="chevron-right" size=${15} strokeWidth=${2} class="dest-chev" />
    </button>`
  }
  return html`<button type="button" class="dest" onClick=${() => openSheet('folders')} aria-label=${`Destino: ${folderTrail(dest)}. Trocar pasta`}>
    <span class="dest-eyebrow">Enviar para</span>
    <span class="dest-row">
      <span class="dest-icon" aria-hidden="true"><${Icon} name=${icon} size=${22} /></span>
      <span class="dest-text">
        <span class="dest-name">${dest.name}</span>
        ${trail ? html`<span class="dest-trail">${trail}</span>` : html`<span class="dest-trail">${isShared ? 'Drive compartilhado' : 'Pasta principal do seu Drive'}</span>`}
      </span>
      <span class="dest-change">Trocar <${Icon} name="chevron-right" size=${14} strokeWidth=${2} /></span>
    </span>
  </button>`
}

// Dica do app Arquivos (iPhone): aparece aberta até a primeira escolha; depois fica recolhida num toque.
const TIP_KEY = 'sobedesce.dicaArquivos'

function FilesTip() {
  const [seen] = useState(() => local.get(TIP_KEY) === 'vista')
  const text = html`Para vídeos no tamanho original, escolha pelo app <b>Arquivos</b>; pela Fototeca o iPhone às vezes converte.`
  if (!seen) return html`<p class="tip"><${Icon} name="info" size=${15} /> <span>${text}</span></p>`
  return html`<details class="tip tip-more">
    <summary><${Icon} name="info" size=${15} /> <span>Vídeo no tamanho original?</span></summary>
    <p>${text}</p>
  </details>`
}

/** O botão grande de escolher arquivos; com a fila andando, vira o "+ Adicionar" ao lado do destino. */
function Picker({ dest, account, compact }) {
  const input = useRef(null)
  const onChange = (e) => {
    const files = [...(e.currentTarget.files || [])]
    e.currentTarget.value = ''
    if (!files.length || !dest) return
    if (isIOS) local.set(TIP_KEY, 'vista')
    const r = engine.addFiles(files, dest)
    pushRecent(dest, account)
    if (r.resumed) toast(r.resumed === 1 ? 'Continuando de onde parou' : `${r.resumed} envios continuando de onde pararam`, { tone: 'success' })
    if (r.dupes) toast(r.dupes === 1 ? 'Esse arquivo já está na fila' : `${r.dupes} arquivos já estavam na fila`)
  }
  const field = html`<input ref=${input} id="file-input" class="offscreen" type="file" multiple onChange=${onChange} disabled=${!dest} />`
  if (compact) {
    return html`<div class="picker is-compact">
      ${field}
      <label for="file-input" class=${cx('pick-add', !dest && 'is-disabled')} aria-label="Adicionar arquivos">
        <${Icon} name="plus" size=${18} strokeWidth=${2.2} /><span>Adicionar</span>
      </label>
    </div>`
  }
  return html`<div class="picker">
    ${field}
    <label for="file-input" class=${cx('pick', !dest && 'is-disabled')}>
      <span class="pick-icon" aria-hidden="true"><${Icon} name="upload" size=${24} strokeWidth=${1.8} /></span>
      <span class="pick-text">
        <b>Escolher arquivos</b>
        <span>Vídeos, fotos, qualquer tamanho</span>
      </span>
    </label>
    ${isIOS ? html`<${FilesTip} />` : null}
  </div>`
}

/**
 * Envios que ficaram pela metade (a página recarregou): o botão abre o mesmo seletor do Escolher arquivos e a lista
 * diz quais arquivos escolher. Ao escolher, os que batem (nome, tamanho, data) continuam de onde pararam.
 */
const RESUME_NAMES = 4
function ResumeNotice({ items, n, canPick }) {
  const names = items.filter((it) => it.status === 'needsFile').map((it) => it.name)
  const shown = names.slice(0, names.length > RESUME_NAMES ? RESUME_NAMES - 1 : RESUME_NAMES)
  return html`<div class="notice notice-soft resume">
    <${Icon} name="refresh" size=${20} />
    <div>
      <b>${n === 1 ? 'Um envio ficou pela metade' : `${n} envios ficaram pela metade`}</b>
      <p>Escolha ${n === 1 ? 'o mesmo arquivo' : 'os mesmos arquivos'} de novo: continua de onde parou.</p>
      <ul class="resume-names" aria-label="Arquivos para escolher de novo">
        ${shown.map((name, i) => html`<li key=${i}><${FileName} name=${name} class="resume-name" /></li>`)}
        ${names.length > shown.length ? html`<li class="resume-more">e mais ${names.length - shown.length}</li>` : null}
      </ul>
      ${canPick
        ? html`<label for="file-input" class="btn btn-secondary btn-sm resume-btn"><${Icon} name="upload" size=${15} /><span>Escolher de novo</span></label>`
        : null}
    </div>
  </div>`
}

function Empty() {
  return html`<div class="empty">
    <div class="empty-art" aria-hidden="true"><span class="hero-bar hero-up"></span><span class="hero-bar hero-down"></span></div>
    <b>Nada subindo agora</b>
    <p>Os arquivos vão direto do celular para o seu Drive. Se a conexão cair, o envio continua de onde parou.</p>
  </div>`
}

function LanNotices({ lan, sum }) {
  if (!lan) return null
  if (lan.error) {
    return html`<div class="notice" role="alert">
      <${Icon} name="wifi" size=${20} />
      <div>
        <b>${lan.badCode ? 'O código de acesso mudou' : 'Não consegui falar com o computador'}</b>
        <p>${lan.error}</p>
      </div>
    </div>`
  }
  if (lan.noAccount) {
    return html`<div class="notice" role="alert">
      <${Icon} name="warning" size=${20} />
      <div>
        <b>Falta uma conta do Google no computador</b>
        <p>Abra o SOBEDESCE em “${lan.mac}” e conecte a conta do Drive. Depois toque em Escolher arquivos.</p>
      </div>
    </div>`
  }
  if (sum.onMac && !sum.pending && !sum.paused) {
    return html`<div class="notice notice-soft lan-done" role="status">
      <${Icon} name="circle-check" size=${20} />
      <div>
        <b>Pode fechar esta tela</b>
        <p>${sum.onMac === 1 ? 'O arquivo já está' : 'Os arquivos já estão'} no ${LAN.label}. O SOBEDESCE de lá termina de subir pro Drive${lan.deleteAfterUpload ? ' e apaga a cópia do computador' : ''}.</p>
      </div>
    </div>`
  }
  return null
}

/** O Google pediu nova autorização para o Drive: os envios pausaram até reconectar na conta. */
function ReconnectNotice({ drive, message }) {
  return html`<div class="notice notice-reconnect" role="alert">
    <${Icon} name="warning" size=${20} />
    <div>
      <b>Reconecte o Google Drive</b>
      <p>${message || `O Google pediu uma nova autorização para ${drive?.email || 'este Drive'}.`} Os envios pausaram e continuam sozinhos quando você voltar.</p>
      <a class="btn btn-primary btn-sm" href=${ACCOUNT.manage}><span>Abrir minha conta</span></a>
    </div>
  </div>`
}

export function MainScreen() {
  const user = LAN ? useLanAccount() : useAccount()
  const { dest, issue, authError, drive, resumeAt, awake, lan } = useApp((s) => ({
    dest: s.dest,
    issue: s.auth.issue,
    authError: s.auth.error,
    drive: s.drive,
    resumeAt: s.resumeAt,
    awake: s.awake,
    lan: s.lan,
  }))
  // Reconectado na conta: continua o que pausou por isso.
  useEffect(() => {
    if (resumeAt && engine.resumeAuthPaused()) toast('Drive reconectado. Os envios continuam', { tone: 'success' })
  }, [resumeAt])
  useEngine()
  const items = engine.items
  const sum = summarize(items)
  const hasFinished = sum.finished > 0
  // Fila andando (ou pausada no meio): o topo encolhe para a fila aparecer sem rolar, até no iPhone SE.
  const compact = sum.pending + sum.paused > 0
  // Início completo (atalhos, espaço, recentes) só com a fila parada e fora do modo Wi-Fi.
  const inicio = !LAN && !compact

  const waiting = issue === 'rede'
  const reconnect = issue === 'reconectar'
  return html`<div class=${cx('screen', 'main', waiting && 'has-tap-pill')}>
    <${Header} user=${user} sum=${sum} items=${items} waiting=${waiting} awake=${awake} />
    <main class=${cx('main-body', compact && 'is-compact', inicio && 'is-inicio')}>
      ${inicio ? html`<${Saudacao} user=${user} />` : null}
      ${LAN ? null : html`<${ComputerCard} />`}
      ${!LAN && compact ? html`<${P2pAndamentoCompacto} />` : null}
      ${compact
        ? html`<div class="sendbar">
            <${Destination} dest=${dest} compact />
            <${Picker} dest=${lan?.noAccount || reconnect ? null : dest} account=${user?.emailAddress} compact />
          </div>`
        : html`<div class="ini-entra" style="--i:1"><${Destination} dest=${dest} /></div>`}
      ${reconnect ? html`<${ReconnectNotice} drive=${drive} message=${authError} />` : null}
      ${compact ? null : html`<div class="ini-entra" style="--i:2"><${Picker} dest=${lan?.noAccount || reconnect ? null : dest} account=${user?.emailAddress} /></div>`}
      ${inicio ? html`<${Atalhos} /><${P2pAndamentoCompacto} /><${Espaco} /><${Recentes} user=${user} dest=${dest} />` : null}
      ${LAN ? html`<${LanNotices} lan=${lan} sum=${sum} />` : null}

      ${engine.notice
        ? html`<div class="notice" role="alert">
            <${Icon} name="clock" size=${20} />
            <div>
              <b>Limite diário do Google</b>
              <p>${engine.notice.text}</p>
              <${Button} size="sm" variant="secondary" icon="play" onClick=${() => engine.resumeAll()}>Retomar mesmo assim</${Button}>
            </div>
          </div>`
        : null}

      ${sum.waitingFile ? html`<${ResumeNotice} items=${items} n=${sum.waitingFile} canPick=${Boolean(dest) && !lan?.noAccount && !reconnect} />` : null}

      ${compact ? null : html`<${BatchCards} items=${items} />`}

      ${items.length
        ? html`<section class="queue" aria-label="Envios">
            <div class="section-head">
              <h2>Envios</h2>
              <span class="section-count">${plural(items.length, 'arquivo', 'arquivos')}</span>
              ${hasFinished ? html`<button type="button" class="link-btn" onClick=${() => engine.clearFinished()}>Limpar concluídos</button>` : null}
            </div>
            <ul class="group rows">
              ${items.map((it) => html`<${QueueRow} key=${it.id} it=${it} waiting=${waiting} />`)}
            </ul>
          </section>`
        : LAN
          ? html`<${Empty} />`
          : null}

      <p class="foot">
        ${LAN
          ? html`<${Icon} name="wifi" size=${13} /> Pelo Wi-Fi até “${lan?.mac || LAN.mac}”, que sobe pro seu Drive.`
          : 'Direto do celular para o Google — nada passa por servidor nosso.'}
      </p>
    </main>

    ${waiting
      ? html`<div class="tap-pill" role="status">
          <span class="tap-pill-dot" aria-hidden="true"></span>
          <span>Sem resposta da conta. Tentando de novo</span>
        </div>`
      : null}
    ${sum.pending ? null : html`<${InstallHint} />`}
  </div>`
}
