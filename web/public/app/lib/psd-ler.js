// Leitura de PSD/PSB sem baixar o arquivo todo (lib/psd.js busca os pedaços no Drive; a decodificação roda no
// lib/psd-worker.js). Sem dependências: o mesmo código roda no aparelho, no worker e nos testes (test/psd.test.js).
//
// O que sai de um PSD:
//   - a miniatura que o Photoshop grava dentro dele (recurso 1036, JPEG de até 160 px), lida nos primeiros KB;
//   - a imagem final (a "composta", que o Photoshop grava com "Maximizar compatibilidade"), no fim do arquivo;
//   - a lista de camadas e as pranchetas (artboards: grupo com o retângulo da prancheta), lidas logo depois.

export const MAX_COMPOSTA = 150e6 // imagem final maior que isso não abre no celular (fica a miniatura)
export const MAX_CAMADAS = 3e6 // lê até isso das camadas (os nomes e as pranchetas vêm antes dos pixels)

const td = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-16be') : null

export class Leitor {
  constructor(bytes, base = 0) {
    this.b = bytes
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.p = 0
    this.base = base // posição de bytes[0] no arquivo
  }
  get fim() {
    return this.p >= this.b.length
  }
  precisa(n) {
    if (this.p + n > this.b.length) throw new FimDosDados()
  }
  u8() {
    this.precisa(1)
    return this.b[this.p++]
  }
  u16() {
    this.precisa(2)
    const x = this.v.getUint16(this.p)
    this.p += 2
    return x
  }
  i16() {
    this.precisa(2)
    const x = this.v.getInt16(this.p)
    this.p += 2
    return x
  }
  u32() {
    this.precisa(4)
    const x = this.v.getUint32(this.p)
    this.p += 4
    return x
  }
  i32() {
    this.precisa(4)
    const x = this.v.getInt32(this.p)
    this.p += 4
    return x
  }
  u64() {
    const hi = this.u32()
    const lo = this.u32()
    return hi * 2 ** 32 + lo
  }
  f64() {
    this.precisa(8)
    const x = this.v.getFloat64(this.p)
    this.p += 8
    return x
  }
  ascii(n) {
    this.precisa(n)
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.p + i])
    this.p += n
    return s
  }
  bytes(n) {
    this.precisa(n)
    const x = this.b.subarray(this.p, this.p + n)
    this.p += n
    return x
  }
  pular(n) {
    this.precisa(n)
    this.p += n
  }
  unicode() {
    const n = this.u32()
    this.precisa(n * 2)
    const raw = this.b.subarray(this.p, this.p + n * 2)
    this.p += n * 2
    let s = td ? td.decode(raw) : String.fromCharCode(...Array.from({ length: n }, (_, i) => (raw[i * 2] << 8) | raw[i * 2 + 1]))
    return s.replace(/\u0000+$/, '')
  }
}

export class FimDosDados extends Error {
  constructor() {
    super('dados acabaram')
    this.name = 'FimDosDados'
  }
}

export class NaoEPsd extends Error {
  constructor(msg = 'Não é um arquivo do Photoshop.') {
    super(msg)
    this.name = 'NaoEPsd'
  }
}

export const MODOS = { 0: 'Bitmap', 1: 'Tons de cinza', 2: 'Indexado', 3: 'RGB', 4: 'CMYK', 7: 'Multicanal', 8: 'Duotone', 9: 'Lab' }

/**
 * Cabeçalho (26 bytes), dados de cor e recursos. `bytes` = começo do arquivo (64 KB bastam para quase todos).
 * Devolve onde ficam os recursos inteiros quando eles não couberam (`faltaRecursos`).
 */
export function lerCabecalho(bytes) {
  const r = new Leitor(bytes)
  if (r.ascii(4) !== '8BPS') throw new NaoEPsd()
  const versao = r.u16()
  if (versao !== 1 && versao !== 2) throw new NaoEPsd('Versão de PSD desconhecida.')
  r.pular(6)
  const canais = r.u16()
  const altura = r.u32()
  const largura = r.u32()
  const prof = r.u16()
  const modo = r.u16()
  const corLen = r.u32()
  const corInicio = r.p
  const recursosEm = corInicio + corLen
  const cab = { psb: versao === 2, canais, largura, altura, prof, modo, paleta: null, recursosEm }
  if (modo === 2 && corLen >= 768 && corInicio + 768 <= bytes.length) cab.paleta = bytes.slice(corInicio, corInicio + 768)
  if (recursosEm + 4 > bytes.length) return { ...cab, recursosLen: null }
  const rv = new DataView(bytes.buffer, bytes.byteOffset + recursosEm, 4)
  cab.recursosLen = rv.getUint32(0)
  cab.camadasEm = recursosEm + 4 + cab.recursosLen
  return cab
}

