// Varredura por assinatura (Resgate, docs/CARTOES.md §7.2): lê o cartão (ou a imagem dele) do começo ao fim e acha
// cada foto, vídeo e RAW pela estrutura do formato, mesmo sem nenhum índice do sistema de arquivos. Cartão recém
// formatado na câmera grava em sequência, sem fragmentar: por isso o arquivo inteiro costuma estar contíguo.
//
//   JPG          FF D8 FF … até o FF D9 (os marcadores são seguidos; a miniatura dentro do EXIF não confunde)
//   MP4/MOV/CR3  caixa "ftyp" e as caixas do topo em sequência (ftyp, mdat, moov…); sem moov = "sem índice"
//   CR2/NEF/ARW/DNG/TIF  cabeçalho TIFF; o tamanho sai das IFDs (faixas, tiles, sub-IFDs, EXIF, pré-visualização)
//
// Só lê a origem (nunca escreve nela). Código próprio: o motor de varredura de código aberto é GPL.
import fs from 'node:fs/promises'
import path from 'node:path'
import { createReadStream } from 'node:fs'

const BLOCO = 8 * 1024 * 1024
const SETOR = 512
const MAX_JPG = 300e6
const MAX_TIFF = 1e9
const TOPO_BMFF = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'uuid', 'meta', 'pdin', 'moof', 'mfra', 'styp', 'sidx', 'prft', 'emsg', 'pnot', 'PICT', 'junk'])

/** Leitor com cache de blocos sobre um arquivo aberto (cartão, imagem do cartão). */
class Origem {
  constructor(fh, tamanho) {
    this.fh = fh
    this.tamanho = tamanho
    this.cache = new Map()
  }
  async bloco(i) {
    if (this.cache.has(i)) return this.cache.get(i)
    const ini = i * BLOCO
    const n = Math.max(0, Math.min(BLOCO, this.tamanho - ini))
    const b = new Uint8Array(n)
    let lidos = 0
    while (lidos < n) {
      const { bytesRead } = await this.fh.read(b, lidos, n - lidos, ini + lidos)
      if (!bytesRead) break
      lidos += bytesRead
    }
    const out = b.subarray(0, lidos)
    this.cache.set(i, out)
    if (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value)
    return out
  }
  /** Bytes [pos, pos+n) (menos no fim da origem). */
  async ler(pos, n) {
    if (pos >= this.tamanho) return new Uint8Array(0)
    n = Math.min(n, this.tamanho - pos)
    const i = Math.floor(pos / BLOCO)
    const j = Math.floor((pos + n - 1) / BLOCO)
    if (i === j) {
      const b = await this.bloco(i)
      const o = pos - i * BLOCO
      return b.subarray(o, o + n)
    }
    const out = new Uint8Array(n)
    let p = 0
    for (let k = i; k <= j; k++) {
      const b = await this.bloco(k)
      const o = k === i ? pos - k * BLOCO : 0
      const pedaco = b.subarray(o, Math.min(b.length, o + (n - p)))
      out.set(pedaco, p)
      p += pedaco.length
    }
    return out.subarray(0, p)
  }
}

const u16be = (b, p) => (b[p] << 8) | b[p + 1]
const u32be = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]
const tipo4 = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3])

// ───── TIFF (RAW de foto e o EXIF dos JPG) ─────

const TAM_TIPO = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 }

/**
 * Lê as IFDs de um TIFF a partir de `ler(pos, n)` (posições relativas ao início do TIFF).
 * @returns {Promise<{ fim: number, make: string, model: string, data: string, dng: boolean } | null>}
 */
