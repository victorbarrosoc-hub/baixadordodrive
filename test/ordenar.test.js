// Ordenar e filtrar a tela Drive (public/lib/ordenar.js, sem navegador): a ordem por Tipo, o filtro por tipo com os
// formatos de câmera (BRAW com application/octet-stream), os arquivos do Mac escondidos e a seleção só do que está à
// vista. A regra de "o que pode ir para a lixeira" é a mesma do servidor (src/util/paths.js isMacClutter).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SORT, canTrashMac, compareItems, driveView, filterButton, filterChips, isMacFile, keepVisible, kindOf, macHiddenText, nextSort,
  normalizeSort, sortLabel, visibleSummary, chunks,
} from '../public/lib/ordenar.js'
import { isMacClutter, MAC_CLUTTER_MAX_BYTES } from '../src/util/paths.js'
import { MAC_MAX_BYTES } from '../public/lib/ordenar.js'

const FOLDER = 'application/vnd.google-apps.folder'
let seq = 0
const file = (name, extra = {}) => ({ id: `f${++seq}`, name, mimeType: 'application/octet-stream', size: 1000, modifiedTime: '2026-10-14T12:00:00.000Z', isFolder: false, isShortcut: false, isGoogleDoc: false, ...extra })
const folder = (name, extra = {}) => ({ id: `d${++seq}`, name, mimeType: FOLDER, size: null, modifiedTime: '2026-10-10T12:00:00.000Z', isFolder: true, isShortcut: false, isGoogleDoc: false, ...extra })
const names = list => list.map(x => x.name)

test('ordem por Tipo: pastas primeiro, depois pela extensão e, no empate, pelo nome (A a Z nas duas direções)', () => {
  const items = [
    file('Trilha.wav'), file('B001_C001.mov'), file('A001_C002.braw'), folder('Proxy'), file('A001_C001.braw'),
    file('Claquete.jpg'), file('LEIAME'), folder('01 Brutos'),
    { id: 'atalho', name: 'Atalho Entregas', mimeType: 'application/vnd.google-apps.shortcut', isShortcut: true, shortcutTargetMimeType: FOLDER, size: null },
  ]
  const asc = items.slice().sort(compareItems('type', 'asc'))
  assert.deepEqual(names(asc), ['01 Brutos', 'Atalho Entregas', 'Proxy', 'LEIAME', 'A001_C001.braw', 'A001_C002.braw', 'Claquete.jpg', 'B001_C001.mov', 'Trilha.wav'])
  const desc = items.slice().sort(compareItems('type', 'desc'))
  assert.deepEqual(names(desc).slice(0, 3), ['01 Brutos', 'Atalho Entregas', 'Proxy'], 'pastas continuam primeiro (sem extensão: empate, pelo nome)')
  assert.deepEqual(names(desc).slice(3), ['Trilha.wav', 'B001_C001.mov', 'Claquete.jpg', 'A001_C001.braw', 'A001_C002.braw', 'LEIAME'], 'mesmo tipo fica de A a Z')
})

test('ordem por Nome (números como gente lê), Tamanho e Modificado', () => {
  const a = file('A001_C10.braw', { size: 30, modifiedTime: '2026-10-01T00:00:00Z' })
  const b = file('A001_C9.braw', { size: 30, modifiedTime: '2026-10-03T00:00:00Z' })
  const c = file('a001_c1.braw', { size: 50, modifiedTime: null })
  const d = folder('Z pasta')
  const list = [a, b, c, d]
  assert.deepEqual(names(list.slice().sort(compareItems('name', 'asc'))), ['Z pasta', 'a001_c1.braw', 'A001_C9.braw', 'A001_C10.braw'])
  assert.deepEqual(names(list.slice().sort(compareItems('name', 'desc'))), ['Z pasta', 'A001_C10.braw', 'A001_C9.braw', 'a001_c1.braw'])
  assert.deepEqual(names(list.slice().sort(compareItems('size', 'desc'))), ['Z pasta', 'a001_c1.braw', 'A001_C9.braw', 'A001_C10.braw'], 'empate no tamanho: pelo nome')
  assert.deepEqual(names(list.slice().sort(compareItems('modified', 'desc'))), ['Z pasta', 'A001_C9.braw', 'A001_C10.braw', 'a001_c1.braw'], 'sem data vai para o fim nos mais novos')
})

