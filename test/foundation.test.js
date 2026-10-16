// Testes da base: store, limiter, meter, paths, classifyError e validateSettings.
import { test, describe, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import util from 'node:util'

import { readJSON, writeJSONAtomic, JsonFile } from '../src/util/store.js'
import { BandwidthLimiter } from '../src/util/limiter.js'
import { SpeedMeter, eta } from '../src/util/meter.js'
import { safeLocalName, uniqueName, isJunkFile, joinRel, splitRel, toNFC, PART_SUFFIX } from '../src/util/paths.js'
import { classifyError, SobeDesceError, stalledError } from '../src/google/errors.js'
import { HttpError, closeHttp } from '../src/net/http.js'
import { validateSettings, DEFAULT_SETTINGS, Settings, dataPaths } from '../src/config.js'
import { sleep, abortError, isAbortError, backoffDelay } from '../src/util/backoff.js'

const KiB = 1024
const MiB = 1024 * KiB

let home
const prevHome = process.env.SOBEDESCE_HOME
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'sobedesce-found-'))
  process.env.SOBEDESCE_HOME = home
})
afterEach(async () => {
  if (prevHome === undefined) delete process.env.SOBEDESCE_HOME
  else process.env.SOBEDESCE_HOME = prevHome
  await fs.rm(home, { recursive: true, force: true })
})
after(async () => {
  await closeHttp()
})

describe('util/store.js', () => {
  test('grava de forma atômica e não deixa temporários', async () => {
    const file = path.join(home, 'sub', 'dados.json')
    await writeJSONAtomic(file, { a: 1, nome: 'Ação' })
    assert.deepEqual(await readJSON(file), { a: 1, nome: 'Ação' })
    const st = await fs.stat(file)
    assert.equal(st.mode & 0o777, 0o600)
    const left = (await fs.readdir(path.dirname(file))).filter(n => n.includes('.tmp-'))
    assert.deepEqual(left, [])
  })

  test('gravações simultâneas no mesmo arquivo são enfileiradas (vence a última)', async () => {
    const file = path.join(home, 'fila.json')
    const big = 'x'.repeat(200 * KiB) // grande o bastante para as gravações se sobreporem se não houver fila
    const writes = []
    for (let i = 0; i < 40; i++) writes.push(writeJSONAtomic(file, { i, big }))
    await Promise.all(writes)
    const data = await readJSON(file)
    assert.equal(data.i, 39)
    assert.equal(data.big.length, big.length)
    const left = (await fs.readdir(home)).filter(n => n.includes('.tmp-'))
    assert.deepEqual(left, [])
  })

  test('gravações em arquivos diferentes não se bloqueiam', async () => {
    await Promise.all([writeJSONAtomic(path.join(home, 'a.json'), { a: 1 }), writeJSONAtomic(path.join(home, 'b.json'), { b: 2 })])
    assert.deepEqual(await readJSON(path.join(home, 'a.json')), { a: 1 })
    assert.deepEqual(await readJSON(path.join(home, 'b.json')), { b: 2 })
  })

  test('uma gravação que falha não trava as próximas nem deixa lixo', async () => {
    const file = path.join(home, 'alvo.json')
    // Uma pasta com conteúdo no lugar do arquivo: o rename final falha.
    await fs.mkdir(path.join(file, 'dentro'), { recursive: true })
    await assert.rejects(writeJSONAtomic(file, { x: 1 }))
    const left = (await fs.readdir(home)).filter(n => n.includes('.tmp-'))
    assert.deepEqual(left, [], 'o temporário da gravação que falhou deve ser apagado')
    await fs.rm(file, { recursive: true })
    await writeJSONAtomic(file, { x: 2 })
    assert.deepEqual(await readJSON(file), { x: 2 })
  })

  test('JSON corrompido: guarda uma cópia e volta ao padrão', async () => {
    const file = path.join(home, 'quebrado.json')
    await fs.writeFile(file, '{"a": 1, "b": ')
    assert.deepEqual(await readJSON(file, { padrao: true }), { padrao: true })
    const names = await fs.readdir(home)
    assert.ok(names.some(n => n.startsWith('quebrado.json.corrupt-')), 'cópia do arquivo corrompido')
    assert.ok(!names.includes('quebrado.json'))
    // Arquivo vazio também conta como corrompido.
    await fs.writeFile(file, '')
    assert.equal(await readJSON(file, null), null)
  })

  test('arquivo inexistente devolve o padrão', async () => {
    assert.deepEqual(await readJSON(path.join(home, 'nao-existe.json'), []), [])
  })

  test('JsonFile: load, saveSoon agrupa, flush grava', async () => {
    const file = path.join(home, 'jf.json')
    const jf = new JsonFile(file, { lista: [] })
    assert.deepEqual(await jf.load(), { lista: [] })
    jf.data.lista.push(1)
    jf.saveSoon(50)
    jf.data.lista.push(2)
    jf.saveSoon(50) // segunda chamada na mesma janela não agenda outra
    await jf.flush()
    assert.deepEqual(await readJSON(file), { lista: [1, 2] })
    assert.equal(jf.timer, null)

    jf.data.lista.push(3)
    jf.saveSoon(30)
    await sleep(150)
    assert.deepEqual(await readJSON(file), { lista: [1, 2, 3] })

    // Os padrões não são compartilhados entre instâncias.
    const other = new JsonFile(path.join(home, 'outro.json'), { lista: [] })
    assert.deepEqual(other.data, { lista: [] })
    const again = new JsonFile(file, {})
    assert.deepEqual(await again.load(), { lista: [1, 2, 3] })
  })
})

