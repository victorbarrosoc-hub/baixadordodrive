// UploadTask contra o Drive falso: fluxo contínuo e em pedaços, pausa/retomada a partir do JSON gravado,
// falhas de rede, sessão expirada, limite de 750 GB/dia, conflitos, pastas, travamento e limite de banda.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { truncateSync } from 'node:fs'
import path from 'node:path'
import { setupDrive, makeTmpDir, randomFile, waitFor } from './helpers.js'
import { UploadTask, chunkLength, committedFromRange, mimeFor, MAX_UPLOAD_SIZE } from '../src/engine/upload.js'
import { Hasher } from '../src/engine/hasher.js'
import { DriveClient } from '../src/google/drive.js'
import { DEFAULT_SETTINGS } from '../src/config.js'
import { BandwidthLimiter } from '../src/util/limiter.js'
import { isAbortError } from '../src/util/backoff.js'
import { classifyError } from '../src/google/errors.js'
import { closeHttp } from '../src/net/http.js'
import { joinRel } from '../src/util/paths.js'
import { FolderListings } from '../src/engine/folder-listings.js'

const KiB = 1024
const MiB = 1024 * KiB
const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e'

after(() => closeHttp())

/** Drive falso + conta conectada + Hasher + pasta local temporária. */
async function setup(t, mockOptions = {}) {
  const env = await setupDrive(mockOptions)
  const dir = await makeTmpDir('sobedesce-upload-')
  const hasher = new Hasher({ cacheFile: path.join(env.home, 'hash-cache.json'), log: () => {} })
  t.after(async () => {
    await hasher.close()
    await env.cleanup()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })
  })
  // Cliente rápido: os testes fazem muitas chamadas de metadados e algumas com falhas injetadas.
  const drive = new DriveClient(env.auth, env.accountId, { ratePerSec: 1000, retryBaseMs: 5 })
  return { ...env, drive, hasher, dir }
}

/** TaskContext de teste. `settings` é um objeto vivo (dá para mudar no meio). */
function makeCtx(env, { settings = {}, limiter, folderCache, folderListings, onBytes, onPersist } = {}) {
  const live = { ...DEFAULT_SETTINGS, ...settings }
  const ctx = {
    drive: env.drive,
    settings: { get: () => live },
    limiter: limiter ?? new BandwidthLimiter(0),
    hasher: env.hasher,
    folderCache: folderCache ?? new Map(),
    folderListings,
    persist: () => onPersist?.(),
    onBytes: n => {
      ctx.sent += n
      onBytes?.(n)
    },
    log: process.env.UPLOAD_DEBUG ? (...a) => console.error('[upload]', ...a) : () => {},
    retryBaseMs: 5,
    sent: 0,
    live,
  }
  return ctx
}

async function localFile(env, name, size, seed = 1) {
  const p = path.join(env.dir, name)
  const md5 = await randomFile(p, size, seed)
  const st = await fs.stat(p)
  return { path: p, size, md5, mtimeMs: st.mtimeMs }
}

function makeRecord(env, file, { name = path.basename(file.path), rootId = 'root', relDir = '', driveId = null, parentId = null } = {}) {
  const now = Date.now()
  return {
    id: `up-${Math.random().toString(36).slice(2)}`,
    type: 'upload',
    accountId: env.accountId,
    batchId: 'b1',
    status: 'running',
    name,
    relPath: joinRel(relDir, name),
    size: file.size,
    bytesDone: 0,
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    updatedAt: now,
    error: null,
    retryAt: null,
    attempts: 0,
    verify: null,
    note: null,
    local: { path: file.path, size: file.size, mtimeMs: file.mtimeMs },
    target: { rootId, relDir, parentId, driveId, replaceFileId: null, fileId: null },
    session: null,
  }
}

/** Arquivos (não pastas) com esse nome dentro da pasta. */
function filesNamed(mock, parentId, name) {
  const pid = parentId === 'root' ? mock.rootId : parentId
  return mock.listAll().filter(it => !it.isFolder && it.name === name && it.parents.includes(pid))
}

async function assertUploaded(env, record, file) {
  assert.ok(record.target.fileId, 'fileId preenchido')
  assert.equal(record.bytesDone, file.size)
  const item = env.mock.getItem(record.target.fileId)
  assert.ok(item, 'arquivo existe no Drive')
  assert.equal(item.size, file.size)
  assert.equal(await env.mock.contentMd5(record.target.fileId), file.md5, 'conteúdo no Drive = arquivo local')
  assert.equal(record.session, null, 'sessão some depois de terminar (a URI é credencial)')
  return item
}

test('funções auxiliares: pedaço alinhado, Range do 308 e tipo pelo nome', () => {
  assert.equal(chunkLength(0), 0)
  assert.equal(chunkLength(-5), 0)
  assert.equal(chunkLength(1), 256 * KiB)
  assert.equal(chunkLength(8 * MiB + 1000), 8 * MiB)
  assert.equal(chunkLength(700 * KiB), 512 * KiB)
  assert.equal(committedFromRange(undefined), 0)
  assert.equal(committedFromRange('bytes=0-0'), 1)
  assert.equal(committedFromRange('bytes=0-262143'), 262144)
  assert.equal(committedFromRange('bytes=5-10'), undefined)
  assert.equal(committedFromRange('lixo'), undefined)
  assert.equal(mimeFor('A001.MOV'), 'video/quicktime')
  assert.equal(mimeFor('som.wav'), 'audio/wav')
  assert.equal(mimeFor('projeto.prproj'), 'application/octet-stream')
  assert.equal(mimeFor('sem-extensao'), 'application/octet-stream')
  assert.equal(MAX_UPLOAD_SIZE, 5_497_558_138_880)
})

test('1. 300 MB contínuo: um PUT só, MD5 no Drive = local', async t => {
  const env = await setup(t)
  const file = await localFile(env, 'A001.mov', 300 * MiB, 11)
  const record = makeRecord(env, file)
  const persisted = []
  const ctx = makeCtx(env, { onPersist: () => persisted.push(JSON.parse(JSON.stringify(record))) })
  const task = new UploadTask(record, ctx)
  await task.run(new AbortController().signal)
  const item = await assertUploaded(env, record, file)
  assert.equal(item.name, 'A001.mov')
  assert.equal(item.mimeType, 'video/quicktime')
  assert.equal(item.modifiedTime, new Date(file.mtimeMs).toISOString(), 'modifiedTime do Drive = mtime local')
  const stats = env.mock.stats()
  assert.equal(stats.uploadPuts, 1, 'exatamente um PUT de dados')
  assert.equal(stats.statusQueries, 0)
  assert.equal(stats.uploadSessionsCreated, 1)
  assert.deepEqual(record.verify, { state: 'ok', expected: file.md5, actual: file.md5 })
  assert.equal(ctx.sent, file.size, 'onBytes contou cada byte uma vez')
  assert.equal(task.speed(), 0, 'parado = velocidade 0')
  // A sessão foi gravada assim que nasceu (antes de qualquer byte).
  const firstWithSession = persisted.find(p => p.session)
  assert.ok(firstWithSession, 'sessão persistida')
  assert.equal(firstWithSession.session.offset, 0)
  assert.match(firstWithSession.session.uri, /upload_id=/)
})

