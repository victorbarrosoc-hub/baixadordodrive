// TransferManager: agendamento com limites vivos, prioridade, pausar/retomar/cancelar/tentar de novo/remover,
// persistência e recuperação ao reabrir, cota (espera e volta sozinho), reconectar conta, eventos limitados,
// URI de sessão fora da interface — com tarefas falsas (controle total) e com as tarefas de verdade contra o mock.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { TransferManager } from '../src/engine/manager.js'
import { Settings, dataPaths } from '../src/config.js'
import { readJSON } from '../src/util/store.js'
import { HttpError, closeHttp } from '../src/net/http.js'
import { SobeDesceError } from '../src/google/errors.js'
import { DriveClient } from '../src/google/drive.js'
import { Hasher } from '../src/engine/hasher.js'
import { planDownloads, planUploads } from '../src/engine/planner.js'
import { PART_SUFFIX } from '../src/util/paths.js'
import { makeTmpDir, waitFor, setupDrive, randomFile, md5File } from './helpers.js'
import { virtualMd5 } from './mock-drive.js'

const MiB = 1024 * 1024

after(() => closeHttp())

// ─────────── tarefas falsas ───────────

function abortErr() {
  const e = new Error('Interrompido.')
  e.name = 'AbortError'
  return e
}

/** Controle das tarefas falsas: quem começou, terminar/falhar cada uma, contexto recebido. */
function fakeTasks() {
  const ctl = new EventEmitter()
  ctl.started = []
  ctl.live = new Map()
  ctl.ctxs = new Map()
  ctl.tasks = new Map()
  ctl.create = (record, ctx) => {
    const task = {
      record,
      _speed: 0,
      speed() {
        return this._speed
      },
      liveBytes() {
        return record.bytesDone || 0
      },
      run(signal) {
        ctl.started.push(record.id)
        ctl.ctxs.set(record.id, ctx)
        ctl.tasks.set(record.id, task)
        return new Promise((resolve, reject) => {
          const end = fn => value => {
            if (ctl.live.get(record.id)?.task !== task) return
            ctl.live.delete(record.id)
            signal.removeEventListener('abort', onAbort)
            fn(value)
          }
          const onAbort = () => end(reject)(abortErr())
          ctl.live.set(record.id, { task, resolve: end(resolve), reject: end(reject) })
          if (signal.aborted) return onAbort()
          signal.addEventListener('abort', onAbort, { once: true })
          ctl.emit('start', record.id)
        })
      },
    }
    return task
  }
  ctl.finish = id => ctl.live.get(id)?.resolve()
  ctl.fail = (id, err) => ctl.live.get(id)?.reject(err)
  ctl.count = id => ctl.started.filter(x => x === id).length
  ctl.running = () => [...ctl.live.keys()].sort()
  return ctl
}

let seq = 0
function dl(dir, id, extra = {}) {
  const dest = path.join(dir, `${id}.mov`)
  return {
    id,
    type: 'download',
    accountId: 'acc1',
    batchId: 'b1',
    status: 'queued',
    name: `${id}.mov`,
    relPath: `${id}.mov`,
    size: 1000,
    bytesDone: 0,
    createdAt: 1_000_000 + seq++,
    source: { fileId: `f-${id}`, mimeType: 'video/quicktime', md5: null },
    dest: { path: dest, tempPath: dest + PART_SUFFIX },
    segments: null,
    ...extra,
  }
}

function up(id, extra = {}) {
  return {
    id,
    type: 'upload',
    accountId: 'acc1',
    batchId: 'b2',
    status: 'queued',
    name: `${id}.wav`,
    relPath: `${id}.wav`,
    size: 1000,
    bytesDone: 0,
    createdAt: 1_000_000 + seq++,
    local: { path: `/tmp/sobedesce-nao-existe/${id}.wav`, size: 1000, mtimeMs: 1 },
    target: { rootId: 'root', relDir: '', parentId: null, driveId: null, replaceFileId: null, fileId: null },
    session: null,
    ...extra,
  }
}

const batch = (id, type = 'download', accountId = 'acc1') => ({ id, type, label: `Lote ${id}`, createdAt: Date.now(), accountId })

function fakeKeepAwake() {
  return {
    active: false,
    calls: [],
    setActive(v) {
      this.calls.push(!!v)
      this.active = !!v
    },
    stop() {
      this.active = false
    },
  }
}

async function makeManager(t, { settings = {}, home, ctl, auth, keep = false, ...opts } = {}) {
  home ??= await makeTmpDir('sobedesce-manager-')
  const paths = dataPaths(home)
  const s = new Settings(paths.settings)
  await s.load()
  await s.update({ keepAwake: false, ...settings })
  const keepAwake = fakeKeepAwake()
  const m = new TransferManager({ settings: s, auth: auth ?? new EventEmitter(), paths, driveFactory: () => ({}), keepAwake, createTask: ctl?.create, quotaDelays: [60_000], ...opts })
  await m.init()
  t.after(async () => {
    await m.shutdown()
    if (!keep) await fs.rm(home, { recursive: true, force: true, maxRetries: 3 })
  })
  return { m, s, paths, home, keepAwake }
}

