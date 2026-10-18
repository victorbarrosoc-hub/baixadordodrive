// Uso por dia (src/engine/uso.js): conta só o que terminou com o app aberto, uma vez por arquivo, soma o tempo com algo
// andando, guarda em uso.json, manda para a conta só quando mudou (e de novo depois de uma falha) e nunca leva nome
// de arquivo. O cabeçalho x-sobedesce-build vai em todo pedido ao site (src/google/cloud-auth.js).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { UsoDiario, diaLocal, limparDias } from '../src/engine/uso.js'

class FakeCloud extends EventEmitter {
  constructor() {
    super()
    this.pedidos = []
    this.falhar = false
    this.conectado = true
  }
  status() {
    return { conectado: this.conectado }
  }
  async request(method, p, { body }) {
    if (this.falhar) throw Object.assign(new Error('rede'), { status: 503 })
    this.pedidos.push({ method, path: p, body: JSON.parse(JSON.stringify(body)) })
    return { status: 200, data: { ok: true } }
  }
}

function montar({ now = () => relogio.t, file = null } = {}) {
  const manager = new EventEmitter()
  const cloud = new FakeCloud()
  const uso = new UsoDiario({ manager, cloud, file, now, log: () => {}, primeiroMs: 60_000, cadaMs: 60_000 })
  return { manager, cloud, uso }
}

const relogio = { t: Date.parse('2026-10-18T15:00:00') }

describe('uso por dia', () => {
  test('conta envios, downloads, erros e maior arquivo; uma vez por arquivo; o que terminou antes de abrir não conta', () => {
    const { uso } = montar()
    const t0 = relogio.t
    uso.notar([
      { id: 'a', type: 'upload', status: 'completed', size: 2e9, finishedAt: t0 + 1, name: 'A001.braw' },
      { id: 'b', type: 'download', status: 'completed', size: 5e8, finishedAt: t0 + 2 },
      { id: 'c', type: 'download', status: 'failed', size: 1e9, updatedAt: t0 + 3 },
      { id: 'd', type: 'upload', status: 'completed', size: 9e9, finishedAt: t0 - 1000 },
      { id: 'e', type: 'upload', status: 'skipped', size: 1e9, finishedAt: t0 + 4 },
    ])
    // A prévia leve mexe no registro depois do fim: o mesmo arquivo de novo não soma.
    uso.notar([{ id: 'a', type: 'upload', status: 'completed', size: 2e9, finishedAt: t0 + 1 }])
    const [d] = uso.corpo().dias
    assert.deepEqual(d, {
      dia: diaLocal(t0),
      enviadosBytes: 2e9,
      baixadosBytes: 5e8,
      enviados: 1,
      baixados: 1,
      erros: 1,
      maiorArquivo: 2e9,
      msAtivo: 0,
    })
    assert.ok(!JSON.stringify(uso.corpo()).includes('braw'), 'nunca leva nome de arquivo')
  })

  test('tempo andando: soma entre eventos com algo correndo, com teto por passo', () => {
    const r = { t: relogio.t }
    const { uso } = montar({ now: () => r.t })
    const correndo = [{ id: 'x', type: 'download', status: 'running' }]
    uso.notar(correndo)
    r.t += 1000
    uso.notar(correndo)
    r.t += 60_000 // app suspenso: conta no máximo 15 s
    uso.notar(correndo)
    r.t += 500
    uso.notar([{ id: 'x', type: 'download', status: 'queued' }])
    r.t += 5000
    uso.notar(correndo)
    // O último trecho antes de parar não entra (o evento que diz "parou" já não tem nada correndo).
    assert.equal(uso.corpo().dias[0].msAtivo, 1000 + 15_000)
  })

  test('manda só quando mudou; falhou → tenta de novo; sem conta não manda', async () => {
    const { uso, cloud } = montar()
    uso.notar([{ id: 'a', type: 'upload', status: 'completed', size: 10, finishedAt: relogio.t + 1 }])
    cloud.falhar = true
    await uso.agora()
    assert.equal(cloud.pedidos.length, 0)
    cloud.falhar = false
    await uso.agora()
    assert.equal(cloud.pedidos.length, 1)
    assert.equal(cloud.pedidos[0].path, '/api/dispositivos/uso')
    assert.equal(cloud.pedidos[0].body.dias[0].enviados, 1)
    await uso.agora()
    assert.equal(cloud.pedidos.length, 1, 'nada mudou: não manda')
    cloud.conectado = false
    uso.notar([{ id: 'b', type: 'upload', status: 'completed', size: 10, finishedAt: relogio.t + 2 }])
    await uso.agora()
    assert.equal(cloud.pedidos.length, 1)
    await uso.close()
  })

  test('uso.json: guarda os dias e o pendente; ao reabrir continua de onde parou', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-uso-'))
    const file = path.join(dir, 'uso.json')
    const a = montar({ file })
    await a.uso.init()
    a.uso.notar([{ id: 'a', type: 'download', status: 'completed', size: 7, finishedAt: relogio.t + 1 }])
    a.cloud.conectado = false
    await a.uso.close({ final: true })
    const b = montar({ file })
    await b.uso.init()
    assert.equal(b.uso.corpo().dias[0].baixadosBytes, 7)
    await b.uso.agora()
    assert.equal(b.cloud.pedidos.length, 1, 'o pendente do app anterior vai na primeira chance')
    await b.uso.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('limparDias: só datas válidas, até hoje, no máximo 14 e só os campos conhecidos', () => {
    const raw = { 'x': {}, '2026-10-30': { enviados: 1 }, '2026-10-18': { enviados: 2, nome: 'a.mov', erros: -3 } }
    for (let i = 1; i <= 20; i++) raw[`2026-09-${String(i).padStart(2, '0')}`] = { baixados: i }
    const d = limparDias(raw, '2026-10-18')
    const dias = Object.keys(d)
    assert.equal(dias.length, 14)
    assert.equal(dias.at(-1), '2026-10-18')
    assert.equal(d['2026-10-18'].enviados, 2)
    assert.equal(d['2026-10-18'].erros, 0)
    assert.equal('nome' in d['2026-10-18'], false)
  })
})
