// Copiar de um link: pasta ou arquivo do Drive de outra pessoa (compartilhado com a conta ou aberto para quem tem o
// link, com resourcekey quando o link traz) vai para uma pasta do Drive da conta. A cópia é do próprio Google
// (files.copy): nada passa por este computador, só os pedidos. Pastas são recriadas com o mesmo nome (o Drive não
// copia pasta). O mesmo fluxo do celular (web/public/app/lib/copiar.js).
import { FOLDER_MIME, SHORTCUT_MIME, toDriveItem } from './drive.js'
import { SobeDesceError, classifyError } from './errors.js'

export const MAX_COPY_FILES = 5000
const PARALLEL = 3
// O que a cópia devolve: o bastante para baixar dela depois (md5 e revisão para conferir).
const COPY_FIELDS = 'id,name,mimeType,size,md5Checksum,modifiedTime,headRevisionId,capabilities(canDownload)'
// Os campos do download também (md5, revisão): com "Também baixar para…" o plano vira downloads sem ler de novo.
const ITEM = 'id,name,mimeType,size,md5Checksum,modifiedTime,headRevisionId,resourceKey,shortcutDetails(targetId,targetMimeType,targetResourceKey),capabilities(canCopy,canDownload)'

/**
 * Link do Drive → { id, resourceKey, url } (ou null). Pasta (/drive/folders/ID, com /u/0/ e /mobile/), arquivo
 * (/file/d/ID), Documentos/Planilhas/Apresentações (/d/ID) e os antigos (?id=ID); o resourcekey vem na query.
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
  const qid = u.searchParams.get('id') || ''
  const id = /\/folders\/([\w-]{10,})/.exec(u.pathname)?.[1] || /\/d\/([\w-]{10,})/.exec(u.pathname)?.[1] || (/^[\w-]{10,}$/.test(qid) ? qid : null)
  if (!id) return null
  const rk = u.searchParams.get('resourcekey')
  return { id, resourceKey: rk && /^[\w-]{1,200}$/.test(rk) ? rk : null, url: raw }
}

const keysHeader = (...items) => {
  const v = items.filter(p => p?.resourceKey).map(p => `${p.id}/${p.resourceKey}`).join(',')
  return v ? { 'x-goog-drive-resource-keys': v } : undefined
}

/** Erro ao ler o link → mensagem de gente. */
export function readErrorMessage(err) {
  const info = classifyError(err)
  if (info.kind === 'abort') return 'Interrompido.'
  if (info.status === 404 || info.status === 403) return 'Esta conta não abre esse link. Peça para liberarem para quem tem o link, ou para o seu e-mail.'
  if (info.kind === 'retry') return 'Sem conexão com o Google. Confira a internet.'
  return info.message || 'Não consegui abrir esse link agora. Tente de novo.'
}

async function getItem(drive, ref, signal, depth = 0) {
  const r = await drive.api('GET', `files/${encodeURIComponent(ref.id)}`, {
    query: { fields: `${ITEM},owners(displayName)` },
    headers: keysHeader(ref),
    signal,
    retries: 2,
  })
  if (r.mimeType === SHORTCUT_MIME && r.shortcutDetails?.targetId && depth < 2) {
    return getItem(drive, { id: r.shortcutDetails.targetId, resourceKey: r.shortcutDetails.targetResourceKey || null }, signal, depth + 1)
  }
  return r
}

async function children(drive, folder, signal) {
  const out = []
  let pageToken
  do {
    const r = await drive.api('GET', 'files', {
      query: {
        q: `'${String(folder.id).replace(/['\\]/g, '')}' in parents and trashed = false`,
        includeItemsFromAllDrives: 'true',
        pageSize: 1000,
        fields: `nextPageToken,files(${ITEM})`,
        pageToken,
      },
      headers: keysHeader(folder),
      signal,
    })
    out.push(...(r.files || []))
    pageToken = r.nextPageToken
  } while (pageToken)
  return out
}

