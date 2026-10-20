// Reconhecer quadros de vídeo nos dados soltos de um clipe sem índice (Resgate, docs/CARTOES.md §7.3): H.264 e H.265
// guardados com o tamanho na frente de cada NAL (formato MP4), e ProRes (cada quadro começa com o tamanho e "icpf").
// Só lê cabeçalhos, nunca decodifica imagem.

const u32 = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]

function lerTamanho(b, p, n) {
  if (n === 4) return u32(b, p)
  if (n === 2) return (b[p] << 8) | b[p + 1]
  if (n === 1) return b[p]
  return ((b[p] << 16) | (b[p + 1] << 8) | b[p + 2]) >>> 0
}

/** Primeiro bit do RBSP depois do cabeçalho é 1 = Exp-Golomb 0 (first_mb_in_slice = 0 / começa a imagem). */
const primeiroBit = (b, p) => (b[p] & 0x80) !== 0

/** Lê um ue(v) (Exp-Golomb) a partir do bit `bit` de `b[p…]`; devolve { v, bit } ou null. */
function ue(b, p, bit, fim) {
  let zeros = 0
  const lerBit = () => {
    const byte = p + (bit >> 3)
    if (byte >= fim) return -1
    const v = (b[byte] >> (7 - (bit & 7))) & 1
    bit++
    return v
  }
  for (;;) {
    const v = lerBit()
    if (v < 0 || zeros > 31) return null
    if (v === 1) break
    zeros++
  }
  let x = 0
  for (let i = 0; i < zeros; i++) {
    const v = lerBit()
    if (v < 0) return null
    x = x * 2 + v
  }
  return { v: 2 ** zeros - 1 + x, bit }
}

// ───── H.264 ─────

function nalAvcOk(h) {
  if (h & 0x80) return false
  const tipo = h & 31
  const ref = (h >> 5) & 3
  if (tipo === 0 || (tipo >= 16 && tipo <= 18) || tipo >= 22) return false
  if ((tipo === 5 || tipo === 7 || tipo === 8) && ref === 0) return false
  if ((tipo === 6 || tipo === 9 || tipo === 10 || tipo === 11 || tipo === 12) && ref !== 0) return false
  return true
}

const SLICE_AVC = (t) => t === 1 || t === 5
const NOVO_AU_AVC = (t) => t === 9 || t === 7 || t === 8 || t === 6 || (t >= 13 && t <= 18)

// ───── H.265 ─────

function nalHevcOk(h0, h1) {
  if (h0 & 0x80) return false
  const tipo = (h0 >> 1) & 63
  const camada = ((h0 & 1) << 5) | (h1 >> 3)
  const tid = h1 & 7
  if (camada !== 0 || tid === 0) return false
  return tipo <= 9 || (tipo >= 16 && tipo <= 21) || (tipo >= 32 && tipo <= 40)
}

const SLICE_HEVC = (t) => t <= 9 || (t >= 16 && t <= 21)
const NOVO_AU_HEVC = (t) => (t >= 32 && t <= 35) || t === 39

/**
 * O começo do cabeçalho da fatia faz sentido? H.264: first_mb = 0, slice_type 0–9, pps_id pequeno. H.265:
 * first_slice_segment_in_pic = 1 e pps_id pequeno. Corta a maioria dos falsos positivos em dado qualquer (áudio AAC).
 */
function cabecalhoFatiaOk(b, p, fim, hevc, tipo) {
  if (hevc) {
    let bit = 1 // first_slice_segment_in_pic_flag (já conferido = 1)
    if (tipo >= 16 && tipo <= 23) bit++ // no_output_of_prior_pics_flag
    const pps = ue(b, p, bit, fim)
    return Boolean(pps && pps.v <= 7)
  }
  const st = ue(b, p, 1, fim)
  if (!st || st.v > 9) return false
  const pps = ue(b, p, st.bit, fim)
  return Boolean(pps && pps.v <= 7)
}

/**
 * Um quadro (access unit) de H.264/H.265 começando em `p`: { tam, chave, nals } ou null.
 * `nal` = tamanho do campo de comprimento (avcC/hvcC). `hevc` = H.265. Para no início do próximo quadro ou quando os
 * bytes deixam de ser NAL (fim do pedaço de vídeo).
 */
export function quadroNal(b, p, fim, { nal = 4, hevc = false } = {}) {
  let q = p
  let viuSlice = false
  let chave = false
  let nals = 0
  const hdr = hevc ? 2 : 1
  while (q + nal + hdr <= fim) {
    const len = lerTamanho(b, q, nal)
    if (len < hdr + 1 || q + nal + len > fim) break
    const h0 = b[q + nal]
    const h1 = b[q + nal + 1]
    let tipo
    if (hevc) {
      if (!nalHevcOk(h0, h1)) break
      tipo = (h0 >> 1) & 63
    } else {
      if (!nalAvcOk(h0)) break
      tipo = h0 & 31
    }
    const corpo = q + nal + hdr
    const slice = hevc ? SLICE_HEVC(tipo) : SLICE_AVC(tipo)
    const comeca = slice && primeiroBit(b, corpo)
    if (viuSlice && ((hevc ? NOVO_AU_HEVC(tipo) : NOVO_AU_AVC(tipo)) || comeca)) break
    if (!viuSlice && slice && !comeca) return null // quadro tem que começar pelo primeiro pedaço da imagem
    if (slice && !viuSlice && !cabecalhoFatiaOk(b, corpo, Math.min(fim, corpo + 16), hevc, tipo)) return null
    if (slice) {
      viuSlice = true
      if (hevc) chave ||= tipo >= 16 && tipo <= 21
      else if (tipo === 5) chave = true
      else {
        // slice_type: depois de first_mb_in_slice (= 0, um bit "1"); 2 ou 7 = I.
        const st = ue(b, corpo, 1, Math.min(fim, corpo + 8))
        if (st && (st.v === 2 || st.v === 7)) chave = true
      }
    }
    q += nal + len
    nals++
  }
  if (!viuSlice) return null
  return { tam: q - p, chave, nals }
}

/** NALs de parâmetros (SPS/PPS/VPS) dentro de um quadro, para comparar com os da referência. */
export function parametrosNoQuadro(b, p, tam, { nal = 4, hevc = false } = {}) {
  const out = []
  let q = p
  while (q + nal < p + tam) {
    const len = lerTamanho(b, q, nal)
    const h0 = b[q + nal]
    const tipo = hevc ? (h0 >> 1) & 63 : h0 & 31
    if (hevc ? tipo >= 32 && tipo <= 34 : tipo === 7 || tipo === 8) out.push({ tipo, dados: b.subarray(q + nal, q + nal + len) })
    q += nal + len
  }
  return out
}

// ───── ProRes ─────

export const PRORES = new Set(['apcn', 'apch', 'apcs', 'apco', 'ap4h', 'ap4x'])

/** Quadro de ProRes em `p`: { tam, chave: true } ou null. */
export function quadroProRes(b, p, fim) {
  if (p + 8 > fim) return null
  const tam = u32(b, p)
  if (b[p + 4] !== 0x69 || b[p + 5] !== 0x63 || b[p + 6] !== 0x70 || b[p + 7] !== 0x66) return null // 'icpf'
  if (tam < 28 || p + tam > fim) return null
  return { tam, chave: true }
}
