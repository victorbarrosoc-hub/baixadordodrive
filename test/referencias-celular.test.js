// Referência que toca no iPhone (src/referencias/celular.js): o formato pedido ao yt-dlp prefere H.264 ao VP9 do
// Instagram, o vídeo baixado em VP9/AV1 vira H.264 antes de subir e a passada única converte as antigas.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { formato } from '../src/referencias/ytdlp.js'
import { CELULAR_OK, ConsertoCelular, paraCelular, precisaConferir } from '../src/referencias/celular.js'
import { argsTranscode, detectarMotor, parseProbe, probe, tocaNoIphone } from '../src/media/previa.js'
import { makeTmpDir } from './helpers.js'

const FAKE_FF = fileURLToPath(new URL('./fake-ffmpeg.mjs', import.meta.url))
let dir

before(async () => {
  dir = await makeTmpDir('sd-celular-')
})
after(async () => {
  delete process.env.FAKE_FF_PROBE
  delete process.env.FAKE_FF_LOG
  await fs.rm(dir, { recursive: true, force: true })
})

const VP9 = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'media.mp4':
  Duration: 00:00:40.00, start: 0.000000, bitrate: 744 kb/s
  Stream #0:0[0x1](und): Video: vp9 (Profile 0) (vp09 / 0x39307076), yuv420p(tv, bt709), 540x960, 680 kb/s, SAR 1:1 DAR 9:16, 30 fps, 30 tbr, 15360 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (HE-AAC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 62 kb/s (default)