const statusOf = (m, id) => m.get(id)?.status

// ─────────── agendamento ───────────

test('respeita os limites por direção, a ordem da fila e muda na hora quando o ajuste muda', async t => {
  const ctl = fakeTasks()
  const dir = await makeTmpDir()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const { m, s, keepAwake } = await makeManager(t, { ctl, settings: { maxConcurrentDownloads: 2, maxConcurrentUploads: 1, keepAwake: true } })
  const downs = ['d1', 'd2', 'd3', 'd4'].map(id => dl(dir, id))
  const ups = ['u1', 'u2', 'u3'].map(id => up(id))
  await m.add({ batch: batch('b1'), records: downs })
  await m.add({ batch: batch('b2', 'upload'), records: ups })
  await waitFor(() => ctl.live.size === 3)
  assert.deepEqual(ctl.running(), ['d1', 'd2', 'u1'])
  assert.equal(statusOf(m, 'd3'), 'queued')
  assert.equal(keepAwake.active, true, 'KeepAwake liga enquanto há transferência')
  let st = m.stats()
  assert.equal(st.down.active, 2)
  assert.equal(st.down.queued, 2)
  assert.equal(st.up.active, 1)
  assert.equal(st.up.queued, 2)

  ctl.finish('d1')
  await waitFor(() => ctl.live.has('d3'))
  assert.equal(statusOf(m, 'd1'), 'completed')
  assert.equal(m.get('d1').bytesDone, 1000)
  assert.ok(m.get('d1').finishedAt > 0)

  // Mais vagas: começa na hora.
  await s.update({ maxConcurrentDownloads: 3 })
  await waitFor(() => ctl.live.has('d4'))
  assert.deepEqual(ctl.running().filter(x => x.startsWith('d')), ['d2', 'd3', 'd4'])

  // Menos vagas: os últimos da fila voltam para 'queued' (não 'paused').
  await s.update({ maxConcurrentDownloads: 1 })
  await waitFor(() => ctl.running().filter(x => x.startsWith('d')).length === 1)
  assert.deepEqual(ctl.running().filter(x => x.startsWith('d')), ['d2'], 'fica o mais antigo da fila')
  await waitFor(() => statusOf(m, 'd3') === 'queued' && statusOf(m, 'd4') === 'queued')

  ctl.finish('d2')
  await waitFor(() => ctl.live.has('d3'))
  assert.equal(ctl.count('d3'), 2, 'o interrompido recomeça depois')
  st = m.stats()
  assert.equal(st.down.active, 1)
  assert.equal(st.totals.count, 7)
})

test('prioridade: "passar na frente" vai para o começo da fila; pausado volta para a fila', async t => {
  const ctl = fakeTasks()
  const dir = await makeTmpDir()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const { m } = await makeManager(t, { ctl, settings: { maxConcurrentDownloads: 1 } })
  await m.add({ batch: batch('b1'), records: ['p1', 'p2', 'p3', 'p4', 'p5'].map(id => dl(dir, id)) })
  await waitFor(() => ctl.live.has('p1'))
  await m.pause(['p5'])
  assert.equal(statusOf(m, 'p5'), 'paused')
  await m.prioritize(['p4', 'p5'])
  assert.equal(statusOf(m, 'p5'), 'queued')
  assert.ok(m.get('p4').priority > m.get('p5').priority, 'o primeiro id fica na frente')
  assert.ok(m.get('p5').priority > (m.get('p2').priority || 0))
  ctl.finish('p1')
  await waitFor(() => ctl.live.has('p4'))
  ctl.finish('p4')
  await waitFor(() => ctl.live.has('p5'))
  ctl.finish('p5')
  await waitFor(() => ctl.live.has('p2'))
})

// ─────────── ações ───────────

