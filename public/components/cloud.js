// Conta SOBEDESCE: entrar com código (o computador é liberado no navegador), Drives da conta, sair.
// Usado nos Primeiros passos (tela de boas-vindas) e em Ajustes → Conta SOBEDESCE.
import { html, useEffect, useState } from '/vendor/preact-htm.js'
import { useStore } from '../lib/store.js'
import { cloudCancel, cloudLogin, cloudLogout, cloudRefresh, contaUrl, criarContaUrl, openLoginPage } from '../lib/cloud.js'
import { openExternal } from '../lib/desktop.js'
import { confirmDialog } from '../lib/modals.js'
import { cx } from '../lib/ui.js'
import { Icon } from './icons.js'
import { Avatar, Button, LinkButton, Pill, Spinner } from './common.js'

function useNow(active, ms = 1000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return undefined
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [active, ms])
  return now
}

function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** O código grande (ABCD-EFGH), "Abrir no navegador" e a espera. */
export function CloudCode({ login, compact }) {
  const now = useNow(true)
  const left = login.expiraEm ? login.expiraEm - now : null
  const [a, b] = String(login.codigo || '').split('-')
  return html`<div class=${cx('cloud-code-box', compact && 'is-compact')} role="status" aria-live="polite">
    <span class="eyebrow">Seu código</span>
    <div class="cloud-code" aria-label=${`Código ${login.codigo}`}>
      <span>${a}</span><span class="cloud-code-dash" aria-hidden="true">–</span><span>${b}</span>
    </div>
    <p class="cloud-code-hint">Confira se o navegador mostra este mesmo código e libere o computador.</p>
    <div class="cloud-code-actions">
      <${Button} variant="primary" icon="external" onClick=${openLoginPage}>Abrir no navegador</${Button}>
      <${Button} variant="ghost" onClick=${cloudCancel}>Cancelar</${Button}>
    </div>
    <div class="cloud-wait">
      <${Spinner} size=${13} />
      <span>Esperando a liberação${left != null && left > 0 ? html` · vence em <span class="tnum">${mmss(left)}</span>` : null}</span>
    </div>
  </div>`
}

/** Código vencido ou erro: explica e oferece outro. */
function CloudRetry({ login, onRetry, busy }) {
  return html`<div class="cloud-code-box is-compact">
    <p class="cloud-problem"><${Icon} name="warning" size=${15} /> ${login.mensagem || 'O login não terminou.'}</p>
    <div class="cloud-code-actions">
      <${Button} variant="primary" loading=${busy} onClick=${onRetry}>Pedir outro código</${Button}>
      <${Button} variant="ghost" onClick=${cloudCancel}>Agora não</${Button}>
    </div>
  </div>`
}

/** Botão de entrar e, depois de clicado, o código. `hero` = versão grande dos Primeiros passos. */
export function CloudSignIn({ hero }) {
  const cloud = useStore((s) => s.cloud)
  const [busy, setBusy] = useState(false)
  const login = cloud?.login || { estado: 'nenhum' }
  const start = async () => {
    setBusy(true)
    try {
      await cloudLogin()
    } finally {
      setBusy(false)
    }
  }
  if (login.estado === 'pendente') return html`<${CloudCode} login=${login} compact=${!hero} />`
  if (login.estado === 'expirado' || login.estado === 'erro') return html`<${CloudRetry} login=${login} onRetry=${start} busy=${busy} />`
  return html`<div class=${cx('cloud-signin', hero && 'is-hero')}>
    ${cloud?.aviso ? html`<p class="cloud-problem"><${Icon} name="warning" size=${15} /> ${cloud.aviso}</p>` : null}
    <${Button} variant="primary" size=${hero ? 'xl' : 'sm'} icon=${hero ? 'user' : null} loading=${busy} onClick=${start}>Entrar com a conta SOBEDESCE</${Button}>
    ${hero
      ? html`<p class="cloud-signup">Ainda não tem conta? <button type="button" class="link" onClick=${() => openExternal(criarContaUrl())}>Criar no site</button></p>`
      : null}
  </div>`
}

/** "Pronto. Seus Drives apareceram aqui." */
export function CloudReady() {
  return html`<div class="cloud-ready" role="status">
    <span class="cloud-ready-mark"><${Icon} name="check" size=${14} strokeWidth=${2.4} /></span>
    <span>Pronto. Seus Drives apareceram aqui.</span>
  </div>`
}

