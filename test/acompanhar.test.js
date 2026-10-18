// Acompanhar pelo celular (src/engine/acompanhar.js): o retrato que vai para o site (conteúdo, rodadas, teto de
// tamanho), o ritmo dos envios (evento agrupado, 10 s andando, sinal de vida parado), falhas sem atrapalhar nada e o
// ajuste desligado / sem conta = nenhum pedido.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AcompanharCelular, montarRetrato, montarLotes, LIMITE_BYTES, MAX_ITENS } from '../src/engine/acompanhar.js'
import { HttpError } from '../src/net/http.js'
import { validateSettings, DEFAULT_SETTINGS } from '../src/config.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const MIN = 60_000

let seq = 0
function rec(over = {}) {
  const now = Date.now()
  return {
    id: `t${++seq}`,
    type: 'upload',
    batchId: 'b1',
    status: 'queued',
    name: `A001_C00${seq}.braw`,
    relPath: `Cenas/A001_C00${seq}.braw`,
    size: 1e9,
    bytesDone: 0,
    createdAt: now - 10 * MIN,
    startedAt: null,
    finishedAt: null,
    updatedAt: now - 10 * MIN,
    error: null,
    target: { rootId: 'pasta1', relDir: 'Cenas', parentId: null, driveId: null },
    ...over,
  }
}

class FakeManager extends EventEmitter {
  constructor(records = [], { up = 0, down = 0, live = {} } = {}) {
    super()
    this.records = new Map(records.map(r => [r.id, r]))
    this.batches = new Map([['b1', { id: 'b1', type: 'upload', label: 'Pasta Cenas', destino: 'Projeto X' }]])
    this.speeds = { up, down }
    this.live = live
    this.statsCalls = 0
  }
  stats() {
    this.statsCalls++
    return { up: { speed: this.speeds.up }, down: { speed: this.speeds.down }, eta: null }
  }
  get(id) {
    const r = this.records.get(id)
    return r ? { ...r, ...(this.live[id] || {}) } : null
  }
  set(r, patch) {
    Object.assign(r, patch, { updatedAt: Date.now() })
    this.emit('transfers', [{ id: r.id, status: r.status }])
  }
}

class FakeCloud extends EventEmitter {
  constructor({ conectado = true, fail = null } = {}) {
    super()
    this.conectado = conectado
    this.fail = fail
    this.calls = []
  }
  status() {
    return { conectado: this.conectado }
  }
  async request(method, path, opts = {}) {
    this.calls.push({ method, path, body: opts.body ? JSON.parse(JSON.stringify(opts.body)) : null, at: Date.now() })
    const err = this.fail?.()
    if (err) throw err
    return { status: method === 'DELETE' ? 204 : 200, data: { ok: true } }
  }
  posts() {
    return this.calls.filter(c => c.method === 'POST')
  }
}

class FakeSettings extends EventEmitter {
  constructor(over = {}) {
    super()
    this.current = { ...DEFAULT_SETTINGS, ...over }
  }
  get() {
    return this.current
  }
  update(patch) {
    const changed = Object.keys(patch).filter(k => patch[k] !== this.current[k])
    this.current = { ...this.current, ...patch }
    this.emit('change', this.current, changed)
  }
}

const FAST = { ativoMs: 120, ociosoMs: 600, eventoMs: 25, minGapMs: 40, maxEsperaMs: 400, pausaLongaMs: 300, log: () => {} }

