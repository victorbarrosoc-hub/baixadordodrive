// Tela Drive: navegar Meu Drive e drives compartilhados, buscar, criar pasta, enviar para a pasta atual
// e baixar a seleção (barra flutuante embaixo, translúcida como no macOS).
import { html, useEffect, useMemo, useRef, useState } from '/vendor/preact-htm.js'
import { useStore } from '../lib/store.js'
import { navigate } from '../lib/router.js'
import { api, attempt } from '../lib/api.js'
import { bytes, plural, shortPath } from '../lib/format.js'
import { cx, storage, useDebounced, usePersistentState } from '../lib/ui.js'
import { announceBatch, driveFolderUrl, uploadPaths } from '../lib/actions.js'
import { promptDialog } from '../lib/modals.js'
import { pickFolderPath, pickUploadPaths } from '../lib/desktop.js'
import { FileDrop } from './drop.js'
import { toast } from '../lib/toasts.js'
import { Icon } from './icons.js'
import { Button, IconButton, Segmented, Spinner } from './common.js'
import { DriveTable, compare, isOpenable } from './drive-table.js'
import { DriveGrid } from './drive-grid.js'
import { DrivePreview } from './drive-preview.js'
import { onProxies, knownProxy, siblingProxies } from '../lib/media.js'
import { createDriveFolder, useAbout, useDriveFolder, useDriveSearch, useSharedDrives } from './drive-data.js'
import { hasRawFiles, onRawThumbsDone, openRawThumbs, useRawThumbsRunning } from './raw-thumbs.js'
import { hasVideoFiles, isVideoName, onPreviasDone, openPrevias, openProxyArquivo, usePreviasRunning, useComProxy } from './previa.js'

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