describe('util/limiter.js', () => {
  test('sem limite passa na hora', async () => {
    const lim = new BandwidthLimiter(0)
    assert.equal(lim.unlimited, true)
    const t0 = Date.now()
    for (let i = 0; i < 1000; i++) await lim.take(1 * MiB)
    assert.ok(Date.now() - t0 < 500)
  })

  test('respeita a taxa (±25%)', async () => {
    const rate = 2 * MiB
    const lim = new BandwidthLimiter(rate)
    // Esvazia o balde inicial para medir só a taxa sustentada.
    await lim.take(lim.capacity)
    const t0 = Date.now()
    let sent = 0
    while (Date.now() - t0 < 1500) {
      await lim.take(64 * KiB)
      sent += 64 * KiB
    }
    const elapsed = (Date.now() - t0) / 1000
    const measured = sent / elapsed
    assert.ok(measured > rate * 0.75 && measured < rate * 1.25, `taxa medida ${Math.round(measured)} vs ${rate}`)
  })

  test('vários consumidores dividem a mesma taxa', async () => {
    const rate = 1 * MiB
    const lim = new BandwidthLimiter(rate)
    await lim.take(lim.capacity)
    const t0 = Date.now()
    let sent = 0
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (Date.now() - t0 < 1500) {
        await lim.take(16 * KiB)
        sent += 16 * KiB
      }
    }))
    const measured = sent / ((Date.now() - t0) / 1000)
    assert.ok(measured > rate * 0.75 && measured < rate * 1.25, `taxa medida ${Math.round(measured)} vs ${rate}`)
  })

  test('pedido maior que o balde passa e é pago depois', async () => {
    const lim = new BandwidthLimiter(256 * KiB)
    const t0 = Date.now()
    await lim.take(512 * KiB) // balde cheio: passa
    assert.ok(Date.now() - t0 < 200)
    await lim.take(64 * KiB) // agora deve esperar a dívida
    assert.ok(Date.now() - t0 >= 900, `esperou ${Date.now() - t0} ms`)
  })

  test('take respeita AbortSignal e setRate(0) libera', async () => {
    const lim = new BandwidthLimiter(64 * KiB)
    await lim.take(lim.capacity)
    const ac = new AbortController()
    const p = lim.take(10 * MiB, ac.signal)
    setTimeout(() => ac.abort(), 50)
    await assert.rejects(p, err => isAbortError(err))
    lim.setRate(0)
    assert.equal(lim.unlimited, true)
    await lim.take(100 * MiB)
  })
})

