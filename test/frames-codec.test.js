// O codec dentro do MP4/MOV (web/public/app/lib/frames/codec.js): o celular lê só o cabeçalho para dizer o que tem
// dentro (H.264 10-bit 4:2:2 de câmera não abre em iPhone), mesmo com a caixa moov no fim, depois de GB de dados.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { celularAbre, codecDoMoov, lerCodec, porqueNaoAbre, rotuloCodec } from '../web/public/app/lib/frames/codec.js'

const ascii = (s) => [...s].map((c) => c.charCodeAt(0))
const be = (n, w = 4) => Array.from({ length: w }, (_, i) => Math.floor(n / 256 ** (w - 1 - i)) % 256)
const caixa = (t, ...partes) => {
  const corpo = partes.flat()
  return [...be(8 + corpo.length), ...ascii(t), ...corpo]
}

/** Entrada visual (78 bytes) + caixa de configuração. */
const entrada = (fourcc, w, h, cfg = []) => caixa(fourcc, new Array(24).fill(0), be(w, 2), be(h, 2), new Array(50).fill(0), cfg)
const avcC = (perfil, ext = null) => {
  const sps = [0x67, perfil, 0, 0x1f, 1, 2, 3]
  const pps = [0x68, 0xee]
  return caixa('avcC', [1, perfil, 0, 0x1f, 0xff, 0xe1, ...be(sps.length, 2), ...sps, 1, ...be(pps.length, 2), ...pps, ...(ext || [])])
}
const hvcC = (croma, bits) => caixa('hvcC', [1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 120, 0xf0, 0, 0xfc, 0xfc | croma, 0xf8 | (bits - 8), 0xf8 | (bits - 8), 0, 0, 0x0f, 0])
const trak = (handler, stsdEntrada) =>
  caixa(
    'trak',
    caixa('tkhd', new Array(84).fill(0)),
    caixa(
      'mdia',
      caixa('hdlr', [0, 0, 0, 0], ascii('mhlr'), ascii(handler), new Array(12).fill(0)),
      caixa('minf', caixa('hdlr', [0, 0, 0, 0], ascii('dhlr'), ascii('url '), new Array(12).fill(0)), caixa('stbl', caixa('stsd', [0, 0, 0, 0], be(1), stsdEntrada))),
    ),
  )
const moov = (...traks) => caixa('moov', caixa('mvhd', new Array(100).fill(0)), ...traks)
const conteudo = (m) => new Uint8Array(m.slice(8))

describe('codec do vídeo (celular)', () => {
  test('H.264 de câmera em 10-bit 4:2:2: o celular não abre, e a mensagem diz o porquê', () => {
    const c = codecDoMoov(conteudo(moov(trak('soun', caixa('mp4a', new Array(28).fill(0))), trak('vide', entrada('avc1', 3840, 2160, avcC(122, [0xfe, 0xfa, 0xfa, 0]))))))
    assert.deepEqual({ ...c }, { fourcc: 'avc1', largura: 3840, altura: 2160, codec: 'h264', perfil: 122, bits: 10, croma: '4:2:2' })
    assert.equal(rotuloCodec(c), 'H.264 10-bit 4:2:2')
    assert.equal(celularAbre(c), false)
    assert.match(porqueNaoAbre(c, 'C0012.MP4'), /^Este MP4 é H\.264 10-bit 4:2:2, o modo de alta qualidade da câmera/)
    assert.match(porqueNaoAbre(c, 'take.mov'), /^Este MOV é/)
  })

  test('H.264 comum abre; perfil sem extensão usa o próprio perfil; HEVC 4:2:0 abre, 4:2:2 depende; ProRes depende', () => {
    const h = (cfg) => codecDoMoov(conteudo(moov(trak('vide', entrada('avc1', 1920, 1080, cfg)))))
    assert.equal(celularAbre(h(avcC(100, [0xfd, 0xf8, 0xf8, 0]))), true)
    assert.equal(rotuloCodec(h(avcC(100, [0xfd, 0xf8, 0xf8, 0]))), 'H.264 8-bit 4:2:0')
    assert.equal(celularAbre(h(avcC(77))), true)
    assert.equal(rotuloCodec(h(avcC(110))), 'H.264 10-bit 4:2:0')
    assert.equal(celularAbre(h(avcC(110))), false)
    assert.equal(celularAbre(h([])), null, 'sem avcC: não dá para saber')

    const hv = (croma, bits) => codecDoMoov(conteudo(moov(trak('vide', entrada('hvc1', 3840, 2160, hvcC(croma, bits))))))
    assert.equal(rotuloCodec(hv(1, 10)), 'HEVC (H.265) 10-bit 4:2:0')
    assert.equal(celularAbre(hv(1, 10)), true)
    assert.equal(celularAbre(hv(2, 10)), null)

    const pr = codecDoMoov(conteudo(moov(trak('vide', entrada('apch', 1920, 1080)))))
    assert.equal(rotuloCodec(pr), 'ProRes 422 HQ')
    assert.equal(celularAbre(pr), null)
    assert.equal(celularAbre(codecDoMoov(conteudo(moov(trak('vide', entrada('AVdh', 1920, 1080)))))), false)
    assert.equal(codecDoMoov(conteudo(moov(trak('soun', caixa('mp4a', new Array(28).fill(0)))))), null, 'sem trilha de vídeo')
  })

  test('moov no fim de um arquivo de 6 GB: lê só os cabeçalhos das caixas e a moov', async () => {
    const ftyp = caixa('ftyp', ascii('XAVC'), be(0), ascii('XAVCmp42iso2'))
    const m = moov(trak('vide', entrada('avc1', 3840, 2160, avcC(122, [0xfe, 0xfa, 0xfa, 0]))))
    const dados = 6e9
    const mdatCab = [...be(1), ...ascii('mdat'), ...be(Math.floor((dados + 16) / 2 ** 32)), ...be((dados + 16) % 2 ** 32)]
    const posMoov = ftyp.length + 16 + dados
    const tamanho = posMoov + m.length
    const pedidos = []
    const ler = async (a, b) => {
      pedidos.push([a, b])
      const out = new Uint8Array(Math.max(0, Math.min(b, tamanho) - a))
      for (let i = 0; i < out.length; i++) {
        const p = a + i
        out[i] = p < ftyp.length ? ftyp[p] : p < ftyp.length + 16 ? mdatCab[p - ftyp.length] : p >= posMoov ? m[p - posMoov] : 0
      }
      return out
    }
    const c = await lerCodec(ler, tamanho)
    assert.equal(rotuloCodec(c), 'H.264 10-bit 4:2:2')
    assert.ok(pedidos.length <= 3, `${pedidos.length} leituras`)
    assert.ok(pedidos.reduce((s, [a, b]) => s + (b - a), 0) < 70_000, 'não baixa os dados do vídeo')
  })

  test('não é MP4/MOV (MXF, lixo) ou cortado: null, sem erro', async () => {
    const mxf = new Uint8Array([0x06, 0x0e, 0x2b, 0x34, 0x02, 0x05, 0x01, 0x01, ...new Array(100).fill(0)])
    assert.equal(await lerCodec(async (a, b) => mxf.subarray(a, b), mxf.length), null)
    const cortado = new Uint8Array(caixa('ftyp', ascii('isom')).concat(be(5000), ascii('moov'), new Array(40).fill(0)))
    assert.equal(await lerCodec(async (a, b) => cortado.subarray(a, b), cortado.length), null)
    assert.equal(await lerCodec(async () => new Uint8Array(0), 0), null)
  })
})
