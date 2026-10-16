// "Navegador de referências": uma janela do app com um navegador de verdade dentro, para a pessoa entrar no
// Instagram/YouTube uma vez e salvar referências da página aberta.
//
// Duas WebContentsView numa BaseWindow:
//  - barra (nossa interface, ${motor}/navegador.html, sessão padrão do app, preload-navegador.cjs): endereço,
//    voltar/avançar, atalhos, "Salvar referência" e o painel à direita. Ocupa a janela toda; a página fica por cima.
//  - página (sites de terceiros): sessão 'persist:navegador', sandbox, contextIsolation, SEM preload, sem Node.
//    Não alcança o motor local (requisições para loopback são canceladas), não baixa arquivos, não ganha permissões
//    (só tela cheia), janelas novas abrem nela mesma e esquemas que não são http(s) ficam bloqueados.
import { BaseWindow, Menu, WebContentsView, clipboard, nativeTheme, session, shell } from 'electron'
import path from 'node:path'
import { NAVEGADOR_PARTICAO, bloqueadoNoNavegador, dominiosValidos, enderecoDigitado, isAppUrl, permissaoNoNavegador, podeNavegar } from './security.js'
import { detectar } from '../src/referencias/plataformas.js'

const here = import.meta.dirname
const BARRA = 56 // altura da barra (px)
const PAINEL = 380 // largura do painel "Salvar referência"
const INICIO = 'https://www.instagram.com/'

let win = null
let barra = null
let pagina = null
let painelAberto = false
let sessaoPronta = false

/** A sessão do navegador (cookies do Instagram, YouTube…) com as travas aplicadas uma vez. */
export function sessaoNavegador() {
  const ses = session.fromPartition(NAVEGADOR_PARTICAO)
  if (sessaoPronta) return ses
  sessaoPronta = true
  // Nada daqui fala com esta máquina (motor, celular, outros serviços locais).
  // Sem filtro = todas as requisições (http, https, ws, wss) de qualquer quadro, worker ou service worker da sessão.
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: bloqueadoNoNavegador(details.url) }))
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permissaoNoNavegador(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => permissaoNoNavegador(permission))
  ses.setDevicePermissionHandler?.(() => false)
  ses.setDisplayMediaRequestHandler?.((_req, callback) => callback({}))
  // Downloads só pelo nosso fluxo (Salvar referência), nunca pelo navegador.
  ses.on('will-download', event => event.preventDefault())
  // Sem "Electron/…" no agente: alguns sites tratam navegador embutido como robô.
  ses.setUserAgent(ses.getUserAgent().replace(/\s+(Electron|SOBEDESCE|sobedesce)\/\S+/gi, ''))
  return ses
}

/** Cookies dos domínios pedidos pelo motor (para o yt-dlp). Só domínios simples; nada de loopback. */
export async function cookiesPara(dominios) {
  const ses = sessaoNavegador()
  const out = []
  const vistos = new Set()
  for (const d of dominiosValidos(dominios)) {
    for (const c of await ses.cookies.get({ domain: d }).catch(() => [])) {
      const k = `${c.domain}|${c.path}|${c.name}`
      if (vistos.has(k)) continue
      vistos.add(k)
      out.push({ name: c.name, value: c.value, domain: c.domain, hostOnly: c.hostOnly, path: c.path, secure: c.secure, httpOnly: c.httpOnly, session: c.session, expirationDate: c.expirationDate })
    }
  }
  return out
}

function layout() {
  if (!win || win.isDestroyed()) return
  const { width, height } = win.getContentBounds()
  barra?.setBounds({ x: 0, y: 0, width, height })
  pagina?.setBounds({ x: 0, y: BARRA, width: Math.max(200, width - (painelAberto ? PAINEL : 0)), height: Math.max(100, height - BARRA) })
}

function estado() {
  const wc = pagina?.webContents
  if (!wc || wc.isDestroyed()) return null
  const url = wc.getURL()
  return {
    url,
    titulo: wc.getTitle(),
    podeVoltar: wc.navigationHistory.canGoBack(),
    podeAvancar: wc.navigationHistory.canGoForward(),
    carregando: wc.isLoading(),
    deteccao: detectar(url),
  }
}

function enviarEstado() {
  const s = estado()
  if (s && barra && !barra.webContents.isDestroyed()) barra.webContents.send('navegador:estado', s)
  if (s && win && !win.isDestroyed()) win.setTitle(s.titulo ? `${s.titulo} · Navegador de referências` : 'Navegador de referências')
}

function abrirPainel(dados) {
  painelAberto = true
  layout()
  barra?.webContents.send('navegador:salvar', dados)
}

