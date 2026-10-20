// Frames (src/frames/*, src/server/frames.js): nomes e pastas, a escolha com bom senso (sem tela preta, sem quadro
// desfocado, sem repetido, espalhado pelas cenas) e — com um ffmpeg de verdade — o trabalho inteiro: frames em alta
// por cena, takes, índice, trocar e descartar, nome da cena virando pasta, post salvo e a pasta indo para a fila do Drive.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { cenas, distanciaHash, medir } from '../src/frames/analise.js'
import { escolherFrames, escolherTakes, nota } from '../src/frames/escolha.js'
import { timecode } from '../src/frames/extracao.js'
import { FramesService, baseDoNome, pastaDaCena } from '../src/frames/servico.js'
import { makeTmpDir } from './helpers.js'

const ffmpeg = (() => {
  try {
    const r = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' })
    return r.status === 0 ? r.stdout.trim() : null
  } catch {
    return null
  }
})()
const semFfmpeg = !ffmpeg && 'sem ffmpeg neste computador'

async function tmp(t) {
  const dir = await makeTmpDir('sobedesce-frames-')
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}

test('nomes: base do arquivo, pasta da cena e timecode', () => {
  assert.equal(baseDoNome('Filme Final v3 (cor).mov'), 'Filme_Final_v3_cor')
  assert.equal(baseDoNome('Ação — São João.MP4'), 'Ação_São_João')
  assert.equal(baseDoNome('.mov'), 'video')
  assert.equal(pastaDaCena(3, 'Escuro, Frio, Parado'), 'Cena 03 — Escuro, Frio, Parado')
  assert.equal(pastaDaCena(12, 'Praia: pôr do sol / drone'), 'Cena 12 — Praia pôr do sol drone')
  assert.equal(pastaDaCena(1, ''), 'Cena 01')
  assert.equal(timecode(83.5, 24), '00-01-23-12')
  assert.equal(timecode(3600 + 0.04, 25), '01-00-00-01')
})

// Amostras de mentira: o que medir() devolve, já com a diferença para a anterior.
function amostra(t, o = {}) {
  return { t, media: 120, desvio: 50, nitidez: 400, escuros: 0, estourados: 0, calor: 5, saturacao: 0.3, hash: [t * 7919 >>> 0, t * 104729 >>> 0], dif: 3, ...o }
}

test('escolha: nada preto, desfocado, colado no corte ou repetido; espalha pelas cenas', () => {
  const passo = 0.25
  const amostras = []
  for (let k = 0; k < 80; k++) {
    const t = k * passo
    let o = {}
    if (k >= 20 && k < 32) o = { media: 4, desvio: 2, escuros: 0.98 } // cena preta
    if (k >= 32 && k < 52) o = { nitidez: 30 } // cena desfocada
    if (k >= 52) o = { hash: [0xabcdef, 0x123456] } // cena parada: tudo igual
    if (k === 20 || k === 32 || k === 52) o.dif = 90 // cortes
    amostras.push(amostra(t, o))
  }
  const cs = cenas(amostras, passo)
  assert.deepEqual(cs.map((c) => c.de), [0, 20, 32, 52])
  const r = escolherFrames({ amostras, cenas: cs, passo }, 12)
  const ts = r.frames.map((f) => f.t)
  assert.ok(ts.every((t) => t < 5 || t >= 13), 'nenhum da cena preta nem da desfocada')
  assert.equal(r.frames.filter((f) => f.cena === 3).length, 1, 'a cena parada dá um frame só (o resto é repetido)')
  assert.ok(r.descartes.escuro_ou_estourado > 0 && r.descartes.desfocado_ou_tremido > 0 && r.descartes.transicao > 0)
  for (const f of r.frames) {
    const c = cs[f.cena]
    assert.ok(f.t - c.ini >= 0.35 && c.fim - f.t >= 0.35, 'longe do corte')
  }
  // Takes: só cenas que servem, primeiro uma de cada, depois outros trechos sem encostar; na ordem do filme.
  const um = escolherTakes({ amostras, cenas: cs, passo }, { quantidade: 2, duracao: 2 })
  assert.deepEqual(um.map((t) => t.cena), [0, 3])
  const tk = escolherTakes({ amostras, cenas: cs, passo }, { quantidade: 5, duracao: 2 })
  assert.ok(tk.length > 2 && tk.every((t) => t.cena === 0 || t.cena === 3))
  assert.ok(tk.every((t) => t.dur <= 2))
  for (let i = 1; i < tk.length; i++) assert.ok(tk[i].ini >= tk[i - 1].ini + tk[i - 1].dur, 'sem trecho repetido')
  assert.equal(nota(amostra(0, { media: 250 }), 400, 3), 0)
})

