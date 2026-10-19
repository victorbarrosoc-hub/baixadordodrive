// Chamadas de metadados do Drive v3 (fetch direto do navegador para o Google, com o token do usuário).
// No modo Wi-Fi (LAN) as pastas vêm do computador, que fala com o Google por nós.
import { ENDPOINTS, LAN } from './config.js'
import { getToken, invalidate } from './auth.js'
import { getState } from './state.js'
import { lanDrives, lanFolders } from './lan.js'

const FOLDER_MIME = 'application/vnd.google-apps.folder'

export class DriveError extends Error {
  constructor(status, reason, message) {
    super(message || `HTTP ${status}`)
    this.status = status
    this.reason = reason || null
  }
}

/** Erro no formato do Google ({"error":{"code","message","errors":[{reason}]}}) → DriveError. */
export function driveErrorFrom(status, text) {
  let reason = null
  let message = null
  try {
    const j = JSON.parse(text || 'null')
    const e = j?.error
    if (e && typeof e === 'object') {
      reason = e.errors?.[0]?.reason || e.status || null
      message = e.message || null
    } else if (typeof e === 'string') {
      reason = e
      message = j.error_description || null
    }
  } catch {
    // corpo não-JSON (HTML de erro de proxy, por exemplo)
  }
  return new DriveError(status, reason, message)
}

/** 5xx, 429 e os 403 de limite de taxa podem ser repetidos com recuo. */
export function isRetryable(err) {
  if (!err) return false
  if (err.status === 0) return true
  if (err.status >= 500 || err.status === 429 || err.status === 408) return true
  return err.status === 403 && (err.reason === 'rateLimitExceeded' || err.reason === 'userRateLimitExceeded')
}

