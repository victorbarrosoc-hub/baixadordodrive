// LOG → Rec.709, feito pelo app a partir das fórmulas públicas de cada fabricante (sem LUT de terceiros). Serve para
// VER (prévia, miniaturas, busca por cena), não para gradar: o resultado é uma "conversão de monitor", como a LUT 709
// que vai na câmera.
//
//   RGB do vídeo (0–1, como o ffmpeg / o navegador entregam: faixa legal já expandida)
//   ──▶ curva LOG do fabricante → luz linear da cena
//   ──▶ matriz do gamut da câmera → primárias Rec.709 (calculada das coordenadas xy, ponto branco D65)
//   ──▶ curva "de filme" (aproximação do ACES, cinza 18% ≈ 44%) → Rec.709 (gama 2,4)
//
// Este arquivo é o mesmo em src/cor/lut.js, public/lib/cor-lut.js (prévia do computador) e web/public/app/lib/cor-lut.js
// (prévia do celular); a prévia aplica na placa de vídeo. test/cor.test.js confere.

// ─────────── primárias (xy) ───────────
const D65 = [0.3127, 0.329]
export const GAMUTS = {
  rec709: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]],
  rec2020: [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]],
  sgamut3cine: [[0.766, 0.275], [0.225, 0.8], [0.089, -0.087]],
  sgamut3: [[0.73, 0.28], [0.14, 0.855], [0.1, -0.05]],
  vgamut: [[0.73, 0.28], [0.165, 0.84], [0.1, -0.03]],
  cinemagamut: [[0.74, 0.27], [0.17, 1.14], [0.08, -0.1]],
  awg3: [[0.684, 0.313], [0.221, 0.848], [0.0861, -0.102]],
  dgamut: [[0.71, 0.31], [0.21, 0.88], [0.09, -0.08]],
}

// ─────────── curvas LOG → linear ───────────
// Algumas fórmulas são definidas sobre o código "legal" do arquivo (64–940 em 10 bits); o RGB que chega já foi
// expandido para 0–1, então volta para o código antes.
const legal = (v) => (v * 876 + 64) / 1023

export const CURVAS = {
  // Sony S-Log3 (Technical Summary for S-Gamut3.Cine/S-Log3)
  slog3: (v) => {
    const x = legal(v)
    return x >= 171.2102946929 / 1023 ? 10 ** ((x * 1023 - 420) / 261.5) * (0.18 + 0.01) - 0.01 : ((x * 1023 - 95) * 0.01125) / (171.2102946929 - 95)
  },
  // Panasonic V-Log
  vlog: (v) => {
    const x = legal(v)
    return x < 0.181 ? (x - 0.125) / 5.6 : 10 ** ((x - 0.598206) / 0.241514) - 0.00873
  },
  // Canon Log 3 (sobre o valor cheio 0–1)
  clog3: (x) => {
    let y
    if (x < 0.097465473) y = -(10 ** ((0.12783901 - x) / 0.36726845) - 1) / 14.98325
    else if (x <= 0.15277891) y = (x - 0.12512219) / 1.9754798
    else y = (10 ** ((x - 0.12240537) / 0.36726845) - 1) / 14.98325
    return y * 0.9
  },
  // DJI D-Log
  dlog: (x) => (x <= 0.14 ? (x - 0.0929) / 6.025 : (10 ** (3.89616 * x - 2.27752) - 0.0108) / 0.9892),
  // ARRI LogC3 (EI 800)
  logc3: (x) => (x > 5.367655 * 0.010591 + 0.092809 ? (10 ** ((x - 0.385537) / 0.24719) - 0.052272) / 5.555556 : (x - 0.092809) / 5.367655),
  // Fujifilm F-Log
  flog: (x) => (x >= 0.100537775223865 ? (10 ** ((x - 0.790453) / 0.344676) - 0.009468) / 0.555556 : (x - 0.092864) / 8.735631),
}

