// Celular ↔ computador pelo Wi-Fi, lado do celular (web/public/app/lib/p2p-util.js): nome do aparelho, onde guardar o
// que chega (OPFS ou memória, com o limite), nomes e tipos dos arquivos, velocidade e mensagens de erro.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DICA_MAC, candidatosDaSdp, LIMITE_MEMORIA, Medidor, mensagemDe, nomeAparelho, nomeSeguro, ondeGuardar, resumoConexao, textoConexao, tipoDe } from '../web/public/app/lib/p2p-util.js'

test('nome do aparelho pelo user-agent', () => {
  assert.equal(nomeAparelho('Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Mobile/15E148 Safari/604.1'), 'iPhone')
  assert.equal(nomeAparelho('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), 'iPad')
  assert.equal(nomeAparelho('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), 'iPad')
  assert.equal(nomeAparelho('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/141.0 Mobile Safari/537.36'), 'Celular Android')
  assert.equal(nomeAparelho('Mozilla/5.0 (Linux; Android 14; SM-X710) Chrome/141.0 Safari/537.36'), 'Tablet Android')
  assert.equal(nomeAparelho(''), 'Celular')
})

test('onde guardar: OPFS quando tem; sem OPFS, memória até 1 GB; sem espaço, recusa', () => {
  assert.deepEqual(ondeGuardar({ modo: 'worker', total: 5 * LIMITE_MEMORIA }), { modo: 'worker' })
  assert.deepEqual(ondeGuardar({ modo: 'writable', total: 10 }), { modo: 'writable' })
  assert.deepEqual(ondeGuardar({ modo: null, total: LIMITE_MEMORIA }), { modo: 'memoria' })
  assert.match(ondeGuardar({ modo: null, total: LIMITE_MEMORIA + 1 }).motivo, /até 1 GB/)
  assert.match(ondeGuardar({ modo: 'worker', total: 2000, livre: 1000 }).motivo, /Falta espaço/)
  assert.deepEqual(ondeGuardar({ modo: 'worker', total: 1000, livre: 1000 }), { modo: 'worker' })
})

test('nomes de arquivo seguros e tipo pela extensão quando não vem', () => {
  assert.equal(nomeSeguro('../../etc/passwd'), 'passwd')
  assert.equal(nomeSeguro('C:\\Users\\a\\IMG_0001.HEIC'), 'IMG_0001.HEIC')
  assert.equal(nomeSeguro('a:b?c*.mov'), 'a_b_c_.mov')
  assert.equal(nomeSeguro('.oculto'), 'oculto')
  assert.equal(nomeSeguro('', 2), 'arquivo-3')
  assert.equal(tipoDe('IMG_0001.HEIC'), 'image/heic')
  assert.equal(tipoDe('A001.MOV', ''), 'video/quicktime')
  assert.equal(tipoDe('x.mov', 'video/mp4'), 'video/mp4')
  assert.equal(tipoDe('sem-extensao'), 'application/octet-stream')
})

test('velocidade pelos últimos segundos', () => {
  const m = new Medidor(3000)
  assert.equal(m.velocidade, 0)
  m.marcar(0, 0)
  m.marcar(10_000_000, 1000)
  assert.equal(m.velocidade, 10_000_000)
  m.marcar(20_000_000, 5000) // a primeira amostra sai da janela
  assert.equal(m.velocidade, 2_500_000)
})

test('mensagens de erro em português claro', () => {
  assert.match(mensagemDe({ motivo: 'rede' }), /mesmo Wi-Fi/)
  assert.match(mensagemDe({ motivo: 'caiu' }), /caiu/)
  assert.equal(mensagemDe({ motivo: 'cancelado', message: 'O computador cancelou.' }), 'O computador cancelou.')
  assert.equal(mensagemDe(new Error('Sem espaço no disco.')), 'Sem espaço no disco.')
})

test('não conectou: resumo das estatísticas do WebRTC para a linha de detalhe', () => {
  const stats = new Map([
    ['a', { type: 'local-candidate', candidateType: 'host' }],
    ['b', { type: 'local-candidate', candidateType: 'srflx' }],
    ['c', { type: 'remote-candidate', candidateType: 'host' }],
    ['d', { type: 'candidate-pair', requestsSent: 14, responsesReceived: 0 }],
    ['e', { type: 'candidate-pair', requestsSent: 10 }],
    ['f', { type: 'transport' }],
  ])
  const d = resumoConexao(stats, 'failed')
  assert.deepEqual(d, { local: ['local', 'internet'], remoto: ['local'], idas: 24, voltas: 0, estado: 'failed' })
  assert.equal(textoConexao(d), 'Este: local, internet · Outro: local · 24 idas, 0 voltas · failed')
  assert.equal(textoConexao(resumoConexao(new Map(), '')), 'Este: nenhum · Outro: nenhum · 0 idas, 0 voltas')
  assert.match(DICA_MAC, /Rede Local/)
})

test('não conectou: o que o outro lado anunciou na SDP (IP local só até a rede)', () => {
  const sdp = [
    'v=0',
    'a=candidate:1 1 udp 2113937151 192.168.15.23 50506 typ host generation 0',
    'a=candidate:2 1 udp 2113937151 0b7e4c1a-1111-2222-3333-444455556666.local 50507 typ host generation 0',
    'a=candidate:3 1 udp 1677729535 177.10.20.30 61000 typ srflx raddr 0.0.0.0 rport 0 generation 0',
    'a=candidate:4 1 tcp 1518280447 192.168.15.23 9 typ host tcptype active generation 0',
    'a=candidate:5 1 udp 2113939711 fe80::1 50508 typ host generation 0',
  ].join('\r\n')
  assert.deepEqual(candidatosDaSdp(sdp), ['1 local 192.168.15.x', '1 local .local', '1 internet', '1 local 192.168.15.x tcp', '1 local IPv6'])
  assert.deepEqual(candidatosDaSdp(''), [])
  assert.match(textoConexao({ local: ['local'], remoto: [], idas: 0, voltas: 0, estado: 'failed', sdpOutro: [] }), /SDP do outro: nenhum/)
})
