// Comparador (pasta local × pasta do Drive) contra o Drive falso: regras de cada status, nomes (NFD/maiúsculas),
// Docs e lixo ignorados, agregação por pasta, modo completo (MD5 só do necessário, com cache), progresso,
// cancelamento, gravação em disco e desempenho com milhares de arquivos.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setupDrive, makeTmpDir, randomFile } from './helpers.js'
import { DriveClient } from '../src/google/drive.js'
import { Hasher } from '../src/engine/hasher.js'
import { compareFolders, loadCompare, comparePaths } from '../src/engine/compare.js'
import { planDownloadsFromCompare } from '../src/engine/planner.js'
import { closeHttp } from '../src/net/http.js'
import { isAbortError } from '../src/util/backoff.js'

after(() => closeHttp())

const PHASES = ['local', 'drive', 'hash', 'match']

/** Drive falso + cliente rápido + Hasher + pasta local temporária. */
async function setup(t, mockOptions = {}) {
  const ctx = await setupDrive(mockOptions)
  const dir = await makeTmpDir('sobedesce-compare-')
  const hasher = new Hasher({ cacheFile: path.join(ctx.home, 'hash-cache.json'), workers: 2, log: () => {} })
  t.after(async () => {
    await hasher.close()
    await ctx.cleanup()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })
  })
  const drive = new DriveClient(ctx.auth, ctx.accountId, { ratePerSec: 1000, retryBaseMs: 5 })
  return { ...ctx, drive, hasher, dir }
}

/**
 * Cenário realista de uma pasta de projeto:
 *  Drive "Meu Drive/Projetos/Projeto X"           Local ".../Projeto X"
 *   Roteiro.pdf (1000, s11)                         Roteiro.pdf (igual)                    → synced
 *   Notas.txt (500)                                 Notas.txt (600)                        → different (tamanho)
 *   Brutos/A001.mov (4096, s13)                     Brutos/A001.mov (igual)                → synced
 *   Brutos/A002.mov (4096, s14)                     Brutos/A002.mov (4096, s99)            → synced (rápido) / different (MD5)
 *   Brutos/Take1.MOV (300, s15)                     Brutos/Take1.mov (igual)               → synced + nota de maiúsculas
 *   Brutos/Café.mov (NFC, 700, s16)                 Brutos/Café.mov (NFD, igual)      → synced
 *                                                   Brutos/A003.mov (5000)                 → missing
 *   Fotos Still/Selecionadas/IMG_0412.CR3 (s17)     Fotos/IMG_0412.CR3 (igual)             → elsewhere
 *                                                   Fotos/IMG_0413.CR3 (2048, s22)         → missing
 *   Antigas/Velho.mov (800)                                                                → only-drive
 *   Roteiro (Google Doc), .DS_Store                 .DS_Store                              → ignorados
 *   Vazia/ (pasta vazia)                            Local Vazia/ (pasta vazia)             → pastas 'empty'
 */
async function fixture(env) {
  const m = env.mock
  const projetos = m.addFolder('Projetos', 'root')
  const px = m.addFolder('Projeto X', projetos.id)
  const remote = {}
  remote.roteiro = m.addFile('Roteiro.pdf', px.id, { size: 1000, seed: 11 })
  remote.notas = m.addFile('Notas.txt', px.id, { size: 500, seed: 12 })
  const brutos = m.addFolder('Brutos', px.id)
  remote.a001 = m.addFile('A001.mov', brutos.id, { size: 4096, seed: 13 })
  remote.a002 = m.addFile('A002.mov', brutos.id, { size: 4096, seed: 14 })
  remote.take1 = m.addFile('Take1.MOV', brutos.id, { size: 300, seed: 15 })
  remote.cafe = m.addFile('Café.mov', brutos.id, { size: 700, seed: 16 })
  const still = m.addFolder('Fotos Still', px.id)
  const sel = m.addFolder('Selecionadas', still.id)
  remote.img412 = m.addFile('IMG_0412.CR3', sel.id, { size: 2048, seed: 17 })
  const antigas = m.addFolder('Antigas', px.id)
  remote.velho = m.addFile('Velho.mov', antigas.id, { size: 800, seed: 18 })
  m.addGoogleDoc('Roteiro', px.id, 'document')
  m.addFile('.DS_Store', px.id, { size: 10, seed: 19 })
  m.addFolder('Vazia', px.id)

  const local = path.join(env.dir, 'Projeto X')
  await randomFile(path.join(local, 'Roteiro.pdf'), 1000, 11)
  await randomFile(path.join(local, 'Notas.txt'), 600, 20)
  await randomFile(path.join(local, 'Brutos', 'A001.mov'), 4096, 13)
  await randomFile(path.join(local, 'Brutos', 'A002.mov'), 4096, 99)
  await randomFile(path.join(local, 'Brutos', 'Take1.mov'), 300, 15)
  await randomFile(path.join(local, 'Brutos', 'Café.mov'), 700, 16)
  await randomFile(path.join(local, 'Brutos', 'A003.mov'), 5000, 21)
  await randomFile(path.join(local, 'Fotos', 'IMG_0412.CR3'), 2048, 17)
  await randomFile(path.join(local, 'Fotos', 'IMG_0413.CR3'), 2048, 22)
  await fs.writeFile(path.join(local, '.DS_Store'), 'lixo')
  await fs.mkdir(path.join(local, 'Local Vazia'))
  return { local, folderId: px.id, remote }
}