/** Recuo exponencial com jitter, teto de 64 s. attempt começa em 1. */
export function backoffMs(attempt) {
  const base = Math.min(64_000, 1000 * 2 ** Math.max(0, attempt - 1))
  return Math.min(64_000, base / 2 + Math.random() * (base / 2) + Math.random() * 400)
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new DOMException('Abortado', 'AbortError'))
    const t = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    function onAbort() {
      clearTimeout(t)
      reject(signal.reason || new DOMException('Abortado', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function call(path, { method = 'GET', query = {}, body, headers = {}, base = ENDPOINTS.api, signal, retries = 4, raw = false } = {}) {
  const url = new URL(base + path)
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v))
  let authRetries = 0
  for (let attempt = 1; ; attempt++) {
    const token = await getToken()
    let res
    try {
      res = await fetch(url, {
        method,
        signal,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      if (signal?.aborted) throw err
      if (attempt <= retries) {
        await sleep(backoffMs(attempt), signal)
        continue
      }
      throw new DriveError(0, 'network', 'Sem conexão com o Google. Confira a internet.')
    }
    if (res.ok) return raw ? res : res.status === 204 ? null : res.json()
    const err = driveErrorFrom(res.status, await res.text().catch(() => ''))
    if (res.status === 401 && authRetries < 2) {
      authRetries++
      invalidate(token)
      continue
    }
    if (isRetryable(err) && attempt <= retries) {
      await sleep(backoffMs(attempt), signal)
      continue
    }
    throw err
  }
}

/** Escapa um texto para dentro de aspas simples na linguagem de busca do Drive. */
export function q(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export function about(signal) {
  return call('/about', { query: { fields: 'user(displayName,emailAddress,photoLink),storageQuota' }, signal })
}

export async function listSharedDrives(signal) {
  if (LAN) return lanDrives(signal)
  const out = []
  let pageToken
  do {
    const r = await call('/drives', { query: { pageSize: 100, pageToken, fields: 'nextPageToken,drives(id,name)' }, signal })
    out.push(...(r.drives || []))
    pageToken = r.nextPageToken
  } while (pageToken)
  return out
}

/** Só pastas, em ordem de nome. Dentro de drive compartilhado usa corpora=drive. */
export async function listFolders(parentId, driveId, signal) {
  if (LAN) return lanFolders(parentId, signal)
  const out = []
  let pageToken
  do {
    const query = {
      q: `'${q(parentId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 1000,
      orderBy: 'name',
      fields: 'nextPageToken,files(id,name,driveId)',
      pageToken,
    }
    if (driveId) Object.assign(query, { corpora: 'drive', driveId })
    const r = await call('/files', { query, signal })
    out.push(...(r.files || []))
    pageToken = r.nextPageToken
  } while (pageToken)
  return out
}

export function createFolder(name, parentId) {
  return call('/files', {
    method: 'POST',
    query: { supportsAllDrives: true, fields: 'id,name,driveId' },
    body: { name, mimeType: FOLDER_MIME, parents: [parentId] },
    retries: 1,
  })
}

/** Arquivos com esse nome na pasta (o `name =` do Drive ignora maiúsculas; quem chama confere o nome exato). */
export async function findByName(name, folder, signal) {
  const query = {
    q: `name = '${q(name)}' and '${q(folder.id)}' in parents and trashed = false`,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageSize: 100,
    fields: 'files(id,name,size,md5Checksum)',
  }
  if (folder.driveId) Object.assign(query, { corpora: 'drive', driveId: folder.driveId })
  const r = await call('/files', { query, signal })
  return r.files || []
}

/**
 * Abre uma sessão de upload retomável. A URI da sessão vem no header Location e vale como credencial:
 * nunca vai para o console nem para a tela.
 */
export async function createUploadSession(file, folder, signal) {
  const res = await call('/files', {
    method: 'POST',
    base: ENDPOINTS.upload,
    raw: true,
    signal,
    retries: 3,
    query: { uploadType: 'resumable', supportsAllDrives: true, fields: 'id,name,size,md5Checksum' },
    headers: {
      'X-Upload-Content-Type': file.type || 'application/octet-stream',
      'X-Upload-Content-Length': String(file.size),
    },
    body: {
      name: file.name,
      parents: [folder.id],
      modifiedTime: new Date(file.lastModified || Date.now()).toISOString(),
    },
  })
  const uri = res.headers.get('Location')
  if (!uri) throw new DriveError(0, 'noLocation', 'O Google não devolveu o endereço do envio.')
  return uri
}

// ───── compartilhar link ─────
//
// "Compartilhar link" (ficha do envio, prévia e fim do lote): o link do Drive só abre para quem tem acesso. O app confere
// se o item já está aberto para "qualquer pessoa com o link" e, se a pessoa confirmar na tela, cria essa permissão
// (anyone/reader) direto no Google, como a pasta das Referências já faz.

const ANYONE_IDS = ['anyoneWithLink', 'anyone']

export function fileLink(id) {
  return `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`
}
export function folderLink(id) {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`
}

/**
 * Quem consegue abrir o link: { open: true | false | null, canShare, link }. `open: null` = o Google não disse (quem só
 * lê o item nem sempre vê as permissões): o app não afirma nada e não oferece liberar.
 */
export async function linkAccess(id, { folder = false, signal } = {}) {
  const r = await call(`/files/${encodeURIComponent(id)}`, {
    query: { supportsAllDrives: true, fields: 'id,permissionIds,capabilities(canShare),webViewLink' },
    signal,
    retries: 2,
  })
  const ids = Array.isArray(r.permissionIds) ? r.permissionIds : null
  return {
    open: ids ? ids.some((p) => ANYONE_IDS.includes(p)) : null,
    canShare: r.capabilities?.canShare !== false,
    link: r.webViewLink || (folder ? folderLink(id) : fileLink(id)),
  }
}

/** Libera para "qualquer pessoa com o link" (só leitura, sem aparecer em buscas). Só depois da confirmação na tela. */
export function openLink(id) {
  return call(`/files/${encodeURIComponent(id)}/permissions`, {
    method: 'POST',
    query: { supportsAllDrives: true, fields: 'id' },
    body: { type: 'anyone', role: 'reader', allowFileDiscovery: false },
    retries: 1,
  })
}

/**
 * Manda um arquivo para a lixeira do Drive (files.update trashed=true; dá para recuperar por 30 dias). Não apaga de
 * vez. Só a folha de confirmação dos arquivos do Mac usa (lib/browse.js macJunkTrash).
 */
export function trashFile(id, signal) {
  return call(`/files/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    query: { supportsAllDrives: true, fields: 'id,trashed' },
    body: { trashed: true },
    signal,
    retries: 2,
  })
}

// Recusas de política (Google Workspace da empresa, Drive compartilhado só para o domínio): o app não tem como
// contornar, só explicar.
const POLICY = new Set([
  'publishOutNotPermitted',
  'domainPolicy',
  'teamDriveDomainUsersOnlyRestriction',
  'teamDrivesSharingRestrictionNotAllowed',
  'cannotShareTeamDriveTopFolderWithAnyoneOrDomains',
  'cannotShareTeamDriveWithNonGoogleAccounts',
  'sharingNotSupported',
])

/** Erro do Liberar → { policy, text } em linguagem de gente. */
export function openLinkError(err) {
  const reason = err?.reason || ''
  if (POLICY.has(reason) || /policy|domain|organi[sz]ation/i.test(err?.message || '')) {
    return { policy: true, text: 'A política do Google da sua empresa não deixa abrir para qualquer pessoa. Compartilhe com o e-mail de quem vai ver, pelo Drive.' }
  }
  if (err?.status === 0) return { policy: false, text: 'Sem conexão com o Google. Confira a internet e tente de novo.' }
  if (reason === 'sharingRateLimitExceeded' || err?.status === 429) return { policy: false, text: 'O Google limitou os compartilhamentos agora. Tente de novo daqui a pouco.' }
  if (err?.status === 403 || err?.status === 404) return { policy: false, text: 'Você não pode mudar o compartilhamento deste item. Peça a quem é dono.' }
  return { policy: false, text: 'Não consegui liberar agora. Tente de novo.' }
}

// ───── buscar pasta (seletor de destino) ─────

const rootIds = new Map() // Drive escolhido → Promise<id do Meu Drive> (trocar de conta troca o Meu Drive)
/** O id de verdade do "Meu Drive" (os pais vêm com ele, não com o apelido 'root'). */
export function myDriveId(signal) {
  const key = getState().drive?.id || '-'
  if (!rootIds.has(key)) {
    rootIds.set(
      key,
      call('/files/root', { query: { fields: 'id' }, signal }).then(
        (r) => r.id,
        (err) => {
          rootIds.delete(key)
          throw err
        },
      ),
    )
  }
  return rootIds.get(key)
}

/** Pastas com esse nome (começo das palavras, como a busca do Drive) em tudo o que a conta vê. */
export async function searchFolders(text, signal) {
  const clean = String(text || '').trim()
  if (!clean) return []
  const r = await call('/files', {
    query: {
      q: `name contains '${q(clean)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
      corpora: 'allDrives',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 30,
      fields: 'files(id,name,driveId,parents)',
    },
    signal,
  })
  return r.files || []
}

const folderInfo = new Map() // id → Promise<{ id, name, parents, driveId } | null>
/** Nome e pai de uma pasta (null se a conta não enxerga). Guardado enquanto a página está aberta. */
export function folderMeta(id, signal) {
  if (!folderInfo.has(id)) {
    const p = call(`/files/${encodeURIComponent(id)}`, { query: { supportsAllDrives: true, fields: 'id,name,parents,driveId' }, signal, retries: 1 }).then(
      (r) => r,
      (err) => {
        if (err?.status === 404 || err?.status === 403) return null
        folderInfo.delete(id)
        throw err
      },
    )
    folderInfo.set(id, p)
  }
  return folderInfo.get(id)
}

/**
 * Caminho de uma pasta achada na busca, no formato do destino ({ id, name, driveId, path }). Sobe pelos pais até o
 * Meu Drive, a raiz do Drive compartilhado ou a última pasta que a conta enxerga (compartilhada com ela).
 */
export async function folderPath(f, signal) {
  const root = await myDriveId(signal).catch(() => null)
  const chain = [{ id: f.id, name: f.name }]
  let parent = f.parents?.[0] || null
  let top = null // 'mine' | 'drive' | null
  for (let i = 0; parent && i < 25; i++) {
    if (parent === 'root' || parent === root) {
      top = 'mine'
      break
    }
    if (f.driveId && parent === f.driveId) {
      top = 'drive'
      break
    }
    const m = await folderMeta(parent, signal)
    if (!m) break
    chain.unshift({ id: m.id, name: m.name })
    parent = m.parents?.[0] || null
  }
  if (top === 'mine') chain.unshift({ id: 'root', name: 'Meu Drive' })
  else if (top === 'drive') {
    const d = await folderMeta(f.driveId, signal).catch(() => null)
    chain.unshift({ id: f.driveId, name: d?.name || 'Drive compartilhado' })
  }
  return { id: f.id, name: f.name, driveId: f.driveId || null, path: chain }
}

// ───── favoritas e compartilhadas comigo (seletor de destino) ─────

const PASTAS = `mimeType = '${FOLDER_MIME}' and trashed = false`

async function todasAsPaginas(query, signal, max = 300) {
  const out = []
  let pageToken
  do {
    const r = await call('/files', { query: { ...query, pageToken }, signal })
    out.push(...(r.files || []))
    pageToken = r.nextPageToken
  } while (pageToken && out.length < max)
  return out.slice(0, max)
}

/** Pastas com estrela no Drive (a mesma estrela do Google Drive), de todos os lugares, por nome. */
export function listStarredFolders(signal) {
  return todasAsPaginas(
    {
      q: `starred = true and ${PASTAS}`,
      corpora: 'allDrives',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      orderBy: 'name',
      pageSize: 100,
      fields: 'nextPageToken,files(id,name,driveId,parents)',
    },
    signal,
  )
}

/** Pastas que outras pessoas compartilharam com a conta ("Compartilhados comigo"), as mais recentes primeiro. */
export function listSharedFolders(signal) {
  return todasAsPaginas(
    {
      q: `sharedWithMe = true and ${PASTAS}`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      orderBy: 'sharedWithMeTime desc',
      pageSize: 100,
      fields: 'nextPageToken,files(id,name,driveId,parents,sharingUser(displayName))',
    },
    signal,
  )
}

/** Põe ou tira a estrela (vale no Google Drive também). */
export function setStarred(id, starred) {
  return call(`/files/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    query: { supportsAllDrives: true, fields: 'id,starred' },
    body: { starred: Boolean(starred) },
    retries: 2,
  })
}

export { call as driveCall, FOLDER_MIME }
