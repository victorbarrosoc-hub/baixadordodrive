// "Baixar como…" (src/referencias/formatos.js): a tabela de formatos, o nome do convertido, a linha de comando do
// ffmpeg para cada formato (MP3 320 = 320k CBR), as frases de erro e, com um ffmpeg de mentira, o caminho todo da
// conversão (codificador que falha e o seguinte, cancelar, travar). Com o ffmpeg de verdade (/usr/bin/ffmpeg), converte
// um vídeo curto feito na hora e confere com o ffprobe: MP3 a 320 kbps constantes, WAV 48 kHz, M4A sem perda, MP4 720p.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  FORMATOS, FormatoError, argsFormato, codificadorVideo, converterFormato, formatoServe, formatosPara, lerAudio, limparFormatos, nomeConvertido, planoVideo, tipoDoArquivo,
} from '../src/referencias/formatos.js'
import { NOME_MAX } from '../src/referencias/metadados.js'
import { makeTmpDir } from './helpers.js'

const valor = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
const h264 = { codec: 'h264', bits: 8, pixFmt: 'yuv420p', width: 1920, height: 1080, sar: null }
const aac = { codec: 'aac', hz: 44100, canais: 'stereo' }
const info = (video = h264, audioInfo = aac) => ({ durationS: 10, video, audio: Boolean(audioInfo), audioInfo })
const base = { entrada: '/tmp/in.mp4', saida: '/tmp/out' }

describe('tabela e nomes', () => {
  test('vídeo tem original, MP4 (3 qualidades) e os 3 áudios; foto tem original e JPG', () => {
    assert.deepEqual(formatosPara('video'), ['original', 'mp4', 'mp4-1080', 'mp4-720', 'mp3-320', 'wav', 'm4a'])
    assert.deepEqual(formatosPara('foto'), ['original', 'jpg'])
    assert.ok(formatoServe('mp3-320', 'video'))
    assert.ok(!formatoServe('mp3-320', 'foto'))
    assert.ok(!formatoServe('constructor', 'video'), 'só os formatos da tabela (nada do protótipo)')
    assert.equal(tipoDoArquivo({ mimeType: 'video/mp4' }), 'video')
    assert.equal(tipoDoArquivo({ mimeType: 'image/webp' }), 'foto')
    assert.equal(tipoDoArquivo({ name: 'a.MOV' }), 'video')
    assert.equal(tipoDoArquivo({ mimeType: 'application/pdf', name: 'a.pdf' }), null)
  })

  test('limparFormatos: só os conhecidos, sem o original, sem repetir', () => {
    assert.deepEqual(limparFormatos(['mp3-320', 'original', 'mp3-320', 'xyz', 'wav', '__proto__']), ['mp3-320', 'wav'])
    assert.deepEqual(limparFormatos('mp3-320'), [])
    assert.deepEqual(limparFormatos(null), [])
  })

  test('nome com sufixo claro ao lado do original, sempre até 120 caracteres', () => {
    assert.equal(nomeConvertido('Estúdio Norte - Plano na chuva (Instagram).mp4', 'mp3-320'), 'Estúdio Norte - Plano na chuva (Instagram) (MP3 320).mp3')
    assert.equal(nomeConvertido('Clipe (YouTube).webm', 'mp4-720'), 'Clipe (YouTube) (MP4 720p).mp4')
    assert.equal(nomeConvertido('Clipe (YouTube).mp4', 'wav'), 'Clipe (YouTube) (WAV).wav')
    assert.equal(nomeConvertido('Clipe.mp4', 'm4a'), 'Clipe (M4A).m4a')
    assert.equal(nomeConvertido('Foto (Pinterest).webp', 'jpg'), 'Foto (Pinterest) (JPG).jpg')
    assert.equal(nomeConvertido('', 'mp3-320'), 'Referência (MP3 320).mp3')
    assert.equal(nomeConvertido('a/b:c*?.mp4', 'wav'), 'a b c (WAV).wav')
    const longo = nomeConvertido(`${'x'.repeat(130)}.mp4`, 'mp4-1080')
    assert.ok([...longo].length <= NOME_MAX, longo)
    assert.match(longo, /… \(MP4 1080p\)\.mp4$/)
    assert.throws(() => nomeConvertido('a.mp4', 'original'))
  })

  test('lerAudio: codec, frequência e canais da primeira trilha', () => {
    assert.deepEqual(lerAudio('  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 127 kb/s (default)'), { codec: 'aac', hz: 44100, canais: 'stereo' })
    assert.deepEqual(lerAudio('  Stream #0:1: Audio: opus, 48000 Hz, 5.1, fltp (default)'), { codec: 'opus', hz: 48000, canais: '5.1' })
    assert.equal(lerAudio('  Stream #0:0: Video: h264'), null)
  })
})