const byPath = result => Object.fromEntries(result.files.map(f => [f.relPath, f]))
const folderMap = result => Object.fromEntries(result.folders.map(f => [f.relDir, f]))

test('comparePaths: ordem natural pt-BR, nível por nível (subárvore fica junta)', () => {
  const list = ['Fotos Still/b', 'Fotos/x', 'A10', 'A2', 'Fotos', 'Árvore', 'arvore', 'B', 'Fotos Still']
  list.sort(comparePaths)
  assert.deepEqual(list, ['A2', 'A10', 'arvore', 'Árvore', 'B', 'Fotos', 'Fotos/x', 'Fotos Still', 'Fotos Still/b'])
  assert.equal(comparePaths('a', 'a'), 0)
  assert.ok(comparePaths('', 'a') < 0)
})

test('modo rápido: synced, missing, different (tamanho), only-drive, elsewhere, NFD×NFC, maiúsculas, Docs e lixo ignorados', async t => {
  const env = await setup(t)
  const fx = await fixture(env)
  const phases = []
  const result = await compareFolders({
    drive: env.drive, localPath: fx.local, driveFolderId: fx.folderId, mode: 'quick', hasher: env.hasher,
    paths: env.paths, onProgress: p => phases.push(p),
  })
  const f = byPath(result)

  assert.deepEqual(Object.keys(f).sort(), [
    'Antigas/Velho.mov', 'Brutos/A001.mov', 'Brutos/A002.mov', 'Brutos/A003.mov', 'Brutos/Café.mov', 'Brutos/Take1.mov',
    'Fotos/IMG_0412.CR3', 'Fotos/IMG_0413.CR3', 'Notas.txt', 'Roteiro.pdf',
  ].sort(), 'Doc nativo e .DS_Store (local e remoto) ficam de fora')

  assert.equal(f['Roteiro.pdf'].status, 'synced')
  assert.deepEqual(f['Roteiro.pdf'].remote, { id: fx.remote.roteiro.id, size: 1000, md5: f['Roteiro.pdf'].remote.md5, path: 'Projeto X/Roteiro.pdf' })
  assert.match(f['Roteiro.pdf'].remote.md5, /^[0-9a-f]{32}$/)
  assert.equal(f['Roteiro.pdf'].local.size, 1000)
  assert.equal(typeof f['Roteiro.pdf'].local.mtimeMs, 'number')
  assert.equal(f['Roteiro.pdf'].local.path, undefined, 'caminho dedutível não vai no JSON')

  assert.equal(f['Notas.txt'].status, 'different')
  assert.equal(f['Notas.txt'].local.size, 600)
  assert.equal(f['Notas.txt'].remote.size, 500)

  assert.equal(f['Brutos/A001.mov'].status, 'synced')
  assert.equal(f['Brutos/A002.mov'].status, 'synced', 'rápido = mesmo tamanho')

  const take = f['Brutos/Take1.mov']
  assert.equal(take.status, 'synced')
  assert.equal(take.remote.id, fx.remote.take1.id)
  assert.match(take.note, /Take1\.MOV/)
  assert.match(take.note, /maiúscula/)

  const cafe = f['Brutos/Café.mov']
  assert.equal(cafe.relPath, 'Brutos/Café'.normalize('NFC') + '.mov')
  assert.equal(cafe.status, 'synced', 'NFD local casa com NFC no Drive')
  assert.equal(cafe.remote.id, fx.remote.cafe.id)
  assert.equal(cafe.local.path, path.join(fx.local, 'Brutos', 'Café.mov'), 'nome no disco (NFD) preservado para abrir o arquivo')

  assert.equal(f['Brutos/A003.mov'].status, 'missing')
  assert.equal(f['Brutos/A003.mov'].remote, undefined)

  const moved = f['Fotos/IMG_0412.CR3']
  assert.equal(moved.status, 'elsewhere')
  assert.equal(moved.remote.id, fx.remote.img412.id)
  assert.equal(moved.remote.path, 'Projeto X/Fotos Still/Selecionadas/IMG_0412.CR3')
  assert.equal(f['Fotos/IMG_0413.CR3'].status, 'missing')

  const velho = f['Antigas/Velho.mov']
  assert.equal(velho.status, 'only-drive')
  assert.equal(velho.relDir, 'Antigas')
  assert.equal(velho.name, 'Velho.mov')
  assert.equal(velho.local, undefined)
  assert.equal(velho.remote.id, fx.remote.velho.id)
  assert.equal(velho.remote.size, 800)
  assert.equal(velho.remote.mimeType, 'video/quicktime')
  assert.ok(velho.remote.modifiedTime)
  assert.ok(!result.files.some(x => x.remote?.id === fx.remote.img412.id && x.status === 'only-drive'), 'o arquivo movido não aparece também como só no Drive')

  assert.deepEqual(result.summary, {
    files: 10,
    bytes: 1000 + 600 + 4096 + 4096 + 300 + 700 + 5000 + 2048 + 2048 + 800,
    synced: 5,
    syncedBytes: 1000 + 4096 + 4096 + 300 + 700,
    missing: 2,
    missingBytes: 5000 + 2048,
    different: 1,
    differentBytes: 600,
    onlyDrive: 1,
    onlyDriveBytes: 800,
    elsewhere: 1,
    elsewhereBytes: 2048,
    ignored: 1,
    skipped: 0,
  })

  // Pastas: subárvore local ∪ Drive, com estado e nomes; ordem por caminho.
  assert.deepEqual(result.folders.map(x => x.relDir), ['', 'Antigas', 'Brutos', 'Fotos', 'Fotos Still', 'Fotos Still/Selecionadas', 'Local Vazia', 'Vazia'])
  const d = folderMap(result)
  const pick = x => ({ files: x.files, synced: x.synced, missing: x.missing, different: x.different, onlyDrive: x.onlyDrive, elsewhere: x.elsewhere, state: x.state })
  assert.deepEqual(pick(d['']), { files: 10, synced: 6, missing: 2, different: 1, onlyDrive: 1, elsewhere: 1, state: 'partial' })
  assert.equal(d[''].name, 'Projeto X')
  assert.equal(d[''].depth, 0)
  assert.equal(d[''].bytes, result.summary.bytes)
  assert.equal(d[''].missingBytes, 7048)
  assert.deepEqual(pick(d.Brutos), { files: 5, synced: 4, missing: 1, different: 0, onlyDrive: 0, elsewhere: 0, state: 'partial' })
  assert.equal(d.Brutos.missingBytes, 5000)
  assert.equal(d.Brutos.bytes, 4096 + 4096 + 300 + 700 + 5000)
  assert.deepEqual(pick(d.Fotos), { files: 2, synced: 1, missing: 1, different: 0, onlyDrive: 0, elsewhere: 1, state: 'partial' })
  assert.deepEqual(pick(d.Antigas), { files: 1, synced: 0, missing: 0, different: 0, onlyDrive: 1, elsewhere: 0, state: 'complete' })
  assert.equal(d.Antigas.existsLocal, false)
  assert.equal(d.Antigas.existsDrive, true)
  assert.equal(d['Fotos Still/Selecionadas'].state, 'empty', 'o arquivo de lá foi casado como "em outro lugar"')
  assert.equal(d['Fotos Still/Selecionadas'].name, 'Selecionadas')
  assert.equal(d['Fotos Still/Selecionadas'].depth, 2)
  assert.equal(d['Local Vazia'].state, 'empty')
  assert.deepEqual([d['Local Vazia'].existsLocal, d['Local Vazia'].existsDrive], [true, false])
  assert.deepEqual([d.Vazia.existsLocal, d.Vazia.existsDrive, d.Vazia.state], [false, true, 'empty'])

  // Cabeçalho do resultado.
  assert.equal(result.mode, 'quick')
  assert.equal(result.localPath, fx.local)
  assert.equal(result.localIsDir, true)
  assert.deepEqual(result.drive, { folderId: fx.folderId, name: 'Projeto X', path: 'Meu Drive/Projetos/Projeto X', driveId: null })
  assert.match(result.id, /^cmp/)
  assert.ok(!Number.isNaN(Date.parse(result.createdAt)))

  // Arquivos ordenados por caminho (natural, nível por nível).
  const rels = result.files.map(x => x.relPath)
  assert.deepEqual(rels, [...rels].sort(comparePaths))

  // Progresso: fases em ordem, sem 'hash' no rápido, terminando em match completo.
  const order = phases.map(p => PHASES.indexOf(p.phase))
  assert.ok(order.every(i => i >= 0))
  assert.ok(order.every((v, i) => i === 0 || v >= order[i - 1]), `fases fora de ordem: ${phases.map(p => p.phase)}`)
  assert.ok(!phases.some(p => p.phase === 'hash'))
  const last = phases[phases.length - 1]
  assert.deepEqual([last.phase, last.done, last.total], ['match', 9, 9])

  // Gravado em disco e recuperável.
  assert.deepEqual(await loadCompare(result.id, env.paths), result)
  assert.equal(await loadCompare('../accounts', env.paths), null)
  assert.equal(await loadCompare('cmp-nao-existe', env.paths), null)
  assert.equal(env.hasher.started, 0, 'o modo rápido não calcula MD5')
})

