// Processo principal do app de desktop: sobe o motor, abre a janela e cuida do que é nativo
// (seletor de pastas, Dock/barra de tarefas, notificações, sair sem perder transferências).
import { app, BrowserWindow, Menu, Notification, dialog, ipcMain, nativeTheme, powerSaveBlocker, safeStorage, session, shell, utilityProcess } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { allowPermission, trustedSender } from './security.js'
import { responderCofre } from './cofre.js'
import { AVISO_COOKIES, marcarAvisado, migrarCookies, precisaAvisar } from './cookies-cifrados.js'
import { abrirNavegador, cookiesPara, fecharNavegador, registrarCanais } from './navegador.js'
import { handoffCommand, isHandoffScript } from '../src/updater.js'
import { ligarZoom } from './zoom.js'

const here = import.meta.dirname
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

app.setName('SOBEDESCE')
if (isWin) app.setAppUserModelId('app.sobedesce.desktop')
// Celular pelo Wi-Fi (docs/CELULAR-WIFI.md): o WebRTC da janela oculta anuncia o IP local de verdade, não um nome
// .local (mDNS). O Safari do celular manda as checagens para esse IP e a conexão sai mesmo em rede sem multicast.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns')

let engine = null // utilityProcess do motor
let engineUrl = null
let win = null
let celularWin = null // janela oculta do WebRTC com o celular (public/celular/p2p.html)
let zoom = null // zoom automático pela largura da janela + o escolhido no menu (desktop/zoom.js)
let quitting = false
let quitConfirmed = false // a pessoa já disse "Sair" com transferências andando (não pergunta duas vezes)
let activeCount = 0
let sleepBlocker = null

