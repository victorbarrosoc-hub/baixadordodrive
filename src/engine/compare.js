// Comparador: pasta do computador × pasta do Drive (contrato em docs/ARCHITECTURE.md, "engine/compare.js").
//
// Por que é assim:
//  - Tudo por Map (caminho, nome+tamanho, MD5): 50 mil arquivos cruzam em segundos, sem O(n²).
//  - As duas varreduras (disco e Drive) rodam ao mesmo tempo: uma é presa ao disco, a outra à rede.
//  - No modo completo só calcula o MD5 do que precisa (arquivo com par do mesmo tamanho no Drive, ou sem par
//    mas com algum arquivo do mesmo tamanho em outro lugar), sempre pelo cache do Hasher.
//  - O Drive aceita nomes repetidos numa pasta: cada caminho do Drive guarda uma lista, e cada arquivo remoto
//    só serve de par para UM arquivo local.
import path from 'node:path'
import fs from 'node:fs/promises'
import { dataPaths } from '../config.js'
import { scanLocal } from '../local/scan.js'
import { Hasher } from './hasher.js'
import { readJSON, writeJSONAtomic } from '../util/store.js'
import { newId } from '../util/ids.js'
import { isJunkFile, joinRel, splitRel } from '../util/paths.js'
import { abortError, isAbortError } from '../util/backoff.js'
import { classifyError } from '../google/errors.js'

const PROGRESS_MS = 200 // no máximo 5 avisos de progresso por segundo (por fase)
const HASH_CONCURRENCY = 4 // pedidos simultâneos ao Hasher (ele tem os próprios workers)
const KEEP_COMPARES = 20 // resultados antigos guardados em disco (cada um pode ter megabytes)
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/

const NOTE = {
  caseOnly: rel => `No Drive está como "${rel}" (só muda maiúscula/minúscula).`,
  folderCase: rel => `No Drive a pasta está como "${rel}".`,
  md5: 'Mesmo tamanho, mas o conteúdo é diferente (MD5).',
  noRemoteMd5: 'O Drive não informa o MD5 deste arquivo: conferi só o tamanho.',
  unreadable: code => `Não consegui ler o arquivo para conferir o MD5${code ? ` (${code})` : ''}: conferi só o tamanho.`,
  shortcut: 'No Drive é um atalho para o arquivo.',
}

// ─────────── ordenação natural (pt-BR) ───────────

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' })

/** Nomes em ordem natural ('C2' antes de 'C10'); empate desfeito pelo código dos caracteres (ordem total). */
export function compareNames(a, b) {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)
}

function compareSegs(sa, sb) {
  const n = Math.min(sa.length, sb.length)
  for (let i = 0; i < n; i++) {
    if (sa[i] === sb[i]) continue
    const c = compareNames(sa[i], sb[i])
    if (c) return c
  }
  return sa.length - sb.length
}

/**
 * Caminhos relativos em ordem natural, nível por nível: a pasta vem antes do que tem dentro e
 * uma subárvore inteira fica junta (comparar a string toda misturaria "A B" entre "A" e "A/x").
 */
export function comparePaths(a, b) {
  return compareSegs(splitRel(a), splitRel(b))
}

/** Ordena `list` por `keyOf(item)` (caminho relativo) sem repetir o split a cada comparação. */
export function sortByPath(list, keyOf) {
  const keyed = list.map(item => ({ item, segs: splitRel(keyOf(item)) }))
  keyed.sort((x, y) => compareSegs(x.segs, y.segs))
  for (let i = 0; i < keyed.length; i++) list[i] = keyed[i].item
  return list
}

// ─────────── ajudantes ───────────

function parentOf(relDir) {
  const i = relDir.lastIndexOf('/')
  return i < 0 ? '' : relDir.slice(0, i)
}

function lastSeg(rel) {
  const i = rel.lastIndexOf('/')
  return i < 0 ? rel : rel.slice(i + 1)
}

function hasJunkSegment(rel) {
  for (const s of rel.split('/')) if (isJunkFile(s)) return true
  return false
}

