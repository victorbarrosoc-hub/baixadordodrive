// Frames: o bom senso na escolha (a mesma cópia roda no celular: web/public/app/lib/frames/escolha.js). Regras (docs/FRAMES.md):
//   - nada de tela preta, branca, estourada ou fechada demais;
//   - nada de quadro tremido ou desfocado (nitidez abaixo do normal da própria cena);
//   - nada perto de corte, transição ou fusão (as primeiras e últimas amostras de cada cena e os saltos de imagem);
//   - nada repetido (impressão digital parecida com um já escolhido);
//   - espalhado pelo filme: cada cena ganha frames na medida do tempo dela, e dentro dela, espaçados.
import { distanciaHash } from './medidas.js'

const PERTO_DO_CORTE_S = 0.35
const HASH_IGUAL = 10 // de 64 bits: abaixo disso, é praticamente a mesma imagem
const HASH_PERTO = 4 // abaixo disso, é a mesma imagem mesmo

/**
 * Nitidez de referência de cada amostra: a da própria cena (um plano suave, de neblina ou de foco raso, não perde para
 * o plano mais nítido do filme), mas sem descer a menos de 1/4 da do filme inteiro (cena toda fora de foco não vale).
 */
export function refPorCena(amostras, cenas) {
  const global = pct(amostras.map((a) => a.nitidez), 0.75)
  const ref = new Float64Array(amostras.length).fill(global)
  for (const c of cenas) {
    const daCena = pct(amostras.slice(c.de, c.ate + 1).map((a) => a.nitidez), 0.75)
    const r = Math.max(daCena, global / 4)
    for (let k = c.de; k <= c.ate; k++) ref[k] = r
  }
  return ref
}

/** Nota de 0 a 1 de uma amostra para virar frame (0 = não serve). */
export function nota(a, refNitidez, difNormal) {
  if (a.media < 22 || a.media > 238) return 0 // preto ou branco
  if (a.escuros > 0.82 || a.estourados > 0.45) return 0 // cena de noite e low-key ainda vale; tela fechada não
  if (a.desvio < 9) return 0 // chapado (fusão, tela lisa, letreiro em fundo liso)
  const nit = Math.min(1.3, a.nitidez / Math.max(1, refNitidez))
  if (nit < 0.35) return 0 // desfocado ou tremido
  const exposicao = 1 - Math.min(1, Math.abs(a.media - 118) / 140) - Math.min(0.5, a.estourados + a.escuros * 0.6)
  const movimento = a.dif > difNormal * 2.5 ? 0.45 : a.dif > difNormal * 1.6 ? 0.75 : 1
  const contraste = Math.min(1, a.desvio / 48)
  return Math.max(0, nit * 0.55 + exposicao * 0.25 + contraste * 0.2) * movimento
}

const pct = (xs, p) => {
  const o = xs.slice().sort((a, b) => a - b)
  return o[Math.min(o.length - 1, Math.floor(o.length * p))] ?? 0
}

/** Reparte `n` entre as cenas pelo tempo de cada uma (raiz quadrada: cena longa ganha mais, sem engolir as curtas). */
function repartir(cenas, n) {
  const pesos = cenas.map((c) => (c.ok ? Math.sqrt(c.fim - c.ini) : 0))
  const total = pesos.reduce((s, x) => s + x, 0)
  if (!total) return cenas.map(() => 0)
  const out = pesos.map((p) => Math.floor((p / total) * n))
  // Cada cena que serve ganha pelo menos 1 quando dá.
  if (n >= cenas.filter((c) => c.ok).length) cenas.forEach((c, i) => c.ok && !out[i] && (out[i] = 1))
  let sobra = n - out.reduce((s, x) => s + x, 0)
  const ordem = pesos.map((p, i) => ({ i, r: (p / total) * n - out[i] })).sort((a, b) => b.r - a.r)
  for (let k = 0; sobra > 0 && k < ordem.length * 4; k++) {
    const { i } = ordem[k % ordem.length]
    if (!pesos[i]) continue
    out[i]++
    sobra--
  }
  while (sobra < 0) {
    const i = out.indexOf(Math.max(...out))
    out[i]--
    sobra++
  }
  return out
}

/**
 * Escolhe `quantidade` frames.
 * @returns {{ frames: { t, cena, nota, amostra }[], descartes: Record<string, number> }}
 */