describe('util/meter.js', () => {
  test('taxa bruta numa janela', () => {
    const m = new SpeedMeter({ windowMs: 4000 })
    const t0 = 1_000_000
    for (let i = 0; i < 8; i++) m.add(1 * MiB, t0 + i * 250) // 8 MiB em 2 s
    const raw = m.rawRate(t0 + 2000)
    assert.ok(Math.abs(raw - 4 * MiB) < 0.01 * MiB, `raw ${raw}`)
    assert.equal(m.total, 8 * MiB)
  })

  test('janela curta conta pelo menos 1 s (sem picos absurdos)', () => {
    const m = new SpeedMeter()
    const t0 = 5_000_000
    m.add(1 * MiB, t0)
    assert.equal(m.rawRate(t0 + 10), 1 * MiB)
  })

  test('dados velhos saem da janela', () => {
    const m = new SpeedMeter({ windowMs: 2000 })
    const t0 = 2_000_000
    m.add(10 * MiB, t0)
    assert.equal(m.rawRate(t0 + 5000), 0)
    assert.equal(m.buckets.length, 0)
  })

  test('rate suaviza e zera quando para', () => {
    const m = new SpeedMeter({ windowMs: 1000, smoothing: 0.5 })
    let t = 3_000_000
    for (let i = 0; i < 8; i++, t += 250) {
      m.add(250 * KiB, t)
      m.rate(t)
    }
    const r = m.rate(t)
    assert.ok(r > 700 * KiB && r < 1300 * KiB, `rate ${r}`)
    // Sem bytes: cai até zerar.
    let last = r
    for (let i = 0; i < 80; i++) {
      t += 250
      last = m.rate(t)
    }
    assert.equal(last, 0)
    m.reset()
    assert.equal(m.rate(t + 1000), 0)
    m.add(0, t) // zero bytes é ignorado
    assert.equal(m.buckets.length, 0)
  })

  test('eta', () => {
    assert.equal(eta(100, 10), 10)
    assert.equal(eta(101, 10), 11)
    assert.equal(eta(0, 10), 0)
    assert.equal(eta(-5, 0), 0)
    assert.equal(eta(100, 0), null)
    assert.equal(eta(100, 0.5), null)
  })
})