function push(map, key, value) {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/** Primeiro livre da lista; se todos já têm par, o primeiro (conteúdo repetido continua valendo). */
function preferFree(list) {
  if (!list?.length) return null
  return list.find(r => !r.claimed) ?? list[0]
}

/**
 * Traduz uma pasta relativa para a grafia que existe do "outro lado" quando só muda maiúscula/minúscula,
 * nível por nível. `exact` = pastas do outro lado; o resto fica como veio.
 */
function caseMapper(exact) {
  const lower = new Map()
  for (const d of exact) {
    const k = d.toLowerCase()
    if (!lower.has(k)) lower.set(k, d)
  }
  const memo = new Map([['', '']])
  const map = relDir => {
    const hit = memo.get(relDir)
    if (hit !== undefined) return hit
    const i = relDir.lastIndexOf('/')
    const parent = map(i < 0 ? '' : relDir.slice(0, i))
    const candidate = parent ? `${parent}/${relDir.slice(i + 1)}` : relDir.slice(i + 1)
    const out = exact.has(candidate) ? candidate : lower.get(candidate.toLowerCase()) ?? candidate
    memo.set(relDir, out)
    return out
  }
  return map
}

function makeReporter(onProgress) {
  let last = 0
  let lastPhase = null
  return (p, force = false) => {
    if (!onProgress) return
    const now = Date.now()
    if (!force && p.phase === lastPhase && now - last < PROGRESS_MS) return
    last = now
    lastPhase = p.phase
    try {
      onProgress(p)
    } catch {
      // progresso é só informativo
    }
  }
}

function badRequest(message) {
  const err = new Error(message)
  err.status = 400
  return err
}

function driveNotFound(cause) {
  const err = new Error('Não achei esta pasta no Drive. Ela pode ter sido apagada, movida ou deixado de ser compartilhada com você.')
  err.status = 404
  err.code = 'notFound'
  err.cause = cause
  return err
}

// ─────────── comparação ───────────

/**
 * Compara a pasta local com a pasta do Drive.
 * @param {{ drive: import('../google/drive.js').DriveClient, localPath: string, driveFolderId: string,
 *   mode?: 'quick'|'deep', hasher?: Hasher, signal?: AbortSignal, onProgress?: Function,
 *   paths?: ReturnType<typeof dataPaths>, persist?: boolean }} opts
 *   `paths`/`persist` (opcionais): onde gravar o resultado (padrão dataPaths()) e se grava.
 */
export async function compareFolders({ drive, localPath, driveFolderId, mode = 'quick', hasher = null, signal, onProgress, paths = null, persist = true } = {}) {
  if (signal?.aborted) throw abortError(signal)
  if (!drive) throw new Error('compareFolders: drive é obrigatório')
  if (!localPath) throw badRequest('Escolha a pasta do computador.')
  if (!driveFolderId) throw badRequest('Escolha a pasta do Drive.')
  const deep = mode === 'deep'
  const report = makeReporter(onProgress)

  // 1 + 2. Disco e Drive ao mesmo tempo. Se um falhar, o outro para (não gasta cota à toa).
  const inner = new AbortController()
  const sig = signal ? AbortSignal.any([signal, inner.signal]) : inner.signal
  let failure = null
  // Cada ramo nasce já observado: nem um erro síncrono ao começar deixa outro ramo com rejeição solta.
  const start = fn => {
    let p
    try {
      p = Promise.resolve(fn())
    } catch (err) {
      p = Promise.reject(err)
    }
    const guarded = p.catch(err => {
      failure ??= err
      inner.abort()
      throw err
    })
    guarded.catch(() => {})
    return guarded
  }
  let localDone = false
  let driveFiles = 0
  report({ phase: 'local', done: 0, total: 0, current: '' }, true)
  const localP = start(() =>
    scanLocal(localPath, {
      signal: sig,
      onProgress: p => {
        if (!localDone) report({ phase: 'local', done: p.files, total: 0, current: p.current || '' })
      },
    }).then(r => {
      localDone = true
      report({ phase: 'drive', done: driveFiles, total: 0, current: '' }, true)
      return r
    }),
  )
  const driveP = start(() =>
    drive
      .walk(driveFolderId, {
        signal: sig,
        appProps: true, // a marca do proxy gerado pelo app: ele fica fora do Só no Drive
        onProgress: p => {
          driveFiles = p.files
          if (localDone) report({ phase: 'drive', done: p.files, total: 0, current: '' })
        },
      })
      .catch(err => {
        if (classifyError(err).kind === 'notfound') throw driveNotFound(err)
        throw err
      }),
  )
  // O caminho legível ("Meu Drive/Projetos/X") é só enfeite: falha nele não derruba a comparação.
  const pathP = start(() =>
    drive.getPath(driveFolderId, { signal: sig }).catch(err => {
      if (isAbortError(err) || sig.aborted) throw err
      return null
    }),
  )
  let scan
  let tree
  let crumbs
  try {
    ;[scan, tree, crumbs] = await Promise.all([localP, driveP, pathP])
  } catch (err) {
    if (signal?.aborted) throw abortError(signal)
    throw failure ?? err
  }
  if (!tree.root.isFolder) throw badRequest('Escolha uma pasta do Drive para comparar (não um arquivo).')
  driveFiles = tree.items.reduce((n, it) => n + (it.isFolder ? 0 : 1), 0)
  report({ phase: 'drive', done: driveFiles, total: driveFiles, current: '' }, true)

  const root = tree.root
  const rootDisplay = crumbs?.length ? crumbs[crumbs.length - 1].name : root.name
  const drivePath = crumbs?.length ? crumbs.map(c => c.name).join('/') : root.name
  const folderId = driveFolderId === 'root' ? 'root' : root.id
  const localRoot = scan.root.path
  const localIsDir = scan.root.isDir

  // 3. Arquivos do Drive que contam: binários e atalhos para binários. Docs nativos e lixo de sistema ficam de fora.
  const remotes = []
  const remoteDirSet = new Set()
  let ignored = 0
  for (const it of tree.items) {
    if (hasJunkSegment(it.relPath)) continue
    if (it.isFolder) {
      remoteDirSet.add(it.relPath)
      continue
    }
    let src = it
    if (it.isShortcut) {
      const t = it.target
      if (!t || t.isFolder || t.isShortcut || t.isGoogleDoc || t.size == null) {
        ignored++
        continue
      }
      src = t
    } else if (it.isGoogleDoc || it.size == null) {
      ignored++
      continue
    }
    remotes.push({
      id: src.id,
      relPath: it.relPath,
      relDir: it.relDir || '',
      name: lastSeg(it.relPath),
      size: src.size,
      md5: src.md5 ? String(src.md5).toLowerCase() : null,
      mimeType: src.mimeType,
      modifiedTime: src.modifiedTime ?? null,
      resourceKey: src.resourceKey ?? null,
      canDownload: src.canDownload !== false,
      shortcut: it.isShortcut,
      // Proxy que o próprio SOBEDESCE gerou (Proxy/<nome>.mp4): pode ser par de um arquivo local, mas sozinho
      // não é "Só no Drive" (nem entra no "Baixar o que só está no Drive").
      previa: !it.isShortcut && isPreviaMark(it),
      claimed: false,
    })
  }

  // Índices (tudo O(1) por consulta).
  const byPath = new Map()
  const byLower = new Map()
  const byNameSize = new Map()
  const byMd5 = new Map()
  const md5Sizes = new Set()
  for (const r of remotes) {
    push(byPath, r.relPath, r)
    push(byLower, r.relPath.toLowerCase(), r)
    push(byNameSize, `${r.name}\u0000${r.size}`, r)
    if (r.md5) {
      push(byMd5, r.md5, r)
      md5Sizes.add(r.size)
    }
  }

  // 4. Pares pelo caminho: primeiro exato (NFC), depois sem diferenciar maiúsculas.
  const entries = scan.files.map(f => ({ f, remote: null, alts: null, how: null, md5: null, hashError: null }))
  const pick = (e, group, how) => {
    let first = null
    const same = []
    for (const r of group) {
      if (r.claimed) continue
      first ??= r
      if (r.size === e.f.size) same.push(r)
    }
    if (!first) return
    const chosen = same[0] ?? first
    chosen.claimed = true
    e.remote = chosen
    e.how = how
    if (same.length > 1) e.alts = same.slice(1) // nomes repetidos no Drive: o MD5 escolhe o par certo
  }
  for (const e of entries) {
    const group = byPath.get(e.f.relPath)
    if (group) pick(e, group, 'exact')
  }
  for (const e of entries) {
    if (e.remote) continue
    const group = byLower.get(e.f.relPath.toLowerCase())
    if (group) pick(e, group, 'case')
  }

  // 5. MD5 local (modo completo), só do necessário.
  if (deep) {
    const need = entries.filter(e => {
      const f = e.f
      if (e.remote) return e.remote.size === f.size && (!!e.remote.md5 || !!e.alts?.some(a => a.md5))
      return f.size > 0 && md5Sizes.has(f.size)
    })
    await hashEntries(need, { hasher, sig: signal, report, paths })
  }
  if (signal?.aborted) throw abortError(signal)

  // 6. Veredito.
  report({ phase: 'match', done: 0, total: entries.length, current: '' }, true)
  const files = []
  const add = (e, status, remote, notes) => {
    const f = e.f
    const out = { relPath: f.relPath, relDir: f.relDir, name: f.name, status }
    out.local = { size: f.size, mtimeMs: f.mtimeMs }
    // Caminho no disco só quando não dá para deduzir (ex.: nome gravado em NFD no macOS).
    const derived = localIsDir ? path.join(localRoot, ...splitRel(f.relPath)) : localRoot
    if (f.path !== derived) out.local.path = f.path
    if (remote) out.remote = remoteView(remote, rootDisplay, f.relPath, false)
    if (notes.length) out.note = notes.join(' ')
    e.out = out
    files.push(out)
  }

  // 6a. Quem tem par pelo caminho (antes dos sem par: uma troca de par pelo MD5 não pode roubar de ninguém).
  for (const e of entries) {
    if (!e.remote) continue
    const f = e.f
    let r = e.remote
    const notes = []
    let status
    if (r.size !== f.size) {
      status = 'different'
    } else if (!deep) {
      status = 'synced'
    } else if (e.md5 == null) {
      status = 'synced'
      notes.push(e.hashError ? NOTE.unreadable(e.hashError.code) : NOTE.noRemoteMd5)
    } else if (r.md5 === e.md5) {
      status = 'synced'
    } else {
      const alt = e.alts?.find(a => !a.claimed && a.md5 === e.md5)
      if (alt) {
        r.claimed = false
        alt.claimed = true
        e.remote = r = alt
        status = 'synced'
      } else if (!r.md5) {
        status = 'synced'
        notes.push(NOTE.noRemoteMd5)
      } else {
        status = 'different'
        notes.push(NOTE.md5)
      }
    }
    if (e.how === 'case') notes.unshift(NOTE.caseOnly(r.relPath))
    if (r.shortcut) notes.push(NOTE.shortcut)
    add(e, status, r, notes)
  }

  // 6b. Sem par: o mesmo conteúdo em outro lugar da pasta do Drive? (MD5 no completo; nome+tamanho no rápido.)
  const driveCase = caseMapper(remoteDirSet)
  for (const e of entries) {
    if (e.remote) continue
    const f = e.f
    let found = null
    // Arquivo vazio: todo vazio tem o mesmo MD5, então só vale nome+tamanho.
    if (!deep || f.size === 0) found = preferFree(byNameSize.get(`${f.name}\u0000${f.size}`))
    else if (e.md5) found = preferFree(byMd5.get(e.md5)?.filter(r => r.size === f.size))
    if (found) {
      found.claimed = true // movido no Drive: não aparece também como "só no Drive"
      add(e, 'elsewhere', found, [])
      continue
    }
    const notes = []
    const rd = driveCase(f.relDir)
    if (rd !== f.relDir) notes.push(NOTE.folderCase(rd))
    add(e, 'missing', null, notes)
    if (rd !== f.relDir) e.out.remoteRelDir = rd // o planner sobe para a pasta que já existe no Drive
  }

  // 6c. Só no Drive. Pastas que só mudam maiúscula/minúscula entram na grafia local (a árvore não duplica).
  const localDirSet = new Set(scan.dirs)
  const localCase = caseMapper(localDirSet)
  let proxies = 0
  const proxyDirs = new Set()
  for (const r of remotes) {
    if (r.claimed) continue
    if (r.previa) {
      proxies++
      proxyDirs.add(r.relDir)
      continue
    }
    const relDir = localCase(r.relDir)
    const relPath = joinRel(relDir, r.name)
    files.push({ relPath, relDir, name: r.name, status: 'only-drive', remote: remoteView(r, rootDisplay, relPath, true) })
  }
  report({ phase: 'match', done: entries.length, total: entries.length, current: '' }, true)

  // A pasta Proxy que só tem os proxies do app sai da árvore também (senão viraria uma pasta vazia "só no Drive").
  if (proxyDirs.size) pruneProxyDirs(proxyDirs, { remoteDirSet, localDirSet, items: tree.items, remotes })

  sortByPath(files, x => x.relPath)
  const folders = aggregateFolders(files, { localDirs: localDirSet, remoteDirs: remoteDirSet, localCase, rootName: scan.root.name })
  const summary = summarize(files)
  summary.ignored = ignored
  summary.skipped = scan.skipped.length
  if (proxies) summary.proxies = proxies // proxies do app deixados de fora do "Só no Drive"

  const result = {
    id: newId('cmp'),
    createdAt: new Date().toISOString(),
    mode: deep ? 'deep' : 'quick',
    localPath: localRoot,
    localIsDir,
    drive: { folderId, name: rootDisplay, path: drivePath, driveId: root.driveId ?? null },
    summary,
    folders,
    files,
    skipped: scan.skipped.slice(0, 500),
  }
  if (persist) await saveCompare(result, paths ?? dataPaths())
  return result
}

/**
 * Feito pelo SOBEDESCE ao lado do original: o proxy ('previa', src/media/previa-fila.js) ou a tira de quadros do hover
 * scrub ('quadros', src/media/quadros.js). Nenhum dos dois é "só no Drive".
 */
function isPreviaMark(it) {
  const m = it?.appProperties?.sobedesce
  return m === 'previa' || m === 'quadros'
}

/**
 * Tira de `remoteDirSet` a pasta onde, no Drive, só há proxies do app que ficaram sem par. Fica a pasta que existe
 * no computador ou que tem qualquer outra coisa dentro no Drive (arquivo, Doc, atalho, subpasta).
 */
function pruneProxyDirs(proxyDirs, { remoteDirSet, localDirSet, items, remotes }) {
  const ignoredIds = new Set(remotes.filter(r => r.previa && !r.claimed).map(r => r.id))
  const busy = new Set() // pastas com algo que conta logo dentro
  for (const it of items) {
    if (hasJunkSegment(it.relPath)) continue
    if (it.isFolder || !ignoredIds.has(it.id)) busy.add(it.relDir || '')
  }
  for (const d of proxyDirs) if (d && !busy.has(d) && !localDirSet.has(d)) remoteDirSet.delete(d)
}

/** Parte do Drive que vai no resultado (o que o planner precisa para baixar/substituir, sem inchar o JSON). */
function remoteView(r, rootDisplay, entryRelPath, forDownload) {
  const out = { id: r.id, size: r.size, md5: r.md5, path: joinRel(rootDisplay, r.relPath) }
  if (r.relPath !== entryRelPath) out.relPath = r.relPath
  if (forDownload) {
    out.mimeType = r.mimeType
    out.modifiedTime = r.modifiedTime
  }
  if (r.resourceKey) out.resourceKey = r.resourceKey
  if (!r.canDownload) out.canDownload = false
  if (r.shortcut) out.shortcut = true
  return out
}

async function hashEntries(need, { hasher, sig, report, paths }) {
  if (!need.length) return
  const own = hasher ? null : new Hasher({ cacheFile: (paths ?? dataPaths()).hashCache })
  const h = hasher ?? own
  try {
    await h.init()
    const total = need.length
    let bytesTotal = 0
    for (const e of need) bytesTotal += e.f.size
    let done = 0
    let bytesDone = 0
    const live = new Map() // entrada -> bytes já lidos (cálculo em andamento)
    let current = ''
    const emit = (force = false) => {
      let inFlight = 0
      for (const b of live.values()) inFlight += b
      report({ phase: 'hash', done, total, current, bytesDone: bytesDone + inFlight, bytesTotal }, force)
    }
    emit(true)
    let next = 0
    const worker = async () => {
      while (next < need.length) {
        if (sig?.aborted) throw abortError(sig)
        const e = need[next++]
        const f = e.f
        // Cache primeiro, sem nem abrir o arquivo (o scan já trouxe tamanho e data).
        const cached = h.getCached(f.path, f.size, f.mtimeMs)
        if (cached) {
          e.md5 = cached.toLowerCase()
        } else {
          current = f.relPath
          live.set(e, 0)
          emit()
          try {
            e.md5 = String(
              await h.hash(f.path, {
                signal: sig,
                onProgress: p => {
                  live.set(e, p.bytes || 0)
                  emit()
                },
              }),
            ).toLowerCase()
          } catch (err) {
            if (isAbortError(err) || sig?.aborted) throw sig?.aborted ? abortError(sig) : err
            e.hashError = err // sumiu ou sem permissão: fica a conferência por tamanho, com nota
          } finally {
            live.delete(e)
          }
        }
        done++
        bytesDone += f.size
        emit()
      }
    }
    await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, need.length) }, worker))
    current = ''
    emit(true)
  } finally {
    if (own) await own.close().catch(() => {})
  }
}

