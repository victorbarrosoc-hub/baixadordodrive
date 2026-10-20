// Caixas (atoms) do MP4/MOV (ISO BMFF e QuickTime): ler a árvore, expandir as tabelas de amostras de cada faixa e
// escrever caixas de volta. Base do Resgate (docs/CARTOES.md §7): consertar o clipe que perdeu o índice e achar vídeo
// pela estrutura na varredura. Código próprio, sem dependências (o motor de conserto de código aberto é GPL).

/** Caixas que só têm outras caixas dentro (o resto é guardado como bytes). */
export const CONTEINERES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'udta', 'mvex', 'tref'])

const TIPO_OK = /^[\x20-\x7e©]{4}$/

export function tipoValido(t) {
  return TIPO_OK.test(t)
}

export const lerTipo = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3])

function u32(b, p) {
  return ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]
}
function u64(b, p) {
  return u32(b, p) * 2 ** 32 + u32(b, p + 4)
}
const u16 = (b, p) => (b[p] << 8) | b[p + 1]
const i32 = (b, p) => u32(b, p) | 0

/**
 * Cabeçalho de caixa em `b[p]`: { tipo, tamanho, cab } (cab = 8 ou 16). tamanho 0 = até o fim (`fim`).
 * null se não parece caixa.
 */
export function cabecalho(b, p, fim = b.length) {
  if (p + 8 > fim) return null
  let tamanho = u32(b, p)
  const tipo = lerTipo(b, p + 4)
  if (!tipoValido(tipo)) return null
  let cab = 8
  if (tamanho === 1) {
    if (p + 16 > fim) return null
    tamanho = u64(b, p + 8)
    cab = 16
  } else if (tamanho === 0) tamanho = fim - p
  if (tamanho < cab) return null
  return { tipo, tamanho, cab }
}

/** Árvore de caixas de `b[ini, fim)`: [{ tipo, filhos } | { tipo, dados }]. Para no primeiro pedaço que não é caixa. */
export function arvore(b, ini = 0, fim = b.length) {
  const out = []
  let p = ini
  while (p + 8 <= fim) {
    const c = cabecalho(b, p, fim)
    if (!c || p + c.tamanho > fim) break
    const corpoIni = p + c.cab
    const corpoFim = p + c.tamanho
    if (CONTEINERES.has(c.tipo)) out.push({ tipo: c.tipo, filhos: arvore(b, corpoIni, corpoFim) })
    else out.push({ tipo: c.tipo, dados: b.subarray(corpoIni, corpoFim) })
    p = corpoFim
  }
  return out
}

export const filho = (no, tipo) => no?.filhos?.find((f) => f.tipo === tipo) || null
export const caminho = (no, ...tipos) => tipos.reduce((n, t) => filho(n, t), no)

// ───── escrever ─────

function cabecalhoBytes(tipo, tamanhoCorpo) {
  const total = tamanhoCorpo + 8
  if (total > 0xffffffff) {
    const h = new Uint8Array(16)
    const v = new DataView(h.buffer)
    v.setUint32(0, 1)
    for (let i = 0; i < 4; i++) h[4 + i] = tipo.charCodeAt(i)
    v.setUint32(8, Math.floor((total + 8) / 2 ** 32))
    v.setUint32(12, (total + 8) >>> 0)
    return h
  }
  const h = new Uint8Array(8)
  new DataView(h.buffer).setUint32(0, total)
  for (let i = 0; i < 4; i++) h[4 + i] = tipo.charCodeAt(i)
  return h
}

/** Nó → bytes. */
export function escrever(no) {
  if (no.filhos) {
    const partes = no.filhos.map(escrever)
    const n = partes.reduce((s, x) => s + x.length, 0)
    const out = new Uint8Array(8 + n)
    out.set(cabecalhoBytes(no.tipo, n), 0)
    let p = 8
    for (const x of partes) {
      out.set(x, p)
      p += x.length
    }
    return out
  }
  const h = cabecalhoBytes(no.tipo, no.dados.length)
  const out = new Uint8Array(h.length + no.dados.length)
  out.set(h)
  out.set(no.dados, h.length)
  return out
}