test('modo completo: MD5 diferente vira "different", só calcula o necessário e usa o cache na segunda vez', async t => {
  const env = await setup(t)
  const fx = await fixture(env)
  const phases = []
  const result = await compareFolders({
    drive: env.drive, localPath: fx.local, driveFolderId: fx.folderId, mode: 'deep', hasher: env.hasher,
    paths: env.paths, onProgress: p => phases.push(p),
  })
  const f = byPath(result)
  assert.equal(result.mode, 'deep')
  assert.equal(f['Brutos/A002.mov'].status, 'different')
  assert.match(f['Brutos/A002.mov'].note, /MD5/)
  assert.equal(f['Brutos/A001.mov'].status, 'synced')
  assert.equal(f['Brutos/Café.mov'].status, 'synced')
  assert.equal(f['Brutos/Take1.mov'].status, 'synced')
  assert.equal(f['Roteiro.pdf'].status, 'synced')
  assert.equal(f['Notas.txt'].status, 'different')
  assert.equal(f['Fotos/IMG_0412.CR3'].status, 'elsewhere', 'mesmo MD5 em outra pasta')
  assert.equal(f['Fotos/IMG_0413.CR3'].status, 'missing')
  assert.equal(f['Brutos/A003.mov'].status, 'missing')
  assert.equal(result.summary.synced, 4)
  assert.equal(result.summary.different, 2)
  assert.equal(result.summary.differentBytes, 600 + 4096)
  assert.equal(folderMap(result).Brutos.different, 1)

  // MD5 só do necessário: Notas.txt (tamanho já difere) e A003.mov (nenhum arquivo de 5000 bytes no Drive) ficam de fora.
  const cached = rel => {
    const x = f[rel]
    const p = x.local.path ?? path.join(fx.local, ...rel.split('/'))
    return env.hasher.getCached(p, x.local.size, x.local.mtimeMs)
  }
  assert.equal(env.hasher.started, 7, 'Roteiro, A001, A002, Take1, Café, IMG_0412, IMG_0413')
  assert.equal(cached('Notas.txt'), null)
  assert.equal(cached('Brutos/A003.mov'), null)
  assert.equal(cached('Brutos/A001.mov'), f['Brutos/A001.mov'].remote.md5)
  assert.equal(cached('Brutos/A002.mov') === f['Brutos/A002.mov'].remote.md5, false)

  const hashPhase = phases.filter(p => p.phase === 'hash')
  assert.ok(hashPhase.length >= 2)
  const lastHash = hashPhase[hashPhase.length - 1]
  assert.deepEqual([lastHash.done, lastHash.total], [7, 7])
  assert.equal(lastHash.bytesDone, lastHash.bytesTotal)
  const order = phases.map(p => PHASES.indexOf(p.phase))
  assert.ok(order.every((v, i) => i === 0 || v >= order[i - 1]), `fases fora de ordem: ${phases.map(p => p.phase)}`)

  // Segunda vez: tudo pelo cache, nenhum cálculo novo.
  const again = await compareFolders({ drive: env.drive, localPath: fx.local, driveFolderId: fx.folderId, mode: 'deep', hasher: env.hasher, paths: env.paths })
  assert.equal(env.hasher.started, 7)
  assert.deepEqual(again.files.map(x => [x.relPath, x.status]), result.files.map(x => [x.relPath, x.status]))
  assert.notEqual(again.id, result.id)
})

