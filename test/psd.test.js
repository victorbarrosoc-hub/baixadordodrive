// PSD no celular (web/public/app/lib/psd-ler.js): cabeçalho, miniatura gravada pelo Photoshop, camadas com grupos,
// nome unicode e prancheta (descritor), e a imagem final (RLE e sem compressão, RGB, CMYK, 16 bits, PSB, recorte).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { desenhar, lerCabecalho, lerCamadas, miniaturaDosRecursos, NaoEPsd, prepararComposta } from '../web/public/app/lib/psd-ler.js'

// ───── um PSD montado à mão ─────

class W {
  constructor() {
    this.a = []
  }
  u8(x) {
    this.a.push(x & 255)
    return this
  }
  u16(x) {
    return this.u8(x >> 8).u8(x)
  }
  u32(x) {
    return this.u16(x >>> 16).u16(x & 0xffff)
  }
  u64(x) {
    return this.u32(Math.floor(x / 2 ** 32)).u32(x >>> 0)
  }
  i32(x) {
    return this.u32(x >>> 0)
  }
  f64(x) {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setFloat64(0, x)
    return this.raw(b)
  }
  ascii(s) {
    for (const c of s) this.u8(c.charCodeAt(0))
    return this
  }
  raw(b) {
    for (const x of b) this.a.push(x)
    return this
  }
  uni(s) {
    this.u32(s.length + 1)
    for (const c of s) this.u16(c.charCodeAt(0))
    return this.u16(0)
  }
  id(s) {
    return s.length === 4 ? this.u32(0).ascii(s) : this.u32(s.length).ascii(s)
  }
  bytes() {
    return Uint8Array.from(this.a)
  }
}

function packbits(row) {
  // Uma sequência literal de até 128 bytes por vez, e repetição quando tudo é igual (para testar os dois).
  const w = new W()
  let i = 0
  while (i < row.length) {
    let j = i
    while (j + 1 < row.length && row[j + 1] === row[i] && j - i < 127) j++
    if (j > i) {
      w.u8(257 - (j - i + 1)).u8(row[i])
      i = j + 1
    } else {
      const n = Math.min(128, row.length - i)
      w.u8(n - 1).raw(row.subarray(i, i + n))
      i += n
    }
  }
  return w.bytes()
}

function artboardDescriptor({ left, top, right, bottom }) {
  const w = new W()
  w.u32(16) // versão
  w.uni('').id('artboard').u32(1)
  w.id('artboardRect').ascii('Objc')
  w.uni('').id('classFloatRect').u32(4)
  w.id('Top ').ascii('doub').f64(top)
  w.id('Left').ascii('doub').f64(left)
  w.id('Btom').ascii('doub').f64(bottom)
  w.id('Rght').ascii('doub').f64(right)
  return w.bytes()
}

function layerRecord(w, { name, uni, divider, artboard, psb }) {
  w.i32(0).i32(0).i32(0).i32(0)
  w.u16(0) // sem canais (os pixels das camadas não interessam aqui)
  w.ascii('8BIM').ascii('norm').u8(255).u8(0).u8(0).u8(0)
  const extra = new W()
  extra.u32(0).u32(0)
  const n = Math.min(255, name.length)
  extra.u8(n).ascii(name.slice(0, n))
  for (let p = (n + 1) % 4; p && p < 4; p++) extra.u8(0)
  const info = (key, data) => {
    extra.ascii('8BIM').ascii(key)
    psb && ['LMsk', 'Lr16'].includes(key) ? extra.u64(data.length) : extra.u32(data.length)
    extra.raw(data)
  }
  if (uni) {
    const u = new W().uni(uni)
    while (u.a.length % 4) u.u8(0)
    info('luni', u.bytes())
  }
  if (divider != null) info('lsct', new W().u32(divider).bytes())
  if (artboard) info('artb', artboardDescriptor(artboard))
  const e = extra.bytes()
  w.u32(e.length).raw(e)
}

function montarPsd({ w: W_, h: H, modo = 3, canais = 3, prof = 8, psb = false, rle = true, px, mini = null, camadas = [] }) {
  const f = new W()
  f.ascii('8BPS').u16(psb ? 2 : 1).raw(new Uint8Array(6)).u16(canais).u32(H).u32(W_).u16(prof).u16(modo)
  f.u32(0) // dados de cor
  const rec = new W()
  if (mini) {
    rec.ascii('8BIM').u16(1036).u8(0).u8(0)
    const d = new W().u32(1).u32(10).u32(10).u32(32).u32(320).u32(mini.length).u16(24).u16(1).raw(mini)
    const b = d.bytes()
    rec.u32(b.length).raw(b)
    if (b.length % 2) rec.u8(0)
  }
  const r = rec.bytes()
  f.u32(r.length).raw(r)
  // Camadas: registros de baixo para cima.
  const li = new W()
  li.u16(camadas.length)
  for (const c of camadas) layerRecord(li, { ...c, psb })
  const lib = li.bytes()
  const lm = new W()
  psb ? lm.u64(lib.length).raw(lib).u32(0) : lm.u32(lib.length).raw(lib).u32(0)
  const lmb = lm.bytes()
  psb ? f.u64(lmb.length) : f.u32(lmb.length)
  f.raw(lmb)
  // Imagem final, canal por canal.
  const bps = prof / 8
  f.u16(rle ? 1 : 0)
  const linhas = []
  for (let c = 0; c < canais; c++)
    for (let y = 0; y < H; y++) {
      const row = new Uint8Array(W_ * bps)
      for (let x = 0; x < W_; x++) {
        const v = px(x, y, c)
        if (bps === 2) {
          row[x * 2] = v
          row[x * 2 + 1] = 0x7f
        } else row[x] = v
      }
      linhas.push(rle ? packbits(row) : row)
    }
  if (rle) for (const l of linhas) psb ? f.u32(l.length) : f.u16(l.length)
  for (const l of linhas) f.raw(l)
  return f.bytes()
}

