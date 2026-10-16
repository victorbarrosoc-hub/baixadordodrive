// "Gerar miniaturas" (tela Drive): miniatura para os RAW que JÁ estão no Drive, sem enviar nada de novo.
//
// O Drive não gera miniatura de .braw/.r3d e o motor só gravava a nossa na hora do envio. Aqui a pessoa aponta onde
// estão os originais (HD, cartão da câmera); o motor:
//  1. lista os RAW da pasta do Drive (e subpastas, se pedido) que não têm miniatura (ou todos, com `refazer`);
//  2. varre a pasta do computador atrás de RAW (com limites: sem ocultas/sistema, sem seguir links, profundidade e
//     quantidade de itens com teto);
//  3. casa cada arquivo do Drive com um do computador pelo NOME (sem diferenciar maiúsculas, NFC/NFD iguais, como
//     o comparador) + TAMANHO igual. Nome igual com tamanho diferente não serve (pode ser outra tomada);
//  4. tira o frame com o mesmo extrator dos envios (mesma fila: no máximo 2 decodificações de RAW ao mesmo tempo)
//     e grava como miniatura do arquivo do Drive (`setThumbnail`, contentHints.thumbnail).
// Nada daqui derruba o motor: falha de um arquivo vira "falhou (motivo)" e o lote segue; cancelar para tudo.
import fs from 'node:fs/promises'
import path from 'node:path'
import { FOLDER_MIME } from '../google/drive.js'
import { classifyError } from '../google/errors.js'
import { abortError, isAbortError } from '../util/backoff.js'
import { isJunkFile } from '../util/paths.js'
import { mapLimit } from '../local/fsbrowse.js'
import { MAX_THUMB_BYTES, imageMime, isRawThumbCandidate } from './raw-thumb.js'

/** Tetos da varredura local: um HD inteiro escolhido por engano não pode travar o app. */
export const LOTE_LIMITS = Object.freeze({
  maxDepth: 24, // níveis de pasta abaixo da escolhida
  maxEntries: 400_000, // itens (arquivos + pastas) olhados no total
  dirConcurrency: 6, // pastas lidas ao mesmo tempo
  maxDetails: 200, // nomes guardados em cada lista do resultado (o resto só conta)
})

// Pastas de sistema que nunca têm original de câmera (e às vezes nem deixam ler).
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'recovery', 'config.msi', 'node_modules', 'lost+found'])

/** Chave de comparação de nomes: NFC (o macOS grava NFD) e sem diferenciar maiúsculas. */
export function nameKey(name) {
  return String(name ?? '').normalize('NFC').toLowerCase()
}

function skipDir(name) {
  return name.startsWith('.') || name.startsWith('$') || SKIP_DIRS.has(name.toLowerCase()) || isJunkFile(name)
}

function badRequest(message) {
  const err = new Error(message)
  err.status = 400
  return err
}

/**
 * Varre `dir` atrás de RAW (.braw/.r3d). Não segue links simbólicos e pula pastas já vistas (dev+inode), ocultas
 * e de sistema. Devolve { byName: Map<nameKey, Array<{ path, size }>>, files, dirs, truncated, skipped }.
 * `accept(name)` troca o filtro de arquivos (o "Gerar prévias" procura vídeos).
 */
export async function indexLocalRaw(dir, { signal, limits = LOTE_LIMITS, onProgress, accept = isRawThumbCandidate } = {}) {
  const lim = { ...LOTE_LIMITS, ...limits }
  let st
  try {
    st = await fs.stat(dir)
  } catch (err) {
    throw badRequest(err?.code === 'ENOENT' ? 'Não achei essa pasta no computador. O disco ou o cartão está conectado?' : 'Não consegui abrir essa pasta do computador.')
  }
  if (!st.isDirectory()) throw badRequest('Escolha uma pasta do computador (não um arquivo).')
  const byName = new Map()
  const seen = new Set([`${st.dev}:${st.ino}`])
  const out = { byName, files: 0, dirs: 1, entries: 0, truncated: false, skipped: 0 }
  let level = [dir]
  for (let depth = 0; level.length && depth <= lim.maxDepth; depth++) {
    const next = []
    await mapLimit(level, lim.dirConcurrency, async abs => {
      if (signal?.aborted || out.truncated) return
      let handle
      try {
        handle = await fs.opendir(abs, { bufferSize: 256 })
      } catch {
        out.skipped++ // sem permissão, sumiu (cartão tirado): segue com o resto
        return
      }
      const raws = []
      try {
        for await (const d of handle) {
          if (signal?.aborted) break
          if (++out.entries > lim.maxEntries) {
            out.truncated = true
            break
          }
          const name = d.name
          if (d.isSymbolicLink()) continue
          if (d.isDirectory()) {
            if (skipDir(name)) continue
            if (depth >= lim.maxDepth) {
              out.truncated = true
              continue
            }
            next.push(path.join(abs, name))
          } else if (d.isFile() && !name.startsWith('._') && accept(name)) {
            raws.push(name)
          }
        }
      } catch {
        out.skipped++
      }
      for (const name of raws) {
        if (signal?.aborted) return
        const p = path.join(abs, name)
        try {
          const s = await fs.stat(p)
          if (!s.isFile()) continue
          const key = nameKey(name)
          const list = byName.get(key)
          const entry = { path: p, size: s.size }
          if (list) list.push(entry)
          else byName.set(key, [entry])
          out.files++
        } catch {
          out.skipped++
        }
      }
      try {
        onProgress?.({ files: out.files, dirs: out.dirs, current: abs })
      } catch {}
    })
    if (signal?.aborted) throw abortError(signal)
    // Pastas já vistas (montagens repetidas, junções do Windows): um stat por pasta, barato perto de ler a pasta.
    level = []
    for (const p of next) {
      try {
        const s = await fs.stat(p)
        const id = `${s.dev}:${s.ino}`
        if (s.ino && seen.has(id)) continue
        seen.add(id)
      } catch {
        continue
      }
      out.dirs++
      level.push(p)
    }
  }
  if (signal?.aborted) throw abortError(signal)
  // Ordem estável entre execuções (o primeiro de mesmo tamanho é o escolhido).
  for (const list of byName.values()) list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}

