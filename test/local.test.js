// Testes do disco local: navegação (fsbrowse), varredura (scan) e KeepAwake (power).
import { test, describe, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'

import { listRoots, listDir, statPaths, expandHome, mapLimit } from '../src/local/fsbrowse.js'
import { scanLocal } from '../src/local/scan.js'
import { KeepAwake, helperCommand } from '../src/engine/power.js'
import { isAbortError } from '../src/util/backoff.js'
import { closeHttp } from '../src/net/http.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

let home // SOBEDESCE_HOME
let tmp // área de trabalho do teste
const prevHome = process.env.SOBEDESCE_HOME
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'sobedesce-local-home-'))
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sobedesce-local-'))
  process.env.SOBEDESCE_HOME = home
})
afterEach(async () => {
  if (prevHome === undefined) delete process.env.SOBEDESCE_HOME
  else process.env.SOBEDESCE_HOME = prevHome
  await fs.chmod(tmp, 0o700).catch(() => {})
  await fs.rm(tmp, { recursive: true, force: true })
  await fs.rm(home, { recursive: true, force: true })
})
after(async () => {
  await closeHttp()
})

async function write(p, content = '') {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content)
}

describe('local/fsbrowse.js', () => {
  test('mapLimit preserva a ordem e respeita o limite', async () => {
    let running = 0
    let peak = 0
    const out = await mapLimit([...Array(50).keys()], 5, async i => {
      running++
      peak = Math.max(peak, running)
      await new Promise(r => setTimeout(r, (i % 3) * 2))
      running--
      return i * 2
    })
    assert.deepEqual(out, [...Array(50).keys()].map(i => i * 2))
    assert.ok(peak <= 5)
    assert.deepEqual(await mapLimit([], 5, async x => x), [])
  })

  test('listDir: pastas primeiro, ordem natural pt-BR, ocultos e lixo', async () => {
    for (const d of ['b', 'A', '10', '2']) await fs.mkdir(path.join(tmp, d))
    await write(path.join(tmp, 'file10.txt'), '1234567890')
    await write(path.join(tmp, 'file2.txt'), '12')
    await write(path.join(tmp, 'Ábaco.mov'), 'abc')
    await write(path.join(tmp, 'zebra.mov'), '')
    await write(path.join(tmp, '.oculto'), 'x')
    for (const junk of ['.DS_Store', '._file2.txt', 'video.mov.sobedesce-part', 'Thumbs.db']) await write(path.join(tmp, junk), 'lixo')
    await fs.symlink(path.join(tmp, 'file2.txt'), path.join(tmp, 'link-ok'))
    await fs.symlink(path.join(tmp, 'nao-existe'), path.join(tmp, 'quebrado'))
    await fs.symlink(path.join(tmp, 'b'), path.join(tmp, 'atalho-pasta'))

    const res = await listDir(tmp)
    assert.equal(res.path, tmp)
    assert.equal(res.parent, path.dirname(tmp))
    assert.deepEqual(res.entries.map(e => e.name), ['2', '10', 'A', 'atalho-pasta', 'b', 'Ábaco.mov', 'file2.txt', 'file10.txt', 'link-ok', 'zebra.mov'])
    const byName = Object.fromEntries(res.entries.map(e => [e.name, e]))
    assert.equal(byName['atalho-pasta'].isDir, true)
    assert.equal(byName['atalho-pasta'].isLink, true)
    assert.equal(byName['b'].isDir, true)
    assert.equal(byName['b'].size, 0)
    assert.equal(byName['file10.txt'].size, 10)
    assert.equal(byName['file10.txt'].path, path.join(tmp, 'file10.txt'))
    assert.equal(byName['file10.txt'].isDir, false)
    assert.equal(byName['link-ok'].size, 2)
    const st = await fs.stat(path.join(tmp, 'file10.txt'))
    assert.equal(byName['file10.txt'].mtimeMs, st.mtimeMs)
    assert.ok(res.entries.every(e => e.hidden === false))

    const withHidden = await listDir(tmp, { showHidden: true })
    const names = withHidden.entries.map(e => e.name)
    assert.ok(names.includes('.oculto'))
    assert.equal(withHidden.entries.find(e => e.name === '.oculto').hidden, true)
    for (const junk of ['.DS_Store', '._file2.txt', 'video.mov.sobedesce-part', 'Thumbs.db', 'quebrado']) assert.ok(!names.includes(junk), junk)
  })

  test('listDir: itens de sistema do Windows ficam ocultos', async () => {
    await fs.mkdir(path.join(tmp, '$RECYCLE.BIN'))
    await fs.mkdir(path.join(tmp, 'System Volume Information'))
    await write(path.join(tmp, 'pagefile.sys'), '')
    await write(path.join(tmp, 'filme.mov'), '')
    const win = await listDir(tmp, { platform: 'win32' })
    assert.deepEqual(win.entries.map(e => e.name), ['filme.mov'])
    const lin = await listDir(tmp, { platform: 'linux' })
    assert.equal(lin.entries.length, 4)
  })

  test('listDir: raiz do disco não tem pasta de cima; ~ é a pasta do usuário', async () => {
    const root = await listDir('/')
    assert.equal(root.parent, null)
    assert.equal(root.path, path.resolve('/'))
    const prev = process.env.HOME
    process.env.HOME = tmp
    try {
      await fs.mkdir(path.join(tmp, 'Projetos'))
      assert.equal((await listDir('~')).path, tmp)
      assert.equal((await listDir('~/Projetos')).path, path.join(tmp, 'Projetos'))
      assert.equal(expandHome('~'), tmp)
      assert.equal(expandHome('relativo/x'), path.resolve('relativo/x'))
    } finally {
      process.env.HOME = prev
    }
  })

  test('listDir: erros com mensagem em português e status HTTP', async () => {
    await assert.rejects(listDir(path.join(tmp, 'nao-existe')), err => err.status === 404 && /Não encontrei/.test(err.message) && err.code === 'ENOENT')
    await write(path.join(tmp, 'arquivo.txt'), 'x')
    await assert.rejects(listDir(path.join(tmp, 'arquivo.txt')), err => err.status === 404 && err.code === 'ENOTDIR' && /não é uma pasta/.test(err.message))
  })

  test('listDir: pasta sem permissão dá 403', { skip: isRoot && 'root lê qualquer pasta' }, async () => {
    const locked = path.join(tmp, 'trancada')
    await fs.mkdir(locked)
    await fs.chmod(locked, 0o000)
    try {
      await assert.rejects(listDir(locked), err => err.status === 403 && /permissão/.test(err.message))
    } finally {
      await fs.chmod(locked, 0o700)
    }
  })

  test('statPaths', async () => {
    await write(path.join(tmp, 'a.bin'), 'abcd')
    await fs.mkdir(path.join(tmp, 'pasta'))
    const out = await statPaths([path.join(tmp, 'a.bin'), path.join(tmp, 'pasta'), path.join(tmp, 'sumiu')])
    assert.equal(out.length, 3)
    assert.deepEqual(
      out.map(({ path: p, isDir, size, exists }) => ({ p, isDir, size, exists })),
      [
        { p: path.join(tmp, 'a.bin'), isDir: false, size: 4, exists: true },
        { p: path.join(tmp, 'pasta'), isDir: true, size: 0, exists: true },
        { p: path.join(tmp, 'sumiu'), isDir: false, size: 0, exists: false },
      ],
    )
    assert.deepEqual(await statPaths([]), [])
  })

  test('listRoots no Linux: Início, Área de Trabalho (XDG), Downloads e discos montados', async () => {
    const userHome = path.join(tmp, 'home')
    await fs.mkdir(path.join(userHome, 'Área de Trabalho'), { recursive: true })
    await fs.mkdir(path.join(userHome, 'Desktop'))
    await fs.mkdir(path.join(userHome, 'Downloads'))
    await write(path.join(userHome, '.config', 'user-dirs.dirs'), '# xdg\nXDG_DESKTOP_DIR="$HOME/Área de Trabalho"\nXDG_DOWNLOAD_DIR="$HOME/Downloads"\n')
    const media = path.join(tmp, 'media', 'eu')
    const mnt = path.join(tmp, 'mnt')
    await fs.mkdir(path.join(media, 'SSD EXTERNO'), { recursive: true })
    await fs.mkdir(path.join(media, '.oculto'), { recursive: true })
    await fs.mkdir(path.join(mnt, 'backup'), { recursive: true })
    await fs.symlink(path.join(media, 'SSD EXTERNO'), path.join(mnt, 'link-para-ssd'))
    await write(path.join(mnt, 'arquivo-solto'), 'x')

    const roots = await listRoots({ platform: 'linux', home: userHome, user: 'eu', mountBases: [media, path.join(tmp, 'run-media-nao-existe'), mnt] })
    assert.deepEqual(roots, [
      { name: 'Início', path: userHome, kind: 'home' },
      { name: 'Área de Trabalho', path: path.join(userHome, 'Área de Trabalho'), kind: 'desktop' },
      { name: 'Downloads', path: path.join(userHome, 'Downloads'), kind: 'downloads' },
      { name: 'SSD EXTERNO', path: path.join(media, 'SSD EXTERNO'), kind: 'volume' },
      { name: 'backup', path: path.join(mnt, 'backup'), kind: 'volume' },
    ])

    // Sem XDG: usa ~/Desktop.
    await fs.rm(path.join(userHome, '.config'), { recursive: true })
    const plain = await listRoots({ platform: 'linux', home: userHome, user: 'eu', mountBases: [] })
    assert.deepEqual(plain.map(r => [r.kind, r.path]), [
      ['home', userHome],
      ['desktop', path.join(userHome, 'Desktop')],
      ['downloads', path.join(userHome, 'Downloads')],
    ])
  })

  test('listRoots no mac: pastas que existem + /Volumes sem o disco do sistema', async () => {
    const userHome = path.join(tmp, 'Users', 'eu')
    for (const d of ['Desktop', 'Downloads', 'Movies']) await fs.mkdir(path.join(userHome, d), { recursive: true })
    const volumes = path.join(tmp, 'Volumes')
    await fs.mkdir(path.join(volumes, 'EXTERNO 4TB'), { recursive: true })
    await fs.mkdir(path.join(volumes, 'com.apple.TimeMachine.localsnapshots'))
    await fs.mkdir(path.join(volumes, '.timemachine'))
    await fs.symlink('/', path.join(volumes, 'Macintosh HD'))
    await fs.symlink(path.join(tmp, 'nada'), path.join(volumes, 'quebrado'))

    const roots = await listRoots({ platform: 'darwin', home: userHome, volumesDir: volumes })
    assert.deepEqual(roots, [
      { name: 'Início', path: userHome, kind: 'home' },
      { name: 'Mesa', path: path.join(userHome, 'Desktop'), kind: 'desktop' },
      { name: 'Downloads', path: path.join(userHome, 'Downloads'), kind: 'downloads' },
      { name: 'Filmes', path: path.join(userHome, 'Movies'), kind: 'movies' },
      { name: 'EXTERNO 4TB', path: path.join(volumes, 'EXTERNO 4TB'), kind: 'volume' },
    ])
    await fs.mkdir(path.join(userHome, 'Documents'))
    const again = await listRoots({ platform: 'darwin', home: userHome, volumesDir: volumes })
    assert.deepEqual(again.find(r => r.kind === 'documents'), { name: 'Documentos', path: path.join(userHome, 'Documents'), kind: 'documents' })
  })

  test('listRoots no Windows: pastas do usuário + letras de unidade que existem', async () => {
    const userHome = path.join(tmp, 'eu')
    await fs.mkdir(path.join(userHome, 'OneDrive', 'Desktop'), { recursive: true })
    await fs.mkdir(path.join(userHome, 'Downloads'))
    // Aqui (Linux) nenhuma letra existe: a lista de discos fica vazia.
    const roots = await listRoots({ platform: 'win32', home: userHome })
    assert.deepEqual(roots, [
      { name: 'Início', path: userHome, kind: 'home' },
      { name: 'Área de Trabalho', path: path.join(userHome, 'OneDrive', 'Desktop'), kind: 'desktop' },
      { name: 'Downloads', path: path.join(userHome, 'Downloads'), kind: 'downloads' },
    ])
  })

  test('listRoots de verdade começa pela pasta do usuário', async () => {
    const roots = await listRoots()
    assert.ok(roots.length >= 1)
    assert.deepEqual(roots[0], { name: 'Início', path: os.homedir(), kind: 'home' })
    const kinds = new Set(['home', 'desktop', 'downloads', 'documents', 'movies', 'volume', 'drive'])
    for (const r of roots) {
      assert.ok(kinds.has(r.kind))
      assert.ok(path.isAbsolute(r.path))
    }
  })
})

