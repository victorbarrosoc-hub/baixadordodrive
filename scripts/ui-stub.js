#!/usr/bin/env node
// Servidor falso para desenvolver a interface do SOBEDESCE sem o motor real.
//
//   node scripts/ui-stub.js                 → http://127.0.0.1:4318
//
// Variáveis:
//   STUB_PORT=4318        porta
//   STUB_SETUP=0          simula instalação nova (sem chave do Google, sem contas, sem transferências)
//   STUB_MANY=1           acrescenta um lote com 3.000 quadros EXR (teste de desempenho da lista)
//   STUB_DEMO_DIR=/caminho  cria ali um disco de exemplo (/Users/victor com Filmes, Downloads…, e
//                         /Volumes/Externo SSD) com arquivos esparsos (não ocupam espaço) e mostra
//                         esse diretório como se fosse a raiz "/" do computador (bom para screenshots)
//   STUB_PLATFORM=darwin  plataforma informada à interface (darwin | win32 | linux)
//   STUB_VERSAO=42        aviso de versão nova: o site tem o build 42 e este app é o anterior (sem: build 0, sem aviso)
//   STUB_DESKTOP=1        simula o app de desktop: injeta uma ponte falsa `window.sobedesce` (seletores nativos
//                         devolvem caminhos da pasta de demonstração, notify/setProgress/reveal só registram no
//                         console, openExternal da tela de login conclui o OAuth sozinho depois de 2,5 s)
//
// Implementa todas as rotas de docs/ARCHITECTURE.md com dados inventados, transferências que
// andam sozinhas (downloads segmentados com "roubo" de segmentos), SSE (transfers 4×/s, stats 2×/s)
// e um trabalho de comparação que passa pelas fases e devolve um CompareResult realista.
// Só usa módulos do Node.

import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = path.join(ROOT, 'public')
const VENDOR = path.join(ROOT, 'node_modules/htm/preact/standalone.module.js')
const PORT = Number(process.env.STUB_PORT || 4318)
const FRESH = process.env.STUB_SETUP === '0'
const MANY = process.env.STUB_MANY === '1'
const DEMO_DIR = process.env.STUB_DEMO_DIR ? path.resolve(process.env.STUB_DEMO_DIR) : ''
const PLATFORM = process.env.STUB_PLATFORM || 'darwin'
const DESKTOP = process.env.STUB_DESKTOP === '1'
const VERSAO = Number(process.env.STUB_VERSAO) || 0
let versaoDispensada = 0

const KB = 1e3
const MB = 1e6
const GB = 1e9
const MiB = 1024 * 1024

// ───────────────────────────── utilidades ─────────────────────────────

