// Calculadora de mídia (aba Cartões §6): a conta (GB por hora, cartões com margem, HDs, tempo de cópia e conferência),
// o cartão "de 128 GB" no computador, os modos prontos (todos com fonte do fabricante) e as duas cópias iguais
// (app do computador e site).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { calcular, comoOComputadorMostra, duracao, gbPorHora, tamanho } from '../public/lib/midia-conta.js'
import { MODOS } from '../public/lib/midia-modos.js'

const ler = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

describe('calculadora de mídia', () => {
  test('GB por hora: bitrate × 3.600 ÷ 8 ÷ 1.000', () => {
    assert.equal(gbPorHora(100), 45)
    assert.equal(gbPorHora(240), 108)
    assert.equal(gbPorHora(600), 270)
  })

  test('cartões com margem, HDs e a conta linha por linha', () => {
    const r = calcular({ cameras: [{ nome: 'FX3', mbps: 240, horas: 10 }, { nome: 'A7 IV', mbps: 100, horas: 6 }], cartaoGB: 128, margem: 0.2, copias: 2 })
    assert.equal(r.linhas.length, 2)
    const [fx3, a7] = r.linhas
    assert.equal(fx3.gb, 1080)
    assert.equal(fx3.cartoes, 11, '1.080 × 1,2 = 1.296 ÷ 128 = 10,1 → 11')
    assert.equal(duracao(fx3.horasPorCartao * 3600), '1 h 11 min')
    assert.equal(a7.cartoes, 3)
    assert.equal(r.totalCartoes, 14)
    assert.equal(r.totalGB, 1350)
    assert.equal(r.hdGB, 2700)
    assert.equal(r.tempoTotalS, null, 'sem velocidade, sem tempo')
    assert.match(fx3.conta[0], /240 Mb\/s × 3\.600 s ÷ 8 ÷ 1\.000 = 108 GB por hora/)
    assert.match(r.conta[1], /× 2 cópias = 2,7 TB/)
    assert.match(r.conta[0], /^Total gravado: 1,08 TB \+ 270 GB = 1,35 TB/)
  })

  test('cartão exato não ganha um a mais; sem margem, conta seca', () => {
    const r = calcular({ cameras: [{ mbps: 100, horas: 128 / 45 }], cartaoGB: 128, margem: 0 })
    assert.equal(r.linhas[0].cartoes, 1)
  })

  test('tempo: o mais lento entre leitor e HD copia; conferir é ler de volta do HD', () => {
    const r = calcular({ cameras: [{ mbps: 240, horas: 10 }], cartaoGB: 256, leitorMBs: 300, hdMBs: 150 })
    assert.equal(r.tempoCopiaS, (1080 * 1000) / 150)
    assert.equal(r.tempoConferenciaS, (1080 * 1000) / 150)
    assert.match(r.conta.find((l) => l.startsWith('Cópia')), /o HD é o limite/)
    const so = calcular({ cameras: [{ mbps: 240, horas: 10 }], cartaoGB: 256, leitorMBs: 90 })
    assert.equal(so.tempoCopiaS, (1080 * 1000) / 90)
    assert.equal(so.tempoConferenciaS, null)
  })

  test('câmera sem bitrate ou sem horas fica de fora (nada inventado)', () => {
    const r = calcular({ cameras: [{ mbps: null, horas: 5 }, { mbps: 100, horas: 0 }], cartaoGB: 128 })
    assert.equal(r.linhas.length, 0)
    assert.equal(r.totalCartoes, 0)
  })

  test('o de 128 GB no computador: ~119 no Windows, 128 no Mac', () => {
    const m = comoOComputadorMostra(128)
    assert.equal(m.mac, 128)
    assert.equal(Math.round(m.windows * 10) / 10, 119.2)
    assert.equal(tamanho(1350), '1,35 TB')
    assert.equal(tamanho(45), '45 GB')
  })

  test('modos prontos: todos com bitrate, fonte do fabricante e id único', () => {
    const ids = new Set()
    for (const m of MODOS) {
      assert.ok(m.id && !ids.has(m.id), `id repetido: ${m.id}`)
      ids.add(m.id)
      assert.ok(m.camera && m.modo, m.id)
      assert.ok(m.mbps > 0, m.id)
      assert.match(m.fonte, /^https:\/\//, m.id)
      assert.ok(m.fonteNome, m.id)
    }
  })

  test('o app do computador e o site usam a mesma conta e os mesmos modos', () => {
    assert.equal(ler('../public/lib/midia-conta.js'), ler('../web/src/lib/midia/conta.js'))
    assert.equal(ler('../public/lib/midia-modos.js'), ler('../web/src/lib/midia/modos.js'))
    // e a do celular (aba Criar → Calculadora)
    assert.equal(ler('../public/lib/midia-conta.js'), ler('../web/public/app/lib/midia-conta.js'))
    assert.equal(ler('../public/lib/midia-modos.js'), ler('../web/public/app/lib/midia-modos.js'))
  })
})
