// Busca por cena (src/cenas/): tokenizador, índice (trechos, 8 bits, busca), download conferido do modelo e o serviço
// de ponta a ponta com um vídeo de cores servido como o Drive (com token) e um "modelo" de mentira que enxerga a cor
// média — o modelo de verdade (228 MB) não baixa no teste.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { criarTokenizador, normalizar, separar } from '../src/cenas/texto.js'
import { DIM, LADO, lerSafetensors, normalizarVetor, pixelsParaTensor } from '../src/cenas/modelo.js'
import { buscar, desempacotar, desquantizar, empacotar, quantizar, trechos } from '../src/cenas/indice.js'
import { ArquivosModelo } from '../src/cenas/arquivos.js'
import { CenasService } from '../src/cenas/servico.js'
import { makeTmpDir } from './helpers.js'

const tmp = async (t) => {
  const d = await makeTmpDir('sobedesce-cenas-')
  t.after(() => fsp.rm(d, { recursive: true, force: true }))
  return d
}

const temFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

/** Vetor "de cor": o eixo 0 é vermelho, 1 verde, 2 azul (o resto zero). */
const cor = (r, g, b) => {
  const v = new Float32Array(DIM)
  v[0] = r
  v[1] = g
  v[2] = b
  v[3] = 0.05
  return normalizarVetor(v)
}

