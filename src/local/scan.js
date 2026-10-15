// Varredura recursiva de uma pasta local (para subir pastas e para o comparador).
// Precisa aguentar pastas com 100 mil arquivos: lê várias pastas ao mesmo tempo e faz os stat em paralelo.
import fs from 'node:fs/promises'
import path from 'node:path'
import { isJunkFile, toNFC } from '../util/paths.js'
import { abortError } from '../util/backoff.js'
import { expandHome, fsError, mapLimit } from './fsbrowse.js'

const DIR_CONCURRENCY = 8 // pastas lidas ao mesmo tempo
const STAT_CONCURRENCY = 16 // stat simultâneos por pasta (8 × 16 no máximo)
const PROGRESS_MS = 200 // no máximo 5 avisos de progresso por segundo

function skipReason(err) {
  const code = err?.code
  if (code === 'EACCES' || code === 'EPERM') return 'Sem permissão para ler.'
  if (code === 'ENOENT') return 'Sumiu durante a leitura.'
  return `Não consegui ler (${code || err?.message || 'erro'}).`
}

/**
 * Lista todos os arquivos de uma pasta (ou um arquivo só).
 * Ignora lixo de sistema (isJunkFile); links simbólicos, itens especiais e pastas sem permissão vão para `skipped`.
 * @param {string} rootPath
 * @param {{ signal?: AbortSignal, onProgress?: (p: { files: number, bytes: number, dirs: number, current: string }) => void }} [opts]
 * @returns {Promise<{ root: { path, name, isDir }, files: Array<{ relPath, relDir, name, path, size, mtimeMs }>, dirs: string[], skipped: Array<{ path, reason }> }>}
 *   relPath/relDir/name em NFC com '/', relativos à pasta escolhida (sem o nome dela); `dirs` = subpastas (sem a raiz '').
 */
export async function scanLocal(rootPath, { signal, onProgress } = {}) {
  if (signal?.aborted) throw abortError(signal)
  const rootAbs = expandHome(rootPath)
  let st
  try {
    st = await fs.stat(rootAbs)
  } catch (err) {
    throw fsError(err, rootAbs, 'item')
  }
  // Checa de novo antes de registrar o listener: um abort durante o stat não dispararia o evento depois.
  if (signal?.aborted) throw abortError(signal)
  const rootName = toNFC(path.basename(rootAbs) || rootAbs)

  if (!st.isDirectory()) {
    if (!st.isFile()) {
      const err = new Error('Isso não é um arquivo nem uma pasta.')
      err.status = 400
      throw err
    }
    // Arquivo escolhido explicitamente: entra mesmo que pareça lixo de sistema.
    return {
      root: { path: rootAbs, name: rootName, isDir: false },
      files: [{ relPath: rootName, relDir: '', name: rootName, path: rootAbs, size: st.size, mtimeMs: st.mtimeMs }],
      dirs: [],
      skipped: [],
    }
  }

  const files = []
  const dirs = []
  const skipped = []
  const counters = { files: 0, bytes: 0, dirs: 0 }
  let lastEmit = 0
  let current = ''
  let failure = null

  const emit = (force = false) => {
    if (!onProgress) return
    const now = Date.now()
    if (!force && now - lastEmit < PROGRESS_MS) return
    lastEmit = now
    onProgress({ files: counters.files, bytes: counters.bytes, dirs: counters.dirs, current })
  }

  // Fila de pastas compartilhada pelos leitores. `active` conta pastas em leitura (que ainda podem achar subpastas).
  const queue = [{ abs: rootAbs, rel: '' }]
  let head = 0
  let active = 0
  let waiters = []
  const wake = () => {
    const list = waiters
    waiters = []
    for (const resolve of list) resolve()
  }
  const onAbort = () => {
    failure ??= abortError(signal)
    wake()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  async function takeDir() {
    for (;;) {
      if (failure) return null
      if (head < queue.length) {
        active++ // marca já, antes de ceder a vez, para ninguém achar que acabou
        const item = queue[head]
        queue[head++] = null
        return item
      }
      if (active === 0) return null
      await new Promise(resolve => waiters.push(resolve))
    }
  }

  async function statFile(f) {
    if (failure) throw failure
    let s
    try {
      s = await fs.lstat(f.abs)
    } catch (err) {
      if (err.code !== 'ENOENT') skipped.push({ path: f.abs, reason: skipReason(err) })
      return
    }
    if (!s.isFile()) return
    files.push({ relPath: f.rel, relDir: f.relDir, name: f.name, path: f.abs, size: s.size, mtimeMs: s.mtimeMs })
    counters.files++
    counters.bytes += s.size
    emit()
  }

  async function readDir(item) {
    current = item.rel
    let dir
    try {
      dir = await fs.opendir(item.abs, { bufferSize: 256 })
    } catch (err) {
      if (item.rel === '') throw fsError(err, item.abs)
      if (err.code !== 'ENOENT') skipped.push({ path: item.abs, reason: skipReason(err) })
      return
    }
    const pending = []
    try {
      // for await fecha o Dir sozinho ao terminar, ao sair com erro ou ao interromper.
      for await (const d of dir) {
        if (failure) throw failure
        const raw = d.name
        if (isJunkFile(raw)) continue
        const abs = path.join(item.abs, raw)
        const name = toNFC(raw)
        const rel = item.rel ? `${item.rel}/${name}` : name
        if (d.isSymbolicLink()) {
          skipped.push({ path: abs, reason: 'Link simbólico (atalho) ignorado.' })
        } else if (d.isDirectory()) {
          dirs.push(rel)
          counters.dirs++
          queue.push({ abs, rel })
          wake()
        } else if (d.isFile()) {
          pending.push({ abs, rel, relDir: item.rel, name })
        } else {
          // FIFO, socket, dispositivo: ler isso travaria o envio.
          skipped.push({ path: abs, reason: 'Não é um arquivo comum.' })
        }
      }
    } catch (err) {
      if (failure) throw failure
      // Erro no meio da leitura (ex.: disco desconectado): fica com o que deu para ler.
      skipped.push({ path: item.abs, reason: skipReason(err) })
    }
    await mapLimit(pending, STAT_CONCURRENCY, statFile)
    emit()
  }

  async function reader() {
    for (;;) {
      const item = await takeDir()
      if (!item) break
      try {
        await readDir(item)
      } catch (err) {
        failure ??= err
      } finally {
        active--
        wake()
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: DIR_CONCURRENCY }, reader))
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  if (failure) throw failure

  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  dirs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  // Num disco Linux podem existir dois nomes iguais em NFC (um com acento "composto", outro "decomposto").
  // O Drive guarda NFC, então só o primeiro entra; o outro é avisado.
  const unique = []
  for (const f of files) {
    if (unique.length && unique[unique.length - 1].relPath === f.relPath) {
      skipped.push({ path: f.path, reason: 'Nome repetido (o mesmo nome com acentos gravados de outro jeito).' })
      counters.files--
      counters.bytes -= f.size
      continue
    }
    unique.push(f)
  }

  current = ''
  emit(true)
  return { root: { path: rootAbs, name: rootName, isDir: true }, files: unique, dirs: [...new Set(dirs)], skipped }
}
