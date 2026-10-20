// Ordem de exibição dos quadros (POC) de H.264 e H.265, lida do cabeçalho de cada fatia, para remontar a tabela de
// deslocamentos (ctts) de quem grava com B-frames. Lê SPS/PPS do avcC/hvcC da referência e os que vierem dentro do
// próprio vídeo. Só cabeçalhos: nada de decodificar imagem.

/** RBSP: tira os bytes de prevenção (00 00 03 → 00 00) dos primeiros `max` bytes. */
function rbsp(b, ini, fim, max = 256) {
  const out = []
  let zeros = 0
  for (let i = ini; i < fim && out.length < max; i++) {
    const x = b[i]
    if (zeros >= 2 && x === 3) {
      zeros = 0
      continue
    }
    out.push(x)
    zeros = x === 0 ? zeros + 1 : 0
  }
  return Uint8Array.from(out)
}

class Bits {
  constructor(b) {
    this.b = b
    this.i = 0
  }
  u(n) {
    let v = 0
    for (let k = 0; k < n; k++) {
      const byte = this.b[this.i >> 3]
      if (byte === undefined) throw new Error('fim')
      v = v * 2 + ((byte >> (7 - (this.i & 7))) & 1)
      this.i++
    }
    return v
  }
  ue() {
    let z = 0
    while (this.u(1) === 0) if (++z > 31) throw new Error('ue')
    return 2 ** z - 1 + this.u(z)
  }
  se() {
    const k = this.ue()
    return k & 1 ? (k + 1) / 2 : -(k / 2)
  }
}

// ───── H.264 ─────

const ALTOS = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135])

function spsAvc(nal) {
  const r = new Bits(rbsp(nal, 1, nal.length))
  const perfil = r.u(8)
  r.u(16)
  const id = r.ue()
  let separado = 0
  if (ALTOS.has(perfil)) {
    const croma = r.ue()
    if (croma === 3) separado = r.u(1)
    r.ue()
    r.ue()
    r.u(1)
    if (r.u(1)) {
      for (let i = 0; i < (croma !== 3 ? 8 : 12); i++) {
        if (!r.u(1)) continue
        let ultimo = 8
        let prox = 8
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (prox !== 0) prox = (ultimo + r.se() + 256) % 256
          ultimo = prox === 0 ? ultimo : prox
        }
      }
    }
  }
  const log2Frame = r.ue() + 4
  const tipoPoc = r.ue()
  let log2Poc = 0
  if (tipoPoc === 0) log2Poc = r.ue() + 4
  else if (tipoPoc === 1) {
    r.u(1)
    r.se()
    r.se()
    for (let i = 0, n = r.ue(); i < n; i++) r.se()
  }
  r.ue()
  r.u(1)
  r.ue()
  r.ue()
  const soQuadros = r.u(1)
  return { id, separado, log2Frame, tipoPoc, log2Poc, soQuadros }
}

function ppsAvc(nal) {
  const r = new Bits(rbsp(nal, 1, nal.length, 16))
  return { id: r.ue(), sps: r.ue() }
}

// ───── H.265 ─────

function perfilTierNivel(r, maxSub) {
  r.u(2 + 1 + 5 + 32 + 4 + 43 + 1 + 8) // geral: 96 bits
  const presente = []
  for (let i = 0; i < maxSub; i++) presente.push([r.u(1), r.u(1)])
  if (maxSub > 0) for (let i = maxSub; i < 8; i++) r.u(2)
  for (const [perfil, nivel] of presente) {
    if (perfil) r.u(88)
    if (nivel) r.u(8)
  }
}

function spsHevc(nal) {
  const r = new Bits(rbsp(nal, 2, nal.length))
  r.u(4)
  const maxSub = r.u(3)
  r.u(1)
  perfilTierNivel(r, maxSub)
  const id = r.ue()
  const croma = r.ue()
  let separado = 0
  if (croma === 3) separado = r.u(1)
  r.ue()
  r.ue()
  if (r.u(1)) (r.ue(), r.ue(), r.ue(), r.ue())
  r.ue()
  r.ue()
  const log2Poc = r.ue() + 4
  return { id, separado, log2Poc }
}

