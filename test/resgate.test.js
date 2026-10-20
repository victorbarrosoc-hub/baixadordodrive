// Resgate (src/resgate/, docs/CARTOES.md §7): varredura por assinatura numa imagem de cartão montada aqui (JPG com
// miniatura no EXIF, RAW estilo Nikon e Canon, MP4 com índice, MOV sem índice, lixo e um falso começo de JPG), nome
// de quem volta sem nome, extração sem tocar na origem; reconhecimento de quadros H.264/ProRes; e — com um ffmpeg de
// verdade — o conserto de um clipe sem índice saindo igual ao original, quadro a quadro.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { extrair, nomeSugerido, varrer } from '../src/resgate/varredura.js'
import { quadroNal, quadroProRes } from '../src/resgate/nal.js'
import { consertarVideo } from '../src/resgate/consertar.js'

const JPG_16 = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDOooorjPoz/9k=',
  'base64',
)

// ───── montar arquivos ─────

/** TIFF little-endian com IFD0 (entradas dadas) e dados extras; devolve o buffer. */
function tiff({ cr2 = false, make, model, data, faixa = 8192 }) {
  const asc = (s) => Buffer.from(s + '\0', 'latin1')
  const mk = asc(make)
  const md = asc(model)
  const dt = asc(data)
  // Layout: cabeçalho (16) | IFD0 | EXIF IFD | textos | faixa de dados.
  const n0 = 5
  const ifd0 = 16
  const exif = ifd0 + 2 + n0 * 12 + 4
  const textos = exif + 2 + 12 + 4
  const pMk = textos
  const pMd = pMk + mk.length + (mk.length % 2)
  const pDt = pMd + md.length + (md.length % 2)
  const pFaixa = Math.ceil((pDt + dt.length) / 16) * 16
  const b = Buffer.alloc(pFaixa + faixa)
  b.write('II*\0', 0, 'latin1')
  b.writeUInt32LE(ifd0, 4)
  if (cr2) b.write('CR\x02\x00', 8, 'latin1')
  let p = ifd0
  b.writeUInt16LE(n0, p)
  p += 2
  const ent = (tag, tipo, cnt, val) => {
    b.writeUInt16LE(tag, p)
    b.writeUInt16LE(tipo, p + 2)
    b.writeUInt32LE(cnt, p + 4)
    b.writeUInt32LE(val, p + 8)
    p += 12
  }
  ent(0x010f, 2, mk.length, pMk)
  ent(0x0110, 2, md.length, pMd)
  ent(0x0111, 4, 1, pFaixa)
  ent(0x0117, 4, 1, faixa)
  ent(0x8769, 4, 1, exif)
  b.writeUInt32LE(0, p)
  p = exif
  b.writeUInt16LE(1, p)
  p += 2
  ent(0x9003, 2, dt.length, pDt)
  b.writeUInt32LE(0, p)
  mk.copy(b, pMk)
  md.copy(b, pMd)
  dt.copy(b, pDt)
  crypto.randomFillSync(b, pFaixa, faixa)
  return b
}

/** JPG com APP1/EXIF (modelo, data e uma miniatura JPG dentro). */
function jpgComExif(model, data) {
  const t = tiff({ make: 'SONY', model, data, faixa: 16 })
  // IFD1 com a miniatura: pendura no fim (o próximo IFD do IFD0 aponta para ela).
  const ifd1 = t.length
  const mini = JPG_16
  const corpo = Buffer.alloc(2 + 2 * 12 + 4)
  corpo.writeUInt16LE(2, 0)
  corpo.writeUInt16LE(0x0201, 2)
  corpo.writeUInt16LE(4, 4)
  corpo.writeUInt32LE(1, 6)
  corpo.writeUInt32LE(ifd1 + corpo.length, 10)
  corpo.writeUInt16LE(0x0202, 14)
  corpo.writeUInt16LE(4, 16)
  corpo.writeUInt32LE(1, 18)
  corpo.writeUInt32LE(mini.length, 22)
  t.writeUInt32LE(ifd1, 16 + 2 + 5 * 12) // próximo IFD do IFD0
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t, corpo, mini])
  const app1 = Buffer.alloc(4)
  app1.writeUInt16BE(0xffe1, 0)
  app1.writeUInt16BE(exif.length + 2, 2)
  // Uma foto "grande" (o JPG de 16 px repetido não serve: usa o mesmo, com o EXIF na frente).
  return Buffer.concat([JPG_16.subarray(0, 2), app1, exif, JPG_16.subarray(2)])
}

function caixa(tipo, corpo) {
  const h = Buffer.alloc(8)
  h.writeUInt32BE(8 + corpo.length, 0)
  h.write(tipo, 4, 'latin1')
  return Buffer.concat([h, corpo])
}

