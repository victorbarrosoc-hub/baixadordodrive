// "Baixar como…" de ponta a ponta no motor, com o ffmpeg de verdade: site falso (test/mock-cloud.js), Drive falso
// (test/mock-drive.js) e o yt-dlp de mentira entregando um vídeo real (FAKE_YTDLP_MEDIA).
//   - "Também salvar como" (MP3 320 + WAV): convertidos do vídeo recém-baixado, ao lado do original, sem baixar de novo;
//   - "Baixar como…" de uma referência salva: M4A para a coleção e o computador; o original do Drive desce uma vez só
//     para dois formatos; nome repetido no computador vira "(2)";
//   - erros claros (vídeo sem áudio, formato que não serve, arquivo que sumiu, pasta inválida);
//   - link do celular com "Também salvar como" (fila do site).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startApp } from '../src/index.js'
import { closeHttp } from '../src/net/http.js'
import { makeTmpDir, waitFor } from './helpers.js'
import { startMockDrive } from './mock-drive.js'
import { startMockCloud } from './mock-cloud.js'

const FFMPEG = '/usr/bin/ffmpeg'
const FFPROBE = '/usr/bin/ffprobe'
const semFfmpeg = !(fs.existsSync(FFMPEG) && fs.existsSync(FFPROBE)) && 'sem /usr/bin/ffmpeg neste ambiente'
const FAKE = fileURLToPath(new URL('./fake-ytdlp.mjs', import.meta.url))
const keepAwake = { active: false, setActive() {}, stop() {} }
let mock, site, home, app, midia, destino, colecao

function gerar(saida, args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args, saida])
  assert.equal(r.status, 0, String(r.stderr))
}

before(async () => {
  if (semFfmpeg) return
  home = await makeTmpDir()
  const binDir = await makeTmpDir('sd-fmt-bin-')
  const bin = path.join(binDir, 'yt-dlp')
  await fsp.copyFile(FAKE, bin)
  await fsp.chmod(bin, 0o755)
  // O "vídeo do Instagram": 2 s, H.264 1280×720 + AAC 44,1 kHz.
  midia = path.join(binDir, 'reel.mp4')
  gerar(midia, ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'])
  process.env.FAKE_YTDLP_MEDIA = midia
  destino = await makeTmpDir('sd-fmt-downloads-')
  mock = await startMockDrive()
  mock.applyEnv()
  site = await startMockCloud({ drive: mock })
  const updater = { resolver: async () => ({ path: bin, versao: '2026.09.30', origem: 'app' }), status: () => ({ versao: '2026.09.30' }), start() {}, stop() {}, on() {}, off() {} }
  app = await startApp({
    home,
    port: 0,
    open: false,
    quiet: true,
    cloudOptions: { pollMs: 20, retryBaseMs: 5, refreshEveryMs: 0, deviceName: 'Mac de Teste', platform: 'darwin', baseUrl: site.url },
    managerOptions: { keepAwake, taskOptions: { upload: { retryBaseMs: 5 } } },
    serverOptions: { log: () => {} },
    pedidosFormatoOptions: { pollMs: 3_600_000 },
    referenciasOptions: {
      updater,
      ffmpeg: () => FFMPEG,
      motor: async () => ({ via: 'ffmpeg', ffmpeg: { path: FFMPEG }, encoder: { nome: 'libx264' } }),
      converter: async () => ({ estado: 'ok' }),
      conserto: false,
      jsRuntime: null,
      pollMs: 60_000,
      log: () => {},
    },
  })
  await app.settings.update({ keepAwake: false, verifyChecksums: false, downloadDir: destino })
})

after(async () => {
  if (semFfmpeg) return
  delete process.env.FAKE_YTDLP_MEDIA
  await app?.shutdown()
  await site?.close().catch(() => {})
  await mock?.close()
  for (const d of [home, destino]) await fsp.rm(d, { recursive: true, force: true, maxRetries: 3 })
  await closeHttp()
})

function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const h = { host: `127.0.0.1:${app.port}` }
    if (method !== 'GET') h['content-type'] = 'application/json'
    if (data != null) h['content-length'] = Buffer.byteLength(data)
    const req = http.request({ host: '127.0.0.1', port: app.port, method, path: p, headers: h, agent: false }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        let json = null
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {}
        resolve({ status: res.statusCode, json })
      })
    })
    req.on('error', reject)
    if (data != null) req.write(data)
    req.end()
  })
}
const get = p => call('GET', p)
const post = (p, b = {}) => call('POST', p, b)
const job = id => app.referencias.status().trabalhos.find(t => t.id === id)
const esperarFim = async (id, timeoutMs = 30_000) => {
  await waitFor(() => ['pronto', 'erro', 'cancelado'].includes(job(id)?.fase), { timeoutMs, message: `trabalho ${id} está em ${job(id)?.fase}` })
  return job(id)
}
const naColecao = () => mock.listAll().filter(i => i.parents[0] === colecao.driveFolderId && !i.isFolder)
const restos = async sub => fsp.readdir(path.join(home, 'referencias', sub)).catch(() => [])
async function sondaDrive(item) {
  const f = path.join(destino, `.sonda-${item.id}`)
  await fsp.writeFile(f, mock.readContent(item.id))
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,bit_rate,sample_rate', '-of', 'json', f], { encoding: 'utf8' })
  await fsp.rm(f, { force: true })
  return JSON.parse(r.stdout).streams
}

