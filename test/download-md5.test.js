// Rodada 3 (4.7, 4.9, 4.14): MD5 calculado JUNTO com a gravação do download (blocos em ordem + Hasher.stream),
// retomada em processo novo relendo o prefixo, byte corrompido (na rede e no disco), arquivo que muda no Drive,
// servidor sem Range, arquivos de 0 byte / menores que um bloco, cache de MD5 do arquivo final e checkpoint por bytes.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setupDrive, md5File, waitFor } from './helpers.js'
import { virtualBytes } from './mock-drive.js'
import { DownloadTask } from '../src/engine/download.js'
import { planDownloads } from '../src/engine/planner.js'
import { Settings } from '../src/config.js'
import { BandwidthLimiter } from '../src/util/limiter.js'
import { Hasher } from '../src/engine/hasher.js'
import { DriveClient } from '../src/google/drive.js'
import { closeHttp } from '../src/net/http.js'
import { PART_SUFFIX } from '../src/util/paths.js'
import { isAbortError } from '../src/util/backoff.js'

const MiB = 1024 * 1024
const CHILD = fileURLToPath(new URL('./download-retomar-filho.mjs', import.meta.url))

after(() => closeHttp())

async function env(t, { mock = {}, settings = {} } = {}) {
  const base = await setupDrive(mock)
  const hasher = new Hasher({ cacheFile: path.join(base.home, 'hash-cache.json'), workers: 1, log: () => {} })
  t.after(async () => {
    await hasher.close()
    await base.cleanup()
  })
  const s = new Settings(base.settingsFile)
  await s.update(settings)
  const drive = new DriveClient(base.auth, base.accountId, { ratePerSec: 1000, retryBaseMs: 5 })
  return { ...base, settings: s, hasher, drive, limiter: new BandwidthLimiter(0), destDir: path.join(base.home, 'Baixados') }
}

async function recordFor(e, fileId, { name } = {}) {
  const item = await e.drive.getItem(fileId)
  const finalName = name ?? item.name
  const dest = path.join(e.destDir, finalName)
  const now = Date.now()
  return {
    id: `t_${crypto.randomBytes(4).toString('hex')}`, type: 'download', accountId: e.accountId, batchId: 'b_test', status: 'running',
    name: finalName, relPath: finalName, size: item.size, bytesDone: 0, createdAt: now, startedAt: now, finishedAt: null, updatedAt: now,
    error: null, retryAt: null, attempts: 0, verify: null, note: null,
    source: { fileId: item.id, mimeType: item.mimeType, md5: item.md5, modifiedTime: item.modifiedTime, headRevisionId: item.headRevisionId, resourceKey: item.resourceKey },
    dest: { path: dest, tempPath: dest + PART_SUFFIX },
    segments: [],
  }
}

function makeTask(e, record, opts = {}) {
  const snapshots = []
  const ctx = {
    drive: e.drive, settings: e.settings, limiter: e.limiter, hasher: e.hasher, folderCache: new Map(),
    persist: () => snapshots.push(JSON.parse(JSON.stringify(record))),
    onBytes() {}, log() {},
  }
  const task = new DownloadTask(record, ctx, { retryBaseMs: 20, ...opts })
  let atVerify = null
  task.on('status', s => {
    if (s === 'verifying') atVerify = task.verifyBytes
  })
  return { task, snapshots, record, verifyAt: () => atVerify }
}

/** O MD5 que o motor aceitou é o do arquivo no disco e o do Drive; foi calculado junto com a gravação. */
async function assertStreamOk(e, job, fileId) {
  const rec = job.record
  const disk = await md5File(rec.dest.path)
  assert.equal(disk, await e.mock.contentMd5(fileId), 'arquivo no disco = conteúdo do Drive')
  assert.equal(rec.verify.state, 'ok')
  assert.equal(rec.verify.actual, disk, 'MD5 aceito = MD5 do arquivo no disco')
  assert.equal(job.task.counters.streamHashes, 1, 'MD5 veio do acompanhamento da gravação')
  assert.equal(job.task.counters.hashFallbacks, 0, 'sem cair na conferência completa')
  assert.equal(job.task.counters.hashConfirms, 0)
  await assert.rejects(fs.access(rec.dest.tempPath), 'temporário não fica para trás')
}

// ─────────── Hasher.stream ───────────

