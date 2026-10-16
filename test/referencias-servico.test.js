// Referências de ponta a ponta no motor: site falso (test/mock-cloud.js) + Drive falso (test/mock-drive.js) + yt-dlp de
// mentira (test/fake-ytdlp.mjs). Salvar um link (nome, appProperties, descrição, miniatura e envio pela fila de
// transferências), cookies passados e apagados, erro com frase humana, cancelar, a fila do celular (corrida entre
// computadores, pronto/erro no site), 403 plano e a validação das rotas.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startApp } from '../src/index.js'
import { closeHttp } from '../src/net/http.js'
import { bytesUtf8 } from '../src/referencias/metadados.js'
import { makeTmpDir, waitFor } from './helpers.js'
import { startMockDrive } from './mock-drive.js'
import { startMockCloud } from './mock-cloud.js'

const FAKE = fileURLToPath(new URL('./fake-ytdlp.mjs', import.meta.url))
const keepAwake = { active: false, setActive() {}, stop() {} }
let mock, site, home, bin, log, app
const cookiesPedidos = []

before(async () => {
  home = await makeTmpDir()
  const binDir = await makeTmpDir('sd-ref-bin-')
  bin = path.join(binDir, 'yt-dlp')
  await fs.copyFile(FAKE, bin)
  await fs.chmod(bin, 0o755)
  log = path.join(binDir, 'log.jsonl')
  process.env.FAKE_YTDLP_LOG = log
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
    referenciasOptions: {
      updater,
      ffmpeg: () => '/bin/true',
      jsRuntime: null,
      pollMs: 60_000,
      vidaMs: 150,
      log: () => {},
      cookies: async dominios => {
        cookiesPedidos.push(dominios)
        return [
          { name: 'sessionid', value: 'segredo123', domain: '.instagram.com', path: '/', secure: true, httpOnly: true, expirationDate: 1893456000 },
          { name: 'csrftoken', value: 'tok', domain: 'www.instagram.com', hostOnly: true, path: '/', secure: true, session: true },
        ]
      },
    },
  })
  await app.settings.update({ keepAwake: false, verifyChecksums: false })
})

after(async () => {
  delete process.env.FAKE_YTDLP_LOG
  await app?.shutdown()
  await site?.close().catch(() => {})
  await mock?.close()
  await fs.rm(home, { recursive: true, force: true, maxRetries: 3 })
  await closeHttp()
})