test('medir: nitidez cai no desfocado, hash parecido no parecido', () => {
  const w = 64
  const h = 36
  const xadrez = Buffer.alloc(w * h * 3)
  const liso = Buffer.alloc(w * h * 3, 128)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) xadrez.fill(((x >> 2) + (y >> 2)) % 2 ? 230 : 20, (y * w + x) * 3, (y * w + x) * 3 + 3)
  const a = medir(xadrez, w, h)
  const b = medir(liso, w, h)
  assert.ok(a.nitidez > 1000 && b.nitidez < 1)
  assert.equal(distanciaHash(a.hash, a.hash), 0)
  assert.ok(b.desvio < 1)
})

/** Filme de 14 s com 4 cenas: barras (movimento), preto, padrão de teste e mandelbrot. */
function filme(file) {
  const fc = [
    'testsrc2=s=1280x720:r=25:d=4[a]',
    'color=c=black:s=1280x720:r=25:d=2[b]',
    'smptehdbars=s=1280x720:r=25:d=4,format=yuv420p,noise=alls=20:allf=t[c]',
    'mandelbrot=s=1280x720:r=25,trim=duration=4,setpts=PTS-STARTPTS[d]',
    'sine=f=440:d=14[s]',
    '[a][b][c][d]concat=n=4:v=1:a=0,format=yuv420p[v]',
  ].join(';')
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-filter_complex', fc, '-map', '[v]', '-map', '[s]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', file])
  assert.equal(r.status, 0, String(r.stderr))
  return file
}