export async function lerTiff(ler, { max = MAX_TIFF } = {}) {
  const h = await ler(0, 8)
  if (h.length < 8) return null
  const le = h[0] === 0x49 && h[1] === 0x49
  if (!le && !(h[0] === 0x4d && h[1] === 0x4d)) return null
  const u16 = (b, p) => (le ? b[p] | (b[p + 1] << 8) : u16be(b, p))
  const u32 = (b, p) => (le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 2 ** 24 : u32be(b, p))
  if (u16(h, 2) !== 42) return null
  let fim = 8
  const info = { make: '', model: '', data: '', dng: false }
  const vistos = new Set()
  const fila = [u32(h, 4)]
  const texto = async (off, n) => {
    const b = await ler(off, Math.min(n, 64))
    return String.fromCharCode(...b).replace(/\0.*$/s, '').trim()
  }
  const valores = async (tipo, n, campo, off) => {
    const t = TAM_TIPO[tipo] || 1
    const b = n * t <= 4 ? campo : await ler(off, Math.min(n * t, 4 * 4096))
    const out = []
    for (let i = 0; i < Math.min(n, 4096); i++) out.push(t === 2 ? u16(b, i * 2) : u32(b, i * 4))
    return out
  }
  while (fila.length && vistos.size < 64) {
    const ifd = fila.shift()
    if (!ifd || ifd >= max || vistos.has(ifd)) continue
    vistos.add(ifd)
    const nb = await ler(ifd, 2)
    if (nb.length < 2) continue
    const n = u16(nb, 0)
    if (n === 0 || n > 1000) continue
    const e = await ler(ifd + 2, n * 12 + 4)
    if (e.length < n * 12 + 4) continue
    fim = Math.max(fim, ifd + 2 + n * 12 + 4)
    const pares = { faixa: [[], []], tile: [[], []], jpg: [0, 0] }
    for (let k = 0; k < n; k++) {
      const p = k * 12
      const tag = u16(e, p)
      const tipo = u16(e, p + 2)
      const cnt = u32(e, p + 4)
      const campo = e.subarray(p + 8, p + 12)
      const off = u32(e, p + 8)
      const bytes = cnt * (TAM_TIPO[tipo] || 1)
      if (bytes > 4) fim = Math.max(fim, off + bytes)
      if (tag === 0x0111) pares.faixa[0] = await valores(tipo, cnt, campo, off)
      else if (tag === 0x0117) pares.faixa[1] = await valores(tipo, cnt, campo, off)
      else if (tag === 0x0144) pares.tile[0] = await valores(tipo, cnt, campo, off)
      else if (tag === 0x0145) pares.tile[1] = await valores(tipo, cnt, campo, off)
      else if (tag === 0x0201) pares.jpg[0] = off
      else if (tag === 0x0202) pares.jpg[1] = off
      else if (tag === 0x014a) fila.push(...(await valores(tipo, cnt, campo, off)))
      else if (tag === 0x8769 || tag === 0xc634) fila.push(u32(campo, 0))
      else if (tag === 0x010f && !info.make) info.make = await texto(bytes > 4 ? off : 0, cnt).catch(() => '')
      else if (tag === 0x0110 && !info.model) info.model = await texto(bytes > 4 ? off : 0, cnt).catch(() => '')
      else if ((tag === 0x9003 || (tag === 0x0132 && !info.data)) && bytes > 4) info.data = await texto(off, cnt).catch(() => '')
      else if (tag === 0xc612) info.dng = true
    }
    for (const [offs, lens] of [pares.faixa, pares.tile]) for (let i = 0; i < Math.min(offs.length, lens.length); i++) fim = Math.max(fim, offs[i] + lens[i])
    if (pares.jpg[0] && pares.jpg[1]) fim = Math.max(fim, pares.jpg[0] + pares.jpg[1])
    const prox = u32(e, n * 12)
    if (prox) fila.push(prox)
  }
  if (fim > max) return null
  return { fim, ...info }
}

function extTiff(cab, info) {
  if (cab[8] === 0x43 && cab[9] === 0x52) return 'cr2'
  if (info.dng) return 'dng'
  const m = info.make.toUpperCase()
  if (m.startsWith('NIKON')) return 'nef'
  if (m.startsWith('SONY')) return 'arw'
  if (m.startsWith('CANON')) return 'cr2'
  if (m.startsWith('PENTAX') || m.startsWith('RICOH')) return 'pef'
  return 'tif'
}

// ───── JPEG ─────

async function medirJpeg(o, ini) {
  let q = ini + 2
  let viuSos = false
  let viuQuadro = false
  let exif = null
  while (q - ini < MAX_JPG) {
    const m = await o.ler(q, 4)
    if (m.length < 2 || m[0] !== 0xff) return null
    const mk = m[1]
    if (mk === 0xd9) return viuSos ? { fim: q + 2, exif } : null
    if (mk === 0xff) {
      q++
      continue
    }
    if ((mk >= 0xd0 && mk <= 0xd7) || mk === 0x01) {
      q += 2
      continue
    }
    if (m.length < 4) return null
    const len = u16be(m, 2)
    if (len < 2) return null
    if (mk === 0xe1 && !exif) exif = { pos: q + 4, len: len - 2 }
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) viuQuadro = true
    if (mk !== 0xda) {
      if (!viuSos && !((mk >= 0xc0 && mk <= 0xfe) || mk === 0xdd)) return null
      q += 2 + len
      continue
    }
    if (!viuQuadro) return null
    viuSos = true
    // Dados da imagem: até o próximo marcador de verdade (FF seguido de algo que não é 00 nem RSTn).
    q += 2 + len
    for (;;) {
      if (q - ini > MAX_JPG) return null
      const b = await o.ler(q, 64 * 1024)
      if (!b.length) return null
      let achou = -1
      for (let i = 0; i + 1 < b.length; i++) {
        if (b[i] !== 0xff) continue
        const x = b[i + 1]
        if (x === 0x00 || (x >= 0xd0 && x <= 0xd7) || x === 0xff) continue
        achou = i
        break
      }
      if (achou >= 0) {
        q += achou
        break
      }
      q += b.length - 1
    }
  }
  return null
}