describe('linha de comando de cada formato', () => {
  test('MP3 320: libmp3lame a 320k constante (CBR: -b:a, nunca -q:a), só o áudio', () => {
    const { args, modo } = argsFormato({ ...base, formato: 'mp3-320', info: info() })
    assert.equal(modo, 'converte')
    assert.equal(valor(args, '-c:a'), 'libmp3lame')
    assert.equal(valor(args, '-b:a'), '320k')
    assert.ok(!args.includes('-q:a') && !args.includes('-abr'), 'nada de VBR/ABR')
    assert.equal(valor(args, '-map'), '0:a:0')
    assert.ok(args.includes('-vn'))
    assert.equal(valor(args, '-f'), 'mp3')
    assert.equal(args.at(-1), '/tmp/out')
    assert.ok(!args.includes('-ar') && !args.includes('-ac'), 'estéreo 44,1 kHz fica como está')
    // 96 kHz e 5.1: o MP3 não aceita; desce para 48 kHz e estéreo.
    const r = argsFormato({ ...base, formato: 'mp3-320', info: info(h264, { codec: 'flac', hz: 96000, canais: '5.1' }) })
    assert.equal(valor(r.args, '-ar'), '48000')
    assert.equal(valor(r.args, '-ac'), '2')
  })

  test('WAV: PCM 16 bits a 48 kHz; M4A copia o AAC (sem perda) ou converte para AAC 256k', () => {
    const w = argsFormato({ ...base, formato: 'wav', info: info() })
    assert.equal(valor(w.args, '-c:a'), 'pcm_s16le')
    assert.equal(valor(w.args, '-ar'), '48000')
    assert.equal(valor(w.args, '-f'), 'wav')
    const m = argsFormato({ ...base, formato: 'm4a', info: info() })
    assert.equal(m.modo, 'copia')
    assert.equal(valor(m.args, '-c:a'), 'copy')
    assert.equal(valor(m.args, '-f'), 'ipod')
    const o = argsFormato({ ...base, formato: 'm4a', info: info(h264, { codec: 'opus', hz: 48000, canais: 'stereo' }) })
    assert.equal(o.modo, 'converte')
    assert.equal(valor(o.args, '-c:a'), 'aac')
    assert.equal(valor(o.args, '-b:a'), '256k')
  })

  test('MP4: H.264 + AAC que já cabe só troca o contêiner; VP9 converte com libx264 CRF 18', () => {
    const c = argsFormato({ ...base, formato: 'mp4', info: info() })
    assert.equal(c.modo, 'copia')
    assert.equal(valor(c.args, '-c:v'), 'copy')
    assert.equal(valor(c.args, '-c:a'), 'copy')
    assert.ok(c.args.includes('+faststart'))
    assert.equal(valor(c.args, '-f'), 'mp4')
    const vp9 = argsFormato({ ...base, formato: 'mp4', info: info({ ...h264, codec: 'vp9' }, { codec: 'opus', hz: 48000, canais: 'stereo' }) })
    assert.equal(vp9.modo, 'converte')
    assert.equal(valor(vp9.args, '-c:v'), 'libx264')
    assert.equal(valor(vp9.args, '-crf'), '18')
    assert.equal(valor(vp9.args, '-c:a'), 'aac')
    assert.equal(valor(vp9.args, '-b:a'), '192k')
    assert.match(valor(vp9.args, '-vf'), /format=yuv420p$/)
  })

  test('MP4 1080p / 720p: o lado menor vira o limite (também na vertical); menor que o limite não aumenta', () => {
    const h = argsFormato({ ...base, formato: 'mp4-720', info: info() })
    assert.equal(h.modo, 'converte')
    assert.match(valor(h.args, '-vf'), /scale=w='if\(gte\(iw,ih\),-2,720\)':h='if\(gte\(iw,ih\),720,-2\)'/)
    const vertical = argsFormato({ ...base, formato: 'mp4-1080', info: info({ ...h264, width: 1080, height: 1920 }) })
    assert.equal(vertical.modo, 'copia', '1080 × 1920 já é 1080p')
    const vertical4k = argsFormato({ ...base, formato: 'mp4-1080', info: info({ ...h264, width: 2160, height: 3840 }) })
    assert.match(valor(vertical4k.args, '-vf'), /720\)|1080\)/)
    const pequeno = argsFormato({ ...base, formato: 'mp4-1080', info: info({ ...h264, width: 1280, height: 720 }) })
    assert.equal(pequeno.modo, 'copia')
  })

  test('MP4: anamórfico vira pixel quadrado, HEVC 10 bits converte, sem áudio sai sem áudio', () => {
    const ana = argsFormato({ ...base, formato: 'mp4', info: info({ ...h264, sar: [4, 3] }) })
    assert.equal(ana.modo, 'converte')
    assert.match(valor(ana.args, '-vf'), /^scale=w='trunc\(iw\*sar\/2\)\*2':h=ih,setsar=1/)
    const hevc = argsFormato({ ...base, formato: 'mp4', info: info({ ...h264, codec: 'hevc', bits: 10, pixFmt: 'yuv420p10le' }) })
    assert.equal(hevc.modo, 'converte')
    const mudo = argsFormato({ ...base, formato: 'mp4', info: info(h264, null) })
    assert.ok(mudo.args.includes('-an'))
    assert.ok(!mudo.args.includes('0:a:0'))
  })

  test('codificador da máquina: taxa pelo tamanho de saída (hardware não tem CRF)', () => {
    const vt = argsFormato({ ...base, formato: 'mp4-720', info: info({ ...h264, codec: 'vp9' }), encoder: 'h264_videotoolbox' })
    assert.equal(valor(vt.args, '-c:v'), 'h264_videotoolbox')
    assert.equal(valor(vt.args, '-b:v'), '6M')
    assert.equal(valor(codificadorVideo('h264_nvenc', 1080), '-b:v'), '10M')
    assert.match(valor(argsFormato({ ...base, formato: 'mp4', info: info({ ...h264, codec: 'vp9' }), encoder: 'h264_qsv' }).args, '-vf'), /format=nv12$/)
    assert.deepEqual(planoVideo(new Set(['libx264', 'h264_videotoolbox']), 'h264_videotoolbox'), ['libx264', 'h264_videotoolbox'])
    assert.deepEqual(planoVideo(new Set(['h264_nvenc']), null), ['h264_nvenc'])
    assert.deepEqual(planoVideo(new Set(['libmp3lame']), null), [])
  })

  test('JPG: foto JPEG vai como está; WebP/PNG viram JPEG qualidade alta', () => {
    assert.equal(argsFormato({ ...base, formato: 'jpg', info: null, mimeType: 'image/jpeg' }).modo, 'arquivo')
    const w = argsFormato({ ...base, formato: 'jpg', info: { video: { codec: 'webp' }, audio: false }, mimeType: 'image/webp' })
    assert.equal(valor(w.args, '-c:v'), 'mjpeg')
    assert.equal(valor(w.args, '-q:v'), '2')
    assert.equal(valor(w.args, '-frames:v'), '1')
  })

  test('erros claros: áudio de vídeo mudo, MP4 de um arquivo sem imagem', () => {
    assert.throws(() => argsFormato({ ...base, formato: 'mp3-320', info: info(h264, null) }), e => e instanceof FormatoError && e.codigo === 'sem_audio' && e.message === 'Este vídeo não tem áudio.')
    assert.throws(() => argsFormato({ ...base, formato: 'mp4', info: { durationS: 3, video: null, audio: true, audioInfo: aac } }), e => e.codigo === 'sem_video')
    assert.throws(() => argsFormato({ ...base, formato: 'original', info: info() }), e => e.codigo === 'formato')
  })
})

