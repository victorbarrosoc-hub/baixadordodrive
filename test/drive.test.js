// DriveClient contra o Drive falso: listagem, drives compartilhados, atalhos, árvore, pastas, caminhos e limites.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupDrive } from './helpers.js'
import {
  DriveClient,
  MetadataLimiter,
  FILE_FIELDS,
  GOOGLE_EXPORTS,
  toDriveItem,
  resourceKeyHeader,
  escapeQueryValue,
} from '../src/google/drive.js'
import { closeHttp, HttpError } from '../src/net/http.js'
import { classifyError } from '../src/google/errors.js'

const FOLDER = 'application/vnd.google-apps.folder'
const SHORTCUT = 'application/vnd.google-apps.shortcut'

after(() => closeHttp())

async function setup(t, mockOptions = {}) {
  const ctx = await setupDrive(mockOptions)
  t.after(ctx.cleanup)
  return ctx
}

/** Registra as chamadas que passam por drive.api (para conferir parâmetros enviados). */
function spyApi(drive) {
  const calls = []
  const original = drive.api.bind(drive)
  drive.api = (method, pathOrUrl, opts = {}) => {
    calls.push({ method, path: pathOrUrl, query: { ...(opts.query || {}) }, headers: { ...(opts.headers || {}) } })
    return original(method, pathOrUrl, opts)
  }
  return calls
}

test('toDriveItem, resourceKeyHeader, FILE_FIELDS e GOOGLE_EXPORTS', () => {
  const file = toDriveItem({
    id: 'f1', name: 'A001.mov', mimeType: 'video/quicktime', size: '214748364800', md5Checksum: 'abc',
    modifiedTime: '2026-01-02T03:04:05.000Z', headRevisionId: 'rev', resourceKey: '0-key', parents: ['p1'], driveId: 'd1',
    capabilities: { canDownload: false },
  })
  assert.deepEqual(file, {
    id: 'f1', name: 'A001.mov', mimeType: 'video/quicktime', size: 214748364800, md5: 'abc',
    modifiedTime: '2026-01-02T03:04:05.000Z', headRevisionId: 'rev', resourceKey: '0-key', canDownload: false,
    parents: ['p1'], driveId: 'd1', isFolder: false, isGoogleDoc: false, isShortcut: false,
    shortcutTargetId: null, shortcutTargetMimeType: null, shortcutTargetResourceKey: null,
  })
  const minimal = toDriveItem({ id: 'f2', name: 'x', mimeType: 'application/octet-stream' })
  assert.equal(minimal.size, null)
  assert.equal(minimal.md5, null)
  assert.equal(minimal.canDownload, true, 'canDownload padrão é true')
  assert.deepEqual(minimal.parents, [])
  assert.equal(minimal.driveId, null)
  assert.equal(toDriveItem({ id: 'e', name: 'vazio', mimeType: 'text/plain', size: '0' }).size, 0)

  const folder = toDriveItem({ id: 'd', name: 'Pasta', mimeType: FOLDER })
  assert.equal(folder.isFolder, true)
  assert.equal(folder.size, null)
  const doc = toDriveItem({ id: 'g', name: 'Roteiro', mimeType: 'application/vnd.google-apps.document', size: '1024' })
  assert.equal(doc.isGoogleDoc, true)
  assert.equal(doc.size, null, 'tamanho de Doc nativo não é o do arquivo exportado')
  const sc = toDriveItem({ id: 's', name: 'atalho', mimeType: SHORTCUT, shortcutDetails: { targetId: 't', targetMimeType: 'video/mp4', targetResourceKey: '0-rk' } })
  assert.equal(sc.isShortcut, true)
  assert.equal(sc.isGoogleDoc, false)
  assert.equal(sc.shortcutTargetId, 't')
  assert.equal(sc.shortcutTargetMimeType, 'video/mp4')
  assert.equal(sc.shortcutTargetResourceKey, '0-rk')

  assert.deepEqual(resourceKeyHeader(file), { 'x-goog-drive-resource-keys': 'f1/0-key' })
  assert.deepEqual(resourceKeyHeader(minimal), {})
  assert.deepEqual(resourceKeyHeader(null), {})

  assert.match(FILE_FIELDS, /md5Checksum/)
  assert.match(FILE_FIELDS, /shortcutDetails\(targetId,targetMimeType,targetResourceKey\)/)
  assert.match(FILE_FIELDS, /capabilities\(canDownload\)/)
  assert.equal(GOOGLE_EXPORTS['application/vnd.google-apps.document'].ext, '.docx')
  assert.equal(GOOGLE_EXPORTS['application/vnd.google-apps.spreadsheet'].ext, '.xlsx')
  assert.equal(GOOGLE_EXPORTS['application/vnd.google-apps.presentation'].ext, '.pptx')
  assert.deepEqual({ ...GOOGLE_EXPORTS['application/vnd.google-apps.drawing'] }, { mime: 'image/png', ext: '.png' })
  assert.equal(GOOGLE_EXPORTS['application/vnd.google-apps.form'], undefined)

  assert.equal(escapeQueryValue("O'Brien \\ 1"), "O\\'Brien \\\\ 1")
})

