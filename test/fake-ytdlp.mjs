#!/usr/bin/env node
// yt-dlp de mentira para os testes das Referências (test/referencias-*.test.js). Lê os mesmos argumentos que o
// motor manda (-P pasta, --cookies, --ffmpeg-location, o link depois de --) e escreve o que o yt-dlp escreveria:
// media.mp4, media.jpg (miniatura), info.info.json e o progresso no formato do --progress-template.
// O comportamento vem do link:
//   …/erro-login       ERROR do Instagram pedindo login (sai 1)
//   …/privado          "Private video" (sai 1)
//   …/sem-video        post só com foto (sai 1)
//   …/lento            progresso devagar por ~30 s (para cancelar)
//   …/trava            não escreve nada por muito tempo (travamento)
//   …/sem-arquivo      sai 0 sem gravar o vídeo
// Variáveis: FAKE_YTDLP_LOG = arquivo onde cada chamada vira uma linha JSON { args, cookies: { modo, texto } | null };
// FAKE_YTDLP_MEDIA = vídeo de verdade copiado como media.mp4 (sem ela, 4 KB de bytes repetidos).
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const after = a => (args.includes(a) ? args[args.indexOf(a) + 1] : null)
const url = args.includes('--') ? args[args.indexOf('--') + 1] : args[args.length - 1]

if (args.includes('--version')) {
  process.stdout.write(`${process.env.FAKE_YTDLP_VERSION || '2026.09.30'}\n`)
  process.exit(0)
}

const dir = after('-P') || process.cwd()
const cookies = after('--cookies')
if (process.env.FAKE_YTDLP_LOG) {
  let c = null
  if (cookies) {
    try {
      const st = fs.statSync(cookies)
      c = { modo: (st.mode & 0o777).toString(8), texto: fs.readFileSync(cookies, 'utf8'), caminho: cookies }
    } catch {
      c = { erro: true }
    }
  }
  fs.appendFileSync(process.env.FAKE_YTDLP_LOG, JSON.stringify({ args, cookies: c, pid: process.pid }) + '\n')
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const out = s => process.stdout.write(`${s}\n`)
const fail = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`)
  process.exit(code)
}

// JPEG pequeno válido (16×16 px): a miniatura.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgQEBMQExYWFhYWFhoYGhsbGxoaGhobGxsdHR0iIiIdHR0bGx0dICAiIiUmJSMjIiMmJigoKDAwLi44ODpFRVP/xABLAAEBAAAAAAAAAAAAAAAAAAAABgEBAAAAAAAAAAAAAAAAAAAABBABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIABAAEAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIAAsV//2Q==',
  'base64',
)

async function main() {
  out(`[generic] Extracting URL: ${url}`)
  if (/erro-login/.test(url)) fail('ERROR: [Instagram] DQx1: Requested content is not available, rate-limit reached or login required. Use --cookies, --cookies-from-browser, --username and --password, --netrc-cmd, or --netrc (instagram) to provide account credentials')
  if (/privado/.test(url)) fail("ERROR: [youtube] abc123: Private video. Sign in if you've been granted access to this video")
  if (/sem-video/.test(url)) fail('ERROR: [Instagram] DQx2: There is no video in this post')
  if (/trava/.test(url)) {
    await sleep(60_000)
    process.exit(0)
  }
  const partes = after('--ffmpeg-location') ? 2 : 1
  out(`[info] abc123: Downloading 1 format(s): ${partes === 2 ? '137+140' : '18'}`)
  const lento = /lento/.test(url)
  for (let p = 0; p < partes; p++) {
    out(`[download] Destination: ${path.join(dir, `media.f${p}.mp4`)}`)
    const total = 1000
    const passos = lento ? 60 : 4
    for (let i = 1; i <= passos; i++) {
      out(`SDPROG downloading ${Math.round((total * i) / passos)} ${total} NA 250000.5 ${passos - i}`)
      await sleep(lento ? 500 : 5)
    }
    out(`SDPROG finished ${total} ${total} NA NA NA`)
  }
  if (partes === 2) out(`[Merger] Merging formats into "${path.join(dir, 'media.mp4')}"`)
  if (/sem-arquivo/.test(url)) process.exit(0)
  fs.mkdirSync(dir, { recursive: true })
  // FAKE_YTDLP_MEDIA: um vídeo de verdade (para converter com o ffmpeg nos testes de "Também salvar como").
  if (process.env.FAKE_YTDLP_MEDIA) fs.copyFileSync(process.env.FAKE_YTDLP_MEDIA, path.join(dir, 'media.mp4'))
  else fs.writeFileSync(path.join(dir, 'media.mp4'), Buffer.alloc(4096, 7))
  fs.writeFileSync(path.join(dir, 'media.jpg'), JPEG)
  const info = {
    id: 'abc123',
    title: process.env.FAKE_YTDLP_TITLE || 'Plano-sequência na chuva #cinema #bts',
    uploader: process.env.FAKE_YTDLP_UPLOADER || 'Estúdio Norte',
    description: 'Legenda original do post.\nSegunda linha.',
    extractor_key: /instagram/.test(url) ? 'Instagram' : 'Youtube',
    webpage_url: url,
    duration: 12.5,
    width: 1080,
    height: 1920,
  }
  fs.writeFileSync(path.join(dir, 'info.info.json'), JSON.stringify(info))
  process.exit(0)
}

main()