/** Escritor de corpo de caixa (big-endian). */
export class Corpo {
  constructor() {
    this.partes = []
    this.n = 0
  }
  u8(x) {
    this.partes.push(Uint8Array.of(x & 255))
    this.n += 1
    return this
  }
  u16(x) {
    this.partes.push(Uint8Array.of((x >> 8) & 255, x & 255))
    this.n += 2
    return this
  }
  u32(x) {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, x >>> 0)
    this.partes.push(b)
    this.n += 4
    return this
  }
  i32(x) {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setInt32(0, x | 0)
    this.partes.push(b)
    this.n += 4
    return this
  }
  u64(x) {
    return this.u32(Math.floor(x / 2 ** 32)).u32(x % 2 ** 32)
  }
  bytes(b) {
    this.partes.push(b)
    this.n += b.length
    return this
  }
  fim() {
    const out = new Uint8Array(this.n)
    let p = 0
    for (const x of this.partes) {
      out.set(x, p)
      p += x.length
    }
    return out
  }
}

// ───── faixas e tabelas de amostras ─────

/** Versão e flags da caixa "full". */
const vf = (d) => ({ versao: d[0], flags: (d[1] << 16) | (d[2] << 8) | d[3] })

function lerMdhd(d) {
  const { versao } = vf(d)
  return versao === 1 ? { timescale: u32(d, 20), duracao: u64(d, 24) } : { timescale: u32(d, 12), duracao: u32(d, 16) }
}

export function lerMvhd(d) {
  const { versao } = vf(d)
  return versao === 1
    ? { versao, criado: u64(d, 4), timescale: u32(d, 20), duracao: u64(d, 24) }
    : { versao, criado: u32(d, 4), timescale: u32(d, 12), duracao: u32(d, 16) }
}

/** Primeira descrição de amostra do stsd: { codec, dados (a entrada inteira, com cabeçalho) }. */
function lerStsd(d) {
  const n = u32(d, 4)
  if (!n) return null
  const tam = u32(d, 8)
  return { codec: lerTipo(d, 12), entrada: d.subarray(8, 8 + tam), total: n }
}

/** Tamanho do campo de comprimento das NAL (avcC/hvcC), a partir da entrada do stsd de vídeo. */
function tamanhoNal(entrada, codec) {
  // Entrada de vídeo: 8 (cab) + 78 bytes fixos, depois as caixas filhas (avcC, hvcC, pasp, colr…).
  const kids = arvore(entrada, 86, entrada.length)
  if (codec === 'avc1' || codec === 'avc3') {
    const c = kids.find((k) => k.tipo === 'avcC')
    return c ? { nal: (c.dados[4] & 3) + 1, config: c.dados } : null
  }
  if (codec === 'hvc1' || codec === 'hev1') {
    const c = kids.find((k) => k.tipo === 'hvcC')
    return c ? { nal: (c.dados[21] & 3) + 1, config: c.dados } : null
  }
  return null
}

/** Áudio PCM: bytes por quadro (todos os canais), pela entrada do stsd (QuickTime v0/v1/v2 ou ISO). */
function bytesPorQuadroPcm(entrada, codec) {
  const versao = u16(entrada, 16)
  const canais = u16(entrada, 24)
  const bits = u16(entrada, 26)
  if (versao === 2) {
    // QuickTime v2: canais em 48, bits por canal em 56, bytes por pacote (= quadro, no LPCM) em 64.
    const bpf = u32(entrada, 64)
    if (bpf) return bpf
    return (u32(entrada, 48) * u32(entrada, 56)) / 8
  }
  if (versao === 1) {
    const bpf = u32(entrada, 44) // bytes por quadro
    if (bpf) return bpf
  }
  const fixos = { twos: null, sowt: null, in24: 3, in32: 4, fl32: 4, fl64: 8, raw: 1 }
  if (fixos[codec]) return fixos[codec] * canais
  return (bits / 8) * canais
}

export const PCM = new Set(['twos', 'sowt', 'lpcm', 'ipcm', 'in24', 'in32', 'fl32', 'fl64', 'raw '])