function newAgg(relDir, name) {
  return {
    relDir,
    name,
    depth: relDir ? relDir.split('/').length : 0,
    files: 0,
    bytes: 0,
    synced: 0,
    missing: 0,
    missingBytes: 0,
    different: 0,
    differentBytes: 0,
    onlyDrive: 0,
    onlyDriveBytes: 0,
    elsewhere: 0,
    state: 'empty',
    existsLocal: false,
    existsDrive: false,
  }
}

/** Cada pasta (local ∪ Drive) com os números da SUBÁRVORE inteira dela. */
function aggregateFolders(files, { localDirs, remoteDirs, localCase, rootName }) {
  const agg = new Map()
  const ensure = relDir => {
    let a = agg.get(relDir)
    if (a) return a
    a = newAgg(relDir, relDir ? lastSeg(relDir) : rootName)
    agg.set(relDir, a)
    if (relDir) ensure(parentOf(relDir)) // ancestrais sempre presentes (a árvore da UI depende disso)
    return a
  }
  ensure('').existsLocal = true
  agg.get('').existsDrive = true
  for (const d of localDirs) ensure(d).existsLocal = true
  for (const d of remoteDirs) ensure(localCase(d)).existsDrive = true

  for (const x of files) {
    const size = x.local?.size ?? x.remote?.size ?? 0
    let d = x.relDir
    for (;;) {
      const a = ensure(d)
      a.files++
      a.bytes += size
      switch (x.status) {
        case 'synced':
          a.synced++
          break
        case 'elsewhere':
          a.synced++ // o conteúdo está no Drive (em outra pasta): conta como "já no Drive"
          a.elsewhere++
          break
        case 'missing':
          a.missing++
          a.missingBytes += size
          break
        case 'different':
          a.different++
          a.differentBytes += size
          break
        case 'only-drive':
          a.onlyDrive++
          a.onlyDriveBytes += size
          break
      }
      if (d === '') break
      d = parentOf(d)
    }
  }

  const folders = [...agg.values()]
  for (const a of folders) {
    if (a.files === 0) a.state = 'empty'
    else if (a.missing + a.different === 0) a.state = 'complete'
    else if (a.missing === a.files) a.state = 'missing'
    else a.state = 'partial'
  }
  return sortByPath(folders, a => a.relDir)
}