function ppsHevc(nal) {
  const r = new Bits(rbsp(nal, 2, nal.length, 16))
  const id = r.ue()
  const sps = r.ue()
  r.u(1) // dependent_slice_segments_enabled
  const saida = r.u(1)
  const extras = r.u(3)
  return { id, sps, saida, extras }
}

// ───── parâmetros a partir da configuração (avcC/hvcC) ─────

function nalsDoAvcC(c) {
  const out = []
  let p = 5
  const nSps = c[p++] & 31
  for (let i = 0; i < nSps; i++) {
    const len = (c[p] << 8) | c[p + 1]
    out.push(c.subarray(p + 2, p + 2 + len))
    p += 2 + len
  }
  const nPps = c[p++]
  for (let i = 0; i < nPps; i++) {
    const len = (c[p] << 8) | c[p + 1]
    out.push(c.subarray(p + 2, p + 2 + len))
    p += 2 + len
  }
  return out
}

function nalsDoHvcC(c) {
  const out = []
  let p = 22
  const arrays = c[p++]
  for (let a = 0; a < arrays; a++) {
    p++
    const n = (c[p] << 8) | c[p + 1]
    p += 2
    for (let i = 0; i < n; i++) {
      const len = (c[p] << 8) | c[p + 1]
      out.push(c.subarray(p + 2, p + 2 + len))
      p += 2 + len
    }
  }
  return out
}

const lerTam = (b, p, n) => (n === 4 ? ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3] : n === 2 ? (b[p] << 8) | b[p + 1] : b[p])

/**
 * Lê a ordem de exibição de cada quadro, na ordem em que eles aparecem no arquivo.
 * `quadro()` devolve { grupo, poc } (grupo muda a cada IDR) ou null se não deu para ler.
 */
export class OrdemExibicao {
  constructor({ hevc, config, nal = 4 }) {
    this.hevc = hevc
    this.nal = nal
    this.sps = new Map()
    this.pps = new Map()
    this.grupo = 0
    this.prevMsb = 0
    this.prevLsb = 0
    this.primeiro = true
    this.falhou = false
    try {
      for (const n of hevc ? nalsDoHvcC(config) : nalsDoAvcC(config)) this.#param(n)
    } catch {
      this.falhou = true
    }
  }