test('URLs de mídia, exportação e upload; about; getItem com resourceKey', async t => {
  const { mock, drive, accountId } = await setup(t, { storageLimitBytes: 15e9 })
  const api = mock.env.SOBEDESCE_DRIVE_API
  const up = mock.env.SOBEDESCE_DRIVE_UPLOAD
  const media = new URL(drive.mediaUrl('abc/1'))
  assert.equal(media.origin + media.pathname, `${api}/files/abc%2F1`)
  assert.equal(media.searchParams.get('alt'), 'media')
  assert.equal(media.searchParams.get('supportsAllDrives'), 'true')
  assert.equal(media.searchParams.get('acknowledgeAbuse'), 'false')
  const exp = new URL(drive.exportUrl('doc1', 'application/pdf'))
  assert.equal(exp.pathname.endsWith('/files/doc1/export'), true)
  assert.equal(exp.searchParams.get('mimeType'), 'application/pdf')
  const init = new URL(drive.uploadInitUrl())
  assert.equal(init.origin + init.pathname, `${up}/files`)
  assert.equal(init.searchParams.get('uploadType'), 'resumable')
  assert.equal(init.searchParams.get('supportsAllDrives'), 'true')
  assert.equal(init.searchParams.get('fields'), FILE_FIELDS)
  const upd = new URL(drive.uploadUpdateUrl('f9'))
  assert.equal(upd.origin + upd.pathname, `${up}/files/f9`)
  assert.equal(upd.searchParams.get('uploadType'), 'resumable')

  const header = await drive.authHeader()
  assert.match(header.authorization, /^Bearer ya29\.mock-/)

  const about = await drive.about()
  assert.equal(about.user.permissionId, accountId)
  assert.equal(about.user.email, mock.user.emailAddress)
  assert.equal(about.user.photoUrl, mock.user.photoLink)
  assert.equal(about.quota.limit, 15e9)
  assert.equal(typeof about.quota.usage, 'number')

  const added = mock.addFile('legado.mov', 'root', { size: 1234, resourceKey: true })
  await assert.rejects(drive.getItem(added.id), err => classifyError(err).kind === 'notfound')
  const item = await drive.getItem(added.id, { resourceKey: added.resourceKey })
  assert.equal(item.size, 1234)
  assert.equal(item.resourceKey, added.resourceKey)
  assert.deepEqual(resourceKeyHeader(item), { 'x-goog-drive-resource-keys': `${added.id}/${added.resourceKey}` })
  assert.equal(item.md5, await mock.contentMd5(added.id))

  const blocked = mock.addFile('bloqueado.mov', 'root', { size: 10, canDownload: false })
  assert.equal((await drive.getItem(blocked.id)).canDownload, false)
  await assert.rejects(drive.getItem('nao-existe'), err => classifyError(err).kind === 'notfound')
})

test('listChildren pagina tudo (> 1000 itens, páginas curtas), ignora lixeira e ordena pastas primeiro', async t => {
  const { mock, drive } = await setup(t, { seed: 3, failures: { shortPageProb: 0.7 } })
  const big = mock.addFolder('Brutos')
  const n = 2345
  for (let i = 0; i < n; i++) mock.addFile(`C${String(i).padStart(4, '0')}.mxf`, big.id, { size: i })
  mock.addFolder('zeta', big.id)
  mock.addFolder('Alfa', big.id)
  mock.addFile('apagado.mov', big.id, { size: 5, trashed: true })
  mock.addFolder('pasta na lixeira', big.id, { trashed: true })
  mock.resetStats()

  const items = await drive.listChildren(big.id)
  assert.equal(items.length, n + 2)
  assert.deepEqual(items.slice(0, 2).map(i => i.name), ['Alfa', 'zeta'])
  assert.equal(items[2].name, 'C0000.mxf')
  assert.equal(items.at(-1).name, `C${n - 1}.mxf`)
  assert.equal(new Set(items.map(i => i.id)).size, items.length, 'sem repetidos entre páginas')
  assert.ok(!items.some(i => i.name === 'apagado.mov' || i.name === 'pasta na lixeira'))
  const sample = items.find(i => i.name === 'C0100.mxf')
  assert.equal(sample.size, 100)
  assert.match(sample.md5, /^[0-9a-f]{32}$/)
  assert.deepEqual(sample.parents, [big.id])
  const s = mock.stats()
  assert.ok(s.requests['files.list'] >= 3, `páginas: ${s.requests['files.list']}`)
  assert.ok(s.faults.shortPages > 0, 'o teste precisa ter pego páginas curtas')

  // Raiz do Meu Drive pelo apelido 'root'.
  const rootItems = await drive.listChildren('root')
  assert.deepEqual(rootItems.map(i => i.name), ['Brutos'])
})

