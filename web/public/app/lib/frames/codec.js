// Qual codec está dentro do vídeo (MP4/MOV), lendo só o cabeçalho (a caixa "moov"), sem baixar o vídeo.
// "MP4" é só a embalagem: dentro pode vir H.264 de 8 bits (abre em qualquer celular) ou o H.264 10-bit 4:2:2 das
// câmeras (Sony XAVC S-I/S 4:2:2, Canon, Panasonic), que nenhum aparelho Apple decodifica. Saber antes evita a espera
// de um vídeo que não vai abrir e deixa a mensagem dizer o motivo de verdade.
//
// `ler(a, b)` devolve os bytes [a, b) do arquivo (Range do Drive ou File.slice da galeria).

const INICIO = 64 * 1024
const MAX_MOOV = 32e6

const u16 = (b, o) => b[o] * 256 + b[o + 1]
const u32 = (b, o) => b[o] * 2 ** 24 + b[o + 1] * 65536 + b[o + 2] * 256 + b[o + 3]
const tipo = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])
const legivel = (t) => /^[\x20-\x7e]{4}$/.test(t)

/** As caixas entre [ini, fim) de `b`: { t, ini (início do conteúdo), fim }. */
function* caixas(b, ini = 0, fim = b.length) {
  let p = ini
  while (p + 8 <= fim) {
    let size = u32(b, p)
    const t = tipo(b, p + 4)
    let h = 8
    if (size === 1) {
      if (p + 16 > fim) return
      size = u32(b, p + 8) * 2 ** 32 + u32(b, p + 12)
      h = 16
    } else if (size === 0) size = fim - p
    if (size < h || p + size > fim || !legivel(t)) return
    yield { t, ini: p + h, fim: p + size }
    p += size
  }
}

const filho = (b, c, t) => {
  for (const x of caixas(b, c.ini, c.fim)) if (x.t === t) return x
  return null
}
const caminho = (b, c, ...ts) => ts.reduce((x, t) => (x ? filho(b, x, t) : null), c)

const PRORES = { apco: 'ProRes 422 Proxy', apcs: 'ProRes 422 LT', apcn: 'ProRes 422', apch: 'ProRes 422 HQ', ap4h: 'ProRes 4444', ap4x: 'ProRes 4444 XQ' }
const H264 = new Set(['avc1', 'avc2', 'avc3', 'avc4'])
const HEVC = new Set(['hvc1', 'hev1', 'dvh1', 'dvhe'])
const CROMA = ['4:0:0', '4:2:0', '4:2:2', '4:4:4']

function avc(b, c) {
  const perfil = b[c.ini + 1]
  let bits = perfil === 110 || perfil === 122 || perfil === 244 ? 10 : 8
  let croma = perfil === 122 ? '4:2:2' : perfil === 244 ? '4:4:4' : '4:2:0'
  // Depois das listas de SPS e PPS, os perfis High+ dizem a croma e os bits de verdade.
  if ([100, 110, 122, 144, 244].includes(perfil)) {
    let p = c.ini + 5
    let ok = p < c.fim
    for (let lista = 0; lista < 2 && ok; lista++) {
      const n = lista === 0 ? b[p] & 0x1f : b[p]
      p++
      for (let i = 0; i < n && ok; i++) {
        if (p + 2 > c.fim) ok = false
        else p += 2 + u16(b, p)
      }
      ok = ok && p <= c.fim
    }
    if (ok && p + 2 <= c.fim) {
      croma = CROMA[b[p] & 3]
      bits = (b[p + 1] & 7) + 8
    }
  }
  return { codec: 'h264', perfil, bits, croma }
}

function hevc(b, c) {
  if (c.fim - c.ini < 19) return { codec: 'hevc', perfil: null, bits: null, croma: null }
  return { codec: 'hevc', perfil: b[c.ini + 1] & 0x1f, bits: (b[c.ini + 17] & 7) + 8, croma: CROMA[b[c.ini + 16] & 3] }
}

