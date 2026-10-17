// Planejador contra o Drive falso: downloads (pastas, nomes repetidos, Docs, atalhos, conflitos locais),
// uploads (pastas, nomes no topo, lixo/links, limite de 5 TB, aviso de espaço) e lotes vindos do comparador.
// Os registros também passam pelas tarefas de verdade (DownloadTask/UploadTask), para garantir que o formato serve.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setupDrive, makeTmpDir, randomFile, md5File } from './helpers.js'
import { DriveClient, GOOGLE_EXPORTS } from '../src/google/drive.js'
import { Hasher } from '../src/engine/hasher.js'
import { planDownloads, planUploads, planUploadsFromCompare, planDownloadsFromCompare, MAX_UPLOAD_SIZE } from '../src/engine/planner.js'
import { compareFolders } from '../src/engine/compare.js'
import { DownloadTask } from '../src/engine/download.js'
import { UploadTask } from '../src/engine/upload.js'
import { DEFAULT_SETTINGS } from '../src/config.js'
import { BandwidthLimiter } from '../src/util/limiter.js'
import { PART_SUFFIX } from '../src/util/paths.js'
import { closeHttp } from '../src/net/http.js'
import { isAbortError } from '../src/util/backoff.js'

after(() => closeHttp())

const DOCX = GOOGLE_EXPORTS['application/vnd.google-apps.document']

async function setup(t, mockOptions = {}) {
  const ctx = await setupDrive(mockOptions)
  const dir = await makeTmpDir('sobedesce-planner-')
  const hasher = new Hasher({ cacheFile: path.join(ctx.home, 'hash-cache.json'), workers: 1, log: () => {} })
  t.after(async () => {
    await hasher.close()
    await ctx.cleanup()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })
  })
  const drive = new DriveClient(ctx.auth, ctx.accountId, { ratePerSec: 1000, retryBaseMs: 5 })
  return { ...ctx, drive, hasher, dir }
}

/** Confere os campos comuns de um TransferRecord recém-planejado. */
function assertFresh(rec, { type, accountId, batchId }) {
  assert.match(rec.id, /^t/)
  assert.equal(rec.type, type)
  assert.equal(rec.accountId, accountId)
  assert.equal(rec.batchId, batchId)
  assert.equal(rec.status, 'queued')
  assert.equal(rec.bytesDone, 0)
  assert.equal(rec.attempts, 0)
  assert.equal(rec.verify, null)
  assert.equal(rec.error, null)
  assert.equal(rec.retryAt, null)
  assert.equal(rec.startedAt, null)
  assert.equal(rec.finishedAt, null)
  assert.equal(typeof rec.createdAt, 'number')
  assert.equal(rec.updatedAt, rec.createdAt)
  assert.ok('note' in rec)
  if (type === 'download') {
    assert.equal(rec.segments, null)
    assert.equal(rec.dest.tempPath, rec.dest.path + PART_SUFFIX)
    assert.ok(path.isAbsolute(rec.dest.path))
  } else {
    assert.equal(rec.session, null)
    assert.equal(rec.target.parentId, null)
    assert.equal(rec.target.fileId, null)
    assert.ok(path.isAbsolute(rec.local.path))
  }
}

function taskCtx(env, settings = {}) {
  const live = { ...DEFAULT_SETTINGS, ...settings }
  return {
    drive: env.drive,
    settings: { get: () => live },
    limiter: new BandwidthLimiter(0),
    hasher: env.hasher,
    folderCache: new Map(),
    persist() {},
    onBytes() {},
    log() {},
    retryBaseMs: 5,
  }
}

const byRel = records => Object.fromEntries(records.map(r => [r.relPath, r]))

