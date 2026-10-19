// Tira de quadros do hover scrub (src/media/quadros.js e a parte dela na fila e no lote da prévia): tamanho dos quadros,
// a marca no original, a linha de comando, e — com um ffmpeg de verdade — a tira saindo de um vídeo, subindo para
// Proxy/<nome>.quadros.jpg ao lado do proxy e o original apontando para ela; os que já tinham proxy ganham a tira no
// "Gerar proxies da pasta" baixando só o proxy; a tira não aparece na lista nem vira "só no Drive" no Comparar.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DriveClient } from '../src/google/drive.js'
import { GeradorPrevias } from '../src/media/previa-fila.js'
import { gerarPreviasLote, resumoPrevias } from '../src/media/previa-lote.js'
import { detectarMotor, parseProbe } from '../src/media/previa.js'
import { QUADROS_COLS, argsQuadros, celula, gerarQuadros, gradeTexto, lerGrade, quadrosName } from '../src/media/quadros.js'
import { driveView } from '../public/lib/ordenar.js'
import { closeHttp } from '../src/net/http.js'
import { makeTmpDir, setupDrive } from './helpers.js'

after(() => closeHttp())

const ffmpeg = (() => {
  try {
    const r = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' })
    return r.status === 0 ? r.stdout.trim() : null
  } catch {
    return null
  }
})()
const semFfmpeg = !ffmpeg && 'sem ffmpeg neste computador'

async function tmp(t, prefix = 'sobedesce-quadros-') {
  const dir = await makeTmpDir(prefix)
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}

function clipe(file, { s = '1280x720', d = 6, extra = [] } = {}) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${s}:r=24:d=${d}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...extra, file])
  assert.equal(r.status, 0, String(r.stderr))
  return file
}

const dims = file => {
  const v = parseProbe(spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr).video
  return `${v.width}x${v.height}`
}

test('tamanho dos quadros, marca no original, nome e linha de comando', () => {
  assert.deepEqual(celula(1920, 1080), { w: 240, h: 136 })
  assert.deepEqual(celula(1080, 1920), { w: 136, h: 240 })
  assert.deepEqual(celula(4096, 1716), { w: 240, h: 100 })
  assert.deepEqual(celula(null, null), { w: 240, h: 136 })
  assert.equal(gradeTexto({ n: 64, cols: 8, w: 240, h: 136 }), '64.8.240.136')
  assert.deepEqual(lerGrade('64.8.240.136'), { n: 64, cols: 8, w: 240, h: 136 })
  for (const ruim of ['', '64.8.240', 'a.b.c.d', '8.64.240.136', null]) assert.equal(lerGrade(ruim), null, String(ruim))
  // A marca cabe no limite do Google (chave + valor ≤ 124 bytes).
  assert.ok(Buffer.byteLength('quadrosGrade') + Buffer.byteLength('999.99.9999.9999') <= 124)
  assert.equal(quadrosName('A001_C002.braw'), 'A001_C002.quadros.jpg')
  assert.equal(quadrosName('Cena 1.MOV'), 'Cena 1.quadros.jpg')

  const a = argsQuadros({ input: '/p.mp4', output: '/q.jpg', durationS: 64, cel: { w: 240, h: 136 } })
  const vf = a[a.indexOf('-vf') + 1]
  assert.match(vf, /^fps=1\.01\d*,scale=240:136,setsar=1,tile=8x8$/)
  assert.ok(!a.includes('-skip_frame'), 'clipe curto: todos os quadros')
  assert.deepEqual(a.slice(a.indexOf('-frames:v'), a.indexOf('-frames:v') + 2), ['-frames:v', '1'])
  const longo = argsQuadros({ input: '/p.mp4', output: '/q.jpg', durationS: 3600, cel: { w: 240, h: 136 }, n: 16 })
  assert.deepEqual(longo.slice(longo.indexOf('-skip_frame'), longo.indexOf('-skip_frame') + 2), ['-skip_frame', 'nokey'])
  assert.match(longo[longo.indexOf('-vf') + 1], /tile=8x2$/)
})