// ─────────── conversão com um ffmpeg de mentira ───────────

const PROBE = {
  h264: 'Input #0, mov,mp4,m4a,3gp,3g2,mj2, from \'in.mp4\':\n  Duration: 00:00:10.00, start: 0.000000, bitrate: 2000 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 1800 kb/s, 25 fps\n  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)\nAt least one output file must be specified\n',
  vp9: 'Input #0, matroska,webm, from \'in.webm\':\n  Duration: 00:00:10.00, start: 0.000000, bitrate: 900 kb/s\n  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv), 1080x1920, SAR 1:1 DAR 9:16, 30 fps\n  Stream #0:1: Audio: opus, 48000 Hz, stereo, fltp (default)\n',
  mudo: 'Input #0, mov,mp4,m4a,3gp,3g2,mj2, from \'in.mp4\':\n  Duration: 00:00:10.00, start: 0.000000, bitrate: 2000 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080, 1800 kb/s, 25 fps\n',
  lixo: 'in.bin: Invalid data found when processing input\n',
}
const ENCODERS = (nomes) => `Encoders:\n V..... = Video\n A..... = Audio\n ------\n${nomes.map((n) => ` ${n.startsWith('lib') && n !== 'libmp3lame' ? 'V' : n.startsWith('h264') ? 'V' : 'A'}....D ${n.padEnd(20)} descrição`).join('\n')}\n`

