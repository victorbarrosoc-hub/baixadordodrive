// Tela Drive: navegar Meu Drive e drives compartilhados, buscar, criar pasta, enviar para a pasta atual
// e baixar a seleção (barra flutuante embaixo, translúcida como no macOS).
import { html, useEffect, useMemo, useState } from '/vendor/preact-htm.js'
import { useStore } from '../lib/store.js'
import { navigate } from '../lib/router.js'
import { api, attempt } from '../lib/api.js'
import { bytes, plural, shortPath } from '../lib/format.js'
import { cx, useDebounced } from '../lib/ui.js'
import { announceBatch, driveFolderUrl, uploadPaths } from '../lib/actions.js'
import { pickLocal, promptDialog } from '../lib/modals.js'
import { toast } from '../lib/toasts.js'
import { Icon } from './icons.js'
import { Button, IconButton, Spinner } from './common.js'
import { DriveTable, isOpenable } from './drive-table.js'
import { createDriveFolder, useAbout, useDriveFolder, useDriveSearch, useSharedDrives } from './drive-data.js'

/** Fontes: Meu Drive + drives compartilhados, em pílulas. */
export function SourceChips({ drives, current, onPick, vertical }) {
  return html`<div class=${cx('sources', vertical && 'is-vertical')} role="tablist" aria-label="Onde procurar">
    <button type="button" role="tab" aria-selected=${current === 'root' ? 'true' : 'false'} class=${cx('source', current === 'root' && 'is-on')} onClick=${() => onPick('root')}>
      <${Icon} name="cloud" size=${15} /> Meu Drive
    </button>
    ${drives.map(
      (d) => html`<button type="button" role="tab" aria-selected=${current === d.id ? 'true' : 'false'} class=${cx('source', current === d.id && 'is-on')} onClick=${() => onPick(d.id)} title=${d.name}>
        <${Icon} name="users" size=${15} /> <span>${d.name}</span>
      </button>`,
    )}
  </div>`
}

/** Trilha de pastas. Encurta o meio quando fica longa. */
export function Breadcrumb({ path, folder, drives, onOpen }) {
  let crumbs = (path || []).slice()
  if (folder && (!crumbs.length || crumbs[crumbs.length - 1].id !== folder.id)) crumbs.push({ id: folder.id, name: folder.name })
  if (!crumbs.length) crumbs = [{ id: 'root', name: 'Meu Drive' }]
  crumbs = crumbs.map((c, i) => {
    if (i !== 0) return c
    const shared = drives?.find((d) => d.id === c.id)
    return { ...c, name: shared ? shared.name : c.id === 'root' || !folder?.driveId ? 'Meu Drive' : c.name }
  })
  let view = crumbs
  if (crumbs.length > 4) view = [crumbs[0], { ellipsis: true, id: '…', hidden: crumbs.slice(1, -2) }, ...crumbs.slice(-2)]
  return html`<nav class="crumbs" aria-label="Caminho">
    ${view.map((c, i) => {
      const last = i === view.length - 1
      return html`${i > 0 ? html`<${Icon} name="chevron-right" size=${12} class="crumb-sep" />` : null}
        ${c.ellipsis
          ? html`<button type="button" class="crumb" title=${c.hidden.map((h) => h.name).join(' / ')} onClick=${() => onOpen(c.hidden[c.hidden.length - 1].id)}>…</button>`
          : last
            ? html`<span class="crumb is-current" aria-current="page" title=${c.name}>${c.name}</span>`
            : html`<button type="button" class="crumb" title=${c.name} onClick=${() => onOpen(c.id)}>${c.name}</button>`}`
    })}
  </nav>`
}

function Quota({ accountId }) {
  const about = useAbout(accountId)
  const q = about?.quota
  if (!q || !q.limit) return null
  const frac = Math.min(1, (q.usage || 0) / q.limit)
  return html`<div class=${cx('quota', frac > 0.9 && 'is-full')} title=${`${bytes(q.usage)} usados de ${bytes(q.limit)}`}>
    <span class="quota-bar"><i style=${`width:${(frac * 100).toFixed(1)}%`}></i></span>
    <span>${bytes(q.usage)} de ${bytes(q.limit)}</span>
  </div>`
}