test('planDownloads: pasta vira destino/<pasta>/<caminho>, nomes repetidos do Drive, Docs exportados, atalhos e o que não dá para baixar', async t => {
  const env = await setup(t)
  const m = env.mock
  const brutos = m.addFolder('Brutos', 'root')
  const dia = m.addFolder('Dia 01', brutos.id)
  const a001 = m.addFile('A001.mov', dia.id, { size: 1000, seed: 1 })
  const t1 = m.addFile('Take1.mov', dia.id, { size: 200, seed: 2 })
  const t2 = m.addFile('Take1.mov', dia.id, { size: 300, seed: 3 })
  const doc = m.addGoogleDoc('Roteiro', brutos.id, 'document')
  m.addGoogleDoc('Planilha.xlsx', brutos.id, 'spreadsheet')
  m.addGoogleDoc('Formulário', brutos.id, 'form')
  m.addFile('Bloqueado.mov', brutos.id, { size: 10, seed: 4, canDownload: false })
  const original = m.addFile('Original.mov', 'root', { size: 500, seed: 5 })
  m.addShortcut('Ref.mov', brutos.id, original.id)
  const gone = m.addFile('Some.mov', 'root', { size: 5, seed: 6 })
  m.addShortcut('Quebrado.mov', brutos.id, gone.id)
  m.deleteItem(gone.id)
  const outra = m.addFolder('Outra', 'root')
  m.addShortcut('Outra Pasta', brutos.id, outra.id)
  const barra = m.addFile('a/b.mov', brutos.id, { size: 20, seed: 7 })
  m.addFile('.DS_Store', dia.id, { size: 8, seed: 8 })
  m.addFolder('Vazia', brutos.id)
  const destDir = path.join(env.dir, 'Baixados')

  const item = await env.drive.getItem(brutos.id)
  const progress = []
  const plan = await planDownloads({ drive: env.drive, accountId: env.accountId, items: [item], destDir, conflict: 'skip', onProgress: p => progress.push(p) })
  const { batch, records, skipped, warnings, totals } = plan

  assert.equal(batch.type, 'download')
  assert.equal(batch.label, 'Pasta "Brutos"')
  assert.equal(batch.accountId, env.accountId)
  assert.match(batch.id, /^b/)
  assert.equal(typeof batch.createdAt, 'number')
  for (const r of records) assertFresh(r, { type: 'download', accountId: env.accountId, batchId: batch.id })
  assert.deepEqual(warnings, [])
  assert.ok(progress.length >= 1)

  const r = byRel(records)
  assert.deepEqual(Object.keys(r).sort(), [
    'Brutos/Dia 01/A001.mov', 'Brutos/Dia 01/Take1 (2).mov', 'Brutos/Dia 01/Take1.mov', 'Brutos/Planilha.xlsx', 'Brutos/Ref.mov',
    'Brutos/Roteiro.docx', 'Brutos/a_b.mov',
  ].sort())

  const a = r['Brutos/Dia 01/A001.mov']
  assert.equal(a.name, 'A001.mov')
  assert.equal(a.size, 1000)
  assert.equal(a.dest.path, path.join(destDir, 'Brutos', 'Dia 01', 'A001.mov'))
  assert.equal(a.note, null)
  // checkedAt: metadados lidos agora pela varredura (o download começa sem perguntar de novo ao Drive).
  assert.ok(a.source.checkedAt > 0 && a.source.checkedAt <= Date.now())
  assert.deepEqual(a.source, {
    fileId: a001.id, mimeType: 'video/quicktime', md5: await m.contentMd5(a001.id), modifiedTime: a001.modifiedTime,
    headRevisionId: a001.headRevisionId, resourceKey: null, checkedAt: a.source.checkedAt,
  })

  // O Drive aceita dois "Take1.mov" na mesma pasta; no disco o segundo ganha "(2)".
  const takes = [r['Brutos/Dia 01/Take1.mov'], r['Brutos/Dia 01/Take1 (2).mov']]
  assert.deepEqual(takes.map(x => x.source.fileId).sort(), [t1.id, t2.id].sort())
  assert.equal(takes[0].note, null)
  assert.match(takes[1].note, /mais de um "Take1\.mov"/)
  assert.equal(takes[1].dest.path, path.join(destDir, 'Brutos', 'Dia 01', 'Take1 (2).mov'))

  const roteiro = r['Brutos/Roteiro.docx']
  assert.equal(roteiro.size, null)
  assert.equal(roteiro.source.fileId, doc.id)
  assert.equal(roteiro.source.md5, null)
  assert.deepEqual(roteiro.source.export, { mime: DOCX.mime, ext: '.docx' })
  assert.equal(roteiro.note, 'Exportado como .docx')
  assert.equal(r['Brutos/Planilha.xlsx'].name, 'Planilha.xlsx', 'não repete a extensão')

  const ref = r['Brutos/Ref.mov']
  assert.equal(ref.source.fileId, original.id, 'atalho baixa o alvo')
  assert.equal(ref.size, 500)
  assert.equal(r['Brutos/a_b.mov'].source.fileId, barra.id, "'/' no nome do Drive não cria pasta")

  const reasons = Object.fromEntries(skipped.map(s => [s.name, s.reason]))
  assert.match(reasons['Brutos/Formulário'], /não pode ser baixado/)
  assert.match(reasons['Brutos/Bloqueado.mov'], /dono bloqueou/)
  assert.match(reasons['Brutos/Quebrado.mov'], /atalho aponta/)
  assert.match(reasons['Brutos/Outra Pasta'], /atalho para outra pasta/)
  assert.ok(!records.some(x => x.name === '.DS_Store') && !skipped.some(x => /DS_Store/.test(x.name)), '.DS_Store fica de fora em silêncio')
  assert.deepEqual(totals, { count: 7, bytes: 1000 + 200 + 300 + 500 + 20 })

  // As tarefas de verdade aceitam os registros e o conteúdo chega certo.
  for (const rec of records) await new DownloadTask(rec, taskCtx(env), { retryBaseMs: 5 }).run(new AbortController().signal)
  for (const rec of records) {
    if (rec.source.export) {
      assert.ok((await fs.stat(rec.dest.path)).size > 0)
      continue
    }
    assert.equal(await md5File(rec.dest.path), await m.contentMd5(rec.source.fileId), rec.relPath)
  }
  assert.equal(await md5File(path.join(destDir, 'Brutos', 'Dia 01', 'Take1 (2).mov')), await m.contentMd5(takes[1].source.fileId))
})

