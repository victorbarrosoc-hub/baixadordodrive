// Busca por cena: o índice de um vídeo. Amostras (um vetor do modelo a cada poucos segundos) viram trechos: amostras
// seguidas parecidas são o mesmo plano/cena e viram um trecho só, com o vetor médio e a amostra mais típica como
// miniatura. Os vetores ficam em 8 bits (512 bytes cada), o bastante para comparar e leve para guardar e subir.
import { DIM, normalizarVetor, semelhanca } from './modelo.js'

export const VERSAO = 1
const JUNTA = 0.9 // semelhança entre amostras seguidas para ainda ser o mesmo trecho
const MAX_TRECHO_S = 20 // trecho longo demais (plano parado de festa) se divide: ajuda a achar o momento

/**
 * @param {{ t: number, v: Float32Array }[]} amostras em ordem de tempo
 * @param {number} passo segundos entre amostras
 * @returns {{ ini: number, fim: number, t: number, v: Float32Array }[]} t = a amostra que melhor representa o trecho
 */
export function trechos(amostras, passo, { junta = JUNTA, maxS = MAX_TRECHO_S } = {}) {
  const out = []
  let grupo = []
  const fechar = () => {
    if (!grupo.length) return
    const media = new Float32Array(DIM)
    for (const a of grupo) for (let i = 0; i < DIM; i++) media[i] += a.v[i]
    normalizarVetor(media)
    let melhor = grupo[0]
    let ms = -2
    for (const a of grupo) {
      const s = semelhanca(a.v, media)
      if (s > ms) [ms, melhor] = [s, a]
    }
    out.push({ ini: grupo[0].t, fim: grupo.at(-1).t + passo, t: melhor.t, v: media })
    grupo = []
  }
  for (const a of amostras) {
    const ant = grupo.at(-1)
    if (ant && (semelhanca(ant.v, a.v) < junta || a.t - grupo[0].t >= maxS)) fechar()
    grupo.push(a)
  }
  fechar()
  return out
}

/** Float32 normalizado → Int8 (×127). */
export function quantizar(v) {
  const q = new Int8Array(v.length)
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i] * 127)))
  return q
}

/** Int8 de volta para Float32 normalizado. */
export function desquantizar(q) {
  return normalizarVetor(Float32Array.from(q, (x) => x / 127))
}

/** O índice de um vídeo, pronto para JSON (vetores em base64). */
export function empacotar({ arquivo, origem, duracao, passo, trechos: ts }) {
  const bytes = new Int8Array(ts.length * DIM)
  ts.forEach((t, i) => bytes.set(quantizar(t.v), i * DIM))
  return {
    versao: VERSAO,
    modelo: 'clip-vit-b32-multilingual-v1',
    arquivo,
    origem,
    duracao,
    passo,
    trechos: ts.map((t) => ({ ini: round(t.ini), fim: round(t.fim), t: round(t.t) })),
    vetores: Buffer.from(bytes.buffer).toString('base64'),
  }
}

const round = (x) => Math.round(x * 100) / 100

/** JSON do índice → trechos com os vetores (Float32) para buscar. Devolve null se o formato não serve. */
export function desempacotar(j) {
  if (!j || j.versao !== VERSAO || !Array.isArray(j.trechos) || typeof j.vetores !== 'string') return null
  const bytes = Buffer.from(j.vetores, 'base64')
  if (bytes.length !== j.trechos.length * DIM) return null
  const q = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length)
  return { ...j, trechos: j.trechos.map((t, i) => ({ ...t, v: desquantizar(q.subarray(i * DIM, (i + 1) * DIM)) })) }
}

/**
 * Busca em vários índices: os trechos mais parecidos com o texto, do melhor para o pior. `nota` vai de 0 a 1 (a
 * semelhança crua do CLIP fica entre ~0,15 e ~0,35; a nota abre essa faixa para a tela).
 * @param {Float32Array} q vetor do texto
 * @param {{ arquivo: object, trechos: { ini, fim, t, v }[] }[]} indices
 */
export function buscar(q, indices, { limite = 60, porArquivo = 12 } = {}) {
  const todos = []
  for (const ind of indices) {
    const deste = ind.trechos.map((t, i) => ({ arquivo: ind.arquivo, i, ini: t.ini, fim: t.fim, t: t.t, s: semelhanca(q, t.v) }))
    deste.sort((a, b) => b.s - a.s)
    todos.push(...deste.slice(0, porArquivo))
  }
  todos.sort((a, b) => b.s - a.s)
  const top = todos.slice(0, limite)
  return top.map((r) => ({ ...r, s: round3(r.s), nota: round3(Math.max(0, Math.min(1, (r.s - 0.15) / 0.2))) }))
}

const round3 = (x) => Math.round(x * 1000) / 1000
