// Copiar de um link: pasta ou arquivo do Drive de outra pessoa (compartilhado com a conta ou aberto para quem tem o
// link) vai para uma pasta do Drive da conta. A cópia é do próprio Google (files.copy): nada passa pelo celular, só os
// pedidos. As pastas são recriadas com o mesmo nome, uma a uma (o Drive não copia pasta).
import { DriveError, FOLDER_MIME, driveCall } from './drive.js'
import { getState, setState } from './state.js'
import { keepAwake } from './wakelock.js'

const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'
const MAX_FILES = 5000 // acima disso o Drive web é o caminho: a varredura fica longa demais para o celular
const PARALLEL = 3

/**
 * Link do Drive → { id, resourceKey } (ou null). Aceita pasta (/drive/folders/ID, com /u/0/ e /mobile/), arquivo
 * (/file/d/ID), Documentos/Planilhas/Apresentações (/d/ID) e os antigos (?id=ID). O resourcekey vem na query.
 */
export function parseDriveLink(text) {
  const raw = String(text || '').match(/https?:\/\/[^\s<>"']+/)?.[0]
  if (!raw) return null
  let u
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (!/(^|\.)(drive|docs)\.google\.com$/.test(u.hostname)) return null
  const id = /\/folders\/([\w-]{10,})/.exec(u.pathname)?.[1] || /\/d\/([\w-]{10,})/.exec(u.pathname)?.[1] || (/^[\w-]{10,}$/.test(u.searchParams.get('id') || '') ? u.searchParams.get('id') : null)
  if (!id) return null
  return { id, resourceKey: u.searchParams.get('resourcekey') || null, url: raw }
}

const keysHeader = (pairs) => {
  const v = pairs.filter((p) => p.resourceKey).map((p) => `${p.id}/${p.resourceKey}`).join(',')
  return v ? { 'X-Goog-Drive-Resource-Keys': v } : {}
}

const ITEM = 'id,name,mimeType,size,resourceKey,shortcutDetails(targetId,targetMimeType,targetResourceKey),capabilities(canCopy)'

/** O que o link aponta, com dono. Atalho vira o item de verdade. */
async function getItem(ref, signal) {
  const r = await driveCall(`/files/${encodeURIComponent(ref.id)}`, {
    query: { supportsAllDrives: true, fields: `${ITEM},owners(displayName),driveId` },
    headers: keysHeader([ref]),
    signal,
    retries: 2,
  })
  if (r.mimeType === SHORTCUT_MIME && r.shortcutDetails?.targetId) {
    return getItem({ id: r.shortcutDetails.targetId, resourceKey: r.shortcutDetails.targetResourceKey || null }, signal)
  }
  return r
}

async function children(folder, signal) {
  const out = []
  let pageToken
  do {
    const r = await driveCall('/files', {
      query: {
        q: `'${folder.id}' in parents and trashed = false`,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        pageSize: 1000,
        fields: `nextPageToken,files(${ITEM})`,
        pageToken,
      },
      headers: keysHeader([folder]),
      signal,
    })
    out.push(...(r.files || []))
    pageToken = r.nextPageToken
  } while (pageToken)
  return out
}

/** Erro de leitura do link → frase de gente. */
export function readError(err) {
  if (err?.status === 0) return 'Sem conexão com o Google. Confira a internet.'
  if (err?.status === 404 || err?.status === 403) return 'Esta conta não abre esse link. Peça para liberarem para quem tem o link, ou para o seu e-mail.'
  return 'Não consegui abrir esse link agora. Tente de novo.'
}

/** Erro de um arquivo na cópia → { why, stop }. `stop`: não adianta seguir (Drive cheio, por exemplo). */
function copyError(err) {
  const r = err?.reason || ''
  if (r === 'storageQuotaExceeded' || r === 'quotaExceeded') return { why: 'Seu Drive está cheio.', stop: true }
  if (r === 'teamDriveFileLimitExceeded' || r === 'numChildrenInNonRootLimitExceeded') return { why: 'O destino chegou no limite de arquivos do Google.', stop: true }
  if (r === 'userRateLimitExceeded' && /daily|750/i.test(err?.message || '')) return { why: 'Você chegou no limite diário de cópia do Google (750 GB). Continue amanhã.', stop: true }
  if (r === 'cannotCopyFile' || r === 'fileNotCopyable' || r === 'cannotDownloadFile') return { why: 'O dono bloqueou cópia e download.', stop: false }
  if (err?.status === 404) return { why: 'Sumiu do link ou deixou de estar liberado.', stop: false }
  if (err?.status === 0) return { why: 'Sem conexão com o Google.', stop: true }
  return { why: err?.message || 'O Google recusou a cópia.', stop: false }
}

// ───── o trabalho (um por vez, no estado do app: a folha mostra e pode fechar e voltar) ─────

let ctl = null

function patch(p) {
  setState((s) => ({ copia: s.copia ? { ...s.copia, ...p } : s.copia }))
}

/** Lê o link e monta a lista do que vai ser copiado. Estado: copia.status 'lendo' → 'pronto' | 'erro'. */
export async function inspect(text) {
  const ref = parseDriveLink(text)
  if (!ref) return setState({ copia: { status: 'erro', error: 'Cole um link do Google Drive (pasta ou arquivo).' } })
  ctl?.abort()
  ctl = new AbortController()
  const signal = ctl.signal
  const keep = getState().copia?.dest || null
  setState({ copia: { status: 'lendo', link: ref.url, dest: keep, found: 0 } })
  try {
    const root = await getItem(ref, signal)
    const isFolder = root.mimeType === FOLDER_MIME
    const plan = { root: { id: root.id, name: root.name, resourceKey: root.resourceKey || ref.resourceKey || null, folder: isFolder }, owner: root.owners?.[0]?.displayName || null, folders: [], files: [], skipped: [], blocked: 0, bytes: 0 }
    if (!isFolder) {
      plan.files.push({ ...root, parent: null, path: '' })
    } else {
      const queue = [{ ...plan.root, path: '' }]
      while (queue.length) {
        const f = queue.shift()
        for (const c of await children(f, signal)) {
          const path = f.path ? `${f.path}/${c.name}` : c.name
          if (c.mimeType === FOLDER_MIME) {
            plan.folders.push({ id: c.id, name: c.name, resourceKey: c.resourceKey || null, parent: f.id })
            queue.push({ id: c.id, name: c.name, resourceKey: c.resourceKey || null, path })
          } else if (c.mimeType === SHORTCUT_MIME) plan.skipped.push({ name: path, why: 'Atalho para outro lugar do Drive.' })
          else plan.files.push({ ...c, parent: f.id, path })
          if (plan.files.length > MAX_FILES) throw new DriveError(0, 'tooMany', `Mais de ${MAX_FILES} arquivos: copie por partes (uma subpasta por vez).`)
        }
        patch({ found: plan.files.length })
      }
    }
    for (const f of plan.files) {
      plan.bytes += Number(f.size) || 0
      if (f.capabilities?.canCopy === false) plan.blocked++
    }
    if (signal.aborted) return
    patch({ status: 'pronto', plan })
  } catch (err) {
    if (signal.aborted) return
    patch({ status: 'erro', error: err?.reason === 'tooMany' ? err.message : readError(err) })
  }
}

export function setCopyDest(dest) {
  setState((s) => ({ copia: { ...(s.copia || { status: 'vazio' }), dest } }))
}

export function resetCopy() {
  ctl?.abort()
  ctl = null
  keepAwake(false)
  setState((s) => ({ copia: s.copia?.dest ? { status: 'vazio', dest: s.copia.dest } : null }))
}

export function stopCopy() {
  ctl?.abort()
}

/** Copia o plano para copia.dest. Pasta do link → uma pasta com o mesmo nome dentro do destino. */
export async function runCopy() {
  const st = getState().copia
  const plan = st?.plan
  const dest = st?.dest
  if (!plan || !dest || st.status === 'copiando') return
  ctl?.abort()
  ctl = new AbortController()
  const signal = ctl.signal
  const todo = plan.files.filter((f) => f.capabilities?.canCopy !== false)
  const failed = plan.files.filter((f) => f.capabilities?.canCopy === false).map((f) => ({ name: f.path || f.name, why: 'O dono bloqueou cópia e download.' }))
  const bytesTotal = todo.reduce((t, f) => t + (Number(f.size) || 0), 0)
  patch({ status: 'copiando', done: 0, total: todo.length, bytesDone: 0, bytesTotal, current: null, failed, newFolder: null, stopped: null })
  keepAwake(true)
  const made = new Map() // id da pasta de origem → id da pasta nova
  const mkdir = (name, parent) =>
    driveCall('/files', {
      method: 'POST',
      query: { supportsAllDrives: true, fields: 'id' },
      body: { name, mimeType: FOLDER_MIME, parents: [parent] },
      signal,
      retries: 3,
    }).then((r) => r.id)
  let stopped = null
  try {
    if (plan.root.folder) {
      const top = await mkdir(plan.root.name, dest.id)
      made.set(plan.root.id, top)
      patch({ newFolder: top })
      for (const f of plan.folders) made.set(f.id, await mkdir(f.name, made.get(f.parent)))
    }
    let next = 0
    let done = 0
    let bytesDone = 0
    const worker = async () => {
      while (!stopped && !signal.aborted && next < todo.length) {
        const f = todo[next++]
        patch({ current: f.path || f.name })
        try {
          await driveCall(`/files/${encodeURIComponent(f.id)}/copy`, {
            method: 'POST',
            query: { supportsAllDrives: true, fields: 'id' },
            body: { name: f.name, parents: [f.parent ? made.get(f.parent) : dest.id] },
            headers: keysHeader([f]),
            signal,
            retries: 5,
          })
          bytesDone += Number(f.size) || 0
        } catch (err) {
          if (signal.aborted) return
          const e = copyError(err)
          failed.push({ name: f.path || f.name, why: e.why })
          if (e.stop) stopped = e.why
        }
        done++
        patch({ done, bytesDone, failed: [...failed] })
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker))
  } catch (err) {
    if (!signal.aborted) stopped = copyError(err).why
  } finally {
    keepAwake(false)
  }
  patch({ status: signal.aborted ? 'parado' : 'feito', stopped, current: null })
}