test('a tira sai de um vídeo de verdade: grade 8 × 8 de 240 px; clipe curto tem menos quadros; em pé fica em pé', { skip: semFfmpeg }, async t => {
  const dir = await tmp(t)
  const motor = await detectarMotor({ candidates: [{ path: ffmpeg, origem: 'sistema' }], braw: null })
  const q = await gerarQuadros(motor, clipe(path.join(dir, 'a.mp4'), { d: 20 }), { dir })
  assert.deepEqual(q.grade, { n: 64, cols: 8, w: 240, h: 136 })
  assert.equal(dims(q.path), '1920x1088')
  assert.ok(q.size > 10_000 && q.size < 900_000, String(q.size))

  const sub = path.join(dir, 'curto')
  await fs.mkdir(sub)
  const c = await gerarQuadros(motor, clipe(path.join(sub, 'c.mp4'), { d: 3 }), { dir: sub })
  assert.equal(c.grade.n, 16, '3 s → 12 quadros, arredondado para 2 linhas de 8')
  assert.equal(dims(c.path), `${240 * QUADROS_COLS}x${136 * 2}`)

  const pe = path.join(dir, 'pe')
  await fs.mkdir(pe)
  const p = await gerarQuadros(motor, clipe(path.join(pe, 'p.mp4'), { s: '720x1280', d: 4 }), { dir: pe })
  assert.deepEqual([p.grade.w, p.grade.h], [136, 240])

  await assert.rejects(gerarQuadros({ via: 'avconvert' }, path.join(dir, 'a.mp4'), { dir }), /sem ffmpeg/)
})

test('fila: depois do proxy, a tira sobe em Proxy/ com a marca e o original aponta para ela; refazer troca a mesma', { skip: semFfmpeg }, async t => {
  const env = await setupDrive()
  t.after(() => env.cleanup())
  const mock = env.mock
  const drive = new DriveClient(env.auth, env.accountId, { ratePerSec: 1000, retryBaseMs: 5 })
  const tmpRoot = await tmp(t, 'sobedesce-quadros-tmp-')
  const motor = await detectarMotor({ candidates: [{ path: ffmpeg, origem: 'sistema' }], braw: null })
  // O "proxy" é um H.264 de verdade (a tira sai dele), escrito num temporário como o gerarPrevia faz.
  const gerar = async () => {
    const d = await fs.mkdtemp(path.join(tmpRoot, 'sobedesce-previa-'))
    const p = clipe(path.join(d, 'previa.mp4'), { d: 8 })
    return { estado: 'pronta', path: p, size: (await fs.stat(p)).size, encoder: 'libx264', motivo: 'ProRes', limpar: () => fs.rm(d, { recursive: true, force: true }) }
  }
  const logs = []
  const g = new GeradorPrevias({ detect: async () => motor, gerar, tmpRoot, retryBaseMs: 5, selfCheck: false, log: m => logs.push(m) })
  const dia = mock.addFolder('Diária 1')
  const orig = mock.addFile('A001.mov', dia.id, { size: 5000, seed: 1, appProperties: { outra: 'fica' } })

  const r = await g.gerarESubir({ drive, localPath: '/nao/importa', name: 'A001.mov', size: 5000, parentId: dia.id, originalId: orig.id })
  assert.equal(r.estado, 'pronta', logs.join('\n'))
  const o = mock.getItem(orig.id)
  assert.equal(o.appProperties.outra, 'fica', 'as outras marcas do original ficam')
  assert.equal(o.appProperties.quadrosGrade, '32.8.240.136')
  const tira = mock.getItem(o.appProperties.quadros)
  assert.equal(tira.name, 'A001.quadros.jpg')
  assert.equal(tira.mimeType, 'image/jpeg')
  assert.deepEqual(tira.appProperties, { sobedesce: 'quadros', original: orig.id, proxy: r.fileId })
  assert.deepEqual(tira.parents, mock.getItem(r.fileId).parents, 'ao lado do proxy, em Proxy/')
  assert.deepEqual((await fs.readdir(tmpRoot)).filter(n => n.startsWith('sobedesce-')), [], 'temporários apagados')

  // Refazer o proxy (replaceFileId): a mesma tira é trocada, sem "A001.quadros (1).jpg".
  const r2 = await g.gerarESubir({ drive, localPath: '/nao/importa', name: 'A001.mov', size: 5000, parentId: dia.id, originalId: orig.id, replaceFileId: r.fileId, forcar: true })
  assert.equal(r2.fileId, r.fileId)
  assert.equal(mock.getItem(orig.id).appProperties.quadros, tira.id)
  const nomes = mock.listAll().filter(it => !it.trashed && it.name.includes('quadros')).map(it => it.name)
  assert.deepEqual(nomes, ['A001.quadros.jpg'])

  // Sem ffmpeg (Mac só com avconvert): proxy sai, tira não, e nada quebra.
  const semFf = new GeradorPrevias({ detect: async () => ({ via: 'avconvert', avconvert: '/usr/bin/avconvert' }), gerar, tmpRoot, retryBaseMs: 5, selfCheck: false })
  const b = mock.addFile('B001.mov', dia.id, { size: 5000, seed: 2 })
  const rb = await semFf.gerarESubir({ drive, localPath: '/nao/importa', name: 'B001.mov', size: 5000, parentId: dia.id, originalId: b.id })
  assert.equal(rb.estado, 'pronta')
  assert.equal(mock.getItem(b.id).appProperties?.quadros, undefined)
})