test('pausar, retomar, cancelar (apaga o temporário / encerra a sessão), tentar de novo e remover', async t => {
  const ctl = fakeTasks()
  const dir = await makeTmpDir()
  // Servidor que faz papel da URI de sessão: registra o DELETE.
  const seen = []
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url })
    res.writeHead(499)
    res.end()
  })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => srv.close(resolve))
    await fs.rm(dir, { recursive: true, force: true })
  })
  const { m } = await makeManager(t, { ctl, settings: { maxConcurrentDownloads: 2, maxConcurrentUploads: 2 } })
  const removed = []
  const batchesSeen = []
  m.on('removed', ids => removed.push(...ids))
  m.on('batches', list => batchesSeen.push(list.map(b => b.id)))

  const a = dl(dir, 'a')
  const b = dl(dir, 'b')
  await m.add({ batch: batch('b1'), records: [a, b] })
  await waitFor(() => ctl.live.has('a') && ctl.live.has('b'))

  // pausa → 'paused' depois que a tarefa para; retomar → roda de novo
  await m.pause(['a'])
  assert.equal(statusOf(m, 'a'), 'paused')
  assert.ok(!ctl.live.has('a'))
  await m.resume(['a'])
  await waitFor(() => ctl.live.has('a'))
  assert.equal(ctl.count('a'), 2)

  // cancelar download rodando: o temporário some depois que a tarefa solta o arquivo
  await fs.writeFile(a.dest.tempPath, 'parcial')
  a.segments = [{ start: 0, end: 999, pos: 7 }]
  await m.cancel(['a'])
  assert.equal(statusOf(m, 'a'), 'canceled')
  await assert.rejects(fs.stat(a.dest.tempPath), { code: 'ENOENT' })
  assert.equal(m.get('a').bytesDone, 0)
  assert.equal(m.get('a').segments, null)

  // tentar de novo um cancelado → volta para a fila e roda; falha fatal → 'failed' com mensagem
  await m.retry(['a'])
  await waitFor(() => ctl.live.has('a'))
  ctl.fail('a', new SobeDesceError('fatal', 'Sem permissão para gravar na pasta de destino.', { reason: 'EACCES' }))
  await waitFor(() => statusOf(m, 'a') === 'failed')
  assert.equal(m.get('a').error.message, 'Sem permissão para gravar na pasta de destino.')
  assert.equal(m.get('a').error.kind, 'fatal')
  await m.retry(['a'])
  await waitFor(() => ctl.live.has('a'))
  assert.equal(m.get('a').error, null)
  assert.equal(m.get('a').attempts, 0)

  // cancelar upload parado: DELETE na URI da sessão (melhor esforço) e a sessão sai do registro
  const u = up('u', { status: 'paused', session: { uri: `http://127.0.0.1:${srv.address().port}/upload/drive/v3/files?uploadType=resumable&upload_id=XYZ`, createdAt: Date.now(), offset: 0 } })
  await m.add({ batch: batch('bu', 'upload'), records: [u] })
  await m.cancel(['u'])
  assert.equal(statusOf(m, 'u'), 'canceled')
  assert.deepEqual(seen.map(x => x.method), ['DELETE'])
  assert.match(seen[0].url, /upload_id=XYZ/)
  assert.equal(u.session, null)

  // remover rodando: aborta, limpa e some da lista (e o lote vazio também)
  await fs.writeFile(b.dest.tempPath, 'x')
  await m.remove(['b'])
  assert.equal(m.get('b'), null)
  assert.ok(!ctl.live.has('b'))
  await assert.rejects(fs.stat(b.dest.tempPath), { code: 'ENOENT' })
  await waitFor(() => removed.includes('b'))

  // limpar concluídas
  ctl.finish('a')
  await waitFor(() => statusOf(m, 'a') === 'completed')
  m.clearFinished()
  assert.equal(m.get('a'), null)
  assert.equal(m.get('u'), null)
  await waitFor(() => removed.includes('a') && removed.includes('u'))
  await waitFor(() => batchesSeen.some(list => list.length === 0))
  assert.equal(m.snapshot().transfers.length, 0)
  assert.equal(m.snapshot().batches.length, 0)
})

test('ações por lote e "pausar tudo"/"retomar tudo"', async t => {
  const ctl = fakeTasks()
  const dir = await makeTmpDir()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const { m } = await makeManager(t, { ctl, settings: { maxConcurrentDownloads: 2 } })
  await m.add({ batch: batch('x'), records: [dl(dir, 'x1', { batchId: 'x' }), dl(dir, 'x2', { batchId: 'x' })] })
  await m.add({ batch: batch('y'), records: [dl(dir, 'y1', { batchId: 'y' })] })
  await waitFor(() => ctl.live.size === 2)
  await m.pauseBatch('x')
  assert.equal(statusOf(m, 'x1'), 'paused')
  assert.equal(statusOf(m, 'x2'), 'paused')
  await waitFor(() => ctl.live.has('y1'))
  await m.pause('all')
  assert.equal(statusOf(m, 'y1'), 'paused')
  assert.equal(ctl.live.size, 0)
  await m.resume('all')
  await waitFor(() => ctl.live.size === 2)
  await m.cancelBatch('x')
  assert.equal(statusOf(m, 'x1'), 'canceled')
  assert.equal(statusOf(m, 'x2'), 'canceled')
})

test('tarefa que termina como "skipped" continua skipped', async t => {
  const ctl = fakeTasks()
  const { m } = await makeManager(t, { ctl })
  const u = up('s1')
  await m.add({ batch: batch('b2', 'upload'), records: [u] })
  await waitFor(() => ctl.live.has('s1'))
  u.status = 'skipped'
  u.note = 'Já estava no Drive'
  ctl.finish('s1')
  await waitFor(() => !ctl.live.has('s1') && !m.entries.has('s1'))
  assert.equal(statusOf(m, 's1'), 'skipped')
  assert.equal(m.get('s1').note, 'Já estava no Drive')
})