/**
 * RAW da pasta do Drive. `recursive`: subpastas também (walk). Lixeira fica de fora (as consultas já filtram).
 * Atalhos não entram: a miniatura iria para o arquivo de outra pasta (talvez de outra pessoa).
 * Devolve { root, items: DriveItem[] (com hasThumbnail e relPath) }.
 */
export async function listDriveRaw(drive, folderId, { recursive = true, signal, onProgress } = {}) {
  let root
  try {
    root = await drive.getItem(folderId, { signal })
    if (root.isShortcut && root.shortcutTargetId && root.shortcutTargetMimeType === FOLDER_MIME) root = await drive.getItem(root.shortcutTargetId, { signal, resourceKey: root.shortcutTargetResourceKey || undefined })
  } catch (err) {
    if (classifyError(err).kind === 'notfound') {
      const e = new Error('Não achei esta pasta no Drive. Ela pode ter sido apagada, movida ou deixado de ser compartilhada com você.')
      e.status = 404
      throw e
    }
    throw err
  }
  if (!root.isFolder) throw badRequest('Escolha uma pasta do Drive (não um arquivo).')
  let items
  if (recursive) {
    items = (await drive.walk(root.id, { signal, media: true, onProgress: p => onProgress?.({ files: p.files }) })).items
  } else {
    items = await drive.listChildren(root.id, { signal, media: true })
    for (const it of items) it.relPath = it.name
  }
  return { root, items: items.filter(it => !it.isFolder && !it.isShortcut && !it.isGoogleDoc && it.size != null && isRawThumbCandidate(it.name)) }
}

function newSummary() {
  return {
    phase: 'drive', // 'drive' → 'local' → 'gerar' → 'fim'
    raw: 0, // RAW achados no Drive
    jaTinham: 0, // já tinham miniatura (e `refazer` desligado)
    total: 0, // RAW que precisam de miniatura
    aGerar: 0, // com par no computador
    feitos: 0,
    semLocal: 0,
    tamanhoDiferente: 0,
    falhou: 0,
    localFiles: 0, // RAW achados no computador
    localTruncated: false,
    current: '',
    falhas: [], // [{ name, reason }]
    semLocalNomes: [],
    tamanhoNomes: [], // [{ name, drive, local }]
    feitosIds: [], // ids do Drive que ganharam miniatura (a tela renova essas miniaturas)
  }
}

/**
 * Roda o lote. Nunca deixa um arquivo derrubar o resto; só lança em erro "do lote" (pasta inválida, Drive fora,
 * cancelado → AbortError).
 * @param {object} o
 * @param {import('../google/drive.js').DriveClient} o.drive
 * @param {string} o.driveFolderId
 * @param {string} o.localDir caminho absoluto
 * @param {boolean} [o.recursive] subpastas do Drive (padrão true)
 * @param {boolean} [o.refazer] grava também nos que já têm miniatura
 * @param {(file: string, { signal }) => Promise<{ buf: Buffer|null, reason: string|null }>} o.frame
 *   extrator (RawThumbnailer.frameFor: mesma fila e mesmos limites dos envios)
 * @param {number} [o.concurrency] arquivos em andamento ao mesmo tempo (a fila do extrator manda no resto)
 * @param {(p: object) => void} [o.onProgress] recebe o resumo (o mesmo objeto, atualizado)
 */
