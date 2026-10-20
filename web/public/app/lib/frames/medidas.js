// Frames: as medidas de uma amostra (nitidez, exposição, cor, impressão digital) e o corte de cenas. Sem nada de
// Node: a mesma cópia roda no celular (web/public/app/lib/frames/medidas.js, igual byte a byte; test/frames.test.js
// confere).

function luma(r, g, b) {
  return (r * 77 + g * 150 + b * 29) >> 8
}

/** Métricas de uma amostra (RGB `w`×`h`). */
export function medir(rgb, w, h) {
  const n = w * h
  const y = new Uint8Array(n)
  let soma = 0
  let soma2 = 0
  let escuros = 0
  let estourados = 0
  let quente = 0
  let sat = 0
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const r = rgb[p]
    const g = rgb[p + 1]
    const b = rgb[p + 2]
    const l = luma(r, g, b)
    y[i] = l
    soma += l
    soma2 += l * l
    if (l < 12) escuros++
    else if (l > 245) estourados++
    quente += r - b
    const mx = Math.max(r, g, b)
    sat += mx ? (mx - Math.min(r, g, b)) / mx : 0
  }
  const media = soma / n
  const desvio = Math.sqrt(Math.max(0, soma2 / n - media * media))
  // Nitidez: variância do Laplaciano (4 vizinhos) no miolo.
  let ls = 0
  let ls2 = 0
  let k = 0
  for (let yy = 1; yy < h - 1; yy++) {
    for (let x = 1; x < w - 1; x++) {
      const i = yy * w + x
      const lap = 4 * y[i] - y[i - 1] - y[i + 1] - y[i - w] - y[i + w]
      ls += lap
      ls2 += lap * lap
      k++
    }
  }
  const nitidez = ls2 / k - (ls / k) ** 2
  // dHash 64 bits (9×8 de médias), em dois inteiros de 32.
  const hash = [0, 0]
  const cw = w / 9
  const ch = h / 8
  const cel = (cx, cy) => {
    let s = 0
    let c = 0
    for (let yy = Math.floor(cy * ch); yy < Math.floor((cy + 1) * ch); yy++)
      for (let x = Math.floor(cx * cw); x < Math.floor((cx + 1) * cw); x++) {
        s += y[yy * w + x]
        c++
      }
    return c ? s / c : 0
  }
  let bit = 0
  for (let cy = 0; cy < 8; cy++) {
    let ant = cel(0, cy)
    for (let cx = 1; cx < 9; cx++) {
      const v = cel(cx, cy)
      if (v > ant) hash[bit >> 5] |= 1 << (bit & 31)
      ant = v
      bit++
    }
  }
  return {
    y,
    media,
    desvio,
    nitidez,
    escuros: escuros / n,
    estourados: estourados / n,
    calor: quente / n, // > 0 quente, < 0 frio
    saturacao: sat / n,
    hash,
  }
}

export function distanciaHash(a, b) {
  let d = 0
  for (let i = 0; i < 2; i++) {
    let x = (a[i] ^ b[i]) >>> 0
    while (x) {
      x &= x - 1
      d++
    }
  }
  return d
}

export function diferenca(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return s / a.length
}

/**
 * Cenas: corte onde a imagem muda de uma vez (diferença bem acima do normal do vídeo). Cena curta demais (< 0,6 s)
 * junta com a vizinha. Devolve [{ i, ini, fim, de, ate }] (de/ate = índices das amostras).
 */
export function cenas(amostras, passo) {
  if (!amostras.length) return []
  const difs = amostras.map((a) => a.dif).slice(1)
  const ord = difs.slice().sort((a, b) => a - b)
  const mediana = ord[Math.floor(ord.length / 2)] || 0
  const p90 = ord[Math.floor(ord.length * 0.9)] || 0
  const limiar = Math.max(18, mediana * 4, p90 * 1.6)
  const cortes = [0]
  for (let k = 1; k < amostras.length; k++) {
    const a = amostras[k]
    // Corte: salto grande e isolado (o vizinho seguinte não continua mudando tanto = não é só movimento).
    // Ou a luz/cor mudou de uma vez (corte para uma cena de muito movimento, onde o vizinho também muda muito).
    const prox = amostras[k + 1]?.dif ?? 0
    const ant = amostras[k - 1]
    const depois = amostras[k + 1] ?? a
    const mudouCor = Math.abs(a.media - ant.media) > 14 && Math.abs(depois.media - ant.media) > 14 || Math.abs(a.saturacao - ant.saturacao) > 0.14 && Math.abs(depois.saturacao - ant.saturacao) > 0.14 || Math.abs(a.calor - ant.calor) > 18 && Math.abs(depois.calor - ant.calor) > 18
    if ((a.dif > limiar && a.dif > prox * 1.5) || (mudouCor && a.dif > Math.max(18, limiar * 0.5))) cortes.push(k)
  }
  const min = Math.ceil(0.6 / passo)
  const limpos = [0]
  for (const c of cortes.slice(1)) {
    if (c - limpos[limpos.length - 1] >= min) limpos.push(c)
  }
  const out = []
  for (let i = 0; i < limpos.length; i++) {
    const de = limpos[i]
    const ate = (limpos[i + 1] ?? amostras.length) - 1
    if (ate - de + 1 < min && out.length) {
      out[out.length - 1].ate = ate
      out[out.length - 1].fim = (ate + 1) * passo
      continue
    }
    out.push({ i: out.length, de, ate, ini: de * passo, fim: (ate + 1) * passo })
  }
  return out.map((c, i) => ({ ...c, i }))
}