describe('lotes (pedidos, como a tela Transferências)', () => {
  test('conta por lote: andando, na fila, prontos, conferidos, cancelados e erros; antigos e cancelados de vez ficam de fora', () => {
    const now = Date.now()
    const down = (over) => rec({ type: 'download', batchId: 'b2', target: undefined, dest: { path: '/Volumes/SSD/ZRO/x.mp4' }, ...over })
    const m = new FakeManager(
      [
        down({ status: 'running', size: 4e9, bytesDone: 1e8 }),
        down({ status: 'running', size: 3e9, bytesDone: 2e8 }),
        down({ status: 'queued', size: 2e9 }),
        down({ status: 'completed', size: 1e9, bytesDone: 1e9, finishedAt: now - 1000, verify: { state: 'ok' } }),
        rec({ status: 'completed', size: 5e8, bytesDone: 5e8, finishedAt: now - 59 * MIN, verify: { state: 'ok' } }),
        rec({ status: 'canceled', size: 5e8 }),
        rec({ status: 'canceled', size: 5e8 }),
        rec({ batchId: 'velho', status: 'completed', finishedAt: now - 8 * 24 * 60 * MIN }),
      ],
      { live: {} },
    )
    m.batches.set('b2', { id: 'b2', type: 'download', label: 'Pasta "ZRO"', destino: 'SSD', createdAt: now - 5 * MIN })
    const ids = [...m.records.values()].filter(r => r.batchId === 'b2' && r.status === 'running').map(r => r.id)
    m.live = { [ids[0]]: { bytesDone: 1.5e8, speed: 7.7e6 }, [ids[1]]: { bytesDone: 2e8, speed: 6.7e6 } }
    const lotes = montarLotes(m, now)
    assert.deepEqual(lotes.map(l => l.id), ['b2', 'b1'], 'andando primeiro; o velho (8 dias) fica de fora')
    const [zro, cenas] = lotes
    assert.equal(zro.titulo, 'Pasta "ZRO"')
    assert.equal(zro.direcao, 'desce')
    assert.equal(zro.arquivos, 4)
    assert.equal(zro.bytes, 10e9)
    assert.equal(zro.feitoBytes, 1.5e8 + 2e8 + 0 + 1e9)
    assert.deepEqual([zro.andando, zro.naFila, zro.concluidos, zro.conferidos, zro.cancelados, zro.erros], [2, 1, 1, 1, 0, 0])
    assert.equal(zro.velocidade, Math.round(7.7e6 + 6.7e6))
    assert.equal(zro.eta, Math.round((4e9 - 1.5e8 + 3e9 - 2e8 + 2e9) / (7.7e6 + 6.7e6)))
    assert.equal(zro.terminouEm, null)
    assert.equal(cenas.titulo, 'Pasta Cenas')
    assert.deepEqual([cenas.arquivos, cenas.concluidos, cenas.cancelados, cenas.conferidos], [3, 1, 2, 1])
    assert.equal(cenas.terminouEm, now - 59 * MIN)
    assert.equal(cenas.eta, null)
  })

  test('o retrato leva os lotes e cada item diz de qual lote é', () => {
    const now = Date.now()
    const r = montarRetrato(new FakeManager([rec({ status: 'running' }), rec({ status: 'completed', finishedAt: now - 1000 })]), { rodada: { id: 'r', inicio: now - MIN }, now })
    assert.equal(r.lotes.length, 1)
    assert.equal(r.itens[0].lote, 'b1')
    assert.equal(r.terminados[0].lote, 'b1')
  })
})