/**
 * Lê o link e monta o plano: { root, owner, folders[{id,name,resourceKey,parent,item}], files[{id,name,size,resourceKey,
 * parent,path,canCopy,item}], skipped[{name,why}], blocked, bytes }. `item` é o DriveItem com relPath/relDir (a
 * mesma forma do DriveClient.walk), para o download para a mídia física (downloadItems). `onFound(n)` a cada pasta.
 */
export async function lerLink(drive, ref, { signal, onFound } = {}) {
  const root = await getItem(drive, ref, signal)
  const isFolder = root.mimeType === FOLDER_MIME
  const plan = {
    root: { id: root.id, name: root.name, resourceKey: root.resourceKey || ref.resourceKey || null, folder: isFolder },
    owner: root.owners?.[0]?.displayName || null,
    folders: [],
    files: [],
    skipped: [],
    blocked: 0,
    bytes: 0,
  }
  const relOf = (path, dir) => ({ relPath: path, relDir: dir })
  const fileOf = (f, parent, path, dir) => ({
    id: f.id,
    name: f.name,
    size: f.size != null ? Number(f.size) : null,
    resourceKey: f.resourceKey || null,
    parent,
    path,
    canCopy: f.capabilities?.canCopy !== false,
    item: { ...toDriveItem(f), ...relOf(path, dir) },
  })
  plan.rootItem = toDriveItem({ ...root, resourceKey: plan.root.resourceKey })
  if (!isFolder) plan.files.push(fileOf({ ...root, resourceKey: plan.root.resourceKey }, null, root.name, ''))
  else {
    const queue = [{ ...plan.root, path: '' }]
    while (queue.length) {
      const f = queue.shift()
      for (const c of await children(drive, f, signal)) {
        const path = f.path ? `${f.path}/${c.name}` : c.name
        if (c.mimeType === FOLDER_MIME) {
          plan.folders.push({ id: c.id, name: c.name, resourceKey: c.resourceKey || null, parent: f.id, item: { ...toDriveItem(c), ...relOf(path, f.path) } })
          queue.push({ id: c.id, name: c.name, resourceKey: c.resourceKey || null, path })
        } else if (c.mimeType === SHORTCUT_MIME) plan.skipped.push({ name: path, why: 'Atalho para outro lugar do Drive.' })
        else plan.files.push(fileOf(c, f.id, path, f.path))
        if (plan.files.length > MAX_COPY_FILES) {
          throw new SobeDesceError('fatal', `Mais de ${MAX_COPY_FILES} arquivos: copie por partes (uma subpasta por vez).`, { reason: 'muitosArquivos', status: 413 })
        }
      }
      onFound?.(plan.files.length)
    }
  }
  for (const f of plan.files) {
    plan.bytes += f.size || 0
    if (!f.canCopy) plan.blocked++
  }
  return plan
}

/** Erro de um arquivo na cópia → { why, stop }. `stop`: não adianta seguir (Drive cheio, limite do dia, sem internet). */
export function copyError(err) {
  const info = classifyError(err)
  const r = info.reason || ''
  if (r === 'storageQuotaExceeded' || r === 'quotaExceeded') return { why: 'Seu Google Drive está sem espaço.', stop: true }
  if (r === 'teamDriveFileLimitExceeded' || r === 'numChildrenInNonRootLimitExceeded' || r === 'activeItemCreationLimitExceeded') return { why: info.message, stop: true }
  if (info.kind === 'quota') return { why: info.message, stop: true }
  if (r === 'insufficientFilePermissions' || r === 'insufficientPermissions') return { why: 'Sua conta não pode criar arquivos na pasta de destino. Escolha outra.', stop: true }
  if (r === 'cannotCopyFile' || r === 'fileNotCopyable' || r === 'fileNotDownloadable') return { why: 'O dono bloqueou cópia e download.', stop: false }
  if (info.kind === 'notfound') return { why: 'Sumiu do link ou deixou de estar liberado.', stop: false }
  if (info.kind === 'retry') return { why: 'Sem conexão com o Google.', stop: true }
  if (info.kind === 'auth' || info.kind === 'reauth') return { why: info.message, stop: true }
  return { why: info.message || 'O Google recusou a cópia.', stop: false }
}

