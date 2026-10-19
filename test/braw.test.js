// Proxy de Blackmagic RAW (src/media/braw.js + o ramo .braw do gerarPrevia): contrato do ajudante nativo, taxa de
// quadros, quem pode ter proxy, ajudante → ffmpeg por um cano (com o áudio tirado do próprio arquivo), falha do
// ajudante no meio, cancelar e as mensagens quando o computador não tem o Blackmagic RAW. O ajudante aqui é de mentira
// (gera frames RGBA); com um ffmpeg de verdade, o cano é testado de ponta a ponta.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { argsBrawTranscode, detectarBraw, fracaoFps, isBrawName, parseInfo } from '../src/media/braw.js'
import { detectarMotor, gerarPrevia, parseProbe, podeTerProxy } from '../src/media/previa.js'
import { GeradorPrevias } from '../src/media/previa-fila.js'
import { makeTmpDir } from './helpers.js'

const posix = process.platform !== 'win32'
const realFfmpeg = (() => {
  try {
    return spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' }).status === 0 ? 'ffmpeg' : null
  } catch {
    return null
  }
})()

async function tmp(t, prefix = 'sobedesce-braw-') {
  const dir = await makeTmpDir(prefix)
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

async function fakeBin(dir, name, body) {
  const p = path.join(dir, name)
  await fs.writeFile(p, `#!${process.execPath}\n${body}\n`, { mode: 0o755 })
  return p
}

// Ajudante de mentira: 320×180, 24000/1001, 12 frames; FAKE_BRAW_FALHA=n sai com 3 depois de n frames;
// FAKE_BRAW_LENTO=1 manda 1 frame e fica parado; FAKE_BRAW_CHECK=código do --check.
const HELPER = `
const a = process.argv.slice(2)
const W = 320, H = 180, N = 12
if (a.includes('--check')) process.exit(Number(process.env.FAKE_BRAW_CHECK || 0))
if (a.includes('--info')) {
  if (process.env.FAKE_BRAW_INFO === 'semComo') { process.stderr.write('clipe que o SDK não abre\\n'); process.exit(2) }
  console.log(JSON.stringify({ width: 4112, height: 2176, frameRate: 23.976023, frames: N, outWidth: W, outHeight: H }))
  process.exit(0)
}
if (a.includes('--frames')) {
  const falha = Number(process.env.FAKE_BRAW_FALHA || 0)
  const frame = Buffer.alloc(W * H * 4)
  let i = 0
  const next = () => {
    if (falha && i >= falha) { process.stderr.write('o SDK parou no frame ' + i + '\\n'); process.exit(3) }
    if (process.env.FAKE_BRAW_LENTO && i >= 1) return setTimeout(() => {}, 60000)
    if (i >= N) return
    frame.fill(i * 20)
    for (let p = 3; p < frame.length; p += 4) frame[p] = 255
    i++
    if (process.stdout.write(frame)) setImmediate(next)
    else process.stdout.once('drain', next)
  }
  next()
} else process.exit(1)
`

test('nomes, taxa de quadros e a linha do --info', () => {
  for (const n of ['A001.braw', 'A001_C002.BRAW', '/x/Clip.Braw']) assert.equal(isBrawName(n), true, n)
  for (const n of ['A001.mov', 'braw', 'x.braw.mov', '', null]) assert.equal(isBrawName(n), false, String(n))
  assert.equal(fracaoFps(23.976), '24000/1001')
  assert.equal(fracaoFps(23.976023), '24000/1001')
  assert.equal(fracaoFps(29.97), '30000/1001')
  assert.equal(fracaoFps(59.94), '60000/1001')
  assert.equal(fracaoFps(24), '24/1')
  assert.equal(fracaoFps(25.0001), '25/1')
  assert.equal(fracaoFps(120), '120/1')
  assert.equal(fracaoFps(33.333), '33333/1000')
  assert.equal(fracaoFps(0), null)
  assert.equal(fracaoFps('x'), null)

  const info = parseInfo('aviso qualquer\n{"width":4112,"height":2176,"frameRate":24,"frames":76,"outWidth":2056,"outHeight":1088}\n')
  assert.deepEqual({ ...info }, { width: 4112, height: 2176, frames: 76, outWidth: 2056, outHeight: 1088, fps: '24/1', frameRate: 24, durationS: 76 / 24 })
  assert.equal(parseInfo('nada'), null)
  assert.equal(parseInfo('{"width":1,"height":1,"frameRate":24,"frames":0,"outWidth":2,"outHeight":2}'), null)
  assert.equal(parseInfo('{"frameRate":24,"frames":10,"outWidth":99999,"outHeight":2}'), null)
})

test('quem pode ter proxy: vídeo comum sempre; .braw só com o Blackmagic RAW funcionando', () => {
  assert.equal(podeTerProxy('A001.mov', null), true)
  assert.equal(podeTerProxy('A001.braw', null), false)
  assert.equal(podeTerProxy('A001.braw', { braw: { ok: false } }), false)
  assert.equal(podeTerProxy('A001.braw', { braw: { ok: true } }), true)
  assert.equal(podeTerProxy('A001.r3d', { braw: { ok: true } }), false)

  const g = new GeradorPrevias({ selfCheck: false })
  const rec = name => ({ id: 'x', type: 'upload', name, local: { path: `/tmp/${name}` } })
  // App abrindo (motor sem resposta): o .braw entra e o gerarPrevia decide.
  assert.equal(g.elegivel(rec('A001.braw')), true)
  g.motorResult = { via: 'ffmpeg', braw: null }
  assert.equal(g.elegivel(rec('A001.braw')), false)
  assert.equal(g.elegivel(rec('A001.mov')), true)
  g.motorResult = { via: 'ffmpeg', braw: { ok: true } }
  assert.equal(g.elegivel(rec('A001.braw')), true)
  assert.equal(g.elegivel({ ...rec('A001.braw'), referencia: true }), false)
})

test('linha de comando: vídeo cru pelo stdin, áudio do .braw, cor BT.709 e corte no vídeo', () => {
  const a = argsBrawTranscode({ input: '/x/A001.braw', output: '/t/p.mp4', info: { outWidth: 2056, outHeight: 1088, fps: '24000/1001' }, vf: 'scale', encoderArgs: ['-c:v', 'libx264'] })
  const after = (flag, from = 0) => a[a.indexOf(flag, from) + 1]
  assert.equal(after('-pix_fmt'), 'rgba')
  assert.equal(after('-s'), '2056x1088')
  assert.equal(after('-framerate'), '24000/1001')
  assert.deepEqual(a.slice(a.indexOf('pipe:0') - 1, a.indexOf('pipe:0') + 3), ['-i', 'pipe:0', '-i', '/x/A001.braw'])
  assert.ok(a.join(' ').includes('-map 0:v:0 -map 1:a:0?'))
  for (const f of ['-color_primaries', '-color_trc', '-colorspace']) assert.equal(after(f), 'bt709')
  assert.ok(a.includes('-shortest'))
  assert.equal(a.at(-1), '/t/p.mp4')
})

test('detectarBraw: --check 0 = pronto, 2 = falta instalar, outro = falha; sem ajudante, null', { skip: !posix }, async t => {
  const dir = await tmp(t)
  const helper = await fakeBin(dir, 'sobedesce-raw-frame', HELPER)
  const env = { SOBEDESCE_RAW_HELPER: helper }
  process.env.FAKE_BRAW_CHECK = '0'
  assert.deepEqual(await detectarBraw({ env, resourcesPath: undefined }), { path: helper, ok: true, motivo: null })
  process.env.FAKE_BRAW_CHECK = '2'
  assert.deepEqual(await detectarBraw({ env, resourcesPath: undefined }), { path: helper, ok: false, motivo: 'instale o Blackmagic RAW neste computador' })
  process.env.FAKE_BRAW_CHECK = '5'
  assert.match((await detectarBraw({ env, resourcesPath: undefined })).motivo, /falhou \(saiu com 5\)/)
  delete process.env.FAKE_BRAW_CHECK
  assert.equal(await detectarBraw({ env: {}, resourcesPath: undefined }), null)
  assert.equal(await detectarBraw({ env: {}, resourcesPath: dir }), null, 'resources/raw-frame/ não existe')
})

test('sem decodificador: o .braw é dispensado com o motivo, sem abrir nada', { skip: !posix }, async t => {
  const dir = await tmp(t)
  const file = path.join(dir, 'A001.braw')
  await fs.writeFile(file, 'x')
  const ff = { via: 'ffmpeg', ffmpeg: { path: '/nao/existe' }, encoder: { nome: 'libx264' }, encoders: ['libx264'] }
  assert.deepEqual(await gerarPrevia(file, { motor: { ...ff, braw: null } }), { estado: 'dispensada', motivo: 'este app ainda não tem o decodificador de Blackmagic RAW' })
  assert.deepEqual(await gerarPrevia(file, { motor: { ...ff, braw: { ok: false, motivo: 'instale o Blackmagic RAW neste computador' } } }), {
    estado: 'dispensada',
    motivo: 'BRAW: instale o Blackmagic RAW neste computador',
  })
  assert.equal((await gerarPrevia(file, { motor: { via: 'avconvert', avconvert: '/usr/bin/avconvert', braw: { ok: true } } })).motivo, 'o proxy de BRAW precisa do ffmpeg')
})

// ─────────── com um ffmpeg de verdade ───────────

async function montar(t) {
  const dir = await tmp(t)
  const tmpRoot = await tmp(t, 'sobedesce-braw-tmp-')
  const helper = await fakeBin(dir, 'sobedesce-raw-frame', HELPER)
  // "BRAW" com áudio PCM 24 bits (como o da câmera): o ajudante de mentira ignora a imagem, o ffmpeg só lê o áudio.
  const file = path.join(dir, 'A001.braw')
  const mk = spawnSync(realFfmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=1:sample_rate=48000', '-ac', '2', '-c:a', 'pcm_s24le', '-f', 'mov', file])
  assert.equal(mk.status, 0, String(mk.stderr))
  const motor = await detectarMotor({ candidates: [{ path: realFfmpeg === 'ffmpeg' ? (spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).stdout || '').trim() : realFfmpeg, origem: 'sistema' }], env: { SOBEDESCE_RAW_HELPER: helper }, resourcesPath: undefined })
  return { dir, tmpRoot, helper, file, motor }
}

const temporarios = async tmpRoot => (await fs.readdir(tmpRoot)).filter(n => n.startsWith('sobedesce-previa-'))

test('ffmpeg de verdade: frames do ajudante + áudio do arquivo viram H.264 BT.709 com AAC, com progresso', { skip: (!posix || !realFfmpeg) && 'sem ffmpeg neste computador' }, async t => {
  const { tmpRoot, file, motor } = await montar(t)
  assert.equal(motor.braw?.ok, true)
  const fases = []
  const r = await gerarPrevia(file, { motor, tmpRoot, onProgress: (f, x) => fases.push(x == null ? f : `${f}:${x}`) })
  assert.equal(r.estado, 'pronta', r.motivo)
  t.after(() => r.limpar())
  assert.equal(r.motivo, 'Blackmagic RAW')
  assert.equal(fases[0], 'analisando')
  assert.equal(fases.at(-1), 'gerando:1')
  const out = spawnSync(realFfmpeg, ['-hide_banner', '-i', r.path], { encoding: 'utf8' }).stderr
  const info = parseProbe(out)
  assert.equal(info.video.codec, 'h264')
  assert.equal(info.video.pixFmt, 'yuv420p')
  assert.equal(`${info.video.width}x${info.video.height}`, '320x180')
  assert.equal(info.audio, true)
  assert.match(out, /bt709/)
  // 12 frames a 23,976 ≈ 0,5 s (o áudio de 1 s é cortado no vídeo).
  assert.ok(info.durationS > 0.4 && info.durationS < 0.6, String(info.durationS))
  await r.limpar()
  assert.deepEqual(await temporarios(tmpRoot), [])
})

test('ffmpeg de verdade: ajudante que falha no meio não deixa cópia pela metade nem temporário', { skip: (!posix || !realFfmpeg) && 'sem ffmpeg neste computador' }, async t => {
  const { tmpRoot, file, motor } = await montar(t)
  process.env.FAKE_BRAW_FALHA = '4'
  t.after(() => delete process.env.FAKE_BRAW_FALHA)
  await assert.rejects(gerarPrevia(file, { motor, tmpRoot }), err => err.name === 'PreviaError' && /ajudante do Blackmagic RAW: o SDK parou no frame 4/.test(err.message) && err.retry === false)
  assert.deepEqual(await temporarios(tmpRoot), [])
  delete process.env.FAKE_BRAW_FALHA

  process.env.FAKE_BRAW_INFO = 'semComo'
  t.after(() => delete process.env.FAKE_BRAW_INFO)
  assert.deepEqual(await gerarPrevia(file, { motor, tmpRoot }), { estado: 'dispensada', motivo: 'BRAW: clipe que o SDK não abre' })
})

test('ffmpeg de verdade: cancelar mata o ajudante e o ffmpeg na hora', { skip: (!posix || !realFfmpeg) && 'sem ffmpeg neste computador' }, async t => {
  const { tmpRoot, file, motor } = await montar(t)
  process.env.FAKE_BRAW_LENTO = '1'
  t.after(() => delete process.env.FAKE_BRAW_LENTO)
  const ac = new AbortController()
  const p = gerarPrevia(file, { motor, tmpRoot, signal: ac.signal, onProgress: f => f === 'gerando' && setTimeout(() => ac.abort(), 300) })
  const t0 = Date.now()
  await assert.rejects(p, err => err.name === 'AbortError')
  assert.ok(Date.now() - t0 < 5000)
  assert.deepEqual(await temporarios(tmpRoot), [])
})