// ─────────── cota e reconexão ───────────

test('cota de download do arquivo: espera com atraso crescente e volta sozinho; os outros seguem', async t => {
  const ctl = fakeTasks()
  const dir = await makeTmpDir()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const { m } = await makeManager(t, { ctl, settings: { maxConcurrentDownloads: 1 }, quotaDelays: [150, 400, 5000] })
  await m.add({ batch: batch('b1'), records: [dl(dir, 'q1'), dl(dir, 'q2')] })
  await waitFor(() => ctl.live.has('q1'))
  const quota = () => new HttpError(403, { body: { error: { errors: [{ reason: 'downloadQuotaExceeded' }], message: 'The download quota for this file has been exceeded.' } } })
  let t0 = Date.now()
  ctl.fail('q1', quota())
  await waitFor(() => statusOf(m, 'q1') === 'waiting')
  const w = m.get('q1')
  assert.equal(w.error.kind, 'quota')
  assert.equal(w.error.reason, 'downloadQuotaExceeded')
  assert.ok(w.retryAt >= t0 + 140 && w.retryAt <= Date.now() + 200, `retryAt fora do esperado: ${w.retryAt - t0}`)
  await waitFor(() => ctl.live.has('q2'), { message: 'o outro arquivo deveria seguir' })
  ctl.finish('q2')
  await waitFor(() => ctl.count('q1') === 2, { timeoutMs: 5000 })
  t0 = Date.now()
  ctl.fail('q1', quota())
  await waitFor(() => statusOf(m, 'q1') === 'waiting')
  assert.ok(m.get('q1').retryAt - t0 >= 350, 'a segunda espera é maior')
  await waitFor(() => ctl.count('q1') === 3, { timeoutMs: 5000 })
  ctl.finish('q1')
  await waitFor(() => statusOf(m, 'q1') === 'completed')
})

test('limite diário de upload: espera, os próximos envios da conta esperam junto, e todos voltam sozinhos', async t => {
  const ctl = fakeTasks()
  const { m } = await makeManager(t, { ctl, settings: { maxConcurrentUploads: 1 }, quotaMaxMs: 200 })
  await m.add({ batch: batch('b2', 'upload'), records: [up('c1'), up('c2'), up('c3'), up('o1', { accountId: 'acc2' })] })
  await waitFor(() => ctl.live.has('c1'))
  ctl.fail('c1', new SobeDesceError('quota', 'Você atingiu o limite de upload do Google (750 GB por dia). Retomo sozinho mais tarde.', { reason: 'uploadLimitExceeded', retryAfterMs: 3_600_000, status: 403 }))
  await waitFor(() => statusOf(m, 'c1') === 'waiting')
  assert.equal(statusOf(m, 'c2'), 'waiting')
  assert.equal(statusOf(m, 'c3'), 'waiting')
  assert.equal(m.get('c2').retryAt, m.get('c1').retryAt)
  await waitFor(() => ctl.live.has('o1'), { message: 'outra conta não espera' })
  ctl.finish('o1')
  await waitFor(() => ctl.live.has('c1') || ctl.live.has('c2'), { timeoutMs: 3000 })
  await waitFor(() => ['c1', 'c2', 'c3'].every(id => statusOf(m, id) !== 'waiting'), { timeoutMs: 3000 })
})

test('reconectar conta: pausa tudo dela com o aviso (uma vez) e retoma sozinho quando a conta volta', async t => {
  const ctl = fakeTasks()
  const dir = await makeTmpDir()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const auth = new EventEmitter()
  const { m } = await makeManager(t, { ctl, auth, settings: { maxConcurrentDownloads: 2 } })
  const toasts = []
  m.on('toast', x => toasts.push(x))
  await m.add({ batch: batch('b1'), records: [dl(dir, 'r1'), dl(dir, 'r2'), dl(dir, 'r3'), dl(dir, 'r4'), dl(dir, 'o1', { accountId: 'acc2' })] })
  await waitFor(() => ctl.live.has('r1') && ctl.live.has('r2'))
  await m.pause(['r4']) // pausado à mão: não ganha o erro nem volta sozinho
  const msg = 'O acesso à conta ana@example.com expirou ou foi revogado. Conecte a conta de novo.'
  ctl.fail('r1', new SobeDesceError('reauth', msg, { reason: 'invalid_grant' }))
  await waitFor(() => ['r1', 'r2', 'r3'].every(id => statusOf(m, id) === 'paused'))
  for (const id of ['r1', 'r2', 'r3']) {
    assert.equal(m.get(id).error.kind, 'reauth', id)
    assert.equal(m.get(id).error.message, msg)
  }
  assert.equal(m.get('r4').error, null)
  await waitFor(() => ctl.live.has('o1'), { message: 'a outra conta continua' })
  assert.equal(toasts.filter(x => x.kind === 'error').length, 1)
  assert.equal(toasts[0].message, msg)

  // Ainda sem reconectar: retomar à mão e falhar de novo não repete o aviso.
  await m.resume(['r1'])
  await waitFor(() => ctl.live.has('r1'))
  ctl.fail('r1', new SobeDesceError('reauth', msg, { reason: 'invalid_grant' }))
  await waitFor(() => statusOf(m, 'r1') === 'paused')
  assert.equal(toasts.filter(x => x.kind === 'error').length, 1)

  auth.emit('accounts', [{ id: 'acc1', status: 'ok' }, { id: 'acc2', status: 'ok' }])
  await waitFor(() => ctl.live.has('r1') || ctl.live.has('r2') || ctl.live.has('r3'))
  for (const id of ['r1', 'r2', 'r3']) assert.notEqual(statusOf(m, id), 'paused', id)
  assert.equal(statusOf(m, 'r4'), 'paused')

  // Conta removida do app: o que é dela para na hora (sem aviso extra: a pessoa acabou de remover).
  assert.ok(ctl.live.has('o1'))
  auth.emit('accounts', [{ id: 'acc1', status: 'ok' }])
  await waitFor(() => statusOf(m, 'o1') === 'paused')
  assert.equal(m.get('o1').error.kind, 'reauth')
  assert.equal(toasts.filter(x => x.kind === 'error').length, 1)
  auth.emit('accounts', [{ id: 'acc1', status: 'ok' }, { id: 'acc2', status: 'ok' }])
  await waitFor(() => ['queued', 'running'].includes(statusOf(m, 'o1')), { message: 'conectou de novo: volta sozinho' })
  assert.equal(m.get('o1').error, null)
})

