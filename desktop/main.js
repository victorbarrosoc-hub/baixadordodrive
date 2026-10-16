// Processo principal do app de desktop: sobe o motor, abre a janela e cuida do que é nativo
// (seletor de pastas, Dock/barra de tarefas, notificações, sair sem perder transferências).
import { app, BrowserWindow, Menu, Notification, dialog, ipcMain, nativeTheme, powerSaveBlocker, session, shell, utilityProcess } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { allowPermission, trustedSender } from './security.js'

const here = import.meta.dirname
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

app.setName('SOBEDESCE')
if (isWin) app.setAppUserModelId('app.sobedesce.desktop')

let engine = null // utilityProcess do motor
let engineUrl = null
let win = null
let quitting = false
let quitConfirmed = false // a pessoa já disse "Sair" com transferências andando (não pergunta duas vezes)
let activeCount = 0
let sleepBlocker = null

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(boot)
}

function logFile() {
  const dir = app.getPath('logs')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'motor.log')
}

function startEngine() {
  return new Promise((resolve, reject) => {
    const log = fs.createWriteStream(logFile(), { flags: 'a' })
    log.write(`\n--- ${new Date().toISOString()} SOBEDESCE ${app.getVersion()} ---\n`)
    engine = utilityProcess.fork(path.join(here, 'engine.js'), [], {
      serviceName: 'SOBEDESCE Motor',
      stdio: 'pipe',
      // UV_THREADPOOL_SIZE: mais threads de disco para o motor (ver src/index.js).
      env: { ...process.env, SOBEDESCE_NO_OPEN: '1', SOBEDESCE_DESKTOP: '1', UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '16' },
    })
    engine.stdout?.pipe(log)
    engine.stderr?.pipe(log)
    let settled = false
    engine.on('message', msg => {
      if (msg?.type === 'ready' && !settled) {
        settled = true
        resolve(msg.url)
      } else if (msg?.type === 'fatal' && !settled) {
        settled = true
        const err = new Error(msg.message)
        err.code = msg.code
        err.url = msg.url
        reject(err)
      }
    })
    engine.on('exit', code => {
      engine = null
      if (!settled) {
        settled = true
        reject(new Error(`O motor fechou ao iniciar (código ${code}). Veja o log em ${logFile()}`))
        return
      }
      if (!quitting) onEngineCrash(code)
    })
  })
}

async function onEngineCrash(code) {
  const { response } = await dialog.showMessageBox({
    type: 'error',
    message: 'O motor de transferências parou.',
    detail: `Nada se perdeu: o progresso fica salvo. Código ${code}. Log: ${logFile()}`,
    buttons: ['Reiniciar', 'Sair'],
    defaultId: 0,
  })
  if (response === 1) return app.quit()
  try {
    engineUrl = await startEngine()
    win?.loadURL(engineUrl)
  } catch (err) {
    dialog.showErrorBox('Não deu para reiniciar o motor', err.message)
    app.quit()
  }
}

async function boot() {
  buildMenu()
  // Nenhuma permissão da web (câmera, microfone, localização…) além de copiar texto, e só para a interface do motor.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => callback(allowPermission(permission, details?.requestingUrl || wc?.getURL(), engineUrl)))
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => allowPermission(permission, requestingOrigin, engineUrl))
  try {
    engineUrl = await startEngine()
  } catch (err) {
    if (err.code === 'ALREADY_RUNNING') {
      // A versão de terminal já está aberta usando os mesmos dados: abrimos ela em vez de brigar pela fila.
      if (err.url) {
        engineUrl = err.url
      } else {
        dialog.showErrorBox('SOBEDESCE já está aberto', err.message)
        return app.quit()
      }
    } else {
      dialog.showErrorBox('Não deu para iniciar o SOBEDESCE', err.message)
      return app.quit()
    }
  }
  createWindow()
  app.on('activate', () => showWindow())
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'SOBEDESCE',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0B0B0C' : '#FBFBFD',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    autoHideMenuBar: !isMac,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  const origin = new URL(engineUrl).origin
  const isInternal = url => {
    try {
      return new URL(url).origin === origin
    } catch {
      return false
    }
  }

  // O Google bloqueia login dentro de janelas Electron: o OAuth e qualquer link externo vão para o navegador do sistema.
  win.webContents.on('will-navigate', (event, url) => {
    if (isInternal(url) && !new URL(url).pathname.startsWith('/api/auth/')) return
    event.preventDefault()
    openExternal(url)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })

  win.once('ready-to-show', () => win.show())
  win.on('close', event => {
    if (quitting || isMac) {
      // No Mac fechar a janela não fecha o app: as transferências continuam (padrão do macOS).
      return
    }
    if (activeCount > 0 && !quitConfirmed) {
      if (!confirmQuit()) return event.preventDefault()
      quitConfirmed = true
    }
  })
  win.on('closed', () => {
    win = null
  })
  win.loadURL(engineUrl)
}