function SelectionBar({ items, destDir, home, onChangeDest, onDownload, onClear, busy }) {
  const files = items.filter((x) => !isOpenable(x))
  const folders = items.length - files.length
  const size = files.reduce((a, x) => a + (x.size || 0), 0)
  const docs = files.filter((x) => x.isGoogleDoc).length
  const parts = [plural(items.length, 'item', 'itens')]
  if (size) parts.push(bytes(size))
  let hint = ''
  if (folders) hint = `${plural(folders, 'pasta', 'pastas')} com tudo dentro`
  else if (docs) hint = `${plural(docs, 'Doc Google exportado', 'Docs Google exportados')}`
  return html`<div class="selbar" role="region" aria-label="Seleção">
    <div class="selbar-info">
      <b>${parts.join(' · ')}</b>
      ${hint ? html`<span class="sub">${hint}</span>` : null}
    </div>
    <span class="selbar-sep"></span>
    <button type="button" class="dest-chip" onClick=${onChangeDest} title=${`Baixar em ${destDir}`}>
      <${Icon} name="folder" size=${15} />
      <span class="dest-label">Para</span>
      <span class="dest-name">${shortPath(destDir, home) || 'Escolher…'}</span>
      <${Icon} name="chevron-updown" size=${12} />
    </button>
    <${Button} variant="primary" icon="download" onClick=${onDownload} loading=${busy}>Baixar</${Button}>
    <${IconButton} icon="x" label="Limpar seleção" onClick=${onClear} />
  </div>`
}

