// Prévia leve, parte do conversor (src/media/previa.js): leitura do `ffmpeg -i`, quais vídeos ganham cópia, linha de
// comando de cada codificador, ordem de procura do ffmpeg, escolha do codificador com teste de 1 quadro, conversão com
// progresso, recuo para o libx264, cancelar (mata o processo), prioridade baixa e limpeza do temporário — com um ffmpeg
// de mentira (test/fake-ffmpeg.mjs). Se houver um ffmpeg de verdade aqui, um teste converte um clipe minúsculo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import zlib from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  argsEncoderTest,
  argsTranscode,
  detectarMotor,
  encoderArgs,
  ffmpegCandidates,
  gerarPrevia,
  isProxyName,
  isVideoName,
  parseProbe,
  plano,
  precisaPrevia,
  previaName,
  probe,
  timeoutFor,
  videoFilter,
} from '../src/media/previa.js'
import { makeTmpDir } from './helpers.js'

const MB = 1e6
const posix = process.platform !== 'win32'
const FAKE = fileURLToPath(new URL('./fake-ffmpeg.mjs', import.meta.url))

const PRORES = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'A001.mov':
  Metadata:
    major_brand     : qt
  Duration: 00:01:02.50, start: 0.000000, bitrate: 707000 kb/s
  Stream #0:0[0x1]: Video: prores (HQ) (apch / 0x68637061), yuv422p10le(tv, bt709, progressive), 3840x2160, 705000 kb/s, SAR 1:1 DAR 16:9, 25 fps, 25 tbr, 12800 tbn (default)
    Metadata:
      handler_name    : VideoHandler
  Stream #0:1[0x2]: Audio: pcm_s24le (in24 / 0x34326E69), 48000 Hz, stereo, s32 (24 bit), 2304 kb/s (default)
  Stream #0:2[0x3]: Data: none (tmcd / 0x64636D74), 0 kb/s
At least one output file must be specified
`
const H264 = `  Duration: 00:00:30.00, start: 0.000000, bitrate: 8120 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 8000 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)
`
const IPHONE = `  Duration: 00:00:12.40, start: 0.000000, bitrate: 22000 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67), 3840x2160, 21000 kb/s, 29.98 fps, 30 tbr, 600 tbn (default)
    Side data:
      displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 160 kb/s (default)
`
const ANAMORFICO = `  Duration: 00:00:05.00, start: 0.000000, bitrate: 50000 kb/s
  Stream #0:0: Video: dnxhd (DNXHR HQX) (AVdh / 0x68645641), yuv422p10le(tv, bt709/unknown/unknown, progressive), 1920x1080, SAR 4:3 DAR 64:27, 50000 kb/s, 24 fps