test('planDownloads: conflitos com arquivos locais (skip / rename / overwrite), temporário de outro download e caminhos reservados', async t => {
  const env = await setup(t)
  const m = env.mock
  const cena = m.addFolder('Cena', 'root')
  for (const [name, seed] of [['A.mov', 11], ['B.mov', 12], ['C.mov', 13], ['D.mov', 14], ['E.mov', 15], ['E.mov', 16]]) {
    m.addFile(name, cena.id, { size: 100, seed })
  }
  m.addGoogleDoc('Notas', cena.id, 'document')
  const destDir = path.join(env.dir, 'Destino')
  const local = path.join(destDir, 'Cena')
  await randomFile(path.join(local, 'A.mov'), 100, 99) // mesmo tamanho
  await randomFile(path.join(local, 'B.mov'), 50, 98) // tamanho diferente
  await fs.writeFile(path.join(local, `C.mov${PART_SUFFIX}`), '') // outro download (pausado) usa este nome
  await randomFile(path.join(local, 'e.mov'), 100, 97) // só muda maiúscula/minúscula
  await fs.writeFile(path.join(local, 'Notas.docx'), 'doc antigo')
  const item = await env.drive.getItem(cena.id)
  const plan = conflict => planDownloads({ drive: env.drive, accountId: env.accountId, items: [item], destDir, conflict })

  // skip: igual (mesmo tamanho) não vira registro; diferente fica com os dois; temporário alheio nunca é compartilhado.
  const skip = await plan('skip')
  const s = byRel(skip.records)
  assert.deepEqual(Object.keys(s).sort(), ['Cena/B (2).mov', 'Cena/C (2).mov', 'Cena/D.mov'])
  assert.match(s['Cena/B (2).mov'].note, /Já existia "B\.mov" no computador/)
  assert.match(s['Cena/C (2).mov'].note, /Outra transferência/)
  assert.deepEqual(skip.skipped.map(x => x.name).sort(), ['Cena/A.mov', 'Cena/E.mov', 'Cena/E.mov', 'Cena/Notas.docx'])
  assert.ok(skip.skipped.every(x => /Já existe no computador/.test(x.reason)))
  assert.ok(Object.values(s).every(r => !r.dest.overwrite))

  // rename: tudo que já existe ganha outro nome; o repetido do Drive também.
  const ren = byRel((await plan('rename')).records)
  assert.deepEqual(Object.keys(ren).sort(), ['Cena/A (2).mov', 'Cena/B (2).mov', 'Cena/C (2).mov', 'Cena/D.mov', 'Cena/E (2).mov', 'Cena/E (3).mov', 'Cena/Notas (2).docx'])
  assert.match(ren['Cena/E (2).mov'].note, /Já existia "e\.mov"/)
  assert.match(ren['Cena/E (3).mov'].note, /Já existia "e\.mov"/, 'o segundo E.mov também esbarra no e.mov local')
  assert.match(ren['Cena/Notas (2).docx'].note, /^Exportado como \.docx · Já existia/)

  // overwrite: mantém o caminho e marca dest.overwrite; temporário alheio e repetidos continuam com outro nome.
  const over = byRel((await plan('overwrite')).records)
  assert.deepEqual(Object.keys(over).sort(), ['Cena/A.mov', 'Cena/B.mov', 'Cena/C (2).mov', 'Cena/D.mov', 'Cena/E (2).mov', 'Cena/E.mov', 'Cena/Notas.docx'])
  assert.equal(over['Cena/A.mov'].dest.overwrite, true)
  assert.equal(over['Cena/A.mov'].dest.path, path.join(local, 'A.mov'))
  assert.match(over['Cena/A.mov'].note, /Vai substituir/)
  assert.equal(over['Cena/D.mov'].dest.overwrite, undefined)
  assert.equal(over['Cena/C (2).mov'].dest.overwrite, undefined)

  // Caminho reservado por outra transferência da fila.
  const reserved = await planDownloads({ drive: env.drive, accountId: env.accountId, items: [item], destDir, conflict: 'rename', reservedPaths: [path.join(local, 'D.mov')] })
  const rr = byRel(reserved.records)
  assert.ok(rr['Cena/D (2).mov'] && !rr['Cena/D.mov'])
  assert.match(rr['Cena/D (2).mov'].note, /Outra transferência já vai gravar "D\.mov"/)

  // overwrite de verdade: o arquivo antigo é substituído.
  const recA = over['Cena/A.mov']
  await new DownloadTask(recA, taskCtx(env), { retryBaseMs: 5 }).run(new AbortController().signal)
  assert.equal(recA.dest.path, path.join(local, 'A.mov'))
  assert.equal(await md5File(path.join(local, 'A.mov')), await m.contentMd5(recA.source.fileId))
})