async function infoExif(o, exif) {
  if (!exif || exif.len < 14) return null
  const h = await o.ler(exif.pos, 6)
  if (String.fromCharCode(...h) !== 'Exif\0\0') return null
  const base = exif.pos + 6
  return lerTiff((pos, n) => o.ler(base + pos, Math.min(n, Math.max(0, exif.len - 6 - pos))), { max: exif.len }).catch(() => null)
}

// ───── MP4 / MOV / CR3 ─────

async function medirBmff(o, ini) {
  let q = ini
  let tipos = []
  let moovEm = -1
  let limitado = false
  while (q + 8 <= o.tamanho) {
    const h = await o.ler(q, 16)
    if (h.length < 8) break
    let tam = u32be(h, 0)
    const t = tipo4(h, 4)
    if (!TOPO_BMFF.has(t)) break
    if (tam === 1) {
      if (h.length < 16) break
      tam = u32be(h, 8) * 2 ** 32 + u32be(h, 12)
    } else if (tam === 0) {
      tam = o.tamanho - q
      limitado = true
    }
    if (tam < 8) break
    if (q + tam > o.tamanho) {
      tam = o.tamanho - q
      limitado = true
    }
    if (t === 'moov') moovEm = q
    tipos.push(t)
    q += tam
    if (limitado) break
  }
  if (tipos[0] !== 'ftyp' || q - ini < 64) return null
  const temDados = tipos.includes('mdat') || tipos.includes('moof')
  if (!temDados && !tipos.includes('moov')) return null
  const ftyp = await o.ler(ini, 32)
  const marca = tipo4(ftyp, 8)
  const marcas = []
  for (let p = 16; p + 4 <= Math.min(ftyp.length, u32be(ftyp, 0)); p += 4) marcas.push(tipo4(ftyp, p))
  let ext = 'mp4'
  if (marca === 'crx ') ext = 'cr3'
  else if (['heic', 'heix', 'mif1', 'msf1', 'hevc'].includes(marca)) ext = 'heic'
  else if (marca === 'qt  ' || marcas.includes('qt  ')) ext = 'mov'
  let data = ''
  if (moovEm >= 0) {
    // mvhd é o primeiro filho do moov em quase todo arquivo: a data de criação (desde 1904).
    const m = await o.ler(moovEm + 8, 32)
    if (tipo4(m, 4) === 'mvhd') {
      const v = m[8]
      const seg = v === 1 ? u32be(m, 12) * 2 ** 32 + u32be(m, 16) : u32be(m, 12)
      const ms = (seg - 2082844800) * 1000
      if (ms > Date.UTC(2000, 0, 2) && ms < Date.UTC(2100, 0, 1)) data = new Date(ms).toISOString()
    }
  }
  return { fim: q, ext, semIndice: moovEm < 0 && !tipos.includes('moof'), cortado: limitado, data }
}

// ───── a varredura ─────