let seed = 42
function rand() {
  // PRNG determinístico (mulberry32) para os dados parecerem sempre os mesmos
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (a, b) => a + (b - a) * rand()
const pad = (n, w) => String(n).padStart(w, '0')
let idSeq = 1000
const newId = (prefix) => `${prefix}_${(idSeq++).toString(36)}${crypto.randomBytes(3).toString('hex')}`
const md5Of = (s) => crypto.createHash('md5').update(String(s)).digest('hex')
const now = () => Date.now()

function log(...args) {
  if (process.env.STUB_QUIET !== '1') console.log('[stub]', ...args)
}

// ───────────────────────────── pasta local de demonstração ─────────────────────────────

// Com STUB_DEMO_DIR, a pasta de demonstração vira a raiz virtual "/" (como um chroot).
const toReal = (p) => (DEMO_DIR ? path.join(DEMO_DIR, path.posix.resolve('/', String(p).replace(/\\/g, '/'))) : path.resolve(p))
const toVirtual = (r) => (DEMO_DIR ? '/' + path.relative(DEMO_DIR, r).split(path.sep).join('/') : r)
const vjoin = (...parts) => (DEMO_DIR ? path.posix.join(...parts) : path.join(...parts))
const HOME = DEMO_DIR ? '/Users/victor' : os.homedir()
const VOLUMES = DEMO_DIR ? '/Volumes' : null

function sparse(file, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (!fs.existsSync(file)) {
    const fd = fs.openSync(file, 'w')
    fs.ftruncateSync(fd, Math.round(size))
    fs.closeSync(fd)
  }
}

function buildDemoDir() {
  if (!DEMO_DIR) return
  const h = toReal(HOME)
  for (const d of ['Desktop', 'Downloads', 'Documents', 'Movies', 'Music', 'Pictures']) fs.mkdirSync(path.join(h, d), { recursive: true })
  sparse(path.join(h, '.zshrc'), 1200)
  sparse(path.join(h, 'Desktop', 'Orçamento Mar Aberto.pdf'), 840 * KB)
  sparse(path.join(h, 'Desktop', 'Storyboard_v2.psd'), 312 * MB)
  sparse(path.join(h, 'Downloads', 'client_secret_1234.apps.googleusercontent.com.json'), 410)
  sparse(path.join(h, 'Downloads', 'LUT_MarAberto_Rec709.cube'), 1.1 * MB)
  sparse(path.join(h, 'Documents', 'Contrato Produtora XYZ.pdf'), 2.4 * MB)
  const doc = path.join(h, 'Movies', 'Documentário Mar Aberto')
  const dia = (n, prefix, count, ext, min, max) => {
    for (let i = 1; i <= count; i++) sparse(path.join(doc, 'Brutos', `Dia ${pad(n, 2)}`, `${prefix}_C${pad(i, 3)}_06${pad(11 + n, 2)}${(i * 7919).toString(36).toUpperCase().slice(-2)}.${ext}`), between(min, max) * GB)
  }
  dia(1, 'A001', 14, 'mov', 8, 52)
  dia(2, 'B002', 18, 'braw', 4, 26)
  dia(3, 'A003', 9, 'mov', 10, 44)
  for (const n of ['Boom_T01', 'Boom_T02', 'Boom_T03', 'Lapela_Ana_T01', 'Lapela_Joao_T01']) sparse(path.join(doc, 'Áudio', `${n}.wav`), between(0.8, 2.6) * GB)
  for (const n of ['Ambiente_Praia', 'Ambiente_Porto', 'Vento_Falesia']) sparse(path.join(doc, 'Áudio', 'Ambientes', `${n}.wav`), between(0.3, 1.2) * GB)
  sparse(path.join(doc, 'Projeto.prproj'), 184 * MB)
  sparse(path.join(doc, 'Roteiro_v4.pdf'), 1.8 * MB)
  sparse(path.join(doc, 'Entrega', 'Master_ProRes4444.mov'), 212 * GB)
  sparse(path.join(doc, 'Entrega', 'Master_H264.mp4'), 8.2 * GB)
  sparse(path.join(doc, 'Entrega', 'Legendas_PT.srt'), 48 * KB)
  sparse(path.join(doc, '.DS_Store'), 6 * KB)
  fs.mkdirSync(path.join(doc, 'Lixo'), { recursive: true })
  const ssd = path.join(toReal(VOLUMES), 'Externo SSD')
  for (let i = 1; i <= 6; i++) sparse(path.join(ssd, 'CARD_A', 'CLIP', `A00${i}_C00${i}_0618RX.R3D`), between(20, 60) * GB)
  sparse(path.join(ssd, 'Backup Projeto.zip'), 4.6 * GB)
  const raid = path.join(toReal(VOLUMES), 'RAID Edição')
  sparse(path.join(raid, 'Finalização', 'Cor', 'Offline_v12.drp'), 96 * MB)
  sparse(path.join(raid, 'Finalização', 'Cor', 'Grade_v3.exr'), 210 * MB)
  sparse(path.join(raid, 'Finalização', 'Som', 'Mix_5.1_v2.wav'), 3.4 * GB)
}

// ───────────────────────────── Drive falso ─────────────────────────────

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const MIMES = {
  mov: 'video/quicktime', mp4: 'video/mp4', mxf: 'application/mxf', braw: 'application/octet-stream', r3d: 'application/octet-stream',
  wav: 'audio/wav', aiff: 'audio/aiff', aif: 'audio/aiff', mp3: 'audio/mpeg', jpg: 'image/jpeg', cr3: 'image/x-canon-cr3', png: 'image/png',
  exr: 'image/x-exr', tif: 'image/tiff', pdf: 'application/pdf', zip: 'application/zip', srt: 'application/x-subrip', prproj: 'application/octet-stream',
  drp: 'application/octet-stream', xml: 'text/xml',
}
const GDOC = { doc: 'application/vnd.google-apps.document', sheet: 'application/vnd.google-apps.spreadsheet', slides: 'application/vnd.google-apps.presentation' }

const driveItems = new Map() // id -> DriveItem & { children: string[] }
const sharedDrives = []

function addDriveItem(parentId, name, opts = {}) {
  const id = opts.id || newId('f')
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  const parent = parentId ? driveItems.get(parentId) : null
  const isFolder = !!opts.folder
  const mimeType = opts.mime || (isFolder ? FOLDER_MIME : MIMES[ext] || 'application/octet-stream')
  const isGoogleDoc = mimeType.startsWith('application/vnd.google-apps.') && !isFolder
  const item = {
    id,
    name,
    mimeType,
    size: isFolder || isGoogleDoc ? null : Math.round(opts.size ?? between(1, 50) * MB),
    md5: isFolder || isGoogleDoc ? null : md5Of(id),
    modifiedTime: new Date(now() - (opts.ageMs ?? between(1, 90) * 86400e3)).toISOString(),
    parents: parentId ? [parentId] : [],
    driveId: opts.driveId ?? parent?.driveId ?? null,
    isFolder,
    isGoogleDoc,
    isShortcut: false,
    shortcutTargetId: null,
    shortcutTargetMimeType: null,
    children: [],
  }
  driveItems.set(id, item)
  if (parent) parent.children.push(id)
  return item
}
const folder = (parentId, name, opts = {}) => addDriveItem(parentId, name, { ...opts, folder: true })

function buildDrive() {
  driveItems.set('root', {
    id: 'root', name: 'Meu Drive', mimeType: FOLDER_MIME, size: null, md5: null, modifiedTime: null, parents: [], driveId: null,
    isFolder: true, isGoogleDoc: false, isShortcut: false, shortcutTargetId: null, shortcutTargetMimeType: null, children: [],
  })
  const doc = folder('root', 'Documentário Mar Aberto', { id: 'f_mar', ageMs: 3600e3 * 5 })
  const brutos = folder(doc.id, 'Brutos', { id: 'f_brutos' })
  const d1 = folder(brutos.id, 'Dia 01', { id: 'f_dia01' })
  addDriveItem(d1.id, 'A001_C002_0612XY.mov', { id: 'f_a001c002', size: 48.2 * GB, ageMs: 86400e3 * 3 })
  addDriveItem(d1.id, 'A001_C003_0612K7.mov', { id: 'f_a001c003', size: 31.4 * GB })
  addDriveItem(d1.id, 'A001_C004_0612QM.mov', { id: 'f_a001c004', size: 22.9 * GB })
  addDriveItem(d1.id, 'A001_C005_0612PL.mov', { size: 17.3 * GB })
  addDriveItem(d1.id, 'A001_C006_0612WE.mov', { size: 41.0 * GB })
  const d2 = folder(brutos.id, 'Dia 02', { id: 'f_dia02' })
  for (let i = 1; i <= 11; i++) addDriveItem(d2.id, `B002_C${pad(i, 3)}_0613${(i * 31).toString(36).toUpperCase()}.braw`, { size: between(4, 26) * GB })
  folder(brutos.id, 'Dia 03')
  const audio = folder(doc.id, 'Áudio', { id: 'f_audio' })
  addDriveItem(audio.id, 'Boom_T01.wav', { id: 'f_boom1', size: 2.14 * GB })
  addDriveItem(audio.id, 'Boom_T02.wav', { size: 1.87 * GB })
  addDriveItem(audio.id, 'Lapela_Ana_T01.wav', { size: 1.32 * GB })
  const amb = folder(audio.id, 'Ambientes')
  addDriveItem(amb.id, 'Ambiente_Praia.wav', { size: 812 * MB })
  addDriveItem(amb.id, 'Vento_Falesia.wav', { size: 455 * MB })
  addDriveItem(doc.id, 'Projeto.prproj', { id: 'f_prproj', size: 184 * MB, ageMs: 3600e3 * 2 })
  addDriveItem(doc.id, 'Roteiro', { id: 'f_roteiro', mime: GDOC.doc, ageMs: 86400e3 })
  addDriveItem(doc.id, 'Decupagem', { mime: GDOC.sheet, ageMs: 86400e3 * 2 })
  const entrega = folder(doc.id, 'Entrega', { id: 'f_entrega' })
  addDriveItem(entrega.id, 'Master_ProRes4444.mov', { size: 212 * GB })
  addDriveItem(entrega.id, 'Legendas_PT.srt', { size: 48 * KB })
  const fotos = folder('root', 'Fotos Still')
  for (let i = 1; i <= 24; i++) addDriveItem(fotos.id, `IMG_${pad(400 + i, 4)}.CR3`, { size: between(24, 38) * MB })
  addDriveItem(fotos.id, 'Contato.jpg', { size: 6.1 * MB })
  const trilhas = folder('root', 'Trilhas')
  addDriveItem(trilhas.id, 'Tema_Principal_v3.aiff', { id: 'f_tema', size: 612 * MB })
  addDriveItem(trilhas.id, 'Tema_Principal_v2.aiff', { size: 598 * MB })
  addDriveItem('root', 'Contrato_Produtora.pdf', { size: 2.4 * MB })
  addDriveItem('root', 'Orçamento 2026', { mime: GDOC.sheet })
  addDriveItem('root', 'Backup_Projeto_Antigo.zip', { size: 18.7 * GB, ageMs: 86400e3 * 200 })

  for (const [id, name] of [['sd_xyz', 'Produtora XYZ'], ['sd_final', 'Finalização']]) {
    sharedDrives.push({ id, name })
    driveItems.set(id, {
      id, name, mimeType: FOLDER_MIME, size: null, md5: null, modifiedTime: null, parents: [], driveId: id,
      isFolder: true, isGoogleDoc: false, isShortcut: false, shortcutTargetId: null, shortcutTargetMimeType: null, children: [],
    })
  }
  const camp = folder('sd_xyz', 'Campanha Verão 2026')
  addDriveItem(camp.id, 'Offline_v12.drp', { size: 96 * MB })
  addDriveItem(camp.id, 'Filme_30s_v7.mov', { size: 6.8 * GB })
  addDriveItem(camp.id, 'Filme_15s_v7.mov', { size: 3.4 * GB })
  addDriveItem(camp.id, 'Briefing', { mime: GDOC.slides })
  const cor = folder(camp.id, 'Cor')
  for (let i = 1; i <= 8; i++) addDriveItem(cor.id, `VER_${pad(i * 10, 3)}_v003.exr`, { size: between(40, 60) * MB })
  folder('sd_xyz', 'Clientes')
  addDriveItem('sd_xyz', 'Arquivo morto.zip', { size: 128 * GB })
  addDriveItem('sd_final', 'Mix_5.1_v2.wav', { size: 3.4 * GB })
  addDriveItem('sd_final', 'Timeline_Final.xml', { size: 2.1 * MB })

  // "Compartilhados comigo": de outras pessoas, fora do Meu Drive (sem pai à vista). `leitor` = só pode ver.
  const comigo = (name, opts = {}) => {
    const it = addDriveItem(null, name, opts)
    it.compartilhado = { por: opts.por || 'Bia Produtora', leitor: !!opts.leitor }
    return it
  }
  const casamento = comigo('Casamento Ana e Leo', { folder: true, id: 'sh_casamento', por: 'Bia Produtora', ageMs: 3600e3 * 20 })
  const cam = folder(casamento.id, 'Câmera A')
  for (let i = 1; i <= 6; i++) addDriveItem(cam.id, `A00${i}_C0${10 + i}_0920.mov`, { size: between(6, 30) * GB })
  folder(casamento.id, 'Áudio')
  addDriveItem(casamento.id, 'Roteiro da cerimônia', { mime: GDOC.doc })
  const agencia = comigo('Agência Norte · Campanha', { folder: true, id: 'sh_agencia', por: 'Agência Norte', leitor: true, ageMs: 86400e3 * 4 })
  addDriveItem(agencia.id, 'Referências_v2.pdf', { size: 18 * MB })
  addDriveItem(agencia.id, 'Logo_pack.zip', { size: 240 * MB })
  comigo('Trilha_aprovada.wav', { por: 'Lucas Som', leitor: true, size: 412 * MB, ageMs: 86400e3 * 2 })
  comigo('Contrato assinado.pdf', { por: 'Edu Cardoso', size: 1.2 * MB, ageMs: 86400e3 * 9 })
}

/** Leitor de algo que veio compartilhado (ou de dentro): não renomeia, não move, não recebe. */
function soLeitura(item) {
  for (let p = item; p; p = p.parents[0] ? driveItems.get(p.parents[0]) : null) if (p.compartilhado) return p.compartilhado.leitor
  return false
}

function publicItem(item) {
  if (!item) return null
  const { children, compartilhado, ...rest } = item
  // Permissões como o motor devolve na navegação (src/google/drive.js capsInfo).
  const leitor = soLeitura(item)
  const out = { ...rest, canRename: !leitor && item.id !== 'root', canMove: !leitor && item.parents.length > 0, canAddChildren: item.isFolder && !leitor, canTrash: !leitor }
  if (compartilhado) out.owner = { name: compartilhado.por, email: null }
  return out
}

function sortItems(list) {
  return list.sort((a, b) => (a.isFolder === b.isFolder ? a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' }) : a.isFolder ? -1 : 1))
}

function drivePath(folderId) {
  const out = []
  let cur = driveItems.get(folderId)
  while (cur) {
    out.unshift({ id: cur.id, name: cur.name })
    cur = cur.parents[0] ? driveItems.get(cur.parents[0]) : null
  }
  return out
}

function walkDrive(id, base = '') {
  const item = driveItems.get(id)
  const out = []
  for (const cid of item.children) {
    const c = driveItems.get(cid)
    const rel = base ? `${base}/${c.name}` : c.name
    if (c.isFolder) out.push(...walkDrive(cid, rel))
    else out.push({ item: c, relPath: rel, relDir: base })
  }
  return out
}

// ───────────────────────────── estado do app ─────────────────────────────

const DEFAULT_SETTINGS = {
  downloadDir: vjoin(HOME, 'Downloads'),
  maxConcurrentDownloads: 3,
  maxConcurrentUploads: 3,
  connectionsPerDownload: 8,
  minSegmentSize: 16 * MiB,
  uploadChunkSize: 256 * MiB,
  bandwidthLimitDown: 0,
  bandwidthLimitUp: 0,
  verifyChecksums: true,
  autoResume: true,
  keepAwake: true,
  downloadConflict: 'skip',
  uploadConflict: 'skip',
  stallTimeoutMs: 30_000,
  restartSlowConnections: true,
  showHiddenFiles: false,
  theme: 'system',
}
const LIMITS = {
  maxConcurrentDownloads: [1, 16], maxConcurrentUploads: [1, 16], connectionsPerDownload: [1, 32], minSegmentSize: [MiB, 1024 * MiB],
  uploadChunkSize: [0, 4096 * MiB], bandwidthLimitDown: [0, Number.MAX_SAFE_INTEGER], bandwidthLimitUp: [0, Number.MAX_SAFE_INTEGER], stallTimeoutMs: [5000, 600000],
}
const ENUMS = { downloadConflict: ['skip', 'rename', 'overwrite'], uploadConflict: ['skip', 'rename', 'replace'], theme: ['system', 'light', 'dark'] }

const state = {
  setup: FRESH ? { configured: false, clientIdHint: null } : { configured: true, clientIdHint: '4821…apps.googleusercontent.com' },
  accounts: FRESH ? [] : [{ id: 'acc_victor', email: 'victor@exemplo.com', name: 'Victor', photoUrl: null, addedAt: now() - 86400e3 * 12, status: 'ok' }],
  settings: { ...DEFAULT_SETTINGS },
}

function validateSettings(patch) {
  const out = { ...state.settings }
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in DEFAULT_SETTINGS)) continue
    const def = DEFAULT_SETTINGS[key]
    if (typeof def === 'number') {
      const n = Number(value)
      if (!Number.isFinite(n)) throw httpError(400, `Valor inválido para ${key}`)
      const [min, max] = LIMITS[key] || [-Infinity, Infinity]
      out[key] = Math.round(Math.min(max, Math.max(min, n)))
    } else if (typeof def === 'boolean') out[key] = Boolean(value)
    else if (ENUMS[key]) {
      if (!ENUMS[key].includes(value)) throw httpError(400, `Valor inválido para ${key}`)
      out[key] = value
    } else if (typeof value === 'string' && value.trim()) out[key] = key === 'downloadDir' ? path.resolve(value.trim()) : value.trim()
    else throw httpError(400, `Valor inválido para ${key}`)
  }
  return out
}