At least one output file must be specified
`
const H264 = VP9.replace('vp9 (Profile 0) (vp09 / 0x39307076)', 'h264 (High) (avc1 / 0x31637661)')

test('formato: H.264 separado, depois o progressivo que toca no iPhone, e só então VP9/AV1', () => {
  const f = formato()
  const partes = f.split('/')
  assert.equal(partes[0], 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]')
  // O progressivo do Instagram (H.264, codec não informado) vem antes do MP4 separado em VP9.
  assert.equal(partes[1], 'b[height<=?1920][ext=mp4][vcodec!^=?vp][vcodec!^=?av01]')
  assert.ok(f.indexOf('[vcodec!^=?vp]') < f.indexOf('bv*[height<=1080][ext=mp4]+ba[ext=m4a]'), 'VP9/AV1 só depois')
  assert.equal(partes.at(-1), 'b')
  assert.match(formato({ ffmpeg: false }), /^b\[height<=\?1920\]\[ext=mp4\]\[vcodec!\^=\?vp\]/)
})

test('tocaNoIphone: VP9, VP8 e AV1 não; H.264 e HEVC sim', () => {
  assert.equal(tocaNoIphone(parseProbe(VP9)), false)
  assert.equal(tocaNoIphone(parseProbe(H264)), true)
  assert.equal(tocaNoIphone(parseProbe(VP9.replace('vp9 (Profile 0)', 'av1 (Main)'))), false)
  assert.equal(tocaNoIphone(parseProbe(VP9.replace('vp9 (Profile 0)', 'hevc (Main)'))), true)
  assert.equal(tocaNoIphone(null), true, 'sem vídeo (áudio, foto): nada a fazer')
})

test('argsTranscode: lado maior configurável (a prévia continua 1280; o celular usa 1920)', () => {
  const vf = a => a[a.indexOf('-vf') + 1]
  assert.match(vf(argsTranscode({ input: 'a', output: 'b' })), /min\(1280,iw\)/)
  assert.match(vf(argsTranscode({ input: 'a', output: 'b', lado: 1920 })), /min\(1920,iw\)/)
})

test('paraCelular (ffmpeg de mentira): VP9 vira H.264 até 1920 px; H.264 fica; sem conversor, sobe como veio', async () => {
  const bin = path.join(dir, 'ffmpeg')
  await fs.copyFile(FAKE_FF, bin)
  await fs.chmod(bin, 0o755)
  const logFile = path.join(dir, 'ff.jsonl')
  process.env.FAKE_FF_LOG = logFile
  const motor = { via: 'ffmpeg', ffmpeg: { path: bin }, encoder: { nome: 'libx264', hardware: false }, encoders: ['libx264'] }
  const file = path.join(dir, 'media.mp4')
  await fs.writeFile(file, Buffer.alloc(8192, 1))

  process.env.FAKE_FF_PROBE = H264
  assert.deepEqual(await paraCelular(file, { motor, tmpRoot: dir }), { estado: 'ok' })

  process.env.FAKE_FF_PROBE = VP9
  const r = await paraCelular(file, { motor, tmpRoot: dir })
  assert.equal(r.estado, 'convertido')
  assert.equal(r.codec, 'vp9')
  assert.ok((await fs.stat(r.path)).size > 1024)
  const conv = (await fs.readFile(logFile, 'utf8')).trim().split('\n').map(l => JSON.parse(l)).find(l => l.args.includes('-progress'))
  assert.equal(conv.args[conv.args.indexOf('-c:v') + 1], 'libx264')
  assert.match(conv.args[conv.args.indexOf('-vf') + 1], /min\(1920,iw\)/)
  assert.ok(conv.args.includes('+faststart'))
  await r.limpar()
  await assert.rejects(fs.stat(r.path), 'temporário apagado')

  assert.deepEqual(await paraCelular(file, { motor: { via: 'avconvert' } }), { estado: 'sem_conversor' })
  assert.deepEqual(await paraCelular(file, { motor: { via: null } }), { estado: 'sem_conversor' })
})

function ffmpegComVp9() {
  try {
    const enc = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' })
    return /libvpx-vp9/.test(enc) && /libx264/.test(enc)
  } catch {
    return false
  }
}

test('paraCelular com o ffmpeg de verdade: um MP4 em VP9 sai H.264 + AAC', { skip: !ffmpegComVp9() && 'sem ffmpeg com VP9 e x264 aqui' }, async () => {
  const vp9 = path.join(dir, 'vp9.mp4')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=270x480:r=30:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libvpx-vp9', '-b:v', '200k', '-c:a', 'aac', '-shortest', vp9])
  const motor = await detectarMotor({ candidates: [{ path: execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim(), origem: 'sistema' }], platform: 'linux' })
  assert.equal((await probe(motor, vp9)).video.codec, 'vp9')
  const r = await paraCelular(vp9, { motor, tmpRoot: dir })
  assert.equal(r.estado, 'convertido')
  const info = await probe(motor, r.path)
  assert.equal(info.video.codec, 'h264')
  assert.equal(info.video.width, 270)
  assert.equal(info.audio, true)
  await r.limpar()
})

const ref = (id, extra = {}) => ({
  id,
  name: `${id}.mp4`,
  mimeType: 'video/mp4',
  size: 5_000_000,
  isFolder: false,
  appProperties: { sobedesce: 'referencia' },
  ...extra,
})

test('precisaConferir: só vídeo de referência da SOBEDESCE, sem a marca e não enorme', () => {
  assert.equal(precisaConferir(ref('a')), true)
  assert.equal(precisaConferir(ref('b', { appProperties: { sobedesce: 'referencia', celular: CELULAR_OK } })), false)
  assert.equal(precisaConferir(ref('c', { appProperties: {} })), false, 'arquivo que não foi o app que salvou')
  assert.equal(precisaConferir(ref('d', { mimeType: 'image/jpeg' })), false)
  assert.equal(precisaConferir(ref('e', { size: 900e6 })), false)
})

function montarConserto({ converter, falhar = new Set(), colecoes = [{ id: 'c1' }, { id: 'c2' }] } = {}) {
  const chamadas = { baixados: [], substituidos: [], marcados: [], limpos: 0, ajustes: [] }
  let ajustes = { referenciasCelular: false }
  const itens = {
    c1: [ref('vp9'), ref('h264'), ref('ja', { appProperties: { sobedesce: 'referencia', celular: 'ok' } }), ref('foto', { mimeType: 'image/jpeg' })],
    c2: [ref('quebrado')],
  }
  const conserto = new ConsertoCelular({
    service: {
      listarColecoes: async () => ({ colecoes }),
      itens: async id => ({ itens: itens[id] || [], accountId: 'nuvem:g1' }),
      recarregar: () => (chamadas.recarregou = true),
    },
    settings: { get: () => ajustes, update: async p => (chamadas.ajustes.push(p), (ajustes = { ...ajustes, ...p })) },
    manager: {
      driveFor: id => ({ conta: id }),
      previas: {
        baixarOriginal: async (_drive, item) => {
          chamadas.baixados.push(item.id)
          return { path: `/tmp/${item.id}`, limpar: async () => chamadas.limpos++ }
        },
      },
    },
    motor: async () => ({ via: 'ffmpeg' }),
    converter:
      converter ||
      (async file => {
        const id = path.basename(file)
        if (falhar.has(id)) throw new Error('codificador caiu')
        if (id === 'vp9' || id === 'quebrado') return { estado: 'convertido', path: `/tmp/${id}.h264`, limpar: async () => chamadas.limpos++ }
        return { estado: 'ok' }
      }),
    substituir: async (drive, item, localPath) => chamadas.substituidos.push([drive.conta, item.id, localPath]),
    marcar: async (_drive, id) => chamadas.marcados.push(id),
  })
  return { conserto, chamadas, ajustes: () => ajustes }
}

test('ConsertoCelular: converte VP9 no mesmo arquivo, marca o que já toca, pula o resto e termina uma vez só', async () => {
  const { conserto, chamadas, ajustes } = montarConserto()
  const r = await conserto.rodar()
  assert.deepEqual(r, { conferidos: 3, convertidos: 2, falhas: 0 })
  assert.deepEqual(chamadas.baixados, ['vp9', 'h264', 'quebrado'], 'só referências de vídeo sem a marca')
  assert.deepEqual(chamadas.substituidos, [
    ['nuvem:g1', 'vp9', '/tmp/vp9.h264'],
    ['nuvem:g1', 'quebrado', '/tmp/quebrado.h264'],
  ])
  assert.deepEqual(chamadas.marcados, ['h264'])
  assert.equal(chamadas.limpos, 5, 'temporários do original e da conversão apagados')
  assert.equal(ajustes().referenciasCelular, true)
  assert.equal(chamadas.recarregou, true)
  assert.equal(await conserto.rodar(), null, 'já feito: não roda de novo')
  assert.equal(chamadas.baixados.length, 3)
})

test('ConsertoCelular: um arquivo que falha fica para a próxima abertura (ajuste não grava)', async () => {
  const { conserto, chamadas, ajustes } = montarConserto({ falhar: new Set(['quebrado']) })
  const r = await conserto.rodar()
  assert.deepEqual(r, { conferidos: 2, convertidos: 1, falhas: 1 })
  assert.equal(ajustes().referenciasCelular, false)
  assert.deepEqual(chamadas.ajustes, [])
})

test('ConsertoCelular: sem ffmpeg com H.264, não baixa nada', async () => {
  const { conserto, chamadas } = montarConserto()
  conserto.motor = async () => ({ via: 'avconvert' })
  assert.equal(await conserto.rodar(), null)
  assert.deepEqual(chamadas.baixados, [])
})