describe('retrato', () => {
  test('ajuste novo: ligado por padrão e validado como booleano', () => {
    assert.equal(DEFAULT_SETTINGS.acompanharCelular, true)
    assert.equal(validateSettings({ acompanharCelular: 0 }).acompanharCelular, false)
  })

  test('conteúdo: andando, na fila, pausado, prontos e falhas; listas e destino', () => {
    const now = Date.now()
    const rodando = rec({ status: 'running', bytesDone: 2e8, startedAt: now - MIN })
    const fila = rec({ status: 'queued', type: 'download', batchId: 'b2', dest: { path: '/Users/v/Downloads/Brutos/A.mov' }, target: undefined })
    const pausado = rec({ status: 'paused', bytesDone: 5e8, updatedAt: now - 1000, error: { message: 'Conecte a conta de novo' } })
    const pronto = rec({ status: 'completed', bytesDone: 1e9, finishedAt: now - 30_000 })
    const pulado = rec({ status: 'skipped', bytesDone: 0, finishedAt: now - 20_000, note: 'Já estava no Drive' })
    const falhou = rec({ status: 'failed', bytesDone: 3e8, updatedAt: now - 10_000, error: { message: 'O arquivo sumiu do computador.' } })
    const velho = rec({ status: 'completed', finishedAt: now - 8 * 24 * 60 * MIN })
    const cancelado = rec({ status: 'canceled', finishedAt: now - 5000 })
    const m = new FakeManager([rodando, fila, pausado, pronto, pulado, falhou, velho, cancelado], { up: 80e6, live: { [rodando.id]: { bytesDone: 4e8, speed: 80e6 } } })
    const r = montarRetrato(m, { rodada: { id: 'r1', inicio: now - 60 * MIN }, now })
    assert.equal(r.v, 1)
    assert.equal(r.estado, 'enviando')
    assert.equal(r.rodada, 'r1')
    assert.equal(r.geral.total, 6) // velho e cancelado de fora
    assert.equal(r.geral.feitos, 2)
    assert.equal(r.geral.erros, 1)
    assert.equal(r.geral.totalBytes, 6e9)
    assert.equal(r.geral.feitoBytes, 4e8 + 0 + 5e8 + 1e9 + 1e9 + 3e8)
    assert.equal(r.geral.velocidade, 80e6)
    assert.deepEqual([r.geral.sobe.arquivos, r.geral.desce.arquivos], [5, 1])
    // ETA: o que falta dos ativos (rodando + fila) na velocidade de agora; o pausado não conta.
    assert.equal(r.geral.eta, Math.round((1e9 - 4e8 + 1e9) / 80e6))
    assert.deepEqual(
      r.itens.map(i => [i.nome, i.estado, i.direcao, i.feito, i.destino]),
      [
        [rodando.name, 'enviando', 'sobe', 4e8, 'Projeto X'],
        [fila.name, 'na_fila', 'desce', 0, 'Brutos'],
        [pausado.name, 'pausado', 'sobe', 5e8, 'Projeto X'],
      ],
    )
    assert.equal(r.itens[0].velocidade, 80e6)
    assert.equal(r.itens[2].erro, 'Conecte a conta de novo')
    assert.deepEqual(
      r.terminados.map(t => [t.nome, t.ok]),
      [
        [falhou.name, false],
        [pulado.name, true],
        [pronto.name, true],
      ],
    )
    assert.equal(r.terminados[0].erro, 'O arquivo sumiu do computador.')
    // Nada de caminho do computador, sessão ou conta no retrato.
    const json = JSON.stringify(r)
    assert.ok(!json.includes('/Users/v'))
    assert.ok(!json.includes('accountId'))
  })

  test('estados quando nada anda: concluído, erro, pausado, parado', () => {
    const now = Date.now()
    const rodada = { id: 'r1', inicio: now - MIN }
    const ok = () => rec({ status: 'completed', finishedAt: now - 1000, bytesDone: 1e9 })
    assert.equal(montarRetrato(new FakeManager([ok(), ok()]), { rodada, now }).estado, 'concluido')
    assert.equal(montarRetrato(new FakeManager([ok(), rec({ status: 'failed', updatedAt: now - 500 })]), { rodada, now }).estado, 'erro')
    assert.equal(montarRetrato(new FakeManager([ok(), rec({ status: 'paused', updatedAt: now - 500 })]), { rodada, now }).estado, 'pausado')
    // Pausado de antes da rodada não segura o "concluído".
    assert.equal(montarRetrato(new FakeManager([ok(), rec({ status: 'paused', updatedAt: now - 60 * MIN })]), { rodada, now }).estado, 'concluido')
    const parado = montarRetrato(new FakeManager([ok()]), { rodada: null, now })
    assert.equal(parado.estado, 'parado')
    assert.equal(parado.rodada, null)
    assert.equal(parado.geral.total, 0)
    assert.equal(parado.terminados.length, 1) // "Já passou" continua aparecendo
    const down = montarRetrato(new FakeManager([rec({ status: 'running', type: 'download', dest: { path: '/x/y/z.mov' } })], { down: 1 }), { rodada, now })
    assert.equal(down.estado, 'baixando')
  })

  test('teto de tamanho: até 50 itens e menos de 60 KB, o resto conta em "fora"', () => {
    const now = Date.now()
    const list = []
    for (let i = 0; i < 400; i++) list.push(rec({ status: i % 2 ? 'queued' : 'completed', finishedAt: i % 2 ? null : now - i * 1000, name: `${'Nome bem comprido de arquivo de câmera '.repeat(8)}${i}.braw` }))
    const r = montarRetrato(new FakeManager(list), { rodada: { id: 'r', inicio: 0 }, now })
    assert.ok(r.itens.length <= MAX_ITENS)
    assert.ok(Buffer.byteLength(JSON.stringify(r)) <= LIMITE_BYTES)
    assert.equal(r.geral.fora, 200 - r.itens.length)
    assert.ok(r.itens.every(i => i.nome.length <= 160))
  })
})