test('lote: quem já tinha proxy (da câmera ou nosso) ganha a tira baixando só o proxy; quem já tem tira fica', { skip: semFfmpeg }, async t => {
  const env = await setupDrive()
  t.after(() => env.cleanup())
  const mock = env.mock
  const drive = new DriveClient(env.auth, env.accountId, { ratePerSec: 1000, retryBaseMs: 5 })
  const tmpRoot = await tmp(t, 'sobedesce-quadros-tmp-')
  const local = await tmp(t)
  const motor = await detectarMotor({ candidates: [{ path: ffmpeg, origem: 'sistema' }], braw: null })
  const g = new GeradorPrevias({ detect: async () => motor, gerar: async () => assert.fail('não gera proxy'), tmpRoot, retryBaseMs: 5, selfCheck: false })
  const mp4 = await fs.readFile(clipe(path.join(local, 'p.mp4'), { d: 5 }))

  const dia = mock.addFolder('Diária 3')
  const proxyDir = mock.addFolder('Proxy', dia.id)
  const cam = mock.addFile('A001_C001.braw', dia.id, { size: 9000, seed: 1 })
  mock.addFile('A001_C001.mp4', proxyDir.id, { content: mp4 }) // proxy gravado pela câmera
  const ja = mock.addFile('A002_C001.braw', dia.id, { size: 9000, seed: 2, appProperties: { quadros: 'x', quadrosGrade: '64.8.240.136' } })
  mock.addFile('A002_C001.mp4', proxyDir.id, { content: mp4 })

  const s = await gerarPreviasLote({ drive, gerador: g, driveFolderId: dia.id, localDir: local })
  assert.equal(s.jaTinham, 2)
  assert.equal(s.quadrosAGerar, 1)
  assert.equal(s.quadros, 1)
  assert.equal(s.quadrosFalhou, 0)
  assert.match(resumoPrevias(s), /1 tira de quadros gerada/)
  const o = mock.getItem(cam.id)
  assert.equal(mock.getItem(o.appProperties.quadros).name, 'A001_C001.quadros.jpg')
  assert.deepEqual(mock.getItem(o.appProperties.quadros).parents, [proxyDir.id])
  assert.equal(mock.getItem(ja.id).appProperties.quadros, 'x', 'quem já tinha tira não é tocado')
  assert.deepEqual((await fs.readdir(tmpRoot)).filter(n => n.startsWith('sobedesce-')), [], 'o proxy baixado foi apagado')
})

test('a tira não aparece na lista da tela Drive', () => {
  const items = [
    { id: '1', name: 'A001.mp4', mimeType: 'video/mp4' },
    { id: '2', name: 'A001.quadros.jpg', mimeType: 'image/jpeg', appProperties: { sobedesce: 'quadros' } },
    { id: '3', name: 'foto.jpg', mimeType: 'image/jpeg' },
  ]
  const v = driveView(items)
  assert.deepEqual(v.sorted.map(x => x.id).sort(), ['1', '3'])
  assert.equal(v.counts.image, 1)
})