test('2. modo em pedaços de 8 MiB: todos alinhados, último = resto', async t => {
  const env = await setup(t)
  const size = 5 * 8 * MiB + 123_457
  const file = await localFile(env, 'clip.mxf', size, 12)
  const record = makeRecord(env, file)
  const offsets = []
  const ctx = makeCtx(env, {
    settings: { uploadChunkSize: 8 * MiB },
    onPersist: () => {
      const o = record.session?.offset
      if (o && o !== offsets.at(-1)) offsets.push(o)
    },
  })
  await new UploadTask(record, ctx).run(new AbortController().signal)
  await assertUploaded(env, record, file)
  const stats = env.mock.stats()
  assert.equal(stats.uploadPuts, 6, '5 pedaços cheios + o resto')
  assert.equal(stats.statusQueries, 0)
  // Toda confirmação intermediária é múltiplo do pedaço (o mock recusa pedaço desalinhado com 400).
  const intermediate = offsets.filter(o => o < size)
  assert.deepEqual(intermediate, [8, 16, 24, 32, 40].map(n => n * MiB))
})

test('3. pausa em ~50%, tarefa NOVA a partir do JSON gravado retoma pela consulta de status', async t => {
  const env = await setup(t, { perConnectionBps: 24 * MiB, uploadRetainGranularity: 8 * MiB })
  const size = 64 * MiB
  const file = await localFile(env, 'B002.mov', size, 13)
  const record = makeRecord(env, file)
  let saved = null
  const ac = new AbortController()
  const ctx = makeCtx(env, {
    onPersist: () => (saved = JSON.stringify(record)),
    onBytes: () => {
      if (ctx.sent >= size / 2 && !ac.signal.aborted) ac.abort()
    },
  })
  await assert.rejects(new UploadTask(record, ctx).run(ac.signal), err => isAbortError(err))
  assert.ok(saved, 'registro gravado')
  const json = JSON.parse(saved)
  assert.ok(json.session?.uri, 'sessão gravada para retomar')
  // O Google (mock) guarda só o que "assentou" (múltiplos de 8 MiB aqui).
  await waitFor(() => env.mock.listUploadSessions()[0]?.committed > 0, { timeoutMs: 5000 })
  await new Promise(resolve => setTimeout(resolve, 100))
  const retained = env.mock.listUploadSessions()[0].committed
  assert.equal(retained % (8 * MiB), 0)
  assert.ok(retained < size)

  env.mock.setOptions({ perConnectionBps: 0 })
  env.mock.resetStats()
  const record2 = JSON.parse(saved)
  const ctx2 = makeCtx(env, { onPersist: () => (saved = JSON.stringify(record2)) })
  await new UploadTask(record2, ctx2).run(new AbortController().signal)
  await assertUploaded(env, record2, file)
  const stats = env.mock.stats()
  assert.equal(stats.statusQueries, 1, 'retomou perguntando ao Google')
  assert.equal(stats.uploadSessionsCreated, 0, 'mesma sessão')
  assert.equal(stats.uploadPuts, 1)
  assert.ok(stats.bytesReceived <= size - retained + 256 * KiB, `reenviou só o que faltava (${stats.bytesReceived} > ${size - retained})`)
  assert.equal(ctx2.sent, size - retained)
  assert.equal(env.mock.listAll().filter(it => it.name === 'B002.mov').length, 1)
})

test('4. falhas: quedas 30%, 5xx 10%, 429 5% → arquivo correto', async t => {
  const env = await setup(t, {
    seed: 7,
    failures: { dropUploadProb: 0.3, error5xxProb: 0.1, error429Prob: 0.05 },
  })
  const file = await localFile(env, 'C003.mov', 48 * MiB + 777, 14)
  const record = makeRecord(env, file)
  const ctx = makeCtx(env)
  await new UploadTask(record, ctx).run(new AbortController().signal)
  await assertUploaded(env, record, file)
  const stats = env.mock.stats()
  const faults = stats.faults.uploadDrops + stats.faults.error5xx + stats.faults.error429
  assert.ok(faults >= 1, 'pelo menos uma falha aconteceu')
  assert.equal(env.mock.listAll().filter(it => it.name === 'C003.mov').length, 1, 'nenhum arquivo duplicado')
})

test('4b. falhas sem fim: desiste depois de 10 falhas seguidas sem avanço', async t => {
  const env = await setup(t)
  // Tamanho fora da granularidade: o 5xx depois do corpo guarda só parte, nunca fecha o arquivo.
  const file = await localFile(env, 'D004.mov', 2 * MiB + 1000, 15)
  const record = makeRecord(env, file)
  const ctx = makeCtx(env, {
    onPersist: () => {
      // Depois que a sessão existe, tudo dá 5xx (inclusive a consulta de status).
      if (record.session && !ctx.broken) {
        ctx.broken = true
        env.mock.setOptions({ failures: { error5xxProb: 1 } })
      }
    },
  })
  const err = await new UploadTask(record, ctx).run(new AbortController().signal).then(() => null, e => e)
  assert.ok(err, 'falhou')
  assert.equal(classifyError(err).kind, 'retry')
  assert.equal(err.name, 'SobeDesceError')
  assert.equal(record.attempts, 11)
  assert.match(err.message, /várias vezes/)
})

