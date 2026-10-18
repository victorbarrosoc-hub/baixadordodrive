// Planejador: transforma o que o usuário escolheu (itens do Drive, caminhos locais, resultado do comparador)
// em registros de transferência prontos para a fila (contrato em docs/ARCHITECTURE.md, "engine/planner.js").
//
// Por que é assim:
//  - O Drive aceita dois "Take1.mov" na mesma pasta; o disco não. Cada pasta de destino tem o seu conjunto de
//    nomes já usados no lote, e o repetido vira "Take1 (2).mov" — nunca dois registros no mesmo arquivo.
//  - Um ".sobedesce-part" que já está na pasta é de outro download (talvez pausado): o nome conta como ocupado,
//    senão dois downloads escreveriam no mesmo temporário.
//  - Nada aqui baixa ou sobe bytes: só lê metadados (Drive) e lista pastas (disco).
import fs from 'node:fs/promises'
import path from 'node:path'
import { FOLDER_MIME, GOOGLE_EXPORTS } from '../google/drive.js'
import { classifyError } from '../google/errors.js'
import { scanLocal } from '../local/scan.js'
import { expandHome } from '../local/fsbrowse.js'
import { abortError, isAbortError } from '../util/backoff.js'
import { newId } from '../util/ids.js'
import { PART_SUFFIX, isJunkFile, joinRel, safeLocalName, splitRel, toNFC } from '../util/paths.js'
import { sortByPath } from './compare.js'

/** Maior arquivo que o Drive aceita (5 TB). */
export const MAX_UPLOAD_SIZE = 5 * 1024 ** 4
/** Limite diário de upload do Google por conta (750 GB). */
const DAILY_UPLOAD_LIMIT = 750 * 1e9
const CONFLICTS = new Set(['skip', 'rename', 'overwrite'])

const NOTE = {
  exported: ext => `Exportado como ${ext}`,
  driveDup: (from, to) => `O Drive tem mais de um "${from}" nesta pasta: este vai como "${to}".`,
  localExists: (from, to) => `Já existia "${from}" no computador: vai como "${to}".`,
  reserved: (from, to) => `Outra transferência já vai gravar "${from}": esta vai como "${to}".`,
  overwrite: from => `Vai substituir o "${from}" que já está no computador.`,
  topDup: (from, to) => `Outro item com o nome "${from}" foi escolhido: este vai como "${to}".`,
  replace: 'Substitui a versão diferente que está no Drive (o Google guarda a anterior no histórico).',
  folderCase: rel => `Vai para a pasta "${rel}", que já existe no Drive.`,
}

const SKIP = {
  sameLocal: 'Já existe no computador (mesmo tamanho).',
  existsLocal: 'Já existe no computador.',
  blocked: 'O dono bloqueou downloads deste arquivo.',
  gappsOther: 'Este tipo de arquivo do Google (formulário, site, mapa…) não pode ser baixado.',
  danglingShortcut: 'O atalho aponta para um arquivo que não existe mais (ou que sua conta não vê).',
  folderShortcut: 'É um atalho para outra pasta: escolha a pasta original para baixar.',
  notFile: 'Este item do Drive não é um arquivo que dá para baixar.',
  tooBig: 'Maior que o limite do Google Drive (5 TB por arquivo).',
  gone: 'Não achei no Drive: foi apagado, movido ou deixou de ser compartilhado com você.',
}

// ─────────── ajudantes ───────────

function badRequest(message) {
  const err = new Error(message)
  err.status = 400
  return err
}