test('nextSort: a opção ativa inverte; outra começa na direção natural; lixo do localStorage vira Nome ↑', () => {
  assert.deepEqual(nextSort({ key: 'name', dir: 'asc' }, 'name'), { key: 'name', dir: 'desc' })
  assert.deepEqual(nextSort({ key: 'name', dir: 'desc' }, 'name'), { key: 'name', dir: 'asc' })
  assert.deepEqual(nextSort({ key: 'name', dir: 'asc' }, 'modified'), { key: 'modified', dir: 'desc' }, 'mais novos primeiro')
  assert.deepEqual(nextSort({ key: 'name', dir: 'asc' }, 'size'), { key: 'size', dir: 'desc' }, 'maiores primeiro')
  assert.deepEqual(nextSort({ key: 'size', dir: 'desc' }, 'type'), { key: 'type', dir: 'asc' })
  assert.deepEqual(normalizeSort(null), DEFAULT_SORT)
  assert.deepEqual(normalizeSort({ key: 'cor', dir: 'asc' }), DEFAULT_SORT)
  assert.deepEqual(normalizeSort({ key: 'size', dir: 'x' }), { key: 'size', dir: 'asc' })
  assert.deepEqual(sortLabel({ key: 'name', dir: 'asc' }), { short: 'Nome ↑', long: 'Nome: A a Z' })
  assert.deepEqual(sortLabel({ key: 'modified', dir: 'desc' }), { short: 'Modificado ↓', long: 'Modificado: Mais novos primeiro' })
})

test('tipo de cada item: formatos de câmera são vídeo mesmo com application/octet-stream', () => {
  const oct = { mimeType: 'application/octet-stream' }
  for (const n of ['A003_C001_1014XQ.braw', 'A001_C001_0101AB.R3D', 'A001C001_220101_R1AB.ari', 'A001C001.arx', 'MVI_0001.CRM', 'C0001.MXF', 'Master_ProRes.mov', 'X.prores']) {
    assert.equal(kindOf(file(n, oct)), 'video', n)
  }
  assert.equal(kindOf(file('Sem extensão', { mimeType: 'video/mp4' })), 'video', 'sem extensão: pelo tipo do Drive')
  assert.equal(kindOf(file('Claquete.JPG', oct)), 'image')
  assert.equal(kindOf(file('IMG_0001.CR3', oct)), 'image')
  assert.equal(kindOf(file('Som_Direto_T01.wav', oct)), 'audio')
  assert.equal(kindOf(file('Projeto.drp', oct)), 'other')
  assert.equal(kindOf(file('Decupagem', { mimeType: 'application/vnd.google-apps.spreadsheet', isGoogleDoc: true, size: null })), 'other')
  assert.equal(kindOf(folder('Proxy')), 'folder')
  assert.equal(kindOf({ id: 's', name: 'Atalho.braw', isShortcut: true, mimeType: 'application/vnd.google-apps.shortcut', shortcutTargetMimeType: 'application/octet-stream' }), 'video', 'atalho conta pelo alvo')
  assert.equal(kindOf(file('._A003_C001_1014XQ.braw', { size: 4096 })), 'other', 'o ._ do Mac não é vídeo')
})

