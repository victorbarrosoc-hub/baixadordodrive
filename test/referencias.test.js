// Referências, peças soltas: links de cada plataforma, nome/appProperties/descrição (limites em bytes), cookies para o
// yt-dlp (arquivo 0600 apagado no fim), linha de comando e progresso do yt-dlp (com um yt-dlp de mentira),
// atualizador do yt-dlp (SHA-256 que não confere nunca roda) e o cliente da API do site.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectar, dominiosDeCookies, limparUrl, nomeDaPlataforma } from '../src/referencias/plataformas.js'
import { appProperties, bytesUtf8, cortarBytes, descricao, lerReferencia, nomeDoArquivo, PROP_MAX_BYTES, tituloCurto } from '../src/referencias/metadados.js'
import { apagarCookies, gravarCookies, linhaNetscape, textoNetscape } from '../src/referencias/cookies.js'
import { baixarVideo, classificarErro, formato, lerProgresso, montarArgs, Progresso, resumoInfo } from '../src/referencias/ytdlp.js'
import { compararVersao, ffmpegCandidates, ytdlpAsset, ytdlpCandidates } from '../src/referencias/binarios.js'
import { lerSums, tagDoEndereco, YtdlpUpdater } from '../src/referencias/ytdlp-update.js'
import { ReferenciasApi, normalizarColecao } from '../src/referencias/api.js'
import { autorDoTitulo, cabecalhoCookie, tituloDaPagina } from '../src/referencias/service.js'
import { CloudAuth } from '../src/google/cloud-auth.js'
import { dataPaths } from '../src/config.js'
import { closeHttp } from '../src/net/http.js'
import { makeTmpDir, waitFor } from './helpers.js'
import { startMockCloud } from './mock-cloud.js'

const FAKE = fileURLToPath(new URL('./fake-ytdlp.mjs', import.meta.url))
const tmps = []
const tmp = async p => {
  const d = await makeTmpDir(p)
  tmps.push(d)
  return d
}
after(async () => {
  for (const d of tmps) await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  await closeHttp()
})

// ─────────── links ───────────

