// LOG → Rec.709 (src/cor/): as curvas dos fabricantes, as matrizes de gamut, a LUT (.cube e a cópia da prévia) e a
// detecção do perfil pelos metadados e pela imagem.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CURVAS, PERFIS, converter, cube, curvaFilme, ehPerfil, gerarLut, matrizPara709 } from '../src/cor/lut.js'
import { pareceLog, perfilDosBytes } from '../src/cor/detectar.js'

const perto = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} ≠ ${b}`)

describe('cor', () => {
  test('as prévias (computador e celular) usam a mesma LUT, detecção e filtro (cópias idênticas)', () => {
    const ler = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
    for (const [orig, copias] of [
      ['src/cor/lut.js', ['public/lib/cor-lut.js', 'web/public/app/lib/cor-lut.js']],
      ['src/cor/detectar.js', ['web/public/app/lib/cor-detectar.js']],
      ['public/lib/cor-gl.js', ['web/public/app/lib/cor-gl.js']],
    ])
      for (const c of copias) assert.equal(ler(c), ler(orig), `${c} = ${orig}`)
    assert.doesNotMatch(ler('src/cor/detectar.js'), /\bBuffer\b|^import /m, 'roda no navegador do celular')
  })

  test('curvas: o cinza 18% de cada câmera volta a 18% de luz', () => {
    // Valores de código (0–1, cheio) do cinza 18% publicados pelos fabricantes.
    const cinza = {
      slog3: (420 / 1023 - 64 / 1023) / (876 / 1023), // 420 em 10 bits legal
      vlog: (0.423 * 1023 - 64) / 876, // V-Log: 42,3% do código
      clog3: 0.343, // Canon Log 3: 34,3% (cheio)
      logc3: 0.391, // ARRI LogC3 EI 800: 39,1%
      flog: 0.46, // F-Log: 46%
    }
    for (const [c, v] of Object.entries(cinza)) perto(CURVAS[c](v), 0.18, 0.012, c)
    perto(CURVAS.dlog(0.4), 0.18, 0.05, 'dlog (aproximado)')
  })

  test('matrizes: branco continua branco; Rec.709 é a identidade', () => {
    assert.deepEqual(matrizPara709('rec709'), [[1, 0, 0], [0, 1, 0], [0, 0, 1]])
    for (const g of ['sgamut3cine', 'sgamut3', 'vgamut', 'cinemagamut', 'awg3', 'dgamut', 'rec2020']) {
      const m = matrizPara709(g)
      for (const l of m) perto(l[0] + l[1] + l[2], 1, 1e-6, g)
    }
  })

  test('tela: cinza médio fica ~44%, preto é preto e o branco não estoura seco', () => {
    perto(converter('slog3-cine', ...Array(3).fill((420 / 1023 - 64 / 1023) / (876 / 1023)))[0], 0.44, 0.03, 'cinza')
    assert.equal(curvaFilme(0), 0)
    assert.ok(curvaFilme(1) < 0.9 && curvaFilme(20) <= 1)
    // Rec.709 passa reto.
    assert.deepEqual(converter('rec709', 0.2, 0.5, 0.7), [0.2, 0.5, 0.7])
    // LOG fica mais contrastado e mais saturado.
    const lavado = [0.55, 0.42, 0.4]
    const [r, g, b] = converter('slog3-cine', ...lavado)
    assert.ok(r - b > lavado[0] - lavado[2], 'satura')
  })

  test('LUT: vermelho varia mais rápido, .cube no formato que o ffmpeg lê', () => {
    const n = 5
    const lut = gerarLut('slog3-cine', n)
    assert.equal(lut.length, n * n * n * 3)
    const [r1] = converter('slog3-cine', 1 / (n - 1), 0, 0)
    perto(lut[3], r1, 1e-6, 'segunda entrada = vermelho 1')
    const txt = cube('vlog', n).trim().split('\n')
    assert.match(txt[0], /^TITLE ".*V-Log/)
    assert.equal(txt[1], `LUT_3D_SIZE ${n}`)
    assert.equal(txt.length, 4 + n ** 3)
    assert.match(txt.at(-1), /^\d\.\d{6} \d\.\d{6} \d\.\d{6}$/)
  })

  test('detecção pelos metadados das câmeras', () => {
    const casos = [
      ['<CaptureGammaEquation value="s-log3-cine"/>', 'slog3-cine'],
      ['<CaptureGammaEquation value="s-log3"/><CaptureColorPrimaries value="S-Gamut3"/>', 'slog3'],
      ['<CaptureGammaEquation value="s-log3"/><CaptureColorPrimaries value="S-Gamut3.Cine"/>', 'slog3-cine'],
      ['<CaptureGammaEquation value="rec709"/>', 'rec709'],
      ['<CaptureGammaEquation value="s-cinetone"/>', 'rec709'],
      ['..GammaMode V-Log ..', 'vlog'],
      ['Canon Log 3', 'clog3'],
      ['DJI D-Log', 'dlog'],
      ['ARRI ALEXA Mini LF LogC', 'logc3'],
      ['FUJIFILM F-Log', 'flog'],
      ['nada aqui, nem blog nem catalog', null],
      ['Meu vlog de viagem · flog · dlog', null],
    ]
    for (const [txt, esperado] of casos) assert.equal(perfilDosBytes(Buffer.from(`\0\0${txt}\0`, 'latin1')), esperado, txt)
    assert.equal(perfilDosBytes(new TextEncoder().encode('<CaptureGammaEquation value="s-log3-cine"/>')), 'slog3-cine', 'Uint8Array (celular)')
    assert.ok(ehPerfil('vlog') && !ehPerfil('toString') && !ehPerfil('auto'))
    for (const p of Object.values(PERFIS)) assert.ok(p.nome)
  })

  test('detecção pela imagem: LOG lavado sim; Rec.709 com branco e cor não', () => {
    const quadro = (fn) => {
      const q = new Uint8Array(224 * 224 * 3)
      for (let i = 0; i < 224 * 224; i++) q.set(fn(i / (224 * 224)), i * 3)
      return q
    }
    // LOG: rampa de 25% a 65%, pouca cor.
    const log = quadro((x) => [Math.round((0.25 + 0.4 * x) * 255), Math.round((0.24 + 0.38 * x) * 255), Math.round((0.23 + 0.36 * x) * 255)])
    // Rec.709: preto a branco, com cor.
    const r709 = quadro((x) => [Math.round(x * 255), Math.round(x * x * 255), Math.round((1 - x) * 200)])
    assert.equal(pareceLog([log, log, log]), 'log')
    assert.equal(pareceLog([r709, r709, r709]), null)
    assert.equal(pareceLog([log, r709, r709]), null, 'vale a maioria')
    assert.equal(pareceLog([]), null)
  })
})