test('filtro "Vídeos" com BRAW octet-stream: mostra só os vídeos, na ordem, e a linha diz o que está visível', () => {
  const items = [
    folder('Proxy'),
    file('A003_C001_1014XQ.braw', { size: 31_200_000_000 }),
    file('A003_C002_1014K2.braw', { size: 48_700_000_000 }),
    file('B001_C001.mov', { mimeType: 'video/quicktime', size: 4_100_000_000 }),
    file('Claquete.jpg', { mimeType: 'image/jpeg', size: 900_000 }),
    file('Som_Direto_T01.wav', { mimeType: 'audio/wav', size: 812_000_000 }),
    file('._A003_C001_1014XQ.braw', { size: 4096 }),
    file('._A003_C002_1014K2.braw', { size: 4096 }),
    file('.DS_Store', { size: 6148 }),
  ]
  const v = driveView(items, { sort: { key: 'size', dir: 'desc' }, filter: 'video' })
  assert.deepEqual(names(v.sorted), ['A003_C002_1014K2.braw', 'A003_C001_1014XQ.braw', 'B001_C001.mov'])
  assert.deepEqual(v.counts, { all: 6, video: 3, image: 1, audio: 1, folder: 1, other: 0 }, 'os do Mac não contam')
  assert.equal(v.mac.length, 3)
  assert.equal(visibleSummary(v.sorted, 'video'), '3 vídeos · 84 GB')
  assert.equal(visibleSummary(driveView(items, { filter: 'folder' }).sorted, 'folder'), '1 pasta')
  assert.deepEqual(filterChips(v.counts, 'video').map(c => `${c.label} ${c.count}`), ['Tudo 6', 'Vídeos 3', 'Fotos 1', 'Áudio 1', 'Pastas 1'], 'menu Filtro: sem "Outros" vazio')
  assert.deepEqual(filterChips(v.counts, 'other').map(c => c.value), ['all', 'video', 'image', 'audio', 'folder', 'other'], 'o ativo fica mesmo vazio')

  // O botão "Filtro" da barra (no lugar dos chips): "Tudo" sem filtro; com filtro, o nome do tipo e a dica.
  assert.deepEqual(filterButton('all'), { label: 'Tudo', on: false, title: 'Filtro: Tudo' })
  assert.deepEqual(filterButton('video'), { label: 'Vídeos', on: true, title: 'Filtro: só vídeos' })
  assert.deepEqual(filterButton('other'), { label: 'Outros', on: true, title: 'Filtro: só outros arquivos' })
  assert.deepEqual(filterButton('nada'), { label: 'Tudo', on: false, title: 'Filtro: Tudo' }, 'desconhecido vira Tudo')

  // Tudo, sem os do Mac (padrão) e com eles à vista.
  const tudo = driveView(items)
  assert.equal(tudo.sorted.length, 6)
  assert.ok(!tudo.sorted.some(isMacFile))
  const comMac = driveView(items, { showMac: true })
  assert.equal(comMac.sorted.length, 9)
  assert.equal(comMac.counts.other, 3, 'à vista, os do Mac entram em Outros')
  assert.equal(driveView(items, { filter: 'nada' }).filter, 'all', 'filtro desconhecido vira Tudo')
  assert.equal(macHiddenText(38), '38 arquivos do Mac ocultos')
  assert.equal(macHiddenText(1), '1 arquivo do Mac oculto')
})

test('seleção e "Selecionar tudo" só com o que está visível', () => {
  const braw = file('A.braw')
  const jpg = file('B.jpg')
  const sel = new Set([braw.id, jpg.id])
  const v = driveView([braw, jpg], { filter: 'video' })
  assert.deepEqual([...keepVisible(sel, v.sorted)], [braw.id])
  const same = new Set([braw.id])
  assert.equal(keepVisible(same, v.sorted), same, 'sem mudança: o mesmo Set (não redesenha à toa)')
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
})

test('arquivos do Mac: a tela e o servidor concordam no que pode ir para a lixeira', () => {
  assert.equal(MAC_MAX_BYTES, MAC_CLUTTER_MAX_BYTES)
  const cases = [
    [file('._A003_C001_1014XQ.braw', { size: 143_000 }), true],
    [file('._A003_C001_1014XQ.braw', { size: MAC_MAX_BYTES - 1 }), true],
    [file('._grande.braw', { size: MAC_MAX_BYTES }), false],
    [file('._sem_tamanho', { size: null }), false],
    [file('.DS_Store', { size: 6148 }), true],
    [file('.ds_store', { size: 20_000_000 }), true],
    [file('Thumbs.db', { size: 10 }), true],
    [file('A003_C001_1014XQ.braw', { size: 100 }), false],
    [file('.hidden', { size: 100 }), false],
    [file('desktop.ini', { size: 100 }), false],
    [folder('._pasta'), false],
    [file('._Doc', { isGoogleDoc: true, size: null, mimeType: 'application/vnd.google-apps.document' }), false],
    [{ id: 'x', name: '._atalho', isShortcut: true, mimeType: 'application/vnd.google-apps.shortcut', shortcutTargetMimeType: 'video/mp4', size: null }, false],
  ]
  for (const [it, want] of cases) {
    assert.equal(canTrashMac(it), want, `tela: ${it.name} (${it.size})`)
    assert.equal(isMacClutter(it), want, `servidor: ${it.name} (${it.size})`)
  }
  assert.equal(isMacFile(file('._grande.braw', { size: 9e9 })), true, 'escondido, mesmo sem poder ir para a lixeira')
})