function mp4({ comMoov = true, marca = 'isom', dados = 6000, criado = Date.UTC(2026, 9, 12, 14, 32) } = {}) {
  const ftyp = caixa('ftyp', Buffer.concat([Buffer.from(marca, 'latin1'), Buffer.alloc(4), Buffer.from(marca + 'mp41', 'latin1')]))
  const mdat = caixa('mdat', crypto.randomBytes(dados))
  if (!comMoov) return Buffer.concat([ftyp, mdat])
  const mvhd = Buffer.alloc(100)
  mvhd.writeUInt32BE(Math.floor(criado / 1000) + 2082844800, 4)
  mvhd.writeUInt32BE(1000, 12)
  return Buffer.concat([ftyp, mdat, caixa('moov', caixa('mvhd', mvhd))])
}

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex')

describe('varredura por assinatura', () => {
  let dir
  let imagem
  let mapa
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resgate-'))
    const partes = []
    let tam = 0
    const por = (b) => {
      partes.push(b)
      tam += b.length
    }
    const alinhar = () => por(Buffer.alloc((32768 - (tam % 32768)) % 32768))
    const lixo = (n, falsoJpg = false) => {
      const b = crypto.randomBytes(n)
      // Nada de assinatura por acaso nos começos de setor (o falso JPG é de propósito).
      for (let s = 0; s < n; s += 512) b[s] = 0
      if (falsoJpg) b.set([0xff, 0xd8, 0xff, 0xe0], 512)
      por(b)
    }
    mapa = []
    const arquivo = (nome, b) => {
      alinhar()
      mapa.push({ nome, inicio: tam, tamanho: b.length, md5: md5(b) })
      por(b)
    }
    lixo(65536)
    arquivo('foto', jpgComExif('ILCE-7M4', '2026:10:12 14:32:05'))
    lixo(40000, true)
    arquivo('nef', tiff({ make: 'NIKON CORPORATION', model: 'NIKON Z 6_2', data: '2026:10:12 15:00:00', faixa: 20000 }))
    arquivo('cr2', tiff({ cr2: true, make: 'Canon', model: 'Canon EOS R6', data: '2026:10:13 09:05:00', faixa: 12000 }))
    arquivo('mp4', mp4())
    arquivo('mov', mp4({ marca: 'qt  ', comMoov: false }))
    lixo(5000)
    imagem = path.join(dir, 'cartao.img')
    fs.writeFileSync(imagem, Buffer.concat(partes))
  })
  after(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('acha cada arquivo, com o tamanho certo, e nada a mais', async () => {
    const antes = md5(fs.readFileSync(imagem))
    const achados = []
    const r = await varrer({ origem: imagem, onAchado: (a) => achados.push(a) })
    assert.deepEqual(r, achados)
    assert.deepEqual(
      r.map((a) => [a.inicio, a.tamanho, a.ext]),
      mapa.map((m) => [m.inicio, m.tamanho, { foto: 'jpg', nef: 'nef', cr2: 'cr2', mp4: 'mp4', mov: 'mov' }[m.nome]]),
    )
    assert.equal(r[4].defeito, 'sem_indice', 'vídeo sem índice vai para o Consertar')
    assert.equal(r[3].defeito, null)
    assert.equal(md5(fs.readFileSync(imagem)), antes, 'a origem não muda')
  })

  test('nome de quem volta sem nome: data, câmera e número', async () => {
    const r = await varrer({ origem: imagem })
    assert.equal(nomeSugerido(r[0]), 'recuperado_2026-10-12_1432_ILCE-7M4_0001.jpg')
    assert.equal(nomeSugerido(r[1]), 'recuperado_2026-10-12_1500_NIKON-Z-6_2_0002.nef')
    assert.equal(nomeSugerido(r[2]), 'recuperado_2026-10-13_0905_Canon-EOS-R6_0003.cr2')
    assert.equal(nomeSugerido(r[3]), 'recuperado_2026-10-12_1432_0004.mp4')
    assert.equal(nomeSugerido(r[4]), 'recuperado_0005.mov')
  })

  test('extrair copia o arquivo igual e nunca sobrescreve', async () => {
    const r = await varrer({ origem: imagem })
    const pasta = path.join(dir, 'saida')
    for (const [i, a] of r.entries()) {
      const dest = await extrair({ origem: imagem, achado: a, pasta })
      assert.equal(md5(fs.readFileSync(dest)), mapa[i].md5, mapa[i].nome)
    }
    const de_novo = await extrair({ origem: imagem, achado: r[0], pasta })
    assert.match(path.basename(de_novo), /-2\.jpg$/)
  })
})