/** Miniatura gravada pelo Photoshop (JPEG) a partir dos bytes da seção de recursos (sem o tamanho). null = sem. */
export function miniaturaDosRecursos(bytes) {
  const r = new Leitor(bytes)
  let achada = null
  try {
    while (!r.fim) {
      if (r.ascii(4) !== '8BIM') break
      const id = r.u16()
      const nomeLen = r.u8()
      r.pular(nomeLen + ((nomeLen + 1) % 2)) // nome Pascal com tamanho par
      const len = r.u32()
      const ini = r.p
      if ((id === 1036 || id === 1033) && len > 28) {
        const formato = r.u32()
        r.pular(24)
        // 1 = JPEG. 1033 (Photoshop 4) grava em BGR: as cores saem trocadas, mas serve na falta da outra.
        if (formato === 1) {
          const jpeg = bytes.slice(r.p, ini + len)
          if (id === 1036 || !achada) achada = jpeg
        }
      }
      r.p = ini + len + (len % 2)
    }
  } catch (err) {
    if (!(err instanceof FimDosDados)) throw err
  }
  return achada
}

// Chaves das informações extras de camada que usam tamanho de 8 bytes no PSB.
const LEN8 = new Set(['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn', 'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD'])

function idDescritor(r) {
  const n = r.u32()
  return r.ascii(n === 0 ? 4 : n)
}

function valorDescritor(r, tipo) {
  switch (tipo) {
    case 'Objc':
    case 'GlbO':
      return descritor(r)
    case 'VlLs': {
      const n = r.u32()
      const out = []
      for (let i = 0; i < n; i++) out.push(valorDescritor(r, r.ascii(4)))
      return out
    }
    case 'doub':
      return r.f64()
    case 'UntF':
      r.pular(4)
      return r.f64()
    case 'UnFl': {
      r.pular(4)
      const n = r.u32()
      const out = []
      for (let i = 0; i < n; i++) out.push(r.f64())
      return out
    }
    case 'long':
      return r.i32()
    case 'comp':
      return r.u64()
    case 'bool':
      return r.u8() !== 0
    case 'TEXT':
      return r.unicode()
    case 'enum':
      idDescritor(r)
      return idDescritor(r)
    case 'type':
    case 'GlbC':
      r.unicode()
      return idDescritor(r)
    case 'tdta':
    case 'alis':
    case 'Pth ':
      r.pular(r.u32())
      return null
    case 'obj ': {
      const n = r.u32()
      for (let i = 0; i < n; i++) {
        const t = r.ascii(4)
        if (t === 'prop') (r.unicode(), idDescritor(r), idDescritor(r))
        else if (t === 'Clss') (r.unicode(), idDescritor(r))
        else if (t === 'Enmr') (r.unicode(), idDescritor(r), idDescritor(r), idDescritor(r))
        else if (t === 'rele') (r.unicode(), idDescritor(r), r.u32())
        else if (t === 'Idnt' || t === 'indx') r.u32()
        else if (t === 'name') (r.unicode(), idDescritor(r), r.unicode())
        else throw new Error(`referência ${t}`)
      }
      return null
    }
    default:
      throw new Error(`tipo ${tipo}`)
  }
}

/** Descritor do Photoshop (ActionDescriptor) → objeto simples { chave: valor }. */
export function descritor(r) {
  r.unicode()
  idDescritor(r)
  const n = r.u32()
  const out = {}
  for (let i = 0; i < n; i++) {
    const k = idDescritor(r)
    out[k] = valorDescritor(r, r.ascii(4))
  }
  return out
}

function retanguloDaPrancheta(dados) {
  try {
    const r = new Leitor(dados)
    r.u32() // versão
    const d = descritor(r)
    const ret = d.artboardRect
    if (!ret || typeof ret.Left !== 'number') return null
    const rect = { left: Math.round(ret.Left), top: Math.round(ret['Top ']), right: Math.round(ret.Rght), bottom: Math.round(ret.Btom) }
    return rect.right > rect.left && rect.bottom > rect.top ? rect : null
  } catch {
    return null
  }
}

/**
 * Camadas: `bytes` começa na seção "camadas e máscaras" (posição `camadasEm` do cabeçalho) e pode estar cortado
 * (só os registros importam). Devolve onde fica a imagem final e a árvore de cima para baixo.
 * @returns {{ compostaEm: number, total: number, parcial: boolean, camadas: object[], pranchetas: object[] }}
 */