test('falhas: "retry" anunciado pela tarefa volta sozinho algumas vezes; esgotado vira failed com mensagem final', async t => {
  const ctl = fakeTasks()
  const dir = await makeTmpDir()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const { m } = await makeManager(t, { ctl, settings: { maxConcurrentDownloads: 1 } })
  await m.add({ batch: batch('b1'), records: [dl(dir, 'x')] })
  for (let i = 1; i <= 4; i++) {
    await waitFor(() => ctl.count('x') === i && ctl.live.has('x'))
    ctl.fail('x', new SobeDesceError('retry', 'O arquivo mudou no Drive durante o download. Vou tentar de novo.', { reason: 'remoteChanged' }))
  }
  await waitFor(() => statusOf(m, 'x') === 'failed')
  assert.equal(ctl.count('x'), 4)
  assert.doesNotMatch(m.get('x').error.message, /Vou tentar/)
  await m.retry(['x'])
  await waitFor(() => ctl.count('x') === 5)
  ctl.fail('x', new SobeDesceError('retry', 'A conexão com o Google falhou muitas vezes seguidas. Tente de novo daqui a pouco.', { reason: 'ECONNRESET' }))
  await waitFor(() => statusOf(m, 'x') === 'failed')
  assert.equal(m.get('x').error.message, 'A conexão com o Google falhou muitas vezes seguidas. Tente de novo daqui a pouco.')
})

// ─────────── eventos e o que sai para a interface ───────────

test('eventos: transfers no máximo ~4×/s e só com o que mudou; stats 2×/s; batches e removed', async t => {
  const ctl = fakeTasks()
  const dir = await makeTmpDir()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const { m } = await makeManager(t, { ctl, settings: { maxConcurrentDownloads: 1 } })
  const events = []
  const stats = []
  const batches = []
  m.on('transfers', list => events.push({ at: Date.now(), ids: list.map(x => x.id) }))
  m.on('stats', s => stats.push(s))
  m.on('batches', list => batches.push(list))
  await m.add({ batch: batch('b1'), records: [dl(dir, 'e1'), dl(dir, 'e2'), dl(dir, 'e3')] })
  await waitFor(() => ctl.live.has('e1'))
  await waitFor(() => batches.length >= 1)
  assert.deepEqual(batches[0].map(b => b.id), ['b1'])
  await new Promise(resolve => setTimeout(resolve, 300))
  const ctx = ctl.ctxs.get('e1')
  const rec = ctl.tasks.get('e1').record
  events.length = 0
  stats.length = 0
  const t0 = Date.now()
  // Uma tarefa que pede gravação sem parar (progresso) não pode virar uma enxurrada de eventos.
  while (Date.now() - t0 < 1200) {
    rec.bytesDone = Math.min(1000, rec.bytesDone + 1)
    ctx.persist()
    await new Promise(resolve => setImmediate(resolve))
  }
  await new Promise(resolve => setTimeout(resolve, 300))
  const span = (Date.now() - t0) / 1000
  assert.ok(events.length >= 2, `poucos eventos: ${events.length}`)
  assert.ok(events.length <= span * 4 + 2, `eventos demais: ${events.length} em ${span.toFixed(1)} s`)
  for (const e of events) assert.deepEqual(e.ids, ['e1'], 'só o que mudou (o que roda)')
  assert.ok(stats.length >= 1 && stats.length <= span * 2 + 2, `stats: ${stats.length} em ${span.toFixed(1)} s`)
  const s = stats.at(-1)
  for (const k of ['down', 'up', 'totals', 'eta', 'history', 'keepAwake', 'usage']) assert.ok(k in s, k)
  assert.deepEqual(Object.keys(s.down).sort(), ['active', 'queued', 'speed'])
})

