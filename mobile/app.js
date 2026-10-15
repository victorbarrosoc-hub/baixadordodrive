// SOBEDESCE Celular — envia arquivos do celular direto para o Google Drive. Sem build: Preact + htm.
import { html, render } from './vendor/preact-htm.js'
import { DEV, consumeClientIdParam } from './lib/config.js'
import * as auth from './lib/auth.js'
import { getState, setState, useApp } from './lib/state.js'
import { SetupScreen } from './components/setup.js'
import { SignInScreen } from './components/signin.js'
import { MainScreen } from './components/main.js'
import { FolderSheet } from './components/folders.js'
import { SettingsSheet } from './components/settings.js'
import { ItemSheet } from './components/queue.js'
import { SheetHost, Toasts } from './components/ui.js'
import { engine } from './lib/uploader.js'

const SHEETS = { folders: FolderSheet, settings: SettingsSheet, item: ItemSheet }

// ?client_id=… (QR code do app do computador) entra e some da barra de endereço.
const fromUrl = consumeClientIdParam()
if (fromUrl) setState({ clientId: fromUrl, screen: null })

auth.restore()

function App() {
  const { clientId, screen, status } = useApp((s) => ({ clientId: s.clientId, screen: s.screen, status: s.auth.status }))
  let view
  if (!DEV && (screen === 'setup' || !clientId)) view = html`<${SetupScreen} />`
  else if (status !== 'signedIn') view = html`<${SignInScreen} />`
  else view = html`<${MainScreen} />`
  return html`${view}<${SheetHost} registry=${SHEETS} /><${Toasts} />`
}

render(html`<${App} />`, document.getElementById('app'))
document.documentElement.classList.add('is-ready')

// Service worker do app (só a casca do app; nunca toca nas requisições do Google). Fora do modo de teste.
if ('serviceWorker' in navigator && !DEV) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  })
}

// Só no modo de teste (127.0.0.1/localhost): leitura do estado para o teste automatizado. Nada sensível sai
// daqui — sem token e sem URI de sessão.
if (DEV) {
  window.__sobedesce = {
    getState,
    items: () =>
      engine.items.map(({ id, name, size, status, offset, error, fileId, note }) => ({ id, name, size, status, offset, error, fileId, note })),
  }
}