export function lerCamadas(bytes, { psb = false, camadasEm = 0 } = {}) {
  const r = new Leitor(bytes)
  const len = () => (psb ? r.u64() : r.u32())
  const secaoLen = len()
  const compostaEm = camadasEm + (psb ? 8 : 4) + secaoLen
  const registros = []
  let total = 0
  let parcial = false
  try {
    if (secaoLen > 0) {
      const infoLen = len()
      if (infoLen > 0) {
        total = Math.abs(r.i16())
        for (let i = 0; i < total; i++) {
          const reg = { nome: '', tipo: 0, prancheta: null, oculta: false }
          reg.rect = { top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32() }
          const nc = r.u16()
          r.pular(nc * (psb ? 10 : 6))
          r.pular(4) // '8BIM'
          r.pular(4) // modo de mesclagem
          r.pular(2) // opacidade, recorte
          const flags = r.u8()
          reg.oculta = Boolean(flags & 2)
          r.pular(1)
          const extraLen = r.u32()
          const fimExtra = r.p + extraLen
          r.pular(r.u32()) // máscara
          r.pular(r.u32()) // faixas de mesclagem
          const nomeLen = r.u8()
          const nomeRaw = r.bytes(nomeLen)
          reg.nome = Array.from(nomeRaw, (c) => String.fromCharCode(c)).join('')
          r.pular((4 - ((nomeLen + 1) % 4)) % 4)
          while (r.p + 12 <= fimExtra) {
            const sig = r.ascii(4)
            if (sig !== '8BIM' && sig !== '8B64') break
            const chave = r.ascii(4)
            const n = psb && LEN8.has(chave) ? r.u64() : r.u32()
            const ini = r.p
            r.precisa(n)
            if (chave === 'luni') {
              const s = new Leitor(bytes.subarray(ini, ini + n)).unicode()
              if (s) reg.nome = s
            } else if (chave === 'lsct' || chave === 'lsdk') {
              reg.tipo = new DataView(bytes.buffer, bytes.byteOffset + ini, 4).getUint32(0)
            } else if (chave === 'artb' || chave === 'artd' || chave === 'abdd') {
              reg.prancheta = retanguloDaPrancheta(bytes.subarray(ini, ini + n))
            }
            r.p = ini + n
          }
          r.p = fimExtra
          registros.push(reg)
        }
      }
    }
  } catch (err) {
    if (!(err instanceof FimDosDados)) throw err
    parcial = true
  }
  // Os registros vêm de baixo para cima; grupo = registro do grupo (tipo 1/2) em cima dos filhos e um divisor (tipo 3)
  // embaixo deles.
  const camadas = []
  let nivel = 0
  for (const reg of registros.slice().reverse()) {
    if (reg.tipo === 3) {
      nivel = Math.max(0, nivel - 1)
      continue
    }
    const grupo = reg.tipo === 1 || reg.tipo === 2
    camadas.push({ nome: reg.nome || 'Sem nome', grupo, nivel, oculta: reg.oculta, prancheta: reg.prancheta })
    if (grupo) nivel++
  }
  const pranchetas = camadas.filter((c) => c.prancheta).map((c) => ({ nome: c.nome, rect: c.prancheta }))
  return { compostaEm, total: camadas.length || total, parcial, camadas, pranchetas }
}

// ───── imagem final (composta) ─────

/**
 * Prepara a imagem final: `bytes` = do começo da seção da imagem até o fim do arquivo. Devolve um objeto para
 * desenhar recortes (`desenhar`), guardado no worker.
 */
export function prepararComposta(bytes, cab) {
  const r = new Leitor(bytes)
  const compressao = r.u16()
  const { largura: w, altura: h, prof } = cab
  const canais = cab.canais
  if (compressao !== 0 && compressao !== 1) throw new Error('compressão da imagem final não suportada')
  if (prof !== 8 && prof !== 16 && prof !== 1) throw new Error('profundidade não suportada')
  const bps = prof === 16 ? 2 : 1
  const linhaBytes = prof === 1 ? Math.ceil(w / 8) : w * bps
  let inicios // início de cada linha (canal × altura)
  if (compressao === 1) {
    const n = canais * h
    const tam = cab.psb ? 4 : 2
    r.precisa(n * tam)
    inicios = new Float64Array(n + 1)
    let p = r.p + n * tam
    for (let i = 0; i < n; i++) {
      inicios[i] = p
      p += tam === 4 ? r.u32() : r.u16()
    }
    inicios[n] = p
    if (p > bytes.length) throw new FimDosDados()
  } else {
    if (r.p + canais * h * linhaBytes > bytes.length) throw new FimDosDados()
  }
  return { bytes, cab, compressao, bps, linhaBytes, dados: r.p, inicios }
}