test('planDownloads: arquivos soltos, rótulos do lote, item incompleto, repetidos na seleção, pastas com o mesmo nome e erros', async t => {
  const env = await setup(t)
  const m = env.mock
  const p1 = m.addFolder('P1', 'root')
  const p2 = m.addFolder('P2', 'root')
  const x1 = m.addFile('X.mov', p1.id, { size: 10, seed: 21 })
  const x2 = m.addFile('X.mov', p2.id, { size: 20, seed: 22 })
  const a = m.addFile('A001.mov', 'root', { size: 30, seed: 23 })
  const b1 = m.addFolder('Brutos', p1.id)
  m.addFile('um.mov', b1.id, { size: 1, seed: 24 })
  const b2 = m.addFolder('Brutos', p2.id)
  m.addFile('dois.mov', b2.id, { size: 2, seed: 25 })
  const destDir = path.join(env.dir, 'Soltos')
  const get = id => env.drive.getItem(id)
  const plan = (items, extra = {}) => planDownloads({ drive: env.drive, accountId: env.accountId, items, destDir, ...extra })

  const three = await plan([await get(x1.id), await get(x2.id), await get(a.id)])
  assert.equal(three.batch.label, '3 arquivos')
  assert.deepEqual(three.records.map(r => r.relPath), ['X.mov', 'X (2).mov', 'A001.mov'])
  assert.equal(three.records[1].dest.path, path.join(destDir, 'X (2).mov'))

  const one = await plan([{ id: a.id }], { batchId: 'b_fixo' })
  assert.equal(one.batch.id, 'b_fixo')
  assert.equal(one.records[0].batchId, 'b_fixo')
  assert.equal(one.batch.label, '"A001.mov"')
  assert.equal(one.records[0].size, 30, 'item só com id é buscado no Drive')

  const myDrive = await plan([{ id: 'root' }])
  assert.equal(myDrive.batch.label, 'Pasta "Meu Drive"')
  assert.ok(myDrive.records.some(r => r.relPath === 'Meu Drive/A001.mov'), myDrive.records.map(r => r.relPath).join(', '))

  const same = await plan([await get(a.id), await get(a.id)])
  assert.equal(same.records.length, 1, 'o mesmo item duas vezes vira um registro só')

  const mixed = await plan([await get(b1.id), await get(b2.id), await get(x1.id)])
  assert.equal(mixed.batch.label, '2 pastas e 1 arquivo')
  const mr = byRel(mixed.records)
  assert.ok(mr['Brutos/um.mov'])
  assert.ok(mr['Brutos (2)/dois.mov'], `pastas com o mesmo nome não se misturam: ${Object.keys(mr)}`)
  assert.match(mr['Brutos (2)/dois.mov'].note, /Outro item com o nome "Brutos"/)
  assert.equal(mr['Brutos (2)/dois.mov'].dest.path, path.join(destDir, 'Brutos (2)', 'dois.mov'))

  // Pasta local que já existe com o mesmo nome: junta (retomar um download de pasta não cria "Brutos (2)").
  await fs.mkdir(path.join(destDir, 'Brutos'), { recursive: true })
  const again = await plan([await get(b1.id)])
  assert.deepEqual(again.records.map(r => r.relPath), ['Brutos/um.mov'])

  await assert.rejects(plan([]), err => err.status === 400)
  await assert.rejects(planDownloads({ drive: env.drive, accountId: env.accountId, items: [await get(a.id)] }), err => err.status === 400 && /destino/.test(err.message))
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(plan([await get(b1.id)], { signal: ac.signal }), err => isAbortError(err))
})

test('planUploads: pastas sobem como <destino>/<pasta>/..., arquivos soltos no destino, nomes repetidos no topo, lixo e links', async t => {
  const env = await setup(t)
  const m = env.mock
  const dest = m.addFolder('Entregas', 'root')
  const src = path.join(env.dir, 'origem')
  const src2 = path.join(env.dir, 'outra')
  await randomFile(path.join(src, 'Brutos', 'A001.mov'), 1000, 31)
  await randomFile(path.join(src, 'Brutos', 'Dia 02', 'B.mov'), 2000, 32)
  await fs.writeFile(path.join(src, 'Brutos', '.DS_Store'), 'lixo')
  await fs.symlink(path.join(src, 'Brutos', 'A001.mov'), path.join(src, 'Brutos', 'atalho.mov'))
  await randomFile(path.join(src, 'Solto.mov'), 500, 33)
  await randomFile(path.join(src2, 'Brutos', 'C.mov'), 300, 34)
  const before = env.mock.stats().requests['about.get'] || 0

  const plan = await planUploads({
    drive: env.drive, accountId: env.accountId, destFolderId: dest.id, driveId: null,
    paths: [path.join(src, 'Brutos'), path.join(src, 'Solto.mov'), path.join(src2, 'Brutos'), path.join(src, 'Brutos')],
  })
  const { batch, records, skipped, warnings, totals } = plan
  assert.equal(batch.type, 'upload')
  assert.equal(batch.label, '2 pastas e 1 arquivo')
  for (const r of records) assertFresh(r, { type: 'upload', accountId: env.accountId, batchId: batch.id })
  assert.deepEqual(records.map(r => r.relPath), ['Brutos/A001.mov', 'Brutos/Dia 02/B.mov', 'Solto.mov', 'Brutos (2)/C.mov'])
  const r = byRel(records)
  assert.deepEqual(r['Brutos/Dia 02/B.mov'].target, { rootId: dest.id, relDir: 'Brutos/Dia 02', parentId: null, driveId: null, replaceFileId: null, fileId: null })
  assert.equal(r['Brutos/Dia 02/B.mov'].name, 'B.mov')
  const st = await fs.stat(path.join(src, 'Brutos', 'Dia 02', 'B.mov'))
  assert.deepEqual(r['Brutos/Dia 02/B.mov'].local, { path: path.join(src, 'Brutos', 'Dia 02', 'B.mov'), size: 2000, mtimeMs: st.mtimeMs })
  assert.equal(r['Brutos/Dia 02/B.mov'].size, 2000)
  assert.equal(r['Solto.mov'].target.relDir, '')
  assert.equal(r['Brutos (2)/C.mov'].target.relDir, 'Brutos (2)')
  assert.match(r['Brutos (2)/C.mov'].note, /Outro item com o nome "Brutos"/)
  assert.deepEqual(skipped.map(s => s.name), ['Brutos/atalho.mov'])
  assert.match(skipped[0].reason, /Link simbólico/)
  assert.deepEqual(warnings, [])
  assert.deepEqual(totals, { count: 4, bytes: 3800 })
  assert.equal(env.mock.stats().requests['about.get'], before + 1, 'confere o espaço do Drive uma vez')

  // Os envios de verdade criam as pastas certas.
  const ctx = taskCtx(env)
  for (const rec of records) await new UploadTask(rec, ctx).run(new AbortController().signal)
  const tree = await env.drive.walk(dest.id)
  assert.deepEqual(tree.items.filter(i => !i.isFolder).map(i => i.relPath).sort(), ['Brutos (2)/C.mov', 'Brutos/A001.mov', 'Brutos/Dia 02/B.mov', 'Solto.mov'])

  // Drive sem espaço: aviso (não bloqueia). Drive compartilhado: a cota pessoal não vale, nem consulta.
  m.setOptions({ storageLimitBytes: 1 })
  const full = await planUploads({ drive: env.drive, accountId: env.accountId, destFolderId: dest.id, paths: [path.join(src, 'Solto.mov')] })
  assert.equal(full.records.length, 1)
  assert.equal(full.warnings.length, 1)
  assert.match(full.warnings[0], /livres/)
  const shared = m.addSharedDrive('Equipe')
  const calls = env.mock.stats().requests['about.get']
  const sd = await planUploads({ drive: env.drive, accountId: env.accountId, destFolderId: shared.id, driveId: shared.id, paths: [path.join(src, 'Solto.mov')] })
  assert.equal(sd.records[0].target.driveId, shared.id)
  assert.equal(sd.records[0].target.rootId, shared.id)
  assert.deepEqual(sd.warnings, [])
  const sdRoot = await planUploads({ drive: env.drive, accountId: env.accountId, destFolderId: 'root', driveId: shared.id, paths: [path.join(src, 'Solto.mov')] })
  assert.equal(sdRoot.records[0].target.rootId, shared.id, "'root' com driveId é a raiz do drive compartilhado")
  assert.equal(env.mock.stats().requests['about.get'], calls)
  m.setOptions({ storageLimitBytes: null })

  // Caminho que não existe: sozinho é erro claro; junto com outros, vai para skipped.
  await assert.rejects(planUploads({ drive: env.drive, accountId: env.accountId, paths: [path.join(env.dir, 'nada')] }), err => err.status === 404)
  const partial = await planUploads({ drive: env.drive, accountId: env.accountId, paths: [path.join(env.dir, 'nada'), path.join(src, 'Solto.mov')] })
  assert.equal(partial.records.length, 1)
  assert.equal(partial.records[0].target.rootId, 'root')
  assert.equal(partial.batch.label, '"Solto.mov"')
  assert.equal(partial.skipped.length, 1)
  assert.match(partial.skipped[0].reason, /Não encontrei/)
  await assert.rejects(planUploads({ drive: env.drive, accountId: env.accountId, paths: [] }), err => err.status === 400)
})