test('nomes repetidos no Drive, atalhos, pasta com maiúsculas diferentes, arquivo vazio e sem MD5 no Drive', async t => {
  const env = await setup(t)
  const m = env.mock
  const top = m.addFolder('Edição', 'root')
  const dup = m.addFolder('Dup', top.id)
  const c1 = m.addFile('Clip.mov', dup.id, { size: 100, seed: 31 })
  const c2 = m.addFile('Clip.mov', dup.id, { size: 100, seed: 32 })
  const outside = m.addFile('Referência.mov', 'root', { size: 900, seed: 33 })
  const atalhos = m.addFolder('Atalhos', top.id)
  m.addShortcut('Referência.mov', atalhos.id, outside.id)
  const gone = m.addFile('Some.mov', 'root', { size: 5, seed: 34 })
  m.addShortcut('Some.mov', atalhos.id, gone.id)
  m.deleteItem(gone.id) // atalho pendurado: ignorado
  const caixa = m.addFolder('BRUTOS', top.id)
  m.addFile('Y.mov', caixa.id, { size: 50, seed: 35 })
  m.addFile('Vazio.txt', top.id, { size: 0, seed: 36 })
  m.addFile('SemMd5.bin', top.id, { size: 64, seed: 37, md5: null })

  const local = path.join(env.dir, 'Edição')
  await randomFile(path.join(local, 'Dup', 'Clip.mov'), 100, 32) // igual ao SEGUNDO do Drive
  await randomFile(path.join(local, 'Atalhos', 'Referência.mov'), 900, 33)
  await randomFile(path.join(local, 'brutos', 'X.mov'), 70, 38) // pasta existe no Drive como BRUTOS
  await fs.writeFile(path.join(local, 'Outro vazio.txt'), '') // vazio sem par: não casa com qualquer vazio
  await randomFile(path.join(local, 'SemMd5.bin'), 64, 99) // conteúdo diferente, mas o Drive não tem MD5

  for (const mode of ['quick', 'deep']) {
    const result = await compareFolders({ drive: env.drive, localPath: local, driveFolderId: top.id, mode, hasher: env.hasher, paths: env.paths })
    const all = result.files.map(x => `${x.status}:${x.relPath}:${x.remote?.id ?? '-'}`)
    const clipSynced = result.files.find(x => x.relPath === 'Dup/Clip.mov' && x.status === 'synced')
    assert.ok(clipSynced, `${mode}: ${all}`)
    const clipOnly = result.files.find(x => x.relPath === 'Dup/Clip.mov' && x.status === 'only-drive')
    assert.ok(clipOnly, `${mode}: o outro Clip.mov é só do Drive`)
    if (mode === 'deep') {
      assert.equal(clipSynced.remote.id, c2.id, 'deep: o MD5 escolhe o par certo entre nomes repetidos')
      assert.equal(clipOnly.remote.id, c1.id)
    } else {
      assert.notEqual(clipSynced.remote.id, clipOnly.remote.id)
    }

    const ref = result.files.find(x => x.relPath === 'Atalhos/Referência.mov')
    assert.equal(ref.status, 'synced', `${mode}: atalho para arquivo conta pelo alvo`)
    assert.equal(ref.remote.id, outside.id)
    assert.equal(ref.remote.shortcut, true)
    assert.match(ref.note, /atalho/)
    assert.ok(!result.files.some(x => x.name === 'Some.mov'), 'atalho pendurado não aparece')

    const x = result.files.find(x => x.relPath === 'brutos/X.mov')
    assert.equal(x.status, 'missing')
    assert.equal(x.remoteRelDir, 'BRUTOS', 'sobe para a pasta que já existe no Drive')
    assert.match(x.note, /BRUTOS/)
    const y = result.files.find(x => x.name === 'Y.mov')
    assert.equal(y.status, 'only-drive')
    assert.equal(y.relPath, 'brutos/Y.mov', 'só no Drive entra na grafia da pasta local')
    assert.equal(y.remote.relPath, 'BRUTOS/Y.mov')
    const dirs = result.folders.map(f => f.relDir)
    assert.ok(dirs.includes('brutos') && !dirs.includes('BRUTOS'), `a árvore não duplica a pasta: ${dirs}`)
    const brutos = result.folders.find(f => f.relDir === 'brutos')
    assert.deepEqual([brutos.existsLocal, brutos.existsDrive, brutos.files, brutos.missing, brutos.onlyDrive, brutos.state], [true, true, 2, 1, 1, 'partial'])

    assert.equal(result.files.find(x => x.relPath === 'Outro vazio.txt').status, 'missing', `${mode}: vazio não casa com outro vazio de nome diferente`)
    assert.equal(result.files.find(x => x.relPath === 'Vazio.txt').status, 'only-drive')

    const semMd5 = result.files.find(x => x.relPath === 'SemMd5.bin')
    assert.equal(semMd5.status, 'synced')
    if (mode === 'deep') assert.match(semMd5.note, /MD5/)
    assert.equal(semMd5.remote.md5, null)
  }
})

