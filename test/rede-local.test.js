// Permissão de Rede Local do macOS 15+ (src/celular/rede-local.js): sem ela, o Wi-Fi com o celular nunca conecta.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { criarRedeLocal, roteadorDe, temPermissaoDeRede, tentarConexao } from '../src/celular/rede-local.js'

/** net.connect falso: responde com o evento pedido para cada porta. */
function conexaoFalsa(porPorta) {
  const chamadas = []
  const conectar = ({ host, port }) => {
    chamadas.push(`${host}:${port}`)
    const s = new EventEmitter()
    s.destroy = () => {}
    const r = porPorta[port]
    if (r === 'connect') setImmediate(() => s.emit('connect'))
    else if (r) setImmediate(() => s.emit('error', Object.assign(new Error(r), { code: r })))
    return s
  }
  return { conectar, chamadas }
}

test('só o macOS 15 em diante (Darwin 24+) tem a permissão', () => {
  assert.equal(temPermissaoDeRede('darwin', '24.1.0'), true)
  assert.equal(temPermissaoDeRede('darwin', '25.0.0'), true)
  assert.equal(temPermissaoDeRede('darwin', '23.6.0'), false)
  assert.equal(temPermissaoDeRede('win32', '10.0.22631'), false)
  assert.equal(temPermissaoDeRede('linux', '6.8.0'), false)
})

test('roteador pelo route -n get default', () => {
  const saida = '   route to: default\ndestination: default\n       mask: default\n    gateway: 192.168.15.1\n  interface: en0\n'
  assert.equal(roteadorDe(saida), '192.168.15.1')
  assert.equal(roteadorDe('route: writing to routing socket: not in table'), null)
  assert.equal(roteadorDe('    gateway: fe80::1%en0'), null)
})

test('a tentativa: conectou ou porta recusada = ok; No route to host = bloqueada; o resto, não sabe', async () => {
  const r = (code) => tentarConexao('192.168.0.1', 53, 500, conexaoFalsa({ 53: code }).conectar)
  assert.equal(await r('connect'), 'ok')
  assert.equal(await r('ECONNREFUSED'), 'ok')
  assert.equal(await r('EHOSTUNREACH'), 'bloqueada')
  assert.equal(await r('ETIMEDOUT'), null)
  assert.equal(await tentarConexao('192.168.0.1', 53, 30, conexaoFalsa({}).conectar), null)
})

test('confere com cache; fora do Mac é sempre null e nem tenta', async () => {
  const f = conexaoFalsa({ 53: 'ETIMEDOUT', 80: 'EHOSTUNREACH' })
  let t = 1000
  const rede = criarRedeLocal({ platform: 'darwin', release: '24.0.0', roteador: async () => '10.0.0.1', conectar: f.conectar, agora: () => t })
  assert.equal(rede.estado, null)
  assert.equal(await rede.conferir(), 'bloqueada')
  assert.deepEqual(f.chamadas, ['10.0.0.1:53', '10.0.0.1:80'])
  assert.equal(await rede.conferir(), 'bloqueada')
  assert.equal(f.chamadas.length, 2, 'dentro de 1 min usa o que já sabe')
  t += 61_000
  await rede.conferir()
  assert.equal(f.chamadas.length, 4)
  await rede.conferir({ forcar: true })
  assert.equal(f.chamadas.length, 6)

  const g = conexaoFalsa({ 53: 'EHOSTUNREACH' })
  const fora = criarRedeLocal({ platform: 'linux', release: '6.8.0', roteador: async () => '10.0.0.1', conectar: g.conectar })
  assert.equal(await fora.conferir(), null)
  assert.equal(g.chamadas.length, 0)
})

test('Firewall do macOS: lê o socketfilterfw (ligado, bloquear tudo, este app) e acha a pasta .app', async () => {
  const { appDe, criarFirewall, lerFirewall } = await import('../src/celular/firewall.js')
  assert.equal(appDe('/Applications/SOBEDESCE.app/Contents/Frameworks/SOBEDESCE Helper.app/Contents/MacOS/SOBEDESCE Helper'), '/Applications/SOBEDESCE.app')
  assert.equal(appDe('/usr/bin/node'), null)
  assert.deepEqual(lerFirewall({ global: 'Firewall is disabled. (State = 0)', tudo: 'Firewall has block all state set to disabled.', app: '' }), { ligado: false, bloquearTudo: false, app: null })
  assert.deepEqual(lerFirewall({ global: 'Firewall is enabled. (State = 1)', tudo: 'Block all DISABLED!', app: 'The application /Applications/SOBEDESCE.app is permitted' }), { ligado: true, bloquearTudo: false, app: 'permitido' })
  assert.deepEqual(lerFirewall({ global: 'Firewall is enabled. (State = 1)', tudo: 'Firewall has block all state set to enabled.', app: '/Applications/SOBEDESCE.app is blocked' }), { ligado: true, bloquearTudo: true, app: 'bloqueado' })
  assert.equal(lerFirewall({ global: 'Firewall is enabled. (State = 1)', tudo: '', app: 'The application is not part of the firewall' }).app, 'fora')

  const pedidos = []
  const respostas = { '--getglobalstate': 'Firewall is enabled. (State = 1)', '--getblockall': 'Block all DISABLED!', '--getappblocked': 'The application is not part of the firewall' }
  const fw = criarFirewall({ platform: 'darwin', execPath: '/Applications/SOBEDESCE.app/Contents/MacOS/SOBEDESCE', ler: async (args) => (pedidos.push(args), respostas[args[0]]) })
  const r = await fw.conferir()
  assert.equal(r.atrapalha, true, 'ligado e o app sem "Permitir"')
  assert.deepEqual(pedidos.at(-1), ['--getappblocked', '/Applications/SOBEDESCE.app'])
  await fw.conferir()
  assert.equal(pedidos.length, 3, 'dentro de 1 min usa o que já sabe')
  respostas['--getappblocked'] = 'The application /Applications/SOBEDESCE.app is permitted'
  assert.equal((await fw.conferir({ forcar: true })).atrapalha, false)
  assert.equal(await criarFirewall({ platform: 'win32' }).conferir(), null)
})