test('planUploads: arquivo maior que 5 TB vai para skipped (arquivo esparso)', async t => {
  const env = await setup(t)
  const big = path.join(env.dir, 'enorme.mov')
  const fh = await fs.open(big, 'w')
  try {
    await fh.truncate(MAX_UPLOAD_SIZE + 1)
  } catch (err) {
    t.skip(`o sistema de arquivos não aceita arquivo esparso desse tamanho (${err.code})`)
    return
  } finally {
    await fh.close()
  }
  await randomFile(path.join(env.dir, 'normal.mov'), 10, 41)
  const plan = await planUploads({ drive: env.drive, accountId: env.accountId, paths: [big, path.join(env.dir, 'normal.mov')] })
  assert.deepEqual(plan.records.map(r => r.name), ['normal.mov'])
  assert.equal(plan.skipped.length, 1)
  assert.match(plan.skipped[0].reason, /5 TB/)
  assert.equal(plan.totals.bytes, 10)
  await fs.rm(big, { force: true })
})

test('planUploadsFromCompare / planDownloadsFromCompare: o que falta, os diferentes, só no Drive, filtro por pasta e NFD', async t => {
  const env = await setup(t)
  const m = env.mock
  const proj = m.addFolder('Proj', 'root')
  const brutos = m.addFolder('Brutos', proj.id)
  m.addFile('A.mov', brutos.id, { size: 100, seed: 51 })
  const dia = m.addFolder('Dia 01', brutos.id)
  const bRemote = m.addFile('B.mov', dia.id, { size: 100, seed: 52 })
  const b2 = m.addFolder('Brutos 2', proj.id)
  const z = m.addFile('Z.mov', b2.id, { size: 70, seed: 53 })
  const d1 = m.addFile('Dup.mov', brutos.id, { size: 40, seed: 54 })
  const d2 = m.addFile('Dup.mov', brutos.id, { size: 41, seed: 55 })
  m.addFile('Trancado.mov', brutos.id, { size: 5, seed: 56, canDownload: false })

  const local = path.join(env.dir, 'Proj')
  await randomFile(path.join(local, 'Brutos', 'A.mov'), 100, 51)
  await randomFile(path.join(local, 'Brutos', 'Dia 01', 'B.mov'), 150, 57) // diferente
  await randomFile(path.join(local, 'Brutos', 'Dia 01', 'C.mov'), 60, 58)
  await randomFile(path.join(local, 'Brutos 2', 'Y.mov'), 80, 59)
  await randomFile(path.join(local, 'Raiz.mov'), 90, 60)
  const nfd = path.join(local, 'Brutos', 'Café novo.mov')
  await randomFile(nfd, 30, 61)

  const result = await compareFolders({ drive: env.drive, localPath: local, driveFolderId: proj.id, hasher: env.hasher, paths: env.paths })
  const acc = env.accountId

  const missing = planUploadsFromCompare(result, { accountId: acc })
  assert.equal(missing.batch.type, 'upload')
  assert.equal(missing.batch.label, 'Faltando em "Proj"')
  for (const r of missing.records) assertFresh(r, { type: 'upload', accountId: acc, batchId: missing.batch.id })
  const mr = byRel(missing.records)
  assert.deepEqual(Object.keys(mr).sort(), ['Brutos 2/Y.mov', 'Brutos/Café novo.mov'.normalize('NFC'), 'Brutos/Dia 01/C.mov', 'Raiz.mov'].sort())
  assert.deepEqual(mr['Brutos/Dia 01/C.mov'].target, { rootId: proj.id, relDir: 'Brutos/Dia 01', parentId: null, driveId: null, replaceFileId: null, fileId: null })
  assert.equal(mr['Raiz.mov'].target.relDir, '')
  assert.equal(mr['Brutos/Dia 01/C.mov'].local.path, path.join(local, 'Brutos', 'Dia 01', 'C.mov'))
  const cafe = mr['Brutos/Café novo.mov'.normalize('NFC')]
  assert.equal(cafe.local.path, nfd, 'abre o arquivo pelo nome do disco (NFD), não pelo NFC')
  assert.equal(cafe.name, 'Café novo.mov'.normalize('NFC'), 'no Drive o nome vai em NFC')
  await fs.access(cafe.local.path)
  assert.deepEqual(missing.totals, { count: 4, bytes: 60 + 80 + 90 + 30 })

  // Diferentes + filtro de pasta: 'Brutos' inclui 'Brutos/Dia 01', mas não 'Brutos 2'.
  const diff = planUploadsFromCompare(result, { accountId: acc, statuses: ['missing', 'different'], relDirs: ['Brutos'] })
  assert.equal(diff.batch.label, 'Faltando e diferentes em "Brutos"')
  const dr = byRel(diff.records)
  assert.deepEqual(Object.keys(dr).sort(), ['Brutos/Café novo.mov'.normalize('NFC'), 'Brutos/Dia 01/B.mov', 'Brutos/Dia 01/C.mov'].sort())
  assert.equal(dr['Brutos/Dia 01/B.mov'].target.replaceFileId, bRemote.id)
  assert.match(dr['Brutos/Dia 01/B.mov'].note, /Substitui/)
  assert.equal(dr['Brutos/Dia 01/C.mov'].target.replaceFileId, null)
  assert.equal(planUploadsFromCompare(result, { accountId: acc, statuses: ['different'] }).batch.label, 'Diferentes em "Proj"')
  assert.equal(planUploadsFromCompare(result, { accountId: acc, relDirs: [''] }).records.length, 4)
  assert.equal(planUploadsFromCompare(result, { accountId: acc, relDirs: ['Brutos/Dia 01'] }).records.length, 1)

  // Só no Drive → localPath/relPath, com "(2)" para nomes repetidos; bloqueados ficam de fora.
  const down = planDownloadsFromCompare(result, { accountId: acc })
  assert.equal(down.batch.type, 'download')
  assert.equal(down.batch.label, 'Só no Drive: "Proj"')
  for (const r of down.records) assertFresh(r, { type: 'download', accountId: acc, batchId: down.batch.id })
  const dd = byRel(down.records)
  assert.deepEqual(Object.keys(dd).sort(), ['Brutos 2/Z.mov', 'Brutos/Dup (2).mov', 'Brutos/Dup.mov'])
  assert.equal(dd['Brutos 2/Z.mov'].dest.path, path.join(local, 'Brutos 2', 'Z.mov'))
  assert.equal(dd['Brutos 2/Z.mov'].source.fileId, z.id)
  assert.equal(dd['Brutos 2/Z.mov'].size, 70)
  assert.equal(dd['Brutos 2/Z.mov'].source.mimeType, 'video/quicktime')
  assert.deepEqual([dd['Brutos/Dup.mov'].source.fileId, dd['Brutos/Dup (2).mov'].source.fileId].sort(), [d1.id, d2.id].sort())
  assert.match(dd['Brutos/Dup (2).mov'].note, /mais de um "Dup\.mov"/)
  assert.deepEqual(down.skipped.map(s => s.name), ['Brutos/Trancado.mov'])
  assert.deepEqual(down.totals, { count: 3, bytes: 70 + 40 + 41 })
  const onlyBrutos = planDownloadsFromCompare(result, { accountId: acc, relDirs: ['Brutos'] })
  assert.equal(onlyBrutos.batch.label, 'Só no Drive: "Brutos"')
  assert.deepEqual(onlyBrutos.records.map(r => r.relPath).sort(), ['Brutos/Dup (2).mov', 'Brutos/Dup.mov'])

  // As tarefas de verdade: substitui o diferente (mesmo id, novo conteúdo) e baixa o que só estava no Drive.
  const ctx = taskCtx(env)
  const recB = dr['Brutos/Dia 01/B.mov']
  await new UploadTask(recB, ctx).run(new AbortController().signal)
  assert.equal(recB.target.fileId, bRemote.id)
  assert.equal(m.getItem(bRemote.id).size, 150)
  const recC = dr['Brutos/Dia 01/C.mov']
  await new UploadTask(recC, ctx).run(new AbortController().signal)
  assert.equal(m.getItem(recC.target.fileId).parents[0], dia.id, 'o que falta vai para a pasta correspondente no Drive')
  const recZ = dd['Brutos 2/Z.mov']
  await new DownloadTask(recZ, ctx, { retryBaseMs: 5 }).run(new AbortController().signal)
  assert.equal(await md5File(path.join(local, 'Brutos 2', 'Z.mov')), await m.contentMd5(z.id))

  // Depois de tudo, a nova comparação só acha o que ainda falta.
  const after2 = await compareFolders({ drive: env.drive, localPath: local, driveFolderId: proj.id, hasher: env.hasher, paths: env.paths })
  assert.equal(after2.files.find(f => f.relPath === 'Brutos/Dia 01/B.mov').status, 'synced')
  assert.equal(after2.files.find(f => f.relPath === 'Brutos 2/Z.mov').status, 'synced')
})