test('modo completo com arquivo local que não dá para ler: fica a conferência por tamanho, com nota', async t => {
  const env = await setup(t)
  const top = env.mock.addFolder('Trancado', 'root')
  env.mock.addFile('Segredo.mov', top.id, { size: 128, seed: 41 })
  env.mock.addFile('Outro.mov', top.id, { size: 64, seed: 42 })
  const local = path.join(env.dir, 'Trancado')
  await randomFile(path.join(local, 'Segredo.mov'), 128, 41)
  await randomFile(path.join(local, 'Solto.mov'), 64, 43) // sem par: também precisa de MD5 (há um de 64 bytes no Drive)
  // Hasher que falha como um disco sem permissão (rodar como root leria qualquer arquivo).
  const failing = {
    init: async () => {},
    getCached: () => null,
    hash: async p => {
      const err = new Error(`EACCES: permission denied, open '${p}'`)
      err.code = 'EACCES'
      throw err
    },
  }
  const result = await compareFolders({ drive: env.drive, localPath: local, driveFolderId: top.id, mode: 'deep', hasher: failing, paths: env.paths })
  const f = byPath(result)
  assert.equal(f['Segredo.mov'].status, 'synced')
  assert.match(f['Segredo.mov'].note, /Não consegui ler o arquivo para conferir o MD5 \(EACCES\)/)
  assert.equal(f['Solto.mov'].status, 'missing')
  assert.equal(f['Outro.mov'].status, 'only-drive')
})