/** Tamanho legível em unidades decimais (como a interface mostra). */
function formatBytes(n) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = Math.max(0, Number(n) || 0)
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${v.toLocaleString('pt-BR', { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`
}

function plural(n, one, many) {
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`
}

/** 'Pasta "Brutos"' / '"A001.mov"' / '3 arquivos' / '2 pastas e 3 arquivos'. */
function selectionLabel(folders, files) {
  if (folders.length === 1 && files.length === 0) return `Pasta "${folders[0]}"`
  if (folders.length === 0 && files.length === 1) return `"${files[0]}"`
  const parts = []
  if (folders.length) parts.push(plural(folders.length, 'pasta', 'pastas'))
  if (files.length) parts.push(plural(files.length, 'arquivo', 'arquivos'))
  return parts.join(' e ') || 'Nada'
}

/** Mesmo formato do uniqueName de util/paths.js ('a (2).mov'), mas consultando uma função: O(1) por tentativa. */
function nextFreeName(name, isTaken) {
  if (!isTaken(name.toLowerCase())) return name
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`
    if (!isTaken(candidate.toLowerCase())) return candidate
  }
}

function pathKey(p) {
  return toNFC(path.resolve(p)).toLowerCase()
}

function resolveDir(dir) {
  const s = String(dir)
  return s.startsWith('~') ? expandHome(s) : path.resolve(s)
}

function newBatch(id, type, label, accountId, now) {
  return { id: id || newId('b'), type, label, createdAt: now, accountId }
}

/** Registro com todos os campos do contrato (TransferRecord) já preenchidos. */
function baseRecord(type, { accountId, batchId, name, relPath, size, now }) {
  return {
    id: newId('t'),
    type,
    accountId,
    batchId,
    status: 'queued',
    name,
    relPath,
    size,
    bytesDone: 0,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    error: null,
    retryAt: null,
    attempts: 0,
    verify: null,
    note: null,
  }
}

function joinNotes(...notes) {
  const list = notes.filter(Boolean)
  return list.length ? list.join(' · ') : null
}

function totalsOf(records) {
  let bytes = 0
  for (const r of records) bytes += r.size || 0
  return { count: records.length, bytes }
}

/** Filtro de pastas do comparador: uma pasta inclui as subpastas; '' (ou nada) = tudo. */
function dirFilter(relDirs) {
  if (!Array.isArray(relDirs) || !relDirs.length) return () => true
  const dirs = relDirs.map(d => splitRel(toNFC(d)).join('/'))
  if (dirs.includes('')) return () => true
  return relDir => dirs.some(d => relDir === d || relDir.startsWith(`${d}/`))
}

function lastSeg(rel) {
  const i = rel.lastIndexOf('/')
  return i < 0 ? rel : rel.slice(i + 1)
}

function parentOf(rel) {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

// ─────────── nomes no disco de destino ───────────

/**
 * Decide o nome final de cada arquivo numa pasta local: nomes repetidos no lote, arquivos que já existem,
 * temporários de outros downloads e caminhos reservados por outras transferências.
 * Comparação sem diferenciar maiúsculas e em NFC (macOS e Windows tratam assim).
 */
class LocalPlacer {
  constructor({ policy, reserved }) {
    this.policy = policy
    this.reserved = reserved // Set de pathKey()
    // pathKey(dirAbs) -> Promise<{ existing: Map<lower, name>, busy: Set<lower>, batch: Set<lower> }>.
    // Chave sem diferenciar maiúsculas: "Cena 1" e "cena 1" (o Drive aceita as duas) são a MESMA pasta no
    // macOS/Windows, e os nomes dentro delas não podem se repetir.
    this.dirs = new Map()
  }

  #dir(dirAbs) {
    const key = pathKey(dirAbs)
    let p = this.dirs.get(key)
    if (!p) {
      p = (async () => {
        const existing = new Map()
        const busy = new Set()
        try {
          for (const raw of await fs.readdir(dirAbs)) {
            const name = toNFC(raw)
            const lower = name.toLowerCase()
            if (!existing.has(lower)) existing.set(lower, raw)
            if (lower.endsWith(PART_SUFFIX)) busy.add(lower.slice(0, -PART_SUFFIX.length))
          }
        } catch {
          // Pasta ainda não existe (ou não dá para ler): o download cria/acusa na hora certa.
        }
        return { existing, busy, batch: new Set() }
      })()
      this.dirs.set(key, p)
    }
    return p
  }

  /** Subpasta que este lote vai criar: arquivo nenhum pode ganhar o mesmo nome nesta pasta. Mesmo nome = mesma pasta. */
  async registerDir(dirAbs, name) {
    const d = await this.#dir(dirAbs)
    d.batch.add(name.toLowerCase())
  }

  /** Nome para uma pasta de topo do lote: junta com uma pasta local de mesmo nome, mas nunca com outra escolha do lote. */
  async topDir(dirAbs, name) {
    const d = await this.#dir(dirAbs)
    const lower = name.toLowerCase()
    let final = name
    let clash = d.batch.has(lower)
    if (!clash && d.existing.has(lower)) {
      const st = await fs.lstat(path.join(dirAbs, d.existing.get(lower))).catch(() => null)
      clash = !!st && !st.isDirectory() // um arquivo com esse nome: não dá para criar a pasta
    }
    if (clash) final = nextFreeName(name, k => d.batch.has(k) || d.existing.has(k))
    d.batch.add(final.toLowerCase())
    return { name: final, renamed: final !== name }
  }

  /**
   * @returns {Promise<{ skip: string } | { name: string, overwrite: boolean, note: string|null }>}
   */
  async file(dirAbs, name, { size, isDoc }) {
    const d = await this.#dir(dirAbs)
    const lower = name.toLowerCase()
    const taken = k => d.batch.has(k) || d.existing.has(k) || d.busy.has(k) || this.reserved.has(pathKey(path.join(dirAbs, k)))
    const inBatch = d.batch.has(lower)
    const reserved = this.reserved.has(pathKey(path.join(dirAbs, name)))
    const busy = d.busy.has(lower)
    let final = name
    let note = null
    let overwrite = false
    if (inBatch || reserved || busy) {
      final = nextFreeName(name, taken)
      note = inBatch ? NOTE.driveDup(name, final) : NOTE.reserved(name, final)
    } else if (d.existing.has(lower)) {
      const st = await fs.lstat(path.join(dirAbs, d.existing.get(lower))).catch(() => null)
      if (!st) {
        d.existing.delete(lower) // sumiu desde a listagem
      } else if (st.isFile() && this.policy === 'skip' && (isDoc || st.size === size)) {
        // Doc exportado não tem tamanho conhecido antes: mesmo nome já basta para pular.
        return { skip: isDoc ? SKIP.existsLocal : SKIP.sameLocal }
      } else if (st.isFile() && this.policy === 'overwrite') {
        overwrite = true
        note = NOTE.overwrite(d.existing.get(lower))
      } else {
        // 'rename', 'skip' com tamanho diferente (guarda os dois) ou uma pasta com esse nome.
        final = nextFreeName(name, taken)
        note = NOTE.localExists(toNFC(d.existing.get(lower)), final)
      }
    }
    d.batch.add(final.toLowerCase())
    return { name: final, overwrite, note }
  }
}

/** Espaço livre no disco de `dir` (ou da primeira pasta acima dele que existe), ou null. */
async function freeSpace(dir) {
  let d = dir
  for (let i = 0; i < 64; i++) {
    try {
      const st = await fs.statfs(d)
      return Number(st.bavail) * Number(st.bsize)
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') return null
      const up = path.dirname(d)
      if (up === d) return null
      d = up
    }
  }
  return null
}

// ─────────── downloads ───────────

/** Item vindo da interface pode estar incompleto (JSON antigo): sem mimeType, busca de novo. */
async function normalizeItem(drive, item, signal) {
  if (!item || typeof item !== 'object' || !item.id) throw badRequest('Item do Drive inválido.')
  if (item.mimeType && typeof item.isFolder === 'boolean') return item
  return drive.getItem(item.id, { signal, resourceKey: item.resourceKey || undefined })
}

async function shortcutTarget(drive, item, signal) {
  if (item.target !== undefined) return item.target
  if (!item.shortcutTargetId) return null
  try {
    return await drive.getItem(item.shortcutTargetId, { signal, resourceKey: item.shortcutTargetResourceKey || undefined })
  } catch (err) {
    const info = classifyError(err)
    if (info.kind === 'notfound' || (info.kind === 'fatal' && info.status === 403)) return null
    throw err
  }
}

/**
 * Expande itens do Drive (pastas viram todos os arquivos dentro) em registros de download.
 * @param {{ drive, accountId: string, items: object[], destDir: string, conflict?: 'skip'|'rename'|'overwrite',
 *   batchId?: string, signal?: AbortSignal, onProgress?: Function, platform?: string, reservedPaths?: Iterable<string> }} opts
 *   `reservedPaths` (opcional): destinos (dest.path) de downloads que já estão na fila, para não repetir.
 */
export async function planDownloads({ drive, accountId, items, destDir, conflict = 'skip', batchId, signal, onProgress, platform = process.platform, reservedPaths } = {}) {
  if (signal?.aborted) throw abortError(signal)
  if (!Array.isArray(items) || !items.length) throw badRequest('Escolha pelo menos um item do Drive.')
  if (!destDir || typeof destDir !== 'string') throw badRequest('Escolha a pasta de destino.')
  const root = resolveDir(destDir)
  const policy = CONFLICTS.has(conflict) ? conflict : 'skip'
  const now = Date.now()
  const reserved = new Set()
  for (const p of reservedPaths || []) if (p) reserved.add(pathKey(p))
  const placer = new LocalPlacer({ policy, reserved })
  const records = []
  const skipped = []
  const warnings = []
  const picked = { folders: [], files: [] }
  const id = batchId || newId('b')
  const progress = { files: 0, bytes: 0, current: '' }
  const emit = () => {
    try {
      onProgress?.({ phase: 'drive', ...progress })
    } catch {
      // progresso é só informativo
    }
  }

  // `fresh`: os metadados do item foram lidos do Drive agora, neste plano (não vieram prontos da tela).
  const addFile = async (it, dirAbs, displayDir, { inFolder, extraNote = null, fresh = false }) => {
    // Lixo de sistema que alguém subiu (.DS_Store…) não vem junto numa pasta; escolhido à mão, vem.
    if (inFolder && isJunkFile(it.name)) return
    let src = it
    let srcFresh = fresh
    if (it.isShortcut) {
      if (it.shortcutTargetMimeType === FOLDER_MIME) return void skipped.push({ name: joinRel(displayDir, it.name), reason: SKIP.folderShortcut, id: it.id })
      srcFresh = fresh || it.target === undefined // sem alvo pronto, o alvo é buscado agora
      src = await shortcutTarget(drive, it, signal)
      if (!src) return void skipped.push({ name: joinRel(displayDir, it.name), reason: SKIP.danglingShortcut, id: it.id })
      if (src.isFolder) return void skipped.push({ name: joinRel(displayDir, it.name), reason: SKIP.folderShortcut, id: it.id })
    }
    const displayName = toNFC(it.name)
    let exp = null
    if (src.isGoogleDoc) {
      exp = GOOGLE_EXPORTS[src.mimeType] ?? null
      if (!exp) return void skipped.push({ name: joinRel(displayDir, displayName), reason: SKIP.gappsOther, id: it.id })
    }
    if (src.canDownload === false) return void skipped.push({ name: joinRel(displayDir, displayName), reason: SKIP.blocked, id: it.id })
    if (!exp && (src.isFolder || src.isShortcut || typeof src.size !== 'number')) {
      return void skipped.push({ name: joinRel(displayDir, displayName), reason: SKIP.notFile, id: it.id })
    }
    let localName = safeLocalName(it.name, platform)
    if (exp && !localName.toLowerCase().endsWith(exp.ext)) localName = safeLocalName(`${localName}${exp.ext}`, platform)
    const size = exp ? null : src.size
    const placed = await placer.file(dirAbs, localName, { size, isDoc: !!exp })
    if (placed.skip) return void skipped.push({ name: joinRel(displayDir, localName), reason: placed.skip, id: it.id })

    const destPath = path.join(dirAbs, placed.name)
    const rec = baseRecord('download', { accountId, batchId: id, name: placed.name, relPath: joinRel(displayDir, placed.name), size, now })
    rec.note = joinNotes(exp ? NOTE.exported(exp.ext) : null, placed.note, extraNote)
    rec.source = {
      fileId: src.id,
      mimeType: src.mimeType,
      md5: exp ? null : (src.md5 ?? null),
      modifiedTime: src.modifiedTime ?? null,
      headRevisionId: exp ? null : (src.headRevisionId ?? null),
      resourceKey: src.resourceKey ?? null,
    }
    if (exp) rec.source.export = { mime: exp.mime, ext: exp.ext }
    // Metadados lidos agora: o download pode começar sem perguntar de novo ao Drive (engine/download.js, #freshPlan).
    else if (srcFresh) rec.source.checkedAt = now
    rec.dest = { path: destPath, tempPath: destPath + PART_SUFFIX }
    if (placed.overwrite) rec.dest.overwrite = true
    rec.segments = null // a tarefa cria os segmentos (depende dos ajustes na hora de baixar)
    records.push(rec)
    progress.files++
    progress.bytes += size || 0
  }

  // Item que sumiu do Drive desde que a lista foi aberta: vai para skipped e o resto do lote segue.
  let missing = 0
  const gone = (err, it) => {
    if (classifyError(err).kind !== 'notfound') return false
    missing++
    skipped.push({ name: toNFC(it?.name || it?.id || ''), reason: SKIP.gone, id: it?.id })
    return true
  }

  const seen = new Set()
  for (const raw of items) {
    if (signal?.aborted) throw abortError(signal)
    if (raw?.id && seen.has(raw.id)) continue
    if (raw?.id) seen.add(raw.id)
    let item
    try {
      item = await normalizeItem(drive, raw, signal)
    } catch (err) {
      if (gone(err, raw)) continue
      throw err
    }
    // A raiz do Meu Drive vem do Google como "My Drive": no disco, o nome que o usuário vê.
    if (raw.id === 'root' && item.isFolder) item = { ...item, name: 'Meu Drive' }
    const isFolderLike = item.isFolder || (item.isShortcut && item.shortcutTargetMimeType === FOLDER_MIME)
    if (!isFolderLike) {
      picked.files.push(toNFC(item.name))
      progress.current = toNFC(item.name)
      await addFile(item, root, '', { inFolder: false, fresh: item !== raw })
      emit()
      continue
    }

    progress.current = toNFC(item.name)
    emit()
    const base = { files: progress.files, bytes: progress.bytes }
    let tree
    try {
      // `walked`: a árvore já veio lida (Copiar de um link + baixar: pasta de outra pessoa, com resourcekey).
      if (Array.isArray(raw.walked)) tree = raw.walked
      else ({ items: tree } = await drive.walk(item.id, {
        signal,
        onProgress: p => {
          try {
            onProgress?.({ phase: 'drive', files: base.files + p.files, bytes: base.bytes + p.bytes, current: progress.current })
          } catch {
            // progresso é só informativo
          }
        },
      }))
    } catch (err) {
      if (gone(err, item)) continue
      throw err
    }
    picked.folders.push(toNFC(item.name))
    const wantedTop = safeLocalName(item.name, platform)
    const top = await placer.topDir(root, wantedTop)
    const topNote = top.renamed ? NOTE.topDup(wantedTop, top.name) : null
    const topAbs = path.join(root, top.name)
    const dirs = new Map([['', { abs: topAbs, display: top.name }]])
    const dirOf = relDir => {
      let d = dirs.get(relDir)
      if (d) return d
      const i = relDir.lastIndexOf('/')
      const parent = dirOf(i < 0 ? '' : relDir.slice(0, i))
      const seg = safeLocalName(relDir.slice(i + 1), platform)
      d = { abs: path.join(parent.abs, seg), display: joinRel(parent.display, seg) }
      dirs.set(relDir, d)
      return d
    }
    // Pastas primeiro: um arquivo não pode ficar com o nome de uma subpasta.
    const files = []
    for (const it of tree) {
      if (splitRel(it.relDir || '').some(isJunkFile)) continue // dentro de pasta-lixo (.Trashes…)
      if (it.isFolder) {
        if (isJunkFile(lastSeg(it.relPath))) continue
        const parent = dirOf(it.relDir || '')
        await placer.registerDir(parent.abs, safeLocalName(lastSeg(it.relPath), platform))
      } else {
        files.push(it)
      }
    }
    sortByPath(files, it => it.relPath)
    for (const it of files) {
      if (signal?.aborted) throw abortError(signal)
      const d = dirOf(it.relDir || '')
      await addFile(it, d.abs, d.display, { inFolder: true, extraNote: topNote, fresh: true })
    }
    emit()
  }

  if (missing && missing === seen.size && !records.length) {
    const err = new Error(missing === 1 ? 'Não achei este item no Drive. Ele pode ter sido apagado, movido ou deixado de ser compartilhado com você.' : 'Não achei estes itens no Drive. Eles podem ter sido apagados, movidos ou deixado de ser compartilhados com você.')
    err.status = 404
    throw err
  }
  const totals = totalsOf(records)
  if (totals.bytes > 0) {
    const free = await freeSpace(root)
    if (free != null && totals.bytes > free) {
      warnings.push(`Pode faltar espaço: o lote tem ${formatBytes(totals.bytes)} e o disco de destino tem ${formatBytes(free)} livres.`)
    }
  }
  const batch = newBatch(id, 'download', selectionLabel(picked.folders, picked.files), accountId, now)
  return { batch, records, skipped, warnings, totals }
}

// ─────────── uploads ───────────

/**
 * Expande caminhos locais (pastas viram todos os arquivos dentro) em registros de upload.
 * A pasta de destino de cada arquivo é criada só na hora do envio (target.parentId = null).
 * A política de conflito no Drive é aplicada pela tarefa de upload (ajuste uploadConflict) no momento do envio.
 */
export async function planUploads({ drive, accountId, paths, destFolderId = 'root', driveId = null, batchId, signal, onProgress } = {}) {
  if (signal?.aborted) throw abortError(signal)
  if (!Array.isArray(paths) || !paths.length) throw badRequest('Escolha pelo menos um arquivo ou pasta.')
  // 'root' + driveId = raiz do drive compartilhado (o id da raiz é o próprio driveId), nunca o Meu Drive.
  const rootId = (destFolderId === 'root' || !destFolderId) && driveId ? driveId : destFolderId || 'root'
  const now = Date.now()
  const id = batchId || newId('b')
  const records = []
  const skipped = []
  const warnings = []
  const picked = { folders: [], files: [] }
  const topTaken = new Set() // nomes no topo do destino (minúsculas): duas escolhas com o mesmo nome não se misturam
  const seen = new Set()
  let firstError = null
  let base = { files: 0, bytes: 0 }

  const addRecord = (f, { name, relPath, relDir, note }) => {
    if (f.size > MAX_UPLOAD_SIZE) return void skipped.push({ name: relPath, reason: SKIP.tooBig, path: f.path })
    const rec = baseRecord('upload', { accountId, batchId: id, name, relPath, size: f.size, now })
    rec.note = note ?? null
    rec.local = { path: f.path, size: f.size, mtimeMs: f.mtimeMs }
    rec.target = { rootId, relDir, parentId: null, driveId: driveId || null, replaceFileId: null, fileId: null }
    rec.session = null
    records.push(rec)
  }

  for (const p of paths) {
    if (signal?.aborted) throw abortError(signal)
    if (typeof p !== 'string' || !p) continue
    const key = path.resolve(expandHome(p))
    if (seen.has(key)) continue
    seen.add(key)
    let scan
    try {
      scan = await scanLocal(p, {
        signal,
        onProgress: x => {
          try {
            onProgress?.({ phase: 'local', files: base.files + x.files, bytes: base.bytes + x.bytes, current: x.current || '' })
          } catch {
            // progresso é só informativo
          }
        },
      })
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) throw signal?.aborted ? abortError(signal) : err
      firstError ??= err
      skipped.push({ name: path.basename(key) || key, reason: err.message, path: key })
      continue
    }
    // Raiz de um disco ('/', 'C:\') não tem nome de pasta: separadores no nome criariam níveis no Drive.
    const rawName = scan.root.name
    const rootName = scan.root.isDir && path.parse(scan.root.path).root === scan.root.path ? rawName.replace(/[/\\]/g, '') || 'Disco' : rawName
    const top = nextFreeName(rootName, k => topTaken.has(k))
    topTaken.add(top.toLowerCase())
    const note = top !== rootName ? NOTE.topDup(rootName, top) : null
    if (scan.root.isDir) {
      picked.folders.push(rootName)
      for (const f of sortByPath(scan.files, x => x.relPath)) {
        addRecord(f, { name: f.name, relPath: joinRel(top, f.relPath), relDir: joinRel(top, f.relDir), note })
      }
    } else {
      picked.files.push(rootName)
      addRecord(scan.files[0], { name: top, relPath: top, relDir: '', note })
    }
    for (const s of scan.skipped) {
      const rel = path.relative(scan.root.path, s.path).split(path.sep).join('/')
      skipped.push({ name: joinRel(scan.root.isDir ? top : '', toNFC(rel)), reason: s.reason, path: s.path })
    }
    base = { files: base.files + scan.files.length, bytes: base.bytes + scan.files.reduce((n, f) => n + f.size, 0) }
  }
  // Nenhum caminho deu para ler: melhor um erro claro (com .status e mensagem em PT-BR) do que um lote vazio.
  if (firstError && picked.folders.length + picked.files.length === 0) throw firstError

  const totals = totalsOf(records)
  if (totals.bytes > 0 && !driveId) {
    // Drive compartilhado usa o espaço da organização: a cota pessoal não vale lá.
    try {
      const about = await drive.about({ signal })
      const { limit, usage } = about.quota || {}
      if (limit != null) {
        const free = Math.max(0, limit - (usage || 0))
        if (totals.bytes > free) {
          warnings.push(`Seu Drive tem ${formatBytes(free)} livres e este envio tem ${formatBytes(totals.bytes)}. Libere espaço antes, senão o envio para no meio.`)
        }
      }
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) throw signal?.aborted ? abortError(signal) : err
      // Sem conseguir ver a cota, segue sem o aviso (o envio acusa se faltar espaço).
    }
  }
  if (totals.bytes > DAILY_UPLOAD_LIMIT) {
    warnings.push(`O Google aceita até 750 GB de envio por dia em cada conta. Este lote tem ${formatBytes(totals.bytes)}: o que passar disso continua sozinho depois.`)
  }
  const batch = newBatch(id, 'upload', selectionLabel(picked.folders, picked.files), accountId, now)
  return { batch, records, skipped, warnings, totals }
}

// ─────────── a partir do comparador ───────────

function compareRootName(result) {
  return result.folders?.find(f => f.relDir === '')?.name || path.basename(result.localPath || '') || 'pasta'
}

function scopeName(result, relDirs, fallback) {
  if (Array.isArray(relDirs) && relDirs.length === 1) {
    const d = splitRel(toNFC(relDirs[0])).join('/')
    if (d) return lastSeg(d)
  }
  return fallback
}

/**
 * Sobe o que falta (e, se pedido, os diferentes) de uma comparação.
 * 'missing' → na pasta correspondente dentro da pasta comparada do Drive; 'different' → nova versão do arquivo do Drive.
 * @param {object} result CompareResult
 * @param {{ accountId: string, statuses?: string[], relDirs?: string[], batchId?: string }} opts
 */
export function planUploadsFromCompare(result, { accountId, statuses = ['missing'], relDirs = null, batchId } = {}) {
  if (!result?.files || !result.drive?.folderId) throw badRequest('Resultado de comparação inválido.')
  const want = new Set(Array.isArray(statuses) && statuses.length ? statuses : ['missing'])
  const inScope = dirFilter(relDirs)
  const now = Date.now()
  const id = batchId || newId('b')
  const records = []
  const skipped = []
  const localRoot = result.localPath
  for (const f of result.files) {
    if (!want.has(f.status) || !f.local || !inScope(f.relDir)) continue
    if (f.local.size > MAX_UPLOAD_SIZE) {
      skipped.push({ name: f.relPath, reason: SKIP.tooBig })
      continue
    }
    const localPath = f.local.path ?? (result.localIsDir === false ? localRoot : path.join(localRoot, ...splitRel(f.relPath)))
    const rec = baseRecord('upload', { accountId, batchId: id, name: f.name, relPath: f.relPath, size: f.local.size, now })
    // Substituir um atalho mexeria no arquivo original, que está em outro lugar: aí sobe como novo.
    const replace = f.status === 'different' && f.remote?.id && !f.remote.shortcut ? f.remote.id : null
    // Pasta de destino na grafia do Drive: o 'different' casado sem diferenciar maiúsculas fica onde o arquivo está
    // (senão a tarefa criaria uma pasta "brutos" vazia ao lado de "Brutos" só para depois substituir o arquivo).
    const relDir = f.remote?.relPath && f.status !== 'elsewhere' ? parentOf(f.remote.relPath) : (f.remoteRelDir ?? f.relDir)
    rec.note = replace ? NOTE.replace : relDir !== f.relDir ? NOTE.folderCase(relDir) : null
    rec.local = { path: localPath, size: f.local.size, mtimeMs: f.local.mtimeMs }
    rec.target = {
      rootId: result.drive.folderId,
      relDir,
      parentId: null,
      driveId: result.drive.driveId ?? null,
      replaceFileId: replace,
      fileId: null,
    }
    rec.session = null
    records.push(rec)
  }
  const onlyMissing = [...want].every(s => s === 'missing')
  const onlyDifferent = [...want].every(s => s === 'different')
  const prefix = onlyMissing ? 'Faltando em' : onlyDifferent ? 'Diferentes em' : 'Faltando e diferentes em'
  const batch = newBatch(id, 'upload', `${prefix} "${scopeName(result, relDirs, compareRootName(result))}"`, accountId, now)
  return { batch, records, skipped, totals: totalsOf(records) }
}

/**
 * Baixa o que só está no Drive para a pasta local comparada (localPath/relPath).
 * Síncrono: usa só o que a comparação já sabe do disco (nomes locais de cada pasta) para não repetir nomes;
 * se algo aparecer no caminho até a hora de baixar, a tarefa escolhe outro nome sozinha.
 * @param {object} result CompareResult
 * @param {{ accountId: string, relDirs?: string[], batchId?: string, platform?: string }} opts
 */
export function planDownloadsFromCompare(result, { accountId, relDirs = null, batchId, platform = process.platform } = {}) {
  if (!result?.files || !result.localPath) throw badRequest('Resultado de comparação inválido.')
  const inScope = dirFilter(relDirs)
  const now = Date.now()
  const id = batchId || newId('b')
  const base = result.localIsDir === false ? path.dirname(result.localPath) : result.localPath

  // Pasta no disco de cada relDir: a de verdade quando a comparação viu (pode estar em NFD), senão montada.
  const onDisk = new Map()
  // relDir (minúsculas: no macOS/Windows "Cena" e "cena" são a mesma pasta) -> nomes já existentes ou já usados.
  const taken = new Map()
  const takenOf = relDir => {
    const key = relDir.toLowerCase()
    let s = taken.get(key)
    if (!s) taken.set(key, (s = new Set()))
    return s
  }
  for (const f of result.files) {
    if (!f.local) continue
    takenOf(f.relDir).add(safeLocalName(f.name, platform).toLowerCase())
    if (f.local.path && result.localIsDir !== false) {
      // Cada nível do relPath é um nível no disco: sobe junto registrando as pastas de verdade.
      let rel = f.relDir
      let abs = path.dirname(f.local.path)
      while (rel && !onDisk.has(rel)) {
        onDisk.set(rel, abs)
        rel = parentOf(rel)
        abs = path.dirname(abs)
      }
    }
  }
  // Subpastas (locais ou que o lote vai criar) também ocupam o nome na pasta de cima.
  for (const d of result.folders || []) {
    if (d.relDir) {
      const i = d.relDir.lastIndexOf('/')
      takenOf(i < 0 ? '' : d.relDir.slice(0, i)).add(safeLocalName(lastSeg(d.relDir), platform).toLowerCase())
    }
  }
  const dirs = new Map([['', base]])
  const dirOf = relDir => {
    let d = dirs.get(relDir) ?? onDisk.get(relDir)
    if (d) return d
    const i = relDir.lastIndexOf('/')
    d = path.join(dirOf(i < 0 ? '' : relDir.slice(0, i)), safeLocalName(relDir.slice(i + 1), platform))
    dirs.set(relDir, d)
    return d
  }

  const records = []
  const skipped = []
  for (const f of result.files) {
    if (f.status !== 'only-drive' || !f.remote?.id || !inScope(f.relDir)) continue
    const r = f.remote
    if (r.canDownload === false) {
      skipped.push({ name: f.relPath, reason: SKIP.blocked, id: r.id })
      continue
    }
    if (typeof r.size !== 'number') {
      skipped.push({ name: f.relPath, reason: SKIP.notFile, id: r.id })
      continue
    }
    const want = safeLocalName(f.name, platform)
    const set = takenOf(f.relDir)
    const name = nextFreeName(want, k => set.has(k))
    set.add(name.toLowerCase())
    const destPath = path.join(dirOf(f.relDir), name)
    const rec = baseRecord('download', { accountId, batchId: id, name, relPath: joinRel(f.relDir, name), size: r.size, now })
    if (name !== want) rec.note = NOTE.driveDup(want, name)
    rec.source = {
      fileId: r.id,
      mimeType: r.mimeType || 'application/octet-stream',
      md5: r.md5 ?? null,
      modifiedTime: r.modifiedTime ?? null,
      headRevisionId: null,
      resourceKey: r.resourceKey ?? null,
    }
    rec.dest = { path: destPath, tempPath: destPath + PART_SUFFIX }
    rec.segments = null
    records.push(rec)
  }
  const batch = newBatch(id, 'download', `Só no Drive: "${scopeName(result, relDirs, result.drive?.name || compareRootName(result))}"`, accountId, now)
  return { batch, records, skipped, totals: totalsOf(records) }
}