function menuDeContexto(params) {
  const wc = pagina.webContents
  const itens = []
  const pageURL = params.pageURL || wc.getURL()
  if (params.mediaType === 'image' && params.srcURL && (/^https?:/i.test(params.srcURL) || /^data:image\//i.test(params.srcURL))) {
    itens.push({ label: 'Salvar imagem como referência', click: () => abrirPainel({ tipo: 'imagem', imagemUrl: params.srcURL, paginaUrl: pageURL, titulo: wc.getTitle() }) })
  }
  if (params.linkURL && detectar(params.linkURL).salvavel) {
    itens.push({ label: 'Salvar link como referência', click: () => abrirPainel({ tipo: 'video', url: params.linkURL }) })
  }
  if (!itens.length && detectar(pageURL).salvavel) itens.push({ label: 'Salvar esta página como referência', click: () => abrirPainel({ tipo: 'video', url: pageURL }) })
  if (itens.length) itens.push({ type: 'separator' })
  if (params.selectionText) itens.push({ label: 'Copiar', role: 'copy' })
  if (params.isEditable) itens.push({ label: 'Colar', role: 'paste' })
  if (params.linkURL) {
    itens.push({ label: 'Copiar endereço do link', click: () => clipboard.writeText(params.linkURL) })
    if (podeNavegar(params.linkURL)) itens.push({ label: 'Abrir link no navegador do computador', click: () => shell.openExternal(params.linkURL) })
  }
  if (params.mediaType === 'image' && /^https?:/i.test(params.srcURL || '')) itens.push({ label: 'Copiar endereço da imagem', click: () => clipboard.writeText(params.srcURL) })
  if (itens.length && itens[itens.length - 1].type !== 'separator') itens.push({ type: 'separator' })
  itens.push(
    { label: 'Voltar', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
    { label: 'Avançar', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
    { label: 'Recarregar', click: () => wc.reload() },
  )
  Menu.buildFromTemplate(itens).popup({ window: win })
}

/**
 * Abre (ou traz para frente) o navegador de referências.
 * @param {{ engineUrl: string, url?: string, openExternal: (url) => void }} o
 */
export function abrirNavegador({ engineUrl, url, openExternal }) {
  if (win && !win.isDestroyed()) {
    if (url && podeNavegar(url)) pagina.webContents.loadURL(url)
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return win
  }
  win = new BaseWindow({
    width: 1320,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Navegador de referências',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0B0B0C' : '#FBFBFD',
    autoHideMenuBar: process.platform !== 'darwin',
  })

  // Nossa barra: a mesma origem do motor, com uma ponte pequena (preload-navegador.cjs).
  barra = new WebContentsView({
    webPreferences: { preload: path.join(here, 'preload-navegador.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  })
  barra.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0B0B0C' : '#FBFBFD')
  const origem = new URL(engineUrl).origin
  barra.webContents.on('will-navigate', (event, to) => {
    if (isAppUrl(to, origem) && new URL(to).pathname === '/navegador.html') return
    event.preventDefault()
  })
  barra.webContents.setWindowOpenHandler(({ url: to }) => {
    openExternal(to)
    return { action: 'deny' }
  })

  // A página: sites de terceiros, isolados.
  const ses = sessaoNavegador()
  pagina = new WebContentsView({
    webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, safeDialogs: true, navigateOnDragDrop: false, spellcheck: true },
  })
  const wc = pagina.webContents
  wc.setWindowOpenHandler(({ url: to }) => {
    // Pop-up/nova aba: abre aqui mesmo (login do Instagram/Google costuma vir assim).
    if (podeNavegar(to)) setImmediate(() => wc.loadURL(to))
    return { action: 'deny' }
  })
  const trava = (event, to) => {
    if (!podeNavegar(to)) event.preventDefault()
  }
  wc.on('will-navigate', trava)
  wc.on('will-redirect', trava)
  wc.on('will-frame-navigate', event => {
    if (!event.isMainFrame && bloqueadoNoNavegador(event.url)) event.preventDefault()
  })
  wc.on('will-attach-webview', event => event.preventDefault())
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading', 'did-fail-load']) wc.on(ev, enviarEstado)
  wc.on('context-menu', (_e, params) => menuDeContexto(params))

  win.contentView.addChildView(barra)
  win.contentView.addChildView(pagina) // por cima da barra (a barra ocupa a janela toda; o painel fica à direita)
  win.on('resize', layout)
  win.on('closed', () => {
    // BaseWindow não fecha as páginas das views sozinha.
    for (const v of [pagina, barra]) {
      try {
        if (v && !v.webContents.isDestroyed()) v.webContents.close()
      } catch {}
    }
    win = null
    barra = null
    pagina = null
    painelAberto = false
  })
  layout()
  barra.webContents.loadURL(`${origem}/navegador.html?plataforma=${process.platform}`)
  wc.loadURL(url && podeNavegar(url) ? url : INICIO)
  return win
}

/** Canais da barra (preload-navegador.cjs). `confiavel(event)` confere a origem (trustedSender). */
export function registrarCanais(ipcMain, confiavel) {
  const ok = event => confiavel(event) && barra && event.sender === barra.webContents && pagina && !pagina.webContents.isDestroyed()
  ipcMain.handle('navegador:ir', (event, texto) => {
    if (!ok(event)) return false
    const url = enderecoDigitado(texto)
    if (!url) return false
    pagina.webContents.loadURL(url)
    return true
  })
  ipcMain.handle('navegador:acao', (event, acao) => {
    if (!ok(event)) return false
    const w = pagina.webContents
    if (acao === 'voltar' && w.navigationHistory.canGoBack()) w.navigationHistory.goBack()
    else if (acao === 'avancar' && w.navigationHistory.canGoForward()) w.navigationHistory.goForward()
    else if (acao === 'recarregar') w.reload()
    else if (acao === 'parar') w.stop()
    return true
  })
  ipcMain.handle('navegador:painel', (event, aberto) => {
    if (!ok(event)) return false
    painelAberto = Boolean(aberto)
    layout()
    return true
  })
  ipcMain.handle('navegador:estado', event => (ok(event) ? estado() : null))
  ipcMain.handle('navegador:abrir-fora', (event, to) => {
    if (ok(event) && podeNavegar(to)) shell.openExternal(to)
  })
  ipcMain.handle('navegador:sair-das-contas', async event => {
    if (!ok(event)) return false
    await sessaoNavegador().clearStorageData()
    pagina.webContents.reload()
    return true
  })
}

export function fecharNavegador() {
  if (win && !win.isDestroyed()) win.destroy()
}