// `SOBEDESCE --smoke` (CI, desktop/smoke.js): sobe o motor numa pasta temporária, confere tudo, escreve "SMOKE OK" e
// sai com 0 (ou 1). Não abre janela, não usa os dados nem os cookies da pessoa e não disputa a trava de instância.
const SMOKE = process.argv.includes('--smoke')
let smokeHome = null
if (SMOKE) {
  smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sobedesce-smoke-'))
  app.setPath('userData', path.join(smokeHome, 'electron'))
  app.setAppLogsPath(path.join(smokeHome, 'logs'))
  process.env.SOBEDESCE_HOME = path.join(smokeHome, 'dados')
  process.env.SOBEDESCE_PORT = String(41000 + Math.floor(Math.random() * 20000))
  process.env.SOBEDESCE_SMOKE = '1'
  app.whenReady().then(runSmoke)
} else if (!app.requestSingleInstanceLock()) {
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
      // SOBEDESCE_APP_EXE/PID: só no app empacotado, liga o "Atualizar" (src/updater.js troca este app e reabre).
      env: {
        ...process.env,
        SOBEDESCE_NO_OPEN: '1',
        SOBEDESCE_DESKTOP: '1',
        UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE || '16',
        SOBEDESCE_APP_EXE: app.isPackaged ? process.execPath : '',
        SOBEDESCE_APP_PID: app.isPackaged ? String(process.pid) : '',
      },
    })
    engine.stdout?.pipe(log)
    engine.stderr?.pipe(log)
    let settled = false
    engine.on('message', msg => {
      if (msg?.type === 'ready' && !settled) {
        settled = true
        resolve(msg.url)
      } else if (msg?.type === 'update-handoff') {
        runUpdateHandoff(msg.script)
      } else if (msg?.type === 'cookies-pedido') {
        // Referências: o motor precisa dos cookies do navegador de referências para o yt-dlp (só os domínios do vídeo).
        responderCookies(msg)
      } else if (msg?.type === 'cofre') {
        // Tokens e sessão (src/util/segredos.js): o safeStorage só existe neste processo.
        const child = engine
        try {
          child?.postMessage(responderCofre(safeStorage, msg))
        } catch {}
      } else if (msg?.type === 'smoke-resultado') {
        smokeResult?.(msg.checks)
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

/**
 * "Atualizar": o motor baixou e conferiu a versão nova e gravou o script da troca (src/updater.js). Este processo roda
 * o script solto (ele espera o app fechar, troca e abre de novo) e fecha o app. As transferências pausam ao sair e
 * continuam na próxima abertura (o motor só chega aqui com nenhuma andando ou com a pessoa tendo confirmado).
 */
function runUpdateHandoff(script) {
  const command = isHandoffScript(script) ? handoffCommand(process.platform, script) : null
  if (!command) return
  const failed = err => dialog.showErrorBox('Não deu para atualizar', `${err?.message || err}\n\nUse Baixar no aviso de versão nova.`)
  let child
  try {
    child = spawn(command.cmd, command.args, { detached: true, stdio: 'ignore', windowsHide: true })
  } catch (err) {
    return failed(err)
  }
  child.once('error', failed)
  // Só fecha depois que o script de fato começou (senão o app fecharia sem ninguém para abrir de novo).
  child.once('spawn', () => {
    child.unref()
    quitConfirmed = true
    app.quit()
  })
}

async function responderCookies(msg) {
  const child = engine
  let cookies = []
  try {
    cookies = await cookiesPara(msg.dominios)
  } catch {
    cookies = []
  }
  try {
    child?.postMessage({ type: 'cookies-resposta', id: msg.id, cookies })
  } catch {}
}

async function onEngineCrash(code) {
  if (SMOKE) return smokeResult?.([{ nome: 'motor', ok: false, detalhe: `o motor fechou no meio do teste (código ${code})` }])
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
    abrirJanelaCelular()
  } catch (err) {
    dialog.showErrorBox('Não deu para reiniciar o motor', err.message)
    app.quit()
  }
}

async function boot() {
  // Fusível EnableCookieEncryption: na primeira abertura com ele, os cookies antigos (texto puro) do navegador de
  // Referências são apagados antes de a sessão dele existir (desktop/cookies-cifrados.js). Só no app empacotado.
  try {
    const { apagou } = migrarCookies({ userData: app.getPath('userData'), ligado: app.isPackaged })
    if (apagou) console.log('[sobedesce] cookies antigos do navegador de referências apagados (agora cifrados)')
  } catch {}
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
  abrirJanelaCelular()
  app.on('activate', () => showWindow())
}

/**
 * Celular pelo Wi-Fi: uma janela que ninguém vê, de pé enquanto o app está aberto (no Mac, também com a janela
 * principal fechada). Ela faz o WebRTC com o celular e conversa com o motor pela API local. Se cair, volta sozinha.
 */
function abrirJanelaCelular() {
  if (SMOKE || !engineUrl || quitting) return
  const url = new URL('/celular/p2p.html', engineUrl).href
  if (celularWin && !celularWin.isDestroyed()) {
    if (celularWin.webContents.getURL() !== url) celularWin.loadURL(url)
    return
  }
  const w = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
  })
  celularWin = w
  w.webContents.on('will-navigate', event => event.preventDefault())
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('render-process-gone', () => {
    if (celularWin === w) celularWin = null
    try {
      w.destroy()
    } catch {}
    if (!quitting) setTimeout(abrirJanelaCelular, 2000)
  })
  w.on('closed', () => {
    if (celularWin === w) celularWin = null
  })
  w.loadURL(url)
}

