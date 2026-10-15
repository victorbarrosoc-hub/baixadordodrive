// DownloadTask contra o Drive falso: paralelismo, pausa/retomada, queda, falhas, travamento, roubo de segmentos,
// arquivo que muda no Drive, Range ignorado, export de Docs, MD5 que não bate, limite de banda.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { setupDrive, md5File, waitFor } from './helpers.js'
import { DownloadTask, loadSegments, formatBytes } from '../src/engine/download.js'
import { Settings } from '../src/config.js'
import { BandwidthLimiter } from '../src/util/limiter.js'
import { Hasher } from '../src/engine/hasher.js'
import { DriveClient, GOOGLE_EXPORTS } from '../src/google/drive.js'
import { classifyError } from '../src/google/errors.js'
import { closeHttp } from '../src/net/http.js'
import { PART_SUFFIX } from '../src/util/paths.js'
import { isAbortError } from '../src/util/backoff.js'

const MiB = 1024 * 1024

after(() => closeHttp())

/** Drive falso + contexto de verdade (Settings, limitador, Hasher). */
async function env(t, { mock = {}, settings = {}, limit = 0 } = {}) {
  const base = await setupDrive(mock)
  const hasher = new Hasher({ cacheFile: path.join(base.home, 'hash-cache.json'), workers: 1 })
  t.after(async () => {
    await hasher.close()
    await base.cleanup()
  })
  const s = new Settings(base.settingsFile)
  await s.update(settings)
  // Muitas chamadas de metadados com falhas sorteadas: recuo curto para o teste não demorar.
  const drive = new DriveClient(base.auth, base.accountId, { ratePerSec: 1000, retryBaseMs: 5 })
  const limiter = new BandwidthLimiter(limit)
  const destDir = path.join(base.home, 'Baixados')
  return { ...base, settings: s, hasher, drive, limiter, destDir }
}

/** Registro de download como o planner montaria, a partir do item do Drive (via API, como no app). */
async function recordFor(e, fileId, { name, exportAs } = {}) {
  const item = await e.drive.getItem(fileId, { resourceKey: e.mock.getItem(fileId).resourceKey || undefined })
  const finalName = name ?? item.name + (exportAs ? exportAs.ext : '')
  const dest = path.join(e.destDir, finalName)
  const now = Date.now()
  return {
    id: `t_${crypto.randomBytes(4).toString('hex')}`,
    type: 'download',
    accountId: e.accountId,
    batchId: 'b_test',
    status: 'running',
    name: finalName,
    relPath: finalName,
    size: exportAs ? null : item.size,
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
    source: {
      fileId: item.id,
      mimeType: item.mimeType,
      md5: item.md5,
      modifiedTime: item.modifiedTime,
      headRevisionId: item.headRevisionId,
      resourceKey: item.resourceKey,
      ...(exportAs ? { export: exportAs } : {}),
    },
    dest: { path: dest, tempPath: dest + PART_SUFFIX },
    segments: [],
  }
}

/** TaskContext montado com os módulos de verdade; persist guarda uma cópia (JSON) de cada gravação pedida. */
function makeTask(e, record, opts = {}) {
  const snapshots = []
  const counter = { bytes: 0 }
  const ctx = {
    drive: e.drive,
    settings: e.settings,
    limiter: e.limiter,
    hasher: e.hasher,
    folderCache: new Map(),
    persist: () => snapshots.push(JSON.parse(JSON.stringify(record))),
    onBytes: n => {
      counter.bytes += n
    },
    log: () => {},
  }
  const task = new DownloadTask(record, ctx, { retryBaseMs: 20, ...opts })
  return { task, snapshots, counter, record }
}

function liveDone(task) {
  return task.liveSegments().reduce((sum, s) => sum + (s.pos - s.start), 0)
}