test('5. sessão expirada → sessão nova do zero; sessão perto de 1 semana nem é consultada', async t => {
  const env = await setup(t, { perConnectionBps: 16 * MiB })
  const size = 24 * MiB
  const file = await localFile(env, 'E005.mov', size, 16)
  const record = makeRecord(env, file)
  let saved = null
  const ac = new AbortController()
  const ctx = makeCtx(env, {
    onPersist: () => (saved = JSON.stringify(record)),
    onBytes: () => {
      if (ctx.sent >= size / 3 && !ac.signal.aborted) ac.abort()
    },
  })
  await assert.rejects(new UploadTask(record, ctx).run(ac.signal), err => isAbortError(err))
  env.mock.setOptions({ perConnectionBps: 0 })
  env.mock.expireUploadSessions() // "passou uma semana"
  env.mock.resetStats()
  const record2 = JSON.parse(saved)
  const ctx2 = makeCtx(env)
  await new UploadTask(record2, ctx2).run(new AbortController().signal)
  await assertUploaded(env, record2, file)
  assert.equal(ctx2.sent, size, 'mandou tudo de novo')
  let stats = env.mock.stats()
  assert.equal(stats.requests['upload.put'], 2, 'consulta (404) + um PUT de dados')
  assert.equal(stats.uploadPuts, 1)
  assert.equal(stats.uploadSessionsCreated, 1, 'abriu outra sessão')
  assert.match(record2.note, /sessão/i)

  // Sessão com 7 dias (gravada): vai direto para uma nova, sem consultar a velha.
  const file2 = await localFile(env, 'E006.mov', 3 * MiB, 17)
  const record3 = makeRecord(env, file2)
  record3.session = { uri: `${env.mock.url}/upload/drive/v3/files?uploadType=resumable&upload_id=velha`, createdAt: Date.now() - 7 * 24 * 3600_000, offset: 1 * MiB }
  env.mock.resetStats()
  await new UploadTask(record3, makeCtx(env)).run(new AbortController().signal)
  await assertUploaded(env, record3, file2)
  stats = env.mock.stats()
  assert.equal(stats.statusQueries, 0)
  assert.equal(stats.uploadSessionsCreated, 1)
})

test('6. limite diário: o arquivo que cruza termina; os outros recebem cota (uploadLimitExceeded)', async t => {
  const env = await setup(t, { uploadDailyLimitBytes: 16 * MiB })
  // B abre a sessão antes do limite e pausa logo em seguida.
  const fileB = await localFile(env, 'B.mov', 20 * MiB, 21) // > 8 MiB: o 403 chega com o corpo ainda saindo
  const recordB = makeRecord(env, fileB)
  const acB = new AbortController()
  let savedB = null
  const ctxB = makeCtx(env, {
    onPersist: () => {
      savedB = JSON.stringify(recordB)
      if (recordB.session) acB.abort()
    },
  })
  await assert.rejects(new UploadTask(recordB, ctxB).run(acB.signal), err => isAbortError(err))
  assert.ok(JSON.parse(savedB).session)

  // A cruza o limite (24 MiB > 16 MiB) e termina mesmo assim.
  const fileA = await localFile(env, 'A.mov', 24 * MiB, 22)
  const recordA = makeRecord(env, fileA)
  await new UploadTask(recordA, makeCtx(env)).run(new AbortController().signal)
  await assertUploaded(env, recordA, fileA)

  // B retoma: consulta funciona, mas o PUT de dados leva 403 userRateLimitExceeded → 5 vezes → cota.
  const recordB2 = JSON.parse(savedB)
  const errB = await new UploadTask(recordB2, makeCtx(env)).run(new AbortController().signal).then(() => null, e => e)
  assert.ok(errB, 'B falhou')
  assert.equal(errB.kind, 'quota')
  assert.equal(errB.reason, 'uploadLimitExceeded')
  assert.equal(errB.retryAfterMs, 60 * 60_000)
  assert.match(errB.message, /750 GB/)
  assert.ok(recordB2.session, 'B continua com a sessão para retomar depois')

  // C nem consegue abrir sessão: 3 recusas seguidas → cota.
  const fileC = await localFile(env, 'C.mov', 1 * MiB, 23)
  const recordC = makeRecord(env, fileC)
  env.mock.resetStats()
  const errC = await new UploadTask(recordC, makeCtx(env)).run(new AbortController().signal).then(() => null, e => e)
  assert.equal(errC?.kind, 'quota')
  assert.equal(errC.reason, 'uploadLimitExceeded')
  assert.equal(classifyError(errC).kind, 'quota')
  assert.equal(env.mock.stats().requests['upload.create'], 3)

  // Passadas 24 h, B termina a partir da mesma sessão.
  env.mock.resetDailyUsage()
  await new UploadTask(recordB2, makeCtx(env)).run(new AbortController().signal)
  await assertUploaded(env, recordB2, fileB)
})

test('7. conflitos: skip (igual), replace (mesmo id, conteúdo novo), rename e skip com conteúdo diferente', async t => {
  const env = await setup(t)
  const folder = env.mock.addFolder('Entrega')
  const size = 3 * MiB + 5

  // skip: mesmo conteúdo já no Drive.
  const same = await localFile(env, 'a.mov', size, 31)
  const existingA = env.mock.addFile('a.mov', folder.id, { size, seed: 31 })
  const recA = makeRecord(env, same, { rootId: folder.id })
  await new UploadTask(recA, makeCtx(env, { settings: { uploadConflict: 'skip' } })).run(new AbortController().signal)
  assert.equal(recA.status, 'skipped')
  assert.equal(recA.note, 'Já estava no Drive')
  assert.equal(recA.target.fileId, existingA.id)
  assert.equal(env.mock.stats().uploadSessionsCreated, 0)

  // replace: arquivo diferente com o mesmo nome → nova versão do MESMO arquivo.
  const fileB = await localFile(env, 'b.mov', size + 100, 32)
  const existingB = env.mock.addFile('b.mov', folder.id, { size, seed: 99 })
  const recB = makeRecord(env, fileB, { rootId: folder.id })
  await new UploadTask(recB, makeCtx(env, { settings: { uploadConflict: 'replace' } })).run(new AbortController().signal)
  await assertUploaded(env, recB, fileB)
  assert.equal(recB.target.fileId, existingB.id, 'mesmo id')
  assert.notEqual(env.mock.getItem(existingB.id).headRevisionId, existingB.headRevisionId, 'nova revisão')
  assert.equal(filesNamed(env.mock, folder.id, 'b.mov').length, 1)

  // rename: sobe como "a (2).mov".
  const fileA2 = await localFile(env, 'outro/a.mov', size, 33)
  const recA2 = makeRecord(env, fileA2, { rootId: folder.id, name: 'a.mov' })
  await new UploadTask(recA2, makeCtx(env, { settings: { uploadConflict: 'rename' } })).run(new AbortController().signal)
  await assertUploaded(env, recA2, fileA2)
  assert.equal(recA2.name, 'a (2).mov')
  assert.equal(env.mock.getItem(recA2.target.fileId).name, 'a (2).mov')
  assert.match(recA2.note, /a \(2\)\.mov/)
  assert.equal(filesNamed(env.mock, folder.id, 'a.mov').length, 1, 'o original continua lá')

  // skip com mesmo nome e tamanho mas MD5 diferente: não pula, mantém os dois com nome novo.
  const fileA3 = await localFile(env, 'mais/a.mov', size, 34)
  const recA3 = makeRecord(env, fileA3, { rootId: folder.id, name: 'a.mov' })
  await new UploadTask(recA3, makeCtx(env, { settings: { uploadConflict: 'skip' } })).run(new AbortController().signal)
  await assertUploaded(env, recA3, fileA3)
  assert.equal(recA3.name, 'a (3).mov')
  assert.notEqual(recA3.status, 'skipped')

  // skip sem md5 remoto e mesmo tamanho: pula.
  const fileC = await localFile(env, 'c.wav', 1 * MiB, 35)
  env.mock.addFile('c.wav', folder.id, { size: 1 * MiB, seed: 777, md5: null })
  const recC = makeRecord(env, fileC, { rootId: folder.id })
  await new UploadTask(recC, makeCtx(env)).run(new AbortController().signal)
  assert.equal(recC.status, 'skipped')
})