describe('util/paths.js', () => {
  test('joinRel e splitRel', () => {
    assert.equal(joinRel('a', 'b/c'), 'a/b/c')
    assert.equal(joinRel('', 'a', null, undefined, '/b/', 'c'), 'a/b/c')
    assert.equal(joinRel(), '')
    assert.deepEqual(splitRel('a/b/c'), ['a', 'b', 'c'])
    assert.deepEqual(splitRel(''), [])
    assert.deepEqual(splitRel('a//b/'), ['a', 'b'])
    assert.deepEqual(splitRel(undefined), [])
  })

  test('toNFC', () => {
    const nfd = 'Ação'
    assert.equal(toNFC(nfd), 'Ação')
    assert.equal(toNFC(null), '')
  })

  test('safeLocalName no Windows', () => {
    assert.equal(safeLocalName('a<b>c:d"e/f\\g|h?i*j.mov', 'win32'), 'a_b_c_d_e_f_g_h_i_j.mov')
    assert.equal(safeLocalName('final. . ', 'win32'), 'final')
    assert.equal(safeLocalName('CON', 'win32'), 'CON_')
    assert.equal(safeLocalName('nul', 'win32'), 'nul_')
    assert.equal(safeLocalName('COM1', 'win32'), 'COM1_')
    assert.equal(safeLocalName('lpt9.txt', 'win32'), 'lpt9_.txt')
    // "CON.txt" também é reservado no Windows: o '_' precisa ir antes da extensão.
    assert.equal(safeLocalName('con.txt', 'win32'), 'con_.txt')
    assert.equal(safeLocalName('aux.tar.gz', 'win32'), 'aux_.tar.gz')
    assert.equal(safeLocalName('CONSOLE.txt', 'win32'), 'CONSOLE.txt')
    assert.equal(safeLocalName('...', 'win32'), '_')
    assert.equal(safeLocalName('tab\there', 'win32'), 'tab_here')
  })

  test('safeLocalName no mac e no Linux', () => {
    assert.equal(safeLocalName('a/b:c.mov', 'darwin'), 'a_b_c.mov')
    assert.equal(safeLocalName('a/b:c.mov', 'linux'), 'a_b:c.mov')
    assert.equal(safeLocalName('con.txt', 'linux'), 'con.txt')
    assert.equal(safeLocalName('', 'linux'), '_')
    assert.equal(safeLocalName('   ', 'linux'), '_')
    assert.equal(safeLocalName('.', 'linux'), '_')
    assert.equal(safeLocalName('..', 'darwin'), '_')
    assert.equal(safeLocalName('linha\nnova\u007f', 'linux'), 'linha_nova_')
    assert.equal(safeLocalName('trailing. ', 'linux'), 'trailing. ')
    // NFD vira NFC.
    assert.equal(safeLocalName('Ação.mov', 'darwin'), 'Ação.mov')
  })

  test('safeLocalName limita a 240 bytes UTF-8 e preserva a extensão', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const long = 'ç'.repeat(300) + '.mov' // 2 bytes por letra
      const out = safeLocalName(long, platform)
      assert.ok(Buffer.byteLength(out) <= 240, `${platform}: ${Buffer.byteLength(out)}`)
      assert.ok(out.endsWith('.mov'))
      assert.ok(out.startsWith('ççç'))
      const emoji = '🎬'.repeat(100) + '.braw'
      const out2 = safeLocalName(emoji, platform)
      assert.ok(Buffer.byteLength(out2) <= 240)
      assert.ok(out2.endsWith('.braw'))
      assert.ok(!out2.includes('�'), 'não corta emoji no meio')
      const noExt = 'a'.repeat(500)
      assert.equal(Buffer.byteLength(safeLocalName(noExt, platform)), 240)
    }
  })

  test('uniqueName', () => {
    assert.equal(uniqueName('a.mov', new Set()), 'a.mov')
    assert.equal(uniqueName('a.mov', new Set(['a.mov'])), 'a (2).mov')
    assert.equal(uniqueName('A.MOV', new Set(['a.mov', 'A (2).mov'])), 'A (3).MOV')
    assert.equal(uniqueName('pasta', ['pasta']), 'pasta (2)')
    assert.equal(uniqueName('.bashrc', new Set(['.bashrc'])), '.bashrc (2)')
    assert.equal(uniqueName('x.tar.gz', new Set(['x.tar.gz'])), 'x.tar (2).gz')
  })

  test('isJunkFile', () => {
    for (const junk of ['.DS_Store', '.ds_store', '._clip.mov', 'Thumbs.db', 'thumbs.db', 'desktop.ini', 'Desktop.ini', `video.mov${PART_SUFFIX}`, 'Icon\r', '.Spotlight-V100', '.Trashes', '.fseventsd', '.TemporaryItems']) {
      assert.equal(isJunkFile(junk), true, junk)
    }
    for (const ok of ['video.mov', '.gitignore', 'Icon', 'icones', '_clip.mov', 'DS_Store', 'thumbs.db.bak', 'a.sobedesce-part.mov']) {
      assert.equal(isJunkFile(ok), false, ok)
    }
  })
})