test('PublicTransfer nunca leva a URI da sessão (nem no snapshot, nem nos eventos)', async t => {
  const ctl = fakeTasks()
  const { m } = await makeManager(t, { ctl, settings: { maxConcurrentUploads: 1 } })
  const sent = []
  m.on('transfers', list => sent.push(JSON.stringify(list)))
  const secret = 'http://127.0.0.1:9/upload/drive/v3/files?uploadType=resumable&upload_id=SEGREDO-123'
  const u = up('sec', { size: 10 * MiB, session: { uri: secret, createdAt: Date.now(), offset: 262144 }, bytesDone: 262144 })
  await m.add({ batch: batch('b2', 'upload'), records: [u, up('sec2', { status: 'paused', session: { uri: secret + '2', createdAt: 1, offset: 0 } })] })
  await waitFor(() => ctl.live.has('sec'))
  await waitFor(() => sent.length >= 1)
  const pub = m.get('sec')
  assert.ok(!('session' in pub))
  assert.equal(pub.bytesDone, 262144)
  for (const text of [JSON.stringify(m.snapshot()), JSON.stringify(pub), ...sent]) {
    assert.ok(!text.includes('SEGREDO'), 'vazou a URI')
    assert.ok(!text.includes('upload_id'), 'vazou a URI')
  }
  // ...mas ela está no registro interno (e no disco) para retomar
  assert.equal(u.session.uri, secret)
})

test('download que vai para o mesmo arquivo: repetido sai, outro vira "nome (2)"; envio repetido sai', async t => {
  const ctl = fakeTasks()
  const dir = await makeTmpDir()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const { m } = await makeManager(t, { ctl, settings: { maxConcurrentDownloads: 1 } })
  const first = dl(dir, 'same')
  await m.add({ batch: batch('b1'), records: [first] })
  const dup = dl(dir, 'dupe', { dest: { ...first.dest }, source: { ...first.source }, name: first.name })
  const other = dl(dir, 'other', { dest: { ...first.dest }, source: { fileId: 'outro-arquivo' }, name: first.name, relPath: `Pasta/${first.name}` })
  const res = await m.add({ batch: batch('b3'), records: [dup, other] })
  assert.deepEqual(res.records.map(r => r.id), ['other'])
  assert.deepEqual(res.dropped.map(r => r.id), ['dupe'])
  assert.equal(other.dest.path, path.join(dir, 'same (2).mov'))
  assert.equal(other.dest.tempPath, path.join(dir, 'same (2).mov') + PART_SUFFIX)
  assert.equal(other.name, 'same (2).mov')
  assert.equal(other.relPath, 'Pasta/same (2).mov')
  assert.ok(m.reservedPaths().includes(other.dest.path))

  const u1 = up('up1')
  await m.add({ batch: batch('b2', 'upload'), records: [u1] })
  const again = await m.add({ batch: batch('b4', 'upload'), records: [up('up2', { local: { ...u1.local }, name: u1.name })] })
  assert.equal(again.records.length, 0)
  assert.ok(!m.snapshot().batches.some(b => b.id === 'b4'), 'lote sem nada novo não entra')
})

// ─────────── persistência ───────────