function SelectionBar({ items, destDir, home, onChangeDest, onDownload, onClear, busy, onPreview, onProxy }) {
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
    ${onPreview && files.length ? html`<${Button} icon="eye" onClick=${onPreview} title="Prévia (espaço)">Prévia</${Button}>` : null}
    ${onProxy && items.length === 1 && files.length === 1 && isVideoName(files[0].name)
      ? html`<${Button} icon="film" onClick=${() => onProxy(files[0])} title="Proxy (cópia leve 1080p) para a prévia tocar fluida">Gerar proxy</${Button}>`
      : null}
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
  const [view, setView] = usePersistentState('drive.view', 'list')
  const [sort, setSort] = usePersistentState('drive.sort', { key: 'name', dir: 'asc' })
  const [peek, setPeek] = useState(null) // id do item na prévia
  const [, setProxyTick] = useState(0)
  useEffect(() => onProxies(() => setProxyTick((n) => n + 1)), [])
  // "Gerar miniaturas" terminou: recarrega a pasta para as miniaturas novas aparecerem.
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  useEffect(() => onRawThumbsDone((job) => job.progress?.feitos && reloadRef.current()), [])
  const thumbsRunning = useRawThumbsRunning()
  // "Gerar prévias" terminou: recarrega a pasta (a subpasta Proxy aparece).
  useEffect(() => onPreviasDone((job) => job.progress?.feitos && reloadRef.current()), [])
  const previasRunning = usePreviasRunning()

  const searching = !!q.trim()
  // Selo "Proxy" nos vídeos que já têm (mesma pasta ou subpasta Proxy da lista).
  const comProxy = useComProxy(accountId, searching ? null : data?.items)
  const items = searching ? search.items : data?.items || null
  const folder = data?.folder
  const sourceId = folder?.driveId || (data?.path?.[0]?.id && drives.some((d) => d.id === data.path[0].id) ? data.path[0].id : 'root')

  useEffect(() => {
    setSelected(new Set())
    setPeek(null)
  }, [folderId, q, accountId])
  // lembra a pasta aberta: soltar arquivos na tela Transferências envia para cá
  useEffect(() => {
    if (folder && accountId) storage.set('drive.last', { accountId, id: folder.id, name: folderLabel(folder, drives), driveId: folder.driveId || null })
  }, [folder?.id, accountId, drives.length])
  useEffect(() => {
    api.get('/api/local/roots').then((r) => setHome(r.home || '')).catch(() => {})
  }, [])

  const byId = useMemo(() => new Map((items || []).map((x) => [x.id, x])), [items])
  const sorted = useMemo(() => (items || []).slice().sort(compare(sort?.key || 'name', sort?.dir || 'asc')), [items, sort])
  // Arquivos da pasta na ordem da tela (atalho para arquivo vira o próprio arquivo): a prévia anda por eles com ←/→.
  const peekList = useMemo(
    () => sorted.filter((x) => !isOpenable(x)).map((x) => (x.isShortcut && x.shortcutTargetId ? { ...x, id: x.shortcutTargetId, mimeType: x.shortcutTargetMimeType || x.mimeType, isShortcut: false, hasThumbnail: false, viaShortcut: x.id } : x)),
    [sorted],
  )
  const peekIndex = peek ? peekList.findIndex((x) => x.id === peek || x.viaShortcut === peek) : -1
  // Miniatura do proxy de câmera para o original sem miniatura (o que já está na pasta ou já foi achado na prévia).
  const proxies = (() => {
    const m = siblingProxies(items)
    for (const it of items || []) {
      const p = !it.hasThumbnail && !m.has(it.id) ? knownProxy(accountId, it.id) : null
      if (p?.hasThumbnail) m.set(it.id, p)
    }
    return m
  })()
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

  const uploadHere = async (e) => {
    const paths = await pickUploadPaths({ title: `Enviar para “${folderLabel(folder, drives)}”`, anchor: e?.currentTarget })
    if (!paths?.length) return
    await uploadPaths({ accountId, paths, destFolderId: folderId, driveId: folder?.driveId || null, destName: folderLabel(folder, drives) })
  }

  const chooseDest = async () => {
    const p = await pickFolderPath({ title: 'Onde salvar os downloads?', defaultPath: dest })
    if (p) setDestDir(p)
  }

  const preview = (it) => {
    if (!it || isOpenable(it)) return
    setSelected(new Set([it.id]))
    setPeek(it.id)
  }

  const downloadOne = async (it) => {
    const res = await attempt(api.post('/api/transfers/download', { accountId, items: [it], destDir: dest }))
    if (res) announceBatch(res, 'na fila')
    return !!res?.count
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

  const emptyView = searching
    ? html`<span>Nada com “${q.trim()}” no nome.</span>`
    : html`<div class="table-empty"><${Icon} name="folder" size=${22} /><b>Pasta vazia</b><span>Use “Enviar para esta pasta” para mandar arquivos para cá.</span></div>`

  const onKeyDownPage = (e) => {
    if (e.key === 'Escape' && selected.size) setSelected(new Set())
  }

  return html`<div class=${cx('page page-drive', selected.size && 'has-selbar')} onKeyDown=${onKeyDownPage}>
    <${FileDrop}
      label=${folderLabel(folder, drives)}
      enabled=${!!folder && !!accountId}
      onPaths=${(paths) => uploadPaths({ accountId, paths, destFolderId: folderId, driveId: folder?.driveId || null, destName: folderLabel(folder, drives) })}
    />
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
        <${Segmented}
          size="sm"
          class="view-seg"
          label="Ver como"
          value=${view}
          onChange=${setView}
          options=${[
            { value: 'list', label: 'Lista', icon: 'list', title: 'Lista' },
            { value: 'grid', label: 'Miniaturas', icon: 'grid', title: 'Miniaturas' },
          ]}
        />
        ${!searching ? html`<${IconButton} icon="refresh" label="Atualizar" onClick=${reload} class=${loading && data ? 'is-spinning' : ''} />` : null}
        ${!searching && folder ? html`<a class="icon-btn" href=${folderId === 'root' ? 'https://drive.google.com/drive/my-drive' : driveFolderUrl(folderId)} target="_blank" rel="noopener" title="Abrir no navegador" aria-label="Abrir no navegador"><${Icon} name="external" /></a>` : null}
        ${!searching && folder && (hasRawFiles(items) || thumbsRunning)
          ? html`<button type="button" class="btn btn-secondary" onClick=${() => openRawThumbs({ accountId, folder: { id: folderId, name: folderLabel(folder, drives) } })} title="Miniatura para os BRAW/R3D, a partir dos originais no computador">
              ${thumbsRunning ? html`<${Spinner} size=${14} />` : html`<${Icon} name="photo" size=${16} />`}<span>Gerar miniaturas</span>
            </button>`
          : null}
        ${!searching && folder && (hasVideoFiles(items, folder) || previasRunning)
          ? html`<button type="button" class="btn btn-secondary" onClick=${() => openPrevias({ accountId, folder: { id: folderId, name: folderLabel(folder, drives) } })} title="Proxy (cópia leve 1080p, pasta Proxy) dos vídeos desta pasta, para a prévia tocar fluida">
              ${previasRunning ? html`<${Spinner} size=${14} />` : html`<${Icon} name="film" size=${16} />`}<span>Gerar proxies da pasta</span>
            </button>`
          : null}
        <${Button} icon="folder-plus" onClick=${newFolder} disabled=${searching}>Nova pasta</${Button}>
        <${Button} variant="primary" icon="upload" onClick=${uploadHere} disabled=${searching}>Enviar para esta pasta</${Button}>
      </div>
    </div>
    <div class=${cx('card', view === 'grid' ? 'card-grid' : 'card-table')}>
      ${view === 'grid'
        ? html`<${DriveGrid}
            items=${items}
            sorted=${sorted}
            selected=${selected}
            onSelect=${setSelected}
            onOpen=${open}
            onPreview=${preview}
            accountId=${accountId}
            proxies=${proxies}
            comProxy=${comProxy}
            loading=${searching ? search.loading : loading}
            error=${searching ? search.error : error}
            onRetry=${reload}
            resetKey=${searching ? 'q:' + q : folderId}
            empty=${emptyView}
          />`
        : html`<${DriveTable}
            items=${items}
            selected=${selected}
            onSelect=${setSelected}
            onOpen=${open}
            onPreview=${preview}
            accountId=${accountId}
            proxies=${proxies}
            comProxy=${comProxy}
            sort=${sort}
            onSort=${setSort}
            loading=${searching ? search.loading : loading}
            error=${searching ? search.error : error}
            onRetry=${reload}
            resetKey=${searching ? 'q:' + q : folderId}
            empty=${emptyView}
          />`}
    </div>
    ${peekIndex >= 0
      ? html`<${DrivePreview}
          accountId=${accountId}
          items=${peekList}
          index=${peekIndex}
          onIndex=${(i) => {
            const it = peekList[i]
            setPeek(it.id)
            setSelected(new Set([it.viaShortcut || it.id]))
          }}
          onClose=${() => setPeek(null)}
          onDownload=${downloadOne}
          dest=${dest}
          destLabel=${shortPath(dest, home)}
          onChangeDest=${chooseDest}
        />`
      : null}
    ${selItems.length && peekIndex < 0
      ? html`<${SelectionBar}
          items=${selItems}
          destDir=${dest}
          home=${home}
          busy=${busy}
          onChangeDest=${chooseDest}
          onDownload=${download}
          onClear=${() => setSelected(new Set())}
          onPreview=${() => preview(selItems.find((x) => !isOpenable(x)))}
          onProxy=${(item) => openProxyArquivo({ accountId, item })}
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