function fecharJanelaCelular() {
  const w = celularWin
  celularWin = null
  try {
    w?.destroy()
  } catch {}
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

  zoom = ligarZoom(win, { userData: app.getPath('userData') })
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
    // A janela oculta do celular conta como janela aberta: sem isto, fechar a janela no Windows não fecharia o app.
    if (!isMac) app.quit()
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
  fecharNavegador()
  fecharJanelaCelular()
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

// Só estes endereços fixos (openExternal só abre http/https): Rede Local e Firewall nos Ajustes do Sistema.
const PAINEIS_MAC = {
  'rede-local': 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork',
  firewall: 'x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall',
}
ipcMain.handle('sobedesce:abrir-ajustes-rede', (event, qual) => {
  if (!trustedSender(event, engineUrl) || process.platform !== 'darwin') return false
  shell.openExternal(PAINEIS_MAC[qual] || PAINEIS_MAC['rede-local'])
  return true
})

ipcMain.handle('sobedesce:abrir-navegador', (event, url) => {
  if (!trustedSender(event, engineUrl) || !engineUrl) return false
  const janela = abrirNavegador({ engineUrl, url: typeof url === 'string' ? url : null, openExternal })
  avisarCookies(janela)
  return true
})

/** Uma vez, depois que os cookies antigos foram apagados: "Entre de novo no Instagram uma vez". */
function avisarCookies(janela) {
  const userData = app.getPath('userData')
  if (!precisaAvisar(userData)) return
  marcarAvisado(userData)
  dialog.showMessageBox(janela && !janela.isDestroyed?.() ? janela : undefined, { type: 'info', message: AVISO_COOKIES.titulo, detail: AVISO_COOKIES.texto, buttons: ['Entendi'] }).catch(() => {})
}

// Barra do navegador de referências (preload-navegador.cjs): a mesma regra de origem da ponte principal.
registrarCanais(ipcMain, event => trustedSender(event, engineUrl))

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
        { label: 'Tamanho real', accelerator: 'CmdOrCtrl+0', click: () => zoom?.tamanhoReal() },
        { label: 'Aumentar', accelerator: 'CmdOrCtrl+=', click: () => zoom?.aumentar() },
        { label: 'Aumentar', accelerator: 'CmdOrCtrl+Plus', click: () => zoom?.aumentar(), visible: false, acceleratorWorksWhenHidden: true },
        { label: 'Diminuir', accelerator: 'CmdOrCtrl+-', click: () => zoom?.diminuir() },
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

// ---- Teste de fumaça (--smoke) ----

let smokeResult = null

async function runSmoke() {
  // Sem console (app de janela no Windows), escrever no stdout pode dar erro: o resultado vai também para o arquivo.
  process.stdout.on?.('error', () => {})
  const linhas = []
  const escrever = texto => {
    linhas.push(texto)
    try {
      process.stdout.write(`${texto}\n`)
    } catch {}
  }
  let code = 1
  const limite = setTimeout(() => finish(2, 'SMOKE FALHOU: passou de 4 minutos'), 240_000)
  async function finish(c, extra) {
    clearTimeout(limite)
    if (extra) escrever(extra)
    quitting = true
    if (engine) {
      const child = engine
      await new Promise(resolve => {
        const t = setTimeout(() => {
          child.kill()
          resolve()
        }, 15_000)
        child.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
        child.postMessage({ type: 'shutdown' })
      })
    }
    if (c !== 0) {
      try {
        escrever(`--- motor.log ---\n${fs.readFileSync(logFile(), 'utf8').slice(-8000)}`)
      } catch {}
    }
    const saida = process.env.SOBEDESCE_SMOKE_SAIDA
    if (saida) {
      try {
        fs.writeFileSync(saida, `${linhas.join('\n')}\n`)
      } catch {}
    }
    try {
      fs.rmSync(smokeHome, { recursive: true, force: true })
    } catch {}
    app.exit(c)
  }
  try {
    escrever(`SOBEDESCE ${app.getVersion()} · Electron ${process.versions.electron} · ${process.platform}-${process.arch} · empacotado: ${app.isPackaged ? 'sim' : 'não'}`)
    engineUrl = await startEngine()
    const checks = await new Promise((resolve, reject) => {
      smokeResult = resolve
      setTimeout(() => reject(new Error('o motor não respondeu ao teste em 3 minutos')), 180_000).unref?.()
      engine.postMessage({ type: 'smoke', exigirBinarios: app.isPackaged && (isMac || isWin), exigirCofre: isWin })
    })
    const { relatorio } = await import('./smoke.js')
    const r = relatorio(checks)
    escrever(r.texto)
    code = r.ok ? 0 : 1
  } catch (err) {
    escrever(`FALHA motor: ${err?.message || err}`)
    escrever('SMOKE FALHOU')
    code = 1
  }
  await finish(code)
}