export function DriveScreen({ route }) {
  const accountId = useStore((s) => s.activeAccountId)
  const settings = useStore((s) => s.settings)
  const folderId = route.parts[1] || 'root'
  const drives = useSharedDrives(accountId)
  const { data, loading, error, reload } = useDriveFolder(accountId, folderId)
  const [query, setQuery] = useState('')
  const q = useDebounced(query, 300)
  const search = useDriveSearch(accountId, q)
  const [selected, setSelected] = useState(new Set())
  const [destDir, setDestDir] = useState(null)
  const [home, setHome] = useState('')
  const [busy, setBusy] = useState(false)

  const searching = !!q.trim()
  const items = searching ? search.items : data?.items || null
  const folder = data?.folder
  const sourceId = folder?.driveId || (data?.path?.[0]?.id && drives.some((d) => d.id === data.path[0].id) ? data.path[0].id : 'root')

  useEffect(() => setSelected(new Set()), [folderId, q, accountId])
  useEffect(() => {
    api.get('/api/local/roots').then((r) => setHome(r.home || '')).catch(() => {})
  }, [])

  const byId = useMemo(() => new Map((items || []).map((x) => [x.id, x])), [items])
  const selItems = [...selected].map((id) => byId.get(id)).filter(Boolean)
  const dest = destDir || settings?.downloadDir || ''

  const open = (it) => {
    const target = it.isShortcut && it.shortcutTargetId ? it.shortcutTargetId : it.id
    setQuery('')
    navigate(`drive/${encodeURIComponent(target)}`)
  }
  const openId = (id) => navigate(id === 'root' ? 'drive' : `drive/${encodeURIComponent(id)}`)

  const newFolder = async () => {
    const name = await promptDialog({ title: 'Nova pasta', label: 'Nome da pasta', placeholder: 'Sem título', confirmLabel: 'Criar pasta', hint: folder ? `Dentro de “${folderLabel(folder, drives)}”` : '' })
    if (!name) return
    const item = await attempt(createDriveFolder(accountId, folderId, name))
    if (item) {
      toast('success', `Pasta “${item.name}” criada.`)
      await reload()
      setSelected(new Set([item.id]))
    }
  }

  const uploadHere = async () => {
    const paths = await pickLocal({ mode: 'files', title: `Enviar para “${folderLabel(folder, drives)}”` })
    if (!paths?.length) return
    await uploadPaths({ accountId, paths, destFolderId: folderId, driveId: folder?.driveId || null })
  }

  const chooseDest = async () => {
    const p = await pickLocal({ mode: 'folder', title: 'Onde salvar os downloads?', initialPath: dest })
    if (p) setDestDir(p)
  }

  const download = async () => {
    if (!selItems.length) return
    setBusy(true)
    const res = await attempt(api.post('/api/transfers/download', { accountId, items: selItems, destDir: dest }))
    setBusy(false)
    if (res) {
      announceBatch(res, 'na fila')
      setSelected(new Set())
    }
  }

  const onKeyDownPage = (e) => {
    if (e.key === 'Escape' && selected.size) setSelected(new Set())
  }

  return html`<div class=${cx('page page-drive', selected.size && 'has-selbar')} onKeyDown=${onKeyDownPage}>
    <header class="page-head">
      <h1>Drive</h1>
      <div class="page-head-actions"><${Quota} accountId=${accountId} /></div>
    </header>
    <${SourceChips} drives=${drives} current=${searching ? null : sourceId} onPick=${(id) => { setQuery(''); openId(id) }} />
    <div class="drive-bar">
      ${searching
        ? html`<div class="crumbs"><span class="crumb is-current">Resultados para “${q.trim()}”</span>${search.loading ? html`<${Spinner} size=${14} />` : null}</div>`
        : html`<${Breadcrumb} path=${data?.path} folder=${folder} drives=${drives} onOpen=${openId} />`}
      <div class="drive-bar-actions">
        <label class="search">
          <${Icon} name="search" size=${15} />
          <input
            type="search"
            placeholder="Buscar no Drive"
            value=${query}
            onInput=${(e) => setQuery(e.currentTarget.value)}
            onKeyDown=${(e) => e.key === 'Escape' && setQuery('')}
            aria-label="Buscar no Drive"
          />
        </label>
        ${!searching ? html`<${IconButton} icon="refresh" label="Atualizar" onClick=${reload} class=${loading && data ? 'is-spinning' : ''} />` : null}
        ${!searching && folder ? html`<a class="icon-btn" href=${folderId === 'root' ? 'https://drive.google.com/drive/my-drive' : driveFolderUrl(folderId)} target="_blank" rel="noopener" title="Abrir no navegador" aria-label="Abrir no navegador"><${Icon} name="external" /></a>` : null}
        <${Button} icon="folder-plus" onClick=${newFolder} disabled=${searching}>Nova pasta</${Button}>
        <${Button} variant="primary" icon="upload" onClick=${uploadHere} disabled=${searching}>Enviar para esta pasta</${Button}>
      </div>
    </div>
    <div class="card card-table">
      <${DriveTable}
        items=${items}
        selected=${selected}
        onSelect=${setSelected}
        onOpen=${open}
        loading=${searching ? search.loading : loading}
        error=${searching ? search.error : error}
        onRetry=${reload}
        resetKey=${searching ? 'q:' + q : folderId}
        empty=${searching
          ? html`<span>Nada com “${q.trim()}” no nome.</span>`
          : html`<div class="table-empty"><${Icon} name="folder" size=${22} /><b>Pasta vazia</b><span>Use “Enviar para esta pasta” para mandar arquivos para cá.</span></div>`}
      />
    </div>
    ${selItems.length
      ? html`<${SelectionBar}
          items=${selItems}
          destDir=${dest}
          home=${home}
          busy=${busy}
          onChangeDest=${chooseDest}
          onDownload=${download}
          onClear=${() => setSelected(new Set())}
        />`
      : null}
  </div>`
}

function folderLabel(folder, drives) {
  if (!folder) return 'esta pasta'
  if (folder.id === 'root') return 'Meu Drive'
  const shared = drives?.find((d) => d.id === folder.id)
  return shared ? shared.name : folder.name
}