  #param(n) {
    if (this.hevc) {
      const t = (n[0] >> 1) & 63
      if (t === 33) {
        const s = spsHevc(n)
        this.sps.set(s.id, s)
      } else if (t === 34) {
        const p = ppsHevc(n)
        this.pps.set(p.id, p)
      }
    } else {
      const t = n[0] & 31
      if (t === 7) {
        const s = spsAvc(n)
        this.sps.set(s.id, s)
      } else if (t === 8) {
        const p = ppsAvc(n)
        this.pps.set(p.id, p)
      }
    }
  }

  /** Quadro em `b[p, p+tam)`. */
  quadro(b, p, tam) {
    try {
      let q = p
      while (q + this.nal < p + tam) {
        const len = lerTam(b, q, this.nal)
        const ini = q + this.nal
        const fim = ini + len
        const tipo = this.hevc ? (b[ini] >> 1) & 63 : b[ini] & 31
        if (this.hevc ? tipo >= 32 && tipo <= 34 : tipo === 7 || tipo === 8) this.#param(b.subarray(ini, fim))
        else if (this.hevc ? tipo <= 21 && (tipo <= 9 || tipo >= 16) : tipo === 1 || tipo === 5) {
          return this.hevc ? this.#fatiaHevc(b, ini, fim, tipo) : this.#fatiaAvc(b, ini, fim, tipo)
        }
        q = fim
      }
    } catch {
      // cai no null
    }
    return null
  }

  #msb(lsb, max) {
    let msb = this.prevMsb
    if (lsb < this.prevLsb && this.prevLsb - lsb >= max / 2) msb += max
    else if (lsb > this.prevLsb && lsb - this.prevLsb > max / 2) msb -= max
    return msb
  }

  #fatiaAvc(b, ini, fim, tipo) {
    const ref = (b[ini] >> 5) & 3
    const r = new Bits(rbsp(b, ini + 1, fim, 64))
    r.ue()
    r.ue()
    const pps = this.pps.get(r.ue())
    const sps = pps && this.sps.get(pps.sps)
    if (!sps) return null
    if (sps.separado) r.u(2)
    r.u(sps.log2Frame)
    if (!sps.soQuadros && r.u(1)) r.u(1)
    if (tipo === 5) {
      r.ue()
      this.grupo++
      this.prevMsb = 0
      this.prevLsb = 0
    }
    if (sps.tipoPoc === 2) return { grupo: this.grupo, poc: null } // sem reordenação: exibe na ordem do arquivo
    if (sps.tipoPoc !== 0) return null
    const max = 2 ** sps.log2Poc
    const lsb = r.u(sps.log2Poc)
    const msb = tipo === 5 ? 0 : this.#msb(lsb, max)
    if (ref) {
      this.prevMsb = msb
      this.prevLsb = lsb
    }
    return { grupo: this.grupo, poc: msb + lsb }
  }

  #fatiaHevc(b, ini, fim, tipo) {
    const tid = (b[ini + 1] & 7) - 1
    const r = new Bits(rbsp(b, ini + 2, fim, 64))
    r.u(1) // first_slice_segment_in_pic (= 1)
    const irap = tipo >= 16 && tipo <= 23
    if (irap) r.u(1)
    const pps = this.pps.get(r.ue())
    const sps = pps && this.sps.get(pps.sps)
    if (!sps) return null
    r.u(pps.extras)
    r.ue() // slice_type
    if (pps.saida) r.u(1)
    if (sps.separado) r.u(2)
    const idr = tipo === 19 || tipo === 20
    // IDR, BLA e o primeiro quadro (CRA no começo) recomeçam a contagem.
    if (idr || (tipo >= 16 && tipo <= 18) || (this.primeiro && irap)) {
      this.primeiro = false
      this.grupo++
      const lsb = idr ? 0 : r.u(sps.log2Poc)
      this.prevMsb = 0
      this.prevLsb = lsb
      return { grupo: this.grupo, poc: lsb }
    }
    this.primeiro = false
    const max = 2 ** sps.log2Poc
    const lsb = r.u(sps.log2Poc)
    const msb = this.#msb(lsb, max)
    // Só quadro de camada 0 que não é RASL/RADL nem descartável vira o "anterior".
    const descartavel = (tipo <= 14 && tipo % 2 === 0) || (tipo >= 6 && tipo <= 9)
    if (tid === 0 && !descartavel) {
      this.prevMsb = msb
      this.prevLsb = lsb
    }
    return { grupo: this.grupo, poc: msb + lsb }
  }
}

/**
 * Deslocamentos (ctts, em unidades de `dur`) a partir das ordens lidas. null se faltou alguma.
 * @returns {{ cts: number[], atraso: number } | null}
 */
export function deslocamentos(ordens, dur) {
  if (!ordens.length || ordens.some((o) => !o)) return null
  if (ordens.every((o) => o.poc == null)) return { cts: ordens.map(() => 0), atraso: 0 }
  const idx = ordens.map((o, i) => ({ i, g: o.grupo, poc: o.poc ?? i }))
  idx.sort((a, b) => a.g - b.g || a.poc - b.poc || a.i - b.i)
  const exib = new Array(ordens.length)
  idx.forEach((x, k) => (exib[x.i] = k))
  let atraso = 0
  for (let i = 0; i < ordens.length; i++) atraso = Math.max(atraso, i - exib[i])
  return { cts: exib.map((e, i) => (e - i + atraso) * dur), atraso: atraso * dur }
}