test('8. pastas aninhadas e 20 envios simultâneos na mesma pasta nova (pasta criada uma vez)', async t => {
  const env = await setup(t)
  const base = env.mock.addFolder('Projeto')

  const deep = await localFile(env, 'take.mov', 512 * KiB, 41)
  const recDeep = makeRecord(env, deep, { rootId: base.id, relDir: 'Cenas/Dia 1/Câmera A' })
  await new UploadTask(recDeep, makeCtx(env)).run(new AbortController().signal)
  await assertUploaded(env, recDeep, deep)
  const names = []
  for (let id = env.mock.getItem(recDeep.target.fileId).parents[0]; id && id !== base.id; ) {
    const it = env.mock.getItem(id)
    names.unshift(it.name)
    id = it.parents[0]
  }
  assert.deepEqual(names, ['Cenas', 'Dia 1', 'Câmera A'])

  env.mock.resetStats()
  const folderCache = new Map()
  const files = await Promise.all(Array.from({ length: 20 }, (_, i) => localFile(env, `lote/f${i}.wav`, 64 * KiB + i, 100 + i)))
  const records = files.map(f => makeRecord(env, f, { rootId: base.id, relDir: 'Novo/Sub' }))
  await Promise.all(records.map(rec => new UploadTask(rec, makeCtx(env, { folderCache })).run(new AbortController().signal)))
  for (let i = 0; i < records.length; i++) await assertUploaded(env, records[i], files[i])
  const folders = env.mock.listAll().filter(it => it.isFolder)
  assert.equal(folders.filter(f => f.name === 'Novo').length, 1)
  assert.equal(folders.filter(f => f.name === 'Sub').length, 1)
  assert.equal(env.mock.stats().requests['files.create'], 2, 'uma criação por nível')
  assert.equal(new Set(records.map(r => r.target.parentId)).size, 1)

  // Drive compartilhado.
  const shared = env.mock.addSharedDrive('Equipe')
  const sf = await localFile(env, 'shared.mov', 300 * KiB, 50)
  const recShared = makeRecord(env, sf, { rootId: shared.id, driveId: shared.id, relDir: 'Entregas' })
  await new UploadTask(recShared, makeCtx(env)).run(new AbortController().signal)
  await assertUploaded(env, recShared, sf)
  assert.equal(env.mock.getItem(recShared.target.fileId).driveId, shared.id)
})

test('9a. arquivo vazio', async t => {
  const env = await setup(t)
  const p = path.join(env.dir, 'vazio.txt')
  await fs.writeFile(p, '')
  const st = await fs.stat(p)
  const file = { path: p, size: 0, md5: EMPTY_MD5, mtimeMs: st.mtimeMs }
  const record = makeRecord(env, file)
  await new UploadTask(record, makeCtx(env)).run(new AbortController().signal)
  await assertUploaded(env, record, file)
  assert.equal(env.mock.stats().uploadPuts, 0, 'sem PUT de dados (só "bytes */0")')
  assert.equal(record.verify.state, 'ok')
})

test('9b. arquivo local mudou entre a pausa e a retomada → recomeça do zero', async t => {
  const env = await setup(t, { perConnectionBps: 16 * MiB })
  const size = 24 * MiB
  const file = await localFile(env, 'F007.mov', size, 51)
  const record = makeRecord(env, file)
  let saved = null
  const ac = new AbortController()
  const ctx = makeCtx(env, {
    onPersist: () => (saved = JSON.stringify(record)),
    onBytes: () => {
      if (ctx.sent >= size / 2 && !ac.signal.aborted) ac.abort()
    },
  })
  await assert.rejects(new UploadTask(record, ctx).run(ac.signal), err => isAbortError(err))
  env.mock.setOptions({ perConnectionBps: 0 })
  // Regravado com outro conteúdo (mesmo tamanho) e outra data.
  const md5 = await randomFile(file.path, size, 52)
  const later = new Date(file.mtimeMs + 5000)
  await fs.utimes(file.path, later, later)
  env.mock.resetStats()
  const record2 = JSON.parse(saved)
  await new UploadTask(record2, makeCtx(env)).run(new AbortController().signal)
  await assertUploaded(env, record2, { ...file, md5 })
  assert.equal(record2.local.mtimeMs, (await fs.stat(file.path)).mtimeMs)
  const stats = env.mock.stats()
  assert.equal(stats.uploadSessionsCreated, 1, 'sessão nova')
  assert.equal(stats.statusQueries, 0, 'a sessão velha foi descartada sem consulta')
  assert.match(record2.note, /mudou/)
})

test('9c. 401 no meio do envio → renova o token e continua', async t => {
  const env = await setup(t)
  const file = await localFile(env, 'G008.mov', 12 * MiB, 53)
  const record = makeRecord(env, file)
  let expired = false
  const ctx = makeCtx(env, {
    settings: { uploadChunkSize: 4 * MiB },
    onPersist: () => {
      if (!expired && record.session?.offset >= 4 * MiB) {
        expired = true
        env.mock.expireAccessTokens()
      }
    },
  })
  const before = env.mock.stats().requests['oauth.token'] || 0
  await new UploadTask(record, ctx).run(new AbortController().signal)
  await assertUploaded(env, record, file)
  assert.ok(expired)
  assert.equal((env.mock.stats().requests['oauth.token'] || 0) - before, 1, 'uma renovação')
})