test('entra na conta e cria a coleção', { skip: semFfmpeg }, async () => {
  const l = await app.auth.cloud.beginLogin()
  site.approve(l.codigo)
  await waitFor(() => app.auth.cloud.signedIn && app.auth.listAccounts().some(a => a.id === 'nuvem:g1'))
  await waitFor(() => app.referencias.status().ativo)
  colecao = (await post('/api/referencias/colecoes', { nome: 'Trilhas' })).json.colecao
  assert.ok(colecao?.driveFolderId)
  const c = await get('/api/referencias/conversor')
  assert.equal(c.status, 200)
  assert.equal(c.json.conversor.ok, true)
  assert.equal(c.json.conversor.mp3, true)
})

test('salvar com "Também salvar como" MP3 320 + WAV: convertidos do vídeo baixado, ao lado do original', { skip: semFfmpeg }, async () => {
  const r = await post('/api/referencias/salvar', { url: 'https://www.instagram.com/reel/DQfmt123/', colecaoId: colecao.id, formatos: ['mp3-320', 'wav', 'mp3-320', 'original'] })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.deepEqual(r.json.trabalho.formatos, ['mp3-320', 'wav'])
  const principal = await esperarFim(r.json.trabalho.id)
  assert.equal(principal.fase, 'pronto', principal.erro?.mensagem)
  await waitFor(() => app.referencias.status().trabalhos.filter(t => t.tipo === 'formato').length === 2)
  const extras = app.referencias.status().trabalhos.filter(t => t.tipo === 'formato')
  for (const t of extras) assert.equal((await esperarFim(t.id)).fase, 'pronto', job(t.id).erro?.mensagem)
  const nomes = naColecao().map(i => i.name).sort()
  assert.deepEqual(nomes, [
    'Estúdio Norte - Plano-sequência na chuva (Instagram) (MP3 320).mp3',
    'Estúdio Norte - Plano-sequência na chuva (Instagram) (WAV).wav',
    'Estúdio Norte - Plano-sequência na chuva (Instagram).mp4',
  ])
  const mp3 = naColecao().find(i => i.name.endsWith('.mp3'))
  // Marcado como convertido (não entra no link pra IA nem na passada do celular), com a origem do original.
  assert.equal(mp3.appProperties.sobedesce, 'formato')
  assert.equal(mp3.appProperties.formato, 'mp3-320')
  assert.equal(mp3.appProperties.autor, 'Estúdio Norte')
  assert.equal(mp3.description.split('\n')[0], 'https://www.instagram.com/reel/DQfmt123/')
  const s = await sondaDrive(mp3)
  assert.deepEqual(s.map(x => x.codec_name), ['mp3'])
  assert.equal(Number(s[0].bit_rate), 320000)
  const wav = await sondaDrive(naColecao().find(i => i.name.endsWith('.wav')))
  assert.equal(wav[0].codec_name, 'pcm_s16le')
  assert.equal(Number(wav[0].sample_rate), 48000)
  // O original desceu uma vez (pelo yt-dlp); nada foi baixado do Drive para converter.
  assert.equal(mock.stats().mediaGets, 0)
  // A tela mostra o formato junto do título; temporários: nada sobrou.
  const it = await get(`/api/referencias/colecoes/${colecao.id}/itens?forcar=1`)
  assert.equal(it.json.itens.find(i => i.id === mp3.id).formato, 'MP3 320')
  assert.deepEqual(await restos('formatos'), [])
  assert.deepEqual(await restos('tmp'), [])
  assert.deepEqual(await restos('envios'), [])
})

