// Testes do Hasher (MD5 em worker_threads + cache) e do worker.
import { test, describe, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Hasher } from '../src/engine/hasher.js'
import { dataPaths } from '../src/config.js'
import { readJSON } from '../src/util/store.js'
import { isAbortError } from '../src/util/backoff.js'
import { closeHttp } from '../src/net/http.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MiB = 1024 * 1024
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

let home
let hashers = []
const prevHome = process.env.SOBEDESCE_HOME
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'sobedesce-hash-'))
  process.env.SOBEDESCE_HOME = home
  hashers = []
})
afterEach(async () => {
  await Promise.all(hashers.map(h => h.close()))
  if (prevHome === undefined) delete process.env.SOBEDESCE_HOME
  else process.env.SOBEDESCE_HOME = prevHome
  await fs.rm(home, { recursive: true, force: true })
})
after(async () => {
  await closeHttp()
})

function make(opts = {}) {
  const h = new Hasher({ log: () => {}, ...opts })
  hashers.push(h)
  return h
}

const md5 = buf => crypto.createHash('md5').update(buf).digest('hex')

/** Arquivo esparso (só zeros, não ocupa disco) para testar arquivos grandes sem gastar espaço. */
async function sparse(name, size) {
  const p = path.join(home, name)
  const fh = await fs.open(p, 'w')
  await fh.truncate(size)
  await fh.close()
  return p
}

let zeroCache = new Map()
function md5Zeros(size) {
  if (zeroCache.has(size)) return zeroCache.get(size)
  const h = crypto.createHash('md5')
  const block = Buffer.alloc(4 * MiB)
  let left = size
  while (left > 0) {
    const n = Math.min(left, block.length)
    h.update(n === block.length ? block : block.subarray(0, n))
    left -= n
  }
  const out = h.digest('hex')
  zeroCache.set(size, out)
  return out
}

async function waitFor(cond, ms = 5000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (cond()) return true
    await new Promise(r => setTimeout(r, 10))
  }
  return cond()
}