const dataExif = (s) => {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/.exec(s || '')
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00` : ''
}

/** O que começa em `pos`? Achado ou null. */
async function examinar(o, pos, cab) {
  if (cab[0] === 0xff && cab[1] === 0xd8 && cab[2] === 0xff) {
    const r = await medirJpeg(o, pos)
    if (!r || r.fim - pos < 512) return null
    const ex = await infoExif(o, r.exif)
    return { tipo: 'foto', ext: 'jpg', inicio: pos, tamanho: r.fim - pos, modelo: ex?.model || '', data: dataExif(ex?.data) }
  }
  if (cab[4] === 0x66 && cab[5] === 0x74 && cab[6] === 0x79 && cab[7] === 0x70) {
    const r = await medirBmff(o, pos)
    if (!r) return null
    return {
      tipo: r.ext === 'cr3' || r.ext === 'heic' ? 'foto' : 'video',
      ext: r.ext,
      inicio: pos,
      tamanho: r.fim - pos,
      data: r.data,
      modelo: '',
      defeito: r.semIndice ? 'sem_indice' : r.cortado ? 'cortado' : null,
    }
  }
  const tiff = (cab[0] === 0x49 && cab[1] === 0x49 && cab[2] === 0x2a && cab[3] === 0) || (cab[0] === 0x4d && cab[1] === 0x4d && cab[2] === 0 && cab[3] === 0x2a)
  if (tiff) {
    const r = await lerTiff((p, n) => o.ler(pos + p, n)).catch(() => null)
    if (!r || r.fim < 4096) return null
    return { tipo: 'foto', ext: extTiff(cab, r), inicio: pos, tamanho: r.fim, modelo: r.model || '', data: dataExif(r.data) }
  }
  return null
}

/**
 * Varre `origem` (arquivo de imagem do cartão, ou o próprio cartão quando o sistema deixa ler) e devolve os achados.
 * `tamanho` é obrigatório para dispositivos (o stat deles diz 0).
 * @returns {Promise<object[]>} [{ tipo, ext, inicio, tamanho, data, modelo, defeito }]
 */
export async function varrer({ origem, tamanho = null, inicio = 0, fim = null, onAchado, onProgress, signal } = {}) {
  const fh = await fs.open(origem, 'r')
  const achados = []
  try {
    const total = tamanho ?? (await fh.stat()).size
    const o = new Origem(fh, total)
    const ate = Math.min(fim ?? total, total)
    let pos = Math.ceil(inicio / SETOR) * SETOR
    let ultimo = 0
    while (pos + 8 <= ate) {
      if (signal?.aborted) throw Object.assign(new Error('parado'), { name: 'AbortError' })
      const i = Math.floor(pos / BLOCO)
      const b = await o.bloco(i)
      const base = i * BLOCO
      let proximo = base + b.length
      for (let p = pos - base; p + 8 <= b.length; p += SETOR) {
        const cab = b.subarray(p, p + 16)
        const pode =
          (cab[0] === 0xff && cab[1] === 0xd8 && cab[2] === 0xff) ||
          (cab[4] === 0x66 && cab[5] === 0x74 && cab[6] === 0x79 && cab[7] === 0x70) ||
          (cab[0] === 0x49 && cab[1] === 0x49 && cab[2] === 0x2a) ||
          (cab[0] === 0x4d && cab[1] === 0x4d && cab[2] === 0 && cab[3] === 0x2a)
        if (!pode) continue
        const achado = await examinar(o, base + p, Uint8Array.from(cab))
        if (!achado) continue
        achado.n = achados.length + 1
        achados.push(achado)
        onAchado?.(achado)
        // Pula o arquivo inteiro (a miniatura dentro do RAW ou do vídeo não vira outro achado).
        proximo = Math.ceil((achado.inicio + achado.tamanho) / SETOR) * SETOR
        break
      }
      pos = Math.max(proximo, pos + SETOR)
      if (onProgress && pos - ultimo > 32 * 1024 * 1024) {
        ultimo = pos
        onProgress(Math.min(1, pos / ate), achados.length)
      }
    }
    onProgress?.(1, achados.length)
  } finally {
    await fh.close()
  }
  return achados
}

/** Nome para quem volta sem nome: recuperado_2026-10-12_1432_ILCE-7M4_0001.mp4 (sem data/modelo, só o número). */
export function nomeSugerido(a) {
  const n = String(a.n || 1).padStart(4, '0')
  const d = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(a.data || '')
  const modelo = (a.modelo || '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30)
  return ['recuperado', d ? `${d[1]}_${d[2]}${d[3]}` : null, modelo || null, n].filter(Boolean).join('_') + `.${a.ext}`
}

/** Copia um achado para `pasta` (nunca escreve na origem). Devolve o caminho do arquivo novo. */
export async function extrair({ origem, achado, pasta, nome = nomeSugerido(achado), signal } = {}) {
  await fs.mkdir(pasta, { recursive: true })
  let destino = path.join(pasta, nome)
  for (let k = 2; ; k++) {
    try {
      await fs.access(destino)
      destino = path.join(pasta, nome.replace(/(\.\w+)$/, `-${k}$1`))
    } catch {
      break
    }
  }
  if (path.resolve(destino) === path.resolve(origem)) throw new Error('Salve em outro lugar, nunca em cima da origem.')
  const fh = await fs.open(origem, 'r')
  const out = await fs.open(destino, 'wx')
  try {
    const rs = createReadStream(null, { fd: fh.fd, start: achado.inicio, end: achado.inicio + achado.tamanho - 1, autoClose: false, highWaterMark: 4 * 1024 * 1024 })
    let pos = 0
    for await (const b of rs) {
      if (signal?.aborted) {
        rs.destroy()
        throw Object.assign(new Error('parado'), { name: 'AbortError' })
      }
      await out.write(b, 0, b.length, pos)
      pos += b.length
    }
  } catch (err) {
    await out.close().catch(() => {})
    await fs.rm(destino, { force: true })
    throw err
  } finally {
    await fh.close()
  }
  await out.close()
  return destino
}