/** Roda até `fraction` do arquivo e pausa (abort). Devolve o registro como ficou. */
async function runAndPause(job, fraction, { beforeAbort } = {}) {
  const ac = new AbortController()
  const p = job.task.run(ac.signal)
  p.catch(() => {})
  await waitFor(() => liveDone(job.task) >= fraction * job.record.size, { timeoutMs: 60_000, intervalMs: 5, message: 'o download não chegou ao ponto de pausa' })
  const extra = beforeAbort ? await beforeAbort() : undefined
  ac.abort()
  await assert.rejects(p, err => isAbortError(err), 'pausa rejeita com AbortError')
  return extra
}

/** Confere que cada trecho que o registro diz ter no disco é igual ao conteúdo do Drive. */
async function assertClaimsOnDisk(e, rec, fileId) {
  const fh = await fs.open(rec.dest.tempPath, 'r')
  try {
    for (const s of rec.segments) {
      const len = s.pos - s.start
      if (!len) continue
      const buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, s.start)
      assert.equal(bytesRead, len)
      assert.ok(buf.equals(e.mock.readContent(fileId, s.start, s.pos)), `bytes [${s.start}, ${s.pos}) no disco batem com o Drive`)
    }
  } finally {
    await fh.close()
  }
}

async function assertDone(e, rec, fileId) {
  assert.equal(await md5File(rec.dest.path), await e.mock.contentMd5(fileId), 'MD5 do arquivo baixado = MD5 do Drive')
  await assert.rejects(fs.access(rec.dest.tempPath), 'temporário não fica para trás')
  assert.equal(rec.bytesDone, rec.size)
}

async function waitMediaIdle(e) {
  await waitFor(() => e.mock.stats().activeMediaConnections === 0, { timeoutMs: 10_000, message: 'conexões de mídia não fecharam' })
}

test('helpers: loadSegments valida, ordena e junta pedaços completos; formatBytes em PT-BR', () => {
  assert.equal(loadSegments([], 10), null)
  assert.equal(loadSegments([{ start: 0, end: 4, pos: 0 }], 10), null, 'buraco no fim')
  assert.equal(loadSegments([{ start: 0, end: 4, pos: 6 }, { start: 5, end: 9, pos: 5 }], 10), null, 'pos fora do pedaço')
  assert.equal(loadSegments([{ start: 0, end: 5, pos: 0 }, { start: 5, end: 9, pos: 5 }], 10), null, 'sobreposição')
  assert.deepEqual(
    loadSegments([{ start: 5, end: 9, pos: 7 }, { start: 0, end: 4, pos: 5 }], 10),
    [{ start: 0, end: 9, pos: 7 }],
    'completo absorve o vizinho',
  )
  assert.deepEqual(
    loadSegments([{ start: 0, end: 2, pos: 1 }, { start: 3, end: 5, pos: 6 }, { start: 6, end: 9, pos: 8 }], 10),
    [{ start: 0, end: 2, pos: 1 }, { start: 3, end: 9, pos: 8 }],
  )
  assert.equal(formatBytes(12_345_678_901), '12,3 GB')
  assert.equal(formatBytes(512), '512 bytes')
})

test('200 MiB com 8 conexões: MD5 confere, ≥ 6 conexões simultâneas, data do Drive aplicada', async t => {
  const e = await env(t, { settings: { connectionsPerDownload: 8 } })
  const size = 200 * MiB
  const file = e.mock.addFile('A001_C002.mov', 'root', { size, seed: 11, modifiedTime: '2025-03-04T05:06:07.000Z' })
  const rec = await recordFor(e, file.id)
  const job = makeTask(e, rec)
  await job.task.run()
  await assertDone(e, rec, file.id)
  assert.equal(rec.verify.state, 'ok')
  assert.equal(rec.verify.expected, rec.verify.actual)
  const st = e.mock.stats()
  assert.ok(st.maxActiveMediaConnections >= 6, `conexões simultâneas: ${st.maxActiveMediaConnections}`)
  assert.ok(st.bytesServed <= size * 1.25, `bytes servidos ${st.bytesServed} (sem baixar o arquivo duas vezes)`)
  assert.ok(job.counter.bytes >= size, 'onBytes recebeu todo o tráfego')
  const stat = await fs.stat(rec.dest.path)
  assert.equal(stat.size, size)
  assert.equal(Math.round(stat.mtimeMs), Date.parse('2025-03-04T05:06:07.000Z'), 'mtime = modifiedTime do Drive')
  assert.ok(rec.segments.every(s => s.pos === s.end + 1), 'todos os segmentos completos no registro')
  assert.ok(job.snapshots.length >= 2, 'persist() chamado')
  assert.deepEqual(job.task.liveSegments().map(s => s.active), rec.segments.map(() => false))
})