test('"Baixar como…" M4A para a coleção e o computador; MP4 720p só no computador usa o mesmo original baixado', { skip: semFfmpeg }, async () => {
  const original = naColecao().find(i => i.name.endsWith('(Instagram).mp4'))
  const antes = mock.stats().mediaGets
  let r = await post('/api/referencias/exportar', { colecaoId: colecao.id, fileId: original.id, formato: 'm4a', destino: 'ambos' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.trabalho.formatoNome, 'M4A')
  let t = await esperarFim(r.json.trabalho.id)
  assert.equal(t.fase, 'pronto', t.erro?.mensagem)
  assert.equal(t.caminho, path.join(destino, 'Estúdio Norte - Plano-sequência na chuva (Instagram) (M4A).m4a'))
  assert.ok(fs.existsSync(t.caminho))
  const m4a = naColecao().find(i => i.name.endsWith('(M4A).m4a'))
  assert.ok(m4a, 'subiu ao lado do original')
  assert.equal(m4a.appProperties.de, original.id)
  assert.equal(t.driveFileId, m4a.id)
  assert.equal(mock.stats().mediaGets, antes + 1, 'o original desceu do Drive uma vez')
  // Segundo formato do mesmo arquivo: o original guardado serve (não baixa de novo); só no computador.
  r = await post('/api/referencias/exportar', { colecaoId: colecao.id, fileId: original.id, formato: 'mp4-720', destino: 'computador' })
  t = await esperarFim(r.json.trabalho.id)
  assert.equal(t.fase, 'pronto', t.erro?.mensagem)
  assert.equal(mock.stats().mediaGets, antes + 1)
  assert.ok(!naColecao().some(i => i.name.includes('MP4 720p')), 'não subiu para o Drive')
  assert.match(path.basename(t.caminho), /\(MP4 720p\)\.mp4$/)
  // De novo para o computador: não sobrescreve, ganha "(2)".
  r = await post('/api/referencias/exportar', { colecaoId: colecao.id, fileId: original.id, formato: 'mp4-720', destino: 'computador' })
  t = await esperarFim(r.json.trabalho.id)
  assert.match(path.basename(t.caminho), /\(MP4 720p\) \(2\)\.mp4$/)
  assert.deepEqual((await fsp.readdir(destino)).filter(n => n.endsWith('.part') || n.includes('sobedesce')), [])
})

test('erros claros: vídeo sem áudio, formato que não serve, arquivo que sumiu, entrada inválida', { skip: semFfmpeg }, async () => {
  const mudo = path.join(destino, 'mudo.mp4')
  gerar(mudo, ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:duration=1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'])
  const f = mock.addFile('Sem som (Instagram).mp4', colecao.driveFolderId, { content: await fsp.readFile(mudo), mimeType: 'video/mp4' })
  await fsp.rm(mudo)
  const r = await post('/api/referencias/exportar', { colecaoId: colecao.id, fileId: f.id, formato: 'mp3-320', destino: 'drive' })
  assert.equal(r.status, 200)
  const t = await esperarFim(r.json.trabalho.id)
  assert.equal(t.fase, 'erro')
  assert.equal(t.erro.mensagem, 'Este vídeo não tem áudio.')
  assert.ok(!naColecao().some(i => i.name.startsWith('Sem som') && i.name.endsWith('.mp3')))
  const casos = [
    [{ colecaoId: colecao.id, fileId: f.id, formato: 'jpg' }, 400, /não vale para este arquivo/],
    [{ colecaoId: colecao.id, fileId: f.id, formato: 'original' }, 400, /formato/],
    [{ colecaoId: colecao.id, fileId: f.id, formato: 'flac' }, 400, /formato/],
    [{ colecaoId: colecao.id, fileId: f.id, formato: 'wav', destino: 'nuvem' }, 400, /onde salvar/],
    [{ colecaoId: colecao.id, fileId: f.id, formato: 'wav', destDir: 'relativa/pasta' }, 400, /Pasta/],
    [{ colecaoId: colecao.id, fileId: 'nao_existe_123', formato: 'wav' }, 404, /não está mais no Drive/],
    [{ colecaoId: 'col_x', fileId: f.id, formato: 'wav' }, 404, /coleção/],
  ]
  for (const [body, status, re] of casos) {
    const x = await post('/api/referencias/exportar', body)
    assert.equal(x.status, status, `${JSON.stringify(body)} → ${x.status} ${x.json?.error}`)
    assert.match(x.json.error, re)
  }
  const s = await post('/api/referencias/salvar', { url: 'https://youtu.be/abc123xyz', colecaoId: colecao.id, formatos: ['mp3'] })
  assert.equal(s.status, 400)
})

test('link do celular com "Também salvar como": o computador salva o original e o M4A', { skip: semFfmpeg }, async () => {
  const item = site.addFila('https://www.youtube.com/watch?v=fmtcel123', colecao.id, { formatos: ['m4a'] })
  const antes = naColecao().length
  await post('/api/referencias/fila/consultar')
  await waitFor(() => item.status === 'pronto', { timeoutMs: 30_000, message: `fila: ${item.status} ${item.erro || ''}` })
  await waitFor(() => naColecao().length === antes + 2, { timeoutMs: 30_000, message: `na coleção: ${naColecao().map(i => i.name).join(', ')}` })
  const t = app.referencias.status().trabalhos.find(x => x.tipo === 'formato' && x.origem === 'fila')
  assert.equal(t.formato, 'm4a')
  assert.equal((await esperarFim(t.id)).fase, 'pronto')
})