describe('engine/hasher.js', () => {
  test('MD5 certo: vazio, pequeno e vários blocos de 4 MiB', async () => {
    const h = make()
    await h.init()
    const empty = path.join(home, 'vazio.bin')
    await fs.writeFile(empty, '')
    assert.equal(await h.hash(empty), 'd41d8cd98f00b204e9800998ecf8427e')

    const small = path.join(home, 'pequeno.txt')
    await fs.writeFile(small, 'SOBEDESCE')
    assert.equal(await h.hash(small), md5(Buffer.from('SOBEDESCE')))

    const data = crypto.randomBytes(9 * MiB + 123)
    const big = path.join(home, 'Cena Ação.mov')
    await fs.writeFile(big, data)
    const progress = []
    assert.equal(await h.hash(big, { onProgress: p => progress.push(p) }), md5(data))
    const last = progress[progress.length - 1]
    assert.deepEqual(last, { bytes: data.length, done: data.length, total: data.length })
  })

  test('cache: reaproveita, valida contra o stat atual, persiste e recarrega', async () => {
    const cacheFile = dataPaths().hashCache
    assert.ok(cacheFile.startsWith(home))
    const file = path.join(home, 'clip.mov')
    await fs.writeFile(file, 'versão 1')
    const h = make()
    const first = await h.hash(file)
    assert.equal(first, md5(Buffer.from('versão 1')))
    assert.equal(h.started, 1)
    let st = await fs.stat(file)
    assert.equal(h.getCached(file, st.size, st.mtimeMs), first)
    assert.equal(h.getCached(file, st.size + 1, st.mtimeMs), null)
    assert.equal(h.getCached(file, st.size, st.mtimeMs + 1), null)
    // Caminho relativo vale o mesmo que o absoluto.
    assert.equal(h.getCached(path.relative(process.cwd(), file), st.size, st.mtimeMs), first)

    // Pedir de novo não recalcula.
    assert.equal(await h.hash(file), first)
    assert.equal(h.started, 1)

    // Mudou o conteúdo (mesmo tamanho) e a data: entrada velha é trocada.
    await fs.writeFile(file, 'versão 2')
    const future = new Date(Date.now() + 60_000)
    await fs.utimes(file, future, future)
    const second = await h.hash(file)
    assert.equal(second, md5(Buffer.from('versão 2')))
    assert.equal(h.started, 2)
    st = await fs.stat(file)
    assert.equal(h.getCached(file, st.size, st.mtimeMs), second)

    await h.flush()
    const disk = await readJSON(cacheFile)
    assert.deepEqual(disk[path.resolve(file)], { size: st.size, mtimeMs: st.mtimeMs, md5: second })
    assert.equal(Object.keys(disk).length, 1)

    const h2 = make()
    await h2.init()
    assert.equal(h2.getCached(file, st.size, st.mtimeMs), second)
    assert.equal(await h2.hash(file), second)
    assert.equal(h2.started, 0)
  })

  test('cache corrompido ou com lixo não atrapalha', async () => {
    const cacheFile = path.join(home, 'cache.json')
    await fs.writeFile(cacheFile, '{"quebrado": ')
    const h = make({ cacheFile })
    await h.init()
    assert.deepEqual(h.cache.data, {})
    await fs.writeFile(cacheFile, JSON.stringify({ '/a': { size: 1, mtimeMs: 2, md5: 'x' }, '/b': 'lixo', '/c': { size: '1' } }))
    const h2 = make({ cacheFile })
    await h2.init()
    assert.deepEqual(Object.keys(h2.cache.data), ['/a'])
  })

  test('pedidos simultâneos do mesmo arquivo dividem um cálculo só', async () => {
    const file = await sparse('compartilhado.bin', 64 * MiB)
    const h = make()
    const results = await Promise.all([h.hash(file), h.hash(file), h.hash(path.join(home, '.', 'compartilhado.bin'))])
    assert.deepEqual(results, Array(3).fill(md5Zeros(64 * MiB)))
    assert.equal(h.started, 1)
  })

  test('erros saem com o código original do sistema', async () => {
    const h = make()
    await assert.rejects(h.hash(path.join(home, 'nao-existe.mov')), err => err.code === 'ENOENT')
    await assert.rejects(h.hash(home), err => err.code === 'EISDIR')
    // Depois de erros, continua funcionando.
    const ok = path.join(home, 'ok.txt')
    await fs.writeFile(ok, 'ok')
    assert.equal(await h.hash(ok), md5(Buffer.from('ok')))
  })

  test('sem permissão de leitura: EACCES', { skip: isRoot && 'root lê qualquer arquivo' }, async () => {
    const h = make()
    const file = path.join(home, 'trancado.bin')
    await fs.writeFile(file, 'x')
    await fs.chmod(file, 0o000)
    await assert.rejects(h.hash(file), err => err.code === 'EACCES')
  })

  test('fila FIFO com um worker', async () => {
    const big = await sparse('grande.bin', 256 * MiB)
    const files = []
    for (const n of ['a', 'b', 'c']) {
      const p = path.join(home, `${n}.txt`)
      await fs.writeFile(p, n)
      files.push(p)
    }
    const h = make({ workers: 1 })
    const order = []
    const pBig = h.hash(big).then(() => order.push('grande'))
    await waitFor(() => h.started === 1)
    const ps = []
    for (const [i, f] of files.entries()) {
      ps.push(h.hash(f).then(() => order.push(path.basename(f))))
      await waitFor(() => h.jobs.size === i + 2) // garante a ordem de entrada na fila
    }
    await Promise.all([pBig, ...ps])
    assert.deepEqual(order, ['grande', 'a.txt', 'b.txt', 'c.txt'])
    assert.equal(h.pool.length, 1)
  })

  test('dois workers trabalham ao mesmo tempo', async () => {
    const a = await sparse('a.bin', 512 * MiB)
    const b = await sparse('b.bin', 512 * MiB - 4096)
    const h = make({ workers: 2 })
    const firstProgress = {}
    const doneAt = {}
    const track = (name, p) => h.hash(p, { onProgress: () => (firstProgress[name] ??= Date.now()) }).then(r => {
      doneAt[name] = Date.now()
      return r
    })
    const [ra, rb] = await Promise.all([track('a', a), track('b', b)])
    assert.equal(ra, md5Zeros(512 * MiB))
    assert.equal(rb, md5Zeros(512 * MiB - 4096))
    assert.equal(h.pool.length, 2)
    // O segundo começou antes do primeiro acabar (paralelo de verdade).
    assert.ok(firstProgress.b < doneAt.a && firstProgress.a < doneAt.b, JSON.stringify({ firstProgress, doneAt }))
  })

  test('abort interrompe o cálculo na hora e libera o worker', async () => {
    const size = 1024 * MiB
    const big = await sparse('enorme.bin', size)
    const other = await sparse('enorme-2.bin', size)
    const h = make({ workers: 1 })

    // Referência: quanto leva o arquivo inteiro.
    let t0 = Date.now()
    await h.hash(other)
    const fullMs = Date.now() - t0

    const ac = new AbortController()
    let progressAfterAbort = 0
    let aborted = false
    const p = h.hash(big, {
      signal: ac.signal,
      onProgress: () => {
        if (aborted) progressAfterAbort++
        else {
          aborted = true
          ac.abort()
        }
      },
    })
    await assert.rejects(p, isAbortError)
    t0 = Date.now()
    const small = path.join(home, 'pequeno.txt')
    await fs.writeFile(small, 'depois')
    assert.equal(await h.hash(small), md5(Buffer.from('depois')))
    const afterAbortMs = Date.now() - t0
    assert.equal(progressAfterAbort, 0)
    assert.ok(afterAbortMs < fullMs * 0.6, `depois do abort: ${afterAbortMs} ms; arquivo inteiro: ${fullMs} ms`)
    assert.equal(h.pool.length, 1, 'o mesmo worker continua (cancelamento por mensagem)')
    // O arquivo abortado não entrou no cache.
    const st = await fs.stat(big)
    assert.equal(h.getCached(big, st.size, st.mtimeMs), null)

    // Signal já abortado: rejeita sem calcular.
    const pre = new AbortController()
    pre.abort()
    const before = h.started
    await assert.rejects(h.hash(big, { signal: pre.signal }), isAbortError)
    assert.equal(h.started, before)
  })

  test('abortar um dos interessados não cancela para os outros', async () => {
    const size = 256 * MiB
    const file = await sparse('dividido.bin', size)
    const h = make({ workers: 1 })
    const ac = new AbortController()
    const pA = h.hash(file, { signal: ac.signal })
    const pB = h.hash(file)
    await waitFor(() => h.started === 1)
    ac.abort()
    await assert.rejects(pA, isAbortError)
    assert.equal(await pB, md5Zeros(size))
    assert.equal(h.started, 1)
  })

  test('abort de um job ainda na fila tira ele da fila', async () => {
    const big = await sparse('ocupa.bin', 256 * MiB)
    const queued = path.join(home, 'na-fila.txt')
    await fs.writeFile(queued, 'fila')
    const h = make({ workers: 1 })
    const pBig = h.hash(big)
    await waitFor(() => h.started === 1)
    const ac = new AbortController()
    const pQ = h.hash(queued, { signal: ac.signal })
    await waitFor(() => h.jobs.size === 2)
    ac.abort()
    await assert.rejects(pQ, isAbortError)
    await pBig
    assert.equal(h.started, 1, 'o job abortado nunca chegou ao worker')
  })

  test('worker travado é encerrado e substituído (terminate como reserva)', async () => {
    // Worker de teste que trava de propósito (laço infinito) quando o caminho tem "trava".
    const workerFile = path.join(home, 'worker-teimoso.mjs')
    await fs.writeFile(workerFile, `
      import { parentPort } from 'node:worker_threads'
      import fs from 'node:fs'
      import crypto from 'node:crypto'
      parentPort.on('message', msg => {
        if (msg.type !== 'hash') return
        if (msg.path.includes('trava')) for (;;) {}
        const buf = fs.readFileSync(msg.path)
        parentPort.postMessage({ type: 'done', id: msg.id, bytes: buf.length, md5: crypto.createHash('md5').update(buf).digest('hex') })
      })
    `)
    const stuck = path.join(home, 'trava.bin')
    const fine = path.join(home, 'bom.bin')
    await fs.writeFile(stuck, 'x')
    await fs.writeFile(fine, 'bom')
    const h = make({ workers: 1, workerUrl: pathToFileURL(workerFile), cancelTimeoutMs: 200 })
    const ac = new AbortController()
    const p = h.hash(stuck, { signal: ac.signal })
    await waitFor(() => h.started === 1)
    const firstWorker = h.pool[0].worker
    const t0 = Date.now()
    ac.abort()
    await assert.rejects(p, isAbortError)
    assert.ok(Date.now() - t0 < 1000, 'quem pediu não espera o worker')
    assert.equal(await h.hash(fine), md5(Buffer.from('bom')))
    assert.equal(h.pool.length, 1)
    assert.notEqual(h.pool[0].worker, firstWorker, 'worker novo')
  })

  test('close() interrompe o que está rodando e o que está na fila, e grava o cache', async () => {
    const big = await sparse('fecha.bin', 1024 * MiB)
    const small = path.join(home, 'pronto.txt')
    await fs.writeFile(small, 'pronto')
    const h = make({ workers: 1 })
    assert.equal(await h.hash(small), md5(Buffer.from('pronto')))
    const running = h.hash(big)
    await waitFor(() => h.started === 2)
    const queued = h.hash(path.join(home, 'pronto.txt'), {}) // cache: resolve na hora
    const queued2Path = path.join(home, 'outro.txt')
    await fs.writeFile(queued2Path, 'outro')
    const queued2 = h.hash(queued2Path)
    await waitFor(() => h.jobs.size === 2)
    const checks = [assert.rejects(running, isAbortError), assert.rejects(queued2, isAbortError)]
    await h.close()
    await Promise.all(checks)
    assert.equal(await queued, md5(Buffer.from('pronto')))
    assert.equal(h.pool.length, 0)
    await assert.rejects(h.hash(small), isAbortError)
    const disk = await readJSON(dataPaths().hashCache)
    assert.equal(disk[path.resolve(small)].md5, md5(Buffer.from('pronto')))
  })

  test('workers parados não seguram o processo aberto', async () => {
    const file = path.join(home, 'sai.txt')
    await fs.writeFile(file, 'tchau')
    const code = `
      import { Hasher } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/engine/hasher.js')).href)}
      const h = new Hasher({ workers: 2 })
      console.log(await h.hash(${JSON.stringify(file)}))
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, SOBEDESCE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    const exited = await Promise.race([
      new Promise(resolve => child.on('exit', code => resolve({ code }))),
      new Promise(resolve => setTimeout(() => resolve(null), 20_000).unref()),
    ])
    if (!exited) child.kill('SIGKILL')
    assert.ok(exited, 'o processo terminou sozinho')
    assert.equal(exited.code, 0, err)
    assert.equal(out.trim(), md5(Buffer.from('tchau')))
  })
})