// ───────────────────────────── transferências simuladas ─────────────────────────────

/** @type {Map<string, any>} */
const transfers = new Map()
const batches = []
const dirty = new Set()
const removedQueue = []

function makeBatch(type, label, createdAt = now()) {
  const b = { id: newId('b'), type, label, createdAt, accountId: 'acc_victor' }
  batches.push(b)
  return b
}

function baseRecord(type, batch, name, relPath, size, extra = {}) {
  const t = now()
  return {
    id: newId('t'), type, accountId: 'acc_victor', batchId: batch.id, status: 'queued', name, relPath, size: Math.round(size),
    bytesDone: 0, createdAt: batch.createdAt + transfers.size, startedAt: null, finishedAt: null, updatedAt: t, error: null,
    retryAt: null, attempts: 0, verify: null, note: null, priority: 0, ...extra,
  }
}

function addDownload(batch, item, relPath, destDir, extra = {}) {
  const exp = item.isGoogleDoc ? googleExport(item.mimeType) : null
  const name = exp ? item.name + exp.ext : item.name
  const rec = baseRecord('download', batch, name, relPath ? relPath + (exp ? exp.ext : '') : name, exp ? between(40, 900) * KB : item.size, {
    source: { fileId: item.id, mimeType: item.mimeType, md5: item.md5, modifiedTime: item.modifiedTime, ...(exp ? { export: exp } : {}) },
    dest: { path: vjoin(destDir, relPath ? relPath + (exp ? exp.ext : '') : name), tempPath: vjoin(destDir, (relPath || name) + '.sobedesce-part') },
    segments: [],
    note: exp ? `Exportado como ${exp.ext}` : null,
    ...extra,
  })
  transfers.set(rec.id, rec)
  dirty.add(rec.id)
  return rec
}

function addUpload(batch, localPath, size, relPath, target, extra = {}) {
  const name = path.basename(localPath)
  const rec = baseRecord('upload', batch, name, relPath || name, size, {
    local: { path: localPath, size: Math.round(size), mtimeMs: now() - 86400e3 },
    target: { rootId: target.rootId, relDir: target.relDir || '', parentId: null, driveId: target.driveId || null, replaceFileId: null, fileId: null },
    ...extra,
  })
  transfers.set(rec.id, rec)
  dirty.add(rec.id)
  return rec
}