test('Hasher.stream: segue a frente, bate com o arquivo inteiro; frente para trás, arquivo curto e close falham', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-stream-'))
  const hasher = new Hasher({ cacheFile: path.join(home, 'c.json'), workers: 1, log: () => {} })
  t.after(async () => {
    await hasher.close()
    await fs.rm(home, { recursive: true, force: true })
  })
  const file = path.join(home, 'a.bin')
  const size = 9 * MiB + 77
  await fs.writeFile(file, virtualBytes(5, 0, size))
  const expected = crypto.createHash('md5').update(await fs.readFile(file)).digest('hex')

  const s = hasher.stream(file)
  for (const upto of [0, 1, 4096, 3 * MiB, 3 * MiB, 8 * MiB]) s.advance(upto)
  const seen = []
  assert.equal(await s.finish(size, { onProgress: p => seen.push(p.bytes) }), expected)
  assert.equal(seen.at(-1), size)
  assert.equal(hasher.streams.size, 0, 'worker encerrado depois do fim')

  const back = hasher.stream(file)
  back.advance(2 * MiB)
  back.advance(MiB)
  assert.match(back.failed?.message ?? '', /para trás/)
  await assert.rejects(back.finish(size))

  const short = hasher.stream(file)
  await assert.rejects(short.finish(size + 10), err => err.code === 'ESHORT')

  const closed = hasher.stream(file)
  const p = assert.rejects(closed.finish(size), /encerrado/)
  await closed.close()
  await p

  const ac = new AbortController()
  const paused = hasher.stream(file)
  const q = paused.finish(size, { signal: ac.signal })
  ac.abort()
  await assert.rejects(q, err => isAbortError(err))
  await paused.close()

  // Nenhum descritor esquecido: o worker fecha o arquivo antes de sair (terminate() não fecharia).
  const fds = async () => (await fs.readdir('/proc/self/fd').catch(() => null))?.length ?? null
  const before = await fds()
  if (before != null) {
    for (let i = 0; i < 5; i++) {
      const x = hasher.stream(file)
      x.advance(5 * MiB)
      await waitFor(() => x.bytes > 0, { timeoutMs: 5000 })
      await x.close()
    }
    const done = hasher.stream(file)
    await done.finish(size)
    await done.close()
    assert.equal(await fds(), before, 'descritores abertos voltam ao que eram')
  }
})

// ─────────── download ───────────

test('MD5 durante o download = MD5 do arquivo inteiro, em vários tamanhos e com roubo de segmento', async t => {
  const e = await env(t, { mock: { perConnectionBps: 16 * MiB }, settings: { connectionsPerDownload: 4, minSegmentSize: 1 * MiB } })
  const sizes = [1 * MiB + 1, 1.5 * MiB + 3, 2 * MiB + 7, 9 * MiB + 333, 33 * MiB - 5]
  let steals = 0
  for (const [i, size] of sizes.entries()) {
    const file = e.mock.addFile(`clip_${i}.mov`, 'root', { size, seed: 600 + i })
    const job = makeTask(e, await recordFor(e, file.id), { stealMinBytes: 256 * 1024 })
    await job.task.run()
    await assertStreamOk(e, job, file.id)
    assert.deepEqual(job.record.segments, [{ start: 0, end: size - 1, pos: size }], `${size}: registro compacto no fim`)
    steals += job.task.counters.steals
  }
  assert.ok(steals > 0, `houve roubo de segmento (${steals})`)
})

test('blocos em ordem: o MD5 acompanha a gravação e no fim só falta o último trecho', async t => {
  const e = await env(t, { mock: { perConnectionBps: 2 * MiB }, settings: { connectionsPerDownload: 4, minSegmentSize: 4 * MiB } })
  const size = 48 * MiB
  const file = e.mock.addFile('A001.braw', 'root', { size, seed: 610 })
  const job = makeTask(e, await recordFor(e, file.id), { blockSeconds: 0 }) // bloco fixo de 4 MiB
  const p = job.task.run()
  // Na metade do download o MD5 já leu boa parte do que foi gravado (não espera o último byte).
  await waitFor(() => job.task.liveBytes() >= size / 2, { timeoutMs: 30_000 })
  await waitFor(() => (job.task.hs?.bytes ?? 0) >= size / 4, { timeoutMs: 5000, message: 'o MD5 não acompanhou a gravação' })
  // Blocos em ordem: no meio do download, poucos pedaços vivos (não 4 regiões espalhadas pelo arquivo inteiro).
  const live = job.task.liveSegments()
  assert.ok(live.length <= 4 + 3, `pedaços vivos: ${live.length}`)
  await p
  await assertStreamOk(e, job, file.id)
  const tail = size - job.verifyAt()
  assert.ok(tail <= 4 * 4 * MiB, `faltava ler no fim: ${(tail / MiB).toFixed(1)} MiB (≤ conexões × bloco)`)
})

