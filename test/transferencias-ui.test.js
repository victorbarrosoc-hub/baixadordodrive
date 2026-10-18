// Regras da tela Transferências que não dependem do navegador (public/lib/transferencias.js) e o texto do tempo
// que falta (public/lib/format.js → aprox, o mesmo do celular).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FILTER_TESTS, batchLocal, integrity, integrityLabel, meterTotals, needsYou, sortRows } from '../public/lib/transferencias.js'
import { aprox } from '../public/lib/format.js'

const t = (status, extra = {}) => ({ status, ...extra })

test('filtros: "precisa de você" (pausado com motivo) vai para Com problema, não para Em andamento', () => {
  const precisa = t('paused', { error: { message: 'O acesso expirou.', kind: 'reauth' } })
  const pausado = t('paused')
  assert.equal(needsYou(precisa), true)
  assert.equal(needsYou(pausado), false)
  assert.equal(FILTER_TESTS.failed(precisa), true)
  assert.equal(FILTER_TESTS.active(precisa), false)
  assert.equal(FILTER_TESTS.active(pausado), true)
  assert.equal(FILTER_TESTS.failed(pausado), false)
  assert.equal(FILTER_TESTS.failed(t('failed')), true)
  assert.equal(FILTER_TESTS.failed(t('completed', { verify: { state: 'mismatch' } })), true)
  assert.equal(FILTER_TESTS.failed(t('waiting', { error: { message: 'Sem conexão.' } })), false, 'esperando a rede volta sozinho')
  assert.equal(FILTER_TESTS.active(t('waiting')), true)
  assert.equal(FILTER_TESTS.queued(t('queued')), true)
  assert.equal(FILTER_TESTS.done(t('skipped')), true)
})

test('integridade do lote: conferidos (MD5), sem conferência e os que chegaram diferentes', () => {
  const ok = t('completed', { verify: { state: 'ok' } })
  const nove = Array.from({ length: 9 }, () => ok)
  assert.equal(integrityLabel(integrity(nove)), '9 de 9 conferidos (MD5)')
  assert.equal(integrityLabel(integrity([ok])), '1 de 1 conferido (MD5)')
  const oito = [...Array.from({ length: 8 }, () => ok), t('completed', { verify: { state: 'skipped' } })]
  assert.equal(integrityLabel(integrity(oito)), '8 de 9 conferidos · 1 sem conferência')
  const dif = [ok, t('completed', { verify: { state: 'mismatch' } }), t('completed', { verify: null })]
  assert.deepEqual(integrity(dif), { total: 3, checked: 1, mismatch: 1, unchecked: 1 })
  assert.equal(integrityLabel(integrity(dif)), '1 de 3 conferidos · 1 chegou diferente · 1 sem conferência')
  // "Já estava no Drive" com o MD5 igual conta como conferido; cancelado não conta.
  assert.equal(integrityLabel(integrity([t('skipped', { verify: { state: 'ok' } }), t('canceled'), ok])), '2 de 2 conferidos (MD5)')
  assert.equal(integrityLabel(integrity([t('canceled')])), null)
})

test('rodapé do medidor: o que anda e o parado vêm separados de stats.totals', () => {
  assert.deepEqual(meterTotals({ bytes: 45e9, doneBytes: 1e9, remaining: 1.7e9, parked: 42e9, parkedCount: 4, problems: 3 }), { moving: 1.7e9, parked: 42e9, parkedCount: 4, problems: 3 })
  // Motor antigo (sem `remaining`): tudo o que falta, como antes.
  assert.deepEqual(meterTotals({ bytes: 10, doneBytes: 4 }), { moving: 6, parked: 0, parkedCount: 0, problems: 0 })
  assert.deepEqual(meterTotals(undefined), { moving: 0, parked: 0, parkedCount: 0, problems: 0 })
})

test('aprox: "faltam ~2 min" com o mesmo texto do celular', () => {
  // Mesma tabela de web/public/app/lib/computador.js (aprox), que não carrega no Node.
  const want = { 0: 'menos de 1 min', 59: 'menos de 1 min', 60: '~1 min', 3599: '~1 h', 3600: '~1 h', 3660: '~1 h 1 min', 86400: '~24 h' }
  for (const [s, txt] of Object.entries(want)) assert.equal(aprox(Number(s)), txt, `aprox(${s})`)
  assert.equal(aprox(-1), null)
  assert.equal(aprox(129), '~2 min')
  assert.equal(aprox(30), 'menos de 1 min')
  assert.equal(aprox(7500), '~2 h 5 min')
  assert.equal(aprox(null), null)
})

test('ordem na fila do envio: prioridade, depois o maior primeiro (como o motor); download segue a ordem de entrada', () => {
  const up = (name, size, extra = {}) => ({ name, size, type: 'upload', batchId: 'b', status: 'queued', createdAt: name.charCodeAt(0), ...extra })
  const rows = [up('a', 10), up('b', 500), up('c', 50), up('d', 5, { priority: 1 }), up('e', 900, { status: 'running' }), up('f', 1, { status: 'completed' })]
  assert.deepEqual(rows.slice().sort(sortRows).map((r) => r.name), ['e', 'd', 'b', 'c', 'a', 'f'])
  const dl = (name, size) => ({ name, size, type: 'download', batchId: 'b', status: 'queued', createdAt: name.charCodeAt(0) })
  assert.deepEqual([dl('a', 1), dl('b', 9)].sort(sortRows).map((r) => r.name), ['a', 'b'])
})

test('batchLocal: a pasta do computador de um lote de download (durante e depois), Mac e Windows', () => {
  const d = (path, status = 'completed', extra = {}) => ({ type: 'download', status, dest: { path, tempPath: `${path}.sobedesce-part` }, ...extra })
  // Durante: ninguém pronto ainda; mostra o temporário de quem está baixando na pasta de cima.
  const ativo = [d('/Volumes/SSD/ZRO/A.mp4', 'running'), d('/Volumes/SSD/ZRO/Som/Z.wav', 'queued'), d('/Volumes/SSD/ZRO/B.mp4', 'queued')]
  assert.deepEqual(batchLocal(ativo), { dir: '/Volumes/SSD/ZRO', target: '/Volumes/SSD/ZRO/A.mp4.sobedesce-part', name: 'ZRO' })
  // Depois: o arquivo pronto na pasta de cima.
  const fim = [d('/Volumes/SSD/ZRO/Som/Z.wav'), d('/Volumes/SSD/ZRO/B.mp4'), d('/Volumes/SSD/Outro/x.mp4', 'canceled')]
  assert.deepEqual(batchLocal(fim), { dir: '/Volumes/SSD/ZRO', target: '/Volumes/SSD/ZRO/B.mp4', name: 'ZRO' })
  // Só subpastas: a própria pasta.
  assert.deepEqual(batchLocal([d('/Users/v/Downloads/ZRO/Cam A/1.mov'), d('/Users/v/Downloads/ZRO/Cam B/2.mov')]), { dir: '/Users/v/Downloads/ZRO', target: '/Users/v/Downloads/ZRO', name: 'ZRO' })
  // Windows.
  assert.deepEqual(batchLocal([d('E:\\ZRO\\A.mp4'), d('E:\\ZRO\\B.mp4')]), { dir: 'E:\\ZRO', target: 'E:\\ZRO\\A.mp4', name: 'ZRO' })
  // Envio, sem caminho ou tudo cancelado: nada.
  assert.equal(batchLocal([{ type: 'upload', status: 'completed', local: { path: '/x' } }]), null)
  assert.equal(batchLocal([d('/a/b.mp4', 'canceled')]), null)
  assert.equal(batchLocal([]), null)
})
