// "Rede Local" do macOS (15 em diante): sem essa permissão, o app não fala com nenhum aparelho da rede de casa e o
// Wi-Fi com o celular nunca conecta (o pedido chega pelo site, a conexão direta não abre). O macOS não conta para o app
// se a permissão foi negada; o jeito é tentar: uma conexão TCP ao roteador que volta na hora com "No route to host"
// (EHOSTUNREACH) é o bloqueio. A primeira tentativa também faz o macOS mostrar o pedido de permissão.
import { execFile } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'

const VALE_MS = 60_000
const CONEXAO_MS = 2_000
const PORTAS = [53, 80]

/** macOS 15 (Darwin 24) em diante: só ali existe a permissão de Rede Local para apps do Mac. */
export function temPermissaoDeRede(platform = process.platform, release = os.release()) {
  return platform === 'darwin' && Number.parseInt(String(release), 10) >= 24
}

/** O roteador (gateway padrão) pelo `route -n get default` do macOS. */
export function roteadorDe(saida) {
  const m = /^\s*gateway:\s*([0-9.]+)\s*$/m.exec(String(saida || ''))
  return m && net.isIPv4(m[1]) ? m[1] : null
}

function lerRoteador() {
  return new Promise((ok) => {
    execFile('/sbin/route', ['-n', 'get', 'default'], { timeout: 3000 }, (err, stdout) => ok(err ? null : roteadorDe(stdout)))
  })
}

/** 'ok' (conectou ou o roteador recusou a porta: a rede passa) | 'bloqueada' (EHOSTUNREACH) | null (não deu para saber). */
export function tentarConexao(host, porta, ms = CONEXAO_MS, conectar = net.connect) {
  return new Promise((ok) => {
    let feito = false
    const fim = (v) => {
      if (feito) return
      feito = true
      clearTimeout(t)
      s.destroy()
      ok(v)
    }
    const s = conectar({ host, port: porta })
    const t = setTimeout(() => fim(null), ms)
    s.once('connect', () => fim('ok'))
    s.once('error', (err) => fim(err?.code === 'ECONNREFUSED' || err?.code === 'ECONNRESET' ? 'ok' : err?.code === 'EHOSTUNREACH' ? 'bloqueada' : null))
  })
}

/**
 * Confere (com cache de 1 min) se o macOS deixa o app falar com a rede local.
 * @returns {Promise<'ok'|'bloqueada'|null>} null fora do macOS 15+ ou quando não deu para saber.
 */
export function criarRedeLocal({ platform = process.platform, release = os.release(), roteador = lerRoteador, conectar = net.connect, agora = Date.now } = {}) {
  let ultimo = null
  let em = 0
  let andando = null
  async function conferir() {
    if (!temPermissaoDeRede(platform, release)) return null
    const ip = await roteador()
    if (!ip) return null
    let r = null
    for (const porta of PORTAS) {
      r = await tentarConexao(ip, porta, CONEXAO_MS, conectar)
      if (r) break
    }
    return r
  }
  return {
    get estado() {
      return ultimo
    },
    async conferir({ forcar = false } = {}) {
      if (!forcar && em && agora() - em < VALE_MS) return ultimo
      andando ||= conferir()
        .then((r) => {
          ultimo = r
          em = agora()
          return r
        })
        .finally(() => {
          andando = null
        })
      return andando
    },
  }
}

export const MSG_REDE_BLOQUEADA = 'O Mac está bloqueando a rede local para o SOBEDESCE. No Mac: Ajustes do Sistema → Privacidade e Segurança → Rede Local → ligue o SOBEDESCE.'
