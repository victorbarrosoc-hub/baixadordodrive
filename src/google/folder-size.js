// Tamanho de uma pasta do Drive. O Google não guarda o tamanho de pastas: a conta é feita aqui, descendo a árvore.
// Barato de propósito: só id, tipo e tamanho de cada item (páginas de 1000), poucas listagens ao mesmo tempo,
// sem lixeira, sem seguir atalhos (eles contam à parte) e Docs do Google contam 0 (não ocupam bytes de arquivo).
// A mesma conta existe no app do celular (web/public/app/lib/tamanho.js); os testes conferem as duas.
import { abortError } from '../util/backoff.js'
import { classifyError } from './errors.js'

export const FOLDER_MIME = 'application/vnd.google-apps.folder'
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'
const GAPPS_PREFIX = 'application/vnd.google-apps.'

/** `fields` da varredura: o mínimo para somar (o resto só pesa na resposta). */
export const SIZE_LIST_FIELDS = 'nextPageToken,files(id,mimeType,size)'
const PROGRESS_MS = 200

export function emptySize() {
  return { bytes: 0, files: 0, folders: 0, docs: 0, shortcuts: 0, pending: 0 }
}

/**
 * Soma a árvore de `rootId`.
 * `listPage(folderId, pageToken, signal)` → `{ files: [{ id, mimeType, size }], nextPageToken }` (já sem lixeira).
 * `onProgress(counters)` no máximo a cada `progressMs` e uma última vez no fim.
 * Pasta que some no meio da conta (apagada, sem acesso) é pulada; outro erro derruba a conta.
 * Cancelada (signal): rejeita com AbortError e `err.partial` = o que já tinha somado.
 * @returns {Promise<{ bytes, files, folders, docs, shortcuts, pending: 0 }>}
 *   files inclui os docs; folders não conta a própria raiz.
 */
export async function walkFolderSize({ listPage, rootId, signal, onProgress, concurrency = 4, progressMs = PROGRESS_MS }) {
  if (signal?.aborted) throw withPartial(abortError(signal), emptySize())
  const inner = new AbortController()
  const sig = signal ? AbortSignal.any([signal, inner.signal]) : inner.signal
  const c = emptySize()
  const queue = [rootId]
  const seen = new Set([rootId])
  let head = 0
  let active = 0
  let failure = null
  let waiters = []
  let lastEmit = 0

  const wake = () => {
    const list = waiters
    waiters = []
    for (const resolve of list) resolve()
  }
  const fail = err => {
    failure ??= err
    inner.abort()
    wake()
  }
  const emit = (force = false) => {
    if (!onProgress) return
    const now = Date.now()
    if (!force && now - lastEmit < progressMs) return
    lastEmit = now
    c.pending = queue.length - head + active
    try {
      onProgress({ ...c })
    } catch {
      // progresso é só informativo
    }
  }
  const add = f => {
    const mime = f?.mimeType || ''
    if (mime === FOLDER_MIME) {
      c.folders++
      if (f.id && !seen.has(f.id)) {
        seen.add(f.id)
        queue.push(f.id)
      }
    } else if (mime === SHORTCUT_MIME) c.shortcuts++
    else {
      c.files++
      if (mime.startsWith(GAPPS_PREFIX)) c.docs++
      else {
        const n = Number(f.size)
        if (Number.isFinite(n) && n > 0) c.bytes += n
      }
    }
  }

  const lister = async () => {
    for (;;) {
      if (failure || sig.aborted) return
      if (head < queue.length) {
        const id = queue[head++]
        active++
        try {
          let pageToken
          do {
            const r = await listPage(id, pageToken, sig)
            for (const f of r?.files || []) add(f)
            pageToken = r?.nextPageToken || undefined
            emit()
          } while (pageToken && !sig.aborted)
        } catch (err) {
          const info = classifyError(err)
          const gone = info.kind === 'notfound' || (info.kind === 'fatal' && info.status === 403)
          // A raiz precisa existir; uma subpasta que sumiu no caminho só fica de fora.
          if (id === rootId || !gone) fail(err)
        } finally {
          active--
          wake()
        }
      } else if (active === 0) {
        wake()
        return
      } else {
        await new Promise(resolve => waiters.push(resolve))
      }
    }
  }

  const n = Math.max(1, Math.floor(concurrency) || 1)
  await Promise.all(Array.from({ length: n }, lister))
  c.pending = queue.length - head
  if (signal?.aborted) throw withPartial(abortError(signal), { ...c })
  if (failure) throw withPartial(failure, { ...c })
  c.pending = 0
  emit(true)
  return { ...c }
}

function withPartial(err, partial) {
  try {
    err.partial = partial
  } catch {
    // erro congelado: segue sem o parcial
  }
  return err
}