describe('busca por cena', () => {
  test('tokenizador WordPiece: normaliza, separa pontuação e quebra em pedaços do vocabulário', () => {
    assert.equal(normalizar('noiva\u0007 com\tbuquê'), 'noiva com buquê')
    assert.deepEqual(separar('DJ, tocando!'), ['DJ', ',', 'tocando', '!'])
    const vocab = { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3, noiva: 4, com: 5, o: 6, bu: 7, '##quê': 8, ',': 9, DJ: 10 }
    const t = criarTokenizador({ model: { vocab, unk_token: '[UNK]', continuing_subword_prefix: '##' } })
    assert.deepEqual(t.codificar('noiva com o buquê, DJ'), [2, 4, 5, 6, 7, 8, 9, 10, 3])
    assert.deepEqual(t.codificar('xilofone'), [2, 1, 3], 'palavra fora do vocabulário vira [UNK]')
    assert.equal(t.codificar('noiva '.repeat(200), 16).length, 16, 'corta no tamanho máximo, com [SEP] no fim')
    assert.throws(() => criarTokenizador({ model: {} }))
  })

  test('modelo: safetensors e pixels no formato do CLIP', () => {
    const dados = Float32Array.from({ length: 6 }, (_, i) => i / 2)
    const cab = Buffer.from(JSON.stringify({ 'linear.weight': { dtype: 'F32', shape: [2, 3], data_offsets: [0, 24] } }))
    const len = Buffer.alloc(8)
    len.writeBigUInt64LE(BigInt(cab.length))
    const t = lerSafetensors(Buffer.concat([len, cab, Buffer.from(dados.buffer)]), 'linear.weight')
    assert.deepEqual(t.forma, [2, 3])
    assert.deepEqual(Array.from(t.dados), Array.from(dados))
    const rgb = new Uint8Array(LADO * LADO * 3).fill(255)
    const px = pixelsParaTensor(rgb, new Float32Array(3 * LADO * LADO))
    assert.ok(Math.abs(px[0] - (1 - 0.48145466) / 0.26862954) < 1e-5, 'canal R normalizado')
    assert.ok(Math.abs(px[2 * LADO * LADO] - (1 - 0.40821073) / 0.27577711) < 1e-5, 'canal B vem depois de todo o G')
  })

  test('índice: amostras parecidas viram um trecho; 8 bits voltam quase iguais; a busca ordena', () => {
    const amostras = [0, 2, 4, 6, 8, 10].map((t) => ({ t, v: t < 6 ? cor(1, 0, 0) : cor(0, 0, 1) }))
    const ts = trechos(amostras, 2)
    assert.equal(ts.length, 2)
    assert.deepEqual([ts[0].ini, ts[0].fim, ts[1].ini, ts[1].fim], [0, 6, 6, 12])
    assert.equal(trechos([0, 2, 4, 6, 8, 10, 12].map((t) => ({ t, v: cor(1, 0, 0) })), 2, { maxS: 6 }).length, 3, 'plano longo se divide')
    const v = cor(0.3, 0.6, 0.1)
    const volta = desquantizar(quantizar(v))
    let s = 0
    for (let i = 0; i < DIM; i++) s += v[i] * volta[i]
    assert.ok(s > 0.999)
    const j = empacotar({ arquivo: { id: 'v1', nome: 'a.mp4' }, origem: 'proxy', duracao: 12, passo: 2, trechos: ts })
    assert.equal(typeof j.vetores, 'string')
    const ind = desempacotar(JSON.parse(JSON.stringify(j)))
    assert.equal(ind.trechos.length, 2)
    assert.equal(desempacotar({ ...j, versao: 99 }), null)
    assert.equal(desempacotar({ ...j, vetores: 'AAAA' }), null)
    const rs = buscar(cor(0, 0, 1), [ind])
    assert.equal(rs[0].ini, 6)
    assert.ok(rs[0].nota >= rs[1].nota)
  })

  test('modelo: baixa conferindo o SHA-256; arquivo diferente é apagado e dá erro', async (t) => {
    const dir = await tmp(t)
    const certo = Buffer.from('conteúdo do modelo')
    const sha = crypto.createHash('sha256').update(certo).digest('hex')
    const resposta = (buf) => new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } })
    let vezes = 0
    const a = new ArquivosModelo({ dir, arquivos: { x: { nome: 'x.bin', url: 'https://exemplo/x', tamanho: certo.length, sha256: sha } }, fetch: async () => (vezes++, resposta(certo)) })
    assert.equal(await a.prontos(), false)
    const caminhos = await a.baixar()
    assert.equal(await a.prontos(), true)
    assert.deepEqual(await fsp.readFile(caminhos.x), certo)
    await a.baixar()
    assert.equal(vezes, 1, 'já baixado: não baixa de novo')

    const dir2 = await tmp(t)
    const errado = Buffer.from('conteúdo trocado!!')
    const b = new ArquivosModelo({ dir: dir2, arquivos: { x: { nome: 'x.bin', url: 'https://exemplo/x', tamanho: errado.length, sha256: sha } }, fetch: async () => resposta(errado) })
    await assert.rejects(b.baixar(), /veio diferente/)
    assert.deepEqual(await fsp.readdir(dir2), [], 'nada fica no disco')
  })

  test('serviço: analisa a pasta pelo "Drive" (com token), acha a cor pedida, salva o trecho e não repete', { skip: !temFfmpeg && 'sem ffmpeg' }, async (t) => {
    const dir = await tmp(t)
    // 18 s: vermelho, verde, azul (6 s cada), quadro-chave a cada 1 s.
    const video = path.join(dir, 'cores.mp4')
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=320x180:r=25:d=6', '-f', 'lavfi', '-i', 'color=green:s=320x180:r=25:d=6', '-f', 'lavfi', '-i', 'color=blue:s=320x180:r=25:d=6', '-filter_complex', '[0][1][2]concat=n=3:v=1', '-c:v', 'libx264', '-g', '25', '-pix_fmt', 'yuv420p', video])
    assert.equal(r.status, 0, String(r.stderr))
    const tam = fs.statSync(video).size
    let semToken = 0
    const srv = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer t0k3n') {
        semToken++
        res.writeHead(401)
        return res.end()
      }
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '')
      const ini = m ? Number(m[1]) : 0
      const fim = m && m[2] ? Number(m[2]) : tam - 1
      res.writeHead(m ? 206 : 200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': fim - ini + 1, ...(m ? { 'content-range': `bytes ${ini}-${fim}/${tam}` } : {}) })
      fs.createReadStream(video, { start: ini, end: fim }).pipe(res)
    })
    await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
    t.after(() => srv.close())
    const base = `http://127.0.0.1:${srv.address().port}`
    const item = { id: 'v1', name: 'Cores.mp4', size: String(tam), md5Checksum: 'm1', parents: ['p1'], mimeType: 'video/mp4', relDir: 'Cam A' }
    const walk = { items: [item, { id: 'px', name: 'Cores.mp4', relPath: 'Cam A/Proxy/Cores.mp4', appProperties: { sobedesce: 'previa' } }, { id: 'pdf', name: 'roteiro.pdf', mimeType: 'application/pdf' }] }
    const drive = { walk: async () => walk, mediaUrl: (id) => `${base}/${id}`, authHeader: async () => ({ authorization: 'Bearer t0k3n' }) }
    // "Modelo": a cor média de cada imagem; o texto "vermelho/verde/azul" vira o eixo da cor.
    let imagens = 0
    const modelo = {
      abrir: async () => {},
      imagens: async (lista) =>
        lista.map((rgb) => {
          imagens++
          let r = 0
          let g = 0
          let b = 0
          for (let i = 0; i < rgb.length; i += 3) [r, g, b] = [r + rgb[i], g + rgb[i + 1], b + rgb[i + 2]]
          return cor(r, g, b)
        }),
      texto: async (frase) => (/vermelh/.test(frase) ? cor(1, 0, 0) : /verde/.test(frase) ? cor(0, 1, 0) : cor(0, 0, 1)),
      fechar: async () => {},
    }
    const arquivos = { prontos: async () => true, status: () => ({ baixando: false, progresso: null, erro: null, total: 1 }), caminhos: () => ({}) }
    const mudancas = []
    const svc = new CenasService({ dataRoot: dir, drive: () => drive, motor: async () => ({ ffmpeg: { path: 'ffmpeg' } }), pastaTrechos: () => path.join(dir, 'Cenas'), onChange: (v) => mudancas.push(v), arquivos, modelo, ort: {} })
    t.after(() => svc.close())
    await svc.init()

    const a = await svc.analisarPasta({ accountId: 'nuvem:g1', folderId: 'p1' })
    assert.deepEqual(a, { novos: 1, prontos: 0, total: 1 }, 'o proxy e o PDF ficam de fora')
    for (let i = 0; i < 300 && svc.view().analisando; i++) await new Promise((ok) => setTimeout(ok, 50))
    const f = svc.view().fila[0]
    assert.equal(f.fase, 'pronto', f.erro)
    assert.equal(f.trechos, 3, 'três cores, três trechos')
    assert.equal(semToken, 0, 'todo pedido ao "Drive" levou o token')
    assert.ok(imagens >= 8 && imagens <= 10, `amostras a cada 2 s (${imagens})`)

    const p = await svc.pasta({ accountId: 'nuvem:g1', folderId: 'p1' })
    assert.equal(p.videos.length, 1)
    const busca = await svc.procurar({ accountId: 'nuvem:g1', texto: 'o azul' })
    assert.equal(busca.resultados[0].ini, 12)
    assert.equal(busca.resultados[0].item.name, 'Cores.mp4', 'leva o necessário para abrir a prévia')
    assert.equal((await svc.procurar({ accountId: 'nuvem:g1', texto: 'verde' })).resultados[0].ini, 6)
    assert.equal((await svc.procurar({ accountId: 'outra', texto: 'verde' })).resultados.length, 0, 'índices são por conta')
    assert.ok((await fsp.stat(await svc.miniatura({ accountId: 'nuvem:g1', fileId: 'v1', i: 1 }))).size > 100)
    await assert.rejects(svc.miniatura({ accountId: 'nuvem:g1', fileId: 'v1', i: '../x' }), /inválida/)

    // Mesma versão do arquivo: não analisa de novo.
    assert.deepEqual(await svc.analisarPasta({ accountId: 'nuvem:g1', folderId: 'p1' }), { novos: 0, prontos: 1, total: 1 })

    // Salvar trecho: corta do original sem recodificar.
    const { caminho } = await svc.salvarTrecho({ accountId: 'nuvem:g1', fileId: 'v1', ini: 6, fim: 12 })
    assert.match(path.basename(caminho), /^Cores_00-00-06\.mp4$/)
    const dur = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', caminho]).stdout.toString())
    assert.ok(dur > 5 && dur < 7.5, `duração ${dur}`)

    // Esquecer apaga índice e miniaturas.
    assert.deepEqual(await svc.esquecer({ accountId: 'nuvem:g1' }), { apagados: 1 })
    assert.equal((await svc.procurar({ accountId: 'nuvem:g1', texto: 'azul' })).resultados.length, 0)
    assert.ok(mudancas.length > 0, 'avisou a tela pelo SSE')
    assert.deepEqual(await fsp.readdir(path.join(dir, 'cenas', 'tmp')), [], 'sem temporários')
  })

  test('serviço: sem o onnxruntime neste computador, avisa em vez de quebrar', async (t) => {
    const dir = await tmp(t)
    const svc = new CenasService({ dataRoot: dir, drive: () => ({}), motor: async () => ({}), arquivos: { prontos: async () => false, status: () => ({ baixando: false, total: 1 }) }, ort: null })
    svc.disponivel = false
    assert.equal(svc.view().disponivel, false)
    await assert.rejects(svc.analisarPasta({ accountId: 'a', folderId: 'p' }), /não roda neste computador/)
  })
})