test('9d. arquivo local sumiu → fatal com o caminho; > 5 TB → fatal antes de qualquer requisição', async t => {
  const env = await setup(t)
  const p = path.join(env.dir, 'sumiu.mov')
  const record = makeRecord(env, { path: p, size: 10, mtimeMs: Date.now() })
  env.mock.resetStats()
  const err = await new UploadTask(record, makeCtx(env)).run(new AbortController().signal).then(() => null, e => e)
  assert.equal(err?.message, `O arquivo local não existe mais: ${p}`)
  assert.equal(classifyError(err).kind, 'fatal')
  assert.deepEqual(env.mock.stats().requests, {})

  const big = path.join(env.dir, 'enorme.mov')
  const fh = await fs.open(big, 'w')
  try {
    await fh.truncate(MAX_UPLOAD_SIZE + 1) // esparso: não ocupa disco
  } catch (e) {
    await fh.close()
    t.diagnostic(`sem arquivo esparso de 5 TB aqui (${e.code}); pulando essa parte`)
    return
  }
  await fh.close()
  const st = await fs.stat(big)
  const recBig = makeRecord(env, { path: big, size: st.size, mtimeMs: st.mtimeMs })
  const errBig = await new UploadTask(recBig, makeCtx(env)).run(new AbortController().signal).then(() => null, e => e)
  await fs.rm(big, { force: true })
  assert.equal(errBig?.kind, 'fatal')
  assert.equal(errBig.reason, 'fileSizeLimitExceeded')
  assert.match(errBig.message, /5 TB/)
  assert.deepEqual(env.mock.stats().requests, {}, 'nenhuma requisição')
})

test('10. conexão travada → detector aborta e o envio se recupera', async t => {
  const env = await setup(t, { seed: 3, failures: { stallUploadProb: 1 } })
  const file = await localFile(env, 'H009.mov', 32 * MiB, 61)
  const record = makeRecord(env, file)
  const ctx = makeCtx(env, { settings: { stallTimeoutMs: 800 } })
  // Só o primeiro PUT trava: assim que o mock sorteia o travamento, desliga as falhas.
  const watcher = waitFor(() => env.mock.stats().faults.uploadStalls >= 1, { timeoutMs: 20_000 }).then(() => env.mock.setOptions({ failures: {} }))
  const t0 = Date.now()
  await new UploadTask(record, ctx).run(new AbortController().signal)
  await watcher
  await assertUploaded(env, record, file)
  const stats = env.mock.stats()
  assert.equal(stats.faults.uploadStalls, 1)
  assert.ok(stats.statusQueries >= 1, 'perguntou ao Google onde parou')
  assert.ok(Date.now() - t0 < 30_000)
})

test('11. Drive cheio (storageQuotaExceeded) → fatal com mensagem em português', async t => {
  const env = await setup(t, { storageLimitBytes: 1 * MiB })
  const file = await localFile(env, 'I010.mov', 2 * MiB, 71)
  const record = makeRecord(env, file)
  const err = await new UploadTask(record, makeCtx(env)).run(new AbortController().signal).then(() => null, e => e)
  assert.ok(err)
  assert.equal(err.kind, 'fatal')
  assert.equal(err.reason, 'storageQuotaExceeded')
  assert.equal(err.message, 'Seu Google Drive está sem espaço.')
  assert.equal(classifyError(err).message, 'Seu Google Drive está sem espaço.')
  assert.equal(env.mock.stats().requests['upload.create'], 1, 'não insiste em erro fatal')
})

test('12. limite de banda de 8 MB/s respeitado (±30%)', async t => {
  const env = await setup(t)
  const size = 32_000_000
  const file = await localFile(env, 'J011.mov', size, 81)
  const record = makeRecord(env, file)
  const rate = 8_000_000
  const ctx = makeCtx(env, { limiter: new BandwidthLimiter(rate), settings: { verifyChecksums: false } })
  let first = 0
  const task = new UploadTask(record, ctx)
  let sampled = 0
  const origOnBytes = ctx.onBytes
  ctx.onBytes = n => {
    if (!first) first = Date.now()
    origOnBytes(n)
    if (!sampled && ctx.sent > size / 2) sampled = task.speed()
  }
  await task.run(new AbortController().signal)
  const elapsed = (Date.now() - first) / 1000
  await assertUploaded(env, record, { ...file })
  const measured = size / elapsed
  assert.ok(measured >= rate * 0.7 && measured <= rate * 1.3, `velocidade ${(measured / 1e6).toFixed(2)} MB/s fora de 8 ±30%`)
  assert.ok(sampled > rate * 0.5 && sampled < rate * 1.6, `speed() no meio: ${(sampled / 1e6).toFixed(2)} MB/s`)
})

test('13. MD5 diferente → falha com verify mismatch; tentar de novo troca o conteúdo do MESMO arquivo', async t => {
  const env = await setup(t)
  const file = await localFile(env, 'K012.mov', 2 * MiB + 3, 91)
  const record = makeRecord(env, file)
  // Calculadora "mentirosa": simula o arquivo ter chegado diferente.
  const liar = { hash: async () => '0'.repeat(32) }
  const ctx = makeCtx(env)
  ctx.hasher = liar
  const err = await new UploadTask(record, ctx).run(new AbortController().signal).then(() => null, e => e)
  assert.equal(err?.kind, 'fatal')
  assert.equal(err.reason, 'checksumMismatch')
  assert.equal(record.verify.state, 'mismatch')
  assert.equal(record.verify.expected, '0'.repeat(32))
  assert.equal(record.verify.actual, file.md5)
  assert.equal(record.session, null)
  const badId = record.target.replaceFileId
  assert.ok(badId, 'próxima tentativa substitui o arquivo que ficou no Drive')
  assert.ok(env.mock.getItem(badId), 'o arquivo ficou no Drive')

  await new UploadTask(record, makeCtx(env)).run(new AbortController().signal)
  await assertUploaded(env, record, file)
  assert.equal(record.target.fileId, badId, 'mesmo arquivo, nova versão')
  assert.equal(record.verify.state, 'ok')
  assert.equal(env.mock.listAll().filter(it => it.name === 'K012.mov').length, 1, 'sem duplicata')
})

test('14. pausa durante a conferência → retomada pergunta ao Google (já terminou) e confere', async t => {
  const env = await setup(t)
  const file = await localFile(env, 'L013.mov', 3 * MiB, 92)
  const record = makeRecord(env, file)
  let saved = null
  const ac = new AbortController()
  // Calculadora que só termina quando cancelada: a pausa chega durante 'verifying'.
  const slow = {
    hash: (_p, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('parou'), { name: 'AbortError' })), { once: true })
      }),
  }
  const ctx = makeCtx(env, { onPersist: () => (saved = JSON.stringify(record)) })
  ctx.hasher = slow
  const p = new UploadTask(record, ctx).run(ac.signal)
  await waitFor(() => record.status === 'verifying', { timeoutMs: 10_000 })
  ac.abort()
  await assert.rejects(p, err => isAbortError(err))
  const json = JSON.parse(saved)
  assert.ok(json.session, 'sessão (já completa) fica guardada')
  assert.equal(env.mock.listAll().filter(it => it.name === 'L013.mov').length, 1)

  env.mock.resetStats()
  const record2 = JSON.parse(saved)
  await new UploadTask(record2, makeCtx(env)).run(new AbortController().signal)
  await assertUploaded(env, record2, file)
  const stats = env.mock.stats()
  assert.equal(stats.statusQueries, 1)
  assert.equal(stats.uploadPuts, 0, 'nada reenviado')
  assert.equal(stats.uploadSessionsCreated, 0)
  assert.equal(record2.verify.state, 'ok')
  assert.equal(env.mock.listAll().filter(it => it.name === 'L013.mov').length, 1, 'sem duplicata')
})

