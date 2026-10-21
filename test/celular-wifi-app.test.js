// Celular ↔ computador pelo Wi-Fi, lado do celular (web/public/app/lib/p2p-util.js): nome do aparelho, onde guardar o
// que chega (OPFS ou memória, com o limite), nomes e tipos dos arquivos, velocidade e mensagens de erro.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LIMITE_MEMORIA, Medidor, mensagemDe, nomeAparelho, nomeSeguro, ondeGuardar, tipoDe } from '../web/public/app/lib/p2p-util.js'

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
