// Ações compartilhadas entre telas (transferências, envio, revelar no Finder).
import { api, attempt } from './api.js'
import { toast } from './toasts.js'
import { confirmDialog, pickLocal, pickDriveFolder } from './modals.js'
import { getState } from './store.js'
import { bytes, plural } from './format.js'

export function transferAction(action, ids) {
  return attempt(api.post('/api/transfers/action', { action, ids }))
}

export function batchAction(action, batchId) {
  return attempt(api.post('/api/transfers/action', { action, batchId }))
}

export async function cancelTransfer(t) {
  const ok = await confirmDialog({
    title: `Cancelar “${t.name}”?`,
    message:
      t.type === 'download'
        ? 'O que já foi baixado deste arquivo será apagado.'
        : 'O envio para aqui. Para mandar de novo, ele recomeça do zero.',
    confirmLabel: 'Cancelar transferência',
    cancelLabel: 'Continuar',
    danger: true,
  })
  if (ok) return transferAction('cancel', [t.id])
  return null
}

export async function cancelBatch(batch, n) {
  const ok = await confirmDialog({
    title: `Cancelar “${batch.label}”?`,
    message: `${plural(n, 'arquivo deixa', 'arquivos deixam')} de ser transferidos. O que já terminou continua onde está.`,
    confirmLabel: 'Cancelar lote',
    cancelLabel: 'Continuar',
    danger: true,
  })
  if (ok) return batchAction('cancel', batch.id)
  return null
}

export function reveal(path) {
  if (!path) return null
  return attempt(api.post('/api/reveal', { path }))
}

export function driveFileUrl(fileId) {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`
}

export function driveFolderUrl(folderId) {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`
}

/** Aviso padrão depois de criar um lote. */
export function announceBatch(res, verb = 'na fila') {
  if (!res) return
  const skipped = Array.isArray(res.skipped) ? res.skipped.length : 0
  if (!res.count) {
    toast('info', skipped ? `Nada novo: ${plural(skipped, 'item já estava lá ou não pode ser transferido', 'itens já estavam lá ou não podem ser transferidos')}.` : 'Nada para transferir aqui.')
    return
  }
  const msg = `${plural(res.count, 'arquivo', 'arquivos')} ${verb} · ${bytes(res.bytes)}` + (skipped ? ` · ${skipped} pulado${skipped === 1 ? '' : 's'}` : '')
  toast('success', msg, { action: { label: 'Ver transferências', href: '#/transferencias' } })
}

/** Envia caminhos locais para uma pasta do Drive. */
export async function uploadPaths({ accountId, paths, destFolderId, driveId }) {
  if (!paths?.length) return null
  const res = await attempt(api.post('/api/transfers/upload', { accountId, paths, destFolderId, ...(driveId ? { driveId } : {}) }))
  announceBatch(res, 'para enviar')
  return res
}

/** Fluxo completo: escolher no computador → escolher pasta do Drive → enviar. */
export async function uploadFlow({ destFolderId, driveId, destName } = {}) {
  const { activeAccountId } = getState()
  if (!activeAccountId) return null
  const paths = await pickLocal({ mode: 'files', title: destName ? `Enviar para “${destName}”` : 'O que você quer enviar?' })
  if (!paths?.length) return null
  let dest = destFolderId ? { id: destFolderId, driveId } : null
  if (!dest) {
    dest = await pickDriveFolder({ accountId: activeAccountId, title: 'Para qual pasta do Drive?', confirmLabel: 'Enviar para cá' })
    if (!dest) return null
  }
  return uploadPaths({ accountId: activeAccountId, paths, destFolderId: dest.id, driveId: dest.driveId })
}