/**
 * Copia o plano para `dest` ({ id }). Pasta do link → uma pasta com o mesmo nome dentro do destino.
 * `onProgress({ done, total, bytesDone, bytesTotal, current, failed, newFolderId })`. Devolve o mesmo resumo com
 * `stopped` (motivo) quando parou antes do fim. Abortar pelo `signal` interrompe e sobe o AbortError.
 */
export async function copiarPlano(drive, plan, dest, { signal, onProgress, novas = { pastas: [], arquivos: [] } } = {}) {
  const todo = plan.files.filter(f => f.canCopy)
  const failed = plan.files.filter(f => !f.canCopy).map(f => ({ name: f.path || f.name, why: 'O dono bloqueou cópia e download.' }))
  const s = { done: 0, total: todo.length, bytesDone: 0, bytesTotal: todo.reduce((t, f) => t + (f.size || 0), 0), current: null, failed, newFolderId: null, stopped: null }
  const tell = () => onProgress?.({ ...s, failed: s.failed.slice() })
  tell()
  const made = new Map() // id da pasta de origem → id da pasta nova
  // `novas`: o que foi criado no Drive da conta (DriveItem com relPath/relDir), preenchido aos poucos e válido mesmo
  // se a cópia parar no meio. O "Também baixar" baixa daqui, da cópia.
  const mkdir = async (name, parent) => (await drive.api('POST', 'files', { query: { fields: 'id' }, body: { name, mimeType: FOLDER_MIME, parents: [parent] }, signal, retries: 2 })).id
  try {
    if (plan.root.folder) {
      s.newFolderId = await mkdir(plan.root.name, dest.id)
      made.set(plan.root.id, s.newFolderId)
      tell()
      for (const f of plan.folders) {
        const id = await mkdir(f.name, made.get(f.parent))
        made.set(f.id, id)
        novas.pastas.push({ id, name: f.name, mimeType: FOLDER_MIME, isFolder: true, relPath: f.item?.relPath ?? f.name, relDir: f.item?.relDir ?? '' })
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err
    s.stopped = copyError(err).why
    tell()
    return s
  }
  let next = 0
  const worker = async () => {
    while (!s.stopped && !signal?.aborted && next < todo.length) {
      const f = todo[next++]
      s.current = f.path || f.name
      tell()
      try {
        const r = await drive.api('POST', `files/${encodeURIComponent(f.id)}/copy`, {
          query: { fields: COPY_FIELDS },
          body: { name: f.name, parents: [f.parent ? made.get(f.parent) : dest.id] },
          headers: keysHeader(f),
          signal,
          retries: 4,
        })
        s.bytesDone += f.size || 0
        novas.arquivos.push({ ...toDriveItem(r), relPath: f.item?.relPath ?? f.name, relDir: f.item?.relDir ?? '' })
      } catch (err) {
        if (signal?.aborted) return
        const e = copyError(err)
        s.failed.push({ name: f.path || f.name, why: e.why })
        if (e.stop) s.stopped = e.why
      }
      s.done++
      tell()
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker))
  if (signal?.aborted) throw signal.reason || new DOMException('Interrompido', 'AbortError')
  s.current = null
  return s
}

/**
 * "Também baixar": a CÓPIA que ficou no Drive da conta como itens para o planDownloads (engine/planner.js). Baixar do
 * próprio Drive é o caminho normal do Google (o arquivo de outra pessoa aberto por link vem bem mais devagar) e não
 * depende de a pessoa manter o link aberto. Pasta do link → a pasta nova com `walked` (o que foi criado agora, sem
 * listar de novo); arquivo avulso → a cópia dele. Nada copiado → [].
 */
export function copyDownloadItems(plan, novas, newFolderId) {
  if (!novas?.arquivos?.length) return []
  if (!plan.root.folder) return novas.arquivos
  return [{ id: newFolderId, name: plan.root.name, mimeType: FOLDER_MIME, isFolder: true, walked: [...novas.pastas, ...novas.arquivos] }]
}