describe('local/scan.js', () => {
  test('varre a árvore: NFC, "/" nos caminhos relativos, ignora lixo e links', async () => {
    const root = path.join(tmp, 'Projeto X')
    await write(path.join(root, 'a.txt'), 'hello')
    await write(path.join(root, 'sub', 'b.bin'), 'bb')
    await write(path.join(root, 'sub', 'deep', 'c.mov'), 'ccc')
    const nfd = 'Ação.mov' // como o macOS costuma gravar
    await write(path.join(root, 'sub', nfd), 'acao')
    await write(path.join(root, '.oculto'), 'o')
    await write(path.join(root, '.DS_Store'), 'lixo')
    await write(path.join(root, 'sub', '._b.bin'), 'lixo')
    await write(path.join(root, 'grande.mov.sobedesce-part'), 'lixo')
    await fs.mkdir(path.join(root, 'vazia'))
    await fs.symlink(path.join(root, 'a.txt'), path.join(root, 'link.txt'))
    await fs.symlink(path.join(root, 'sub'), path.join(root, 'link-pasta'))
    let fifo = false
    try {
      execFileSync('mkfifo', [path.join(root, 'cano')])
      fifo = true
    } catch {}

    const progress = []
    const res = await scanLocal(root, { onProgress: p => progress.push(p) })
    assert.deepEqual(res.root, { path: root, name: 'Projeto X', isDir: true })
    assert.deepEqual(res.files.map(f => f.relPath), ['.oculto', 'a.txt', 'sub/Ação.mov', 'sub/b.bin', 'sub/deep/c.mov'])
    const acao = res.files.find(f => f.name === 'Ação.mov')
    assert.equal(acao.relPath, 'sub/Ação.mov'.normalize('NFC'))
    assert.equal(acao.relDir, 'sub')
    assert.equal(acao.path, path.join(root, 'sub', nfd), 'caminho absoluto fica como está no disco')
    assert.equal(acao.size, 4)
    const c = res.files.find(f => f.name === 'c.mov')
    assert.deepEqual({ ...c, mtimeMs: undefined }, { relPath: 'sub/deep/c.mov', relDir: 'sub/deep', name: 'c.mov', path: path.join(root, 'sub', 'deep', 'c.mov'), size: 3, mtimeMs: undefined })
    assert.equal(c.mtimeMs, (await fs.stat(c.path)).mtimeMs)
    assert.equal(res.files.find(f => f.name === 'a.txt').relDir, '')
    assert.deepEqual(res.dirs, ['sub', 'sub/deep', 'vazia'])
    const skippedPaths = res.skipped.map(s => s.path).sort()
    const expectedSkipped = [path.join(root, 'link-pasta'), path.join(root, 'link.txt')]
    if (fifo) expectedSkipped.push(path.join(root, 'cano'))
    assert.deepEqual(skippedPaths, expectedSkipped.sort())
    assert.ok(res.skipped.every(s => typeof s.reason === 'string' && s.reason.length > 0))
    const last = progress[progress.length - 1]
    assert.equal(last.files, 5)
    assert.equal(last.bytes, 5 + 2 + 3 + 4 + 1)
    assert.equal(last.dirs, 3)
  })

  test('um arquivo só vira a lista com ele', async () => {
    const file = path.join(tmp, 'Cena 01.mov')
    await write(file, 'x'.repeat(42))
    const res = await scanLocal(file)
    assert.deepEqual(res.root, { path: file, name: 'Cena 01.mov', isDir: false })
    assert.equal(res.files.length, 1)
    assert.deepEqual({ ...res.files[0], mtimeMs: 0 }, { relPath: 'Cena 01.mov', relDir: '', name: 'Cena 01.mov', path: file, size: 42, mtimeMs: 0 })
    assert.deepEqual(res.dirs, [])
    assert.deepEqual(res.skipped, [])
  })

  test('pasta vazia e caminho inexistente', async () => {
    await fs.mkdir(path.join(tmp, 'vazia'))
    const res = await scanLocal(path.join(tmp, 'vazia'))
    assert.deepEqual(res.files, [])
    assert.deepEqual(res.dirs, [])
    await assert.rejects(scanLocal(path.join(tmp, 'nao-existe')), err => err.status === 404 && /Não encontrei/.test(err.message))
  })

  test('nomes iguais em NFC (composto × decomposto) não viram dois arquivos', async () => {
    const root = path.join(tmp, 'dup')
    await write(path.join(root, 'café.txt'), 'nfc')
    await write(path.join(root, 'café.txt'), 'nfd')
    const res = await scanLocal(root)
    assert.deepEqual(res.files.map(f => f.relPath), ['café.txt'])
    assert.equal(res.skipped.length, 1)
    assert.match(res.skipped[0].reason, /repetido/)
  })

  test('pasta sem permissão vai para skipped', { skip: isRoot && 'root lê qualquer pasta' }, async () => {
    const root = path.join(tmp, 'raiz')
    await write(path.join(root, 'ok.txt'), 'ok')
    await write(path.join(root, 'trancada', 'segredo.txt'), 's')
    await fs.chmod(path.join(root, 'trancada'), 0o000)
    try {
      const res = await scanLocal(root)
      assert.deepEqual(res.files.map(f => f.relPath), ['ok.txt'])
      assert.deepEqual(res.skipped.map(s => s.path), [path.join(root, 'trancada')])
      assert.match(res.skipped[0].reason, /permissão/)
    } finally {
      await fs.chmod(path.join(root, 'trancada'), 0o700)
    }
  })

  test('5 mil arquivos: rápido, ordenado, progresso no máximo 5×/s', async () => {
    const root = path.join(tmp, 'muitos')
    const DIRS = 50
    const PER = 100
    let expectedBytes = 0
    const jobs = []
    for (let d = 0; d < DIRS; d++) {
      const dir = path.join(root, `cam${String(d).padStart(2, '0')}`, d % 2 ? 'proxy' : 'raw')
      await fs.mkdir(dir, { recursive: true })
      for (let f = 0; f < PER; f++) {
        const size = (d * PER + f) % 97
        expectedBytes += size
        jobs.push({ p: path.join(dir, `clip_${f}.mov`), size })
      }
    }
    await mapLimit(jobs, 64, j => fs.writeFile(j.p, Buffer.alloc(j.size, 1)))

    const calls = []
    const t0 = Date.now()
    const res = await scanLocal(root, { onProgress: p => calls.push({ ...p, t: Date.now() }) })
    const elapsed = Date.now() - t0
    assert.equal(res.files.length, DIRS * PER)
    assert.equal(res.files.reduce((a, f) => a + f.size, 0), expectedBytes)
    assert.equal(res.dirs.length, DIRS * 2)
    for (let i = 1; i < res.files.length; i++) assert.ok(res.files[i - 1].relPath < res.files[i].relPath, 'ordenado por relPath')
    assert.ok(elapsed < 20_000, `levou ${elapsed} ms`)
    // ≤ 5 por segundo (+ o aviso final).
    assert.ok(calls.length <= Math.ceil(elapsed / 200) + 2, `${calls.length} avisos em ${elapsed} ms`)
    for (let i = 2; i < calls.length; i++) assert.ok(calls[i - 1].t - calls[i - 2].t >= 190, 'intervalo entre avisos')
    const last = calls[calls.length - 1]
    assert.equal(last.files, DIRS * PER)
    assert.equal(last.bytes, expectedBytes)
    assert.equal(last.dirs, DIRS * 2)
  })

  test('respeita AbortSignal (antes e durante)', async () => {
    const root = path.join(tmp, 'abortar')
    const jobs = []
    for (let d = 0; d < 40; d++) {
      await fs.mkdir(path.join(root, `d${d}`, 'x', 'y'), { recursive: true })
      for (let f = 0; f < 60; f++) jobs.push(path.join(root, `d${d}`, 'x', 'y', `f${f}`))
    }
    await mapLimit(jobs, 64, p => fs.writeFile(p, 'z'))

    const pre = new AbortController()
    pre.abort()
    await assert.rejects(scanLocal(root, { signal: pre.signal }), isAbortError)

    const ac = new AbortController()
    let seen = 0
    const t0 = Date.now()
    const p = scanLocal(root, {
      signal: ac.signal,
      onProgress: () => {
        if (++seen === 1) ac.abort()
      },
    })
    setTimeout(() => ac.abort(), 30) // se o primeiro aviso demorar, aborta assim mesmo
    await assert.rejects(p, isAbortError)
    assert.ok(Date.now() - t0 < 5000)
  })
})