function summarize(files) {
  const s = {
    files: files.length,
    bytes: 0,
    synced: 0,
    syncedBytes: 0,
    missing: 0,
    missingBytes: 0,
    different: 0,
    differentBytes: 0,
    onlyDrive: 0,
    onlyDriveBytes: 0,
    elsewhere: 0,
    elsewhereBytes: 0,
  }
  for (const x of files) {
    const size = x.local?.size ?? x.remote?.size ?? 0
    s.bytes += size
    if (x.status === 'synced') {
      s.synced++
      s.syncedBytes += size
    } else if (x.status === 'missing') {
      s.missing++
      s.missingBytes += size
    } else if (x.status === 'different') {
      s.different++
      s.differentBytes += size
    } else if (x.status === 'only-drive') {
      s.onlyDrive++
      s.onlyDriveBytes += size
    } else if (x.status === 'elsewhere') {
      s.elsewhere++
      s.elsewhereBytes += size
    }
  }
  return s
}

// ─────────── persistência ───────────

async function saveCompare(result, paths) {
  const dir = paths.compares
  try {
    await writeJSONAtomic(path.join(dir, `${result.id}.json`), result)
  } catch (err) {
    // Sem gravar, a comparação continua valendo na memória do servidor; só não sobrevive a reiniciar.
    console.warn('[compare] não consegui gravar o resultado:', err?.message)
    return
  }
  await pruneCompares(dir).catch(() => {})
}

/** Guarda só os resultados mais recentes (ids crescem com o tempo). */
async function pruneCompares(dir) {
  const names = (await fs.readdir(dir)).filter(n => /^cmp[A-Za-z0-9_-]*\.json$/.test(n)).sort()
  const old = names.slice(0, Math.max(0, names.length - KEEP_COMPARES))
  await Promise.all(old.map(n => fs.rm(path.join(dir, n), { force: true }).catch(() => {})))
}

/** Resultado gravado de uma comparação, ou null se não existe (ou o id é inválido). */
export async function loadCompare(id, paths = dataPaths()) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null
  return readJSON(path.join(paths.compares, `${id}.json`), null)
}