test('15. arquivo encolheu durante o envio → fatal; a próxima tentativa recomeça com o arquivo novo', async t => {
  const env = await setup(t, { perConnectionBps: 8 * MiB })
  const size = 16 * MiB
  const file = await localFile(env, 'M014.mov', size, 93)
  const record = makeRecord(env, file)
  let cut = false
  const ctx = makeCtx(env, {
    onBytes: () => {
      if (!cut && ctx.sent >= 2 * MiB) {
        cut = true
        // Síncrono: acontece antes da próxima leitura do stream.
        truncateSync(file.path, 4 * MiB)
      }
    },
  })
  const err = await new UploadTask(record, ctx).run(new AbortController().signal).then(() => null, e => e)
  assert.equal(err?.kind, 'fatal')
  assert.equal(err.reason, 'localChanged')
  assert.match(err.message, /mudou enquanto era enviado/)
  assert.equal(env.mock.listAll().filter(it => it.name === 'M014.mov').length, 0, 'nada pela metade no Drive')

  env.mock.setOptions({ perConnectionBps: 0 })
  const md5 = await randomFile(file.path, 4 * MiB, 93)
  await new UploadTask(record, makeCtx(env)).run(new AbortController().signal)
  await assertUploaded(env, record, { ...file, size: 4 * MiB, md5 })
  assert.equal(record.size, 4 * MiB)
})

test('16. pasta de destino apagada (id velho) → procura/cria de novo; alvo do replace apagado → sobe como novo', async t => {
  const env = await setup(t)
  const base = env.mock.addFolder('Base')
  const old = env.mock.addFolder('Destino', base.id)
  env.mock.deleteItem(old.id)
  const file = await localFile(env, 'N015.mov', 1 * MiB, 94)
  const record = makeRecord(env, file, { rootId: base.id, relDir: 'Destino', parentId: old.id })
  await new UploadTask(record, makeCtx(env)).run(new AbortController().signal)
  await assertUploaded(env, record, file)
  assert.notEqual(record.target.parentId, old.id)
  assert.equal(env.mock.getItem(record.target.parentId).name, 'Destino')

  // Raiz do destino apagada: não tem como recriar → notfound em português.
  const gone = env.mock.addFolder('Some')
  env.mock.deleteItem(gone.id)
  const recGone = makeRecord(env, file, { rootId: gone.id, name: 'outro.mov' })
  const err = await new UploadTask(recGone, makeCtx(env)).run(new AbortController().signal).then(() => null, e => e)
  assert.equal(err?.kind, 'notfound')
  assert.equal(err.message, 'A pasta de destino não existe mais no Drive.')

  // replace cujo alvo sumiu antes de abrir a sessão.
  const target = env.mock.addFile('P016.mov', base.id, { size: 10, seed: 5 })
  const file2 = await localFile(env, 'P016.mov', 512 * KiB, 95)
  const rec2 = makeRecord(env, file2, { rootId: base.id })
  rec2.target.replaceFileId = target.id
  env.mock.deleteItem(target.id)
  await new UploadTask(rec2, makeCtx(env)).run(new AbortController().signal)
  await assertUploaded(env, rec2, file2)
  assert.notEqual(rec2.target.fileId, target.id)
  assert.match(rec2.note, /não existe mais/)
})

test('17. pausa antes de começar e run() em dobro', async t => {
  const env = await setup(t)
  const file = await localFile(env, 'Q017.mov', 256 * KiB, 96)
  const record = makeRecord(env, file)
  const ac = new AbortController()
  ac.abort()
  env.mock.resetStats()
  await assert.rejects(new UploadTask(record, makeCtx(env)).run(ac.signal), err => isAbortError(err))
  assert.deepEqual(env.mock.stats().requests, {}, 'nenhuma requisição')
  const task = new UploadTask(record, makeCtx(env))
  const p = task.run(new AbortController().signal)
  await assert.rejects(task.run(new AbortController().signal), /já está em andamento/)
  await p
  await assertUploaded(env, record, file)
})

// ─────────── listagem por pasta em vez de findChild por arquivo (FolderListings) ───────────

const lists = env => env.mock.stats().requests['files.list'] || 0

test('18. sem findChild por arquivo: pasta que já existe é listada UMA vez; pasta criada pelo app nem é listada', async t => {
  const env = await setup(t)
  const folder = env.mock.addFolder('Cartão A')
  env.mock.addFile('antigo.mov', folder.id, { size: 1000, seed: 1 })
  const listings = new FolderListings()
  const folderCache = new Map()
  const files = await Promise.all(Array.from({ length: 12 }, (_, i) => localFile(env, `cartao/c${i}.wav`, 64 * KiB + i, 200 + i)))
  env.mock.resetStats()
  const recs = files.map(f => makeRecord(env, f, { rootId: folder.id }))
  await Promise.all(recs.map(rec => new UploadTask(rec, makeCtx(env, { folderCache, folderListings: listings })).run(new AbortController().signal)))
  for (let i = 0; i < recs.length; i++) await assertUploaded(env, recs[i], files[i])
  assert.equal(lists(env), 1, '12 envios juntos para uma pasta que já existe: uma listagem só')
  assert.equal(listings.counters.listings, 1)

  // Pasta nova (dois níveis): só as buscas da própria criação das pastas; nenhuma por arquivo.
  env.mock.resetStats()
  const more = await Promise.all(Array.from({ length: 20 }, (_, i) => localFile(env, `novo/n${i}.wav`, 32 * KiB + i, 300 + i)))
  const recs2 = more.map(f => makeRecord(env, f, { rootId: folder.id, relDir: 'Dia 2/Som' }))
  await Promise.all(recs2.map(rec => new UploadTask(rec, makeCtx(env, { folderCache, folderListings: listings })).run(new AbortController().signal)))
  for (let i = 0; i < recs2.length; i++) await assertUploaded(env, recs2[i], more[i])
  assert.equal(env.mock.stats().requests['files.create'], 2, 'uma criação por nível')
  assert.equal(lists(env), 2, 'só os 2 findChild de "a pasta já existe?"; antes eram + 20')
  assert.equal(listings.counters.seeded, 2)

  // Sem a listagem (como antes): uma busca por arquivo.
  env.mock.resetStats()
  const solo = await Promise.all(Array.from({ length: 5 }, (_, i) => localFile(env, `solo/s${i}.wav`, 16 * KiB + i, 400 + i)))
  await Promise.all(solo.map(f => new UploadTask(makeRecord(env, f, { rootId: folder.id }), makeCtx(env, { folderCache })).run(new AbortController().signal)))
  assert.equal(lists(env), 5)
})

