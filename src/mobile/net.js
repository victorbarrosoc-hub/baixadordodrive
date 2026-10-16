// Endereços do computador na rede local: nome Bonjour (.local), IPs da LAN e o nome amigável do Mac.
// Tudo melhor esforço: se algo falhar, os outros endereços continuam valendo.
import os from 'node:os'
import { execFile } from 'node:child_process'

const SCUTIL_TIMEOUT_MS = 1500

function scutil(key) {
  return new Promise(resolve => {
    try {
      execFile('scutil', ['--get', key], { timeout: SCUTIL_TIMEOUT_MS, windowsHide: true }, (err, out) => resolve(err ? null : String(out || '').trim() || null))
    } catch {
      resolve(null)
    }
  })
}

let cached = null

/** { local: 'MacBook-de-Victor.local' | null, name: 'MacBook de Victor' } — calculado uma vez por processo. */
export function hostInfo() {
  cached ??= (async () => {
    let short = null
    let name = null
    if (process.platform === 'darwin') {
      // LocalHostName é o nome que o Bonjour anuncia (o iPhone acha "<nome>.local"); ComputerName é o amigável.
      ;[short, name] = await Promise.all([scutil('LocalHostName'), scutil('ComputerName')])
    }
    const host = os.hostname() || ''
    short ||= host.replace(/\.local\.?$/i, '').split('.')[0]
    // Nome com espaço ou acento não vira endereço válido: aí ficam só os IPs.
    const local = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(short || '') ? `${short}.local` : null
    return { local, name: name || host.replace(/\.local\.?$/i, '') || 'este computador' }
  })()
  return cached
}

function isPrivate(ip) {
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** IPv4 da rede local (privados primeiro; Wi-Fi/Ethernet antes de VPN e máquinas virtuais). */
export function lanAddresses(ifaces = os.networkInterfaces()) {
  const out = []
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const a of list || []) {
      const v4 = a.family === 'IPv4' || a.family === 4
      if (!v4 || a.internal || a.address.startsWith('169.254.')) continue
      // utun/ppp/ipsec = VPN; bridge/vmnet/docker/veth = máquinas virtuais: o celular não chega por aí.
      const virtual = /^(utun|ppp|ipsec|tun|tap|bridge|vmnet|vboxnet|docker|veth|br-|awdl|llw)/i.test(name)
      out.push({ ip: a.address, rank: (isPrivate(a.address) ? 0 : 2) + (virtual ? 1 : 0) + (/^(en0|wlan0|wl|eth0|Wi-Fi)/i.test(name) ? 0 : 0.5) })
    }
  }
  out.sort((x, y) => x.rank - y.rank)
  return [...new Set(out.map(x => x.ip))]
}
