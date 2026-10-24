// SOBEDESCE — interface. Preact + htm sem build.
import { html, render, useEffect, useRef } from '/vendor/preact-htm.js'
import { start, useStore } from './lib/store.js'
import { startDesktopIntegration } from './lib/desktop.js'
import { startCloudWatch } from './lib/cloud.js'
import { navigate, useRoute } from './lib/router.js'
import { Wordmark } from './components/icons.js'
import { Button, Spinner } from './components/common.js'
import { Sidebar } from './components/sidebar.js'
import { TransfersScreen } from './components/transfers.js'
import { PainelScreen } from './components/painel.js'
import { DriveScreen } from './components/drive.js'
import { ReferenciasScreen } from './components/referencias.js'
import { FramesScreen } from './components/frames.js'
import { CompareScreen } from './components/compare.js'
import { ComputadoresScreen } from './components/computadores.js'
import { CartoesScreen } from './components/cartoes.js'
import { SettingsScreen } from './components/settings.js'
import { SetupScreen } from './components/setup.js'
import { ModalHost } from './components/modal.js'
import { Toasts } from './components/toasts.js'
import { OAuthWaitDialog } from './components/oauth-wait.js'
import { abertura } from './lib/abertura.js'

const TITLES = { painel: 'Início', transferencias: 'Transferências', drive: 'Drive', referencias: 'Referências', frames: 'Frames', comparar: 'Comparar', computadores: 'Dispositivos', cartoes: 'Cartões', ajustes: 'Ajustes', inicio: 'Primeiros passos' }

function Splash({ error }) {
  return html`<div class="splash">
    <${Wordmark} size=${28} />
    ${error
      ? html`<div class="splash-msg">
          <b>Não consegui falar com o motor do SOBEDESCE.</b>
          <span class="sub">${error} Tentando de novo sozinho…</span>
          <${Button} size="sm" onClick=${() => location.reload()}>Recarregar</${Button}>
        </div>`
      : html`<${Spinner} size=${18} />`}
  </div>`
}

function Shell({ route }) {
  let screen
  switch (route.name) {
    case 'drive':
      screen = html`<${DriveScreen} route=${route} />`
      break
    case 'referencias':
      screen = html`<${ReferenciasScreen} route=${route} />`
      break
    case 'frames':
      screen = html`<${FramesScreen} route=${route} />`
      break
    case 'comparar':
      screen = html`<${CompareScreen} />`
      break
    case 'computadores':
      screen = html`<${ComputadoresScreen} />`
      break
    case 'cartoes':
      screen = html`<${CartoesScreen} />`
      break
    case 'ajustes':
      screen = html`<${SettingsScreen} route=${route} />`
      break
    case 'transferencias':
      screen = html`<${TransfersScreen} />`
      break
    default:
      screen = html`<${PainelScreen} />`
  }
  // A tela nova entra com um movimento curto (a chave muda com a tela, não com a subpasta do Drive).
  return html`<div class="shell">
    <${Sidebar} current=${route.name} />
    <main class="main" id="main"><div class="tela-entra" key=${route.name}>${screen}</div></main>
  </div>`
}

function App() {
  const status = useStore((s) => s.status)
  const loadError = useStore((s) => s.loadError)
  const accounts = useStore((s) => s.accounts)
  const oauthWait = useStore((s) => s.oauthWait)
  const justSignedIn = useStore((s) => s.cloud?.login?.estado === 'pronto')
  const route = useRoute()
  // O "pronto" do login some sozinho depois de um minuto (motor): quem ainda está lendo a tela de boas-vindas
  // não é jogado para Transferências por isso; sai pelo botão Começar.
  const keepWelcome = useRef(false)
  if (justSignedIn && route.name === 'inicio') keepWelcome.current = true
  else if (route.name !== 'inicio') keepWelcome.current = false
  // Sem nenhum Drive (da conta SOBEDESCE ou só deste computador): Primeiros passos.
  const needsSetup = status === 'ready' && accounts.length === 0
  const inSetup = needsSetup || route.name === 'inicio'

  useEffect(() => {
    if (status !== 'ready') return
    // Já tem Drive e alguém abriu #/inicio sem querer trocar a chave nem conectar um Drive local → Transferências.
    // Logo depois de entrar na conta, a tela fica para mostrar o "Pronto" (o botão Começar segue).
    const sub = route.parts[1]
    if (!needsSetup && route.name === 'inicio' && sub !== 'chave' && sub !== 'local' && !justSignedIn && !keepWelcome.current) navigate('painel', { replace: true })
    if (needsSetup && route.name !== 'inicio') navigate('inicio', { replace: true })
  }, [status, needsSetup, route.name, route.parts[1], justSignedIn])

  useEffect(() => {
    document.title = `${TITLES[inSetup ? 'inicio' : route.name] || 'Início'} — SOBEDESCE`
  }, [route.name, inSetup])

  // Rotas são por hash e a página inteira rola: sem isso, a tela nova abre na altura em que a anterior estava
  // (ex.: sair dos Ajustes lá embaixo e cair no meio da lista de Transferências).
  const routeKey = route.parts.join('/') || route.name
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [routeKey])

  if (status !== 'ready') return html`<div class="titlebar" aria-hidden="true"></div><${Splash} error=${status === 'error' ? loadError : null} /><${Toasts} />`

  return html`
    <div class="titlebar" aria-hidden="true"></div>
    ${inSetup ? html`<${SetupScreen} route=${route} />` : html`<${Shell} route=${route} />`}
    <${ModalHost} />
    ${oauthWait && !inSetup ? html`<${OAuthWaitDialog} />` : null}
    <${Toasts} />
  `
}

// A abertura com o símbolo (uma vez por abertura do app; lib/abertura.js) fica por cima enquanto a tela carrega.
abertura({ tamanho: 84 })
render(html`<${App} />`, document.getElementById('app'))
startDesktopIntegration()
startCloudWatch()
start()