test('drives compartilhados: lista, navega com corpora=drive e lê itens com supportsAllDrives', async t => {
  const { mock, drive } = await setup(t)
  const team = mock.addSharedDrive('Equipe Montagem')
  mock.addSharedDrive('Arquivo Morto')
  const proj = mock.addFolder('Projeto X', team.id)
  const clip = mock.addFile('A001.mov', proj.id, { size: 4096 })
  mock.addFile('solto.wav', team.id, { size: 10 })
  mock.addFile('meu.mov', 'root', { size: 1 })

  const drives = await drive.listSharedDrives()
  assert.deepEqual(drives.map(d => d.name).sort(), ['Arquivo Morto', 'Equipe Montagem'])
  assert.ok(drives.every(d => d.id && Object.keys(d).length === 2))

  const calls = spyApi(drive)
  const top = await drive.listChildren(team.id)
  assert.deepEqual(top.map(i => i.name), ['Projeto X', 'solto.wav'])
  assert.ok(top.every(i => i.driveId === team.id))
  const listCall = calls.find(c => c.path === 'files')
  assert.equal(listCall.query.corpora, 'drive')
  assert.equal(listCall.query.driveId, team.id)
  assert.equal(listCall.query.includeItemsFromAllDrives, 'true')
  assert.equal(listCall.query.supportsAllDrives, 'true')
  assert.equal(listCall.query.pageSize, 1000)
  assert.match(listCall.query.fields, /^nextPageToken,files\(/)
  assert.match(listCall.query.q, /trashed = false/)

  // Subpasta (driveId descoberto pelo próprio item) também lista dentro do drive.
  const fresh = new DriveClient(drive.auth, drive.accountId)
  const freshCalls = spyApi(fresh)
  const inside = await fresh.listChildren(proj.id)
  assert.deepEqual(inside.map(i => i.name), ['A001.mov'])
  assert.equal(freshCalls.find(c => c.path === 'files').query.driveId, team.id)

  const item = await drive.getItem(clip.id)
  assert.equal(item.driveId, team.id)
  assert.equal(item.size, 4096)

  const walked = await drive.walk(team.id)
  assert.deepEqual(walked.items.map(i => i.relPath), ['Projeto X', 'Projeto X/A001.mov', 'solto.wav'])

  assert.deepEqual(await drive.getPath(proj.id), [{ id: team.id, name: 'Equipe Montagem' }, { id: proj.id, name: 'Projeto X' }])
  assert.deepEqual(await fresh.getPath(team.id), [{ id: team.id, name: 'Equipe Montagem' }])

  const created = await drive.createFolder('Entregas', team.id)
  assert.equal(created.driveId, team.id)
  assert.equal((await drive.findChild(team.id, 'Entregas', { folder: true })).id, created.id)
  assert.equal(await drive.ensureFolderPath(team.id, 'Entregas/V1'), (await drive.findChild(created.id, 'V1')).id)
})

test('walk: atalhos para arquivo resolvidos (com resourceKey), pendurados = null, para pasta não seguidos', async t => {
  const { mock, drive } = await setup(t)
  const src = mock.addFolder('Fontes')
  const target = mock.addFile('original.mov', src.id, { size: 777 })
  const keyed = mock.addFile('antigo.mov', src.id, { size: 55, resourceKey: true })
  const doomed = mock.addFile('vai-sumir.mov', src.id, { size: 1 })
  const loopTarget = mock.addFolder('Outra pasta', src.id)
  mock.addFile('dentro.mov', loopTarget.id, { size: 3 })

  const root = mock.addFolder('Montagem')
  mock.addShortcut('atalho original', root.id, target.id)
  mock.addShortcut('atalho antigo', root.id, keyed.id)
  mock.addShortcut('atalho quebrado', root.id, doomed.id)
  mock.addShortcut('atalho pasta', root.id, loopTarget.id)
  mock.addShortcut('atalho para mim mesma', root.id, root.id) // ciclo: não pode travar
  mock.deleteItem(doomed.id)

  const { root: r, items } = await drive.walk(root.id)
  assert.equal(r.id, root.id)
  const by = Object.fromEntries(items.map(i => [i.name, i]))
  assert.equal(items.length, 5)
  assert.equal(by['atalho original'].isShortcut, true)
  assert.equal(by['atalho original'].target.id, target.id)
  assert.equal(by['atalho original'].target.size, 777)
  assert.equal(by['atalho original'].target.md5, await mock.contentMd5(target.id))
  assert.equal(by['atalho antigo'].target.id, keyed.id)
  assert.equal(by['atalho antigo'].target.resourceKey, keyed.resourceKey)
  assert.equal(by['atalho quebrado'].target, null)
  assert.equal('target' in by['atalho pasta'], false)
  assert.equal('target' in by['atalho para mim mesma'], false)
  assert.ok(!items.some(i => i.name === 'dentro.mov'), 'atalho de pasta não é seguido')

  // Atalho de pasta escolhido como raiz: segue o alvo.
  const viaShortcut = await drive.walk(by['atalho pasta'].id)
  assert.equal(viaShortcut.root.id, loopTarget.id)
  assert.deepEqual(viaShortcut.items.map(i => i.relPath), ['dentro.mov'])

  // Arquivo como raiz: nada para varrer.
  const single = await drive.walk(target.id)
  assert.equal(single.root.id, target.id)
  assert.deepEqual(single.items, [])
})

test('walk: árvore de 3 níveis com 2 mil arquivos, relPath/relDir em NFC, progresso e cancelamento', async t => {
  const { mock, drive } = await setup(t)
  const root = mock.addFolder('Filme')
  let files = 0
  let bytes = 0
  const expected = new Set()
  for (let a = 0; a < 5; a++) {
    const l1 = mock.addFolder(`Dia ${a}`, root.id)
    expected.add(`Dia ${a}`)
    for (let b = 0; b < 5; b++) {
      const l2 = mock.addFolder(`Cam ${b}`, l1.id)
      expected.add(`Dia ${a}/Cam ${b}`)
      for (let c = 0; c < 80; c++) {
        const size = 1000 + c
        mock.addFile(`C${c}.mov`, l2.id, { size })
        expected.add(`Dia ${a}/Cam ${b}/C${c}.mov`)
        files++
        bytes += size
      }
    }
  }
  // Nome em NFD (como o macOS grava) e nome com '/' (o Drive permite).
  const nfd = 'Café'
  const special = mock.addFolder(nfd, root.id)
  mock.addFile('Ação.wav'.normalize('NFD'), special.id, { size: 7 })
  mock.addFile('a/b.mov', root.id, { size: 9 })
  mock.addFile('lixo.mov', root.id, { size: 1, trashed: true })
  files += 2
  bytes += 16
  expected.add('Café')
  expected.add('Café/Ação')
  expected.add('Café/Ação.wav')
  expected.delete('Café/Ação')
  expected.add('a_b.mov')

  const progress = []
  mock.resetStats()
  const { items } = await drive.walk(root.id, { concurrency: 6, onProgress: p => progress.push(p) })
  assert.equal(items.length, expected.size)
  assert.deepEqual(new Set(items.map(i => i.relPath)), expected)
  for (const it of items) {
    assert.equal(it.relPath, it.relPath.normalize('NFC'))
    assert.equal(it.relDir, it.relPath.includes('/') ? it.relPath.slice(0, it.relPath.lastIndexOf('/')) : '')
  }
  const deep = items.find(i => i.relPath === 'Dia 3/Cam 4/C79.mov')
  assert.equal(deep.relDir, 'Dia 3/Cam 4')
  assert.equal(deep.size, 1079)
  assert.equal(items.filter(i => i.isFolder).length, 31)
  assert.deepEqual(items.map(i => i.relPath), [...items.map(i => i.relPath)].sort(), 'ordem estável por caminho')

  assert.ok(progress.length >= 1)
  const last = progress.at(-1)
  assert.deepEqual(last, { folders: 31, files, bytes })
  assert.equal(mock.stats().requests['files.list'], 32)

  // Cancelar no meio: rejeita com AbortError e não deixa nada pendurado.
  mock.setOptions({ latencyMs: 30 })
  const ac = new AbortController()
  const pending = drive.walk(root.id, { signal: ac.signal, onProgress: () => ac.abort() })
  await assert.rejects(pending, err => classifyError(err).kind === 'abort')
  await assert.rejects(drive.walk(root.id, { signal: AbortSignal.abort() }), err => classifyError(err).kind === 'abort')
})

test('ensureFolderPath: 50 uploads simultâneos na mesma pasta nova criam cada nível uma vez só', async t => {
  const { mock, drive } = await setup(t, { latencyMs: 15 })
  const dest = mock.addFolder('Destino')
  mock.addFolder('A', dest.id) // nível que já existe é reaproveitado
  mock.resetStats()
  const cache = new Map()
  const ids = await Promise.all(Array.from({ length: 50 }, () => drive.ensureFolderPath(dest.id, 'A/B/C', { cache })))
  assert.equal(new Set(ids).size, 1)
  const all = mock.listAll()
  const named = name => all.filter(i => i.name === name && i.isFolder)
  assert.equal(named('A').length, 1)
  assert.equal(named('B').length, 1)
  assert.equal(named('C').length, 1)
  assert.equal(mock.stats().requests['files.create'], 2)
  assert.equal(mock.getItem(ids[0]).parents[0], named('B')[0].id)
  assert.equal(named('B')[0].parents[0], named('A')[0].id)

  // Outro cache (ou app reaberto): acha o que existe em vez de duplicar.
  const other = await drive.ensureFolderPath(dest.id, 'A/B/C', { cache: new Map() })
  assert.equal(other, ids[0])
  assert.equal(await drive.ensureFolderPath(dest.id, ''), dest.id)
  // Sem `cache`, usa o do próprio cliente.
  const novo = await drive.ensureFolderPath('root', 'Novo/Sub')
  assert.equal(mock.getItem(novo).name, 'Sub')
  assert.equal(await drive.folderCache.get('root/Novo/Sub'), novo)
  assert.equal(mock.listAll().filter(i => i.name === 'C').length, 1)

  // Nomes em NFD viram NFC (o mesmo nível de quem mandou em NFC).
  const nfdId = await drive.ensureFolderPath(dest.id, 'Café/Ok', { cache })
  const nfcId = await drive.ensureFolderPath(dest.id, 'Café/Ok', { cache })
  assert.equal(nfdId, nfcId)

  // Quem pausa (abort) não derruba os outros que esperam a mesma pasta.
  const ac = new AbortController()
  const shared = new Map()
  const quitter = drive.ensureFolderPath(dest.id, 'X/Y', { cache: shared, signal: ac.signal })
  const stayers = Array.from({ length: 5 }, () => drive.ensureFolderPath(dest.id, 'X/Y', { cache: shared }))
  ac.abort()
  await assert.rejects(quitter, err => classifyError(err).kind === 'abort')
  const yIds = await Promise.all(stayers)
  assert.equal(new Set(yIds).size, 1)
  assert.equal(mock.listAll().filter(i => i.name === 'Y').length, 1)

  // Todos que esperavam pausaram: a criação compartilhada é cancelada e sai do cache.
  const gone = new Map()
  const acs = [new AbortController(), new AbortController()]
  const waiting = acs.map(c => drive.ensureFolderPath(dest.id, 'Z/W', { cache: gone, signal: c.signal }))
  assert.equal(gone.size, 1)
  for (const c of acs) c.abort()
  for (const w of waiting) await assert.rejects(w, err => classifyError(err).kind === 'abort')
  assert.equal(gone.size, 0)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(mock.listAll().filter(i => i.name === 'Z').length, 0, 'nada foi criado depois da pausa')
  const w = await drive.ensureFolderPath(dest.id, 'Z/W', { cache: gone })
  assert.equal(mock.getItem(w).name, 'W')
  assert.equal(mock.listAll().filter(i => i.name === 'Z').length, 1)
})

test('ensureFolderPath: com erros do Google cada nível sai uma vez só; "criar" que chegou mas falhou não duplica', async t => {
  const { mock, drive: base } = await setup(t)
  // Taxa alta: o assunto aqui é a repetição, não o limitador (que tem teste próprio).
  const drive = new DriveClient(base.auth, base.accountId, { retryBaseMs: 5, ratePerSec: 1000 })
  const dest = mock.addFolder('Destino')
  mock.setOptions({ failures: { error5xxProb: 0.35 }, seed: 7 })
  const cache = new Map()
  const ids = await Promise.all(Array.from({ length: 12 }, (_, i) => drive.ensureFolderPath(dest.id, `P${i % 3}/Q`, { cache })))
  mock.setOptions({ failures: {} })
  assert.ok(mock.stats().faults.error5xx > 0)
  for (const name of ['P0', 'P1', 'P2']) assert.equal(mock.listAll().filter(i => i.name === name).length, 1, name)
  assert.equal(mock.listAll().filter(i => i.name === 'Q').length, 3)
  assert.equal(new Set(ids).size, 3)
  for (const id of ids) assert.equal(mock.getItem(id).name, 'Q')

  // O Google criou a pasta mas a resposta se perdeu (503): a nova tentativa acha a pasta em vez de criar outra.
  const original = drive.api.bind(drive)
  let lost = 0
  drive.api = async (method, pathOrUrl, opts) => {
    const res = await original(method, pathOrUrl, opts)
    if (method === 'POST' && pathOrUrl === 'files' && lost++ === 0) {
      throw new HttpError(503, { body: { error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } }, method, url: 'files' })
    }
    return res
  }
  const id = await drive.ensureFolderPath(dest.id, 'Entrega', { cache: new Map() })
  assert.equal(lost, 1)
  const entregas = mock.listAll().filter(i => i.name === 'Entrega')
  assert.equal(entregas.length, 1)
  assert.equal(entregas[0].id, id)

  // Tentativas esgotadas: o erro sobe e a promessa ruim sai do cache (a próxima chamada tenta de novo).
  drive.api = original
  mock.setOptions({ failures: { error5xxProb: 1 } })
  const failing = new DriveClient(base.auth, base.accountId, { retryBaseMs: 1, ratePerSec: 1000 })
  const failCache = new Map()
  await assert.rejects(failing.ensureFolderPath(dest.id, 'Nunca', { cache: failCache }), err => classifyError(err).kind === 'retry')
  assert.equal(failCache.size, 0)
  mock.setOptions({ failures: {} })
  const ok = await failing.ensureFolderPath(dest.id, 'Nunca', { cache: failCache })
  assert.equal(mock.getItem(ok).name, 'Nunca')
})