test('baixar pasta e "Comparar e baixar" deixam de fora os ._ do Mac (AppleDouble); escolhido à mão, vem', async t => {
  const env = await setup(t)
  const m = env.mock
  const dia = m.addFolder('Diária 02', 'root')
  const braw = m.addFile('A003_C001_1014XQ.braw', dia.id, { size: 300, seed: 71, mimeType: 'application/octet-stream' })
  const meta = m.addFile('._A003_C001_1014XQ.braw', dia.id, { size: 40, seed: 72, mimeType: 'application/octet-stream' })
  m.addFile('._A003_C002_1014XQ.braw', dia.id, { size: 41, seed: 73 })
  m.addFile('Thumbs.db', dia.id, { size: 9, seed: 74 })
  const cam = m.addFolder('CAM_B', dia.id)
  const mov = m.addFile('B001_C001.mov', cam.id, { size: 120, seed: 75 })
  m.addFile('._B001_C001.mov', cam.id, { size: 42, seed: 76 })
  m.addFile('.DS_Store', cam.id, { size: 8, seed: 77 })

  const destDir = path.join(env.dir, 'Baixados')
  const plan = await planDownloads({ drive: env.drive, accountId: env.accountId, items: [await env.drive.getItem(dia.id)], destDir, conflict: 'skip' })
  assert.deepEqual(plan.records.map(r => r.relPath).sort(), ['Diária 02/A003_C001_1014XQ.braw', 'Diária 02/CAM_B/B001_C001.mov'])
  assert.deepEqual(plan.skipped, [], 'em silêncio: não vira aviso de "pulado"')
  assert.equal(plan.totals.bytes, 300 + 120)
  assert.deepEqual(plan.records.map(r => r.source.fileId).sort(), [braw.id, mov.id].sort())

  // Escolhido à mão (a pessoa clicou nele): vem.
  const mao = await planDownloads({ drive: env.drive, accountId: env.accountId, items: [await env.drive.getItem(meta.id)], destDir: path.join(env.dir, 'Mao'), conflict: 'skip' })
  assert.deepEqual(mao.records.map(r => r.name), ['._A003_C001_1014XQ.braw'])

  // Comparar com uma pasta local vazia e baixar o que falta: os ._ não entram.
  const local = path.join(env.dir, 'Diária 02')
  await fs.mkdir(local, { recursive: true })
  const result = await compareFolders({ drive: env.drive, localPath: local, driveFolderId: dia.id, hasher: env.hasher, paths: env.paths })
  const down = planDownloadsFromCompare(result, { accountId: env.accountId })
  assert.deepEqual(down.records.map(r => r.relPath).sort(), ['A003_C001_1014XQ.braw', 'CAM_B/B001_C001.mov'])
})