describe('AcompanharCelular', () => {
  test('rodada: o que terminou antes de tudo parar não entra na próxima', async () => {
    const a = rec({ status: 'running' })
    const m = new FakeManager([a])
    const rep = new AcompanharCelular({ manager: m, cloud: new FakeCloud(), settings: new FakeSettings(), ...FAST })
    let r = rep.retrato()
    assert.equal(r.estado, 'enviando')
    const primeira = r.rodada
    a.status = 'completed'
    a.finishedAt = Date.now()
    r = rep.retrato()
    assert.equal(r.estado, 'concluido')
    assert.equal(r.rodada, primeira)
    assert.equal(r.geral.feitos, 1)
    await sleep(5)
    const b = rec({ status: 'queued', createdAt: Date.now(), updatedAt: Date.now() })
    m.records.set(b.id, b)
    r = rep.retrato()
    assert.notEqual(r.rodada, primeira)
    assert.equal(r.geral.total, 1)
    assert.equal(r.estado, 'enviando')
    assert.equal(r.terminados.length, 1) // a anterior continua em "Já passou"
  })

  test('ritmo: evento manda logo (agrupado), ~10 s andando, sinal de vida parado', async () => {
    const recs = Array.from({ length: 30 }, () => rec({ status: 'queued' }))
    const m = new FakeManager(recs, { up: 1e6 })
    const cloud = new FakeCloud()
    const rep = new AcompanharCelular({ manager: m, cloud, settings: new FakeSettings(), ...FAST })
    rep.start()
    await sleep(60)
    assert.equal(cloud.posts().length, 1, 'primeiro retrato logo ao começar')
    // 30 arquivos mudando de estado juntos = um envio só.
    for (const r of recs) m.set(r, { status: 'running' })
    await sleep(70)
    assert.equal(cloud.posts().length, 2)
    // Andando: a cada ativoMs (120 ms aqui).
    await sleep(400)
    const andando = cloud.posts().length
    assert.ok(andando >= 3 && andando <= 7, `envios andando: ${andando}`)
    // Tudo termina: manda logo, com "concluido".
    for (const r of recs) {
      r.status = 'completed'
      r.finishedAt = Date.now()
    }
    m.emit('transfers', recs.map(r => ({ id: r.id, status: 'completed' })))
    await sleep(80)
    const fim = cloud.posts().at(-1).body
    assert.equal(fim.estado, 'concluido')
    assert.equal(fim.geral.feitos, 30)
    // Parado: só o sinal de vida (600 ms aqui).
    const n = cloud.posts().length
    await sleep(450)
    assert.equal(cloud.posts().length, n)
    await sleep(300)
    assert.equal(cloud.posts().length, n + 1)
    assert.ok(cloud.posts().every(c => c.path === '/api/dispositivos/status'))
    await rep.close()
  })

  test('lote pequeno que começa e termina entre dois retratos também vira "concluído"', async () => {
    const m = new FakeManager([])
    const cloud = new FakeCloud()
    const rep = new AcompanharCelular({ manager: m, cloud, settings: new FakeSettings(), ...FAST })
    rep.start()
    await sleep(60)
    assert.equal(cloud.posts().at(-1).body.estado, 'parado')
    const r = rec({ status: 'completed', createdAt: Date.now(), finishedAt: Date.now() + 1 })
    m.records.set(r.id, r)
    m.emit('transfers', [{ id: r.id, status: 'completed' }])
    await sleep(80)
    const b = cloud.posts().at(-1).body
    assert.equal(b.estado, 'concluido')
    assert.equal(b.geral.feitos, 1)
    assert.ok(b.rodada)
    // Um retoque depois (prévia leve, miniatura) num arquivo antigo não abre rodada nova.
    const rodada = b.rodada
    await sleep(20)
    m.emit('transfers', [{ id: r.id, status: 'completed' }])
    await sleep(80)
    assert.equal(cloud.posts().at(-1).body.rodada, rodada)
    await rep.close()
  })

  test('falhas não lançam nem atrapalham; volta a mandar quando o site responde', async () => {
    const r = rec({ status: 'running' })
    const m = new FakeManager([r])
    let falhar = true
    const cloud = new FakeCloud({ fail: () => (falhar ? Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }) : null) })
    const rep = new AcompanharCelular({ manager: m, cloud, settings: new FakeSettings(), ...FAST })
    rep.start()
    await sleep(500)
    const tentativas = cloud.calls.length
    assert.ok(tentativas >= 2, `tentou de novo: ${tentativas}`)
    assert.ok(tentativas <= 5, `com recuo: ${tentativas}`)
    assert.equal(rep.enviados, 0)
    assert.equal(r.status, 'running') // a fila nem ficou sabendo
    falhar = false
    await sleep(500)
    assert.ok(rep.enviados >= 1)
    await rep.close()
  })

  test('site sem a rota (404): para por um tempo, sem insistir', async () => {
    const m = new FakeManager([rec({ status: 'running' })])
    const cloud = new FakeCloud({ fail: () => new HttpError(404, { body: { erro: 'nao_encontrada' } }) })
    const rep = new AcompanharCelular({ manager: m, cloud, settings: new FakeSettings(), ...FAST, pausaLongaMs: 10_000 })
    rep.start()
    await sleep(500)
    assert.equal(cloud.calls.length, 1)
    await rep.close()
  })

  test('ajuste desligado ou sem conta: nenhum pedido; desligar depois apaga o retrato do site', async () => {
    const m = new FakeManager([rec({ status: 'running' })])
    const off = new FakeCloud()
    const r1 = new AcompanharCelular({ manager: m, cloud: off, settings: new FakeSettings({ acompanharCelular: false }), ...FAST })
    r1.start()
    m.emit('transfers', [{ id: 'x', status: 'running' }])
    await sleep(300)
    assert.equal(off.calls.length, 0)
    await r1.close({ final: true })
    assert.equal(off.calls.length, 0)

    const semConta = new FakeCloud({ conectado: false })
    const r2 = new AcompanharCelular({ manager: m, cloud: semConta, settings: new FakeSettings(), ...FAST })
    r2.start()
    await sleep(300)
    assert.equal(semConta.calls.length, 0)
    // Entrou na conta: começa a mandar.
    semConta.conectado = true
    semConta.emit('status', { conectado: true })
    await sleep(80)
    assert.equal(semConta.posts().length, 1)
    await r2.close()

    const cloud = new FakeCloud()
    const settings = new FakeSettings()
    const r3 = new AcompanharCelular({ manager: m, cloud, settings, ...FAST })
    r3.start()
    await sleep(60)
    assert.equal(cloud.posts().length, 1)
    settings.update({ acompanharCelular: false })
    await sleep(300)
    assert.deepEqual(
      cloud.calls.map(c => c.method),
      ['POST', 'DELETE'],
    )
    settings.update({ acompanharCelular: true })
    await sleep(80)
    assert.equal(cloud.posts().length, 2)
    await r3.close()
  })

  test('ao fechar o app: última notícia com "fechado"', async () => {
    const m = new FakeManager([rec({ status: 'running' })])
    const cloud = new FakeCloud()
    const rep = new AcompanharCelular({ manager: m, cloud, settings: new FakeSettings(), ...FAST })
    rep.start()
    await sleep(60)
    await rep.close({ final: true })
    const ultimo = cloud.posts().at(-1).body
    assert.equal(ultimo.fechado, true)
    const n = cloud.calls.length
    m.emit('transfers', [{ id: 'y', status: 'running' }])
    await sleep(200)
    assert.equal(cloud.calls.length, n)
  })
})