test('findChild: escapa aspas e barras, confere o nome exato e filtra pasta/arquivo', async t => {
  const { mock, drive } = await setup(t)
  const dir = mock.addFolder('Pasta')
  const tricky = "O'Brien \\ take 1 (final).mov"
  const f = mock.addFile(tricky, dir.id, { size: 3 })
  const upper = mock.addFile('Foto.MOV', dir.id, { size: 1 })
  const lower = mock.addFile('foto.mov', dir.id, { size: 2 })
  const sameFolder = mock.addFolder('Brutos', dir.id)
  const sameFile = mock.addFile('Brutos', dir.id, { size: 4 })
  mock.addFile('apagado.mov', dir.id, { size: 1, trashed: true })

  assert.equal((await drive.findChild(dir.id, tricky)).id, f.id)
  assert.equal((await drive.findChild(dir.id, 'foto.mov')).id, lower.id)
  assert.equal((await drive.findChild(dir.id, 'Foto.MOV')).id, upper.id)
  assert.equal(await drive.findChild(dir.id, 'FOTO.mov'), null, 'o Drive acha sem diferenciar maiúsculas; nós não')
  assert.equal((await drive.findChild(dir.id, 'Brutos', { folder: true })).id, sameFolder.id)
  assert.equal((await drive.findChild(dir.id, 'Brutos', { folder: false })).id, sameFile.id)
  assert.equal(await drive.findChild(dir.id, 'apagado.mov'), null)
  assert.equal(await drive.findChild(dir.id, "nada'aqui"), null)
  assert.equal(await drive.findChild('root', 'Pasta').then(i => i.id), dir.id)
})

