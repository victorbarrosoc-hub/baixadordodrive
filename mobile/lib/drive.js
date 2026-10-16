// Chamadas de metadados do Drive v3 (fetch direto do navegador para o Google, com o token do usuário).
// No modo Wi-Fi (LAN) as pastas vêm do computador, que fala com o Google por nós.
import { ENDPOINTS, LAN } from './config.js'
import { getToken, invalidate } from './auth.js'
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

export { call as driveCall, FOLDER_MIME }