test('fila gravada: reabrir retoma "running" (autoResume) ou pausa; "waiting" mantém o retryAt; gravação na hora quando precisa', async t => {
  const ctl = fakeTasks()
  const dir = await makeTmpDir()
  const home = await makeTmpDir('sobedesce-manager-')
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  })
  const first = await makeManager(t, { ctl, home, keep: true, settings: { maxConcurrentDownloads: 1, maxConcurrentUploads: 1 } })
  const retryAt = Date.now() + 400
  const u = up('u1')
  await first.m.add({
    batch: batch('b1'),
    records: [dl(dir, 'run'), dl(dir, 'que'), dl(dir, 'pau', { status: 'paused' }), dl(dir, 'wai', { status: 'waiting', retryAt, error: { message: 'cota', kind: 'quota', reason: 'downloadQuotaExceeded', at: 1 } })],
  })
  await first.m.add({ batch: batch('b2', 'upload'), records: [u] })
  await waitFor(() => ctl.live.has('run') && ctl.live.has('u1'))

  // URI de sessão nova vai para o disco NA HORA (persist devolve a promessa da gravação).
  u.session = { uri: 'http://127.0.0.1:9/upload?upload_id=NOVA', createdAt: Date.now(), offset: 0 }
  const saving = ctl.ctxs.get('u1').persist()
  assert.ok(saving && typeof saving.then === 'function')
  await saving
  let disk = await readJSON(first.paths.queue)
  assert.equal(disk.transfers.find(r => r.id === 'u1').session.uri, 'http://127.0.0.1:9/upload?upload_id=NOVA')
  // Download que volta para trás também grava na hora (o temporário vai ser recriado).
  const run = ctl.tasks.get('run').record
  run.bytesDone = 500
  run.segments = [{ start: 0, end: 999, pos: 500 }]
  assert.equal(ctl.ctxs.get('run').persist(), undefined, 'progresso normal é agrupado')
  run.bytesDone = 0
  run.segments = [{ start: 0, end: 999, pos: 0 }]
  await ctl.ctxs.get('run').persist()
  disk = await readJSON(first.paths.queue)
  assert.equal(disk.transfers.find(r => r.id === 'run').bytesDone, 0)

  await first.m.shutdown()
  disk = await readJSON(first.paths.queue)
  const byId = Object.fromEntries(disk.transfers.map(r => [r.id, r]))
  assert.equal(byId.run.status, 'running', 'encerrar não marca como pausado: a próxima abertura decide')
  assert.equal(byId.que.status, 'queued')
  assert.equal(byId.pau.status, 'paused')
  assert.equal(byId.wai.status, 'waiting')
  assert.equal(byId.wai.retryAt, retryAt)
  assert.deepEqual(disk.batches.map(b => b.id).sort(), ['b1', 'b2'])

  // Reabre com autoResume: 'running' volta para a fila e roda primeiro (mais antigo); 'waiting' espera o retryAt.
  const ctl2 = fakeTasks()
  const second = await makeManager(t, { ctl: ctl2, home, keep: true, settings: { maxConcurrentDownloads: 1, maxConcurrentUploads: 1, autoResume: true } })
  await waitFor(() => ctl2.live.has('run'))
  assert.equal(statusOf(second.m, 'pau'), 'paused')
  assert.equal(statusOf(second.m, 'wai'), 'waiting')
  assert.equal(second.m.get('wai').retryAt, retryAt)
  await waitFor(() => ctl2.live.has('u1'))
  assert.equal(ctl2.tasks.get('u1').record.session.uri, 'http://127.0.0.1:9/upload?upload_id=NOVA', 'a sessão sobrevive para retomar')
  ctl2.finish('run')
  await waitFor(() => ctl2.live.has('que') || ctl2.live.has('wai'))
  ctl2.finish('que')
  await waitFor(() => statusOf(second.m, 'wai') !== 'waiting', { timeoutMs: 3000 })
  await second.m.shutdown()

  // Sem autoResume: o que estava rodando abre pausado.
  const ctl3 = fakeTasks()
  const third = await makeManager(t, { ctl: ctl3, home, keep: true, settings: { autoResume: false } })
  assert.equal(statusOf(third.m, 'u1'), 'paused')
  assert.equal(third.m.get('u1').error, null)
})

test('uso das últimas 24 h por conta (usage.json) e velocidade por direção', async t => {
  const ctl = fakeTasks()
  const dir = await makeTmpDir()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const { m, paths } = await makeManager(t, { ctl, keep: true })
  await m.add({ batch: batch('b1'), records: [dl(dir, 'g1')] })
  await m.add({ batch: batch('b2', 'upload'), records: [up('g2', { accountId: 'acc2' })] })
  await waitFor(() => ctl.live.has('g1') && ctl.live.has('g2'))
  for (let i = 0; i < 10; i++) {
    ctl.ctxs.get('g1').onBytes(500_000)
    ctl.ctxs.get('g2').onBytes(100_000)
  }
  const s = m.stats()
  assert.equal(s.usage.acc1.down24h, 5_000_000)
  assert.equal(s.usage.acc1.up24h, 0)
  assert.equal(s.usage.acc2.up24h, 1_000_000)
  assert.ok(s.down.speed > 0)
  assert.ok(s.up.speed > 0)
  await m.shutdown()
  const disk = await readJSON(path.join(paths.root, 'usage.json'))
  const buckets = Object.values(disk.accounts.acc1)
  assert.equal(buckets.reduce((a, b) => a + b.down, 0), 5_000_000)
  await fs.rm(paths.root, { recursive: true, force: true })
})

// ─────────── tarefas de verdade contra o Drive falso ───────────

async function realSetup(t, mockOptions = {}, settings = {}) {
  const env = await setupDrive(mockOptions)
  const dir = await makeTmpDir('sobedesce-manager-files-')
  const hasher = new Hasher({ cacheFile: path.join(env.home, 'hash-cache.json'), log: () => {} })
  t.after(async () => {
    await hasher.close()
    await env.cleanup()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })
  })
  const make = async () => {
    const s = new Settings(env.paths.settings)
    await s.load()
    await s.update({ keepAwake: false, connectionsPerDownload: 4, minSegmentSize: MiB, ...settings })
    const m = new TransferManager({
      settings: s,
      auth: env.auth,
      hasher,
      paths: env.paths,
      keepAwake: fakeKeepAwake(),
      driveFactory: id => new DriveClient(env.auth, id, { ratePerSec: 1000, retryBaseMs: 5 }),
      taskOptions: { download: { retryBaseMs: 5, checkpointMs: 150, tickMs: 50 }, upload: { retryBaseMs: 5 } },
    })
    await m.init()
    t.after(() => m.shutdown())
    return { m, s }
  }
  return { env, dir, hasher, make }
}

