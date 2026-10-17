// Ações compartilhadas entre telas (transferências, envio, revelar no Finder).
import { api, attempt } from './api.js'
import { toast } from './toasts.js'
import { confirmDialog, openModal, pickDriveFolder } from './modals.js'
import { pickUploadPaths, revealPath } from './desktop.js'
import { getState } from './store.js'
import { bytes, plural } from './format.js'
import { storage } from './ui.js'
import { lembrarDestino, pastaInicial } from './destinos.js'

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

/** Mostra no Finder/Explorer: pela ponte nativa no desktop, pelo motor no navegador. */
export function reveal(path) {
  return revealPath(path)
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

const VIDEO_EXT = /\.(mp4|mov|m4v|mxf|mkv|avi|mts|m2ts|ts|mpg|mpeg|m2v|wmv|webm|3gp|dv|flv|hevc|h265|h264|vob)$/i

/** A escolha pode ter vídeo? (pasta — sem extensão — conta como "talvez") */
export function mayHaveVideo(paths) {
  return (paths || []).some((p) => {
    const name = String(p).split(/[\\/]/).pop() || ''
    return VIDEO_EXT.test(name) || !/\.[^.]+$/.test(name)
  })
}

/**
 * Envia caminhos locais para uma pasta do Drive. `proxy` (boolean) é a escolha deste envio; sem ela vale o ajuste
 * "Proxy ao enviar" — e, em "Perguntar a cada envio", abre a janela de envio com a escolha em destaque.
 */
export async function uploadPaths({ accountId, paths, destFolderId, driveId, proxy, destName, destPath }) {
  if (!paths?.length) return null
  // destName: nome da pasta do Drive, para mostrar (janela de envio e Acompanhar pelo celular).
  if (typeof proxy !== 'boolean') {
    const modo = getState().settings?.proxyAoEnviar || 'sempre'
    if (modo === 'perguntar') {
      if (mayHaveVideo(paths)) {
        const r = await openModal('envio', { paths, destName })
        if (!r) return null
        proxy = r.proxy
      }
    } else proxy = modo === 'sempre'
  }
  const res = await attempt(api.post('/api/transfers/upload', { accountId, paths, destFolderId, ...(driveId ? { driveId } : {}), ...(typeof proxy === 'boolean' ? { proxy } : {}), ...(destName ? { destName } : {}) }))
  announceBatch(res, 'para enviar')
  // Destino usado: entra nos Recentes do seletor e é onde ele abre da próxima vez.
  if (res) lembrarDestino(storage, accountId, { id: destFolderId || (driveId || 'root'), name: destName, driveId: driveId || null, path: destPath })
  return res
}

/** Fluxo completo: escolher no computador → escolher pasta do Drive → enviar. */
export async function uploadFlow({ destFolderId, driveId, destName, anchor } = {}) {
  const { activeAccountId } = getState()
  if (!activeAccountId) return null
  const paths = await pickUploadPaths({ title: destName ? `Enviar para “${destName}”` : 'O que você quer enviar?', anchor })
  if (!paths?.length) return null
  let dest = destFolderId ? { id: destFolderId, driveId, name: destName } : null
  if (!dest) {
    // A escolha do proxy fica visível no próprio seletor de pasta (marcada pelo ajuste).
    // Abre na última pasta usada como destino, com os Recentes e a busca de pastas ao lado.
    dest = await pickDriveFolder({
      accountId: activeAccountId,
      title: 'Para qual pasta do Drive?',
      confirmLabel: 'Enviar para cá',
      proxyChoice: mayHaveVideo(paths),
      initialFolderId: pastaInicial(storage, activeAccountId).id,
      destinos: true,
    })
    if (!dest) return null
  }
  return uploadPaths({ accountId: activeAccountId, paths, destFolderId: dest.id, driveId: dest.driveId, destName: destName || dest.name, destPath: dest.path, ...(typeof dest.proxy === 'boolean' ? { proxy: dest.proxy } : {}) })
}