test('detecta plataforma e página de vídeo/post (tabela)', () => {
  const casos = [
    ['https://www.instagram.com/reel/DQx1AbCdEfG/', 'instagram', true],
    ['https://instagram.com/p/C9zYxWvUtS/?igsh=abc', 'instagram', true],
    ['https://www.instagram.com/tv/CAbCdEfGhIj', 'instagram', true],
    ['https://www.instagram.com/estudionorte/reel/DQx1AbCdEfG/', 'instagram', true],
    ['https://www.instagram.com/estudionorte/', 'instagram', false],
    ['https://www.instagram.com/', 'instagram', false],
    ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'youtube', true],
    ['https://m.youtube.com/watch?v=jNQXAC9IVRw&t=10', 'youtube', true],
    ['https://www.youtube.com/shorts/aBcDeFgHiJk', 'youtube', true],
    ['https://youtu.be/jNQXAC9IVRw', 'youtube', true],
    ['https://www.youtube.com/watch', 'youtube', false],
    ['https://www.youtube.com/@canal', 'youtube', false],
    ['https://www.youtube.com/', 'youtube', false],
    ['https://www.tiktok.com/@fulano/video/7312345678901234567', 'tiktok', true],
    ['https://vm.tiktok.com/ZMabc123/', 'tiktok', true],
    ['https://www.tiktok.com/foryou', 'tiktok', false],
    ['https://vimeo.com/76979871', 'vimeo', true],
    ['https://vimeo.com/channels/staffpicks/76979871', 'vimeo', true],
    ['https://player.vimeo.com/video/76979871', 'vimeo', true],
    ['https://vimeo.com/fulano', 'vimeo', false],
    ['https://br.pinterest.com/pin/123456789012345678/', 'pinterest', true],
    ['https://www.pinterest.com.br/pin/12345/', 'pinterest', true],
    ['https://pin.it/3abcDEF', 'pinterest', true],
    ['https://br.pinterest.com/fulano/quadro/', 'pinterest', false],
    ['https://x.com/fulano/status/1790000000000000000', 'x', true],
    ['https://twitter.com/fulano/status/1790000000000000000/video/1', 'x', true],
    ['https://x.com/home', 'x', false],
    ['https://www.facebook.com/reel/123456789', 'facebook', true],
    ['https://exemplo.com.br/video.mp4', 'web', false],
  ]
  for (const [url, plat, ok] of casos) {
    const d = detectar(url)
    assert.equal(d.plataforma, plat, url)
    assert.equal(d.salvavel, ok, url)
  }
  for (const ruim of ['', 'nada', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.com/a']) assert.equal(detectar(ruim).salvavel, false, ruim)
  assert.equal(detectar('https://www.instagram.com/reel/x/').nome, 'Instagram')
  assert.equal(nomeDaPlataforma('youtube'), 'YouTube')
  assert.equal(nomeDaPlataforma('Exemplo'), 'Exemplo')
})

test('cookies só dos domínios do site do vídeo; links limpos', () => {
  assert.deepEqual(dominiosDeCookies('https://www.instagram.com/reel/abc12/'), ['instagram.com'])
  assert.deepEqual(dominiosDeCookies('https://youtu.be/jNQXAC9IVRw'), ['youtube.com', 'google.com'])
  assert.deepEqual(dominiosDeCookies('https://cdn.exemplo.com.br/a.mp4'), ['exemplo.com.br'])
  assert.deepEqual(dominiosDeCookies('nada'), [])
  assert.equal(limparUrl('olha isso https://www.instagram.com/reel/abc12/?igsh=xyz&utm_source=ig#c'), 'https://www.instagram.com/reel/abc12/')
  assert.equal(limparUrl('https://www.youtube.com/watch?v=abc123&si=rastreio&t=5'), 'https://www.youtube.com/watch?v=abc123&t=5')
  assert.equal(limparUrl('https://user:senha@site.com/x'), null)
  assert.equal(limparUrl('sem link'), null)
  assert.equal(limparUrl(42), null)
})

// ─────────── metadados ───────────

test('nome do arquivo: autor, título curto e plataforma; sem caracteres proibidos; até 120', () => {
  assert.equal(nomeDoArquivo({ autor: 'Estúdio Norte', titulo: 'Plano-sequência na chuva #cinema #bts', plataforma: 'instagram' }), 'Estúdio Norte - Plano-sequência na chuva (Instagram).mp4')
  assert.equal(nomeDoArquivo({ autor: 'A/B: "C"', titulo: 'x*y?z<w>|', plataforma: 'youtube' }), 'A B C - x y z w (YouTube).mp4')
  assert.equal(nomeDoArquivo({ titulo: 'Só título', plataforma: 'vimeo' }), 'Só título (Vimeo).mp4')
  assert.equal(nomeDoArquivo({ autor: 'Fulano', plataforma: 'tiktok', id: '7312' }), 'Fulano - 7312 (TikTok).mp4')
  assert.equal(nomeDoArquivo({ plataforma: 'x' }), 'Referência (X).mp4')
  assert.equal(nomeDoArquivo({ autor: 'Fulano', titulo: 'foto', plataforma: 'pinterest', ext: 'jpg' }), 'Fulano - foto (Pinterest).jpg')
  const longo = nomeDoArquivo({ autor: 'A'.repeat(90), titulo: 'palavra '.repeat(40), plataforma: 'instagram' })
  assert.ok([...longo].length <= 120, longo)
  assert.match(longo, /\(Instagram\)\.mp4$/)
  assert.ok(!/[\\/:*?"<>|\u0000-\u001f]/.test(longo))
  assert.equal(tituloCurto('Primeira linha\nsegunda'), 'Primeira linha')
  const emoji = nomeDoArquivo({ autor: '🎬'.repeat(70), titulo: '🎥'.repeat(70), plataforma: 'youtube' })
  assert.ok([...emoji].length <= 120)
})

test('appProperties: cada chave + valor cabe em 124 bytes (UTF-8, sem partir caractere)', () => {
  const url = `https://www.youtube.com/watch?v=jNQXAC9IVRw&lista=${'x'.repeat(300)}`
  const p = appProperties({ url, plataforma: 'youtube', autor: 'Ação '.repeat(60), titulo: '🎬 título '.repeat(40) })
  assert.equal(p.sobedesce, 'referencia')
  assert.equal(p.plataforma, 'YouTube')
  for (const [k, v] of Object.entries(p)) assert.ok(bytesUtf8(k) + bytesUtf8(v) <= PROP_MAX_BYTES, `${k}: ${bytesUtf8(k) + bytesUtf8(v)}`)
  assert.equal(p.fonte, 'https://www.youtube.com/watch') // sem a query, que não cabia
  assert.ok(!p.titulo.includes('\uFFFD'))
  assert.equal(cortarBytes('aé🎬', 3), 'aé')
  assert.equal(cortarBytes('aé🎬', 6), 'aé') // 🎬 tem 4 bytes: não cabe em 3 restantes
  assert.equal(cortarBytes('aé🎬', 7), 'aé🎬')
  const curto = appProperties({ url: 'https://x.com/a/status/1', plataforma: 'x' })
  assert.deepEqual(Object.keys(curto).sort(), ['fonte', 'plataforma', 'sobedesce'])
})

test('descrição: link completo na 1ª linha, cabeçalho, nota e legenda; e a volta (lerReferencia)', () => {
  const url = `https://www.instagram.com/reel/DQx1AbCdEfG/?a=${'1'.repeat(200)}`
  const d = descricao({ url, titulo: 'Plano na chuva', autor: 'Estúdio Norte', plataforma: 'instagram', salvoEm: new Date('2026-10-16T14:03:00Z'), nota: 'luz de janela', legenda: 'Legenda\ncom duas linhas' })
  const linhas = d.split('\n')
  assert.equal(linhas[0], url)
  assert.equal(linhas[1], 'Título: Plano na chuva')
  assert.equal(linhas[2], 'Autor: Estúdio Norte')
  assert.equal(linhas[3], 'Plataforma: Instagram')
  assert.equal(linhas[4], 'Salvo em: 2026-10-16T14:03:00.000Z')
  assert.equal(linhas[5], '')
  assert.equal(linhas[6], 'Legenda')
  assert.equal(linhas[8], '')
  assert.equal(linhas[9], 'Nota: luz de janela')
  // Nota no começo (formato antigo) também é lida.
  assert.equal(lerReferencia({ description: 'https://a.com/x\nAutor: B\n\nNota: antes\n\nlegenda' }).nota, 'antes')
  assert.equal(appProperties({ url: 'https://a.com/x', fila: 'fila_9' }).fila, 'fila_9')
  const r = lerReferencia({ description: d, appProperties: { sobedesce: 'referencia' } })
  assert.equal(r.url, url)
  assert.equal(r.titulo, 'Plano na chuva')
  assert.equal(r.autor, 'Estúdio Norte')
  assert.equal(r.plataforma, 'Instagram')
  assert.equal(r.nota, 'luz de janela')
  assert.equal(r.legenda, 'Legenda\ncom duas linhas')
  // Sem descrição: o que der das appProperties.
  const s = lerReferencia({ appProperties: { fonte: 'https://youtu.be/x', autor: 'Fulano', plataforma: 'YouTube' } })
  assert.equal(s.url, 'https://youtu.be/x')
  assert.equal(s.autor, 'Fulano')
  assert.equal(lerReferencia({}).url, null)
  assert.ok(descricao({ url: 'https://a.com/x', legenda: 'z'.repeat(50_000) }).length <= 16_000)
})

test('título da página: autor e legenda do navegador (foto salva pelo menu)', () => {
  assert.equal(autorDoTitulo('Estúdio Norte on Instagram: “luz de fim de tarde”'), 'Estúdio Norte')
  assert.equal(tituloDaPagina('Estúdio Norte on Instagram: “luz de fim de tarde”'), 'luz de fim de tarde')
  assert.equal(tituloDaPagina('Making of - YouTube'), 'Making of')
  assert.equal(autorDoTitulo('Pinterest'), '')
})

// ─────────── cookies ───────────

test('cookies: formato Netscape, arquivo 0600 numa pasta 0700, nada para cookie inválido, apagado no fim', async () => {
  const c = [
    { name: 'sessionid', value: 'abc', domain: '.instagram.com', path: '/', secure: true, httpOnly: true, expirationDate: 1893456000.5 },
    { name: 'csrftoken', value: 'x y', domain: 'www.instagram.com', hostOnly: true, path: '/', secure: true, session: true },
    { name: 'ruim', value: 'a\tb', domain: '.instagram.com' },
    { name: 'sem-dominio', value: 'x' },
  ]
  assert.equal(linhaNetscape(c[0]), '#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\tabc')
  assert.equal(linhaNetscape(c[1]), 'www.instagram.com\tFALSE\t/\tTRUE\t0\tcsrftoken\tx y')
  assert.equal(linhaNetscape(c[2]), null)
  assert.equal(linhaNetscape(c[3]), null)
  assert.match(textoNetscape(c), /^# Netscape HTTP Cookie File\n/)
  const dir = path.join(await tmp('sd-cookies-'), 'job', '.c')
  assert.equal(await gravarCookies(dir, [c[2]]), null)
  const file = await gravarCookies(dir, c)
  const st = await fs.stat(file)
  if (process.platform !== 'win32') {
    assert.equal(st.mode & 0o777, 0o600)
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700)
  }
  const texto = await fs.readFile(file, 'utf8')
  assert.equal(texto.split('\n').filter(l => l && !l.startsWith('# ')).length, 2)
  await apagarCookies(file)
  await assert.rejects(fs.stat(file))
  await apagarCookies(file) // de novo: não lança
  assert.equal(cabecalhoCookie(c, 'https://www.instagram.com/p/x/'), 'sessionid=abc; csrftoken=x y')
  assert.equal(cabecalhoCookie(c, 'https://scontent.cdninstagram.com/a.jpg'), '')
  assert.equal(cabecalhoCookie(c, 'http://www.instagram.com/'), '', 'cookie secure não vai por http')
})

// ─────────── yt-dlp ───────────

test('argumentos do yt-dlp: formato até 1080p, mp4, sem playlist, info + miniatura, cookies e ffmpeg', () => {
  const a = montarArgs({ url: 'https://www.instagram.com/reel/abc12/', workDir: '/tmp/w', ffmpeg: '/app/ffmpeg', cookies: '/tmp/w/.c/cookies.txt', cacheDir: '/d/cache', jsRuntime: { nome: 'node', path: '/app/node' } })
  const after = f => a[a.indexOf(f) + 1]
  // H.264 separado → progressivo que toca no iPhone (o do Instagram) → separado que toca → VP9/AV1 só no fim.
  assert.equal(
    after('-f'),
    'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/b[height<=?1920][ext=mp4][vcodec!^=?vp][vcodec!^=?av01]/bv*[height<=1080][ext=mp4][vcodec!^=?vp][vcodec!^=?av01]+ba[ext=m4a]/bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b[height<=1080]/b',
  )
  assert.equal(after('--merge-output-format'), 'mp4')
  assert.equal(after('--ffmpeg-location'), '/app/ffmpeg')
  assert.equal(after('--cookies'), '/tmp/w/.c/cookies.txt')
  assert.equal(after('-P'), '/tmp/w')
  assert.equal(after('--js-runtimes'), 'node:/app/node')
  assert.equal(after('--cache-dir'), '/d/cache')
  for (const f of ['--no-playlist', '--newline', '--write-info-json', '--write-thumbnail', '--ignore-config', '--no-mtime']) assert.ok(a.includes(f), f)
  assert.ok(!a.includes('--restrict-filenames'))
  assert.deepEqual(a.slice(-2), ['--', 'https://www.instagram.com/reel/abc12/'], 'o link vai depois de -- (nunca vira opção)')
  assert.match(after('--progress-template'), /^download:SDPROG /)
  // Sem ffmpeg: só formatos que já vêm juntos, sem merge.
  const b = montarArgs({ url: 'https://youtu.be/x123456', workDir: '/w' })
  assert.equal(b[b.indexOf('-f') + 1], formato({ ffmpeg: false }))
  assert.ok(!b.includes('--merge-output-format') && !b.includes('--ffmpeg-location') && !b.includes('--cookies'))
  assert.ok(b.includes('--no-cache-dir'))
  assert.throws(() => montarArgs({ url: '--exec rm', workDir: '/w' }))
})

test('progresso do yt-dlp: linhas do template, vídeo + áudio somados, juntando', () => {
  assert.deepEqual(lerProgresso('SDPROG downloading 500 1000 NA 250000.5 2'), { status: 'downloading', baixado: 500, total: 1000, velocidade: 250000.5, eta: 2, fracao: 0.5 })
  assert.equal(lerProgresso('SDPROG downloading 10 NA 100 NA NA').fracao, 0.1)
  assert.equal(lerProgresso('SDPROG downloading 10 NA NA NA NA').fracao, null)
  assert.equal(lerProgresso('[download]  50.0% of 10MiB'), null)
  const vistos = []
  const p = new Progresso(x => vistos.push(x))
  p.linha('[info] abc: Downloading 1 format(s): 137+140')
  p.linha('SDPROG downloading 500 1000 NA 1 1')
  assert.equal(vistos.at(-1).fracao, 0.25)
  p.linha('SDPROG finished 1000 1000 NA NA NA')
  assert.equal(vistos.at(-1).fracao, 0.5)
  p.linha('SDPROG downloading 100 200 NA 1 1')
  assert.equal(vistos.at(-1).fracao, 0.75)
  assert.equal(vistos.at(-1).baixado, 1100)
  p.linha('[Merger] Merging formats into "x.mp4"')
  assert.equal(vistos.at(-1).fase, 'juntando')
})

test('erros do yt-dlp viram frases curtas', () => {
  const casos = [
    ['ERROR: [Instagram] x: Requested content is not available, rate-limit reached or login required. Use --cookies', 'instagram', 'login', 'O Instagram pediu login: entre no Instagram pelo navegador de referências.'],
    ['ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies-from-browser', 'youtube', 'login', 'O YouTube pediu login: entre no YouTube pelo navegador de referências.'],
    ["ERROR: [youtube] x: Private video. Sign in if you've been granted access to this video", 'youtube', 'indisponivel', 'Vídeo privado ou removido.'],
    ['ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader', 'youtube', 'indisponivel', null],
    ['ERROR: [Instagram] x: There is no video in this post', 'instagram', 'sem_video', null],
    ['ERROR: Unsupported URL: https://exemplo.com/', 'web', 'nao_suportado', null],
    ['ERROR: unable to download video data: HTTP Error 403: Forbidden', 'youtube', 'recusado', null],
    ['ERROR: [TikTok] x: HTTP Error 429: Too Many Requests', 'tiktok', 'limite', null],
    ['ERROR: [generic] Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>', 'web', 'rede', null],
    ['ERROR: Requested format is not available. Use --list-formats', 'youtube', 'formato', null],
    ['ERROR: algo novo que ninguém conhece', 'vimeo', 'erro', 'Não deu para baixar este vídeo.'],
  ]
  for (const [stderr, plat, codigo, msg] of casos) {
    const e = classificarErro(`[debug] x\n${stderr}\n`, { plataforma: plat })
    assert.equal(e.codigo, codigo, stderr)
    if (msg) assert.equal(e.message, msg)
    assert.ok(e.detalhe.startsWith('ERROR:'))
  }
  assert.equal(classificarErro('ERROR: x: HTTP Error 429', { plataforma: 'tiktok' }).transitorio, true)
})

test('resumo do info .json: autor, título (sem "Video by"), legenda', () => {
  const r = resumoInfo({ id: 'x', title: 'Video by estudionorte', uploader: 'Estúdio Norte', description: 'Luz de janela\n#cinema', extractor_key: 'Instagram' }, 'u')
  assert.equal(r.autor, 'Estúdio Norte')
  assert.equal(r.titulo, 'Luz de janela')
  assert.equal(r.legenda, 'Luz de janela\n#cinema')
  assert.equal(resumoInfo({}, 'https://a').pagina, 'https://a')
})

async function fakeBin() {
  const dir = await tmp('sd-fake-ytdlp-')
  const bin = path.join(dir, 'yt-dlp')
  await fs.copyFile(FAKE, bin)
  await fs.chmod(bin, 0o755)
  return bin
}

test('baixarVideo com o yt-dlp de mentira: arquivos, progresso, cookies passados e erros', { skip: process.platform === 'win32' }, async () => {
  const bin = await fakeBin()
  const base = await tmp('sd-ytdlp-run-')
  const log = path.join(base, 'log.jsonl')
  const env = { FAKE_YTDLP_LOG: log }
  const prog = []
  const work = path.join(base, 'w1')
  const r = await baixarVideo({ bin, url: 'https://www.instagram.com/reel/abc12/', workDir: work, ffmpeg: '/bin/true', plataforma: 'instagram', env, onProgress: p => prog.push(p) })
  assert.equal(path.basename(r.video.path), 'media.mp4')
  assert.equal(path.basename(r.miniatura), 'media.jpg')
  assert.equal(r.resumo.autor, 'Estúdio Norte')
  assert.equal(r.resumo.extrator, 'Instagram')
  assert.ok(prog.some(p => p.fase === 'juntando'))
  assert.equal(Math.max(...prog.map(p => p.fracao || 0)), 1)
  // Erro: mensagem humana, sem processo para trás.
  await assert.rejects(baixarVideo({ bin, url: 'https://www.instagram.com/reel/erro-login/', workDir: path.join(base, 'w2'), plataforma: 'instagram', env }), e => e.codigo === 'login' && /Instagram pediu login/.test(e.message))
  await assert.rejects(baixarVideo({ bin, url: 'https://youtu.be/privado1', workDir: path.join(base, 'w3'), plataforma: 'youtube', env }), e => e.codigo === 'indisponivel')
  await assert.rejects(baixarVideo({ bin, url: 'https://youtu.be/sem-arquivo', workDir: path.join(base, 'w4'), env }), e => e.codigo === 'sem_video')
  // Travou: mata o processo depois do tempo sem saída.
  await assert.rejects(baixarVideo({ bin, url: 'https://youtu.be/trava123', workDir: path.join(base, 'w5'), env, stallMs: 300 }), e => e.codigo === 'travou')
  // Cancelar: AbortError e o processo morre.
  const ac = new AbortController()
  const p = baixarVideo({ bin, url: 'https://youtu.be/lento123', workDir: path.join(base, 'w6'), env, signal: ac.signal })
  await waitFor(async () => (await fs.readFile(log, 'utf8')).includes('lento123'))
  const pid = (await fs.readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l)).find(l => l.args.includes('https://youtu.be/lento123')).pid
  setTimeout(() => ac.abort(), 100)
  await assert.rejects(p, e => e.name === 'AbortError')
  await waitFor(() => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }, { message: 'o yt-dlp continuou rodando depois de cancelar' })
  // Binário que não existe.
  await assert.rejects(baixarVideo({ bin: path.join(base, 'nao-existe'), url: 'https://youtu.be/x123456', workDir: path.join(base, 'w7') }), e => e.codigo === 'sem_ytdlp')
})

// ─────────── onde estão os binários ───────────

test('candidatos do yt-dlp e do ffmpeg: env, app, desenvolvimento, sistema', () => {
  const y = ytdlpCandidates({ env: { SOBEDESCE_YTDLP: '/x/yt', PATH: '/usr/bin:/bin' }, platform: 'darwin', arch: 'arm64', resourcesPath: '/App.app/Contents/Resources', appRoot: '/App.app/Contents/Resources/app' })
  assert.deepEqual(y.map(c => c.origem), ['env', 'app', 'app', 'sistema', 'sistema', 'sistema', 'sistema'])
  assert.equal(y[1].path, '/App.app/Contents/Resources/yt-dlp/yt-dlp')
  assert.equal(y[1].versaoArquivo, '/App.app/Contents/Resources/yt-dlp/versao.txt')
  assert.equal(y[2].path, '/App.app/Contents/Resources/app/build/yt-dlp/mac/yt-dlp')
  const w = ytdlpCandidates({ env: { Path: 'C:\\bin' }, platform: 'win32', arch: 'x64', resourcesPath: 'C:\\SD\\resources', appRoot: 'C:\\SD\\resources\\app' })
  assert.equal(w[0].path, 'C:\\SD\\resources\\yt-dlp\\yt-dlp.exe')
  assert.ok(w.some(c => c.path === 'C:\\SD\\resources\\app\\build\\yt-dlp\\win-x64\\yt-dlp.exe'))
  const f = ffmpegCandidates({ env: {}, platform: 'darwin', arch: 'x64', resourcesPath: '/R', appRoot: '/R/app' })
  assert.equal(f[0].path, '/R/ffmpeg/ffmpeg')
  assert.ok(f.some(c => c.path === '/opt/homebrew/bin/ffmpeg'))
  assert.equal(ytdlpAsset('darwin', 'arm64'), 'yt-dlp_macos')
  assert.equal(ytdlpAsset('win32', 'x64'), 'yt-dlp.exe')
  assert.equal(ytdlpAsset('win32', 'arm64'), 'yt-dlp_arm64.exe')
  assert.equal(ytdlpAsset('linux', 'x64'), 'yt-dlp_linux')
  assert.equal(compararVersao('2026.08.19', '2026.08.19.1'), -1)
  assert.equal(compararVersao('2026.10.02', '2026.9.30'), 1)
  assert.equal(compararVersao('2026.08.19', '2026.08.19'), 0)
})

// ─────────── atualizador do yt-dlp ───────────

/** Release falso do GitHub: /latest/download/SHA2-256SUMS redireciona para /download/<tag>/SHA2-256SUMS. */
async function fakeReleases({ tag, assets, sumsOverride = {} }) {
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(req.url)
    if (req.url === '/latest/download/SHA2-256SUMS') {
      res.writeHead(302, { location: `/download/${tag}/SHA2-256SUMS` })
      return res.end()
    }
    const m = /^\/download\/([^/]+)\/(.+)$/.exec(req.url)
    if (m && m[1] === tag && m[2] === 'SHA2-256SUMS') {
      const linhas = Object.entries(assets).map(([n, buf]) => `${sumsOverride[n] || crypto.createHash('sha256').update(buf).digest('hex')}  ${n}`)
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end(`${linhas.join('\n')}\n`)
    }
    if (m && m[1] === tag && assets[decodeURIComponent(m[2])]) {
      const buf = assets[decodeURIComponent(m[2])]
      res.writeHead(200, { 'content-length': buf.length })
      return res.end(buf)
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise(r => server.close(r)) }
}

test('lerSums e tag do redirecionamento', () => {
  const m = lerSums('0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202  yt-dlp_macos\nlixo\n66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a *yt-dlp.exe\n')
  assert.equal(m.get('yt-dlp_macos'), '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202')
  assert.equal(m.get('yt-dlp.exe').slice(0, 6), '666749')
  assert.equal(m.size, 2)
  assert.equal(tagDoEndereco('https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/SHA2-256SUMS'), '2026.08.19')
  assert.equal(tagDoEndereco('/download/nightly/SHA2-256SUMS'), null)
})

test('atualizador: baixa o mais novo, confere o SHA-256 e passa a usar; hash errado nunca roda', { skip: process.platform === 'win32' }, async () => {
  const fake = await fs.readFile(FAKE)
  const asset = ytdlpAsset('linux', 'x64')
  const appDir = await tmp('sd-ytdlp-app-')
  const appBin = path.join(appDir, 'yt-dlp')
  await fs.writeFile(appBin, fake, { mode: 0o755 })
  await fs.writeFile(path.join(appDir, 'versao.txt'), '2026.08.19\n')
  const candidates = () => [{ path: appBin, origem: 'app', versaoArquivo: path.join(appDir, 'versao.txt') }]
  const testados = []
  const testar = async bin => {
    testados.push(bin)
    return '2026.09.30'
  }

  // 1) SHA-256 diferente: não instala, não roda, continua o do app.
  let rel = await fakeReleases({ tag: '2026.09.30', assets: { [asset]: fake }, sumsOverride: { [asset]: 'f'.repeat(64) } })
  let dir = await tmp('sd-ytdlp-dados-')
  let u = new YtdlpUpdater({ dir, platform: 'linux', arch: 'x64', releasesBase: rel.url, candidates, testar, now: () => 1e12 })
  let st = await u.verificar()
  assert.match(st.erro, /não confere com o SHA-256/)
  assert.equal(testados.length, 0, 'binário que não confere nunca roda')
  assert.deepEqual(await fs.readdir(dir).catch(() => []), [], 'nada sobrou na pasta')
  assert.equal((await u.resolver()).origem, 'app')
  await rel.close()

  // 2) Confere: instala, testa e passa a valer (mais novo que o do app).
  rel = await fakeReleases({ tag: '2026.09.30', assets: { [asset]: fake } })
  dir = await tmp('sd-ytdlp-dados-')
  u = new YtdlpUpdater({ dir, platform: 'linux', arch: 'x64', releasesBase: rel.url, candidates, testar, now: () => 1e12 })
  st = await u.verificar()
  assert.equal(st.erro, null)
  assert.equal(st.versao, '2026.09.30')
  const r = await u.resolver()
  assert.equal(r.origem, 'atualizado')
  assert.equal(r.versao, '2026.09.30')
  assert.equal(path.basename(r.path), 'yt-dlp')
  if (process.platform !== 'win32') assert.ok(((await fs.stat(r.path)).mode & 0o111) !== 0)
  assert.deepEqual(testados, [r.path])

  // 3) Uma vez por dia: logo depois não pergunta de novo.
  const antes = rel.hits.length
  await u.verificar()
  assert.equal(rel.hits.length, antes)

  // 4) Arquivo trocado no disco depois de instalado: não confere mais, é apagado e volta o do app.
  const u2 = new YtdlpUpdater({ dir, platform: 'linux', arch: 'x64', releasesBase: rel.url, candidates, testar, now: () => 1e12 })
  await fs.appendFile(r.path, '\n// trocado')
  assert.equal((await u2.resolver()).origem, 'app')
  await assert.rejects(fs.stat(r.path))

  // 5) Já está na mais nova: não baixa nada.
  await fs.writeFile(path.join(appDir, 'versao.txt'), '2026.09.30\n')
  const u3 = new YtdlpUpdater({ dir: await tmp('sd-ytdlp-dados-'), platform: 'linux', arch: 'x64', releasesBase: rel.url, candidates, testar, now: () => 1e12 })
  const n = rel.hits.length
  await u3.verificar({ forcar: true })
  assert.deepEqual(rel.hits.slice(n), ['/latest/download/SHA2-256SUMS'])
  await rel.close()

  // 6) Sem internet: erro guardado, o do app continua.
  const u4 = new YtdlpUpdater({ dir: await tmp('sd-ytdlp-dados-'), platform: 'linux', arch: 'x64', releasesBase: 'http://127.0.0.1:9', candidates, testar })
  const s4 = await u4.verificar()
  assert.ok(s4.erro)
  assert.equal((await u4.resolver()).origem, 'app')
})

// ─────────── API do site ───────────

test('cliente da API: coleções, fila, pegar (409 = outro computador), 403 plano, sem sessão', async () => {
  const site = await startMockCloud()
  const home = await tmp('sd-refapi-')
  const cloud = new CloudAuth({ paths: dataPaths(home), baseUrl: site.url, pollMs: 20, refreshEveryMs: 0, deviceName: 'Teste' })
  try {
    const api = new ReferenciasApi({ cloud, retryBaseMs: 5 })
    await assert.rejects(api.listarColecoes(), e => e.codigo === 'sem_sessao')
    const l = await cloud.beginLogin()
    site.approve(l.codigo)
    await waitFor(() => cloud.signedIn)
    assert.deepEqual((await api.listarColecoes()).colecoes, [])
    const c = await api.criarColecao({ nome: 'Clipes', contaGoogleId: 'nuvem:g2' })
    assert.equal(c.nome, 'Clipes')
    assert.equal(c.contaId, 'nuvem:g2')
    assert.ok(c.driveFolderId)
    const ligado = await api.editarColecao(c.id, { link: true })
    assert.match(ligado.link, /\/r\//)
    const trocado = await api.editarColecao(c.id, { link: 'trocar' })
    assert.notEqual(trocado.link, ligado.link)
    assert.equal((await api.editarColecao(c.id, { link: false })).link, null)
    const item = await api.adicionarNaFila({ url: 'https://youtu.be/abc1234', colecaoId: c.id, nota: 'luz' })
    assert.equal((await api.listarColecoes()).colecoes[0].naFila, 1)
    const fila = await api.listarFila({ status: 'pendente' })
    assert.equal(fila.length, 1)
    assert.equal(fila[0].colecao.contaId, 'nuvem:g2')
    assert.equal(fila[0].nota, 'luz')
    assert.ok(await api.pegar(item.id))
    assert.equal(await api.pegar(item.id), null, 'segundo computador perde a corrida')
    assert.equal(await api.pegar('nao-existe'), null)
    await api.atualizarItem(item.id, { status: 'erro', erro: 'Vídeo privado ou removido.' })
    assert.equal(site.fila[0].erro, 'Vídeo privado ou removido.')
    await assert.rejects(api.criarColecao({ nome: '' }), e => e.codigo === 'entrada')
    site.referenciasPermitidas = false
    await assert.rejects(api.listarColecoes(), e => e.codigo === 'plano' && /plano Produtora/.test(e.message))
    site.referenciasPermitidas = true
    await api.apagarColecao(c.id)
    assert.equal(site.colecoes.length, 0)
    // Site fora do ar: repete e desiste com 'rede'.
    site.down = true
    await assert.rejects(api.listarColecoes(), e => e.codigo === 'rede')
    site.down = false
    assert.equal(normalizarColecao({ id: 1, nome: 'x', contaGoogleId: 'g1', link: 'javascript:alert(1)' }).link, null)
  } finally {
    cloud.close()
    await site.close()
  }
})

test('o pacote do app leva o yt-dlp fora do app/ e o Mac universal aceita o binário igual nas duas arquiteturas', async () => {
  const yml = await fs.readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  assert.match(yml, /from: build\/yt-dlp\/mac\s+to: yt-dlp/)
  assert.match(yml, /from: build\/yt-dlp\/\$\{os\}-\$\{arch\}\s+to: yt-dlp/)
  assert.match(yml, /x64ArchFiles: .*yt-dlp/)
  const wf = await fs.readFile(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8')
  assert.match(wf, /node scripts\/ytdlp-baixar\.mjs/)
  const { FONTES } = await import('../scripts/ytdlp-baixar.mjs')
  for (const f of Object.values(FONTES)) assert.match(f.sha256, /^[0-9a-f]{64}$/)
  void os
})
