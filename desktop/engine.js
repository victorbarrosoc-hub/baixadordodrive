// Roda o motor dentro de um "utility process" do Electron (processo Node separado da janela).
// Assim um pico de trabalho do motor nunca trava a interface, e um travamento do motor não derruba a janela.
import { startApp } from '../src/index.js'

const parent = process.parentPort

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
})

try {
  // Sem o aviso de terminal ("aperte Ctrl+C"): aqui a saída vai só para o motor.log.
  // "Atualizar" (src/updater.js): só no app empacotado, que passa o caminho e o PID do processo principal.
  // A troca é entregue ao processo principal, que roda o script solto e fecha o app.
  const appExe = process.env.SOBEDESCE_APP_EXE || ''
  const appPid = Number(process.env.SOBEDESCE_APP_PID) || 0
  const updaterOptions = appExe && appPid ? { appExe, appPid, handoff: ({ script }) => parent.postMessage({ type: 'update-handoff', script }) } : {}
  app = await startApp({ open: false, desktop: true, quiet: true, updaterOptions })
  app.referencias?.setCookieProvider(pedirCookies)
  console.log(`[motor] pronto em ${app.url} · dados em ${app.paths.root}`)
  parent.postMessage({ type: 'ready', url: app.url, port: app.port })
} catch (err) {
  parent.postMessage({ type: 'fatal', code: err.code || null, url: err.url || null, message: err.message })
  process.exit(1)
}