test('slow: 4 MB/s por conexão, 64 MiB: 8 conexões ≥ 3× mais rápido que 1', async t => {
  const e = await env(t, { mock: { perConnectionBps: 4 * MiB }, settings: { verifyChecksums: false, minSegmentSize: 8 * MiB } })
  const size = 64 * MiB
  const file = e.mock.addFile('rush.mov', 'root', { size, seed: 21 })

  await e.settings.update({ connectionsPerDownload: 1 })
  const rec1 = await recordFor(e, file.id, { name: 'um.mov' })
  let t0 = Date.now()
  await makeTask(e, rec1).task.run()
  const single = Date.now() - t0
  assert.equal(rec1.segments.length, 1)

  await e.settings.update({ connectionsPerDownload: 8 })
  const rec8 = await recordFor(e, file.id, { name: 'oito.mov' })
  t0 = Date.now()
  await makeTask(e, rec8).task.run()
  const multi = Date.now() - t0

  const md5 = await e.mock.contentMd5(file.id)
  assert.equal(await md5File(rec1.dest.path), md5)
  assert.equal(await md5File(rec8.dest.path), md5)
  assert.ok(single >= multi * 3, `1 conexão: ${single} ms; 8 conexões: ${multi} ms`)
})

test('pausa em ~40% e retoma com uma tarefa NOVA a partir do JSON gravado: re-download ≤ 10%', async t => {
  const e = await env(t, { mock: { perConnectionBps: 4 * MiB }, settings: { connectionsPerDownload: 4, minSegmentSize: 12 * MiB } })
  const size = 48 * MiB
  const file = e.mock.addFile('entrevista.mxf', 'root', { size, seed: 31 })
  const rec = await recordFor(e, file.id)
  const job = makeTask(e, rec)
  let sawSpeed = false
  await runAndPause(job, 0.4, {
    beforeAbort: () => {
      const live = job.task.liveSegments()
      assert.ok(live.some(s => s.active), 'segmentos ativos durante o download')
      sawSpeed = job.task.speed() > 0
    },
  })
  assert.ok(sawSpeed, 'speed() > 0 durante o download')
  const saved = job.snapshots.at(-1)
  assert.ok(saved.bytesDone >= size * 0.35, `progresso guardado na pausa: ${saved.bytesDone}`)
  await assertClaimsOnDisk(e, saved, file.id)
  await waitMediaIdle(e)

  // "Reinício do app": registro vindo do JSON, tarefa nova.
  const rec2 = JSON.parse(JSON.stringify(saved))
  const job2 = makeTask(e, rec2)
  await job2.task.run()
  await assertDone(e, rec2, file.id)
  assert.equal(rec2.verify.state, 'ok')
  const served = e.mock.stats().bytesServed
  assert.ok(served - size <= size * 0.1, `re-download: ${served - size} bytes`)
})