test('limites do Google: 429/403 são repetidos com recuo e o limitador corta pela metade', async t => {
  const { mock, drive: base } = await setup(t)
  const drive = new DriveClient(base.auth, base.accountId, { retryBaseMs: 10, ratePerSec: 400 })
  const dir = mock.addFolder('Muitos')
  const ids = Array.from({ length: 30 }, (_, i) => mock.addFile(`f${i}.mov`, dir.id, { size: i }).id)
  mock.setOptions({ seed: 42, failures: { error429Prob: 0.25, rateLimit403Prob: 0.2 } })
  const items = await Promise.all(ids.map(id => drive.getItem(id)))
  assert.deepEqual(items.map(i => i.id), ids)
  const listed = await drive.listChildren(dir.id)
  assert.equal(listed.length, 30)
  const faults = mock.stats().faults
  assert.ok(faults.error429 > 0 && faults.rateLimit403 > 0, JSON.stringify(faults))
  const lim = drive.limiter.stats()
  assert.ok(lim.cuts >= 1)
  assert.ok(lim.rate < 400 && lim.limit < 8, JSON.stringify(lim))

  // Sem novas tentativas, o erro sobe classificado como 'retry'.
  mock.setOptions({ failures: { error429Prob: 1 } })
  await assert.rejects(drive.api('GET', `files/${ids[0]}`, { query: { fields: 'id' }, retries: 0 }), err => {
    assert.equal(err.status, 429)
    assert.equal(classifyError(err).kind, 'retry')
    return true
  })
  mock.setOptions({ failures: { rateLimit403Prob: 1 } })
  await assert.rejects(drive.api('GET', `files/${ids[0]}`, { query: { fields: 'id' }, retries: 1 }), err => err.status === 403 && classifyError(err).kind === 'retry')
  // Erros que não são de limite (ex.: 404) não são repetidos.
  mock.setOptions({ failures: {} })
  mock.resetStats()
  await assert.rejects(drive.getItem('nao-existe'), err => err.status === 404)
  assert.equal(mock.stats().requests['files.get'], 1)
})

