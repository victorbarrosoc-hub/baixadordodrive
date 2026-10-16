// SOBEDESCE Celular — envia arquivos do celular direto para o Google Drive. Sem build: Preact + htm.
// A conta (e os Drives ligados a ela) vem do site da SOBEDESCE, na mesma origem; os arquivos vão direto ao Google.
import { html, render } from './vendor/preact-htm.js'
import { DEV, LAN } from './lib/config.js'
import * as auth from './lib/auth.js'
import { getState, savedTab, setState, useApp } from './lib/state.js'
import { AccountScreen, DrivesSheet } from './components/account.js'
import { MainScreen } from './components/main.js'
import { Tabs } from './components/tabs.js'
import { FolderSheet } from './components/folders.js'
import { SettingsSheet } from './components/settings.js'
import { ItemSheet } from './components/queue.js'
import { SheetHost, Toasts } from './components/ui.js'
import { engine } from './lib/uploader.js'
import { startBridge } from './lib/stream.js'

const SHEETS = { folders: FolderSheet, settings: SettingsSheet, item: ItemSheet, drives: DrivesSheet }

// Modo Wi-Fi (servido pelo SOBEDESCE do computador): sem conta aqui, quem fala com o Drive é o computador.
if (!LAN) {
  auth.boot()
  setState({ tab: savedTab() })
  startBridge() // o service worker pede o token por aqui para a prévia e o download (/app/stream/)
}

function App() {
  const status = useApp((s) => s.auth.status)
  const view = LAN ? html`<${MainScreen} />` : status === 'signedIn' ? html`<${Tabs} />` : html`<${AccountScreen} />`
  return html`${view}<${SheetHost} registry=${SHEETS} /><${Toasts} />`
}

render(html`<${App} />`, document.getElementById('app'))
document.documentElement.classList.add('is-ready')

// Service worker do app: guarda a casca (/app/) e faz a prévia e o download do Drive (/app/stream/). Também no modo
// de teste (é ele que faz o streaming). Nunca no Wi-Fi: lá a casca vem do computador, protegida pelo código, e não
// deve ficar guardada.
if ('serviceWorker' in navigator && !LAN) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('sw.js', import.meta.url), { scope: new URL('./', import.meta.url).pathname }).catch(() => {})
  })
}

// Só no modo de teste (127.0.0.1/localhost) e no Wi-Fi: leitura do estado para o teste automatizado. Nada sensível
// sai daqui — sem token e sem URI de sessão.
if (DEV || LAN) {
  window.__sobedesce = {
    getState,
    items: () =>
      engine.items.map(({ id, name, size, status, offset, error, fileId, note, drive }) => ({ id, name, size, status, offset, error, fileId, note, drive })),
  }
}
