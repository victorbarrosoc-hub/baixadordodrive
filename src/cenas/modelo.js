// Busca por cena: o modelo que põe texto e imagem no mesmo espaço (CLIP ViT-B/32, com o texto multilíngue destilado
// do sentence-transformers, que entende português). Roda no computador, pelo onnxruntime-node: nada sai da máquina.
//
//   imagem 224×224 RGB ──▶ vision.onnx (CLIP, MIT) ──────────────────────────────────▶ 512 números
//   texto ──▶ texto.js (WordPiece) ──▶ text.onnx (DistilBERT multilíngue, Apache-2.0)
//         ──▶ média dos tokens ──▶ dense (768 → 512) ──────────────────────────────────▶ 512 números
//
// Os dois vetores saem normalizados (comprimento 1): a semelhança é o produto escalar.
import fs from 'node:fs/promises'
import { criarTokenizador } from './texto.js'

export const LADO = 224
export const DIM = 512
const MEDIA = [0.48145466, 0.4578275, 0.40821073]
const DESVIO = [0.26862954, 0.26130258, 0.27577711]

/** onnxruntime-node é opcional: sem ele (plataforma sem binário, ex.: Mac Intel), a busca fica indisponível. */
export async function carregarOrt() {
  try {
    return await import('onnxruntime-node')
  } catch {
    return null
  }
}

/** Lê um tensor F32 de um .safetensors (cabeçalho JSON de 8 bytes de tamanho + dados crus). */
export function lerSafetensors(buf, nome) {
  const n = Number(buf.readBigUInt64LE(0))
  const cab = JSON.parse(buf.subarray(8, 8 + n).toString('utf8'))
  const t = cab[nome] || Object.entries(cab).find(([k]) => k !== '__metadata__')?.[1]
  if (!t || t.dtype !== 'F32') throw new Error('dense: tensor F32 não encontrado')
  const [a, b] = t.data_offsets
  const bytes = buf.subarray(8 + n + a, 8 + n + b)
  const copia = new Float32Array(bytes.length / 4)
  for (let i = 0; i < copia.length; i++) copia[i] = bytes.readFloatLE(i * 4)
  return { dados: copia, forma: t.shape }
}

export function normalizarVetor(v) {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  const k = s > 0 ? 1 / Math.sqrt(s) : 0
  for (let i = 0; i < v.length; i++) v[i] *= k
  return v
}

/** RGB 224×224 (rgb24, como o ffmpeg entrega) → o que o CLIP espera: [3, 224, 224] normalizado. */
export function pixelsParaTensor(rgb, destino, deslocamento = 0) {
  const area = LADO * LADO
  for (let i = 0; i < area; i++) {
    for (let c = 0; c < 3; c++) destino[deslocamento + c * area + i] = (rgb[i * 3 + c] / 255 - MEDIA[c]) / DESVIO[c]
  }
  return destino
}

export class Modelo {
  /**
   * @param {object} o
   * @param {{ texto: string, visao: string, dense: string, tokenizador: string }} o.arquivos caminhos no disco
   * @param {object} [o.ort] onnxruntime (trocável nos testes)
   */
  constructor({ arquivos, ort, threads } = {}) {
    this.arquivos = arquivos
    this.ort = ort || null
    this.threads = threads
    this.pronto = null
  }

  async #abrir() {
    const ort = this.ort || (await carregarOrt())
    if (!ort) throw Object.assign(new Error('A busca por cena não roda neste computador.'), { codigo: 'sem-motor' })
    this.ort = ort
    const op = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', ...(this.threads ? { intraOpNumThreads: this.threads } : {}) }
    const [texto, visao, dense, tok] = await Promise.all([
      ort.InferenceSession.create(this.arquivos.texto, op),
      ort.InferenceSession.create(this.arquivos.visao, op),
      fs.readFile(this.arquivos.dense),
      fs.readFile(this.arquivos.tokenizador, 'utf8'),
    ])
    const d = lerSafetensors(dense, 'linear.weight')
    if (d.forma[0] !== DIM) throw new Error('dense com tamanho inesperado')
    return { texto, visao, dense: d.dados, entrada: d.forma[1], tokenizador: criarTokenizador(JSON.parse(tok)) }
  }

  abrir() {
    if (!this.pronto) this.pronto = this.#abrir().catch((err) => {
      this.pronto = null
      throw err
    })
    return this.pronto
  }

  /** Texto → vetor de 512 (normalizado). */
  async texto(frase) {
    const m = await this.abrir()
    const ids = m.tokenizador.codificar(frase)
    const n = ids.length
    const T = this.ort.Tensor
    const out = await m.texto.run({
      input_ids: new T('int64', BigInt64Array.from(ids, (x) => BigInt(x)), [1, n]),
      attention_mask: new T('int64', new BigInt64Array(n).fill(1n), [1, n]),
    })
    const h = out.last_hidden_state.data // [1, n, 768]
    const larg = m.entrada
    const media = new Float32Array(larg)
    for (let t = 0; t < n; t++) for (let j = 0; j < larg; j++) media[j] += h[t * larg + j]
    for (let j = 0; j < larg; j++) media[j] /= n
    const v = new Float32Array(DIM)
    for (let i = 0; i < DIM; i++) {
      let s = 0
      const lin = i * larg
      for (let j = 0; j < larg; j++) s += m.dense[lin + j] * media[j]
      v[i] = s
    }
    return normalizarVetor(v)
  }

  /** Várias imagens RGB 224×224 (Buffer/Uint8Array cada) → um vetor de 512 por imagem (normalizados). */
  async imagens(lista) {
    if (!lista.length) return []
    const m = await this.abrir()
    const area = 3 * LADO * LADO
    const px = new Float32Array(lista.length * area)
    lista.forEach((rgb, i) => pixelsParaTensor(rgb, px, i * area))
    const out = await m.visao.run({ pixel_values: new this.ort.Tensor('float32', px, [lista.length, 3, LADO, LADO]) })
    const e = out.image_embeds.data
    return lista.map((_, i) => normalizarVetor(Float32Array.from(e.subarray(i * DIM, (i + 1) * DIM))))
  }

  async fechar() {
    const m = await this.pronto?.catch(() => null)
    this.pronto = null
    await Promise.all([m?.texto?.release?.(), m?.visao?.release?.()].filter(Boolean)).catch(() => {})
  }
}

/** Semelhança (os dois normalizados): de -1 a 1; no CLIP, uma boa resposta costuma passar de 0,25. */
export function semelhanca(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
