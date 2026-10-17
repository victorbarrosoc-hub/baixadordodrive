// Roda o motor dentro de um "utility process" do Electron (processo Node separado da janela).
// Assim um pico de trabalho do motor nunca trava a interface, e um travamento do motor não derruba a janela.
import { startApp } from '../src/index.js'
import { guardaPorMensagens } from '../src/util/segredos.js'

const parent = process.parentPort

// Cofre do sistema (safeStorage do Electron, só no processo principal): tokens e sessão cifrados (src/util/segredos.js).
const guarda = guardaPorMensagens(msg => parent.postMessage(msg))
const smoke = process.env.SOBEDESCE_SMOKE === '1'

let app = null
let stopping = false

async function stop() {
  if (stopping) return
  stopping = true
  try {
    await app?.shutdown()
  } catch {
    // saída limpa mesmo se a gravação final falhar: a fila tem gravação atômica
  }
  process.exit(0)
}

// Referências: cookies do navegador de referências (sessão do Electron, no processo principal) para o yt-dlp.
let pedidoSeq = 0
const pedidos = new Map()
function pedirCookies(dominios) {
  return new Promise(resolve => {
    const id = ++pedidoSeq
    const timer = setTimeout(() => {
      pedidos.delete(id)
      resolve([])
    }, 5000)
    pedidos.set(id, cookies => {
      clearTimeout(timer)
      pedidos.delete(id)
      resolve(Array.isArray(cookies) ? cookies : [])
    })
    parent.postMessage({ type: 'cookies-pedido', id, dominios })
  })
}

parent.on('message', event => {
  if (event.data?.type === 'shutdown') stop()
  else if (event.data?.type === 'cookies-resposta') pedidos.get(event.data.id)?.(event.data.cookies)
  else if (event.data?.type === 'cofre-resposta') guarda.receber(event.data)
  else if (event.data?.type === 'smoke' && smoke) rodarSmoke(event.data)
})

/** `SOBEDESCE --smoke` (desktop/smoke.js): confere o motor de dentro do app empacotado e devolve o resultado. */
async function rodarSmoke({ exigirBinarios = false, exigirCofre = false } = {}) {
  let checks
  try {
    const { verificar } = await import('./smoke.js')
    checks = await verificar({ app, guarda, exigirBinarios, exigirCofre })
  } catch (err) {
    checks = [{ nome: 'smoke', ok: false, detalhe: err?.stack || String(err) }]
  }
  parent.postMessage({ type: 'smoke-resultado', checks })
}

try {
  // Sem o aviso de terminal ("aperte Ctrl+C"): aqui a saída vai só para o motor.log.
  // "Atualizar" (src/updater.js): só no app empacotado, que passa o caminho e o PID do processo principal.
  // A troca é entregue ao processo principal, que roda o script solto e fecha o app.
  const appExe = process.env.SOBEDESCE_APP_EXE || ''
  const appPid = Number(process.env.SOBEDESCE_APP_PID) || 0
  const updaterOptions = appExe && appPid ? { appExe, appPid, handoff: ({ script }) => parent.postMessage({ type: 'update-handoff', script }) } : {}
  app = await startApp({ open: false, desktop: true, quiet: true, segredos: guarda, updaterOptions })
  app.referencias?.setCookieProvider(pedirCookies)
  console.log(`[motor] pronto em ${app.url} · dados em ${app.paths.root}`)
  parent.postMessage({ type: 'ready', url: app.url, port: app.port })
} catch (err) {
  parent.postMessage({ type: 'fatal', code: err.code || null, url: err.url || null, message: err.message })
  process.exit(1)
}