function call(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const h = { host: `127.0.0.1:${app.port}`, ...headers }
    if (method !== 'GET' && !Object.keys(h).some(k => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json'
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
async function esperarFase(id, fases, timeoutMs = 15_000) {
  await waitFor(() => fases.includes(job(id)?.fase), { timeoutMs, message: `trabalho ${id} não chegou em ${fases} (está em ${job(id)?.fase}: ${job(id)?.erro?.mensagem || ''})` })
  return job(id)
}
const lerLog = async () => (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
const restos = async sub => (await fs.readdir(path.join(home, 'referencias', sub)).catch(() => []))

let colecao

test('sem a conta SOBEDESCE: Referências desligadas, salvar pede login', async () => {
  const r = await get('/api/referencias')
  assert.equal(r.status, 200)
  assert.equal(r.json.referencias.ativo, false)
  assert.equal(r.json.referencias.motivo, 'sem_conta')
  const s = await post('/api/referencias/salvar', { url: 'https://www.instagram.com/reel/abc12/', colecaoId: 'col_1' })
  assert.equal(s.status, 401)
  assert.match(s.json.error, /Entre na conta SOBEDESCE/)
  const st = await get('/api/state')
  assert.equal(st.json.referencias.ativo, false)
})

test('entra na conta e cria uma coleção (a pasta nasce no Drive)', async () => {
  const l = await app.auth.cloud.beginLogin()
  site.approve(l.codigo)
  await waitFor(() => app.auth.cloud.signedIn && app.auth.listAccounts().some(a => a.id === 'nuvem:g1'))
  await waitFor(() => app.referencias.status().ativo)
  let r = await post('/api/referencias/colecoes', { nome: '  Clipes  ' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  colecao = r.json.colecao
  assert.equal(colecao.nome, 'Clipes')
  assert.equal(colecao.contaId, 'nuvem:g1')
  assert.equal(mock.listAll().find(i => i.id === colecao.driveFolderId)?.name, 'Clipes')
  r = await get('/api/referencias/colecoes')
  assert.deepEqual(r.json.colecoes.map(c => c.nome), ['Clipes'])
})

test('salvar um reel: yt-dlp com cookies (0600, apagados), nome, appProperties, descrição, miniatura e envio na fila', async () => {
  const url = 'https://www.instagram.com/reel/DQx1AbCdEfG/?igsh=rastreio'
  const r = await post('/api/referencias/salvar', { url, colecaoId: colecao.id, nota: 'luz de janela', origem: 'navegador' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const t = await esperarFase(r.json.trabalho.id, ['pronto', 'erro'])
  assert.equal(t.fase, 'pronto', t.erro?.mensagem)
  assert.equal(t.origem, 'navegador')
  // Cookies: só do Instagram, arquivo 0600 enquanto o yt-dlp roda, apagado depois.
  assert.deepEqual(cookiesPedidos.at(-1), ['instagram.com'])
  const chamada = (await lerLog()).find(l => l.args.includes('https://www.instagram.com/reel/DQx1AbCdEfG/'))
  assert.ok(chamada.cookies, 'yt-dlp recebeu --cookies')
  assert.equal(chamada.cookies.modo, '600')
  assert.match(chamada.cookies.texto, /#HttpOnly_\.instagram\.com\tTRUE\t\/\tTRUE\t1893456000\tsessionid\tsegredo123/)
  await assert.rejects(fs.stat(chamada.cookies.caminho), 'arquivo de cookies apagado')
  assert.ok(!chamada.args.includes('igsh'), 'link limpo de rastreio')
  // O arquivo no Drive.
  const f = mock.listAll().find(i => i.parents[0] === colecao.driveFolderId && !i.isFolder)
  assert.equal(f.name, 'Estúdio Norte - Plano-sequência na chuva (Instagram).mp4')
  assert.equal(f.appProperties.sobedesce, 'referencia')
  assert.equal(f.appProperties.plataforma, 'Instagram')
  assert.equal(f.appProperties.autor, 'Estúdio Norte')
  for (const [k, v] of Object.entries(f.appProperties)) assert.ok(bytesUtf8(k) + bytesUtf8(v) <= 124, k)
  const linhas = f.description.split('\n')
  assert.equal(linhas[0], 'https://www.instagram.com/reel/DQx1AbCdEfG/')
  assert.ok(linhas.includes('Autor: Estúdio Norte'))
  assert.ok(f.description.includes('Nota: luz de janela'))
  assert.ok(f.description.includes('Legenda original do post.'))
  assert.equal(t.driveFileId, f.id)
  await waitFor(() => mock.thumbnailOf?.(f.id) || mock.listAll().find(i => i.id === f.id)?.hasThumbnail !== false, { timeoutMs: 3000 }).catch(() => {})
  // Apareceu em Transferências como envio (lote "quieto": o aviso é o "Salvo em Clipes").
  const tr = app.manager.snapshot().transfers.find(x => x.id === t.transferId)
  assert.equal(tr.status, 'completed')
  assert.equal(tr.referencia.jobId, t.id)
  assert.equal(app.manager.snapshot().batches.find(b => b.id === tr.batchId).label, 'Referência · Clipes')
  // Temporários: nada sobrou.
  assert.deepEqual(await restos('tmp'), [])
  assert.deepEqual(await restos('envios'), [])
  // A tela lê de volta (com a origem de cada arquivo).
  const it = await get(`/api/referencias/colecoes/${colecao.id}/itens?forcar=1`)
  assert.equal(it.status, 200)
  assert.equal(it.json.itens.length, 1)
  assert.equal(it.json.itens[0].referencia.autor, 'Estúdio Norte')
  assert.equal(it.json.itens[0].referencia.nota, 'luz de janela')
  assert.equal(it.json.accountId, 'nuvem:g1')
})

test('salvar de novo o mesmo vídeo não duplica (igual = já estava no Drive)', async () => {
  const r = await post('/api/referencias/salvar', { url: 'https://www.instagram.com/reel/DQx1AbCdEfG/', colecaoId: colecao.id })
  const t = await esperarFase(r.json.trabalho.id, ['pronto', 'erro'])
  assert.equal(t.fase, 'pronto')
  assert.equal(mock.listAll().filter(i => i.parents[0] === colecao.driveFolderId).length, 1)
})

test('erro do site vira frase curta (Instagram pediu login) e os temporários somem', async () => {
  const r = await post('/api/referencias/salvar', { url: 'https://www.instagram.com/reel/erro-login/', colecaoId: colecao.id })
  const t = await esperarFase(r.json.trabalho.id, ['erro', 'pronto'])
  assert.equal(t.fase, 'erro')
  assert.equal(t.erro.mensagem, 'O Instagram pediu login: entre no Instagram pelo navegador de referências.')
  assert.deepEqual(await restos('tmp'), [])
  // Tentar de novo volta para a fila (e erra de novo, igual).
  const again = await post(`/api/referencias/trabalhos/${t.id}/tentar`)
  assert.equal(again.status, 200)
  await esperarFase(t.id, ['erro'])
  const rm = await call('DELETE', `/api/referencias/trabalhos/${t.id}`, {})
  assert.equal(rm.status, 200)
  assert.equal(job(t.id), undefined)
})

test('cancelar no meio do download mata o yt-dlp e limpa tudo', async () => {
  const r = await post('/api/referencias/salvar', { url: 'https://youtu.be/lento12345', colecaoId: colecao.id })
  const id = r.json.trabalho.id
  await waitFor(() => job(id)?.progresso?.fase === 'baixando', { timeoutMs: 10_000 })
  const pid = (await lerLog()).find(l => l.args.includes('https://youtu.be/lento12345')).pid
  const c = await post(`/api/referencias/trabalhos/${id}/cancelar`)
  assert.equal(c.status, 200)
  assert.equal(job(id).fase, 'cancelado')
  await waitFor(() => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }, { message: 'yt-dlp continuou rodando' })
  await waitFor(async () => (await restos('tmp')).length === 0)
  assert.deepEqual(await restos('envios'), [])
})

test('fila do celular: pega, baixa, marca pronto/erro no site; item que outro computador pegou fica com ele', async () => {
  const a = site.addFila('https://www.youtube.com/watch?v=abc123xyz', colecao.id, { nota: 'abertura' })
  const b = site.addFila('https://youtu.be/privado99', colecao.id)
  const c = site.addFila('https://www.tiktok.com/@fulano/video/7312345678901234567', colecao.id)
  // Corrida: entre a lista e o "pegar", outro computador pega o item c.
  const pegar = app.referencias.api.pegar.bind(app.referencias.api)
  app.referencias.api.pegar = async id => {
    if (id === c.id) c.status = 'baixando'
    return pegar(id)
  }
  try {
    const r = await post('/api/referencias/fila/consultar')
    assert.equal(r.status, 200)
    await waitFor(() => a.status === 'pronto' && b.status === 'erro', { timeoutMs: 15_000, message: `fila: a=${a.status} b=${b.status}` })
  } finally {
    app.referencias.api.pegar = pegar
  }
  assert.ok(a.driveFileId)
  assert.ok(mock.listAll().some(i => i.id === a.driveFileId && i.description.includes('Nota: abertura')))
  assert.equal(b.erro, 'Vídeo privado ou removido.')
  assert.equal(c.status, 'baixando', 'o outro computador ficou com o item')
  assert.ok(!app.referencias.status().trabalhos.some(t => t.filaId === c.id))
  // O link com erro aparece uma vez só: como trabalho deste computador (com "Tentar de novo"), não como pendência.
  const local = app.referencias.status().trabalhos.find(t => t.filaId === b.id)
  assert.equal(local.fase, 'erro')
  assert.equal(local.origem, 'fila')
  let it = await get(`/api/referencias/colecoes/${colecao.id}/itens?forcar=1`)
  assert.ok(!it.json.pendentes.some(p => p.id === b.id))
  // "Tentar de novo" num item da fila devolve para o site (pendente) e o consumidor pega de novo.
  assert.equal((await post(`/api/referencias/trabalhos/${local.id}/tentar`)).status, 200)
  await waitFor(() => b.status === 'erro' && app.referencias.status().trabalhos.some(t => t.filaId === b.id && t.fase === 'erro' && t.id !== local.id), { timeoutMs: 15_000 })
  // Item com erro que este computador não conhece (ex.: outro computador tentou): aparece como pendência.
  const d = site.addFila('https://youtu.be/privado77', colecao.id, { status: 'erro', erro: 'Vídeo privado ou removido.' })
  it = await get(`/api/referencias/colecoes/${colecao.id}/itens?forcar=1`)
  assert.ok(it.json.pendentes.some(p => p.id === d.id && p.status === 'erro'))
  assert.equal((await post(`/api/referencias/fila/${d.id}/tentar`)).status, 200)
  await waitFor(() => d.status === 'erro' && app.referencias.status().trabalhos.some(t => t.filaId === d.id), { timeoutMs: 15_000 })
})

test('download longo de um item da fila manda sinal de vida ao site (PATCH baixando)', async () => {
  const item = site.addFila('https://youtu.be/lento67890', colecao.id)
  await post('/api/referencias/fila/consultar')
  await waitFor(() => item.vidaEm, { timeoutMs: 10_000, message: 'nenhum sinal de vida' })
  assert.equal(item.status, 'baixando')
  const t = app.referencias.status().trabalhos.find(x => x.filaId === item.id)
  await post(`/api/referencias/trabalhos/${t.id}/cancelar`)
  await waitFor(() => item.status === 'erro')
  assert.equal(item.erro, 'Cancelado no computador.')
  assert.equal((await call('DELETE', `/api/referencias/fila/${item.id}`, {})).status, 200)
  assert.ok(!site.fila.includes(item))
})

test('recurso fora do plano: 403 com a frase do site e o consumidor da fila para', async () => {
  site.referenciasPermitidas = false
  try {
    const r = await get('/api/referencias/colecoes?forcar=1')
    assert.equal(r.status, 403)
    assert.match(r.json.error, /plano Produtora/)
    assert.equal(app.referencias.status().motivo, 'plano')
    assert.equal(app.referencias.status().ativo, false)
    const antes = site.stats.fila
    await app.referencias.consultarFila()
    assert.equal(site.stats.fila, antes, 'não pergunta de novo durante a pausa')
  } finally {
    site.referenciasPermitidas = true
    app.referencias.planoAte = 0
  }
  await get('/api/referencias/colecoes?forcar=1')
  assert.equal(app.referencias.status().ativo, true)
})

test('rotas validam a entrada', async () => {
  const casos = [
    ['POST', '/api/referencias/salvar', { url: 'não é link', colecaoId: colecao.id }, 400],
    ['POST', '/api/referencias/salvar', { url: 'https://youtu.be/abc123xyz', colecaoId: '../x' }, 400],
    ['POST', '/api/referencias/salvar', { url: 'https://youtu.be/abc123xyz', colecaoId: colecao.id, nota: 42 }, 400],
    ['POST', '/api/referencias/salvar', { url: 42, colecaoId: colecao.id }, 400],
    ['POST', '/api/referencias/salvar', { url: 'https://youtu.be/abc123xyz', colecaoId: 'col_nao_existe' }, 404],
    ['POST', '/api/referencias/salvar-imagem', { imagemUrl: 'file:///etc/passwd', colecaoId: colecao.id }, 400],
    ['POST', '/api/referencias/salvar-imagem', { imagemUrl: 'javascript:alert(1)', colecaoId: colecao.id }, 400],
    ['POST', '/api/referencias/colecoes', { nome: 'a/b' }, 400],
    ['POST', '/api/referencias/colecoes', { nome: '' }, 400],
    ['POST', '/api/referencias/colecoes', { nome: 'x'.repeat(81) }, 400],
    ['POST', '/api/referencias/colecoes', { nome: 'Ok', contaId: 'local123' }, 400],
    ['PATCH', `/api/referencias/colecoes/${colecao.id}`, { link: 'sim' }, 400],
    ['PATCH', `/api/referencias/colecoes/${colecao.id}`, {}, 400],
    ['DELETE', `/api/referencias/colecoes/${colecao.id}`, { apagarNoDrive: 'sim' }, 400],
    ['POST', '/api/referencias/trabalhos/nao-existe/cancelar', {}, 404],
  ]
  for (const [m, p, b, status] of casos) {
    const r = await call(m, p, b)
    assert.equal(r.status, status, `${m} ${p} ${JSON.stringify(b)} → ${r.status} ${r.json?.error}`)
    assert.equal(r.json.ok, false)
  }
  // Sem Content-Type JSON (um <form> de outro site): recusado antes de tudo.
  const f = await call('POST', '/api/referencias/salvar', { url: 'https://youtu.be/abc123xyz', colecaoId: colecao.id }, { 'content-type': 'text/plain' })
  assert.equal(f.status, 415)
  const o = await call('POST', '/api/referencias/salvar', { url: 'https://youtu.be/abc123xyz', colecaoId: colecao.id }, { origin: 'https://www.instagram.com' })
  assert.equal(o.status, 403)
  const d = await get(`/api/referencias/detectar?url=${encodeURIComponent('olha https://youtu.be/abc123xyz?si=x')}`)
  assert.equal(d.json.url, 'https://youtu.be/abc123xyz')
  assert.equal(d.json.salvavel, true)
  assert.equal(d.json.nome, 'YouTube')
})

test('link pra IA, renomear e apagar a coleção', async () => {
  let r = await call('PATCH', `/api/referencias/colecoes/${colecao.id}`, { link: 'ligar' })
  assert.match(r.json.colecao.link, /\/r\//)
  r = await call('PATCH', `/api/referencias/colecoes/${colecao.id}`, { link: false })
  assert.equal(r.json.colecao.link, null)
  r = await call('PATCH', `/api/referencias/colecoes/${colecao.id}`, { nome: 'Clipes 2026' })
  assert.equal(r.json.colecao.nome, 'Clipes 2026')
  r = await call('DELETE', `/api/referencias/colecoes/${colecao.id}`, {})
  assert.equal(r.status, 200)
  assert.equal(site.colecoes.length, 0)
})