describe('quadros de vídeo nos dados soltos', () => {
  const nal = (tipo, ref, corpo) => {
    const b = Buffer.concat([Buffer.from([(ref << 5) | tipo]), Buffer.from(corpo)])
    const h = Buffer.alloc(4)
    h.writeUInt32BE(b.length, 0)
    return Buffer.concat([h, b])
  }
  test('H.264: SEI + IDR = um quadro-chave; P seguinte é outro quadro; lixo não vira quadro', () => {
    // first_mb = 0 ("1"), slice_type 7 = I ("0001000"), pps 0 ("1") → 1000 1000 1…
    const idr = nal(5, 3, [0x88, 0x84, 0x00, 0x33, 0x44])
    const sei = nal(6, 0, [0x05, 0x02, 0x10, 0x20, 0x80])
    const p = nal(1, 2, [0x9a, 0x02, 0x40, 0x11]) // first_mb 0, slice_type 0 (P), pps 0
    const b = new Uint8Array(Buffer.concat([sei, idr, p]))
    const q1 = quadroNal(b, 0, b.length)
    assert.deepEqual([q1.tam, q1.chave], [sei.length + idr.length, true])
    const q2 = quadroNal(b, q1.tam, b.length)
    assert.deepEqual([q2.tam, q2.chave], [p.length, false])
    assert.equal(quadroNal(new Uint8Array(crypto.randomBytes(64).fill(0, 0, 4)), 0, 64), null)
  })
  test('ProRes: tamanho + "icpf"', () => {
    const b = Buffer.alloc(200)
    b.writeUInt32BE(150, 0)
    b.write('icpf', 4, 'latin1')
    assert.deepEqual(quadroProRes(new Uint8Array(b), 0, 200), { tam: 150, chave: true })
    assert.equal(quadroProRes(new Uint8Array(b), 0, 100), null)
  })
})

// ───── conserto com vídeo de verdade ─────

const ffmpeg = (() => {
  const r = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' })
  const p = r.stdout?.trim()
  if (!p) return null
  const enc = spawnSync(p, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || ''
  return enc.includes('libx264') ? p : null
})()

describe('consertar clipe sem índice', { skip: !ffmpeg && 'sem ffmpeg com libx264 neste computador' }, () => {
  let dir
  const gerar = (arq, src, s) =>
    spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${src}=size=640x360:rate=25`, '-f', 'lavfi', '-i', 'sine=sample_rate=48000', '-t', String(s), '-c:v', 'libx264', '-preset', 'veryfast', '-bf', '2', '-g', '12', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ac', '2', arq])
  const framemd5 = (arq) =>
    spawnSync(ffmpeg, ['-v', 'error', '-i', arq, '-map', '0:v', '-f', 'framemd5', '-'], { encoding: 'utf8' })
      .stdout.split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(',').map((x) => x.trim()))
      .map((c) => `${c[1]} ${c[5]}`)
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conserto-'))
    gerar(path.join(dir, 'ref.mov'), 'testsrc2', 3)
    gerar(path.join(dir, 'take.mov'), 'testsrc', 5)
    const b = fs.readFileSync(path.join(dir, 'take.mov'))
    fs.writeFileSync(path.join(dir, 'quebrado.mov'), b.subarray(0, b.lastIndexOf(Buffer.from('moov')) - 4))
  })
  after(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('volta igual ao original, quadro a quadro, com som; o quebrado não muda', async () => {
    const antes = md5(fs.readFileSync(path.join(dir, 'quebrado.mov')))
    const saida = path.join(dir, 'consertado.mov')
    const r = await consertarVideo({ quebrado: path.join(dir, 'quebrado.mov'), referencia: path.join(dir, 'ref.mov'), saida })
    assert.equal(r.quadros, 125)
    assert.equal(Math.round(r.duracaoS), 5)
    assert.deepEqual(r.faixas.map((f) => f.tipo), ['video', 'audio'])
    assert.deepEqual(framemd5(saida), framemd5(path.join(dir, 'take.mov')))
    assert.equal(md5(fs.readFileSync(path.join(dir, 'quebrado.mov'))), antes)
    await assert.rejects(consertarVideo({ quebrado: path.join(dir, 'quebrado.mov'), referencia: path.join(dir, 'ref.mov'), saida }), /EEXIST/, 'não sobrescreve')
  })

  test('clipe inteiro e referência sem índice são recusados', async () => {
    await assert.rejects(consertarVideo({ quebrado: path.join(dir, 'take.mov'), referencia: path.join(dir, 'ref.mov'), saida: path.join(dir, 'x.mov') }), { codigo: 'inteiro' })
    await assert.rejects(consertarVideo({ quebrado: path.join(dir, 'quebrado.mov'), referencia: path.join(dir, 'quebrado.mov'), saida: path.join(dir, 'y.mov') }), { codigo: 'referencia' })
  })
})
