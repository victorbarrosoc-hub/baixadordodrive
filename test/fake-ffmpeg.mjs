#!/usr/bin/env node
// ffmpeg de mentira para os testes da prévia leve (test/previa.test.js). Responde ao que o motor pede:
// -version, -encoders, o teste de 1 quadro (lavfi), a leitura (`-i arquivo` sem saída) e a conversão (-progress).
// Controlado por variáveis de ambiente:
//   FAKE_FF_LOG   arquivo onde cada chamada vira uma linha JSON { args, nice }
//   FAKE_FF_HW    codificadores de hardware que "funcionam" (ex.: "h264_nvenc"); os outros falham
//   FAKE_FF_ENC   codificadores que aparecem em -encoders (padrão: libx264,h264_nvenc,h264_qsv,h264_videotoolbox)
//   FAKE_FF_PROBE texto devolvido na leitura (padrão: ProRes 4K 10 bits, 10 s, com áudio)
//   FAKE_FF_HANG  "1": a conversão manda um progresso e fica parada (para testar cancelar/travar)
//   FAKE_FF_SIZE  tamanho da cópia gerada em bytes (padrão 200000)
//   FAKE_FF_HWDEC_FAIL "1": a conversão com -hwaccel falha
import fs from 'node:fs'
import os from 'node:os'

const args = process.argv.slice(2)
const env = process.env
if (env.FAKE_FF_LOG) {
  let nice = null
  try {
    nice = os.getPriority()
  } catch {}
  fs.appendFileSync(env.FAKE_FF_LOG, JSON.stringify({ args, nice }) + '\n')
}

const PRORES = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x.mov':
  Duration: 00:00:10.00, start: 0.000000, bitrate: 700000 kb/s
  Stream #0:0[0x1]: Video: prores (HQ) (apch / 0x68637061), yuv422p10le(tv, bt709, progressive), 3840x2160, 698000 kb/s, SAR 1:1 DAR 16:9, 25 fps, 25 tbr, 12800 tbn (default)
  Stream #0:1[0x2]: Audio: pcm_s24le (in24 / 0x34326E69), 48000 Hz, stereo, s32 (24 bit), 2304 kb/s (default)
At least one output file must be specified
`

const has = a => args.includes(a)
const after = a => args[args.indexOf(a) + 1]
const hw = new Set(String(env.FAKE_FF_HW || '').split(',').filter(Boolean))
const encs = String(env.FAKE_FF_ENC || 'libx264,h264_nvenc,h264_qsv,h264_videotoolbox').split(',').filter(Boolean)
const works = enc => enc === 'libx264' || hw.has(enc)

if (has('-version')) {
  process.stdout.write('ffmpeg version 9.9-fake Copyright (c) 2000-2026 the FFmpeg developers\n')
  process.exit(0)
}
if (has('-encoders')) {
  process.stdout.write('Encoders:\n ------\n')
  for (const e of encs) process.stdout.write(` V....D ${e}              ${e} H.264\n`)
  process.stdout.write(' A....D aac                  AAC (Advanced Audio Coding)\n')
  process.exit(0)
}
if (has('lavfi')) {
  const enc = after('-c:v')
  if (works(enc)) process.exit(0)
  process.stderr.write(`[${enc} @ 0x1] Cannot load the hardware encoder\nError while opening encoder\n`)
  process.exit(1)
}
if (has('-progress')) {
  const enc = after('-c:v')
  if (!works(enc)) {
    process.stderr.write(`[${enc} @ 0x1] No capable devices found\n`)
    process.exit(1)
  }
  if (has('-hwaccel') && env.FAKE_FF_HWDEC_FAIL === '1') {
    process.stderr.write('Failed setup for format videotoolbox_vld: hwaccel initialisation returned error.\n')
    process.exit(1)
  }
  const out = args[args.length - 1]
  if (env.FAKE_FF_HANG === '1') {
    process.stdout.write('frame=1\nout_time_us=1000000\nprogress=continue\n')
    setInterval(() => {}, 1000)
  } else {
    for (const us of [2_500_000, 5_000_000, 7_500_000, 10_000_000]) process.stdout.write(`frame=10\nout_time_us=${us}\nout_time=00:00:0${us / 1e6}\nprogress=continue\n`)
    fs.writeFileSync(out, Buffer.alloc(Number(env.FAKE_FF_SIZE || 200_000), 3))
    process.stdout.write('progress=end\n')
    process.exit(0)
  }
} else if (has('-i')) {
  process.stderr.write(env.FAKE_FF_PROBE ?? PRORES)
  process.exit(1)
} else {
  process.stderr.write('fake ffmpeg: não sei o que fazer\n')
  process.exit(2)
}