export function escolherFrames({ amostras, cenas, passo }, quantidade) {
  const ref = refPorCena(amostras, cenas)
  const difNormal = Math.max(2, pct(amostras.map((a) => a.dif), 0.5))
  const margem = Math.ceil(PERTO_DO_CORTE_S / passo)
  const descartes = { escuro_ou_estourado: 0, desfocado_ou_tremido: 0, transicao: 0, repetido: 0 }
  const notas = amostras.map((a, k) => nota(a, ref[k], difNormal))
  for (const c of cenas) {
    c.candidatos = []
    for (let k = c.de; k <= c.ate; k++) {
      const a = amostras[k]
      if (k - c.de < margem || c.ate - k < margem) {
        descartes.transicao++
        continue
      }
      if (!notas[k]) {
        if (a.media < 22 || a.media > 238 || a.escuros > 0.82 || a.estourados > 0.45) descartes.escuro_ou_estourado++
        else descartes.desfocado_ou_tremido++
        continue
      }
      c.candidatos.push(k)
    }
    c.ok = c.candidatos.length > 0
  }
  const porCena = repartir(cenas, quantidade)
  const escolhidos = []
  const parecido = (k) => escolhidos.some((e) => distanciaHash(amostras[e.amostra].hash, amostras[k].hash) < HASH_IGUAL)
  cenas.forEach((c, ci) => {
    let quer = porCena[ci]
    if (!quer) return
    // Divide a cena em `quer` trechos e pega o melhor de cada trecho (espalhado), sem repetir.
    const cand = c.candidatos
    for (let parte = 0; parte < quer && cand.length; parte++) {
      const ini = Math.floor((parte * cand.length) / quer)
      const fim = Math.max(ini + 1, Math.floor(((parte + 1) * cand.length) / quer))
      const trecho = cand.slice(ini, fim).sort((a, b) => notas[b] - notas[a])
      const k = trecho.find((x) => !parecido(x))
      if (k == null) {
        descartes.repetido++
        continue
      }
      escolhidos.push({ t: amostras[k].t + passo / 2, cena: c.i, nota: notas[k], amostra: k })
    }
  })
  // Faltou (cenas repetidas, curtas): completa com os melhores que sobraram, em qualquer cena, sem repetir. Se ainda
  // faltar (plano longo e parecido), aceita os só um pouco diferentes, a mais de 1 s dos outros. Qualidade não cede.
  const resto = cenas.flatMap((c) => c.candidatos.map((k) => ({ k, c: c.i }))).sort((a, b) => notas[b.k] - notas[a.k])
  for (const minimo of [HASH_IGUAL, HASH_PERTO]) {
    for (const { k, c } of resto) {
      if (escolhidos.length >= quantidade) break
      if (escolhidos.some((e) => e.amostra === k || Math.abs(amostras[e.amostra].t - amostras[k].t) < (minimo === HASH_IGUAL ? 0 : 1))) continue
      if (escolhidos.some((e) => distanciaHash(amostras[e.amostra].hash, amostras[k].hash) < minimo)) continue
      escolhidos.push({ t: amostras[k].t + passo / 2, cena: c, nota: notas[k], amostra: k })
    }
  }
  escolhidos.sort((a, b) => a.t - b.t)
  return { frames: escolhidos, descartes }
}

/**
 * Takes: em cada cena, a janela de `duracao` segundos com a melhor nota média (longe dos cortes). Cena mais curta que
 * a janela vira um take do tamanho dela (se tiver pelo menos 1,5 s útil). Primeiro um por cena (os melhores); se a
 * pessoa pediu mais, as cenas longas ganham outros trechos que não encostam nos já escolhidos.
 * @returns {{ ini: number, dur: number, cena: number, nota: number }[]}
 */
export function escolherTakes({ amostras, cenas, passo }, { quantidade, duracao }) {
  const ref = refPorCena(amostras, cenas)
  const difNormal = Math.max(2, pct(amostras.map((a) => a.dif), 0.5))
  const notas = amostras.map((a, k) => nota(a, ref[k], difNormal))
  const margem = Math.ceil(PERTO_DO_CORTE_S / passo)
  const folga = Math.ceil(0.5 / passo)
  const janelas = [] // todas as janelas boas: { de, ate, cena, nota }
  for (const c of cenas) {
    const de = c.de + margem
    const ate = c.ate - margem
    if ((ate - de + 1) * passo < 1.5) continue
    const n = Math.max(1, Math.min(ate - de + 1, Math.round(duracao / passo)))
    let soma = 0
    for (let k = de; k <= ate; k++) {
      soma += notas[k]
      if (k - de >= n) soma -= notas[k - n]
      if (k - de + 1 >= n && soma / n >= 0.2) janelas.push({ de: k - n + 1, ate: k, cena: c.i, nota: soma / n })
    }
  }
  janelas.sort((a, b) => b.nota - a.nota)
  const escolhidas = []
  const livre = (j) => escolhidas.every((e) => j.ate + folga < e.de || j.de > e.ate + folga)
  // Um por cena (cena que não serve, preta, desfocada ou tremida do começo ao fim, não tem janela).
  for (const j of janelas) {
    if (escolhidas.length >= quantidade) break
    if (!escolhidas.some((e) => e.cena === j.cena)) escolhidas.push(j)
  }
  // Mais trechos das cenas longas.
  for (const j of janelas) {
    if (escolhidas.length >= quantidade) break
    if (livre(j)) escolhidas.push(j)
  }
  return escolhidas
    .map((j) => ({ ini: amostras[j.de].t, dur: Math.min(duracao, (j.ate - j.de + 1) * passo), cena: j.cena, nota: j.nota }))
    .sort((a, b) => a.ini - b.ini)
}

/** Etiquetas automáticas de uma cena (a pessoa troca pelo nome que quiser). */
export function etiquetas(amostras, cena) {
  const xs = amostras.slice(cena.de, cena.ate + 1)
  const semCorte = xs.length > 1 ? xs.slice(1) : xs // a primeira amostra carrega o salto do corte
  const m = (f) => xs.reduce((s, a) => s + f(a), 0) / Math.max(1, xs.length)
  const tags = []
  const luz = m((a) => a.media)
  tags.push(luz < 70 ? 'Escuro' : luz > 165 ? 'Claro' : 'Meio-tom')
  const sat = m((a) => a.saturacao)
  if (sat < 0.08) tags.push('P&B')
  else {
    const calor = m((a) => a.calor)
    tags.push(calor > 14 ? 'Quente' : calor < -10 ? 'Frio' : 'Neutro')
  }
  const mov = semCorte.reduce((s, a) => s + a.dif, 0) / semCorte.length
  tags.push(mov > 9 ? 'Movimento' : mov < 2.5 ? 'Parado' : 'Calmo')
  return tags
}
