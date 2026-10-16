// Conversa com o SOBEDESCE do computador no modo Wi-Fi (src/mobile/receiver.js). Toda chamada leva o código de
// acesso do QR no header x-sobedesce-code; nada aqui fala com o Google.
import { LAN } from './config.js'

const BASE = '/m/api'

export class LanError extends Error {
  constructor(status, message, data = null) {
    super(message)
    this.status = status
    this.reason = status === 401 ? 'code' : null
    this.lan = true
    this.data = data
  }
}

export const LAN_MSG = {
  offline: 'Sem conexão com o computador. Confira se o celular está no mesmo Wi-Fi e se o SOBEDESCE está aberto lá.',
  code: 'O código de acesso mudou. Escaneie de novo o QR code em Ajustes → Celular, no computador.',
}

async function call(path, { method = 'GET', body, signal } = {}) {
  let res
  try {
    res = await fetch(BASE + path, {
      method,
      signal,
      cache: 'no-store',
      headers: { 'x-sobedesce-code': LAN.code, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new LanError(0, LAN_MSG.offline)
  }
  let data = null
  try {
    data = await res.json()
  } catch {
    // resposta sem JSON (proxy, queda no meio)
  }
  if (res.status === 401) throw new LanError(401, LAN_MSG.code, data)
  if (!res.ok || !data?.ok) throw new LanError(res.status, data?.error || `O computador recusou o pedido (${res.status}).`, data)
  return data
}

/** { mac: { name }, account: { email, name } | null, folder: { id, name, driveId, path }, deleteAfterUpload } */
export const lanInfo = (signal) => call('/info', { signal })

export const lanFolders = (folderId, signal) => call(`/folders?folderId=${encodeURIComponent(folderId)}`, { signal }).then((r) => r.folders || [])

export const lanDrives = (signal) => call('/folders?drives=1', { signal }).then((r) => r.drives || [])

/** Começa ou retoma um recebimento (mesmo nome + tamanho + destino = o mesmo). → { id, offset, status, drive } */
export function lanStart(file, folder, signal) {
  return call('/uploads', {
    method: 'POST',
    signal,
    body: {
      name: file.name,
      size: file.size,
      lastModified: file.lastModified || null,
      folderId: folder.id,
      driveId: folder.driveId || null,
      folderName: (folder.path || []).map((p) => p.name).join(' / ') || folder.name,
    },
  })
}

export const lanStatus = (id, signal) => call(`/uploads/${encodeURIComponent(id)}`, { signal })

export const lanDiscard = (id) => call(`/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null)

/**
 * Um pedaço: PUT com Upload-Offset (XHR, para ter o progresso do envio). Resolve com { status, json } para qualquer
 * resposta HTTP; rejeita só em queda de conexão/abort. `onProgress(bytesEnviados)`.
 */
export function lanPut(id, offset, blob, { onProgress, register } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    register?.(xhr)
    xhr.open('PUT', `${BASE}/uploads/${encodeURIComponent(id)}`)
    xhr.setRequestHeader('x-sobedesce-code', LAN.code)
    xhr.setRequestHeader('Upload-Offset', String(offset))
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded)
    xhr.onload = () => {
      let json = null
      try {
        json = JSON.parse(xhr.responseText || 'null')
      } catch {
        // sem JSON
      }
      resolve({ status: xhr.status, json })
    }
    xhr.onerror = () => reject(new LanError(0, LAN_MSG.offline))
    xhr.onabort = () => reject(new LanError(0, 'Interrompido.'))
    xhr.ontimeout = () => reject(new LanError(0, 'A conexão com o computador travou.'))
    try {
      xhr.send(blob)
    } catch {
      reject(new LanError(0, 'Não consegui ler o arquivo.'))
    }
  })
}