function showWindow() {
  if (!engineUrl) return
  if (!win) createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function confirmQuit() {
  const choice = dialog.showMessageBoxSync(win ?? undefined, {
    type: 'question',
    message: 'Sair do SOBEDESCE?',
    detail: `${activeCount === 1 ? 'Há 1 transferência' : `Há ${activeCount} transferências`} em andamento. Elas pausam agora e continuam de onde pararam quando você abrir o app de novo.`,
    buttons: ['Sair', 'Cancelar'],
    defaultId: 1,
    cancelId: 1,
  })
  return choice === 0
}

function openExternal(url) {
  try {
    const u = new URL(url)
    if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.href)
  } catch {
    // URL inválida: ignora
  }
}

// Sair: pede ao motor para pausar e gravar tudo antes de fechar o processo.
app.on('before-quit', event => {
  if (quitting) return
  // Vale para ⌘Q no Mac e também para Arquivo → Sair no Windows/Linux (que não passa pelo X da janela).
  if (activeCount > 0 && !quitConfirmed && !confirmQuit()) {
    event.preventDefault()
    return
  }
  quitConfirmed = true
  quitting = true
  if (!engine) return
  event.preventDefault()
  const child = engine
  const timer = setTimeout(() => child.kill(), 10_000)
  child.once('exit', () => {
    clearTimeout(timer)
    app.exit(0)
  })
  child.postMessage({ type: 'shutdown' })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

// ---- Ponte com a interface (preload.cjs) ----

ipcMain.handle('sobedesce:pick-folder', async (event, opts = {}) => {
  if (!trustedSender(event, engineUrl)) return null
  const owner = BrowserWindow.fromWebContents(event.sender)
  const res = await dialog.showOpenDialog(owner, {
    title: opts.title || 'Escolher pasta',
    defaultPath: opts.defaultPath || undefined,
    buttonLabel: 'Escolher',
    properties: ['openDirectory', 'createDirectory'],
  })
  return res.canceled ? null : res.filePaths[0] || null
})

ipcMain.handle('sobedesce:pick-paths', async (event, opts = {}) => {
  if (!trustedSender(event, engineUrl)) return []
  const owner = BrowserWindow.fromWebContents(event.sender)
  // Só o Mac permite escolher arquivos e pastas no mesmo diálogo.
  const both = isMac && opts.kind !== 'files'
  const res = await dialog.showOpenDialog(owner, {
    title: opts.title || 'Escolher o que enviar',
    defaultPath: opts.defaultPath || undefined,
    buttonLabel: 'Enviar',
    properties: both ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
  })
  return res.canceled ? [] : res.filePaths
})

ipcMain.on('sobedesce:progress', (event, { fraction, activeCount: count } = {}) => {
  if (!trustedSender(event, engineUrl)) return
  activeCount = Math.max(0, Number(count) || 0)
  const owner = BrowserWindow.fromWebContents(event.sender)
  const value = typeof fraction === 'number' && Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : -1
  owner?.setProgressBar(activeCount > 0 ? value : -1)
  if (isMac) app.dock?.setBadge(activeCount > 0 ? String(activeCount) : '')
  // Sem isso o sistema pode suspender o app (e a rede) no meio de uma transferência longa.
  if (activeCount > 0 && sleepBlocker == null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension')
  if (activeCount === 0 && sleepBlocker != null) {
    powerSaveBlocker.stop(sleepBlocker)
    sleepBlocker = null
  }
})

ipcMain.on('sobedesce:notify', (event, { title, body } = {}) => {
  if (!trustedSender(event, engineUrl)) return
  if (!Notification.isSupported()) return
  const n = new Notification({ title: String(title || 'SOBEDESCE'), body: String(body || ''), silent: false })
  n.on('click', () => showWindow())
  n.show()
})

ipcMain.handle('sobedesce:open-external', (event, url) => {
  if (trustedSender(event, engineUrl)) openExternal(url)
})

ipcMain.handle('sobedesce:reveal', (event, target) => {
  if (!trustedSender(event, engineUrl)) return false
  if (typeof target !== 'string' || !path.isAbsolute(target)) return false
  if (fs.existsSync(target)) shell.showItemInFolder(target)
  else if (fs.existsSync(path.dirname(target))) shell.openPath(path.dirname(target))
  else return false
  return true
})

function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu', label: 'SOBEDESCE' }] : []),
    { role: 'fileMenu', label: 'Arquivo' },
    { role: 'editMenu', label: 'Editar' },
    {
      label: 'Visualizar',
      submenu: [
        { role: 'reload', label: 'Recarregar' },
        { role: 'toggleDevTools', label: 'Ferramentas do desenvolvedor' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Tamanho real' },
        { role: 'zoomIn', label: 'Aumentar' },
        { role: 'zoomOut', label: 'Diminuir' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Tela cheia' },
      ],
    },
    { role: 'windowMenu', label: 'Janela' },
    {
      role: 'help',
      label: 'Ajuda',
      submenu: [
        { label: 'Abrir pasta de logs', click: () => shell.openPath(app.getPath('logs')) },
        { label: 'Abrir no navegador', click: () => engineUrl && shell.openExternal(engineUrl) },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