test('queda simulada: retoma do ÚLTIMO persist() antes da pausa (registro velho) com lixo depois das posições', async t => {
  const e = await env(t, { mock: { perConnectionBps: 4 * MiB }, settings: { connectionsPerDownload: 4, minSegmentSize: 16 * MiB } })
  const size = 64 * MiB
  const file = e.mock.addFile('camera_b.mov', 'root', { size, seed: 41 })
  const rec = await recordFor(e, file.id)
  const job = makeTask(e, rec)
  const ac = new AbortController()
  const p = job.task.run(ac.signal)
  p.catch(() => {})
  // Espera um checkpoint periódico de verdade (progresso > 0) e "derruba" logo depois.
  await waitFor(() => job.snapshots.some(s => s.bytesDone > 0), { timeoutMs: 30_000, message: 'nenhum checkpoint com progresso' })
  await waitFor(() => liveDone(job.task) > job.snapshots.findLast(s => s.bytesDone > 0).bytesDone + 4 * MiB, { timeoutMs: 30_000 })
  const stale = JSON.parse(JSON.stringify(job.snapshots.findLast(s => s.bytesDone > 0)))
  ac.abort()
  await assert.rejects(p, err => isAbortError(err))
  await waitMediaIdle(e)
  assert.ok(stale.bytesDone > 0 && stale.bytesDone < size)
  // O que o registro velho diz ter no disco precisa estar lá (só posições pós-fdatasync são gravadas).
  await assertClaimsOnDisk(e, stale, file.id)
  // Simula escrita pela metade numa queda: lixo logo depois de cada posição durável.
  const fh = await fs.open(stale.dest.tempPath, 'r+')
  for (const s of stale.segments) {
    if (s.pos > s.end) continue
    const n = Math.min(256 * 1024, s.end + 1 - s.pos)
    await fh.write(crypto.randomBytes(n), 0, n, s.pos)
  }
  await fh.close()

  const job2 = makeTask(e, stale)
  await job2.task.run()
  await assertDone(e, stale, file.id)
  assert.equal(stale.verify.state, 'ok')
})

test('falhas: quedas, 5xx, 429 e Content-Range errado → MD5 confere', async t => {
  const e = await env(t, {
    mock: { failures: { dropDownloadProb: 0.3, error5xxProb: 0.1, error429Prob: 0.05, wrongRangeProb: 0.05 } },
    settings: { connectionsPerDownload: 16, minSegmentSize: 2 * MiB },
  })
  const size = 32 * MiB
  const file = e.mock.addFile('drone.mp4', 'root', { size, seed: 51 })
  const rec = await recordFor(e, file.id)
  const job = makeTask(e, rec, { retryBaseMs: 10 })
  await job.task.run()
  await assertDone(e, rec, file.id)
  assert.equal(rec.verify.state, 'ok')
  const f = e.mock.stats().faults
  const faults = f.downloadDrops + f.error5xx + f.error429 + f.wrongRange
  assert.ok(faults > 0, `falhas sorteadas: ${JSON.stringify(f)}`)
  assert.ok(job.task.counters.failures > 0, 'a tarefa passou por falhas e se recuperou')
  if (f.wrongRange > 0) assert.ok(job.task.counters.rangeMismatches > 0, 'Content-Range errado foi detectado')
})

test('travamento: conexão para de mandar bytes, o vigia (stallTimeoutMs 5 s) reabre e termina', async t => {
  const e = await env(t, {
    mock: { perConnectionBps: 4 * MiB, failures: { stallDownloadProb: 1 } },
    settings: { connectionsPerDownload: 2, minSegmentSize: 8 * MiB, stallTimeoutMs: 5000 },
  })
  const size = 16 * MiB
  const file = e.mock.addFile('trava.mov', 'root', { size, seed: 61 })
  const rec = await recordFor(e, file.id)
  const job = makeTask(e, rec)
  const t0 = Date.now()
  const p = job.task.run()
  await waitFor(() => e.mock.stats().faults.downloadStalls >= 2, { timeoutMs: 10_000 })
  e.mock.setOptions({ failures: {} })
  await p
  await assertDone(e, rec, file.id)
  assert.ok(job.task.counters.stalls >= 1, 'o vigia detectou o travamento')
  assert.ok(Date.now() - t0 >= 4500, 'esperou o stallTimeoutMs antes de reabrir')
})