function abrir(bytes) {
  const cab = lerCabecalho(bytes.subarray(0, 65536))
  const mini = miniaturaDosRecursos(bytes.subarray(cab.recursosEm + 4, cab.camadasEm))
  const cam = lerCamadas(bytes.subarray(cab.camadasEm), { psb: cab.psb, camadasEm: cab.camadasEm })
  const comp = prepararComposta(bytes.subarray(cam.compostaEm), cab)
  return { cab, mini, cam, comp }
}

const pixel = (img, x, y) => Array.from(img.rgba.subarray((y * img.largura + x) * 4, (y * img.largura + x) * 4 + 4))

// Imagem de teste: metade esquerda vermelha, direita azul; uma faixa com degradê para a RLE ter literais.
const cores = (x, y, c) => {
  if (y === 3) return (x * 7 + c * 40) & 255
  const esq = x < 50
  return [esq ? 220 : 10, esq ? 30 : 60, esq ? 20 : 230][c]
}

describe('PSD', () => {
  test('cabeçalho, miniatura, camadas com grupo, nome unicode e prancheta', () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
    const bytes = montarPsd({
      w: 100,
      h: 40,
      px: cores,
      mini: jpeg,
      camadas: [
        { name: '</Layer group>', divider: 3 },
        { name: 'Fundo' },
        { name: 'Logo', uni: 'Logo ZRO — branco' },
        { name: 'Feed', divider: 1, artboard: { left: 0, top: 0, right: 50, bottom: 40 } },
        { name: 'Solta' },
      ],
    })
    const { cab, mini, cam } = abrir(bytes)
    assert.deepEqual([cab.largura, cab.altura, cab.modo, cab.prof, cab.psb], [100, 40, 3, 8, false])
    assert.deepEqual(Array.from(mini), Array.from(jpeg))
    assert.equal(cam.parcial, false)
    assert.deepEqual(
      cam.camadas.map((c) => [c.nome, c.grupo, c.nivel]),
      [
        ['Solta', false, 0],
        ['Feed', true, 0],
        ['Logo ZRO — branco', false, 1],
        ['Fundo', false, 1],
      ],
    )
    assert.deepEqual(cam.pranchetas, [{ nome: 'Feed', rect: { left: 0, top: 0, right: 50, bottom: 40 } }])
  })

  test('imagem final RLE: cores, redução e recorte da prancheta', () => {
    const { comp } = abrir(montarPsd({ w: 100, h: 40, px: cores }))
    const img = desenhar(comp, { max: 1000 })
    assert.deepEqual([img.largura, img.altura, img.alfa], [100, 40, false])
    assert.deepEqual(pixel(img, 10, 10), [220, 30, 20, 255])
    assert.deepEqual(pixel(img, 90, 10), [10, 60, 230, 255])
    assert.deepEqual(pixel(img, 5, 3), [35, 75, 115, 255], 'linha com literais')
    const meia = desenhar(comp, { max: 50 })
    assert.deepEqual([meia.largura, meia.altura], [50, 20])
    assert.deepEqual(pixel(meia, 40, 5), [10, 60, 230, 255])
    const recorte = desenhar(comp, { rect: { left: 50, top: 0, right: 100, bottom: 40 }, max: 1000 })
    assert.deepEqual([recorte.largura, recorte.altura], [50, 40])
    assert.deepEqual(pixel(recorte, 0, 0), [10, 60, 230, 255])
  })

  test('sem compressão, 16 bits, PSB e CMYK', () => {
    const raw = desenhar(abrir(montarPsd({ w: 100, h: 40, px: cores, rle: false })).comp)
    assert.deepEqual(pixel(raw, 10, 10), [220, 30, 20, 255])
    const p16 = desenhar(abrir(montarPsd({ w: 100, h: 40, px: cores, prof: 16 })).comp)
    assert.deepEqual(pixel(p16, 90, 10), [10, 60, 230, 255])
    const psb = abrir(montarPsd({ w: 100, h: 40, px: cores, psb: true, camadas: [{ name: 'A' }] }))
    assert.equal(psb.cab.psb, true)
    assert.equal(psb.cam.camadas[0].nome, 'A')
    assert.deepEqual(pixel(desenhar(psb.comp), 10, 10), [220, 30, 20, 255])
    // CMYK invertido: C=0 (255), M=255 (0), Y=255 (0), K=0 (255) → vermelho puro.
    const cmyk = desenhar(abrir(montarPsd({ w: 4, h: 2, modo: 4, canais: 4, px: (x, y, c) => [255, 0, 0, 255][c] })).comp)
    assert.deepEqual(pixel(cmyk, 1, 1), [255, 0, 0, 255])
  })

  test('arquivo que não é PSD e camadas cortadas no meio', () => {
    assert.throws(() => lerCabecalho(new TextEncoder().encode('GIF89a qualquer coisa aqui ok')), NaoEPsd)
    const bytes = montarPsd({ w: 10, h: 2, px: () => 0, camadas: [{ name: 'Um' }, { name: 'Dois' }, { name: 'Três camadas longas' }] })
    const cab = lerCabecalho(bytes)
    const cortado = bytes.subarray(cab.camadasEm, cab.camadasEm + 60)
    const cam = lerCamadas(cortado, { camadasEm: cab.camadasEm })
    assert.equal(cam.parcial, true)
    assert.ok(cam.compostaEm > cab.camadasEm, 'mesmo cortado, sabe onde fica a imagem final')
  })
})