test('cancelar: AbortError antes de começar, durante a leitura do Drive e durante o MD5', async t => {
  const env = await setup(t)
  const fx = await fixture(env)
  const base = { drive: env.drive, localPath: fx.local, driveFolderId: fx.folderId, hasher: env.hasher, paths: env.paths }

  const ac0 = new AbortController()
  ac0.abort()
  await assert.rejects(compareFolders({ ...base, signal: ac0.signal }), err => isAbortError(err))

  // Durante a leitura do Drive (latência deixa a varredura lenta o bastante para cancelar no meio).
  env.mock.setOptions({ latencyMs: 30 })
  const ac1 = new AbortController()
  const p1 = compareFolders({ ...base, signal: ac1.signal, mode: 'quick', onProgress: p => p.phase === 'local' && setTimeout(() => ac1.abort(), 20) })
  await assert.rejects(p1, err => isAbortError(err))
  env.mock.setOptions({ latencyMs: 0 })

  // Durante o MD5.
  const ac2 = new AbortController()
  const p2 = compareFolders({ ...base, signal: ac2.signal, mode: 'deep', onProgress: p => p.phase === 'hash' && ac2.abort() })
  await assert.rejects(p2, err => isAbortError(err))

  const saved = await fs.readdir(env.paths.compares).catch(() => [])
  assert.equal(saved.length, 0, 'comparação cancelada não grava resultado')
})