test('19. conflitos com a listagem: exatamente o mesmo resultado que sem ela (pular, substituir, renomear, manter os dois)', async t => {
  const env = await setup(t)
  const size = 2 * MiB + 7
  const local = {
    a: await localFile(env, 'l/a.mov', size, 31),
    b: await localFile(env, 'l/b.mov', size + 100, 32),
    aOutro: await localFile(env, 'l/outro/a.mov', size, 33),
    aMais: await localFile(env, 'l/mais/a.mov', size, 34),
    c: await localFile(env, 'l/c.wav', 1 * MiB, 35),
    d: await localFile(env, 'l/d.mov', size, 36),
    novo: await localFile(env, 'l/novo.mov', 300 * KiB, 37),
    novoIgual: await localFile(env, 'l/igual/novo.mov', 300 * KiB, 37),
    novoOutro: await localFile(env, 'l/outro/novo.mov', 300 * KiB, 38),
    x: await localFile(env, 'l/x.mov', 100 * KiB, 39),
    xOutro: await localFile(env, 'l/outro/x.mov', 100 * KiB, 40),
    atalho: await localFile(env, 'l/atalho.mov', size, 31),
    doc: await localFile(env, 'l/Roteiro', 10 * KiB, 41),
  }

  async function scenario(withListings) {
    const folder = env.mock.addFolder(withListings ? 'Com listagem' : 'Sem listagem')
    const pre = {
      a: env.mock.addFile('a.mov', folder.id, { size, seed: 31 }),
      b: env.mock.addFile('b.mov', folder.id, { size, seed: 99 }),
      c: env.mock.addFile('c.wav', folder.id, { size: 1 * MiB, seed: 777, md5: null }),
      d: env.mock.addFile('d.mov', folder.id, { size: size + 1, seed: 98 }),
    }
    pre.atalho = env.mock.addShortcut('atalho.mov', folder.id, pre.a.id)
    pre.doc = env.mock.addGoogleDoc('Roteiro', folder.id)
    const listings = withListings ? new FolderListings() : undefined
    const folderCache = new Map()
    const steps = [
      ['a', 'skip', {}],
      ['b', 'replace', {}],
      ['aOutro', 'rename', { name: 'a.mov' }],
      ['aMais', 'skip', { name: 'a.mov' }],
      ['c', 'skip', {}],
      ['d', 'skip', {}],
      ['novo', 'skip', {}],
      ['novoIgual', 'skip', { name: 'novo.mov' }],
      ['novoOutro', 'skip', { name: 'novo.mov' }],
      ['x', 'rename', { relDir: 'Sub' }],
      ['xOutro', 'rename', { relDir: 'Sub', name: 'x.mov' }],
      ['x', 'skip', { relDir: 'Sub' }],
      ['atalho', 'skip', {}],
      ['doc', 'replace', {}],
    ]
    const out = []
    const before = lists(env)
    for (const [key, mode, opts] of steps) {
      const rec = makeRecord(env, local[key], { rootId: folder.id, ...opts })
      await new UploadTask(rec, makeCtx(env, { settings: { uploadConflict: mode }, folderCache, folderListings: listings })).run(new AbortController().signal)
      const preKey = Object.keys(pre).find(k => pre[k]?.id === rec.target.fileId) ?? null
      out.push({ key, mode, status: rec.status, name: rec.name, note: rec.note, sameAs: preKey, md5: rec.status === 'skipped' ? null : await env.mock.contentMd5(rec.target.fileId) })
    }
    const sub = env.mock.listAll().find(it => it.isFolder && it.name === 'Sub' && it.parents.includes(folder.id))
    const names = id => env.mock.listAll().filter(it => !it.isFolder && it.parents.includes(id)).map(it => it.name).sort()
    return { out, names: names(folder.id), subNames: names(sub.id), lists: lists(env) - before, listings }
  }

  const sem = await scenario(false)
  const com = await scenario(true)
  assert.deepEqual(com.out, sem.out, 'cada envio terminou igual com e sem a listagem')
  assert.deepEqual(com.names, sem.names)
  assert.deepEqual(com.subNames, sem.subNames)
  const by = Object.fromEntries(com.out.map((o, i) => [`${i}:${o.key}`, o]))
  assert.equal(by['0:a'].status, 'skipped')
  assert.equal(by['0:a'].sameAs, 'a')
  assert.equal(by['1:b'].sameAs, 'b', 'replace: mesmo arquivo, nova versão')
  assert.equal(by['2:aOutro'].name, 'a (2).mov')
  assert.equal(by['3:aMais'].name, 'a (3).mov')
  assert.equal(by['4:c'].status, 'skipped')
  assert.equal(by['5:d'].name, 'd (2).mov', 'mesmo nome, tamanho diferente: mantém os dois')
  assert.equal(by['6:novo'].name, 'novo.mov')
  assert.equal(by['7:novoIgual'].status, 'skipped', 'o arquivo que o próprio app acabou de criar é enxergado')
  assert.equal(by['8:novoOutro'].name, 'novo (2).mov')
  assert.equal(by['10:xOutro'].name, 'x (2).mov', 'pasta criada pelo app: o primeiro x.mov é enxergado sem listar')
  assert.equal(by['11:x'].status, 'skipped')
  assert.deepEqual(com.subNames, ['x (2).mov', 'x.mov'])
  assert.equal(by['12:atalho'].name, 'atalho (2).mov', 'atalho com o mesmo nome não é "o mesmo arquivo"')
  assert.equal(by['13:doc'].name, 'Roteiro (2)', 'Doc do Google não é substituído')
  assert.ok(com.lists < sem.lists, `menos files.list com a listagem (${com.lists} × ${sem.lists})`)
  assert.equal(com.listings.counters.listings, 1, 'a pasta que já existia foi listada uma vez; a Sub (criada pelo app) nenhuma')
})