/** Estado de um Drive da conta: pronto ou "reconectar" (com o caminho para o site). */
export function CloudDriveState({ account }) {
  if (account.status === 'reauth') {
    return html`<${LinkButton} size="sm" variant="primary" href=${contaUrl()} target="_blank" rel="noopener noreferrer" iconRight="external">Reconectar no site</${LinkButton}>`
  }
  return html`<${Pill} tone="success-soft" icon="check">Pronto</${Pill}>`
}

export async function confirmCloudLogout() {
  const ok = await confirmDialog({
    title: 'Sair da conta SOBEDESCE?',
    message: 'Os Drives da conta somem deste computador. O que estiver na fila com eles fica parado até você entrar de novo.',
    confirmLabel: 'Sair da conta',
    danger: true,
  })
  if (ok) await cloudLogout()
}

/** Lista dos Drives da conta (Ajustes e boas-vindas). `rows` = linhas no estilo dos Ajustes. */
export function CloudDrives({ accounts }) {
  if (!accounts.length) {
    return html`<div class="srow">
      <div class="srow-text">
        <div class="srow-label">Nenhum Drive na conta ainda</div>
        <div class="srow-desc">Conecte um Google Drive no site. Ele aparece aqui sozinho.</div>
      </div>
      <div class="srow-control">
        <${LinkButton} size="sm" href=${contaUrl()} target="_blank" rel="noopener noreferrer" iconRight="external">Conectar no site</${LinkButton}>
      </div>
    </div>`
  }
  return accounts.map(
    (a) => html`<div class=${cx('srow account-row', a.status === 'reauth' && 'is-reauth')}>
      <div class="account-id">
        <${Avatar} name=${a.name} email=${a.email} photoUrl=${a.photoUrl} size=${30} />
        <div class="srow-text">
          <div class="srow-label">${a.name || a.email}</div>
          <div class="srow-desc">${a.status === 'reauth' ? html`<span class="tone-warning">Precisa reconectar</span> · ` : null}${a.email}</div>
        </div>
      </div>
      <div class="srow-control"><${CloudDriveState} account=${a} /></div>
    </div>`,
  )
}

/** Bloco "Conta SOBEDESCE" de Ajustes: entrar, ou a conta com os Drives dela. */
export function CloudAccountRows() {
  const cloud = useStore((s) => s.cloud)
  const [busy, setBusy] = useState(false)
  if (!cloud) return null
  const login = cloud.login || { estado: 'nenhum' }

  if (!cloud.conectado) {
    if (login.estado === 'pendente' || login.estado === 'expirado' || login.estado === 'erro') {
      return html`<div class="srow is-stack cloud-srow"><${CloudSignIn} /></div>`
    }
    return html`<div class="srow">
      <div class="srow-text">
        <div class="srow-label">Entre para usar os Drives da sua conta</div>
        <div class="srow-desc">${cloud.aviso || 'Os Drives que você conectou em sobedesce.com aparecem aqui, sem chave do Google.'}</div>
      </div>
      <div class="srow-control"><${CloudSignIn} /></div>
    </div>`
  }

  const u = cloud.usuario || {}
  const refresh = async () => {
    setBusy(true)
    try {
      await cloudRefresh({ force: true })
    } finally {
      setBusy(false)
    }
  }
  return html`
    <div class="srow account-row cloud-user-row">
      <div class="account-id">
        <${Avatar} name=${u.nome} email=${u.email} size=${36} />
        <div class="srow-text">
          <div class="srow-label">${u.nome || u.email || 'Conta SOBEDESCE'}</div>
          <div class="srow-desc">${u.email || ''}</div>
        </div>
      </div>
      <div class="srow-control">
        <${Button} size="sm" variant="ghost-danger" icon="logout" onClick=${confirmCloudLogout}>Sair da conta</${Button}>
      </div>
    </div>
    ${login.estado === 'pronto' ? html`<div class="srow cloud-srow"><${CloudReady} /></div>` : null}
    <${CloudDrives} accounts=${cloud.contas || []} />
    <div class="srow">
      <div class="srow-text">
        <div class="srow-desc">
          ${cloud.erro
            ? html`<span class="tone-warning">${cloud.erro}</span> Os Drives continuam aqui; a lista se atualiza quando a conexão voltar.`
            : 'Para conectar, reconectar ou tirar um Drive, use o site. A lista se atualiza sozinha.'}
        </div>
      </div>
      <div class="srow-control">
        <${Button} size="sm" variant="ghost" icon="refresh" loading=${busy} onClick=${refresh}>Atualizar</${Button}>
        <${LinkButton} size="sm" href=${contaUrl()} target="_blank" rel="noopener noreferrer" iconRight="external">Gerenciar Drives no site</${LinkButton}>
      </div>
    </div>
  `
}