test('401 renova o token uma vez e repete; muitos 401 ao mesmo tempo = uma renovação', async t => {
  const { mock, drive } = await setup(t)
  const dir = mock.addFolder('Pasta')
  mock.expireAccessTokens()
  mock.resetStats()
  const results = await Promise.all(Array.from({ length: 8 }, () => drive.getItem(dir.id)))
  assert.ok(results.every(r => r.id === dir.id))
  assert.equal(mock.stats().requests['oauth.token'], 1)

  // Token que já nasce vencido: repete uma vez só e desiste com 'auth'.
  mock.setOptions({ tokenTtlSec: 0 })
  mock.expireAccessTokens()
  mock.resetStats()
  await assert.rejects(drive.getItem(dir.id), err => err.status === 401 && classifyError(err).kind === 'auth')
  assert.equal(mock.stats().requests['files.get'], 2)
})

test('getPath: breadcrumb do Meu Drive, cache e pastas compartilhadas comigo', async t => {
  const { mock, drive } = await setup(t)
  const a = mock.addFolder('Clientes')
  const b = mock.addFolder('Marca Y', a.id)
  const c = mock.addFolder('Campanha 2026', b.id)
  assert.deepEqual(await drive.getPath('root'), [{ id: 'root', name: 'Meu Drive' }])
  assert.deepEqual(await drive.getPath(c.id), [
    { id: 'root', name: 'Meu Drive' },
    { id: a.id, name: 'Clientes' },
    { id: b.id, name: 'Marca Y' },
    { id: c.id, name: 'Campanha 2026' },
  ])
  mock.resetStats()
  assert.equal((await drive.getPath(c.id)).length, 4)
  assert.equal(mock.stats().requests['files.get'] ?? 0, 0, 'segunda vez sai do cache')
  const rootId = mock.getItem('root').id
  assert.deepEqual(await drive.getPath(rootId), [{ id: 'root', name: 'Meu Drive' }])

  // Pasta "compartilhada comigo" cujo pai a conta não enxerga: o caminho começa nela.
  const fresh = new DriveClient(drive.auth, drive.accountId)
  const hiddenParent = mock.addFolder('Do outro', 'root', { resourceKey: true })
  const shared = mock.addFolder('Compartilhada', hiddenParent.id)
  assert.deepEqual(await fresh.getPath(shared.id), [{ id: shared.id, name: 'Compartilhada' }])
  await assert.rejects(fresh.getPath('nao-existe'), err => classifyError(err).kind === 'notfound')
})