test('20. listagem: vale 10 min, pasta enorme cai na busca de sempre, pasta apagada é esquecida, drive compartilhado', async t => {
  const env = await setup(t)
  let clock = 1_000_000
  const listings = new FolderListings({ now: () => clock })
  const folder = env.mock.addFolder('Validade')
  const first = await localFile(env, 'v/primeiro.mov', 50 * KiB, 51)
  await new UploadTask(makeRecord(env, first, { rootId: folder.id }), makeCtx(env, { folderListings: listings })).run(new AbortController().signal)
  assert.equal(listings.counters.listings, 1)

  // Alguém sobe o mesmo arquivo por fora. Passados 10 min, a listagem é refeita e o envio enxerga (pula).
  const fora = await localFile(env, 'v/fora.mov', 70 * KiB, 52)
  env.mock.addFile('fora.mov', folder.id, { size: 70 * KiB, seed: 52 })
  clock += 10 * 60_000 + 1
  const rec = makeRecord(env, fora, { rootId: folder.id })
  await new UploadTask(rec, makeCtx(env, { folderListings: listings })).run(new AbortController().signal)
  assert.equal(listings.counters.listings, 2)
  assert.equal(rec.status, 'skipped')
  assert.equal(rec.note, 'Já estava no Drive')

  // Pasta com mais itens que o teto: "não sei" → busca por arquivo, como antes, com o mesmo resultado.
  const big = env.mock.addFolder('Enorme')
  for (let i = 0; i < 6; i++) env.mock.addFile(`ja${i}.wav`, big.id, { size: 10 * KiB, seed: 60 + i })
  const small = new FolderListings({ maxItems: 4 })
  env.mock.resetStats()
  const same = await localFile(env, 'e/ja3.wav', 10 * KiB, 63)
  const fresh = await localFile(env, 'e/novo.wav', 10 * KiB, 70)
  const recSame = makeRecord(env, same, { rootId: big.id })
  const recFresh = makeRecord(env, fresh, { rootId: big.id })
  await new UploadTask(recSame, makeCtx(env, { folderListings: small })).run(new AbortController().signal)
  await new UploadTask(recFresh, makeCtx(env, { folderListings: small })).run(new AbortController().signal)
  assert.equal(recSame.status, 'skipped')
  await assertUploaded(env, recFresh, fresh)
  assert.equal(lists(env), 3, 'uma listagem (cortada) + um findChild por arquivo')

  // Pasta do cache apagada no Drive: procura/cria de novo e a listagem velha é esquecida.
  const base = env.mock.addFolder('Base')
  const folderCache = new Map()
  const gone = await localFile(env, 'g/um.mov', 40 * KiB, 80)
  const r1 = makeRecord(env, gone, { rootId: base.id, relDir: 'Destino' })
  await new UploadTask(r1, makeCtx(env, { folderCache, folderListings: listings })).run(new AbortController().signal)
  const oldParent = r1.target.parentId
  env.mock.deleteItem(oldParent)
  const gone2 = await localFile(env, 'g/dois.mov', 40 * KiB, 81)
  const r2 = makeRecord(env, gone2, { rootId: base.id, relDir: 'Destino' })
  await new UploadTask(r2, makeCtx(env, { folderCache, folderListings: listings })).run(new AbortController().signal)
  await assertUploaded(env, r2, gone2)
  assert.notEqual(r2.target.parentId, oldParent)
  assert.ok(!listings.map.has(oldParent), 'a listagem da pasta apagada saiu')

  // Drive compartilhado: lista dentro do drive e decide igual.
  const shared = env.mock.addSharedDrive('Equipe')
  const sf = await localFile(env, 's/shared.mov', 30 * KiB, 90)
  const sharedListings = new FolderListings()
  const rs1 = makeRecord(env, sf, { rootId: shared.id, driveId: shared.id, relDir: 'Entregas' })
  await new UploadTask(rs1, makeCtx(env, { folderListings: sharedListings })).run(new AbortController().signal)
  await assertUploaded(env, rs1, sf)
  const rs2 = makeRecord(env, sf, { rootId: shared.id, driveId: shared.id, relDir: 'Entregas' })
  await new UploadTask(rs2, makeCtx(env, { folderListings: sharedListings })).run(new AbortController().signal)
  assert.equal(rs2.status, 'skipped')
  assert.equal(rs2.target.fileId, rs1.target.fileId)
  const rs3 = makeRecord(env, sf, { rootId: shared.id, driveId: shared.id })
  await new UploadTask(rs3, makeCtx(env, { folderListings: sharedListings })).run(new AbortController().signal)
  await assertUploaded(env, rs3, sf)
  assert.equal(env.mock.getItem(rs3.target.fileId).driveId, shared.id)
})

test('21. listagem compartilhada: a pausa de um não derruba os outros; todos pausaram = cancela; erro = lista de novo', async () => {
  const pending = []
  const fake = {
    calls: 0,
    listChildren(folderId, { signal, limit }) {
      this.calls++
      return new Promise((resolve, reject) => {
        const job = { folderId, limit, signal, resolve, reject }
        signal.addEventListener('abort', () => reject(Object.assign(new Error('abortado'), { name: 'AbortError' })), { once: true })
        pending.push(job)
      })
    },
  }
  const l = new FolderListings()
  const a1 = new AbortController()
  const p1 = l.has(fake, 'F', 'x.mov', { signal: a1.signal })
  const p2 = l.has(fake, 'F', 'y.mov', { signal: new AbortController().signal })
  assert.equal(fake.calls, 1, 'uma listagem para os dois')
  assert.equal(pending[0].limit, 5001)
  a1.abort()
  await assert.rejects(p1, err => isAbortError(err))
  assert.equal(pending[0].signal.aborted, false, 'o outro ainda espera: a listagem segue')
  pending[0].resolve([{ name: 'y.mov', isFolder: false }, { name: 'x.mov', isFolder: true }])
  assert.equal(await p2, true)
  assert.equal(await l.has(fake, 'F', 'x.mov'), false, 'pasta com o mesmo nome não conta')
  assert.equal(fake.calls, 1)

  // Todos desistiram: cancela e a próxima pergunta lista de novo.
  const b1 = new AbortController()
  const q1 = l.has(fake, 'G', 'z.mov', { signal: b1.signal })
  b1.abort()
  await assert.rejects(q1, err => isAbortError(err))
  assert.equal(pending[1].signal.aborted, true)
  const q2 = l.has(fake, 'G', 'z.mov')
  assert.equal(fake.calls, 3)
  pending[2].reject(Object.assign(new Error('500'), { status: 500 }))
  await assert.rejects(q2, /500/)
  const q3 = l.has(fake, 'G', 'z.mov')
  assert.equal(fake.calls, 4, 'erro não fica guardado')
  pending[3].resolve([{ name: 'z.mov', isFolder: false }])
  assert.equal(await q3, true)

  // Nome normalizado (NFC): "Câmera" composto e decomposto são o mesmo nome.
  l.created('H')
  assert.equal(await l.has(fake, 'H', 'Câmera.mov'), false)
  l.added('H', 'Câmera.mov')
  assert.equal(await l.has(fake, 'H', 'Câmera.mov'), true)
  assert.equal(fake.calls, 4, 'pasta criada pelo app não é listada')
})