export async function gerarMiniaturasLote({ drive, driveFolderId, localDir, recursive = true, refazer = false, frame, signal, onProgress, concurrency = 2, limits } = {}) {
  if (!drive || typeof frame !== 'function') throw new Error('gerarMiniaturasLote: drive e frame são obrigatórios')
  if (signal?.aborted) throw abortError(signal)
  const lim = { ...LOTE_LIMITS, ...limits }
  const s = newSummary()
  const report = () => {
    try {
      onProgress?.(s)
    } catch {}
  }
  const keep = (list, v) => {
    if (list.length < lim.maxDetails) list.push(v)
  }
  report()

  // 1 + 2: Drive e disco ao mesmo tempo (um é rede, o outro é disco). Se um falhar, o outro para.
  const inner = new AbortController()
  const sig = signal ? AbortSignal.any([signal, inner.signal]) : inner.signal
  let failure = null
  const guard = p => {
    const g = p.catch(err => {
      failure ??= err
      inner.abort()
      throw err
    })
    g.catch(() => {})
    return g
  }
  const driveP = guard(listDriveRaw(drive, driveFolderId, { recursive, signal: sig }))
  const localP = guard(indexLocalRaw(localDir, { signal: sig, limits: lim, onProgress: p => ((s.localFiles = p.files), s.phase === 'local' && report()) }))
  let listed
  let local
  try {
    listed = await driveP
    s.raw = listed.items.length
    s.phase = 'local'
    report()
    local = await localP
  } catch (err) {
    if (signal?.aborted) throw abortError(signal)
    throw failure ?? err
  }
  s.localFiles = local.files
  s.localTruncated = local.truncated

  // 3: pares por nome + tamanho.
  const work = []
  for (const it of listed.items) {
    if (it.hasThumbnail && !refazer) {
      s.jaTinham++
      continue
    }
    s.total++
    const list = local.byName.get(nameKey(it.name))
    if (!list?.length) {
      s.semLocal++
      keep(s.semLocalNomes, it.relPath || it.name)
      continue
    }
    const hit = list.find(l => l.size === it.size)
    if (!hit) {
      s.tamanhoDiferente++
      keep(s.tamanhoNomes, { name: it.relPath || it.name, drive: it.size, local: list[0].size })
      continue
    }
    work.push({ item: it, local: hit })
  }
  s.aGerar = work.length
  s.phase = 'gerar'
  report()

  // 4: frame + gravar no Drive. Erro de um arquivo não para os outros; cancelar para tudo.
  const fail = (it, reason) => {
    s.falhou++
    keep(s.falhas, { name: it.relPath || it.name, reason: String(reason || 'sem motivo').slice(0, 300) })
  }
  let next = 0
  const worker = async () => {
    while (next < work.length) {
      if (signal?.aborted) return
      const { item, local: lf } = work[next++]
      s.current = item.relPath || item.name
      report()
      try {
        const { buf, reason } = await frame(lf.path, { signal })
        if (signal?.aborted) return
        const mime = buf ? imageMime(buf) : null
        if (!buf) fail(item, reason || 'sem miniatura')
        else if (!mime || buf.length > MAX_THUMB_BYTES) fail(item, 'a imagem ficou inválida ou grande demais')
        else {
          try {
            await drive.setThumbnail(item.id, buf, mime, { signal })
            s.feitos++
            if (s.feitosIds.length < 5000) s.feitosIds.push(item.id)
          } catch (err) {
            if (signal?.aborted || isAbortError(err)) return
            const info = classifyError(err)
            fail(item, info.kind === 'fatal' && info.status === 403 ? 'o Drive não deixou alterar este arquivo (sem permissão de edição)' : `o Drive recusou: ${info.message || err?.message || err}`)
          }
        }
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) return
        fail(item, err?.message || String(err))
      }
      report()
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, work.length)) }, worker))
  if (signal?.aborted) throw abortError(signal)
  s.current = ''
  s.phase = 'fim'
  report()
  return s
}

/** Resumo curto ("12 miniaturas gravadas · 3 sem arquivo no computador · 1 com tamanho diferente"). */
export function resumoLote(s) {
  if (!s) return ''
  const n = (v, one, many) => `${v} ${v === 1 ? one : many}`
  if (!s.total) return s.jaTinham ? `Nada a fazer: ${n(s.jaTinham, 'RAW já tinha miniatura', 'RAW já tinham miniatura')}.` : 'Nenhum RAW sem miniatura nesta pasta.'
  const parts = [n(s.feitos, 'miniatura gravada', 'miniaturas gravadas')]
  if (s.semLocal) parts.push(`${s.semLocal} sem arquivo no computador`)
  if (s.tamanhoDiferente) parts.push(`${s.tamanhoDiferente} com tamanho diferente`)
  if (s.falhou) parts.push(n(s.falhou, 'falhou', 'falharam'))
  return parts.join(' · ')
}