describe('engine/power.js — KeepAwake', () => {
  function fakeSpawn() {
    const calls = []
    const fn = (cmd, args, opts) => {
      const child = new EventEmitter()
      child.killed = false
      child.kill = () => {
        child.killed = true
        setImmediate(() => child.emit('exit', null, 'SIGTERM'))
        return true
      }
      child.unref = () => {}
      calls.push({ cmd, args, opts, child })
      return child
    }
    fn.calls = calls
    return fn
  }

  test('mac: caffeinate uma vez só, idempotente, e para quando desliga', async () => {
    const spawnFn = fakeSpawn()
    const ka = new KeepAwake({ platform: 'darwin', spawn: spawnFn, log: () => {} })
    assert.equal(ka.active, false)
    ka.setActive(true)
    ka.setActive(true)
    assert.equal(spawnFn.calls.length, 1)
    const { cmd, args, opts, child } = spawnFn.calls[0]
    assert.equal(cmd, 'caffeinate')
    assert.deepEqual(args, ['-dimsu', '-w', String(process.pid)])
    assert.equal(opts.stdio, 'ignore')
    assert.equal(ka.active, true)
    ka.setActive(false)
    ka.setActive(false)
    assert.equal(child.killed, true)
    assert.equal(ka.active, false)
    ka.setActive(true) // depois de parar, pode ligar de novo na hora
    assert.equal(spawnFn.calls.length, 2)
    ka.stop()
    assert.equal(spawnFn.calls[1].child.killed, true)
    assert.equal(ka.active, false)
  })

  test('Windows: PowerShell oculto com SetThreadExecutionState a cada 30 s', () => {
    const spawnFn = fakeSpawn()
    const ka = new KeepAwake({ platform: 'win32', spawn: spawnFn, log: () => {} })
    ka.setActive(true)
    assert.equal(spawnFn.calls.length, 1)
    const { cmd, args, opts } = spawnFn.calls[0]
    assert.match(cmd, /^powershell/i)
    assert.ok(args.includes('-NoProfile'))
    assert.equal(args[args.indexOf('-WindowStyle') + 1], 'Hidden')
    assert.equal(opts.windowsHide, true)
    const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
    assert.match(script, /Add-Type/)
    assert.match(script, /SetThreadExecutionState/)
    assert.match(script, /2147483649/) // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    assert.match(script, /Start-Sleep -Seconds 30/)
    assert.match(script, new RegExp(`Get-Process -Id ${process.pid}`))
    ka.stop()
  })

  test('Linux sem systemd-inhibit: segue sem e avisa uma vez só', () => {
    const spawnFn = fakeSpawn()
    const logs = []
    const prevPath = process.env.PATH
    process.env.PATH = tmp // pasta sem executáveis
    try {
      const ka = new KeepAwake({ platform: 'linux', spawn: spawnFn, log: (...a) => logs.push(a.join(' ')) })
      ka.setActive(true)
      ka.setActive(false)
      ka.setActive(true)
      assert.equal(spawnFn.calls.length, 0)
      assert.equal(ka.active, false)
      assert.equal(logs.length, 1)
    } finally {
      process.env.PATH = prevPath
    }
    assert.equal(helperCommand('linux', 1, tmp), null)
    assert.equal(helperCommand('aix', 1), null)
  })

  test('falha ao iniciar o ajudante é silenciosa (log uma vez) e não tenta em loop', async () => {
    const logs = []
    const spawnFn = (cmd, args, opts) => {
      const child = new EventEmitter()
      child.kill = () => true
      child.unref = () => {}
      setImmediate(() => child.emit('error', Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' })))
      spawnFn.count = (spawnFn.count || 0) + 1
      return child
    }
    const ka = new KeepAwake({ platform: 'darwin', spawn: spawnFn, log: (...a) => logs.push(a.join(' ')) })
    ka.setActive(true)
    await new Promise(r => setImmediate(r))
    assert.equal(ka.active, false)
    ka.setActive(false)
    ka.setActive(true)
    ka.setActive(true)
    assert.equal(spawnFn.count, 1)
    assert.equal(logs.length, 1)

    const throwing = new KeepAwake({ platform: 'darwin', spawn: () => { throw new Error('EPERM') }, log: () => {} })
    throwing.setActive(true)
    assert.equal(throwing.active, false)
  })

  test('ajudante que morre sozinho é refeito depois de um tempo; se sempre morre logo, desiste', async () => {
    const logs = []
    let count = 0
    const spawnFn = () => {
      count++
      const child = new EventEmitter()
      child.kill = () => true
      child.unref = () => {}
      setTimeout(() => child.emit('exit', 1, null), 5)
      return child
    }
    const ka = new KeepAwake({ platform: 'darwin', spawn: spawnFn, log: (...a) => logs.push(a.join(' ')), retryMs: 20 })
    ka.setActive(true)
    assert.equal(ka.active, true)
    await new Promise(r => setTimeout(r, 300))
    assert.equal(count, 3, 'tenta 3 vezes')
    assert.equal(ka.active, false)
    assert.equal(logs.length, 1)
    ka.setActive(true)
    assert.equal(count, 3, 'desistiu')

    // Desligar cancela a nova tentativa agendada.
    let count2 = 0
    const ka2 = new KeepAwake({
      platform: 'darwin',
      log: () => {},
      retryMs: 50,
      spawn: () => {
        count2++
        const child = new EventEmitter()
        child.kill = () => true
        setTimeout(() => child.emit('exit', 1, null), 5)
        return child
      },
    })
    ka2.setActive(true)
    await new Promise(r => setTimeout(r, 20))
    ka2.setActive(false)
    await new Promise(r => setTimeout(r, 120))
    assert.equal(count2, 1)
  })

  // Um systemd-inhibit falso (script) que, como o de verdade, roda o comando como processo filho.
  async function fakeInhibit(dir) {
    const bin = path.join(dir, 'bin')
    await fs.mkdir(bin, { recursive: true })
    const script = path.join(bin, 'systemd-inhibit')
    await fs.writeFile(script, [
      '#!/bin/sh',
      'echo "$@" > "$SOBEDESCE_TEST_ARGS"',
      'while [ $# -gt 0 ]; do case "$1" in --*) shift ;; *) break ;; esac; done',
      '"$@" &',
      'echo $! > "$SOBEDESCE_TEST_PIDFILE"',
      'wait',
      '',
    ].join('\n'))
    await fs.chmod(script, 0o755)
    return bin
  }

  function alive(pid) {
    try {
      const stat = fsSync.readFileSync(`/proc/${pid}/stat`, 'utf8')
      return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z' // zumbi conta como morto
    } catch {
      return false
    }
  }

  async function waitFor(cond, ms) {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (await cond()) return true
      await new Promise(r => setTimeout(r, 50))
    }
    return cond()
  }

  const canTestLinux = process.platform === 'linux' && fsSync.existsSync('/proc/self/stat')

  test('Linux: systemd-inhibit e todos os filhos morrem ao desligar', { skip: !canTestLinux && 'só no Linux' }, async () => {
    const bin = await fakeInhibit(tmp)
    const pidFile = path.join(tmp, 'pid')
    const argsFile = path.join(tmp, 'args')
    const prev = { PATH: process.env.PATH, P: process.env.SOBEDESCE_TEST_PIDFILE, A: process.env.SOBEDESCE_TEST_ARGS }
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
    process.env.SOBEDESCE_TEST_PIDFILE = pidFile
    process.env.SOBEDESCE_TEST_ARGS = argsFile
    const ka = new KeepAwake({ platform: 'linux', log: () => {} })
    try {
      ka.setActive(true)
      assert.equal(ka.active, true)
      const helperPid = ka.helper.child.pid
      assert.ok(await waitFor(() => fsSync.existsSync(pidFile) && fsSync.readFileSync(pidFile, 'utf8').trim() !== '', 5000), 'o comando filho começou')
      const innerPid = Number(fsSync.readFileSync(pidFile, 'utf8').trim())
      const args = fsSync.readFileSync(argsFile, 'utf8')
      assert.match(args, /--what=idle:sleep --who=SOBEDESCE --why=Transferências em andamento --mode=block sh -c/)
      assert.ok(alive(helperPid) && alive(innerPid))
      ka.setActive(false)
      assert.equal(ka.active, false)
      assert.ok(await waitFor(() => !alive(helperPid) && !alive(innerPid), 5000), 'nenhum processo sobra')
    } finally {
      ka.stop()
      process.env.PATH = prev.PATH
      if (prev.P === undefined) delete process.env.SOBEDESCE_TEST_PIDFILE
      if (prev.A === undefined) delete process.env.SOBEDESCE_TEST_ARGS
    }
  })

  test('Linux (slow): se o app morrer de repente, a trava se solta sozinha', { skip: !canTestLinux && 'só no Linux', timeout: 60_000 }, async () => {
    const bin = await fakeInhibit(tmp)
    const pidFile = path.join(tmp, 'pid')
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, SOBEDESCE_TEST_PIDFILE: pidFile, SOBEDESCE_TEST_ARGS: path.join(tmp, 'args') }
    const code = `
      import { KeepAwake } from ${JSON.stringify(path.join(ROOT, 'src/engine/power.js'))}
      import fs from 'node:fs'
      const ka = new KeepAwake({ platform: 'linux', log: () => {} })
      ka.setActive(true)
      const t = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(pidFile)}) && fs.readFileSync(${JSON.stringify(pidFile)}, 'utf8').trim()) {
          clearInterval(t)
          console.log(ka.helper.child.pid)
          process.kill(process.pid, 'SIGKILL')
        }
      }, 20)
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', d => (out += d))
    await new Promise(resolve => child.on('exit', resolve))
    const helperPid = Number(out.trim())
    const innerPid = Number(fsSync.readFileSync(pidFile, 'utf8').trim())
    assert.ok(helperPid > 0 && innerPid > 0)
    assert.ok(await waitFor(() => !alive(helperPid) && !alive(innerPid), 25_000), 'o ajudante percebe que o app morreu e sai')
  })
})