test('erros claros: pasta local que não existe, pasta do Drive que é arquivo ou sumiu; guarda só os 20 resultados mais recentes', async t => {
  const env = await setup(t)
  const top = env.mock.addFolder('P', 'root')
  const file = env.mock.addFile('solto.mov', 'root', { size: 10, seed: 51 })
  const local = path.join(env.dir, 'P')
  await fs.mkdir(local)
  await assert.rejects(
    compareFolders({ drive: env.drive, localPath: path.join(env.dir, 'nao-existe'), driveFolderId: top.id, paths: env.paths }),
    err => err.status === 404 && /Não encontrei/.test(err.message),
  )
  await assert.rejects(
    compareFolders({ drive: env.drive, localPath: local, driveFolderId: file.id, paths: env.paths }),
    err => err.status === 400 && /pasta do Drive/.test(err.message),
  )
  const sumiu = env.mock.addFolder('Sumiu', 'root')
  env.mock.deleteItem(sumiu.id)
  await assert.rejects(
    compareFolders({ drive: env.drive, localPath: local, driveFolderId: sumiu.id, paths: env.paths }),
    err => err.status === 404 && /Não achei esta pasta no Drive/.test(err.message),
  )
  // Muitas comparações: as antigas saem do disco.
  const ids = []
  for (let i = 0; i < 23; i++) ids.push((await compareFolders({ drive: env.drive, localPath: local, driveFolderId: top.id, paths: env.paths })).id)
  const saved = (await fs.readdir(env.paths.compares)).sort()
  assert.equal(saved.length, 20)
  assert.equal(await loadCompare(ids[0], env.paths), null)
  assert.ok(await loadCompare(ids[22], env.paths))
})

test('desempenho: ~5 mil arquivos locais × 5 mil no Drive comparam em menos de 10 s', async t => {
  const env = await setup(t)
  const m = env.mock
  const top = m.addFolder('Grande', 'root')
  const local = path.join(env.dir, 'Grande')
  const FOLDERS = 50
  const PER = 100
  // md5 fixo: o Drive falso não precisa calcular 5 mil MD5 (o modo rápido nem olha o conteúdo).
  const FAKE_MD5 = '0123456789abcdef0123456789abcdef'
  for (let d = 0; d < FOLDERS; d++) {
    const name = `Cartão ${String(d).padStart(2, '0')}`
    const folder = m.addFolder(name, top.id)
    await fs.mkdir(path.join(local, name), { recursive: true })
    const writes = []
    for (let i = 0; i < PER; i++) {
      const file = `C${d}_${i}.mov`
      const n = d * PER + i
      const size = 16 + (n % 7)
      if (n % 10 !== 0) m.addFile(file, folder.id, { size, seed: 1000 + n, md5: FAKE_MD5 }) // 1 em cada 10 falta no Drive
      // Alguns só no Drive (n % 25 === 1), alguns com tamanho diferente (n % 50 === 2).
      if (n % 25 !== 1) writes.push(fs.writeFile(path.join(local, name, file), Buffer.alloc(n % 50 === 2 ? size + 1 : size, n % 251)))
    }
    await Promise.all(writes)
  }
  const t0 = performance.now()
  const result = await compareFolders({ drive: env.drive, localPath: local, driveFolderId: top.id, mode: 'quick', hasher: env.hasher, paths: env.paths })
  const ms = performance.now() - t0
  // Conta esperada, pelas mesmas regras que montaram o cenário.
  const want = { synced: 0, missing: 0, different: 0, onlyDrive: 0 }
  for (let n = 0; n < FOLDERS * PER; n++) {
    const remote = n % 10 !== 0
    const localHas = n % 25 !== 1
    if (localHas && remote) want[n % 50 === 2 ? 'different' : 'synced']++
    else if (localHas) want.missing++
    else if (remote) want.onlyDrive++
  }
  const s = result.summary
  assert.deepEqual({ synced: s.synced, missing: s.missing, different: s.different, onlyDrive: s.onlyDrive }, want)
  assert.equal(s.elsewhere, 0)
  assert.equal(s.files, want.synced + want.missing + want.different + want.onlyDrive)
  assert.equal(result.folders.length, FOLDERS + 1)
  assert.ok(ms < 10_000, `comparação levou ${Math.round(ms)} ms`)
  t.diagnostic(`5k × 5k: ${Math.round(ms)} ms (${s.synced} iguais, ${s.missing} faltando, ${s.different} diferentes, ${s.onlyDrive} só no Drive)`)
})