/** Faixa do moov: dados do codec e as amostras expandidas (posição, tamanho, duração, deslocamento, chave). */
export function lerFaixa(trak) {
  const tkhd = filho(trak, 'tkhd')?.dados
  const mdia = filho(trak, 'mdia')
  const hdlr = filho(mdia, 'hdlr')?.dados
  const mdhd = lerMdhd(filho(mdia, 'mdhd').dados)
  const stbl = caminho(mdia, 'minf', 'stbl')
  const stsd = lerStsd(filho(stbl, 'stsd').dados)
  const handler = hdlr ? lerTipo(hdlr, 8) : '????'
  const id = tkhd ? u32(tkhd, vf(tkhd).versao === 1 ? 20 : 12) : 0
  const f = { id, handler, codec: stsd?.codec || '????', timescale: mdhd.timescale, duracao: mdhd.duracao, trak, stsd, nal: null, pcm: null }
  if (handler === 'vide' && stsd) f.nal = tamanhoNal(stsd.entrada, stsd.codec)
  if (handler === 'soun' && stsd && PCM.has(stsd.codec)) f.pcm = { bytesPorQuadro: bytesPorQuadroPcm(stsd.entrada, stsd.codec) }

  // Tabelas.
  const t = (tipo) => filho(stbl, tipo)?.dados
  const stsz = t('stsz')
  const stz2 = t('stz2')
  const stco = t('stco')
  const co64 = t('co64')
  const stsc = t('stsc')
  const stts = t('stts')
  const ctts = t('ctts')
  const stss = t('stss')
  const tamanhos = []
  let tamanhoFixo = 0
  if (stsz) {
    tamanhoFixo = u32(stsz, 4)
    const n = u32(stsz, 8)
    if (!tamanhoFixo) for (let i = 0; i < n; i++) tamanhos.push(u32(stsz, 12 + i * 4))
    else for (let i = 0; i < n; i++) tamanhos.push(tamanhoFixo)
  } else if (stz2) {
    const campo = stz2[7]
    const n = u32(stz2, 8)
    for (let i = 0; i < n; i++) tamanhos.push(campo === 16 ? u16(stz2, 12 + i * 2) : campo === 8 ? stz2[12 + i] : (stz2[12 + (i >> 1)] >> (i & 1 ? 0 : 4)) & 15)
  }
  const pedacos = []
  if (stco) for (let i = 0, n = u32(stco, 4); i < n; i++) pedacos.push(u32(stco, 8 + i * 4))
  else if (co64) for (let i = 0, n = u32(co64, 4); i < n; i++) pedacos.push(u64(co64, 8 + i * 8))
  const porPedaco = []
  if (stsc) {
    const n = u32(stsc, 4)
    const ent = Array.from({ length: n }, (_, i) => ({ primeiro: u32(stsc, 8 + i * 12), n: u32(stsc, 12 + i * 12) }))
    for (let k = 0; k < ent.length; k++) {
      const ate = k + 1 < ent.length ? ent[k + 1].primeiro : pedacos.length + 1
      for (let c = ent[k].primeiro; c < ate; c++) porPedaco.push(ent[k].n)
    }
  }
  const duracoes = []
  if (stts) for (let i = 0, n = u32(stts, 4); i < n; i++) for (let k = 0, c = u32(stts, 8 + i * 8); k < c; k++) duracoes.push(u32(stts, 12 + i * 8))
  const deslocs = []
  if (ctts) for (let i = 0, n = u32(ctts, 4); i < n; i++) for (let k = 0, c = u32(ctts, 8 + i * 8); k < c; k++) deslocs.push(i32(ctts, 12 + i * 8))
  const chaves = stss ? new Set(Array.from({ length: u32(stss, 4) }, (_, i) => u32(stss, 8 + i * 4) - 1)) : null

  const amostras = []
  const chunks = []
  let s = 0
  for (let c = 0; c < pedacos.length; c++) {
    let pos = pedacos[c]
    const n = porPedaco[c] ?? 0
    let bytes = 0
    for (let k = 0; k < n && s < tamanhos.length; k++, s++) {
      amostras.push({ pos, tam: tamanhos[s], dur: duracoes[s] ?? 0, cts: deslocs[s] ?? 0, chave: chaves ? chaves.has(s) : true })
      pos += tamanhos[s]
      bytes += tamanhos[s]
    }
    chunks.push({ pos: pedacos[c], n, bytes })
  }
  f.amostras = amostras
  f.chunks = chunks
  f.tamanhoFixo = tamanhoFixo
  f.temCtts = Boolean(ctts)
  f.temStss = Boolean(stss)
  return f
}

/** moov → { mvhd, faixas, arvore } */
export function lerMoov(bytesMoov) {
  const raiz = arvore(bytesMoov)
  const moov = raiz.find((n) => n.tipo === 'moov')
  if (!moov) throw new Error('sem moov')
  const mvhd = lerMvhd(filho(moov, 'mvhd').dados)
  const faixas = moov.filhos.filter((n) => n.tipo === 'trak').map(lerFaixa)
  return { mvhd, faixas, moov }
}

export { u16, u32, u64 }