describe('google/errors.js classifyError', () => {
  const googleBody = (status, reason, message = 'msg') => ({ error: { code: status, message, errors: [{ reason, message, domain: 'usageLimits' }] } })
  const http = (status, body = null, headers = {}) => new HttpError(status, { body, headers, url: 'https://www.googleapis.com/drive/v3/files?upload_id=SEGREDO', method: 'GET' })

  test('abort não é erro', () => {
    assert.equal(classifyError(abortError()).kind, 'abort')
    const ac = new AbortController()
    ac.abort()
    assert.equal(classifyError(ac.signal.reason).kind, 'abort')
    assert.equal(classifyError({ code: 'UND_ERR_ABORTED', message: 'x' }).kind, 'abort')
  })

  test('códigos de rede viram retry', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ERR_STREAM_PREMATURE_CLOSE']) {
      const err = Object.assign(new Error('falhou'), { code })
      const info = classifyError(err)
      assert.equal(info.kind, 'retry', code)
      assert.equal(info.reason, code)
      assert.match(info.message, /conexão caiu/)
    }
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN']) {
      const info = classifyError(Object.assign(new Error('x'), { code }))
      assert.equal(info.kind, 'retry')
      assert.match(info.message, /Sem internet/)
    }
    // Código no `cause` (fetch do undici).
    const wrapped = new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) })
    assert.equal(classifyError(wrapped).kind, 'retry')
    assert.equal(classifyError(new TypeError('fetch failed')).kind, 'retry')
    assert.equal(classifyError(new Error('other side closed')).kind, 'retry')
    assert.equal(classifyError(stalledError()).kind, 'retry')
  })

  test('erros de disco são fatais com mensagem clara', () => {
    const enospc = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' })
    const info = classifyError(enospc)
    assert.equal(info.kind, 'fatal')
    assert.equal(info.reason, 'ENOSPC')
    assert.match(info.message, /Disco cheio/)
    assert.equal(classifyError(Object.assign(new Error('x'), { code: 'EACCES', path: '/x' })).kind, 'fatal')
  })

  test('limite de taxa (userRateLimitExceeded/rateLimitExceeded/429) é retry', () => {
    const a = classifyError(http(403, googleBody(403, 'userRateLimitExceeded', 'User rate limit exceeded.')))
    assert.equal(a.kind, 'retry')
    assert.equal(a.reason, 'userRateLimitExceeded')
    assert.equal(a.status, 403)
    assert.equal(classifyError(http(403, googleBody(403, 'rateLimitExceeded'))).kind, 'retry')
    const c = classifyError(http(429, null, { 'retry-after': '7' }))
    assert.equal(c.kind, 'retry')
    assert.equal(c.retryAfterMs, 7000)
  })

  test('cotas: downloadQuotaExceeded/dailyLimitExceeded esperam bastante', () => {
    const q = classifyError(http(403, googleBody(403, 'downloadQuotaExceeded')))
    assert.equal(q.kind, 'quota')
    assert.equal(q.reason, 'downloadQuotaExceeded')
    assert.ok(q.retryAfterMs >= 15 * 60_000)
    assert.equal(classifyError(http(403, googleBody(403, 'dailyLimitExceeded'))).kind, 'quota')
    // Retry-After do servidor manda.
    const r = classifyError(http(403, googleBody(403, 'downloadQuotaExceeded'), { 'retry-after': '120' }))
    assert.equal(r.retryAfterMs, 120_000)
  })

  test('fatais: storageQuotaExceeded, accessNotConfigured, sem permissão', () => {
    const s = classifyError(http(403, googleBody(403, 'storageQuotaExceeded')))
    assert.equal(s.kind, 'fatal')
    assert.match(s.message, /sem espaço/)
    const a = classifyError(http(403, googleBody(403, 'accessNotConfigured')))
    assert.equal(a.kind, 'fatal')
    assert.match(a.message, /Drive API/)
    // Formato novo (status em vez de errors[].reason).
    const svc = classifyError(http(403, { error: { code: 403, message: 'disabled', status: 'SERVICE_DISABLED' } }))
    assert.equal(svc.kind, 'fatal')
    assert.match(svc.message, /Drive API/)
    assert.equal(classifyError(http(403, googleBody(403, 'insufficientFilePermissions'))).kind, 'fatal')
    assert.equal(classifyError(http(403, googleBody(403, 'cannotDownloadAbusiveFile'))).kind, 'fatal')
    assert.equal(classifyError(http(403, googleBody(403, 'algoNovo', 'Proibido'))).kind, 'fatal')
  })

  test('OAuth: invalid_grant pede reconexão; outros erros de cliente são fatais', () => {
    const g = classifyError(http(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }))
    assert.equal(g.kind, 'reauth')
    assert.equal(g.reason, 'invalid_grant')
    const c = classifyError(http(401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' }))
    assert.equal(c.kind, 'fatal')
    assert.equal(c.reason, 'invalid_client')
    assert.equal(classifyError(http(400, { error: 'admin_policy_enforced' })).kind, 'fatal')
  })

  test('status: 401 auth, 404/410 notfound, 5xx/408 retry, 400 fatal', () => {
    assert.equal(classifyError(http(401, googleBody(401, 'authError'))).kind, 'auth')
    assert.equal(classifyError(http(401)).kind, 'auth')
    assert.equal(classifyError(http(404, googleBody(404, 'notFound'))).kind, 'notfound')
    assert.equal(classifyError(http(410)).kind, 'notfound')
    for (const status of [500, 502, 503, 504]) {
      const info = classifyError(http(status, googleBody(status, 'backendError')))
      assert.equal(info.kind, 'retry', String(status))
      assert.equal(info.status, status)
    }
    assert.equal(classifyError(http(503, 'Service Unavailable', { 'retry-after': '3' })).retryAfterMs, 3000)
    assert.equal(classifyError(http(408)).kind, 'retry')
    assert.equal(classifyError(http(400, googleBody(400, 'badRequest'))).kind, 'fatal')
  })

  test('mensagem do HttpError não vaza upload_id', () => {
    const err = http(418)
    assert.ok(!err.message.includes('SEGREDO'))
    // Nem nas propriedades: console.error(err) / util.inspect mostra todas (ex.: log com SOBEDESCE_DEBUG).
    assert.ok(!err.url.includes('SEGREDO'))
    assert.ok(!util.inspect(err, { depth: 5 }).includes('SEGREDO'))
  })

  test('SobeDesceError já classificado passa direto', () => {
    const err = new SobeDesceError('quota', 'Limite de upload', { reason: 'uploadLimitExceeded', retryAfterMs: 1000 })
    assert.deepEqual(classifyError(err), { kind: 'quota', reason: 'uploadLimitExceeded', message: 'Limite de upload', retryAfterMs: 1000, status: null })
  })

  test('erro desconhecido é fatal com a mensagem original', () => {
    const info = classifyError(new Error('algo estranho'))
    assert.equal(info.kind, 'fatal')
    assert.equal(info.message, 'algo estranho')
    assert.equal(classifyError(undefined).kind, 'fatal')
  })
})

