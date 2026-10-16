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

parent.on('message', event => {
  if (event.data?.type === 'shutdown') stop()
})

try {
  // Sem o aviso de terminal ("aperte Ctrl+C"): aqui a saída vai só para o motor.log.
  app = await startApp({ open: false, desktop: true, quiet: true })
  console.log(`[motor] pronto em ${app.url} · dados em ${app.paths.root}`)
  parent.postMessage({ type: 'ready', url: app.url, port: app.port })
} catch (err) {
  parent.postMessage({ type: 'fatal', code: err.code || null, url: err.url || null, message: err.message })
  process.exit(1)
}