`
const COVER = `  Duration: 00:03:00.00, start: 0.000000, bitrate: 320 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 600x600 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)
`

async function tmp(t, prefix = 'sobedesce-previa-test-') {
  const dir = await makeTmpDir(prefix)
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}

/** Copia o ffmpeg de mentira para uma pasta (executável) e devolve o caminho + o log das chamadas. */
async function fakeFfmpeg(t) {
  const dir = await tmp(t, 'sobedesce-fakeff-')
  const bin = path.join(dir, 'ffmpeg')
  await fs.copyFile(FAKE, bin)
  await fs.chmod(bin, 0o755)
  const log = path.join(dir, 'calls.jsonl')
  const saved = { ...process.env }
  process.env.FAKE_FF_LOG = log
  t.after(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('FAKE_FF_') && !(k in saved)) delete process.env[k]
  })
  const calls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l))
  return { bin, dir, calls }
}

const motorWith = (bin, encoder = 'libx264', encoders = ['libx264']) => ({ via: 'ffmpeg', ffmpeg: { path: bin, versao: '9.9', origem: 'app' }, encoder: { nome: encoder, hardware: encoder !== 'libx264' }, encoders })

test('parseProbe: ProRes 4K com áudio e timecode, H.264, HEVC do iPhone girado, anamórfico e capa de MP3', () => {
  const p = parseProbe(PRORES)
  assert.equal(p.durationS, 62.5)
  assert.equal(p.bitrate, 707_000_000)
  assert.deepEqual(p.video, { codec: 'prores', profile: 'HQ', pixFmt: 'yuv422p10le', bits: 10, width: 3840, height: 2160, bitrate: 705_000_000, sar: [1, 1] })
  assert.equal(p.audio, true)

  const h = parseProbe(H264)
  assert.equal(h.video.codec, 'h264')
  assert.equal(h.video.bits, 8)
  assert.equal(h.video.width, 1920)
  assert.equal(h.video.bitrate, 8_000_000)

  const i = parseProbe(IPHONE)
  assert.equal(i.video.codec, 'hevc')
  assert.equal(i.video.bits, 10)
  assert.equal(i.rotation, -90)
  assert.equal(i.audio, true)

  assert.deepEqual(parseProbe(ANAMORFICO).video.sar, [4, 3])
  assert.equal(parseProbe(ANAMORFICO).audio, false)

  const c = parseProbe(COVER)
  assert.equal(c.video, null, 'capa de álbum não é vídeo')
  assert.equal(parseProbe('').video, null)
})

test('precisaPrevia: pesado, codec de câmera, maior que 1080p e contêiner ruim ganham cópia; H.264 leve e RAW não', () => {
  const yes = (text, o) => assert.equal(precisaPrevia(parseProbe(text), o).gerar, true, JSON.stringify(o))
  const no = (text, o) => assert.equal(precisaPrevia(parseProbe(text), o).gerar, false, JSON.stringify(o))
  yes(PRORES, { name: 'A001.mov', size: 5_000 * MB })
  assert.equal(precisaPrevia(parseProbe(PRORES), { name: 'A001.mov', size: 5_000 * MB }).motivo, 'ProRes 10 bits')
  yes(IPHONE, { name: 'IMG_0001.MOV', size: 34 * MB }) // HEVC 10 bits: mesmo pequeno não toca em todo navegador
  yes(ANAMORFICO, { name: 'cena.mxf', size: 30 * MB })
  // H.264 1080p 8 Mbit/s: leve, em qualquer tamanho; pequeno também.
  no(H264, { name: 'entrevista.mp4', size: 30 * MB })
  no(H264, { name: 'entrevista.mp4', size: 900 * MB })
  // Mesma coisa a 45 Mbit/s: pesado.
  yes(H264.replace('8000 kb/s', '45000 kb/s'), { name: 'drone.mp4', size: 900 * MB })
  // 4K H.264 8 bits.
  yes(H264.replace('1920x1080', '3840x2160'), { name: 'gimbal.mp4', size: 900 * MB })
  assert.equal(precisaPrevia(parseProbe(H264.replace('1920x1080', '3840x2160')), { name: 'g.mp4', size: 30 * MB }).gerar, true)
  // 4K pequeno não é "já leve" (só H.264 até 1080p).
  // MKV/AVI não abrem no navegador.
  yes(H264, { name: 'gravacao.mkv', size: 900 * MB })
  // RAW de câmera: nunca (o ffmpeg não abre; a câmera grava o proxy dela).
  assert.deepEqual(precisaPrevia(null, { name: 'A001.braw', size: 9e9 }).gerar, false)
  assert.equal(precisaPrevia(parseProbe(COVER), { name: 'x.mp4', size: 90 * MB }).gerar, false)
  // Sem leitura (avconvert): só .mov/.mp4/.m4v grandes.
  assert.equal(precisaPrevia(null, { name: 'clip.mov', size: 900 * MB }).gerar, true)
  assert.equal(precisaPrevia(null, { name: 'clip.mov', size: 9 * MB }).gerar, false)
  assert.equal(precisaPrevia(null, { name: 'clip.mxf', size: 900 * MB }).gerar, false)
})

test('nomes: vídeo pela extensão, RAW fora, nome da cópia e quem serve de proxy', () => {
  for (const n of ['a.mov', 'B.MP4', 'c.mxf', 'd.MTS', 'e.m2ts', 'f.mkv', 'g.avi', 'h.m4v']) assert.equal(isVideoName(n), true, n)
  for (const n of ['a.braw', 'b.R3D', 'c.ari', 'd.wav', 'e.jpg', 'f', 'g.mov.txt']) assert.equal(isVideoName(n), false, n)
  assert.equal(previaName('A001_C002.MOV'), 'A001_C002.mp4')
  assert.equal(previaName('cena.final.mxf'), 'cena.final.mp4')
  assert.equal(previaName('Ação.mov'.normalize('NFD')), 'Ação.mp4'.normalize('NFC'))
  assert.equal(isProxyName('a001.MP4', 'A001.mov'), true)
  assert.equal(isProxyName('A001.mxf', 'A001.mov'), false)
  assert.equal(isProxyName('A0011.mp4', 'A001.mov'), false)
})

test('linha de comando: 720p no lado maior (como o Drive toca), pares, 4:2:0 8 bits, AAC estéreo, faststart; sem áudio vira -an', () => {
  const info = parseProbe(PRORES)
  const a = argsTranscode({ input: '/in/A001.mov', output: '/tmp/x/previa.mp4', encoder: 'libx264', info })
  const s = a.join(' ')
  assert.ok(s.includes("-vf scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p"), s)
  assert.ok(s.includes('-c:v libx264 -preset veryfast -crf 24 -maxrate 3M -bufsize 6M -profile:v high'), s)
  assert.ok(s.includes('-map 0:v:0 -map 0:a:0? -dn -sn'), s)
  assert.ok(s.includes('-c:a aac -b:a 128k -ac 2'), s)
  assert.ok(s.endsWith('-movflags +faststart -f mp4 /tmp/x/previa.mp4'), s)
  assert.ok(s.includes('-progress pipe:1'), s)
  assert.equal(a[a.indexOf('-i') + 1], '/in/A001.mov')
  assert.ok(!a.includes('-hwaccel'))

  const mudo = argsTranscode({ input: 'i', output: 'o', encoder: 'libx264', info: parseProbe(ANAMORFICO) })
  assert.ok(mudo.includes('-an') && !mudo.includes('aac'))
  assert.ok(videoFilter(parseProbe(ANAMORFICO), 'libx264').startsWith("scale=w='trunc(iw*sar/2)*2':h=ih,setsar=1,"))

  const vt = argsTranscode({ input: 'i', output: 'o', encoder: 'h264_videotoolbox', info, hwDecode: true })
  assert.deepEqual(vt.slice(vt.indexOf('-hwaccel'), vt.indexOf('-hwaccel') + 2), ['-hwaccel', 'videotoolbox'])
  assert.ok(vt.join(' ').includes('-c:v h264_videotoolbox -b:v 2500k -profile:v high -allow_sw 1'))
  // Quick Sync e Media Foundation recebem NV12.
  assert.ok(videoFilter(info, 'h264_qsv').endsWith('format=nv12'))
  assert.ok(videoFilter(info, 'h264_mf').endsWith('format=nv12'))
  for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'h264_videotoolbox', 'libx264']) {
    const e = encoderArgs(enc)
    assert.equal(e[1], enc)
    assert.ok(e.includes('-b:v') || e.includes('-crf'), enc)
  }
  const tst = argsEncoderTest('h264_nvenc')
  assert.ok(tst.includes('lavfi') && tst.includes('h264_nvenc') && tst[tst.length - 1] === '-')
  assert.equal(timeoutFor(60), 10 * 60_000 + 480_000)
  assert.equal(timeoutFor(null), 6 * 3600_000)
})

test('plano: hardware com decodificação no chip (Mac), hardware, e por fim libx264', () => {
  const m = enc => ({ encoder: { nome: enc }, encoders: ['libx264', enc] })
  assert.deepEqual(plano(m('h264_videotoolbox'), 'darwin'), [
    { encoder: 'h264_videotoolbox', hwDecode: true },
    { encoder: 'h264_videotoolbox', hwDecode: false },
    { encoder: 'libx264', hwDecode: false },
  ])
  assert.deepEqual(plano(m('h264_nvenc'), 'win32'), [
    { encoder: 'h264_nvenc', hwDecode: false },
    { encoder: 'libx264', hwDecode: false },
  ])
  assert.deepEqual(plano({ encoder: { nome: 'libx264' }, encoders: ['libx264'] }, 'linux'), [{ encoder: 'libx264', hwDecode: false }])
  // ffmpeg sem libx264 (só o do chip): não inventa tentativa.
  assert.deepEqual(plano({ encoder: { nome: 'h264_videotoolbox' }, encoders: ['h264_videotoolbox'] }, 'darwin').map(p => p.encoder), ['h264_videotoolbox', 'h264_videotoolbox'])
})

test('onde procurar o ffmpeg: variável, o do app, o baixado para desenvolvimento, Homebrew e PATH', () => {
  const mac = ffmpegCandidates({ env: { SOBEDESCE_FFMPEG: '/x/ff', PATH: '/usr/bin:/bin' }, platform: 'darwin', arch: 'arm64', resourcesPath: '/Apps/SOBEDESCE.app/Contents/Resources', appRoot: '/Apps/SOBEDESCE.app/Contents/Resources/app' })
  assert.deepEqual(mac.map(c => c.path), [
    '/x/ff',
    '/Apps/SOBEDESCE.app/Contents/Resources/ffmpeg/ffmpeg',
    '/Apps/SOBEDESCE.app/Contents/Resources/app/build/ffmpeg/mac-arm64/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    '/bin/ffmpeg',
  ])
  assert.deepEqual(mac.map(c => c.origem), ['env', 'app', 'app', 'sistema', 'sistema', 'sistema', 'sistema'])
  const win = ffmpegCandidates({ env: { Path: 'C:\\Tools;C:\\ffmpeg\\bin' }, platform: 'win32', arch: 'x64', resourcesPath: 'C:\\Users\\a\\AppData\\Local\\Programs\\SOBEDESCE\\resources', appRoot: 'C:\\Users\\a\\AppData\\Local\\Programs\\SOBEDESCE\\resources\\app' })
  assert.deepEqual(win.map(c => c.path), [
    'C:\\Users\\a\\AppData\\Local\\Programs\\SOBEDESCE\\resources\\ffmpeg\\ffmpeg.exe',
    'C:\\Users\\a\\AppData\\Local\\Programs\\SOBEDESCE\\resources\\app\\build\\ffmpeg\\win-x64\\ffmpeg.exe',
    'C:\\Tools\\ffmpeg.exe',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
  ])
})

test('detectarMotor: usa o hardware que passa no teste de 1 quadro; sem nenhum, libx264; sem ffmpeg, avconvert (Mac) ou aviso', { skip: !posix }, async t => {
  const { bin, calls } = await fakeFfmpeg(t)
  const cand = [{ path: path.join(path.dirname(bin), 'nao-existe'), origem: 'app' }, { path: bin, origem: 'app' }]
  process.env.FAKE_FF_HW = 'h264_qsv'
  const m = await detectarMotor({ platform: 'win32', candidates: cand })
  assert.equal(m.via, 'ffmpeg')
  assert.equal(m.ffmpeg.versao, '9.9-fake')
  assert.deepEqual(m.encoder, { nome: 'h264_qsv', hardware: true })
  assert.equal(m.label, 'Usando o vídeo do processador Intel')
  assert.deepEqual(m.testados.filter(x => x.encoder), [{ encoder: 'h264_nvenc', ok: false }, { encoder: 'h264_qsv', ok: true }])
  // O teste de hardware usa a mesma linha de comando do codificador.
  assert.ok((await calls()).some(c => c.args.includes('lavfi') && c.args.includes('h264_qsv')))

  process.env.FAKE_FF_HW = ''
  const sw = await detectarMotor({ platform: 'win32', candidates: cand })
  assert.deepEqual(sw.encoder, { nome: 'libx264', hardware: false })
  assert.equal(sw.label, 'Usando o ffmpeg')

  process.env.FAKE_FF_HW = 'h264_videotoolbox'
  const mac = await detectarMotor({ platform: 'darwin', candidates: cand })
  assert.equal(mac.label, 'Usando o chip de vídeo do Mac')

  // Sem ffmpeg: no Mac cai no avconvert; fora dele, aviso.
  const none = [{ path: '/nao/existe/ffmpeg', origem: 'app' }]
  const av = await detectarMotor({ platform: 'darwin', candidates: none, avconvertPath: bin })
  assert.equal(av.via, 'avconvert')
  assert.equal(av.label, 'Usando o conversor de vídeo do macOS')
  const nada = await detectarMotor({ platform: 'win32', candidates: none })
  assert.equal(nada.via, null)
  assert.match(nada.aviso, /Não encontramos o ffmpeg/)
  // ffmpeg sem H.264 nenhum.
  process.env.FAKE_FF_ENC = 'h264_nvenc'
  const semX264 = await detectarMotor({ platform: 'linux', candidates: cand })
  assert.equal(semX264.via, null)
  assert.match(semX264.aviso, /não tem codificador H\.264/)
})

test('gerarPrevia: lê, converte com progresso em prioridade baixa e deixa a cópia num temporário que limpar() apaga', { skip: !posix }, async t => {
  const { bin, calls } = await fakeFfmpeg(t)
  const dir = await tmp(t)
  const tmpRoot = await tmp(t, 'sobedesce-previa-tmp-')
  const src = path.join(dir, 'A001.mov')
  await fs.writeFile(src, Buffer.alloc(3_000_000, 1))
  const fases = []
  const r = await gerarPrevia(src, { motor: motorWith(bin), size: 5_000 * MB, tmpRoot, onProgress: (f, x) => fases.push([f, x]) })
  assert.equal(r.estado, 'pronta')
  assert.equal(r.encoder, 'libx264')
  assert.equal(r.motivo, 'ProRes 10 bits')
  assert.equal(r.size, 200_000)
  assert.equal((await fs.stat(r.path)).size, 200_000)
  assert.ok(r.path.startsWith(tmpRoot))
  assert.deepEqual(fases[0], ['analisando', undefined])
  const pcts = fases.filter(f => f[0] === 'gerando').map(f => f[1])
  assert.deepEqual(pcts, [0, 0.25, 0.5, 0.75, 0.999, 1])
  const conv = (await calls()).find(c => c.args.includes('-progress'))
  assert.ok(conv, 'converteu')
  assert.equal(conv.args[conv.args.indexOf('-i') + 1], src)
  if (process.platform !== 'win32') assert.ok(conv.nice >= 10, `prioridade baixa (nice ${conv.nice})`)
  await r.limpar()
  assert.deepEqual(await fs.readdir(tmpRoot), [])
})

test('gerarPrevia: hardware que falha cai no libx264; H.264 leve é dispensado sem converter; cópia maior que o original também', { skip: !posix }, async t => {
  const { bin, calls } = await fakeFfmpeg(t)
  const dir = await tmp(t)
  const tmpRoot = await tmp(t, 'sobedesce-previa-tmp-')
  const src = path.join(dir, 'A001.mov')
  await fs.writeFile(src, Buffer.alloc(1_000_000, 1))
  // O teste de 1 quadro passou, mas a conversão de verdade falha no chip (e com decodificação no chip): libx264 salva.
  process.env.FAKE_FF_HW = ''
  const log = []
  const r = await gerarPrevia(src, { motor: motorWith(bin, 'h264_videotoolbox', ['libx264', 'h264_videotoolbox']), size: 9e9, tmpRoot, log: m => log.push(m) })
  assert.equal(r.estado, 'pronta')
  assert.equal(r.encoder, 'libx264')
  const encs = (await calls()).filter(c => c.args.includes('-progress')).map(c => c.args[c.args.indexOf('-c:v') + 1])
  assert.deepEqual(encs, process.platform === 'darwin' ? ['h264_videotoolbox', 'h264_videotoolbox', 'libx264'] : ['h264_videotoolbox', 'libx264'])
  assert.ok(log.some(l => /h264_videotoolbox/.test(l)))
  await r.limpar()

  process.env.FAKE_FF_PROBE = H264
  const leve = await gerarPrevia(src, { motor: motorWith(bin), name: 'entrevista.mp4', size: 30 * MB, tmpRoot })
  assert.deepEqual(leve, { estado: 'dispensada', motivo: 'já é leve' })

  process.env.FAKE_FF_PROBE = PRORES
  process.env.FAKE_FF_SIZE = String(2_000_000)
  const grande = await gerarPrevia(src, { motor: motorWith(bin), name: 'A001.mov', size: 1_000_000, tmpRoot })
  assert.equal(grande.estado, 'dispensada')
  assert.match(grande.motivo, /não ficou menor/)
  assert.deepEqual(await fs.readdir(tmpRoot), [])

  // Sem conversor nenhum.
  assert.equal((await gerarPrevia(src, { motor: { via: null, aviso: 'sem ffmpeg' }, tmpRoot })).motivo, 'sem ffmpeg')
  // Arquivo que o ffmpeg não abre.
  process.env.FAKE_FF_PROBE = 'qualquer.mov: Invalid data found when processing input\n'
  assert.match((await gerarPrevia(src, { motor: motorWith(bin), tmpRoot })).motivo, /não abriu/)
})

test('gerarPrevia: cancelar mata o ffmpeg na hora e não deixa temporário', { skip: !posix }, async t => {
  const { bin } = await fakeFfmpeg(t)
  const dir = await tmp(t)
  const tmpRoot = await tmp(t, 'sobedesce-previa-tmp-')
  const src = path.join(dir, 'A001.mov')
  await fs.writeFile(src, Buffer.alloc(1000, 1))
  process.env.FAKE_FF_HANG = '1'
  const ac = new AbortController()
  let started = false
  const p = gerarPrevia(src, {
    motor: motorWith(bin),
    size: 9e9,
    tmpRoot,
    signal: ac.signal,
    onProgress: (f, x) => {
      if (f === 'gerando' && x > 0 && !started) {
        started = true
        setTimeout(() => ac.abort(), 20)
      }
    },
  })
  const t0 = Date.now()
  await assert.rejects(p, e => e.name === 'AbortError')
  assert.ok(Date.now() - t0 < 5000)
  assert.ok(started, 'chegou a converter')
  assert.deepEqual(await fs.readdir(tmpRoot), [])
})

test('probe com ffmpeg de mentira devolve a leitura; sem ffmpeg, null', { skip: !posix }, async t => {
  const { bin } = await fakeFfmpeg(t)
  const info = await probe(motorWith(bin), '/qualquer.mov')
  assert.equal(info.video.codec, 'prores')
  assert.equal(await probe({ via: 'avconvert' }, '/x.mov'), null)
})

// ── com um ffmpeg de verdade (pula quando não há) ──

const realFfmpeg = (() => {
  try {
    return spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' }).status === 0 ? 'ffmpeg' : null
  } catch {
    return null
  }
})()

test('ffmpeg de verdade: ProRes 4K de 1 s vira H.264 1280×720 com AAC estéreo e moov no começo', { skip: !realFfmpeg && 'sem ffmpeg neste computador' }, async t => {
  const dir = await tmp(t)
  const tmpRoot = await tmp(t, 'sobedesce-previa-tmp-')
  const src = path.join(dir, 'A001.mov')
  const mk = spawnSync(realFfmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=25:d=1', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-c:v', 'prores_ks', '-profile:v', '1', '-pix_fmt', 'yuv422p10le', '-c:a', 'pcm_s16le', '-ac', '1', src])
  if (mk.status !== 0) return t.skip('este ffmpeg não gera ProRes')
  const motor = await detectarMotor({ candidates: [{ path: (spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).stdout || '').trim() || realFfmpeg, origem: 'sistema' }] })
  assert.equal(motor.via, 'ffmpeg')
  const st = await fs.stat(src)
  const r = await gerarPrevia(src, { motor, size: st.size, tmpRoot })
  assert.equal(r.estado, 'pronta', r.motivo)
  t.after(() => r.limpar())
  assert.ok(r.size < st.size * 0.2, `${r.size} de ${st.size}`)
  const out = parseProbe(spawnSync(realFfmpeg, ['-hide_banner', '-i', r.path], { encoding: 'utf8' }).stderr)
  assert.equal(out.video.codec, 'h264')
  assert.equal(out.video.pixFmt, 'yuv420p')
  assert.equal(out.video.width, 1280)
  assert.equal(out.video.height, 720)
  assert.equal(out.audio, true)
  const head = (await fs.readFile(r.path)).subarray(0, 4096).toString('latin1')
  assert.ok(head.indexOf('moov') > 0 && (head.indexOf('mdat') < 0 || head.indexOf('moov') < head.indexOf('mdat')), 'faststart: moov antes do mdat')
})

// ── scripts/ffmpeg-baixar.mjs: leitor de zip próprio (o ffmpeg do Mac vem em .zip) ──

/** Zip mínimo (sem compressão ou deflate), como os do ffmpeg: cabeçalho local + diretório central + fim. */
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data, deflate } of entries) {
    const body = deflate ? zlib.deflateRawSync(data) : data
    const n = Buffer.from(name)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(deflate ? 8 : 0, 8)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(n.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(deflate ? 8 : 0, 10)
    ch.writeUInt32LE(body.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(n.length, 28)
    ch.writeUInt32LE(offset, 42)
    locals.push(lh, n, body)
    centrals.push(ch, n)
    offset += 30 + n.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

test('ffmpeg-baixar: tira o executável do zip (deflate e sem compressão); fontes fixas com SHA-256', async () => {
  const { unzipEntry, FONTES } = await import('../scripts/ffmpeg-baixar.mjs')
  const bin = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(200_000, 7)])
  const zip = makeZip([
    { name: 'LEIAME.txt', data: Buffer.from('oi') },
    { name: 'ffmpeg', data: bin, deflate: true },
  ])
  assert.deepEqual(unzipEntry(zip, 'ffmpeg'), bin)
  assert.equal(unzipEntry(zip, 'LEIAME.txt').toString(), 'oi')
  assert.throws(() => unzipEntry(zip, 'ffprobe'), /não está no zip/)
  assert.throws(() => unzipEntry(Buffer.alloc(100), 'ffmpeg'), /diretório central/)
  for (const [alvo, f] of Object.entries(FONTES)) {
    assert.match(f.url, /^https:\/\//, alvo)
    assert.match(f.sha256, /^[0-9a-f]{64}$/, alvo)
  }
  assert.deepEqual(Object.keys(FONTES).sort(), ['mac-arm64', 'mac-x64', 'win-x64'])
})