/** runTool de mentira: `-i` sem saída = sondar; `-encoders` = lista; o resto = converter (grava a saída). */
function fakeRun({ probe = PROBE.h264, encoders = ['libx264', 'libmp3lame', 'aac', 'pcm_s16le', 'mjpeg'], falha = () => null } = {}) {
  const chamadas = []
  let n = 0
  const run = async (cmd, args, opts = {}) => {
    chamadas.push({ cmd, args })
    if (args.includes('-encoders')) return { code: 0, stdout: ENCODERS(encoders), stderr: '' }
    if (!args.includes('-progress')) return { code: 1, stdout: '', stderr: probe }
    if (opts.signal?.aborted) return { code: null, aborted: true, stdout: '', stderr: '' }
    const f = falha(args, n++)
    if (f) return { code: 1, stdout: '', stderr: 'blá\n', ...f }
    opts.onStdout?.('frame=10\nout_time_us=5000000\nprogress=continue\n')
    await fsp.writeFile(args.at(-1), 'convertido')
    opts.onStdout?.('out_time_us=10000000\nprogress=end\n')
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, chamadas }
}

describe('converterFormato (ffmpeg de mentira)', () => {
  test('MP3 320: sonda, confere o libmp3lame, converte e conta o andamento', async () => {
    const dir = await makeTmpDir('sd-fmt-')
    const { run, chamadas } = fakeRun()
    const andamento = []
    // ffmpeg com um caminho só deste teste: a lista de codificadores fica guardada por caminho.
    const r = await converterFormato({ ffmpeg: '/x/ffmpeg-1', formato: 'mp3-320', entrada: path.join(dir, 'in.mp4'), saida: path.join(dir, 'out.mp3'), run, onProgress: (f) => andamento.push(f) })
    assert.equal(r.modo, 'converte')
    assert.equal(r.info.audioInfo.codec, 'aac')
    const conv = chamadas.find((c) => c.args.includes('-progress'))
    assert.equal(valor(conv.args, '-b:a'), '320k')
    assert.deepEqual(andamento, [0.5, 0.999, 1])
    assert.equal(await fsp.readFile(path.join(dir, 'out.mp3'), 'utf8'), 'convertido')
  })

  test('sem ffmpeg, sem MP3 no ffmpeg, arquivo que não abre: frases claras', async () => {
    const dir = await makeTmpDir('sd-fmt-')
    const o = { formato: 'mp3-320', entrada: path.join(dir, 'in.mp4'), saida: path.join(dir, 'o.mp3') }
    await assert.rejects(converterFormato({ ...o, ffmpeg: null, run: fakeRun().run }), (e) => e.codigo === 'sem_ffmpeg' && /falta o ffmpeg/.test(e.message))
    await assert.rejects(converterFormato({ ...o, ffmpeg: '/x/ffmpeg-2', run: fakeRun({ encoders: ['libx264', 'aac'] }).run }), (e) => e.codigo === 'sem_codificador' && /não gera MP3/.test(e.message))
    await assert.rejects(converterFormato({ ...o, ffmpeg: '/x/ffmpeg-3', run: fakeRun({ probe: PROBE.lixo }).run }), (e) => e.codigo === 'nao_abriu')
    await assert.rejects(converterFormato({ ...o, ffmpeg: '/x/ffmpeg-4', run: fakeRun({ probe: PROBE.mudo }).run }), (e) => e.message === 'Este vídeo não tem áudio.')
    const abrir = async () => ({ code: null, error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), stdout: '', stderr: '' })
    await assert.rejects(converterFormato({ ...o, ffmpeg: '/x/nao-existe', run: abrir }), (e) => e.codigo === 'sem_ffmpeg')
  })

  test('ffmpeg falhou: "Não consegui converter para …" com o detalhe só no log; nada de arquivo pela metade', async () => {
    const dir = await makeTmpDir('sd-fmt-')
    const logs = []
    const saida = path.join(dir, 'o.wav')
    const { run } = fakeRun({ falha: () => ({ stderr: 'Error while opening encoder\n' }) })
    await assert.rejects(converterFormato({ ffmpeg: '/x/ffmpeg-5', formato: 'wav', entrada: 'in.mp4', saida, run, log: (m) => logs.push(m) }), (e) => {
      assert.equal(e.codigo, 'conversao')
      assert.equal(e.message, 'Não consegui converter para WAV.')
      assert.match(e.detalhe, /Error while opening encoder/)
      return true
    })
    assert.ok(logs.some((l) => /Error while opening encoder/.test(l)))
    assert.ok(!fs.existsSync(saida))
  })

  test('MP4 de um VP9: libx264 falhou, tenta o codificador da máquina; sem nenhum H.264, diz isso', async () => {
    const dir = await makeTmpDir('sd-fmt-')
    const { run, chamadas } = fakeRun({ probe: PROBE.vp9, encoders: ['libx264', 'h264_videotoolbox', 'aac'], falha: (args) => (valor(args, '-c:v') === 'libx264' ? { stderr: 'x264 [error]: malloc failed\n' } : null) })
    const r = await converterFormato({ ffmpeg: '/x/ffmpeg-6', formato: 'mp4-1080', entrada: 'in.webm', saida: path.join(dir, 'o.mp4'), motorEncoder: 'h264_videotoolbox', run })
    assert.equal(r.encoder, 'h264_videotoolbox')
    assert.deepEqual(chamadas.filter((c) => c.args.includes('-progress')).map((c) => valor(c.args, '-c:v')), ['libx264', 'h264_videotoolbox'])
    await assert.rejects(converterFormato({ ffmpeg: '/x/ffmpeg-7', formato: 'mp4', entrada: 'in.webm', saida: path.join(dir, 'p.mp4'), run: fakeRun({ probe: PROBE.vp9, encoders: ['aac'] }).run }), (e) => e.codigo === 'sem_codificador' && /H\.264/.test(e.message))
    // H.264 + AAC que já cabe: só troca o contêiner, nem precisa de codificador de vídeo.
    const c = await converterFormato({ ffmpeg: '/x/ffmpeg-8', formato: 'mp4', entrada: 'in.mp4', saida: path.join(dir, 'q.mp4'), run: fakeRun({ encoders: ['aac'] }).run })
    assert.equal(c.modo, 'copia')
  })

  test('cancelar e travar', async () => {
    const dir = await makeTmpDir('sd-fmt-')
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(converterFormato({ ffmpeg: '/x/ffmpeg-9', formato: 'wav', entrada: 'in.mp4', saida: path.join(dir, 'a.wav'), run: fakeRun().run, signal: ac.signal }), { name: 'AbortError' })
    const { run } = fakeRun({ falha: () => ({ code: null, stalled: true }) })
    await assert.rejects(converterFormato({ ffmpeg: '/x/ffmpeg-10', formato: 'wav', entrada: 'in.mp4', saida: path.join(dir, 'b.wav'), run }), (e) => e.codigo === 'tempo')
  })

  test('foto JPEG: copia sem ffmpeg', async () => {
    const dir = await makeTmpDir('sd-fmt-')
    const entrada = path.join(dir, 'foto.jpg')
    await fsp.writeFile(entrada, 'jpeg')
    const r = await converterFormato({ ffmpeg: null, formato: 'jpg', entrada, saida: path.join(dir, 'saida.jpg'), mimeType: 'image/jpeg' })
    assert.equal(r.modo, 'arquivo')
    assert.equal(await fsp.readFile(path.join(dir, 'saida.jpg'), 'utf8'), 'jpeg')
  })
})