test('planUploadsFromCompare: drive compartilhado (driveId passa adiante) e pasta que só muda maiúscula no Drive', async t => {
  const env = await setup(t)
  const m = env.mock
  const shared = m.addSharedDrive('Equipe')
  const proj = m.addFolder('Proj', shared.id)
  const caixa = m.addFolder('BRUTOS', proj.id)
  m.addFile('velho.mov', caixa.id, { size: 10, seed: 71 })
  const local = path.join(env.dir, 'Proj')
  await randomFile(path.join(local, 'brutos', 'novo.mov'), 20, 72)
  const result = await compareFolders({ drive: env.drive, localPath: local, driveFolderId: proj.id, hasher: env.hasher, paths: env.paths })
  assert.equal(result.drive.driveId, shared.id)
  assert.equal(result.drive.path, 'Equipe/Proj')
  const plan = planUploadsFromCompare(result, { accountId: env.accountId })
  assert.equal(plan.records.length, 1)
  const rec = plan.records[0]
  assert.deepEqual(rec.target, { rootId: proj.id, relDir: 'BRUTOS', parentId: null, driveId: shared.id, replaceFileId: null, fileId: null })
  assert.match(rec.note, /BRUTOS/)
  await new UploadTask(rec, taskCtx(env)).run(new AbortController().signal)
  assert.equal(m.getItem(rec.target.fileId).parents[0], caixa.id, 'não criou uma pasta "brutos" ao lado de "BRUTOS"')
  assert.throws(() => planUploadsFromCompare({}, { accountId: env.accountId }), err => err.status === 400)
  assert.throws(() => planDownloadsFromCompare(null, { accountId: env.accountId }), err => err.status === 400)
})