test('roubo de segmentos: quem termina rouba metade do maior que falta (perto do fim também)', async t => {
  const e = await env(t, { mock: { perConnectionBps: 4 * MiB }, settings: { connectionsPerDownload: 3, minSegmentSize: 12 * MiB } })
  const size = 24 * MiB
  const file = e.mock.addFile('roubo.mov', 'root', { size, seed: 71 })
  const rec = await recordFor(e, file.id)
  const job = makeTask(e, rec, { stealMinBytes: 1 * MiB })
  let lateSteal = false
  let maxSegs = 0
  const p = job.task.run()
  let finished = false
  p.finally(() => (finished = true)).catch(() => {})
  let prevCount = 0
  while (!finished) {
    const live = job.task.liveSegments()
    if (live.length) {
      if (prevCount && live.length > prevCount && live.some(s => s.pos > s.end)) lateSteal = true
      prevCount = live.length
      maxSegs = Math.max(maxSegs, live.length)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await p
  await assertDone(e, rec, file.id)
  // 2 segmentos iniciais (24 MiB / 12 MiB) → a 3ª conexão rouba no começo → quem termina rouba de novo.
  assert.ok(job.task.counters.steals >= 2, `roubos: ${job.task.counters.steals}`)
  assert.ok(maxSegs >= 4, `segmentos: ${maxSegs}`)
  assert.ok(lateSteal, 'houve roubo depois de algum segmento terminar')
})

test('arquivo mudou no Drive entre a pausa e a retomada: recomeça e baixa o conteúdo NOVO', async t => {
  const e = await env(t, { mock: { perConnectionBps: 4 * MiB }, settings: { connectionsPerDownload: 2, minSegmentSize: 12 * MiB } })
  const file = e.mock.addFile('versao.mov', 'root', { size: 24 * MiB, seed: 81 })
  const rec = await recordFor(e, file.id)
  const job = makeTask(e, rec)
  await runAndPause(job, 0.4)
  await waitMediaIdle(e)
  const saved = JSON.parse(JSON.stringify(job.snapshots.at(-1)))
  assert.ok(saved.bytesDone > 0)

  const updated = e.mock.updateContent(file.id, { size: 20 * MiB, seed: 82 })
  e.mock.setOptions({ perConnectionBps: 0 })
  const job2 = makeTask(e, saved)
  const resets = []
  job2.task.on('reset', r => resets.push(r.reason))
  await job2.task.run()
  assert.deepEqual(resets, ['remoteChanged'])
  assert.equal(saved.size, 20 * MiB)
  assert.equal(saved.source.headRevisionId, updated.headRevisionId)
  const newMd5 = await e.mock.contentMd5(file.id)
  assert.equal(saved.source.md5, newMd5)
  await assertDone(e, saved, file.id)
  assert.equal(saved.verify.state, 'ok')
})

test('servidor ignora o Range (200 com tudo): vira conexão única, inclusive ao retomar', async t => {
  const e = await env(t, { mock: { ignoreRange: true, perConnectionBps: 8 * MiB }, settings: { connectionsPerDownload: 4, minSegmentSize: 4 * MiB } })
  const size = 16 * MiB
  const file = e.mock.addFile('sem-range.mov', 'root', { size, seed: 91 })
  const rec = await recordFor(e, file.id)
  const job = makeTask(e, rec)
  await runAndPause(job, 0.4)
  assert.ok(job.task.counters.singleStream >= 1, 'trocou para conexão única')
  await waitMediaIdle(e)
  const saved = JSON.parse(JSON.stringify(job.snapshots.at(-1)))
  assert.equal(saved.segments.length, 1, 'conexão única = um segmento')
  assert.ok(saved.bytesDone > 0)
  await assertClaimsOnDisk(e, saved, file.id)

  const job2 = makeTask(e, saved)
  await job2.task.run()
  await assertDone(e, saved, file.id)
  assert.ok(e.mock.stats().faults.ignoredRange >= 1)
})

test('Doc do Google é exportado (com 5xx no caminho); resourceKey vai no header', async t => {
  const e = await env(t, { mock: { failures: { error5xxProb: 0.5 } } })
  const doc = e.mock.addGoogleDoc('Roteiro', 'root', 'document', { size: 5000 })
  const rec = await recordFor(e, doc.id, { exportAs: GOOGLE_EXPORTS['application/vnd.google-apps.document'] })
  assert.equal(rec.size, null)
  const job = makeTask(e, rec)
  await job.task.run()
  assert.equal(path.basename(rec.dest.path), 'Roteiro.docx')
  assert.equal((await fs.stat(rec.dest.path)).size, 5000)
  assert.equal(rec.size, 5000)
  assert.equal(rec.bytesDone, 5000)
  assert.equal(rec.verify.state, 'skipped')
  await assert.rejects(fs.access(rec.dest.tempPath))
  assert.ok(e.mock.stats().requests['files.export'] >= 1)
  assert.equal(e.mock.stats().requests['files.media'] ?? 0, 0)

  e.mock.setOptions({ failures: {} })
  const old = e.mock.addFile('antigo.mov', 'root', { size: 3 * MiB, seed: 92, resourceKey: true })
  const rec2 = await recordFor(e, old.id)
  assert.ok(rec2.source.resourceKey)
  await makeTask(e, rec2).task.run()
  await assertDone(e, rec2, old.id)
})

test('arquivo de 0 byte: cria vazio sem nenhuma requisição', async t => {
  const e = await env(t)
  const file = e.mock.addFile('vazio.txt', 'root', { size: 0 })
  const rec = await recordFor(e, file.id)
  assert.equal(rec.size, 0)
  e.mock.resetStats()
  await makeTask(e, rec).task.run()
  assert.equal((await fs.stat(rec.dest.path)).size, 0)
  assert.deepEqual(e.mock.stats().requests, {}, 'nenhuma requisição ao Drive')
  assert.equal(rec.verify.state, 'ok')
  await assert.rejects(fs.access(rec.dest.tempPath))
})

test('download bloqueado pelo dono → fatal; cota do arquivo estourada → quota', async t => {
  const e = await env(t)
  const blocked = e.mock.addFile('bloqueado.mov', 'root', { size: 2 * MiB, seed: 93, canDownload: false })
  const rec = await recordFor(e, blocked.id)
  await assert.rejects(makeTask(e, rec).task.run(), err => {
    const info = classifyError(err)
    assert.equal(info.kind, 'fatal')
    assert.match(info.message, /bloqueou downloads/)
    return true
  })

  const hot = e.mock.addFile('viral.mov', 'root', { size: 2 * MiB, seed: 94 })
  e.mock.setOptions({ downloadQuotaExceededIds: [hot.id] })
  const rec2 = await recordFor(e, hot.id)
  await assert.rejects(makeTask(e, rec2).task.run(), err => {
    assert.equal(classifyError(err).kind, 'quota')
    return true
  })
  await assert.rejects(fs.access(rec2.dest.path), 'nada no destino final')
})

test('sem espaço no disco: fatal ENOSPC antes de criar o arquivo, sem baixar nada', async t => {
  const e = await env(t)
  const huge = e.mock.addFile('gigante.mov', 'root', { size: 2 ** 52, seed: 95 }) // 4 PiB
  const rec = await recordFor(e, huge.id)
  e.mock.resetStats()
  await assert.rejects(makeTask(e, rec).task.run(), err => {
    const info = classifyError(err)
    assert.equal(info.kind, 'fatal')
    assert.equal(info.reason, 'ENOSPC')
    assert.match(info.message, /Falta espaço no disco/)
    return true
  })
  assert.equal(e.mock.stats().requests['files.media'] ?? 0, 0)
  await assert.rejects(fs.access(rec.dest.tempPath), 'não alocou o temporário')
})

test('401 no meio do download: renova o token e continua', async t => {
  const e = await env(t, { mock: { perConnectionBps: 4 * MiB }, settings: { connectionsPerDownload: 3, minSegmentSize: 12 * MiB } })
  const size = 24 * MiB
  const file = e.mock.addFile('token.mov', 'root', { size, seed: 101 })
  const rec = await recordFor(e, file.id)
  const job = makeTask(e, rec, { stealMinBytes: 1 * MiB })
  const p = job.task.run()
  await waitFor(() => liveDone(job.task) >= size * 0.1, { timeoutMs: 30_000 })
  const before = e.mock.stats().requests['oauth.token'] ?? 0
  e.mock.expireAccessTokens()
  await p
  await assertDone(e, rec, file.id)
  assert.ok(job.task.counters.authRefreshes >= 1, 'pediu token novo')
  assert.ok((e.mock.stats().requests['oauth.token'] ?? 0) > before, 'renovou no endpoint de token')
})

test('MD5 que não confere: fatal, apaga o temporário e marca verify mismatch', async t => {
  const e = await env(t)
  const lie = '0123456789abcdef0123456789abcdef'
  const file = e.mock.addFile('mentira.bin', 'root', { size: 3 * MiB, seed: 111, md5: lie })
  const rec = await recordFor(e, file.id)
  assert.equal(rec.source.md5, lie)
  await assert.rejects(makeTask(e, rec).task.run(), err => {
    assert.equal(err.name, 'SobeDesceError')
    assert.equal(err.kind, 'fatal')
    assert.equal(err.reason, 'checksumMismatch')
    assert.equal(err.message, 'O arquivo baixado veio diferente do original (MD5 não confere). Tente de novo.')
    return true
  })
  assert.equal(rec.verify.state, 'mismatch')
  assert.equal(rec.verify.expected, lie)
  assert.equal(rec.verify.actual, await e.mock.contentMd5(file.id))
  assert.deepEqual(rec.segments, [])
  assert.equal(rec.bytesDone, 0)
  await assert.rejects(fs.access(rec.dest.tempPath), 'temporário apagado')
  await assert.rejects(fs.access(rec.dest.path), 'nada no destino final')
})

test('destino passou a existir: usa nome único e não sobrescreve', async t => {
  const e = await env(t)
  const file = e.mock.addFile('Cena 1.mov', 'root', { size: 1 * MiB, seed: 121 })
  const rec = await recordFor(e, file.id)
  await fs.mkdir(e.destDir, { recursive: true })
  await fs.writeFile(rec.dest.path, 'não apague')
  await makeTask(e, rec).task.run()
  assert.equal(path.basename(rec.dest.path), 'Cena 1 (2).mov')
  assert.equal(await fs.readFile(path.join(e.destDir, 'Cena 1.mov'), 'utf8'), 'não apague')
  assert.equal(await md5File(rec.dest.path), await e.mock.contentMd5(file.id))
})

test('limitador de banda a 8 MB/s segura a vazão (±30%)', async t => {
  const rate = 8_000_000
  const e = await env(t, { limit: rate, settings: { connectionsPerDownload: 4, minSegmentSize: 4 * MiB, verifyChecksums: false } })
  const size = 24_000_000
  const file = e.mock.addFile('limitado.mov', 'root', { size, seed: 131 })
  const rec = await recordFor(e, file.id)
  const job = makeTask(e, rec)
  const t0 = Date.now()
  await job.task.run()
  const secs = (Date.now() - t0) / 1000
  const bps = size / secs
  assert.ok(bps >= rate * 0.7 && bps <= rate * 1.3, `vazão: ${(bps / 1e6).toFixed(2)} MB/s`)
  assert.equal(await md5File(rec.dest.path), await e.mock.contentMd5(file.id))
})