// ─────────── com o ffmpeg de verdade ───────────

const FFMPEG = '/usr/bin/ffmpeg'
const FFPROBE = '/usr/bin/ffprobe'
const temFfmpeg = fs.existsSync(FFMPEG) && fs.existsSync(FFPROBE)

function sonda(file, extra = []) {
  const r = spawnSync(FFPROBE, ['-v', 'error', ...extra, '-of', 'json', file], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

describe('com o ffmpeg de verdade', { skip: temFfmpeg ? false : 'sem /usr/bin/ffmpeg neste ambiente' }, () => {
  let dir, video
  test('prepara um vídeo de 3 s (H.264 1920×1080 + AAC 44,1 kHz)', async () => {
    dir = await makeTmpDir('sd-fmt-real-')
    video = path.join(dir, 'fonte.mp4')
    const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', video])
    assert.equal(r.status, 0, String(r.stderr))
  })

  test('MP3 320: sai MP3 a 320 kbps, taxa constante (todos os quadros do mesmo tamanho)', async () => {
    const saida = path.join(dir, 'a.mp3')
    const r = await converterFormato({ ffmpeg: FFMPEG, formato: 'mp3-320', entrada: video, saida })
    assert.equal(r.modo, 'converte')
    const s = sonda(saida, ['-show_entries', 'stream=codec_name,bit_rate,sample_rate,channels'])
    assert.equal(s.streams.length, 1, 'só o áudio')
    assert.equal(s.streams[0].codec_name, 'mp3')
    assert.equal(Number(s.streams[0].bit_rate), 320000)
    assert.equal(Number(s.streams[0].sample_rate), 44100)
    // CBR: a 320 kbps / 44,1 kHz cada quadro tem 1044 ou 1045 bytes (o byte de preenchimento). VBR variaria muito.
    const pacotes = sonda(saida, ['-select_streams', 'a:0', '-show_entries', 'packet=size']).packets.map((p) => Number(p.size))
    assert.ok(pacotes.length > 50)
    assert.ok(pacotes.every((n) => n === 1044 || n === 1045), `tamanhos: ${[...new Set(pacotes)].join(', ')}`)
  })

  test('WAV 48 kHz 16 bits, M4A copiado sem perda, MP4 copiado e MP4 720p convertido', async () => {
    await converterFormato({ ffmpeg: FFMPEG, formato: 'wav', entrada: video, saida: path.join(dir, 'a.wav') })
    const w = sonda(path.join(dir, 'a.wav'), ['-show_entries', 'stream=codec_name,sample_rate']).streams[0]
    assert.equal(w.codec_name, 'pcm_s16le')
    assert.equal(Number(w.sample_rate), 48000)
    const m = await converterFormato({ ffmpeg: FFMPEG, formato: 'm4a', entrada: video, saida: path.join(dir, 'a.m4a') })
    assert.equal(m.modo, 'copia')
    const ms = sonda(path.join(dir, 'a.m4a'), ['-show_entries', 'stream=codec_name']).streams
    assert.deepEqual(ms.map((s) => s.codec_name), ['aac'])
    const c = await converterFormato({ ffmpeg: FFMPEG, formato: 'mp4', entrada: video, saida: path.join(dir, 'a.mp4') })
    assert.equal(c.modo, 'copia')
    const r = await converterFormato({ ffmpeg: FFMPEG, formato: 'mp4-720', entrada: video, saida: path.join(dir, 'b.mp4') })
    assert.equal(r.modo, 'converte')
    const v = sonda(path.join(dir, 'b.mp4'), ['-show_entries', 'stream=codec_name,width,height']).streams
    assert.deepEqual(v.map((s) => s.codec_name), ['h264', 'aac'])
    assert.equal(v[0].width, 1280)
    assert.equal(v[0].height, 720)
  })

  test('foto PNG vira JPG; vídeo sem áudio recusa o MP3', async () => {
    const png = path.join(dir, 'f.png')
    assert.equal(spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240', '-frames:v', '1', png]).status, 0)
    await converterFormato({ ffmpeg: FFMPEG, formato: 'jpg', entrada: png, saida: path.join(dir, 'f.jpg'), mimeType: 'image/png' })
    assert.equal(sonda(path.join(dir, 'f.jpg'), ['-show_entries', 'stream=codec_name']).streams[0].codec_name, 'mjpeg')
    const mudo = path.join(dir, 'mudo.mp4')
    assert.equal(spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', mudo]).status, 0)
    await assert.rejects(converterFormato({ ffmpeg: FFMPEG, formato: 'mp3-320', entrada: mudo, saida: path.join(dir, 'm.mp3') }), (e) => e.message === 'Este vídeo não tem áudio.')
    await fsp.rm(dir, { recursive: true, force: true })
  })
})

test('FORMATOS: todo formato com arquivo próprio tem extensão e rótulo curto', () => {
  for (const f of Object.values(FORMATOS)) {
    assert.ok(f.titulo && f.curto)
    if (f.id !== 'original') assert.match(f.ext, /^[a-z0-9]+$/)
  }
})