/** Perfis que a pessoa escolhe (ou o app detecta): curva + gamut. */
export const PERFIS = {
  rec709: { nome: 'Rec.709 (sem conversão)', curva: null, gamut: 'rec709' },
  'slog3-cine': { nome: 'Sony S-Log3 · S-Gamut3.Cine', curva: 'slog3', gamut: 'sgamut3cine' },
  slog3: { nome: 'Sony S-Log3 · S-Gamut3', curva: 'slog3', gamut: 'sgamut3' },
  vlog: { nome: 'Panasonic V-Log', curva: 'vlog', gamut: 'vgamut' },
  clog3: { nome: 'Canon Log 3', curva: 'clog3', gamut: 'cinemagamut' },
  dlog: { nome: 'DJI D-Log', curva: 'dlog', gamut: 'dgamut' },
  logc3: { nome: 'ARRI LogC3', curva: 'logc3', gamut: 'awg3' },
  flog: { nome: 'Fujifilm F-Log', curva: 'flog', gamut: 'rec2020' },
  // LOG sem saber de qual câmera: a curva da Sony (a mais comum) sem mexer no gamut. Não é exato; deixa ver.
  log: { nome: 'LOG (genérico)', curva: 'slog3', gamut: 'rec709' },
}

export const ehPerfil = (p) => typeof p === 'string' && Object.hasOwn(PERFIS, p)

// ─────────── matrizes ───────────
function rgbParaXYZ(prim, branco = D65) {
  const xyz = ([x, y]) => [x / y, 1, (1 - x - y) / y]
  const [R, G, B] = prim.map(xyz)
  const M = [
    [R[0], G[0], B[0]],
    [R[1], G[1], B[1]],
    [R[2], G[2], B[2]],
  ]
  const W = xyz(branco)
  const S = mult(inversa(M), W)
  return M.map((l) => l.map((v, j) => v * S[j]))
}
function inversa(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ]
}
function mult(m, v) {
  return m.map((l) => l[0] * v[0] + l[1] * v[1] + l[2] * v[2])
}
function multM(a, b) {
  return a.map((l) => [0, 1, 2].map((j) => l[0] * b[0][j] + l[1] * b[1][j] + l[2] * b[2][j]))
}
/** Matriz que leva RGB linear do gamut `de` para RGB linear Rec.709. */
export function matrizPara709(de) {
  if (de === 'rec709') return [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  return multM(inversa(rgbParaXYZ(GAMUTS.rec709)), rgbParaXYZ(GAMUTS[de]))
}

// ─────────── tela ───────────
/** Curva de filme (Narkowicz, aproximação do ACES): luz da cena → luz da tela, 0–1, sem estourar seco. */
export function curvaFilme(x) {
  const v = Math.max(0, x) * 0.6
  return Math.min(1, (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14))
}
const gama = (L) => Math.max(0, Math.min(1, L)) ** (1 / 2.4)

/** Um pixel (0–1) no perfil → Rec.709 (0–1). */
export function converter(perfil, r, g, b) {
  const p = PERFIS[perfil]
  if (!p?.curva) return [r, g, b]
  const curva = CURVAS[p.curva]
  const M = cacheMatriz(p.gamut)
  const lin = [curva(r), curva(g), curva(b)]
  const c = mult(M, lin)
  return c.map((x) => gama(curvaFilme(x)))
}
const matrizes = new Map()
function cacheMatriz(g) {
  if (!matrizes.has(g)) matrizes.set(g, matrizPara709(g))
  return matrizes.get(g)
}

/**
 * A LUT 3D do perfil: `n`³ entradas RGB (vermelho varia mais rápido, como no .cube e na textura 3D).
 * @returns {Float32Array} n*n*n*3
 */
export function gerarLut(perfil, n = 33) {
  const out = new Float32Array(n * n * n * 3)
  let k = 0
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) {
        const o = converter(perfil, r / (n - 1), g / (n - 1), b / (n - 1))
        out[k++] = o[0]
        out[k++] = o[1]
        out[k++] = o[2]
      }
  return out
}

/** A LUT em texto .cube (o ffmpeg lê com o filtro lut3d). */
export function cube(perfil, n = 33) {
  const lut = gerarLut(perfil, n)
  const linhas = [`TITLE "SOBEDESCE ${PERFIS[perfil]?.nome || perfil} para Rec.709"`, `LUT_3D_SIZE ${n}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1']
  for (let i = 0; i < lut.length; i += 3) linhas.push(`${lut[i].toFixed(6)} ${lut[i + 1].toFixed(6)} ${lut[i + 2].toFixed(6)}`)
  return `${linhas.join('\n')}\n`
}