test('conexão rápida: o bloco cresce para durar ~blockSeconds (menos requisições), e o MD5 continua certo', async t => {
  const e = await env(t, { mock: { perConnectionBps: 8 * MiB }, settings: { connectionsPerDownload: 2, minSegmentSize: 1 * MiB } })
  const size = 40 * MiB
  const file = e.mock.addFile('rapido.mov', 'root', { size, seed: 615 })
  const job = makeTask(e, await recordFor(e, file.id), { blockSeconds: 1, maxBlockBytes: 6 * MiB })
  let biggest = 0
  const p = job.task.run()
  const timer = setInterval(() => {
    for (const s of job.task.liveSegments()) if (s.active) biggest = Math.max(biggest, s.end + 1 - s.start)
  }, 20)
  try {
    await p
  } finally {
    clearInterval(timer)
  }
  await assertStreamOk(e, job, file.id)
  // 8 MiB/s por conexão × 1 s = 8 MiB, limitado a 6 MiB: blocos maiores que o mínimo de 1 MiB, nunca acima do teto
  // (a sobra de até meio bloco pode ir junto no último).
  assert.ok(biggest >= 4 * MiB && biggest <= 9 * MiB, `maior bloco: ${(biggest / MiB).toFixed(1)} MiB`)
  assert.ok(job.task.counters.requests < size / MiB / 2, `requisições: ${job.task.counters.requests}`)
})

