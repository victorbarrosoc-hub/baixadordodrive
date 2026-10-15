// Seletor de pasta do Drive (para Comparar e para escolher onde enviar). Reaproveita a tabela do Drive em modo pasta.
import { html, useMemo, useState } from '/vendor/preact-htm.js'
import { attempt } from '../lib/api.js'
import { promptDialog } from '../lib/modals.js'
import { Icon } from './icons.js'
import { Button } from './common.js'
import { Modal } from './modal.js'
import { DriveTable } from './drive-table.js'
import { Breadcrumb, SourceChips } from './drive.js'
import { createDriveFolder, useDriveFolder, useSharedDrives } from './drive-data.js'

function crumbsOf(data, drives) {
  const list = (data?.path || []).slice()
  if (data?.folder && (!list.length || list[list.length - 1].id !== data.folder.id)) list.push({ id: data.folder.id, name: data.folder.name })
  return list.map((c, i) => {
    if (i) return c.name
    const shared = drives.find((d) => d.id === c.id)
    return shared ? shared.name : 'Meu Drive'
  })
}

export function DrivePicker({ accountId, title = 'Escolha uma pasta do Drive', subtitle, confirmLabel, initialFolderId = 'root', onClose }) {
  const [folderId, setFolderId] = useState(initialFolderId || 'root')
  const [selected, setSelected] = useState(new Set())
  const drives = useSharedDrives(accountId)
  const { data, loading, error, reload } = useDriveFolder(accountId, folderId)
  const folder = data?.folder
  const sourceId = folder?.driveId || (data?.path?.[0] && drives.some((d) => d.id === data.path[0].id) ? data.path[0].id : 'root')

  const open = (it) => {
    setSelected(new Set())
    setFolderId(it.isShortcut && it.shortcutTargetId ? it.shortcutTargetId : it.id)
  }
  const byId = useMemo(() => new Map((data?.items || []).map((x) => [x.id, x])), [data])
  const chosenSub = [...selected].map((id) => byId.get(id)).find(Boolean)
  const crumbs = crumbsOf(data, drives)

  const confirm = () => {
    if (!folder) return
    if (chosenSub) {
      onClose({ id: chosenSub.id, name: chosenSub.name, path: [...crumbs, chosenSub.name].join(' / '), driveId: chosenSub.driveId || folder.driveId || null })
    } else {
      onClose({ id: folder.id, name: crumbs[crumbs.length - 1] || folder.name, path: crumbs.join(' / '), driveId: folder.driveId || null })
    }
  }

  const newFolder = async () => {
    const name = await promptDialog({ title: 'Nova pasta', label: 'Nome da pasta', placeholder: 'Sem título', confirmLabel: 'Criar pasta' })
    if (!name) return
    const item = await attempt(createDriveFolder(accountId, folderId, name))
    if (item) {
      await reload()
      setSelected(new Set([item.id]))
    }
  }

  const label = confirmLabel || (chosenSub ? `Escolher “${chosenSub.name}”` : 'Escolher esta pasta')

  return html`<${Modal}
    size="xl"
    class="picker picker-drive"
    title=${title}
    subtitle=${subtitle || 'Dê dois cliques para entrar numa pasta. Sem nada marcado, vale a pasta aberta.'}
    onClose=${() => onClose(null)}
    onKeyDown=${(e) => {
      if (e.key === 'Enter' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON' && !e.target.closest?.('.drow')) {
        e.preventDefault()
        confirm()
      }
    }}
    footer=${html`
      <div class="picker-summary">
        <${Icon} name="cloud" size=${15} />
        <span class="mono-path" title=${crumbs.join(' / ')}>${[...crumbs, ...(chosenSub ? [chosenSub.name] : [])].join(' / ') || '…'}</span>
      </div>
      <${Button} icon="folder-plus" onClick=${newFolder} disabled=${!folder}>Nova pasta</${Button}>
      <${Button} onClick=${() => onClose(null)}>Cancelar</${Button}>
      <${Button} variant="primary" onClick=${confirm} disabled=${!folder}>${label}</${Button}>
    `}
  >
    <div class="picker-grid">
      <aside class="picker-side" aria-label="Drives">
        <div class="side-label">Drives</div>
        <${SourceChips} vertical drives=${drives} current=${sourceId} onPick=${(id) => { setSelected(new Set()); setFolderId(id) }} />
      </aside>
      <section class="picker-main">
        <div class="picker-bar">
          <${Breadcrumb} path=${data?.path} folder=${folder} drives=${drives} onOpen=${(id) => { setSelected(new Set()); setFolderId(id) }} />
        </div>
        <${DriveTable}
          mode="folder"
          compact
          items=${data?.items || null}
          selected=${selected}
          onSelect=${setSelected}
          onOpen=${open}
          loading=${loading}
          error=${error}
          onRetry=${reload}
          resetKey=${folderId}
          empty=${html`<div class="table-empty"><${Icon} name="folder" size=${22} /><b>Sem subpastas</b><span>Escolha esta mesma ou crie uma nova.</span></div>`}
        />
      </section>
    </div>
  </${Modal}>`
}