test('planDownloads: item apagado do Drive depois de listado vai para skipped; se todos sumiram, erro 404 claro', async t => {
  const env = await setup(t)
  const m = env.mock
  const keep = m.addFile('Fica.mov', 'root', { size: 10, seed: 81 })
  const lost = m.addFile('Some.mov', 'root', { size: 10, seed: 82 })
  const lostFolder = m.addFolder('Sumiu', 'root')
  const items = [await env.drive.getItem(keep.id), await env.drive.getItem(lost.id), await env.drive.getItem(lostFolder.id)]
  m.deleteItem(lost.id)
  m.deleteItem(lostFolder.id)
  const destDir = path.join(env.dir, 'D')
  // Item da UI incompleto obriga a buscar de novo (aí o 404 aparece no getItem); pasta aparece no walk.
  const plan = await planDownloads({ drive: env.drive, accountId: env.accountId, items: [items[0], { id: lost.id, name: 'Some.mov' }, items[2]], destDir })
  assert.deepEqual(plan.records.map(r => r.name), ['Fica.mov'])
  assert.equal(plan.batch.label, '"Fica.mov"')
  assert.deepEqual(plan.skipped.map(s => s.name).sort(), ['Some.mov', 'Sumiu'])
  assert.ok(plan.skipped.every(s => /Não achei no Drive/.test(s.reason)))
  await assert.rejects(
    planDownloads({ drive: env.drive, accountId: env.accountId, items: [items[2]], destDir }),
    err => err.status === 404 && /Não achei este item no Drive/.test(err.message),
  )
})

test('planDownloadsFromCompare usa as pastas de verdade do disco (NFD) e planUploadsFromCompare substitui no lugar certo quando só muda maiúscula', async t => {
  const env = await setup(t)
  const m = env.mock
  const proj = m.addFolder('Proj', 'root')
  const cafe = m.addFolder('Café', proj.id)
  const z = m.addFile('z.mov', cafe.id, { size: 12, seed: 91 })
  const sub = m.addFolder('Sub', cafe.id)
  m.addFile('y.mov', sub.id, { size: 13, seed: 92 })
  const caixa = m.addFolder('Brutos', proj.id)
  const b = m.addFile('B.mov', caixa.id, { size: 14, seed: 93 })

  const local = path.join(env.dir, 'Proj')
  const nfdDir = path.join(local, 'Cafe\u0301')
  await randomFile(path.join(nfdDir, 'Sub', 'y.mov'), 13, 92) // só arquivos na subpasta: a pasta NFD precisa ser achada subindo
  await randomFile(path.join(local, 'brutos', 'B.mov'), 15, 94) // diferente, e a pasta só muda maiúscula

  const result = await compareFolders({ drive: env.drive, localPath: local, driveFolderId: proj.id, hasher: env.hasher, paths: env.paths })
  const down = planDownloadsFromCompare(result, { accountId: env.accountId })
  assert.deepEqual(down.records.map(r => r.source.fileId), [z.id])
  assert.equal(down.records[0].dest.path, path.join(nfdDir, 'z.mov'), 'baixa dentro da pasta que já existe (gravada em NFD)')

  const up = planUploadsFromCompare(result, { accountId: env.accountId, statuses: ['different'] })
  assert.equal(up.records.length, 1)
  assert.equal(up.records[0].target.replaceFileId, b.id)
  assert.equal(up.records[0].target.relDir, 'Brutos', 'pasta do arquivo no Drive, não a grafia local')
  await new UploadTask(up.records[0], taskCtx(env)).run(new AbortController().signal)
  assert.equal(m.getItem(b.id).size, 15)
  const folders = m.listAll().filter(i => i.isFolder && i.parents[0] === proj.id).map(i => i.name).sort()
  assert.deepEqual(folders, ['Brutos', 'Café'], 'nenhuma pasta "brutos" vazia criada no Drive')
})

test('pastas do Drive que só mudam maiúscula ("Cena 1" e "cena 1") nunca levam dois downloads ao mesmo arquivo', async t => {
  const env = await setup(t)
  const m = env.mock
  const top = m.addFolder('Filme', 'root')
  const a = m.addFolder('Cena 1', top.id)
  const b = m.addFolder('cena 1', top.id)
  m.addFile('take.mov', a.id, { size: 10, seed: 101 })
  m.addFile('take.mov', b.id, { size: 11, seed: 102 })
  const destDir = path.join(env.dir, 'D')
  const plan = await planDownloads({ drive: env.drive, accountId: env.accountId, items: [await env.drive.getItem(top.id)], destDir })
  assert.equal(plan.records.length, 2)
  const keys = plan.records.map(r => r.dest.path.toLowerCase())
  assert.equal(new Set(keys).size, 2, `destinos iguais sem diferenciar maiúsculas: ${keys}`)

  // Mesmo caso vindo do comparador (pasta local vazia: as duas só no Drive).
  const local = path.join(env.dir, 'Filme')
  await fs.mkdir(local)
  const result = await compareFolders({ drive: env.drive, localPath: local, driveFolderId: top.id, hasher: env.hasher, paths: env.paths })
  const down = planDownloadsFromCompare(result, { accountId: env.accountId })
  assert.equal(down.records.length, 2)
  assert.equal(new Set(down.records.map(r => r.dest.path.toLowerCase())).size, 2)
})
