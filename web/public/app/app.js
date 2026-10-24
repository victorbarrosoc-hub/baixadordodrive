// SOBEDESCE Celular — envia arquivos do celular direto para o Google Drive. Sem build: Preact + htm.
// A conta (e os Drives ligados a ela) vem do site da SOBEDESCE, na mesma origem; os arquivos vão direto ao Google.
import { html, render } from './vendor/preact-htm.js'
import { DEV, LAN } from './lib/config.js'
import * as auth from './lib/auth.js'
import { getState, openSheet, savedTab, setState, setTab, subscribe, useApp } from './lib/state.js'
import { AccountScreen, DrivesSheet } from './components/account.js'
import { MainScreen } from './components/main.js'
import { Tabs } from './components/tabs.js'
import { FolderSheet } from './components/folders.js'
import { SettingsSheet } from './components/settings.js'
import { ItemSheet } from './components/queue.js'
import { SheetHost, Toasts } from './components/ui.js'
import { engine } from './lib/uploader.js'
import { startBridge } from './lib/stream.js'
import { RefAtalhoSheet, RefDeleteSheet, RefItemSheet, RefLinkSheet, RefMenuSheet, RefNameSheet, RefSaveSheet } from './components/referencias.js'
import { findUrl } from './lib/referencias.js'
import { ComputerSheet } from './components/computador.js'
import { startPc } from './lib/computador.js'
import { MacJunkSheet } from './components/browser.js'
import { BaixarSheet, LixeiraSheet } from './components/selecao.js'
import { ItemMenuSheet } from './components/item-menu.js'
import { ProxySheet } from './components/proxies.js'
import { CopySheet } from './components/copiar.js'
import { FramesPostSheet } from './components/criar.js'
import { P2pEnvioSheet, P2pReceberSheet } from './components/p2p.js'
import { startP2p } from './lib/p2p.js'
import { parseDriveLink } from './lib/copiar.js'
import { abertura, aberturaAoVoltar } from './lib/abertura.js'

const SHEETS = {
  folders: FolderSheet,
  settings: SettingsSheet,
  item: ItemSheet,
  drives: DrivesSheet,
  refSave: RefSaveSheet,
  refName: RefNameSheet,
  refMenu: RefMenuSheet,
  refLink: RefLinkSheet,
  refDelete: RefDeleteSheet,
  refItem: RefItemSheet,
  refAtalho: RefAtalhoSheet,
  computador: ComputerSheet,
  macJunk: MacJunkSheet,
  baixarSelecao: BaixarSheet,
  lixeiraSelecao: LixeiraSheet,
  itemMenu: ItemMenuSheet,
  proxySelecao: ProxySheet,
  copiar: CopySheet,
  framesPost: FramesPostSheet,
  p2pEnvio: P2pEnvioSheet,
  p2pReceber: P2pReceberSheet,
}

// Android (share_target nos manifestos): /app/?compartilhar=1&title=&text=&url=. O navegador pode trocar a query
// inteira pelos parâmetros, então vale também só url/text. O link fica guardado na aba (sessionStorage) até a conta
// abrir — quem não estava logado entra e volta para cá — e então abre "Salvar link" na aba Referências.
const SHARE_KEY = 'sobedesce.compartilhar'
let shared = null
let wantComputer = !LAN && typeof location !== 'undefined' && location.hash === '#computador'
function takeShare() {
  if (LAN) return
  const p = new URLSearchParams(location.search)
  if (p.has('compartilhar') || p.has('url') || p.has('text')) {
    const text = [p.get('url'), p.get('text'), p.get('title')].filter(Boolean).join(' ').slice(0, 4000)
    if (findUrl(text)) shared = text
    const clean = new URL(location.href)
    for (const k of ['compartilhar', 'url', 'text', 'title']) clean.searchParams.delete(k)
    history.replaceState(null, '', clean.pathname + clean.search + clean.hash)
  }
  try {
    if (shared) sessionStorage.setItem(SHARE_KEY, shared)
    else shared = sessionStorage.getItem(SHARE_KEY)
  } catch {
    // sem sessionStorage: vale só nesta abertura
  }
}
takeShare()

function openShared(state) {
  if (!shared || state.auth.status !== 'signedIn') return
  // Link do Drive compartilhado do app do Drive: copiar para o seu Drive. O resto vai para as Referências.
  const drive = parseDriveLink(shared)
  if (!drive && !state.recursos?.referencias) return
  const texto = shared
  shared = null
  try {
    sessionStorage.removeItem(SHARE_KEY)
  } catch {
    // nada guardado
  }
  if (drive) {
    setState({ tab: 'drive' })
    return openSheet('copiar', { texto })
  }
  setState({ tab: 'refs', refsOpen: null })
  openSheet('refSave', { texto })
}

// Modo Wi-Fi (servido pelo SOBEDESCE do computador): sem conta aqui, quem fala com o Drive é o computador.
if (!LAN) {
  auth.boot()
  setState({ tab: savedTab() })
  startBridge() // o service worker pede o token por aqui para a prévia e o download (/app/stream/)
  subscribe(openShared)
  // /app/#referencias (link de Sua conta): abre a aba, se a conta tiver o recurso.
  window.addEventListener('hashchange', () => {
    if (location.hash === '#referencias') setState({ tab: 'refs' })
    if (location.hash === '#aparelhos') setState({ tab: 'ap' })
    if (location.hash === '#computador') openComputer()
  })
  // "No computador" (lib/computador.js): começa a acompanhar depois de entrar; /app/#computador (aviso do celular,
  // link de Sua conta) abre a folha.
  subscribe((st) => {
    if (st.auth.status !== 'signedIn') return
    startPc()
    startP2p() // celular ↔ computador pelo Wi-Fi (docs/CELULAR-WIFI.md)
    if (wantComputer) {
      wantComputer = false
      openComputer()
    }
  })
  // Toque na notificação com o app já aberto: o service worker pede para abrir a folha.
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'sd-computador') openComputer()
  })
}

function openComputer() {
  if (getState().auth.status !== 'signedIn') {
    wantComputer = true
    return
  }
  if (location.hash === '#computador') history.replaceState(null, '', location.pathname + location.search)
  setState({ tab: 'send' })
  openSheet('computador')
}

function App() {
  const status = useApp((s) => s.auth.status)
  const view = LAN ? html`<${MainScreen} />` : status === 'signedIn' ? html`<${Tabs} />` : html`<${AccountScreen} />`
  return html`${view}<${SheetHost} registry=${SHEETS} /><${Toasts} />`
}

// A abertura com o símbolo (Versão 1, lib/abertura.js): toda vez que o app abre e quando ele volta para a tela depois
// de um tempo em segundo plano. Só sai quando a conta respondeu: a tela de "carregando" da conta não chega a aparecer.
const contaPronta = new Promise((ok) => {
  if (getState().auth.status !== 'loading') return ok()
  const parar = subscribe(() => {
    if (getState().auth.status === 'loading') return
    parar()
    ok()
  })
})
if (!LAN) {
  abertura({ tamanho: 92, sempre: true, pronto: contaPronta })
  aberturaAoVoltar({ tamanho: 92 })
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
    // telas e folhas para as capturas automáticas (só neste modo)
    setState,
    openSheet,
    setTab,
    items: () =>
      engine.items.map(({ id, name, size, status, offset, error, fileId, note, drive, chunk, sizeOk }) => ({ id, name, size, status, offset, error, fileId, note, drive, chunk, sizeOk })),
  }
}