describe('config.js', () => {
  test('validateSettings limita faixas e arredonda', () => {
    const s = validateSettings({ maxConcurrentDownloads: 100, maxConcurrentUploads: 0, connectionsPerDownload: '6', stallTimeoutMs: 10 })
    assert.equal(s.maxConcurrentDownloads, 16)
    assert.equal(s.maxConcurrentUploads, 1)
    assert.equal(s.connectionsPerDownload, 6)
    assert.equal(s.stallTimeoutMs, 5000)
    assert.equal(validateSettings({ connectionsPerDownload: 7.6 }).connectionsPerDownload, 8)
    assert.equal(validateSettings({ bandwidthLimitDown: -5 }).bandwidthLimitDown, 0)
    assert.equal(validateSettings({ minSegmentSize: 1 }).minSegmentSize, 1 * MiB)
  })

  test('uploadChunkSize: 0 = contínuo; senão múltiplo de 256 KiB', () => {
    assert.equal(validateSettings({ uploadChunkSize: 0 }).uploadChunkSize, 0)
    assert.equal(validateSettings({ uploadChunkSize: 1 }).uploadChunkSize, 256 * KiB)
    assert.equal(validateSettings({ uploadChunkSize: 300 * KiB }).uploadChunkSize, 256 * KiB)
    assert.equal(validateSettings({ uploadChunkSize: 500 * KiB }).uploadChunkSize, 512 * KiB)
    assert.equal(validateSettings({ uploadChunkSize: 8 * MiB + 1 }).uploadChunkSize, 8 * MiB)
    assert.equal(validateSettings({ uploadChunkSize: 1e15 }).uploadChunkSize, 4096 * MiB)
    for (const v of [1, 777777, 5 * MiB + 3, 4096 * MiB - 1]) {
      const out = validateSettings({ uploadChunkSize: v }).uploadChunkSize
      assert.equal(out % (256 * KiB), 0, String(v))
      assert.ok(out > 0 && out <= 4096 * MiB)
    }
  })

  test('enums, booleanos, textos e chaves desconhecidas', () => {
    assert.equal(validateSettings({ downloadConflict: 'rename' }).downloadConflict, 'rename')
    assert.throws(() => validateSettings({ downloadConflict: 'replace' }), /Valor inválido/)
    assert.equal(validateSettings({ uploadConflict: 'replace' }).uploadConflict, 'replace')
    assert.throws(() => validateSettings({ uploadConflict: 'overwrite' }), /Valor inválido/)
    assert.throws(() => validateSettings({ theme: 'blue' }), /Valor inválido/)
    assert.equal(validateSettings({ theme: 'dark' }).theme, 'dark')
    assert.equal(validateSettings({ verifyChecksums: 0 }).verifyChecksums, false)
    assert.equal(validateSettings({ keepAwake: 1 }).keepAwake, true)
    assert.throws(() => validateSettings({ maxConcurrentDownloads: 'muitos' }), /Valor inválido/)
    assert.throws(() => validateSettings({ downloadDir: '   ' }), /Valor inválido/)
    assert.throws(() => validateSettings({ downloadDir: 42 }), /Valor inválido/)
    assert.equal(validateSettings({ downloadDir: ' /tmp/x/../y ' }).downloadDir, path.resolve('/tmp/y'))
    const s = validateSettings({ naoExiste: 1, __proto__: { x: 1 } })
    assert.ok(!('naoExiste' in s))
    assert.deepEqual(validateSettings(null), { ...DEFAULT_SETTINGS })
    // O patch parte da base informada.
    const base = validateSettings({ maxConcurrentUploads: 8 })
    assert.equal(validateSettings({ theme: 'light' }, base).maxConcurrentUploads, 8)
  })

  test('Settings: carrega, atualiza, emite change e persiste', async () => {
    const file = dataPaths().settings
    assert.ok(file.startsWith(home))
    const s = new Settings(file)
    assert.deepEqual(await s.load(), { ...DEFAULT_SETTINGS })
    const changes = []
    s.on('change', (next, keys) => changes.push(keys))
    await s.update({ maxConcurrentDownloads: 5, theme: 'dark' })
    await s.update({ theme: 'dark' }) // sem mudança: sem evento
    assert.deepEqual(changes, [['maxConcurrentDownloads', 'theme']])
    const again = new Settings(file)
    const loaded = await again.load()
    assert.equal(loaded.maxConcurrentDownloads, 5)
    assert.equal(loaded.theme, 'dark')
    await assert.rejects(s.update({ theme: 'roxo' }), /Valor inválido/)
    assert.equal(s.get().theme, 'dark')
    // Arquivo com valor inválido: volta aos padrões em vez de quebrar.
    await fs.writeFile(file, JSON.stringify({ theme: 'roxo' }))
    assert.deepEqual(await new Settings(file).load(), { ...DEFAULT_SETTINGS })
  })

  test('Settings: um valor estragado no arquivo não apaga os outros ajustes', async () => {
    const file = dataPaths().settings
    await fs.writeFile(file, JSON.stringify({ theme: 'roxo', downloadDir: '/Volumes/RAID/Baixados', maxConcurrentUploads: 7, mobileWebUrl: 'javascript:alert(1)' }))
    const loaded = await new Settings(file).load()
    assert.equal(loaded.theme, DEFAULT_SETTINGS.theme)
    assert.equal(loaded.mobileWebUrl, '')
    assert.equal(loaded.downloadDir, path.resolve('/Volumes/RAID/Baixados'))
    assert.equal(loaded.maxConcurrentUploads, 7)
  })
})

describe('util/backoff.js', () => {
  test('backoffDelay cresce e respeita o teto', () => {
    for (let i = 0; i < 50; i++) {
      const d0 = backoffDelay(0)
      assert.ok(d0 >= 500 && d0 <= 1000)
      const d3 = backoffDelay(3)
      assert.ok(d3 >= 4000 && d3 <= 8000)
      const big = backoffDelay(30)
      assert.ok(big >= 32_000 && big <= 64_000)
    }
  })

  test('sleep respeita abort', async () => {
    const ac = new AbortController()
    const t0 = Date.now()
    setTimeout(() => ac.abort(), 20)
    await assert.rejects(sleep(10_000, ac.signal), err => isAbortError(err))
    assert.ok(Date.now() - t0 < 2000)
    await assert.rejects(sleep(10, ac.signal), err => isAbortError(err))
  })
})