test('proxies que o app gerou (pasta Proxy, appProperties.sobedesce = previa) ficam fora do "Só no Drive"', async t => {
  const env = await setup(t)
  const m = env.mock
  const top = m.addFolder('Diária 02', 'root')
  const brutos = m.addFolder('Brutos', top.id)
  m.addFile('A.mov', brutos.id, { size: 300, seed: 1 })
  const prx = m.addFolder('Proxy', brutos.id)
  const pa = m.addFile('A.mp4', prx.id, { size: 40, seed: 2, appProperties: { sobedesce: 'previa', original: 'x' } })
  const pb = m.addFile('B.mp4', prx.id, { size: 41, seed: 3, appProperties: { sobedesce: 'previa' } })
  // Pasta Proxy com algo feito à mão: o arquivo à mão continua "só no Drive" e a pasta fica.
  const outro = m.addFolder('Outro', top.id)
  const prx2 = m.addFolder('Proxy', outro.id)
  const pc = m.addFile('C.mp4', prx2.id, { size: 42, seed: 4, appProperties: { sobedesce: 'previa' } })
  m.addFile('manual.mp4', prx2.id, { size: 43, seed: 5 })
  // Proxy do app que também está no computador: continua sendo par (não vira "falta subir").
  const clip = m.addFolder('Clip', top.id)
  const prx3 = m.addFolder('Proxy', clip.id)
  m.addFile('D.mp4', prx3.id, { size: 44, seed: 6, appProperties: { sobedesce: 'previa' } })
  m.addFile('Velho.mov', top.id, { size: 45, seed: 7 })

  const local = path.join(env.dir, 'Diária 02')
  await randomFile(path.join(local, 'Brutos', 'A.mov'), 300, 1)
  await randomFile(path.join(local, 'Clip', 'Proxy', 'D.mp4'), 44, 6)

  const result = await compareFolders({ drive: env.drive, localPath: local, driveFolderId: top.id, mode: 'quick', hasher: env.hasher, paths: env.paths })
  const f = byPath(result)
  const ids = new Set(result.files.map(x => x.remote?.id).filter(Boolean))
  for (const p of [pa, pb, pc]) assert.ok(!ids.has(p.id), `${p.name} não aparece na lista`)
  assert.equal(f['Outro/Proxy/manual.mp4'].status, 'only-drive', 'arquivo sem a marca do app segue "só no Drive"')
  assert.equal(f['Velho.mov'].status, 'only-drive')
  assert.equal(f['Clip/Proxy/D.mp4'].status, 'synced', 'proxy do app com par no computador continua par')
  assert.equal(f['Brutos/A.mov'].status, 'synced')
  assert.equal(result.summary.onlyDrive, 2)
  assert.equal(result.summary.proxies, 3)
  const dirs = folderMap(result)
  assert.equal(dirs['Brutos/Proxy'], undefined, 'pasta Proxy só com proxies do app sai da árvore')
  assert.ok(dirs['Outro/Proxy'], 'pasta Proxy com outra coisa dentro fica')
  assert.equal(dirs['Brutos'].state, 'complete')

  // "Baixar o que só está no Drive": só os dois de verdade.
  const plan = planDownloadsFromCompare(result, { accountId: env.accountId })
  assert.deepEqual(plan.records.map(r => r.name).sort(), ['Velho.mov', 'manual.mp4'])
})