function googleExport(mime) {
  if (mime === GDOC.doc) return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' }
  if (mime === GDOC.sheet) return { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' }
  if (mime === GDOC.slides) return { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' }
  return null
}

/** Segmentos com aparência de "roubo": alguns terminaram e os maiores restantes foram partidos. */
function stolenSegments(size, fractions) {
  const n = fractions.length
  const part = Math.floor(size / n)
  const segs = []
  for (let i = 0; i < n; i++) {
    const start = i * part
    const end = i === n - 1 ? size - 1 : (i + 1) * part - 1
    segs.push({ start, end, pos: start + Math.floor((end - start + 1) * Math.min(1, fractions[i])) })
  }
  // segmentos terminados roubam metade dos maiores restantes
  for (const s of segs.filter((s) => s.pos > s.end)) {
    const victim = segs.filter((v) => v.pos <= v.end).sort((a, b) => b.end - b.pos - (a.end - a.pos))[0]
    if (!victim || victim.end - victim.pos < 64 * MiB) continue
    const mid = victim.pos + Math.floor((victim.end - victim.pos) / 2)
    const extra = { start: mid, end: victim.end, pos: mid + Math.floor((victim.end - mid) * between(0.1, 0.5)) }
    victim.end = mid - 1
    segs.push(extra)
    void s
  }
  return segs.sort((a, b) => a.start - b.start)
}

function segDone(segs) {
  return segs.reduce((acc, s) => acc + Math.max(0, Math.min(s.pos, s.end + 1) - s.start), 0)
}

function buildTransfers() {
  if (FRESH) return
  const t0 = now()
  const dl = state.settings.downloadDir
  // Lote 1: downloads de brutos (dois rodando com segmentos, alguns na fila, dois concluídos)
  const b1 = makeBatch('download', 'Brutos — Dia 01', t0 - 26 * 60e3)
  const it = (id) => driveItems.get(id)
  const r1 = addDownload(b1, it('f_a001c002'), 'Dia 01/A001_C002_0612XY.mov', vjoin(dl, 'Brutos'), { status: 'running', startedAt: t0 - 9 * 60e3 })
  r1.segments = stolenSegments(r1.size, [1, 0.92, 0.71, 1, 0.58, 0.44, 0.83, 0.3])
  r1.bytesDone = segDone(r1.segments)
  const r2 = addDownload(b1, it('f_a001c003'), 'Dia 01/A001_C003_0612K7.mov', vjoin(dl, 'Brutos'), { status: 'running', startedAt: t0 - 3 * 60e3 })
  r2.segments = stolenSegments(r2.size, [0.36, 0.22, 0.41, 0.18, 0.3, 0.27, 0.12, 0.33])
  r2.bytesDone = segDone(r2.segments)
  addDownload(b1, it('f_a001c004'), 'Dia 01/A001_C004_0612QM.mov', vjoin(dl, 'Brutos'))
  for (const cid of driveItems.get('f_dia01').children.slice(3)) addDownload(b1, it(cid), `Dia 01/${it(cid).name}`, vjoin(dl, 'Brutos'))
  const done1 = addDownload(b1, it('f_boom1'), 'Áudio/Boom_T01.wav', vjoin(dl, 'Brutos'), { status: 'completed', startedAt: t0 - 25 * 60e3, finishedAt: t0 - 22 * 60e3 })
  done1.bytesDone = done1.size
  done1.verify = { state: 'ok', expected: done1.source.md5, actual: done1.source.md5 }
  const done2 = addDownload(b1, it('f_prproj'), 'Projeto.prproj', vjoin(dl, 'Brutos'), { status: 'completed', startedAt: t0 - 24 * 60e3, finishedAt: t0 - 23.5 * 60e3 })
  done2.bytesDone = done2.size
  done2.verify = { state: 'ok', expected: done2.source.md5, actual: done2.source.md5 }

  // Lote 2: upload da entrega (um enviando, um aguardando cota, um que já estava no Drive)
  const ent = vjoin(HOME, 'Movies', 'Documentário Mar Aberto', 'Entrega')
  const b2 = makeBatch('upload', 'Pasta Entrega', t0 - 14 * 60e3)
  const u1 = addUpload(b2, vjoin(ent, 'Master_ProRes4444.mov'), 212 * GB, 'Entrega/Master_ProRes4444.mov', { rootId: 'f_mar', relDir: 'Entrega' }, { status: 'running', startedAt: t0 - 13 * 60e3 })
  u1.bytesDone = Math.round(u1.size * 0.274)
  addUpload(b2, vjoin(ent, 'Master_H264.mp4'), 8.2 * GB, 'Entrega/Master_H264.mp4', { rootId: 'f_mar', relDir: 'Entrega' }, {
    status: 'waiting', retryAt: t0 + 47 * 60e3, attempts: 1,
    error: { message: 'Você atingiu o limite de upload do Google (750 GB por dia). Retomo sozinho mais tarde.', reason: 'uploadLimitExceeded', kind: 'quota', at: t0 - 60e3 },
  })
  const sk = addUpload(b2, vjoin(ent, 'Legendas_PT.srt'), 48 * KB, 'Entrega/Legendas_PT.srt', { rootId: 'f_mar', relDir: 'Entrega' }, { status: 'skipped', note: 'Já estava no Drive', finishedAt: t0 - 13.5 * 60e3 })
  sk.target.fileId = 'f_legendas'

  // Lote 3: avulsos (Doc exportado, um com problema, um pausado, um verificando)
  const b3 = makeBatch('download', '4 arquivos', t0 - 6 * 60e3)
  const doc = addDownload(b3, it('f_roteiro'), '', dl, { status: 'completed', startedAt: t0 - 6 * 60e3, finishedAt: t0 - 5.9 * 60e3 })
  doc.bytesDone = doc.size
  addDownload(b3, it('f_tema'), '', dl, {
    status: 'failed', attempts: 11, startedAt: t0 - 5 * 60e3,
    error: { message: 'O dono bloqueou cópias/downloads deste arquivo.', reason: 'cannotCopyFile', kind: 'fatal', at: t0 - 4.8 * 60e3 },
  })
  const fotos = [...driveItems.values()].find((x) => x.name === 'Contato.jpg')
  const p = addDownload(b3, fotos, '', dl, { status: 'paused', startedAt: t0 - 4 * 60e3 })
  p.segments = stolenSegments(p.size, [0.62])
  p.bytesDone = segDone(p.segments)
  const backup = [...driveItems.values()].find((x) => x.name === 'Backup_Projeto_Antigo.zip')
  const v = addDownload(b3, backup, '', dl, { status: 'verifying', startedAt: t0 - 3 * 60e3 })
  v.bytesDone = v.size
  v.verify = { state: 'running', expected: backup.md5, actual: null }
  v._verifyUntil = t0 + 9000

  if (MANY) {
    const b4 = makeBatch('download', 'Cor — EXR (3.000 quadros)', t0 - 40 * 60e3)
    const destDir = vjoin(dl, 'Cor EXR')
    for (let i = 1; i <= 3000; i++) {
      const name = `MAR_010_v003.${pad(1000 + i, 6)}.exr`
      const item = { id: `f_exr${i}`, name, mimeType: 'image/x-exr', size: Math.round(between(44, 52) * MB), md5: md5Of(name), modifiedTime: new Date(t0 - 86400e3).toISOString(), isGoogleDoc: false }
      const rec = addDownload(b4, item, `EXR/${name}`, destDir)
      if (i <= 420) {
        rec.status = 'completed'
        rec.bytesDone = rec.size
        rec.verify = { state: 'ok', expected: item.md5, actual: item.md5 }
        rec.finishedAt = t0 - (3000 - i) * 400
      }
    }
    // os brutos ficam pausados para os quadros girarem
    r1.status = 'paused'
    r2.status = 'paused'
  }
}

function liveSegments(t) {
  if (t.type !== 'download' || !t.segments?.length) return undefined
  const running = t.status === 'running'
  return t.segments.slice(0, 32).map((s) => ({ start: s.start, end: s.end, pos: Math.min(s.pos, s.end + 1), active: running && s.pos <= s.end, speed: running && s.pos <= s.end ? Math.round(s._speed || 0) : 0 }))
}

function publicTransfer(t) {
  const out = {}
  for (const [k, v] of Object.entries(t)) if (!k.startsWith('_')) out[k] = v
  out.speed = t.status === 'running' ? Math.round(t._speed || 0) : 0
  const remaining = Math.max(0, (t.size || 0) - t.bytesDone)
  out.eta = out.speed > 0 ? Math.ceil(remaining / out.speed) : null
  out.segments = liveSegments(t)
  return out
}

// Velocidade "orgânica": soma de senoides + ruído suave
let noiseDown = 0
let noiseUp = 0
function organic(tSec, base, amp, phase, which) {
  const n = which === 'down' ? (noiseDown += (Math.random() - 0.5) * 0.25, noiseDown *= 0.92) : (noiseUp += (Math.random() - 0.5) * 0.25, noiseUp *= 0.92)
  return Math.max(0, base + amp * (0.55 * Math.sin(tSec / 6.1 + phase) + 0.25 * Math.sin(tSec / 1.7 + phase * 2) + n))
}

const BOOT = now()
let lastTick = now()
let accDown = 0
let accUp = 0
let accSamples = 0
let curDown = 0
let curUp = 0
const history = []

function prefillHistory() {
  const t = now()
  for (let i = 119; i >= 1; i--) {
    const ts = t - i * 1000
    const sec = ts / 1000
    const ramp = Math.min(1, (119 - i) / 14 + 0.05)
    const upRamp = i > 96 ? 0 : Math.min(1, (96 - i) / 10)
    history.push({ t: ts, down: FRESH ? 0 : Math.round(organic(sec, 142 * MB, 22 * MB, 0, 'down') * ramp), up: FRESH ? 0 : Math.round(organic(sec, 47 * MB, 7 * MB, 1.3, 'up') * upRamp) })
  }
}

function startQueued() {
  const s = state.settings
  for (const type of ['download', 'upload']) {
    const max = type === 'download' ? s.maxConcurrentDownloads : s.maxConcurrentUploads
    const all = [...transfers.values()].filter((t) => t.type === type)
    let running = all.filter((t) => t.status === 'running' || t.status === 'verifying').length
    if (running >= max) continue
    const queued = all.filter((t) => t.status === 'queued').sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
    for (const t of queued) {
      if (running >= max) break
      t.status = 'running'
      t.startedAt ??= now()
      t.error = null
      if (type === 'download' && !t.segments.length) {
        const n = Math.max(1, Math.min(s.connectionsPerDownload, Math.ceil(t.size / (16 * MiB))))
        t.segments = stolenSegments(t.size, Array.from({ length: n }, () => 0))
      }
      dirty.add(t.id)
      running++
    }
  }
}

function tick() {
  const t = now()
  const dt = Math.min(1, (t - lastTick) / 1000)
  lastTick = t
  const sec = t / 1000
  const s = state.settings

  for (const tr of transfers.values()) {
    if (tr.status === 'waiting' && tr.retryAt && t >= tr.retryAt) {
      tr.status = 'queued'
      tr.retryAt = null
      dirty.add(tr.id)
    }
    if (tr.status === 'verifying') {
      tr._verifyUntil ??= t + 2500
      if (t >= tr._verifyUntil) {
        tr.status = 'completed'
        tr.finishedAt = t
        tr.verify = { state: 'ok', expected: tr.source?.md5 || null, actual: tr.source?.md5 || null }
        delete tr._verifyUntil
        if (tr.type === 'upload') tr.target.fileId = newId('f')
        dirty.add(tr.id)
        maybeBatchDone(tr.batchId)
      }
    }
  }
  startQueued()

  const runDown = [...transfers.values()].filter((x) => x.type === 'download' && x.status === 'running')
  const runUp = [...transfers.values()].filter((x) => x.type === 'upload' && x.status === 'running')
  let totalDown = runDown.length ? organic(sec, 142 * MB, 24 * MB, 0, 'down') : 0
  let totalUp = runUp.length ? organic(sec, 47 * MB, 8 * MB, 1.3, 'up') : 0
  if (s.bandwidthLimitDown > 0) totalDown = Math.min(totalDown, s.bandwidthLimitDown * between(0.96, 1))
  if (s.bandwidthLimitUp > 0) totalUp = Math.min(totalUp, s.bandwidthLimitUp * between(0.96, 1))

  // o tema bloqueado pelo dono volta a falhar logo depois de "Tentar de novo" (para testar avisos de problema)
  for (const tr of runDown) {
    if (tr.source?.fileId === 'f_tema' && t - (tr._runningSince ??= t) > 1500) {
      tr.status = 'failed'
      tr._speed = 0
      tr._runningSince = null
      tr.attempts = 11
      tr.error = { message: 'O dono bloqueou cópias/downloads deste arquivo.', reason: 'cannotCopyFile', kind: 'fatal', at: t }
      dirty.add(tr.id)
    }
  }

  // downloads: divide a banda entre os arquivos e, dentro de cada um, entre os segmentos ativos
  runDown.filter((tr) => tr.status === 'running').forEach((tr, i) => {
    const weight = 1 + 0.35 * Math.sin(sec / 4 + i)
    const sumW = runDown.reduce((acc, _x, j) => acc + 1 + 0.35 * Math.sin(sec / 4 + j), 0)
    const fileSpeed = (totalDown * weight) / sumW
    tr._speed = fileSpeed
    const active = tr.segments.filter((sg) => sg.pos <= sg.end)
    active.forEach((sg, k) => {
      const segSpeed = (fileSpeed / active.length) * (0.75 + 0.5 * (0.5 + 0.5 * Math.sin(sec * 1.3 + k * 1.7)))
      sg._speed = segSpeed
      sg.pos = Math.min(sg.end + 1, sg.pos + Math.round(segSpeed * dt))
    })
    // roubo: segmento terminou e há outro grande restante
    const finished = tr.segments.filter((sg) => sg.pos > sg.end)
    if (finished.length && tr.segments.length < 32) {
      const victim = tr.segments.filter((v) => v.pos <= v.end).sort((a, b) => b.end - b.pos - (a.end - a.pos))[0]
      const activeCount = tr.segments.filter((v) => v.pos <= v.end).length
      if (victim && activeCount < s.connectionsPerDownload && victim.end - victim.pos > 8 * MiB) {
        const mid = victim.pos + Math.floor((victim.end - victim.pos) / 2)
        tr.segments.push({ start: mid, end: victim.end, pos: mid })
        victim.end = mid - 1
        tr.segments.sort((a, b) => a.start - b.start)
      }
    }
    tr.bytesDone = Math.min(tr.size, segDone(tr.segments))
    tr.updatedAt = t
    if (tr.bytesDone >= tr.size) finishTransfer(tr)
    dirty.add(tr.id)
  })

  runUp.forEach((tr, i) => {
    const fileSpeed = totalUp / runUp.length * (1 + 0.1 * Math.sin(sec + i))
    tr._speed = fileSpeed
    tr.bytesDone = Math.min(tr.size, tr.bytesDone + Math.round(fileSpeed * dt))
    tr.updatedAt = t
    if (tr.bytesDone >= tr.size) finishTransfer(tr)
    dirty.add(tr.id)
  })

  curDown = runDown.reduce((a, x) => a + (x.status === 'running' ? x._speed : 0), 0)
  curUp = runUp.reduce((a, x) => a + (x.status === 'running' ? x._speed : 0), 0)
  accDown += curDown
  accUp += curUp
  accSamples++
}

function finishTransfer(tr) {
  tr._speed = 0
  if (state.settings.verifyChecksums) {
    tr.status = 'verifying'
    tr.verify = { state: 'running', expected: tr.source?.md5 || null, actual: null }
    tr._verifyUntil = now() + Math.min(6000, 800 + tr.size / (900 * MB) * 1000)
  } else {
    tr.status = 'completed'
    tr.finishedAt = now()
    if (tr.type === 'upload') tr.target.fileId = newId('f')
    maybeBatchDone(tr.batchId)
  }
}

function maybeBatchDone(batchId) {
  const items = [...transfers.values()].filter((t) => t.batchId === batchId)
  if (items.length && items.every((t) => ['completed', 'skipped', 'canceled'].includes(t.status))) {
    const b = batches.find((x) => x.id === batchId)
    broadcast('toast', { kind: 'success', message: `“${b?.label || 'Lote'}” terminou: ${items.length} ${items.length === 1 ? 'arquivo' : 'arquivos'}.` })
  }
}

function stats() {
  const all = [...transfers.values()]
  const live = all.filter((t) => t.status !== 'canceled')
  const by = (type) => ({
    speed: Math.round(type === 'download' ? curDown : curUp),
    active: all.filter((t) => t.type === type && (t.status === 'running' || t.status === 'verifying')).length,
    queued: all.filter((t) => t.type === type && t.status === 'queued').length,
  })
  const bytes = live.reduce((a, t) => a + (t.size || 0), 0)
  const doneBytes = live.reduce((a, t) => a + (['completed', 'skipped'].includes(t.status) ? t.size || 0 : t.bytesDone), 0)
  const speedSum = curDown + curUp
  const pending = live.filter((t) => !['completed', 'skipped', 'failed'].includes(t.status)).reduce((a, t) => a + Math.max(0, (t.size || 0) - t.bytesDone), 0)
  const anyActive = all.some((t) => t.status === 'running' || t.status === 'verifying')
  return {
    down: by('download'),
    up: by('upload'),
    totals: { count: live.length, bytes, doneBytes },
    eta: speedSum > 0 ? Math.ceil(pending / speedSum) : null,
    history: history.slice(-120),
    keepAwake: state.settings.keepAwake && anyActive,
  }
}

/** Mesmo formato do VersionChecker (src/version.js). */
function versaoStatus() {
  const plataforma = PLATFORM === 'win32' ? 'windows' : PLATFORM === 'darwin' ? 'mac' : null
  const disponivel = VERSAO > 1 && !!plataforma
  const data = '2026-10-15T12:00:00.000Z'
  return {
    atual: VERSAO > 1 ? { build: VERSAO - 1, commit: 'abc1234', data: '2026-10-01T12:00:00.000Z' } : { build: 0, commit: '', data: null },
    ultima: VERSAO > 1 ? { build: VERSAO, commit: 'def5678', data } : null,
    disponivel,
    nova: disponivel && VERSAO > versaoDispensada,
    dispensada: versaoDispensada,
    plataforma,
    baixarUrl: plataforma ? `https://sobedesce.com/baixar/${plataforma}` : null,
    site: 'https://sobedesce.com',
    verificando: false,
    verificadaEm: VERSAO > 1 ? new Date().toISOString() : null,
    falhou: false,
  }
}

function snapshot() {
  return {
    versao: versaoStatus(),
    app: { name: 'SOBEDESCE', version: '0.1.0', platform: PLATFORM },
    setup: state.setup,
    accounts: state.accounts,
    settings: state.settings,
    transfers: [...transfers.values()].map(publicTransfer),
    batches,
    stats: stats(),
  }
}

// ───────────────────────────── ações ─────────────────────────────

function resolveIds(ids, batchId) {
  if (batchId) return [...transfers.values()].filter((t) => t.batchId === batchId).map((t) => t.id)
  if (ids === 'all') return [...transfers.keys()]
  if (Array.isArray(ids)) return ids.filter((id) => transfers.has(id))
  return []
}

function doAction({ action, ids, batchId }) {
  const list = resolveIds(ids, batchId)
  const removed = []
  for (const id of list) {
    const t = transfers.get(id)
    const st = t.status
    switch (action) {
      case 'pause':
        if (['running', 'queued', 'waiting', 'verifying'].includes(st)) { t.status = 'paused'; t._speed = 0 }
        break
      case 'resume':
        if (st === 'paused' || st === 'waiting') { t.status = 'queued'; t.retryAt = null; t.error = null }
        break
      case 'cancel':
        if (!['completed', 'skipped', 'canceled'].includes(st)) { t.status = 'canceled'; t._speed = 0; t.finishedAt = now(); if (t.type === 'download') { t.segments = []; t.bytesDone = 0 } }
        break
      case 'retry':
        if (['failed', 'canceled', 'waiting', 'paused'].includes(st)) { t.status = 'queued'; t.error = null; t.retryAt = null; t.attempts = 0; t.verify = null }
        break
      case 'remove':
        if (['running', 'verifying'].includes(st)) break
        transfers.delete(id)
        removed.push(id)
        continue
      case 'prioritize':
        t.priority = now()
        if (st === 'paused') t.status = 'queued'
        break
      default:
        throw httpError(400, 'Ação desconhecida.')
    }
    t.updatedAt = now()
    dirty.add(id)
  }
  if (removed.length) {
    removedQueue.push(...removed)
    pruneBatches()
  }
  startQueued()
}

function pruneBatches() {
  const used = new Set([...transfers.values()].map((t) => t.batchId))
  let changed = false
  for (let i = batches.length - 1; i >= 0; i--) if (!used.has(batches[i].id)) { batches.splice(i, 1); changed = true }
  if (changed) broadcast('batches', batches)
}

// ───────────────────────────── comparação ─────────────────────────────

const compareJobs = new Map()

function buildCompareResult(job) {
  seed = 7
  const files = []
  const f = (relDir, name, status, size, extra = {}) => {
    const relPath = relDir ? `${relDir}/${name}` : name
    const rec = { relPath, relDir, name, status }
    if (status !== 'only-drive') rec.local = { size: Math.round(size), mtimeMs: now() - between(1, 30) * 86400e3 }
    if (status === 'synced' || status === 'different') rec.remote = { id: newId('f'), size: Math.round(status === 'different' ? size * between(0.6, 0.98) : size), md5: md5Of(relPath), path: `${job.driveName}/${relPath}` }
    if (status === 'only-drive') rec.remote = { id: newId('f'), size: Math.round(size), md5: md5Of(relPath), path: `${job.driveName}/${relPath}` }
    Object.assign(rec, extra)
    files.push(rec)
  }
  f('', 'Projeto.prproj', 'synced', 184 * MB)
  f('', 'Roteiro_v4.pdf', 'synced', 1.8 * MB)
  f('', 'Notas de produção.txt', 'missing', 14 * KB)
  for (let i = 1; i <= 14; i++) f('Brutos/Dia 01', `A001_C${pad(i, 3)}_0612${(i * 7).toString(36).toUpperCase()}X.mov`, 'synced', between(8, 52) * GB)
  for (let i = 1; i <= 18; i++) f('Brutos/Dia 02', `B002_C${pad(i, 3)}_0613${(i * 31).toString(36).toUpperCase()}.braw`, i <= 11 ? 'synced' : 'missing', between(4, 26) * GB)
  for (let i = 1; i <= 9; i++) f('Brutos/Dia 03', `A003_C${pad(i, 3)}_0614${(i * 13).toString(36).toUpperCase()}Z.mov`, 'missing', between(10, 44) * GB)
  for (let i = 1; i <= 9; i++) f('Brutos/Dia 03/Proxy', `A003_C${pad(i, 3)}_Proxy.mp4`, 'missing', between(0.4, 1.6) * GB)
  for (const n of ['Boom_T01', 'Boom_T02', 'Lapela_Ana_T01', 'Lapela_Ana_T02', 'Lapela_Joao_T01', 'Lapela_Joao_T02']) f('Áudio', `${n}.wav`, 'synced', between(0.8, 2.6) * GB)
  f('Áudio', 'Boom_T03.wav', 'different', 2.2 * GB, { note: 'Tamanho diferente do que está no Drive' })
  for (const n of ['Ambiente_Praia', 'Ambiente_Porto', 'Vento_Falesia', 'Gaivotas', 'Barco_Motor', 'Ondas_Pedras']) f('Áudio/Ambientes', `${n}.wav`, 'synced', between(0.3, 1.2) * GB)
  for (let i = 1; i <= 40; i++) {
    const name = `IMG_${pad(400 + i, 4)}.CR3`
    if (i === 12 || i === 27) f('Fotos', name, 'elsewhere', between(24, 38) * MB, { remote: { id: newId('f'), size: 31 * MB, md5: md5Of(name), path: `${job.driveName}/Fotos Still/Selecionadas/${name}` } })
    else f('Fotos', name, i > 38 ? 'missing' : 'synced', between(24, 38) * MB)
  }
  f('Entrega', 'Master_ProRes4444.mov', 'missing', 212 * GB)
  f('Entrega', 'Master_H264.mp4', 'different', 8.2 * GB, job.mode === 'deep' ? { note: 'Mesmo tamanho, conteúdo diferente (MD5)' } : {})
  f('Entrega', 'Legendas_PT.srt', 'synced', 48 * KB)
  for (const n of ['Master_ProRes4444_v1.mov', 'Master_H264_v1.mp4', 'Legendas_PT_v1.srt']) f('Entrega/Versões antigas', n, 'only-drive', n.endsWith('.srt') ? 46 * KB : between(8, 180) * GB)
  for (const n of ['Tema_Principal_v1.aiff', 'Tema_Principal_v2.aiff', 'Tema_Principal_v3.aiff', 'Vinheta.aiff']) f('Trilhas', n, 'only-drive', between(200, 620) * MB)

  const dirs = new Set([''])
  for (const x of files) {
    const parts = x.relDir ? x.relDir.split('/') : []
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  dirs.add('Lixo')
  const folders = [...dirs].sort((a, b) => a.localeCompare(b, 'pt-BR')).map((relDir) => {
    const sub = files.filter((x) => relDir === '' || x.relDir === relDir || x.relDir.startsWith(relDir + '/'))
    const sum = (st) => sub.filter((x) => x.status === st)
    const synced = sum('synced').length + sum('elsewhere').length
    const missing = sum('missing').length
    const different = sum('different').length
    const onlyDrive = sum('only-drive').length
    const state = sub.length === 0 ? 'empty' : missing + different === 0 ? 'complete' : synced === 0 && onlyDrive === 0 ? 'missing' : 'partial'
    return {
      relDir,
      name: relDir === '' ? job.localName : relDir.split('/').pop(),
      depth: relDir === '' ? 0 : relDir.split('/').length,
      files: sub.length,
      bytes: sub.reduce((a, x) => a + (x.local?.size ?? x.remote?.size ?? 0), 0),
      synced,
      missing,
      missingBytes: sum('missing').reduce((a, x) => a + x.local.size, 0),
      different,
      onlyDrive,
      state,
    }
  })
  const by = (st) => files.filter((x) => x.status === st)
  const bytesOf = (list, side = 'local') => list.reduce((a, x) => a + (x[side]?.size || 0), 0)
  return {
    id: job.id,
    createdAt: new Date().toISOString(),
    mode: job.mode,
    localPath: job.localPath,
    drive: { folderId: job.driveFolderId, name: job.driveName, path: job.drivePathStr },
    summary: {
      files: files.length,
      bytes: files.reduce((a, x) => a + (x.local?.size ?? x.remote?.size ?? 0), 0),
      synced: by('synced').length,
      missing: by('missing').length,
      missingBytes: bytesOf(by('missing')),
      different: by('different').length,
      differentBytes: bytesOf(by('different')),
      onlyDrive: by('only-drive').length,
      onlyDriveBytes: bytesOf(by('only-drive'), 'remote'),
      elsewhere: by('elsewhere').length,
    },
    folders,
    files,
  }
}

function startCompare(body) {
  const { localPath, driveFolderId, mode = 'quick' } = body || {}
  if (!localPath) throw httpError(400, 'Escolha a pasta do computador.')
  if (!driveFolderId) throw httpError(400, 'Escolha a pasta do Drive.')
  const folderItem = driveItems.get(driveFolderId)
  if (!folderItem) throw httpError(404, 'Não achei essa pasta no Drive.')
  const id = newId('cmp')
  const job = {
    id, status: 'running', mode: mode === 'deep' ? 'deep' : 'quick', localPath, driveFolderId, driveName: folderItem.name,
    drivePathStr: drivePath(driveFolderId).map((p) => p.name).join('/'), localName: path.basename(localPath) || localPath,
    progress: { phase: 'local', done: 0, total: 0, current: '' }, result: null, error: null, startedAt: now(),
  }
  compareJobs.set(id, job)
  const phases = [
    { phase: 'local', total: 131, ms: 1800 },
    { phase: 'drive', total: 127, ms: 1800 },
    ...(job.mode === 'deep' ? [{ phase: 'hash', total: 131, ms: 3600 }] : []),
    { phase: 'match', total: 131, ms: 700 },
  ]
  const names = ['Brutos/Dia 01/A001_C004_0612QM.mov', 'Brutos/Dia 02/B002_C011_0613B5.braw', 'Áudio/Boom_T02.wav', 'Fotos/IMG_0417.CR3', 'Entrega/Master_ProRes4444.mov', 'Áudio/Ambientes/Gaivotas.wav']
  let pi = 0
  let phaseStart = now()
  const failing = /erro/i.test(localPath)
  const timer = setInterval(() => {
    const ph = phases[pi]
    const frac = Math.min(1, (now() - phaseStart) / ph.ms)
    job.progress = { phase: ph.phase, done: Math.round(ph.total * frac), total: ph.total, current: names[Math.floor(now() / 230) % names.length] }
    if (failing && ph.phase === 'drive' && frac > 0.4) {
      clearInterval(timer)
      job.status = 'error'
      job.error = 'Não consegui ler a pasta do computador: sem permissão em “Brutos/Dia 03”.'
      broadcast('compare', { jobId: id, status: job.status, progress: job.progress, error: job.error })
      return
    }
    if (frac >= 1) {
      pi++
      phaseStart = now()
      if (pi >= phases.length) {
        clearInterval(timer)
        job.result = buildCompareResult(job)
        job.status = 'done'
        job.progress = { phase: 'match', done: ph.total, total: ph.total, current: '' }
      }
    }
    broadcast('compare', { jobId: id, status: job.status, progress: job.progress, ...(job.error ? { error: job.error } : {}) })
  }, 150)
  return { jobId: id }
}

function compareUpload(job, body) {
  if (!job.result) throw httpError(409, 'A comparação ainda não terminou.')
  const statuses = Array.isArray(body?.statuses) && body.statuses.length ? body.statuses : ['missing']
  const relDirs = Array.isArray(body?.relDirs) && body.relDirs.length ? body.relDirs : null
  const pick = job.result.files.filter((x) => statuses.includes(x.status) && (!relDirs || relDirs.some((d) => d === '' || x.relDir === d || x.relDir.startsWith(d + '/'))))
  if (!pick.length) throw httpError(400, 'Nada para subir aqui.')
  const label = relDirs?.length === 1 && relDirs[0] ? `Faltando em ${relDirs[0].split('/').pop()}` : `Faltando em ${job.localName}`
  const b = makeBatch('upload', label)
  let bytes = 0
  for (const x of pick) {
    addUpload(b, vjoin(job.localPath, x.relPath), x.local.size, x.relPath, { rootId: job.driveFolderId, relDir: x.relDir })
    bytes += x.local.size
  }
  broadcast('batches', batches)
  startQueued()
  return { batch: b, count: pick.length, bytes }
}

function compareDownload(job, body) {
  if (!job.result) throw httpError(409, 'A comparação ainda não terminou.')
  const relDirs = Array.isArray(body?.relDirs) && body.relDirs.length ? body.relDirs : null
  const pick = job.result.files.filter((x) => x.status === 'only-drive' && (!relDirs || relDirs.some((d) => d === '' || x.relDir === d || x.relDir.startsWith(d + '/'))))
  if (!pick.length) throw httpError(400, 'Nada só no Drive aqui.')
  const b = makeBatch('download', `Só no Drive — ${job.driveName}`)
  let bytes = 0
  for (const x of pick) {
    const item = { id: x.remote.id, name: x.name, mimeType: 'application/octet-stream', size: x.remote.size, md5: x.remote.md5, modifiedTime: new Date().toISOString(), isGoogleDoc: false }
    addDownload(b, item, x.relPath, job.localPath)
    bytes += x.remote.size
  }
  broadcast('batches', batches)
  startQueued()
  return { batch: b, count: pick.length, bytes }
}

// ───────────────────────────── local ─────────────────────────────

async function localRoots() {
  const roots = []
  const add = async (name, p, kind) => {
    try {
      if ((await fsp.stat(toReal(p))).isDirectory()) roots.push({ name, path: p, kind })
    } catch {}
  }
  await add('Início', HOME, 'home')
  await add('Mesa', vjoin(HOME, 'Desktop'), 'desktop')
  await add('Downloads', vjoin(HOME, 'Downloads'), 'downloads')
  await add('Documentos', vjoin(HOME, 'Documents'), 'documents')
  await add('Filmes', vjoin(HOME, 'Movies'), 'movies')
  const volDirs = VOLUMES ? [VOLUMES] : ['/Volumes', `/media/${os.userInfo().username}`, '/mnt']
  for (const dir of volDirs) {
    try {
      for (const d of await fsp.readdir(toReal(dir), { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith('.')) await add(d.name, vjoin(dir, d.name), 'volume')
    } catch {}
  }
  return { roots, home: HOME, sep: DEMO_DIR ? '/' : path.sep }
}

async function localList(p, hidden) {
  const abs = DEMO_DIR ? path.posix.resolve('/', p || HOME) : path.resolve(p || HOME)
  let dirents
  try {
    dirents = await fsp.readdir(toReal(abs), { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') throw httpError(404, 'Essa pasta não existe.')
    if (err.code === 'ENOTDIR') throw httpError(400, 'Isso é um arquivo, não uma pasta.')
    if (err.code === 'EACCES' || err.code === 'EPERM') throw httpError(403, 'Sem permissão para abrir essa pasta.')
    throw httpError(500, 'Não consegui abrir essa pasta.')
  }
  const entries = []
  await Promise.all(dirents.map(async (d) => {
    if (!hidden && d.name.startsWith('.')) return
    if (d.isSymbolicLink()) return
    const full = vjoin(abs, d.name)
    try {
      const st = await fsp.stat(toReal(full))
      entries.push({ name: d.name.normalize('NFC'), path: full, isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtimeMs: st.mtimeMs })
    } catch {}
  }))
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' }) : a.isDir ? -1 : 1))
  const dirname = DEMO_DIR ? path.posix.dirname : path.dirname
  const parent = dirname(abs) === abs ? null : dirname(abs)
  return { path: abs, parent, entries }
}

async function scanPaths(paths, limit = 5000) {
  const out = []
  const walk = async (p, base) => {
    if (out.length >= limit) return
    let st
    try {
      st = await fsp.lstat(toReal(p))
    } catch {
      return
    }
    if (st.isSymbolicLink()) return
    const name = path.basename(p)
    if (name === '.DS_Store' || name.startsWith('._')) return
    if (st.isDirectory()) {
      let list = []
      try {
        list = await fsp.readdir(toReal(p))
      } catch {
        return
      }
      for (const c of list.sort()) await walk(vjoin(p, c), base ? `${base}/${c}` : c)
    } else out.push({ path: p, size: st.size, relPath: base })
  }
  for (const p of paths) {
    const abs = DEMO_DIR ? path.posix.resolve('/', p) : path.resolve(p)
    try {
      await fsp.stat(toReal(abs))
    } catch {
      continue
    }
    await walk(abs, path.basename(abs))
  }
  return out
}

// ───────────────────────────── HTTP ─────────────────────────────

function httpError(status, message) {
  const e = new Error(message)
  e.status = status
  return e
}

const sseClients = new Set()
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) res.write(payload)
}

function sendJSON(res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(json)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, 'JSON inválido.')
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' }

/** Ponte falsa do Electron (só com STUB_DESKTOP=1). Ajustes para testes via window.__stub*. */
function fakeBridgeScript() {
  const home = JSON.stringify(HOME)
  const sep = DEMO_DIR ? '/' : path.sep
  return `// Ponte falsa do app de desktop (servidor de simulação). O Electron de verdade expõe isto pelo preload.
(function () {
  var HOME = ${home}, SEP = ${JSON.stringify(sep)}
  var join = function () { return Array.prototype.slice.call(arguments).join(SEP).replace(/\\/+/g, '/') }
  var project = join(HOME, 'Movies', 'Documentário Mar Aberto')
  var log = function () { console.info.apply(console, ['[desktop falso]'].concat([].slice.call(arguments))) }
  window.__stubNotes = []; window.__stubProgress = []; window.__stubExternal = []; window.__stubRevealed = []
  window.sobedesce = {
    desktop: true,
    platform: ${JSON.stringify(PLATFORM)},
    pickFolder: function (o) {
      log('pickFolder', o && o.title, o && o.defaultPath)
      if (window.__stubPickerThrows) return Promise.reject(new Error('diálogo indisponível'))
      return new Promise(function (r) { setTimeout(function () { r(window.__stubPickFolder !== undefined ? window.__stubPickFolder : project) }, 120) })
    },
    pickPaths: function (o) {
      log('pickPaths', o && o.title, o && o.kind)
      if (window.__stubPickerThrows) return Promise.reject(new Error('diálogo indisponível'))
      var list = window.__stubPickPaths || (o && o.kind === 'files' ? [join(project, 'Projeto.prproj'), join(project, 'Roteiro_v4.pdf')] : [join(project, 'Entrega'), join(project, 'Projeto.prproj')])
      return new Promise(function (r) { setTimeout(function () { r(list) }, 120) })
    },
    pathForFile: function (file) {
      var root = window.__stubDropRoot || project
      return file && (file.__path || join(root, file.name))
    },
    setProgress: function (fraction, active) { window.__stubProgress.push({ t: Date.now(), fraction: fraction, active: active }) },
    notify: function (title, body) { log('notify', title, '—', body); window.__stubNotes.push({ title: title, body: body }) },
    openExternal: function (url) {
      log('openExternal', url); window.__stubExternal.push(url)
      // simula a pessoa terminando o login no navegador do sistema
      if (String(url).indexOf('/api/auth/start') >= 0) setTimeout(function () { fetch(url).catch(function () {}) }, window.__stubOAuthDelay || 2500)
      return Promise.resolve()
    },
    reveal: function (p) { log('reveal', p); window.__stubRevealed.push(p) },
  }
})()
`
}

async function serveStatic(req, res, pathname) {
  let file
  if (DESKTOP && pathname === '/__stub/desktop.js') {
    res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' })
    return res.end(fakeBridgeScript())
  }
  if (pathname === '/vendor/preact-htm.js') file = VENDOR
  else {
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
    file = path.join(PUBLIC, path.normalize(rel))
    if (!file.startsWith(PUBLIC)) return sendJSON(res, 403, { ok: false, error: 'Proibido.' })
  }
  const withBridge = (buf) => {
    // desktop falso: a ponte precisa existir antes de qualquer script da página (como o preload)
    if (!DESKTOP) return buf
    return Buffer.from(buf.toString('utf8').replace('<script src="/lib/boot.js"></script>', '<script src="/__stub/desktop.js"></script>\n    <script src="/lib/boot.js"></script>'))
  }
  try {
    let data = await fsp.readFile(file)
    if (file.endsWith('index.html')) data = withBridge(data)
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(data)
  } catch {
    // rotas da interface (hash) caem no index
    if (!path.extname(pathname)) {
      const data = withBridge(await fsp.readFile(path.join(PUBLIC, 'index.html')))
      res.writeHead(200, { 'content-type': TYPES['.html'] })
      return res.end(data)
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Não encontrado')
  }
}

const CALLBACK_HTML = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Conta conectada — SOBEDESCE</title>
<meta http-equiv="refresh" content="1;url=/#/transferencias">
<style>body{font:15px -apple-system,BlinkMacSystemFont,"Inter",sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#FBFBFD;color:#1D1D1F}
@media (prefers-color-scheme:dark){body{background:#0B0B0C;color:#F5F5F7}}h1{font-size:22px;letter-spacing:-.02em;margin:0 0 6px}p{margin:0;color:#6E6E73}</style></head>
<body><div><h1>Conta conectada</h1><p>Voltando para o SOBEDESCE…</p></div></body></html>`

// No desktop o login acontece no navegador do sistema: a página só avisa para voltar ao app.
const CALLBACK_DESKTOP_HTML = CALLBACK_HTML.replace('<meta http-equiv="refresh" content="1;url=/#/transferencias">\n', '').replace('Voltando para o SOBEDESCE…', 'Pode voltar para o SOBEDESCE.')

async function route(req, res, url) {
  const { pathname, searchParams: q } = url
  const method = req.method
  const parts = pathname.split('/').filter(Boolean)
  const needsSetup = () => {
    if (!state.setup.configured) throw httpError(409, 'Configure a chave do Google primeiro.')
  }
  const needsAccount = (acc) => {
    if (!state.accounts.find((a) => a.id === acc)) throw httpError(404, 'Conta não encontrada. Conecte de novo.')
  }

  // OAuth (navegação de página inteira, não JSON)
  if (method === 'GET' && pathname === '/api/auth/start') {
    if (!state.setup.configured) {
      res.writeHead(302, { location: '/#/inicio' })
      return res.end()
    }
    res.writeHead(302, { location: '/oauth/callback?code=stub-code&state=stub-state' })
    return res.end()
  }
  if (method === 'GET' && pathname === '/oauth/callback') {
    const n = state.accounts.length
    const acc = n === 0
      ? { id: 'acc_victor', email: 'victor@exemplo.com', name: 'Victor', photoUrl: null, addedAt: now(), status: 'ok' }
      : { id: newId('acc'), email: `producao${n + 1}@exemplo.com`, name: `Produção ${n + 1}`, photoUrl: null, addedAt: now(), status: 'ok' }
    state.accounts.push(acc)
    broadcast('accounts', state.accounts)
    res.writeHead(200, { 'content-type': TYPES['.html'] })
    return res.end(DESKTOP ? CALLBACK_DESKTOP_HTML : CALLBACK_HTML)
  }

  if (method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(`event: hello\ndata: ${JSON.stringify(snapshot())}\n\n`)
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  if (method === 'GET' && pathname === '/api/state') return { ...snapshot() }

  if (method === 'GET' && pathname === '/api/versao') return { versao: versaoStatus() }
  if (method === 'POST' && pathname === '/api/versao/verificar') return { versao: versaoStatus() }
  if (method === 'POST' && pathname === '/api/versao/depois') {
    if (!VERSAO) throw httpError(409, 'Não há versão nova para deixar para depois.')
    versaoDispensada = VERSAO
    broadcast('versao', versaoStatus())
    return { versao: versaoStatus() }
  }

  if (method === 'POST' && pathname === '/api/setup/credentials') {
    const body = await readBody(req)
    let clientId
    let clientSecret
    if (typeof body.json === 'string') {
      let parsed
      try {
        parsed = JSON.parse(body.json)
      } catch {
        throw httpError(400, 'Esse arquivo não é um JSON válido. Baixe de novo no Console do Google.')
      }
      const inner = parsed.installed || parsed.web || parsed
      clientId = inner.client_id || inner.clientId
      clientSecret = inner.client_secret || inner.clientSecret
      if (parsed.web) throw httpError(400, 'Essa chave é do tipo “Aplicativo da Web”. Crie um cliente do tipo “App para computador”.')
    } else {
      clientId = body.clientId
      clientSecret = body.clientSecret
    }
    if (!clientId || !/\.apps\.googleusercontent\.com$/.test(String(clientId).trim())) throw httpError(400, 'Esse Client ID não parece certo. Ele termina em “.apps.googleusercontent.com”.')
    if (!clientSecret || String(clientSecret).trim().length < 8) throw httpError(400, 'Falta o Client secret.')
    state.setup = { configured: true, clientIdHint: `${String(clientId).slice(0, 4)}…apps.googleusercontent.com` }
    return { setup: state.setup }
  }

  if (method === 'DELETE' && parts[0] === 'api' && parts[1] === 'accounts' && parts[2]) {
    const id = decodeURIComponent(parts[2])
    needsAccount(id)
    state.accounts = state.accounts.filter((a) => a.id !== id)
    broadcast('accounts', state.accounts)
    return { accounts: state.accounts }
  }

  if (parts[0] === 'api' && parts[1] === 'drive' && parts[2]) {
    needsSetup()
    const acc = decodeURIComponent(parts[2])
    needsAccount(acc)
    const account = state.accounts.find((a) => a.id === acc)
    await new Promise((r) => setTimeout(r, 120 + Math.random() * 160)) // latência de rede
    const what = parts[3]
    if (method === 'GET' && what === 'about') {
      return { about: { user: { email: account.email, name: account.name, photoUrl: null, permissionId: account.id }, quota: { limit: 2e12, usage: 1.384e12, usageInDrive: 1.21e12 } } }
    }
    if (method === 'GET' && what === 'drives') return { drives: sharedDrives }
    // Tamanho das pastas (src/server/tamanho.js): a conta já sai pronta, somando a árvore inventada.
    if (what === 'tamanho') {
      const conta = (id) => {
        const f = driveItems.get(id)
        if (!f || !f.isFolder) return null
        const tudo = walkDrive(id)
        const pastas = (fid) => driveItems.get(fid).children.reduce((n, c) => n + (driveItems.get(c).isFolder ? 1 + pastas(c) : 0), 0)
        const docs = tudo.filter((x) => x.item.isGoogleDoc).length
        return { folderId: id, status: 'done', bytes: tudo.reduce((t, x) => t + (x.item.size || 0), 0), files: tudo.length, folders: pastas(id), docs, shortcuts: 0, pending: 0, startedAt: now(), finishedAt: now(), error: null }
      }
      if (method === 'GET') return { tamanhos: Object.fromEntries((q.get('ids') || '').split(',').filter(Boolean).map((id) => [id, conta(id)])) }
      const body = await readBody(req)
      return { tamanho: method === 'DELETE' ? null : conta(body.folderId === 'root' ? 'root' : body.folderId) }
    }
    if (method === 'GET' && what === 'compartilhados') {
      return { items: sortItems([...driveItems.values()].filter((it) => it.compartilhado).map(publicItem)) }
    }
    if (method === 'POST' && what === 'renomear') {
      const body = await readBody(req)
      const it = driveItems.get(body.id)
      if (!it) throw httpError(404, 'Não achei este item: foi apagado ou esta conta perdeu o acesso.')
      if (soLeitura(it)) throw httpError(403, 'Sua conta não pode renomear este item. Peça a quem é dono.')
      const name = String(body.name || '').trim()
      if (!name) throw httpError(400, 'Dê um nome.')
      it.name = name
      return { item: publicItem(it) }
    }
    if (method === 'POST' && what === 'mover') {
      const body = await readBody(req)
      const dest = driveItems.get(body.destId)
      if (!dest || !dest.isFolder) throw httpError(400, 'Escolha a pasta de destino.')
      const movidos = []
      const ja = []
      const recusados = []
      for (const id of body.ids || []) {
        const it = driveItems.get(id)
        let erro = null
        if (!it) erro = [404, 'Não achei o item ou a pasta de destino: foi apagado ou esta conta perdeu o acesso.']
        else if (it.parents[0] === dest.id) {
          ja.push(id)
          continue
        } else if (drivePath(dest.id).some((c) => c.id === it.id)) erro = [400, 'Não dá para mover uma pasta para dentro dela mesma.']
        else if (!it.parents.length) erro = [403, 'Este item foi compartilhado com você e só quem é dono pode mudar de lugar. Copie para o seu Drive, se precisar.']
        else if (soLeitura(it) || soLeitura(dest)) erro = [403, 'Sua conta não pode mover este item para lá. Precisa poder editar o item e a pasta de destino.']
        if (erro) {
          recusados.push({ id, status: erro[0], error: erro[1] })
          continue
        }
        const old = driveItems.get(it.parents[0])
        if (old) old.children = old.children.filter((c) => c !== it.id)
        it.parents = [dest.id]
        dest.children.push(it.id)
        movidos.push(id)
      }
      if (!movidos.length && !ja.length && recusados.length) throw httpError(recusados[0].status, recusados[0].error)
      return { movidos, ja, recusados }
    }
    if (method === 'GET' && what === 'list') {
      const folderId = q.get('folderId') || 'root'
      const f = driveItems.get(folderId)
      if (!f || !f.isFolder) throw httpError(404, 'Pasta não encontrada no Drive.')
      return { folder: publicItem(f), path: drivePath(folderId), items: sortItems(f.children.map((id) => publicItem(driveItems.get(id)))) }
    }
    if (method === 'GET' && what === 'search') {
      const term = (q.get('q') || '').trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
      if (!term) return { items: [] }
      const items = [...driveItems.values()]
        .filter((it) => it.parents.length && it.name.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').includes(term))
        .slice(0, 200)
        .map(publicItem)
      return { items: sortItems(items) }
    }
    if (method === 'POST' && what === 'folders') {
      const body = await readBody(req)
      const name = String(body.name || '').trim()
      if (!name) throw httpError(400, 'Dê um nome para a pasta.')
      const parent = driveItems.get(body.parentId || 'root')
      if (!parent || !parent.isFolder) throw httpError(404, 'Pasta de destino não encontrada.')
      const item = folder(parent.id, name, { ageMs: 0 })
      return { item: publicItem(item) }
    }
  }

  if (method === 'GET' && pathname === '/api/local/roots') return localRoots()
  if (method === 'GET' && pathname === '/api/local/list') return localList(q.get('path'), ['1', 'true'].includes(q.get('hidden')))

  if (method === 'POST' && pathname === '/api/transfers/download') {
    const body = await readBody(req)
    needsAccount(body.accountId)
    const items = Array.isArray(body.items) ? body.items : []
    if (!items.length) throw httpError(400, 'Escolha pelo menos um item.')
    const destDir = body.destDir || state.settings.downloadDir
    const label = items.length === 1 ? (items[0].isFolder ? `Pasta ${items[0].name}` : items[0].name) : `${items.length} itens`
    const b = makeBatch('download', label)
    let count = 0
    let bytes = 0
    const skipped = []
    for (const raw of items) {
      const item = driveItems.get(raw.id) || raw
      if (item.isFolder) {
        for (const { item: c, relPath } of walkDrive(item.id)) {
          if (c.isGoogleDoc && !googleExport(c.mimeType)) { skipped.push({ name: c.name, reason: 'Tipo do Google que não dá para baixar' }); continue }
          const r = addDownload(b, c, `${item.name}/${relPath}`, destDir)
          count++
          bytes += r.size || 0
        }
      } else if (item.isGoogleDoc && !googleExport(item.mimeType)) {
        skipped.push({ name: item.name, reason: 'Tipo do Google que não dá para baixar' })
      } else {
        const r = addDownload(b, item, '', destDir)
        count++
        bytes += r.size || 0
      }
    }
    if (!count) pruneBatches()
    broadcast('batches', batches)
    startQueued()
    return { batch: b, count, bytes, skipped }
  }

  if (method === 'POST' && pathname === '/api/transfers/upload') {
    const body = await readBody(req)
    needsAccount(body.accountId)
    const paths = Array.isArray(body.paths) ? body.paths : []
    if (!paths.length) throw httpError(400, 'Escolha pelo menos um arquivo ou pasta.')
    if (!body.destFolderId) throw httpError(400, 'Escolha a pasta de destino no Drive.')
    const files = await scanPaths(paths)
    if (!files.length) throw httpError(400, 'Não achei arquivos para enviar aí.')
    const label = paths.length === 1 ? `Pasta ${path.basename(paths[0])}` : `${files.length} arquivos`
    const b = makeBatch('upload', label)
    let bytes = 0
    for (const f of files) {
      const relDir = f.relPath.includes('/') ? f.relPath.split('/').slice(0, -1).join('/') : ''
      addUpload(b, f.path, f.size, f.relPath, { rootId: body.destFolderId, relDir, driveId: body.driveId || null })
      bytes += f.size
    }
    broadcast('batches', batches)
    startQueued()
    return { batch: b, count: files.length, bytes, skipped: [] }
  }

  if (method === 'POST' && pathname === '/api/transfers/action') {
    const body = await readBody(req)
    doAction(body)
    return {}
  }

  if (method === 'POST' && pathname === '/api/transfers/clear') {
    for (const [id, t] of transfers) if (['completed', 'skipped', 'canceled'].includes(t.status)) { transfers.delete(id); removedQueue.push(id) }
    pruneBatches()
    return {}
  }

  if (pathname === '/api/settings') {
    if (method === 'GET') return { settings: state.settings }
    if (method === 'PATCH') {
      const body = await readBody(req)
      state.settings = validateSettings(body)
      broadcast('settings', state.settings)
      return { settings: state.settings }
    }
  }

  if (method === 'POST' && pathname === '/api/compare') {
    const body = await readBody(req)
    needsAccount(body.accountId)
    return startCompare(body)
  }
  if (parts[0] === 'api' && parts[1] === 'compare' && parts[2]) {
    const job = compareJobs.get(parts[2])
    if (!job) throw httpError(404, 'Essa comparação não existe mais.')
    if (method === 'GET' && parts.length === 3) return { status: job.status, progress: job.progress, ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}) }
    if (method === 'POST' && parts[3] === 'upload') return compareUpload(job, await readBody(req))
    if (method === 'POST' && parts[3] === 'download') return compareDownload(job, await readBody(req))
  }

  if (method === 'POST' && pathname === '/api/reveal') {
    const body = await readBody(req)
    if (!body.path) throw httpError(400, 'Caminho vazio.')
    log('revelar no Finder:', body.path)
    return {}
  }

  if (pathname.startsWith('/api/')) throw httpError(404, 'Rota não encontrada.')
  return serveStatic(req, res, pathname)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  try {
    const host = req.headers.host
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) throw httpError(403, 'Host não permitido.')
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (!String(req.headers['content-type'] || '').includes('application/json')) throw httpError(415, 'Requisição recusada: falta Content-Type: application/json.')
      const origin = req.headers.origin
      if (origin && origin !== `http://${host}`) throw httpError(403, 'Origem não permitida.')
    }
    const out = await route(req, res, url)
    if (out && !res.headersSent) sendJSON(res, 200, { ok: true, ...out })
  } catch (err) {
    if (!err.status) console.error(err)
    if (!res.headersSent) sendJSON(res, err.status || 500, { ok: false, error: err.status ? err.message : 'Erro interno do servidor falso.' })
  }
})

// ───────────────────────────── início ─────────────────────────────

buildDemoDir()
state.settings.downloadDir = vjoin(HOME, 'Downloads')
buildDrive()
seed = 99
buildTransfers()
prefillHistory()

setInterval(tick, 250)
setInterval(() => {
  // 4×/s: transferências alteradas (+ removidas)
  if (removedQueue.length) broadcast('removed', removedQueue.splice(0))
  if (dirty.size) {
    const list = []
    for (const id of dirty) if (transfers.has(id)) list.push(publicTransfer(transfers.get(id)))
    dirty.clear()
    if (list.length) broadcast('transfers', list)
  }
}, 250)
setInterval(() => {
  // 1 ponto por segundo no histórico
  const n = Math.max(1, accSamples)
  history.push({ t: now(), down: Math.round(accDown / n), up: Math.round(accUp / n) })
  if (history.length > 120) history.splice(0, history.length - 120)
  accDown = accUp = accSamples = 0
}, 1000)
setInterval(() => broadcast('stats', stats()), 500)
setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n')
}, 15000)

server.listen(PORT, '127.0.0.1', () => {
  console.log(`SOBEDESCE (servidor falso) em http://127.0.0.1:${PORT}${FRESH ? '  [instalação nova]' : ''}${MANY ? '  [3.000 quadros]' : ''}`)
  void BOOT
})