/** O codec da primeira trilha de vídeo de uma caixa moov (o conteúdo dela). */
export function codecDoMoov(b) {
  for (const trak of caixas(b, 0, b.length)) {
    if (trak.t !== 'trak') continue
    const hdlr = caminho(b, trak, 'mdia', 'hdlr')
    if (!hdlr || hdlr.ini + 12 > hdlr.fim || tipo(b, hdlr.ini + 8) !== 'vide') continue
    const stsd = caminho(b, trak, 'mdia', 'minf', 'stbl', 'stsd')
    if (!stsd || stsd.ini + 16 > stsd.fim) continue
    const e = stsd.ini + 8 // versão + quantidade
    const fourcc = tipo(b, e + 4)
    const fim = Math.min(stsd.fim, e + u32(b, e))
    const largura = e + 8 + 26 <= fim ? u16(b, e + 8 + 24) : null
    const altura = e + 8 + 28 <= fim ? u16(b, e + 8 + 26) : null
    const entrada = { ini: e + 8 + 78, fim }
    const base = { fourcc, largura, altura }
    if (H264.has(fourcc)) {
      const cfg = entrada.ini < fim ? filho(b, entrada, 'avcC') : null
      return { ...base, ...(cfg ? avc(b, cfg) : { codec: 'h264', perfil: null, bits: null, croma: null }) }
    }
    if (HEVC.has(fourcc)) {
      const cfg = entrada.ini < fim ? filho(b, entrada, 'hvcC') : null
      return { ...base, ...(cfg ? hevc(b, cfg) : { codec: 'hevc', perfil: null, bits: null, croma: null }) }
    }
    if (PRORES[fourcc]) return { ...base, codec: 'prores', nome: PRORES[fourcc] }
    if (fourcc === 'AVdn' || fourcc === 'AVdh') return { ...base, codec: 'dnxhd' }
    if (fourcc === 'av01') return { ...base, codec: 'av1' }
    if (fourcc === 'vp09') return { ...base, codec: 'vp9' }
    if (fourcc === 'mp4v') return { ...base, codec: 'mpeg4' }
    if (/^(jpeg|mjp[ab])$/.test(fourcc)) return { ...base, codec: 'mjpeg' }
    return { ...base, codec: 'outro' }
  }
  return null
}

/**
 * Lê o codec do vídeo: procura a caixa moov entre as de cima (às vezes ela vem depois dos dados, no fim do arquivo)
 * e lê só ela. Devolve null quando não é MP4/MOV ou não deu para saber.
 */
export async function lerCodec(ler, tamanho = null) {
  const primeiro = await ler(0, tamanho ? Math.min(INICIO, tamanho) : INICIO)
  if (primeiro.length < 8 || !legivel(tipo(primeiro, 4))) return null
  const pegar = (a, b) => (b <= primeiro.length ? Promise.resolve(primeiro.subarray(a, b)) : ler(a, b))
  let p = 0
  for (let i = 0; i < 64; i++) {
    if (tamanho != null && p + 8 > tamanho) return null
    const cab = await pegar(p, p + 16)
    if (cab.length < 8) return null
    let size = u32(cab, 0)
    const t = tipo(cab, 4)
    let h = 8
    if (!legivel(t)) return null
    if (size === 1) {
      if (cab.length < 16) return null
      size = u32(cab, 8) * 2 ** 32 + u32(cab, 12)
      h = 16
    } else if (size === 0) {
      if (tamanho == null) return null
      size = tamanho - p
    }
    if (size < h) return null
    if (t === 'moov') {
      if (size > MAX_MOOV) return null
      const b = await pegar(p + h, p + size)
      return b.length === size - h ? codecDoMoov(b) : null
    }
    p += size
  }
  return null
}

/** "H.264 10-bit 4:2:2", "HEVC 10-bit 4:2:0", "ProRes 422 HQ". */
export function rotuloCodec(c) {
  if (!c) return ''
  const det = [c.bits ? `${c.bits}-bit` : '', c.croma || ''].filter(Boolean).join(' ')
  if (c.codec === 'h264') return `H.264${det ? ` ${det}` : ''}`
  if (c.codec === 'hevc') return `HEVC (H.265)${det ? ` ${det}` : ''}`
  if (c.codec === 'prores') return c.nome
  return { dnxhd: 'DNxHD/DNxHR', av1: 'AV1', vp9: 'VP9', mpeg4: 'MPEG-4', mjpeg: 'Motion JPEG' }[c.codec] || `codec ${c.fourcc}`
}

/**
 * O celular abre? true (abre), false (com certeza não: H.264 de 10 bits ou 4:2:2/4:4:4, que nenhum aparelho
 * Apple nem a maioria dos Android decodifica; DNxHD) ou null (depende do aparelho: ProRes nos iPhone Pro, HEVC 4:2:2…).
 */
export function celularAbre(c) {
  if (!c) return null
  if (c.codec === 'h264') return c.bits == null ? null : c.bits === 8 && c.croma === '4:2:0'
  if (c.codec === 'hevc') return c.croma === '4:2:0' && (c.bits === 8 || c.bits === 10) ? true : null
  if (c.codec === 'dnxhd') return false
  return null
}

/** Por que não abre, numa frase (para a tela de erro e o aviso antes de começar). */
export function porqueNaoAbre(c, nome = '') {
  if (!c) return ''
  const ext = /\.(mp4|mov|m4v)$/i.exec(nome)?.[1]
  const este = ext ? `Este ${ext.toUpperCase()}` : 'Este vídeo'
  if (c.codec === 'h264' && (c.bits > 8 || c.croma !== '4:2:0')) return `${este} é ${rotuloCodec(c)}, o modo de alta qualidade da câmera. O celular não decodifica esse codec.`
  return `${este} é ${rotuloCodec(c)}, que este celular não decodifica.`
}