/** Uma linha de um canal, já descompactada (PackBits) em `dst`. */
function linha(c, canal, y, dst) {
  const { bytes, compressao, linhaBytes, dados, inicios, cab } = c
  const idx = canal * cab.altura + y
  if (compressao === 0) {
    const ini = dados + idx * linhaBytes
    dst.set(bytes.subarray(ini, ini + linhaBytes))
    return
  }
  let p = inicios[idx]
  const fim = inicios[idx + 1]
  let o = 0
  while (p < fim && o < linhaBytes) {
    const n = bytes[p++]
    if (n < 128) {
      const k = Math.min(n + 1, linhaBytes - o)
      dst.set(bytes.subarray(p, p + k), o)
      o += k
      p += n + 1
    } else if (n > 128) {
      const k = Math.min(257 - n, linhaBytes - o)
      dst.fill(bytes[p++], o, o + k)
      o += k
    }
  }
}

/**
 * Desenha a imagem final (ou um recorte, `rect`) em RGBA, reduzida para caber em `max` px no lado maior.
 * @returns {{ largura, altura, rgba: Uint8ClampedArray, alfa: boolean }}
 */
export function desenhar(c, { rect = null, max = 2560 } = {}) {
  const { cab, bps } = c
  const W = cab.largura
  const H = cab.altura
  const x0 = Math.max(0, Math.min(W, rect ? rect.left : 0))
  const y0 = Math.max(0, Math.min(H, rect ? rect.top : 0))
  const x1 = Math.max(x0, Math.min(W, rect ? rect.right : W))
  const y1 = Math.max(y0, Math.min(H, rect ? rect.bottom : H))
  const rw = x1 - x0
  const rh = y1 - y0
  if (!rw || !rh) throw new Error('recorte vazio')
  const passo = Math.max(1, Math.ceil(Math.max(rw, rh) / max))
  const ow = Math.ceil(rw / passo)
  const oh = Math.ceil(rh / passo)
  const out = new Uint8ClampedArray(ow * oh * 4)
  const modo = cab.modo
  const corCanais = modo === 4 ? 4 : modo === 3 ? 3 : 1
  const temAlfa = cab.canais > corCanais && (modo === 3 || modo === 4 || modo === 1)
  const usar = Math.min(cab.canais, corCanais + (temAlfa ? 1 : 0))
  const buf = new Uint8Array(c.linhaBytes)
  const plano = Array.from({ length: usar }, () => new Uint8Array(ow * oh))
  for (let ch = 0; ch < usar; ch++) {
    const dst = plano[ch]
    for (let oy = 0; oy < oh; oy++) {
      linha(c, ch, y0 + oy * passo, buf)
      const base = oy * ow
      if (cab.prof === 1) {
        for (let ox = 0; ox < ow; ox++) {
          const x = x0 + ox * passo
          dst[base + ox] = buf[x >> 3] & (0x80 >> (x & 7)) ? 0 : 255
        }
      } else {
        for (let ox = 0; ox < ow; ox++) dst[base + ox] = buf[(x0 + ox * passo) * bps] // 16 bits: o byte alto
      }
    }
  }
  const n = ow * oh
  const pal = cab.paleta
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (modo === 3) {
      out[o] = plano[0][i]
      out[o + 1] = plano[1][i]
      out[o + 2] = plano[2][i]
    } else if (modo === 4) {
      // O PSD guarda CMYK invertido (255 = sem tinta).
      const k = plano[3][i]
      out[o] = (plano[0][i] * k) / 255
      out[o + 1] = (plano[1][i] * k) / 255
      out[o + 2] = (plano[2][i] * k) / 255
    } else if (modo === 2 && pal) {
      const v = plano[0][i]
      out[o] = pal[v]
      out[o + 1] = pal[256 + v]
      out[o + 2] = pal[512 + v]
    } else {
      out[o] = out[o + 1] = out[o + 2] = plano[0][i]
    }
    out[o + 3] = temAlfa ? plano[corCanais][i] : 255
  }
  return { largura: ow, altura: oh, rgba: out, alfa: temAlfa }
}

export const ehPsd = (f) => /\.(psd|psb)$/i.test(f?.name || '') || /photoshop/i.test(f?.mimeType || '')
