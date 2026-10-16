// Tela principal: destino no topo, o botão grande de escolher arquivos e a fila.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js'
import * as auth from '../lib/auth.js'
import { DEV, LAN } from '../lib/config.js'
import { about } from '../lib/drive.js'
import { lanInfo } from '../lib/lan.js'
import { bytes, initials, plural, speed, timecode } from '../lib/format.js'
import { MY_DRIVE, folderTrail, getRecents, getState, openSheet, pushRecent, setState, toast, useApp } from '../lib/state.js'
import { engine, summarize } from '../lib/uploader.js'
import { Icon, Wordmark } from './icons.js'
import { Button, cx, useEngine } from './ui.js'
import { QueueRow, SequenceBar } from './queue.js'
import { InstallHint } from './install-hint.js'
import { isIOS } from '../lib/platform.js'

export function Avatar({ user, size = 32 }) {
  const [broken, setBroken] = useState(false)
  const photo = !DEV && !broken ? user?.photoLink : null
  return html`<span class="avatar" style=${`width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px`}>
    ${photo
      ? html`<img src=${photo} alt="" width=${size} height=${size} referrerpolicy="no-referrer" onError=${() => setBroken(true)} />`
      : initials(user?.displayName, user?.emailAddress)}
  </span>`
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

function useAccount() {
  const user = useApp((s) => s.user)
  useEffect(() => {
    if (user || LAN) return
    const ctl = new AbortController()
    about(ctl.signal).then(
      (r) => {
        const u = r.user || {}
        setState({ user: u, quota: r.storageQuota || null })
        auth.rememberUser(u.emailAddress)
        engine.setAccount(u.emailAddress)
        if (!getState().dest) setState({ dest: getRecents(u.emailAddress)[0] || MY_DRIVE })
        engine.restore()
      },
      (err) => {
        if (ctl.signal.aborted || err?.signedOut) return
        if (err?.status === 401 || err?.status === 403) {
          auth.signOut()
          setState({ auth: { status: 'signedOut', needsTap: false, error: 'O Google não liberou o acesso ao Drive. Entre de novo.' } })
        } else {
          toast('Não consegui falar com o Google. Confira a internet.', { tone: 'error', ms: 4000 })
          setState({ dest: getState().dest || MY_DRIVE })
        }
      },
    )
    return () => ctl.abort()
  }, [user])
  return user
}

function Header({ user, sum, items, needsTap }) {
  const active = sum.pending + sum.paused > 0
  const allPaused = sum.pending === 0 && sum.paused > 0
  const label = allPaused ? 'Pausado' : sum.speed > 0 ? speed(sum.speed) : needsTap ? 'Esperando você' : 'Preparando…'
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
        </div>`
      : null}
  </header>`
}

function Destination({ dest }) {
  if (!dest) {
    return html`<div class="dest is-loading" aria-busy="true"><span class="skeleton skeleton-line"></span></div>`
  }
  const trail = folderTrail(dest, { skipLast: true })
  const isShared = Boolean(dest.driveId)
  return html`<button type="button" class="dest" onClick=${() => openSheet('folders')} aria-label=${`Destino: ${folderTrail(dest)}. Trocar pasta`}>
    <span class="dest-eyebrow">Enviar para</span>
    <span class="dest-row">
      <span class="dest-icon" aria-hidden="true"><${Icon} name=${dest.id === 'root' ? 'disk' : isShared && dest.path?.length === 1 ? 'shared-drive' : 'folder'} size=${22} /></span>
      <span class="dest-text">
        <span class="dest-name">${dest.name}</span>
        ${trail ? html`<span class="dest-trail">${trail}</span>` : html`<span class="dest-trail">${isShared ? 'Drive compartilhado' : 'Pasta principal do seu Drive'}</span>`}
      </span>
      <span class="dest-change">Trocar <${Icon} name="chevron-right" size=${14} strokeWidth=${2} /></span>
    </span>
  </button>`
}

function Picker({ dest, account }) {
  const input = useRef(null)
  const onChange = (e) => {
    const files = [...(e.currentTarget.files || [])]
    e.currentTarget.value = ''
    if (!files.length || !dest) return
    const r = engine.addFiles(files, dest)
    pushRecent(dest, account)
    if (r.resumed) toast(r.resumed === 1 ? 'Continuando de onde parou' : `${r.resumed} envios continuando de onde pararam`, { tone: 'success' })
    if (r.dupes) toast(r.dupes === 1 ? 'Esse arquivo já está na fila' : `${r.dupes} arquivos já estavam na fila`)
  }
  return html`<div class="picker">
    <input ref=${input} id="file-input" class="offscreen" type="file" multiple onChange=${onChange} disabled=${!dest} />
    <label for="file-input" class=${cx('pick', !dest && 'is-disabled')}>
      <span class="pick-icon" aria-hidden="true"><${Icon} name="upload" size=${24} strokeWidth=${1.8} /></span>
      <span class="pick-text">
        <b>Escolher arquivos</b>
        <span>Vídeos, fotos, qualquer tamanho</span>
      </span>
    </label>
    ${isIOS
      ? html`<p class="tip"><${Icon} name="info" size=${15} /> <span>Para vídeos no tamanho original, escolha pelo app <b>Arquivos</b>; pela Fototeca o iPhone às vezes converte.</span></p>`
      : null}
  </div>`
}

function AwakeNote({ awake }) {
  return html`<div class="awake" role="status">
    <span class="awake-dot" aria-hidden="true"></span>
    <div>
      <b>Mantenha esta tela aberta enquanto sobe</b>
      <span>${awake ? 'A tela fica acesa sozinha até terminar.' : 'Se bloquear, o envio pausa e continua quando você voltar.'}</span>
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

export function MainScreen() {
  const user = LAN ? useLanAccount() : useAccount()
  // Com o login restaurado da aba, o GIS ainda não carregou: carrega já, para o toque na pílula
  // "continuar conectado" poder abrir o popup na hora (sem await dentro do toque).
  useEffect(() => {
    if (!DEV && !LAN) auth.prepare(getState().clientId).catch(() => {})
  }, [])
  const { dest, needsTap, awake, lan } = useApp((s) => ({ dest: s.dest, needsTap: s.auth.needsTap, awake: s.awake, lan: s.lan }))
  useEngine()
  const items = engine.items
  const sum = summarize(items)
  const hasFinished = sum.finished > 0
  const running = sum.running > 0

  return html`<div class=${cx('screen', 'main', needsTap && 'has-tap-pill')}>
    <${Header} user=${user} sum=${sum} items=${items} needsTap=${needsTap} />
    <main class="main-body">
      <${Destination} dest=${dest} />
      <${Picker} dest=${lan?.noAccount ? null : dest} account=${user?.emailAddress} />
      ${running ? html`<${AwakeNote} awake=${awake} />` : null}
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

      ${sum.waitingFile
        ? html`<div class="notice notice-soft">
            <${Icon} name="refresh" size=${20} />
            <div>
              <b>${sum.waitingFile === 1 ? 'Um envio ficou pela metade' : `${sum.waitingFile} envios ficaram pela metade`}</b>
              <p>Escolha ${sum.waitingFile === 1 ? 'o mesmo arquivo' : 'os mesmos arquivos'} de novo: continua de onde parou.</p>
            </div>
          </div>`
        : null}

      ${items.length
        ? html`<section class="queue" aria-label="Envios">
            <div class="section-head">
              <h2>Envios</h2>
              <span class="section-count">${plural(items.length, 'arquivo', 'arquivos')}</span>
              ${hasFinished ? html`<button type="button" class="link-btn" onClick=${() => engine.clearFinished()}>Limpar concluídos</button>` : null}
            </div>
            <ul class="group rows">
              ${items.map((it) => html`<${QueueRow} key=${it.id} it=${it} waitingTap=${needsTap} />`)}
            </ul>
          </section>`
        : html`<${Empty} />`}

      <p class="foot">
        ${LAN
          ? html`<${Icon} name="wifi" size=${13} /> Pelo Wi-Fi até “${lan?.mac || LAN.mac}”, que sobe pro seu Drive.`
          : 'Direto do celular para o Google — nada passa por servidor nosso.'}
      </p>
    </main>

    ${needsTap
      ? html`<button type="button" class="tap-pill" onClick=${() => auth.tapRefresh()}>
          <span class="tap-pill-dot" aria-hidden="true"></span>
          <span>Toque para continuar conectado</span>
        </button>`
      : null}
    <${InstallHint} />
  </div>`
}
