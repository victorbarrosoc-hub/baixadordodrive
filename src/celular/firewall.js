// Firewall do macOS (Ajustes do Sistema → Rede → Firewall): ligado, ele recusa o que chega de fora para um app que não
// está na lista como "Permitir". O celular manda as checagens do WebRTC para o IP do Mac e, recusadas, a conexão
// nunca abre (o pedido chega pelo site; a ligação direta, não). O socketfilterfw diz o estado sem precisar de senha.
import { execFile } from 'node:child_process'

const FW = '/usr/libexec/ApplicationFirewall/socketfilterfw'
const VALE_MS = 60_000

/** A pasta .app do aplicativo a partir do executável (o motor roda dentro de um "Helper" no meio do pacote). */
export function appDe(execPath) {
  const m = /^(.*?\.app)(\/|$)/.exec(String(execPath || ''))
  return m ? m[1] : null
}

/** Lê a saída do socketfilterfw: ligado, "bloquear todas as conexões" e o que vale para este app. */
export function lerFirewall({ global, tudo, app }) {
  const ligado = /enabled|State = [12]/i.test(String(global || '')) && !/disabled|State = 0/i.test(String(global || ''))
  const bloquearTudo = /enabled|State = 1/i.test(String(tudo || '')) && !/disabled|State = 0/i.test(String(tudo || ''))
  const t = String(app || '')
  const estadoApp = /block/i.test(t) ? 'bloqueado' : /permit|allow/i.test(t) ? 'permitido' : t ? 'fora' : null
  return { ligado, bloquearTudo, app: estadoApp }
}

const rodar = (args) =>
  new Promise((ok) => execFile(FW, args, { timeout: 4000 }, (err, stdout) => ok(err ? null : String(stdout))))

/**
 * Confere (com cache de 1 min) o Firewall do macOS para este app.
 * @returns {Promise<{ ligado: boolean, bloquearTudo: boolean, app: 'permitido'|'bloqueado'|'fora'|null }|null>}
 *   null fora do Mac ou sem resposta. `atrapalha`: ligado e este app sem "Permitir" (ou bloqueando tudo).
 */
export function criarFirewall({ platform = process.platform, execPath = process.execPath, ler = rodar, agora = Date.now } = {}) {
  let ultimo = null
  let em = 0
  return {
    get estado() {
      return ultimo
    },
    async conferir({ forcar = false } = {}) {
      if (platform !== 'darwin') return null
      if (!forcar && em && agora() - em < VALE_MS) return ultimo
      const app = appDe(execPath)
      const [global, tudo, doApp] = await Promise.all([ler(['--getglobalstate']), ler(['--getblockall']), app ? ler(['--getappblocked', app]) : null])
      ultimo = global == null ? null : { ...lerFirewall({ global, tudo, app: doApp }), caminho: app }
      if (ultimo) ultimo.atrapalha = ultimo.ligado && (ultimo.bloquearTudo || ultimo.app !== 'permitido')
      em = agora()
      return ultimo
    },
  }
}