test('search: nome contém o termo, sem lixeira, pastas primeiro', async t => {
  const { mock, drive } = await setup(t)
  const d = mock.addFolder('Entrevista bruta')
  mock.addFile('Entrevista 01.mov', d.id, { size: 1 })
  mock.addFile('entrevista-final.mov', 'root', { size: 1 })
  mock.addFile('Entrevista velha.mov', 'root', { size: 1, trashed: true })
  mock.addFile('Outro.mov', 'root', { size: 1 })
  const found = await drive.search('entrevista')
  assert.deepEqual(found.map(i => i.name), ['Entrevista bruta', 'Entrevista 01.mov', 'entrevista-final.mov'])
  assert.deepEqual(await drive.search('   '), [])
  assert.deepEqual((await drive.search("O'Brien")).length, 0)
})

test('limitador de metadados: no máximo 8 simultâneas, ~20 req/s e recuperação gradual', async t => {
  const { mock, drive } = await setup(t, { latencyMs: 80 })
  const f = mock.addFile('x.mov', 'root', { size: 1 })
  // 32 chamadas com 80 ms de latência e 8 vagas: pelo menos 4 "ondas".
  let t0 = performance.now()
  await Promise.all(Array.from({ length: 32 }, () => drive.getItem(f.id)))
  const elapsed = performance.now() - t0
  assert.ok(elapsed >= 4 * 80 * 0.9, `paralelismo acima do limite? ${elapsed.toFixed(0)} ms`)

  // Taxa: 50 chamadas a 20/s (rajada de 20) levam pelo menos ~1,5 s.
  mock.setOptions({ latencyMs: 0 })
  const rated = new DriveClient(drive.auth, drive.accountId, { ratePerSec: 20, maxConcurrent: 8 })
  await rated.getItem(f.id)
  await new Promise(resolve => setTimeout(resolve, 1100)) // balde cheio de novo
  t0 = performance.now()
  await Promise.all(Array.from({ length: 50 }, () => rated.getItem(f.id)))
  const rateElapsed = performance.now() - t0
  assert.ok(rateElapsed >= 1200, `taxa acima de 20/s? ${rateElapsed.toFixed(0)} ms`)

  // Unidade: corte pela metade e volta gradual.
  const half = new MetadataLimiter({ maxConcurrent: 8, ratePerSec: 20 })
  half.penalize()
  half.penalize() // mesma rajada: um corte só
  assert.deepEqual(half.stats(), { active: 0, waiting: 0, limit: 4, rate: 10, cuts: 1 })

  const cooldownMs = 1000
  const lim = new MetadataLimiter({ maxConcurrent: 8, ratePerSec: 1000, cooldownMs, recoverMs: 400 })
  const cutAt = Date.now()
  lim.penalize()
  let st = lim.stats()
  assert.equal(st.limit, 4)
  assert.equal(st.rate, 500)
  await Promise.all(Array.from({ length: 4 }, () => lim.acquire()))
  let fifthIn = false
  const fifth = lim.acquire().then(() => (fifthIn = true))
  await new Promise(resolve => setTimeout(resolve, 20))
  st = lim.stats()
  // Só dá para afirmar enquanto o resfriamento não acabou (máquina muito carregada pode pular isso).
  if (Date.now() - cutAt < cooldownMs * 0.8) {
    assert.equal(fifthIn, false, 'acima do limite cortado espera vaga')
    assert.equal(st.waiting, 1)
    assert.equal(st.rate, 500, 'durante o resfriamento não sobe')
  }
  lim.release()
  await fifth
  for (let i = 0; i < 4; i++) lim.release()
  assert.equal(lim.stats().active, 0)
  await new Promise(resolve => setTimeout(resolve, Math.max(0, cutAt + cooldownMs + 600 - Date.now())))
  st = lim.stats()
  assert.equal(st.rate, 1000)
  assert.equal(st.limit, 8)
  // Cortes seguidos têm piso: a navegação nunca para de vez.
  const floor = new MetadataLimiter({ ratePerSec: 20, cooldownMs: 0 })
  for (let i = 0; i < 20; i++) floor.penalize()
  assert.equal(floor.stats().rate, 2)
  assert.equal(floor.stats().limit, 1)

  // Abort enquanto espera vaga: sai da fila sem ocupar vaga.
  const tiny = new MetadataLimiter({ maxConcurrent: 1, ratePerSec: 1000 })
  await tiny.acquire()
  const ac = new AbortController()
  const waiting = tiny.acquire(ac.signal)
  ac.abort()
  await assert.rejects(waiting, err => classifyError(err).kind === 'abort')
  tiny.release()
  assert.equal(tiny.active, 0)
  await tiny.acquire()
  assert.equal(tiny.active, 1)
  tiny.release()
})

test('sem conexão nenhuma (conexão recusada): desiste em segundos, não em ~45 s de recuo', async t => {
  const { mock, drive: base } = await setup(t)
  const drive = new DriveClient(base.auth, base.accountId, { offlineWindowMs: 1500 })
  await drive.about() // token já em cache: daqui para frente só a rede importa
  await mock.close()
  const t0 = Date.now()
  await assert.rejects(drive.listChildren('root'), err => {
    const info = classifyError(err)
    assert.equal(info.kind, 'retry')
    assert.equal(info.reason, 'ECONNREFUSED')
    return true
  })
  const took = Date.now() - t0
  assert.ok(took >= 900, `tentou de novo antes de desistir (${took} ms)`)
  assert.ok(took < 5000, `demorou ${took} ms`)
})