test('retomada em PROCESSO NOVO: o prefixo já baixado é relido do disco e o MD5 continua junto com a gravação', async t => {
  const size = 40 * MiB
  const seed = 620
  const md5 = crypto.createHash('md5')
  for (let p = 0; p < size; p += 4 * MiB) md5.update(virtualBytes(seed, p, Math.min(size, p + 4 * MiB)))
  const item = { id: 'f1', name: 'x.mov', mimeType: 'video/quicktime', size, md5: md5.digest('hex'), modifiedTime: '2026-01-01T00:00:00.000Z', headRevisionId: 'rev1', resourceKey: null, canDownload: true, isFolder: false, isShortcut: false, isGoogleDoc: false }
  const srv = await rangeServer({ size, seed, bps: 3 * MiB })
  t.after(srv.close)
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-retomar-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const settingsFile = path.join(home, 'settings.json')
  const settings = new Settings(settingsFile)
  await settings.update({ connectionsPerDownload: 4, minSegmentSize: 4 * MiB })
  const hasher = new Hasher({ cacheFile: path.join(home, 'c1.json'), workers: 1, log: () => {} })
  t.after(() => hasher.close())
  const dest = path.join(home, 'Baixados', 'x.mov')
  const rec = {
    id: 't_r', type: 'download', status: 'running', name: 'x.mov', relPath: 'x.mov', size, bytesDone: 0, attempts: 0, error: null, verify: null, note: null,
    createdAt: Date.now(), updatedAt: Date.now(), source: { fileId: 'f1', mimeType: item.mimeType, md5: item.md5, modifiedTime: item.modifiedTime, headRevisionId: 'rev1', resourceKey: null },
    dest: { path: dest, tempPath: dest + PART_SUFFIX }, segments: [],
  }
  const snapshots = []
  const drive = { getItem: async () => item, mediaUrl: () => srv.url, authHeader: async () => ({ authorization: 'Bearer teste' }) }
  const task = new DownloadTask(rec, { drive, settings, limiter: new BandwidthLimiter(0), hasher, persist: () => snapshots.push(JSON.parse(JSON.stringify(rec))), onBytes() {}, log() {} }, { retryBaseMs: 20 })
  const ac = new AbortController()
  const run = task.run(ac.signal)
  run.catch(() => {})
  await waitFor(() => task.liveBytes() >= size * 0.5, { timeoutMs: 30_000 })
  ac.abort()
  await assert.rejects(run, err => isAbortError(err))
  const saved = snapshots.at(-1)
  assert.ok(saved.bytesDone >= size * 0.45, `progresso guardado: ${saved.bytesDone}`)
  await waitFor(() => srv.state.active === 0, { timeoutMs: 5000 })

  // "Fecha o app": outro processo, outro Hasher, só o JSON e o temporário no disco.
  const servedBefore = srv.state.served
  const recFile = path.join(home, 'rec.json')
  const itemFile = path.join(home, 'item.json')
  await fs.writeFile(recFile, JSON.stringify(saved))
  await fs.writeFile(itemFile, JSON.stringify(item))
  const out = await new Promise((resolve, reject) => {
    execFile(process.execPath, [CHILD, recFile, itemFile, srv.url, settingsFile, path.join(home, 'c2.json')], { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message}\n${stderr}`))
      resolve(JSON.parse(stdout.trim().split('\n').at(-1)))
    })
  })
  assert.equal(out.error, null, JSON.stringify(out.error))
  assert.equal(out.record.verify.state, 'ok')
  assert.equal(out.record.verify.actual, item.md5)
  assert.equal(await md5File(dest), item.md5)
  assert.equal(out.counters.streamHashes, 1, 'o processo novo conferiu pelo MD5 da gravação (prefixo relido do disco)')
  assert.equal(out.counters.hashFallbacks, 0)
  const resent = srv.state.served - servedBefore
  assert.ok(resent <= size - saved.bytesDone + 4 * MiB, `baixou de novo ${resent} bytes de ${size - saved.bytesDone} que faltavam`)
})

test('byte corrompido na REDE (Drive falso troca um byte): MD5 não confere, fatal, temporário apagado', async t => {
  const e = await env(t, { settings: { connectionsPerDownload: 4, minSegmentSize: 2 * MiB } })
  const size = 20 * MiB + 11
  const file = e.mock.addFile('corrompido.mov', 'root', { size, seed: 630 })
  e.mock.setOptions({ corruptMediaBytes: { [file.id]: 13 * MiB + 5 } })
  const job = makeTask(e, await recordFor(e, file.id))
  await assert.rejects(job.task.run(), err => err.kind === 'fatal' && err.reason === 'checksumMismatch')
  assert.ok(e.mock.stats().faults.corruptedBytes >= 1, 'o byte foi corrompido no envio')
  assert.equal(job.task.counters.streamHashes, 1, 'o MD5 da gravação percebeu')
  assert.equal(job.task.counters.hashConfirms, 1, 'e a leitura completa confirmou antes de jogar fora')
  assert.equal(job.record.verify.state, 'mismatch')
  assert.notEqual(job.record.verify.actual, job.record.verify.expected)
  await assert.rejects(fs.access(job.record.dest.tempPath), 'temporário apagado')
  await assert.rejects(fs.access(job.record.dest.path), 'nada no destino')
})

test('byte corrompido no DISCO (a rede veio certa): o MD5 é o do arquivo gravado, então percebe', async t => {
  const e = await env(t, { mock: { perConnectionBps: 16 * MiB }, settings: { connectionsPerDownload: 4, minSegmentSize: 2 * MiB } })
  const size = 16 * MiB
  const file = e.mock.addFile('disco.mov', 'root', { size, seed: 640 })
  const job = makeTask(e, await recordFor(e, file.id))
  // Toda gravação de FileHandle passa por aqui: a que cobre `target` grava um byte trocado (falha do disco/cabo).
  const probe = await fs.open(path.join(e.home, 'probe'), 'w')
  const proto = Object.getPrototypeOf(probe)
  await probe.close()
  const original = proto.write
  const target = 11 * MiB + 99
  let hit = 0
  proto.write = function (buf, offset, length, position) {
    if (!hit && Buffer.isBuffer(buf) && typeof position === 'number' && length >= 64 * 1024 && target >= position && target < position + length) {
      hit++
      const copy = Buffer.from(buf.subarray(offset, offset + length))
      copy[target - position] ^= 0x01
      return original.call(this, copy, 0, length, position)
    }
    return original.call(this, buf, offset, length, position)
  }
  try {
    await assert.rejects(job.task.run(), err => err.kind === 'fatal' && err.reason === 'checksumMismatch')
  } finally {
    proto.write = original
  }
  assert.equal(hit, 1, 'uma gravação corrompida')
  assert.equal(job.task.counters.streamHashes, 1)
  assert.equal(job.record.verify.state, 'mismatch')
  assert.notEqual(job.record.verify.actual, await e.mock.contentMd5(file.id))
})

test('arquivo muda no Drive durante o download (outro tamanho): recomeça com MD5 novo e baixa a versão nova', async t => {
  const e = await env(t, { mock: { perConnectionBps: 4 * MiB }, settings: { connectionsPerDownload: 3, minSegmentSize: 2 * MiB } })
  const file = e.mock.addFile('versao.mov', 'root', { size: 24 * MiB, seed: 650 })
  // Blocos fixos de 2 MiB: depois da troca ainda nascem requisições (com bloco grande, tudo já teria sido pedido antes
  // da troca e o arquivo chegaria inteiro na versão antiga, o que também está certo).
  const job = makeTask(e, await recordFor(e, file.id), { blockSeconds: 0 })
  const resets = []
  job.task.on('reset', r => resets.push(r.reason))
  const p = job.task.run()
  await waitFor(() => job.task.liveBytes() >= 6 * MiB, { timeoutMs: 30_000 })
  e.mock.updateContent(file.id, { size: 20 * MiB, seed: 651 })
  await p
  assert.ok(resets.includes('remoteChanged'), `recomeços: ${resets}`)
  assert.equal(job.record.size, 20 * MiB)
  await assertStreamOk(e, job, file.id)
})

test('arquivo muda no Drive com o MESMO tamanho (plano recém-feito): MD5 da gravação + confirmação = "mudou", depois baixa certo', async t => {
  const e = await env(t, { mock: { perConnectionBps: 4 * MiB }, settings: { connectionsPerDownload: 3, minSegmentSize: 2 * MiB } })
  const folder = e.mock.addFolder('Entregas')
  const file = e.mock.addFile('corte.mov', folder.id, { size: 16 * MiB, seed: 660 })
  const plan = await planDownloads({ drive: e.drive, accountId: e.accountId, items: [{ id: folder.id }], destDir: e.destDir })
  const rec = plan.records[0]
  const job = makeTask(e, rec, { blockSeconds: 0 })
  const p = job.task.run()
  await waitFor(() => job.task.liveBytes() >= 5 * MiB, { timeoutMs: 30_000 })
  e.mock.updateContent(file.id, { size: 16 * MiB, seed: 661 }) // metade de uma versão, metade de outra
  await assert.rejects(p, err => err.kind === 'retry' && err.reason === 'remoteChanged')
  assert.equal(job.task.counters.streamHashes, 1)
  assert.equal(job.task.counters.hashConfirms, 1)
  assert.equal(rec.verify, null, 'não fica marcado como "chegou diferente"')
  const job2 = makeTask(e, rec)
  await job2.task.run()
  assert.equal(rec.source.md5, await e.mock.contentMd5(file.id))
  await assertStreamOk(e, job2, file.id)
})

test('servidor responde 200 sem Range: conexão única, MD5 junto; pausa e retoma também', async t => {
  const e = await env(t, { mock: { ignoreRange: true, perConnectionBps: 8 * MiB }, settings: { connectionsPerDownload: 4, minSegmentSize: 2 * MiB } })
  const size = 24 * MiB + 1
  const file = e.mock.addFile('sem-range.mov', 'root', { size, seed: 670 })
  const job = makeTask(e, await recordFor(e, file.id))
  const ac = new AbortController()
  const p = job.task.run(ac.signal)
  p.catch(() => {})
  await waitFor(() => job.task.liveBytes() >= size * 0.4, { timeoutMs: 30_000 })
  ac.abort()
  await assert.rejects(p, err => isAbortError(err))
  assert.ok(job.task.counters.singleStream >= 1)
  await waitFor(() => e.mock.stats().activeMediaConnections === 0, { timeoutMs: 10_000 })
  const saved = JSON.parse(JSON.stringify(job.snapshots.at(-1)))
  assert.equal(saved.segments.length, 1)
  const job2 = makeTask(e, saved)
  await job2.task.run()
  assert.ok(job2.task.counters.singleStream >= 1)
  await assertStreamOk(e, job2, file.id)

  // Direto, sem pausa.
  const job3 = makeTask(e, await recordFor(e, file.id, { name: 'direto.mov' }))
  await job3.task.run()
  await assertStreamOk(e, job3, file.id)
})

test('0 byte, menor que um bloco e exatamente um bloco: conferência no fim, como antes; arquivo final entra no cache de MD5', async t => {
  const e = await env(t, { settings: { connectionsPerDownload: 4, minSegmentSize: 4 * MiB } })
  for (const [name, size] of [['vazio.wav', 0], ['pequeno.wav', 3 * MiB + 1], ['um-bloco.wav', 4 * MiB], ['um-bloco-e-1.wav', 4 * MiB + 1]]) {
    const file = e.mock.addFile(name, 'root', { size, seed: 680 + size % 97, modifiedTime: '2025-06-07T08:09:10.000Z' })
    const job = makeTask(e, await recordFor(e, file.id))
    await job.task.run()
    const rec = job.record
    assert.equal(rec.verify.state, 'ok', name)
    assert.equal(await md5File(rec.dest.path), await e.mock.contentMd5(file.id), name)
    assert.equal(job.task.counters.streamHashes, size > 4 * MiB ? 1 : 0, `${name}: MD5 da gravação só acima de um bloco`)
    if (size === 0) continue
    // 4.14: nome final + data do Drive no cache, então o Comparar profundo não relê o arquivo.
    const st = await fs.stat(rec.dest.path)
    assert.equal(Math.round(st.mtimeMs), Date.parse('2025-06-07T08:09:10.000Z'))
    assert.equal(e.hasher.getCached(rec.dest.path, st.size, st.mtimeMs), rec.verify.actual, `${name}: no cache com o nome final`)
    const started = e.hasher.started
    assert.equal(await e.hasher.hash(rec.dest.path), rec.verify.actual)
    assert.equal(e.hasher.started, started, `${name}: hash() veio do cache, sem reler`)
  }
})

test('4.9: checkpoint por bytes gravados (antes dos 10 s) e o que o registro diz ter está no disco', async t => {
  const e = await env(t, { mock: { perConnectionBps: 4 * MiB }, settings: { connectionsPerDownload: 2, minSegmentSize: 2 * MiB } })
  const size = 24 * MiB
  const file = e.mock.addFile('ck.mov', 'root', { size, seed: 690 })
  const job = makeTask(e, await recordFor(e, file.id), { checkpointMs: 60_000, checkpointBytes: 4 * MiB })
  const checks = []
  const p = job.task.run()
  const timer = setInterval(() => {
    const s = job.snapshots.at(-1)
    if (s && s.bytesDone > 0 && s.bytesDone < size) checks.push(JSON.parse(JSON.stringify(s)))
  }, 20)
  try {
    await p
  } finally {
    clearInterval(timer)
  }
  assert.ok(job.task.counters.checkpoints >= 4, `checkpoints: ${job.task.counters.checkpoints}`)
  const distinct = new Set(checks.map(c => c.bytesDone))
  assert.ok(distinct.size >= 3, `progresso intermediário gravado: ${[...distinct]}`)
  await assertStreamOk(e, job, file.id)
})

// ─────────── servidor de Range mínimo (conta os bytes mandados) ───────────

async function rangeServer({ size, seed, bps }) {
  const state = { served: 0, active: 0 }
  const server = http.createServer(async (req, res) => {
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '')
    const start = m ? Number(m[1]) : 0
    const end = m ? Math.min(Number(m[2]), size - 1) : size - 1
    res.writeHead(m ? 206 : 200, { 'content-length': end - start + 1, ...(m ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) })
    state.active++
    try {
      const chunk = Math.max(4096, Math.floor(bps / 20))
      const t0 = Date.now()
      let pos = start
      while (pos <= end && !res.destroyed) {
        const k = Math.min(chunk, end + 1 - pos)
        const ok = res.write(virtualBytes(seed, pos, pos + k))
        pos += k
        state.served += k
        if (!ok) await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve) })
        const wait = t0 + ((pos - start) * 1000) / bps - Date.now()
        if (wait > 1) await new Promise(resolve => setTimeout(resolve, wait))
      }
      res.end()
    } finally {
      state.active--
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/media`,
    state,
    close: () => new Promise(resolve => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