test('download e upload de verdade pela fila (mock), com pausa no meio e retomada sem corromper', async t => {
  const { env, dir, make } = await realSetup(t, { perConnectionBps: 1 * MiB })
  const size = 12 * MiB
  const item = env.mock.addFile('Bruto A001.mov', 'root', { size, seed: 7 })
  const { m } = await make()
  const drive = m.driveFor(env.accountId)
  const plan = await planDownloads({ drive, accountId: env.accountId, items: [{ id: item.id }], destDir: dir })
  assert.equal(plan.records.length, 1)
  await m.add({ batch: plan.batch, records: plan.records })
  const id = plan.records[0].id
  await waitFor(() => (m.get(id)?.bytesDone || 0) > 1 * MiB, { timeoutMs: 15_000, message: 'o download não andou' })
  const live = m.get(id)
  assert.equal(live.status, 'running')
  assert.ok(Array.isArray(live.segments) && live.segments.length >= 2, 'segmentos ao vivo')
  assert.ok(live.segments.length <= 32)
  await m.pause([id])
  assert.equal(m.get(id).status, 'paused')
  const tempPath = plan.records[0].dest.tempPath
  assert.ok((await fs.stat(tempPath)).size === size, 'temporário fica para retomar')
  env.mock.setOptions({ perConnectionBps: 0 })
  await m.resume([id])
  await waitFor(() => m.get(id).status === 'completed', { timeoutMs: 20_000, message: 'o download não terminou' })
  const done = m.get(id)
  assert.equal(done.bytesDone, size)
  assert.equal(done.verify.state, 'ok')
  assert.equal(await md5File(done.dest.path), await virtualMd5(7, size))
  await assert.rejects(fs.stat(tempPath), { code: 'ENOENT' })
  assert.ok(m.stats().usage[env.accountId].down24h >= size)

  // Upload de um arquivo local de verdade.
  const local = path.join(dir, 'envio', 'Som Direto.wav')
  const md5 = await randomFile(local, 5 * MiB + 123, 11)
  const upPlan = await planUploads({ drive, accountId: env.accountId, paths: [local], destFolderId: 'root' })
  await m.add({ batch: upPlan.batch, records: upPlan.records })
  const upId = upPlan.records[0].id
  await waitFor(() => ['completed', 'failed'].includes(m.get(upId).status), { timeoutMs: 20_000 })
  const upDone = m.get(upId)
  assert.equal(upDone.status, 'completed', upDone.error?.message)
  assert.ok(upDone.target.fileId)
  assert.equal(env.mock.getItem(upDone.target.fileId).name, 'Som Direto.wav')
  assert.equal(await env.mock.contentMd5(upDone.target.fileId), md5)
  assert.ok(!JSON.stringify(m.snapshot()).includes('upload_id'))
})

test('reabrir no meio de um download continua de onde parou e o arquivo fica íntegro', async t => {
  const { env, dir, make } = await realSetup(t, { perConnectionBps: 1 * MiB }, { maxConcurrentDownloads: 1 })
  const size = 10 * MiB
  const item = env.mock.addFile('Entrega Master.mov', 'root', { size, seed: 21 })
  const first = await make()
  const drive = first.m.driveFor(env.accountId)
  const plan = await planDownloads({ drive, accountId: env.accountId, items: [{ id: item.id }], destDir: dir })
  await first.m.add({ batch: plan.batch, records: plan.records })
  const id = plan.records[0].id
  // Espera um checkpoint de verdade (posições sincronizadas no registro).
  await waitFor(() => plan.records[0].segments?.some(s => s.pos > s.start + 256 * 1024), { timeoutMs: 15_000, message: 'sem checkpoint' })
  await first.m.shutdown()
  const disk = await readJSON(env.paths.queue)
  const saved = disk.transfers.find(r => r.id === id)
  assert.equal(saved.status, 'running')
  const savedBytes = saved.segments.reduce((a, s) => a + (s.pos - s.start), 0)
  assert.ok(savedBytes > 0, 'progresso gravado')

  env.mock.resetStats()
  env.mock.setOptions({ perConnectionBps: 0 })
  const second = await make()
  await waitFor(() => second.m.get(id)?.status === 'completed', { timeoutMs: 20_000, message: 'não terminou depois de reabrir' })
  assert.equal(await md5File(second.m.get(id).dest.path), await virtualMd5(21, size))
  const served = env.mock.stats().bytesServed
  assert.ok(served <= size - savedBytes + 4 * MiB, `baixou de novo o que já tinha: ${served} bytes servidos`)
})