test('Frames de ponta a ponta: pasta organizada, takes, índice, edições, post e Drive', { skip: semFfmpeg, timeout: 180_000 }, async (t) => {
  const dir = await tmp(t)
  const video = filme(path.join(dir, 'Filme Final.mp4'))
  const logo = path.join(dir, 'logo.png')
  assert.equal(spawnSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white@0.0:s=400x120,format=rgba,drawbox=x=10:y=10:w=380:h=100:color=white@1:t=fill', '-frames:v', '1', logo]).status, 0)
  const subidas = []
  const eventos = []
  const svc = new FramesService({
    dataRoot: path.join(dir, 'dados'),
    motor: async () => ({ ffmpeg: { path: ffmpeg }, encoder: { nome: 'libx264' } }),
    drive: () => assert.fail('não usa o Drive'),
    baixar: () => assert.fail('não baixa'),
    subir: async (o) => {
      subidas.push(o)
      return { count: 9, bytes: 1 }
    },
    pastaPadrao: () => path.join(dir, 'Downloads', 'Frames'),
    onChange: (v) => eventos.push(v),
  })
  const id = svc.iniciar({
    origem: { tipo: 'local', caminho: video },
    ajustes: {
      frames: { quantidade: 8, formato: 'jpg', logo: true },
      takes: { quantidade: 2, duracao: 1.5, formato: '9:16', foco: 0.5, audio: true, fade: true, codec: 'h264', logo: false },
      logo: { path: logo, posicao: 'inf-dir', tamanho: 0.2, opacidade: 1 },
      destino: null,
      subir: { accountId: 'acc1', folderId: 'pasta1', driveId: null, name: 'Entregas' },
    },
  })
  while (svc.job.status === 'running') await new Promise((r) => setTimeout(r, 100))
  assert.equal(svc.job.status, 'done', svc.job.erro)
  assert.ok(eventos.some((e) => e.fase === 'lendo') && eventos.some((e) => e.fase === 'frames'))

  const m = await svc.manifesto(id)
  assert.equal(m.pasta, path.join(dir, 'Downloads', 'Frames', 'Filme Final — Frames e Takes'))
  assert.ok(m.cenas.length >= 3, `cenas: ${m.cenas.map((c) => c.ini).join(',')}`)
  // Nenhum frame na parte preta (4–6 s).
  assert.ok(m.frames.every((f) => f.t < 4 || f.t > 6), m.frames.map((f) => f.t).join(','))
  assert.ok(m.frames.length >= 4)
  // Arquivos em alta, no tamanho do vídeo, dentro da pasta da cena.
  for (const f of m.frames) {
    assert.match(f.arquivo, new RegExp(`^Frames[\\\\/]Cena ${String(f.cena).padStart(2, '0')} — .+[\\\\/]Filme_Final_C${String(f.cena).padStart(2, '0')}_${f.id}_\\d\\d-\\d\\d-\\d\\d-\\d\\d\\.jpg$`))
    const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', path.join(m.pasta, f.arquivo)], { encoding: 'utf8' }).stderr
    assert.match(probe, /1280x720/)
  }
  // Takes 9:16 com som.
  assert.equal(m.takes.length, 2)
  for (const tk of m.takes) {
    assert.match(tk.arquivo, /^Takes[\\/]Filme_Final_C\d\d_T\d\d_[\d-]+_9x16\.mp4$/)
    const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', path.join(m.pasta, tk.arquivo)], { encoding: 'utf8' }).stderr
    assert.match(probe, /Video: h264.*404x720/)
    assert.match(probe, /Audio: aac/)
  }
  // Índice e subida.
  const csv = await fs.readFile(path.join(m.pasta, 'indice.csv'), 'utf8')
  assert.ok(csv.startsWith('﻿tipo;arquivo;cena'))
  assert.equal(csv.trim().split('\r\n').length, 1 + m.frames.length + m.takes.length)
  assert.deepEqual(subidas, [{ accountId: 'acc1', pasta: m.pasta, folderId: 'pasta1', driveId: null, name: 'Entregas' }])
  assert.equal((await svc.historico())[0].id, id)
  // A pasta entregue só tem o que serve.
  assert.deepEqual((await fs.readdir(m.pasta)).sort(), ['Frames', 'Takes', 'indice.csv'])

  // Outro frame: troca por um diferente da mesma cena; o velho vai para os descartados (fora da pasta).
  // (na cena com mais frames: a de barras parada só tem um quadro que não se repete)
  const conta = (n) => m.frames.filter((f) => f.cena === n).length
  const velho = m.frames.slice().sort((a, b) => conta(b.cena) - conta(a.cena))[0]
  const m2 = await svc.maisUm(id, { trocar: velho.id })
  assert.equal(m2.frames.find((f) => f.id === velho.id).descartado, true)
  const novo = m2.frames.find((f) => !f.descartado && f.cena === velho.cena && f.id !== velho.id && Math.abs(f.t - velho.t) > 0.4)
  assert.ok(novo)
  await assert.rejects(fs.stat(path.join(m.pasta, velho.arquivo)))
  // Volta o descartado.
  await svc.descartar(id, velho.id, false)
  await fs.stat(path.join(m.pasta, velho.arquivo))
  // Frame no ponto exato.
  const m3 = await svc.frameEm(id, 9.5)
  assert.ok(m3.frames.some((f) => f.manual && f.t === 9.5))
  // Nome da cena vira a pasta.
  const m4 = await svc.nomearCena(id, velho.cena, 'Abertura')
  const daCena = m4.frames.filter((f) => f.cena === velho.cena)
  for (const f of daCena) {
    assert.match(f.arquivo, new RegExp(`^Frames[\\\\/]Cena ${String(velho.cena).padStart(2, '0')} — Abertura[\\\\/]`))
    if (!f.descartado) await fs.stat(path.join(m.pasta, f.arquivo))
  }
  // Take em outro formato.
  const m5 = await svc.outroTake(id, m.takes[0].id, { formato: '1:1' })
  const quadrado = m5.takes.find((x) => x.formato === '1:1')
  assert.match(spawnSync(ffmpeg, ['-hide_banner', '-i', path.join(m.pasta, quadrado.arquivo)], { encoding: 'utf8' }).stderr, /720x720/)
  // Post salvo em Posts/ e no índice; caminho só dos arquivos do trabalho.
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5d40000000049454e44ae426082', 'hex')
  const { arquivo } = await svc.salvarPost(id, { tipo: 'Triade', proporcao: '4:5', ext: 'png', dados: png })
  assert.match(arquivo, /^Posts[\\/]Filme_Final_Post_Triade_4x5\.png$/)
  assert.equal(await svc.caminho(id, { rel: arquivo }), path.join(m.pasta, arquivo))
  await assert.rejects(svc.caminho(id, { rel: '../../segredo.txt' }), /não é deste trabalho/)
  await assert.rejects(svc.caminho(id, { mini: '../x' }), /inválido/)
  assert.match(await fs.readFile(path.join(m.pasta, 'indice.csv'), 'utf8'), /post;Posts.Filme_Final_Post_Triade_4x5\.png/)
  // Miniaturas para a tela.
  await fs.stat(await svc.caminho(id, { mini: novo.id }))
  // A tela não recebe candidatos nem hash.
  const tela = svc.paraTela(await svc.manifesto(id))
  assert.equal(tela.cenas[0].candidatos, undefined)
  assert.equal(tela.frames[0].hash, undefined)
  // Esquecer apaga só o que é do app; a pasta entregue fica.
  await svc.esquecer(id)
  await fs.stat(m.pasta)
  assert.equal((await svc.historico()).length, 0)
})

test('celular: medidas, escolha e posts são cópias idênticas das do computador', async () => {
  const par = [
    ['../src/frames/medidas.js', '../web/public/app/lib/frames/medidas.js'],
    ['../src/frames/escolha.js', '../web/public/app/lib/frames/escolha.js'],
    ['../public/lib/frames-posts.js', '../web/public/app/lib/frames/posts.js'],
  ]
  for (const [a, b] of par) assert.equal(await fs.readFile(new URL(b, import.meta.url), 'utf8'), await fs.readFile(new URL(a, import.meta.url), 'utf8'), `${b} difere de ${a}`)
})

test('posts: enquadramento de cada frame (arrastar, zoom e qual frame está no ponto)', async () => {
  const { cobrir, enquadreDe, moverEnquadre, frameNoPonto, ZOOM_MAX } = await import('../public/lib/frames-posts.js')
  // Sem enquadre: centralizado, zoom 1; valores fora do limite voltam para dentro.
  assert.deepEqual(enquadreDe(undefined), { x: 0.5, y: 0.5, zoom: 1 })
  assert.deepEqual(enquadreDe({ x: 2, y: -1, zoom: 9 }), { x: 1, y: 0, zoom: ZOOM_MAX })
  // Zoom 2 pega metade do frame (em cada lado), no ponto pedido.
  assert.deepEqual(cobrir(1920, 1080, 100, 100, 0.5, 0.5, 2), { sx: 690, sy: 270, sw: 540, sh: 540 })
  // Caixa quadrada, frame 16:9: sobra na horizontal. Arrastar para a direita mostra mais da esquerda (x desce).
  const b = { x: 0, y: 0, w: 100, h: 100 }
  const e1 = moverEnquadre(undefined, 20, 0, 1920, 1080, b)
  assert.ok(e1.x < 0.5 && e1.y === 0.5, JSON.stringify(e1))
  assert.equal(moverEnquadre(undefined, 0, 40, 1920, 1080, b).y, 0.5, 'sem sobra na vertical: não anda')
  assert.equal(moverEnquadre(undefined, 10_000, 0, 1920, 1080, b).x, 0, 'para na borda')
  // Com zoom, também anda na vertical.
  assert.ok(moverEnquadre({ zoom: 2 }, 0, 20, 1920, 1080, b).y < 0.5)
  // Qual frame está no ponto: tríade de 3 (o do meio), carrossel (sempre o 0), polaroid girada e fora de tudo.
  const meio = frameNoPonto('triade', { n: 3, escala: 1 }, 540, 520)
  assert.equal(meio?.i, 1)
  assert.equal(frameNoPonto('carrossel', { n: 1, escala: 1, slides: 3 }, 2500, 600)?.i, 0)
  const pol = frameNoPonto('polaroid', { n: 2, escala: 1 }, 1080 * 0.6, 1350 * 0.64)
  assert.equal(pol?.i, 1)
  assert.ok(pol.caixa.w > 0 && pol.caixa.x < pol.caixa.w, 'a caixa da polaroid é a foto dentro da moldura')
  assert.equal(frameNoPonto('box', { n: 1, escala: 1 }, 2, 2), null)
})

test('posts: tela cheia (tríade e grade sem bordas do fundo)', async () => {
  const { montar } = await import('../public/lib/frames-posts.js')
  const t = montar('triade', { w: 1080, h: 1920, n: 5, cheio: true })
  assert.equal(t.caixas.length, 5)
  assert.deepEqual(t.texto, [], 'sem título em tela cheia')
  assert.equal(t.caixas[0].y, 0)
  assert.equal(t.caixas.at(-1).y + t.caixas.at(-1).h, 1920, 'vai até o fim do post')
  for (const [i, c] of t.caixas.entries()) {
    assert.equal(c.x, 0)
    assert.equal(c.w, 1080)
    if (i) assert.equal(c.y, t.caixas[i - 1].y + t.caixas[i - 1].h, 'sem espaço entre os frames')
  }
  const g = montar('grade', { w: 1080, h: 1350, n: 4, respiro: 0.03, cheio: true })
  assert.equal(g.caixas[0].x, 0)
  assert.equal(g.caixas[3].x + g.caixas[3].w, 1080)
  // Sem tela cheia, continua com a borda.
  assert.ok(montar('triade', { w: 1080, h: 1350, n: 3, respiro: 0.03 }).caixas[0].x > 0)
})
