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
import { Button, IconButton, MenuButton, Segmented, Spinner } from './common.js'
import { DriveTable, isOpenable } from './drive-table.js'
import { DriveGrid } from './drive-grid.js'
import { DrivePreview } from './drive-preview.js'
import { onProxies, knownProxy, siblingProxies } from '../lib/media.js'
import { createDriveFolder, useAbout, useDriveFolder, useDriveSearch, useSharedDrives } from './drive-data.js'
import { hasRawFiles, onRawThumbsDone, openRawThumbs, useRawThumbsRunning } from './raw-thumbs.js'
import { hasVideoFiles, isVideoName, onPreviasDone, openPrevias, openProxyArquivo, usePreviasRunning, useComProxy } from './previa.js'
import { FolderSummary, calcSize, focusSize, getSize, sizeId, useSizes } from './drive-tamanho.js'
import { copyDriveLink } from './link-share.js'
import { DEFAULT_SORT, FILTERS, driveView, filterChips, keepVisible, normalizeSort, visibleSummary } from '../lib/ordenar.js'
import { FilterMenu, MacLine, SortMenu, openMacTrash } from './drive-ordenar.js'

const FOLDER_MIME = 'application/vnd.google-apps.folder'

/** O que copiar de um item da lista: atalho vira o alvo (o link do atalho só abre para quem o criou). */
export function linkTarget(it) {
  if (it.isShortcut && it.shortcutTargetId) return { id: it.shortcutTargetId, resourceKey: it.shortcutTargetResourceKey || null, url: null, isFolder: it.shortcutTargetMimeType === FOLDER_MIME }
  return { id: it.id, resourceKey: it.resourceKey || null, url: it.webViewLink || null, isFolder: !!it.isFolder }
}

/** "Meu Drive / SERHS / Diária 02": o caminho da pasta aberta, para lembrar nos destinos recentes. */
function folderPathText(data, drives) {
  const list = (data?.path || []).slice()
  if (data?.folder && (!list.length || list[list.length - 1].id !== data.folder.id)) list.push({ id: data.folder.id, name: data.folder.name })
  return list
    .map((c, i) => {
      if (i) return c.name
      const shared = drives?.find((d) => d.id === c.id)
      return shared ? shared.name : c.id === 'root' || !data?.folder?.driveId ? 'Meu Drive' : c.name
    })
    .join(' / ')
}

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

function SelectionBar({ items, destDir, home, onChangeDest, onDownload, onClear, busy, onPreview, accountId, onProxy, onCopyLink }) {
  const files = items.filter((x) => !isOpenable(x))
  const folderItems = items.filter(isOpenable)
  const folders = folderItems.length
  // Pastas com o tamanho já somado entram no total; as outras ficam no botão "Calcular tamanho".
  const sized = folderItems.map((x) => getSize(accountId, sizeId(x)))
  const unknown = folderItems.filter((x, i) => sized[i]?.status !== 'done')
  const calculating = sized.some((v) => v?.status === 'running' || v?.status === 'queued')
  const size = files.reduce((a, x) => a + (x.size || 0), 0) + sized.reduce((a, v) => a + (v?.status === 'done' ? v.bytes : 0), 0)
  const docs = files.filter((x) => x.isGoogleDoc).length
  const parts = [plural(items.length, 'item', 'itens')]
  if (size && !unknown.length) parts.push(bytes(size))
  else if (size) parts.push(`${bytes(size)} + ${unknown.length === 1 ? 'pasta' : 'pastas'}`)
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
    ${unknown.length
      ? html`<${Button} icon="disk" loading=${calculating} onClick=${() => unknown.forEach((x) => calcSize(accountId, sizeId(x)))} title="Somar tudo o que tem dentro das pastas escolhidas">${calculating ? 'Calculando…' : 'Calcular tamanho'}</${Button}>`
      : null}
    ${onPreview && files.length ? html`<${Button} icon="eye" class="selbar-compact" aria-label="Prévia" onClick=${onPreview} title="Prévia (espaço)">Prévia</${Button}>` : null}
    ${onCopyLink && items.length === 1
      ? html`<${Button} icon="link" class="selbar-compact" aria-label="Copiar link" onClick=${() => onCopyLink(items[0])} title="Copiar o link para mandar (e ver quem consegue abrir)">Copiar link</${Button}>`
      : null}
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
  const [sortSaved, setSort] = usePersistentState('drive.sort', DEFAULT_SORT)
  const sort = normalizeSort(sortSaved)
  // Filtro por tipo e arquivos do Mac à vista: valem para a pasta aberta (com "Vídeos" fixo as subpastas sumiriam).
  const [filter, setFilter] = useState('all')
  const [showMac, setShowMac] = useState(false)
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
  // Tamanho das pastas: só a conta desta pasta (e as pedidas aqui) seguem; sair do Drive esquece as que andavam.
  useSizes()
  useEffect(() => {
    focusSize(accountId, folderId)
  }, [accountId, folderId])
  useEffect(() => () => focusSize(null, null), [])
  const sizeOf = (it) => (accountId && isOpenable(it) ? getSize(accountId, sizeId(it)) : null)
  const calcFolder = (it) => calcSize(accountId, sizeId(it))

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
  useEffect(() => {
    setFilter('all')
    setShowMac(false)
  }, [folderId, accountId])
  // lembra a pasta aberta: soltar arquivos na tela Transferências envia para cá
  useEffect(() => {
    if (folder && accountId) storage.set('drive.last', { accountId, id: folder.id, name: folderLabel(folder, drives), driveId: folder.driveId || null })
  }, [folder?.id, accountId, drives.length])
  useEffect(() => {
    api.get('/api/local/roots').then((r) => setHome(r.home || '')).catch(() => {})
  }, [])

  // O que está à vista: sem os arquivos do Mac (a menos que "Mostrar"), só o tipo do filtro, na ordem escolhida.
  // Seleção, "Selecionar tudo", Baixar e a prévia (←/→) valem só sobre isso.
  const shown = useMemo(() => driveView(items, { sort, filter, showMac }), [items, sort.key, sort.dir, filter, showMac])
  const sorted = shown.sorted
  const byId = useMemo(() => new Map(sorted.map((x) => [x.id, x])), [sorted])
  useEffect(() => setSelected((s) => keepVisible(s, sorted)), [sorted])
  const chips = filterChips(shown.counts, shown.filter)
  const filterDef = FILTERS.find((f) => f.value === shown.filter)
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
    await uploadPaths({ accountId, paths, destFolderId: folderId, driveId: folder?.driveId || null, destName: folderLabel(folder, drives), destPath: folderPathText(data, drives) })
  }

  const copyItemLink = (it) => copyDriveLink({ accountId, name: it.name, ...linkTarget(it) })
  const copyFolderLink = () =>
    folder && copyDriveLink({ accountId, id: folder.id, name: folderLabel(folder, drives), isFolder: true, url: folder.webViewLink || null, resourceKey: folder.resourceKey || null })

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

  // A pasta recarrega assim que algo vai para a lixeira (por trás da janela, que mostra o resultado).
  const trashMac = () =>
    openMacTrash({
      accountId,
      folderId,
      folderName: folderLabel(folder, drives),
      mac: shown.mac,
      onMoved: () => {
        reloadRef.current()
        if (getSize(accountId, folderId)?.status === 'done') calcSize(accountId, folderId, { refresh: true })
      },
    })

  const emptyView =
    shown.filter !== 'all' && items?.length
      ? html`<div class="table-empty"><${Icon} name="search" size=${22} /><b>Nenhum ${filterDef.one} ${searching ? 'nos resultados' : 'nesta pasta'}</b><button type="button" class="btn btn-secondary btn-sm" onClick=${() => setFilter('all')}><span>Mostrar tudo</span></button></div>`
      : shown.mac.length && !showMac && items?.length === shown.mac.length
        ? html`<div class="table-empty"><${Icon} name="eye-off" size=${22} /><b>Só arquivos de controle do Mac aqui</b><span>${shown.mac.length === 1 ? 'Está oculto.' : 'Estão ocultos.'}</span><button type="button" class="btn btn-secondary btn-sm" onClick=${() => setShowMac(true)}><span>Mostrar</span></button></div>`
        : searching
          ? html`<span>Nada com “${q.trim()}” no nome.</span>`
          : html`<div class="table-empty"><${Icon} name="folder" size=${22} /><b>Pasta vazia</b><span>Use “Enviar para esta pasta” para mandar arquivos para cá.</span></div>`

  const macLine = shown.mac.length
    ? html`<${MacLine} mac=${shown.mac} shown=${showMac} onToggle=${() => setShowMac(!showMac)} onTrash=${!searching && folder ? () => trashMac() : null} />`
    : null
  const filtro = shown.filter !== 'all' ? visibleSummary(sorted, shown.filter) : null

  const onKeyDownPage = (e) => {
    if (e.key === 'Escape' && selected.size) setSelected(new Set())
  }

  return html`<div class=${cx('page page-drive', selected.size && 'has-selbar')} onKeyDown=${onKeyDownPage}>
    <${FileDrop}
      label=${folderLabel(folder, drives)}
      enabled=${!!folder && !!accountId}
      onPaths=${(paths) => uploadPaths({ accountId, paths, destFolderId: folderId, driveId: folder?.driveId || null, destName: folderLabel(folder, drives), destPath: folderPathText(data, drives) })}
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
        <div class="drive-tools" role="group" aria-label="Ordenar e filtrar">
          <${SortMenu} sort=${sort} onSort=${setSort} />
          <${FilterMenu} chips=${chips} value=${shown.filter} onChange=${setFilter} />
        </div>
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
        ${!searching && folder && folderId !== 'root' ? html`<${IconButton} icon="link" label="Copiar link da pasta" onClick=${copyFolderLink} />` : null}
        ${!searching && folder ? html`<a class="icon-btn" href=${folderId === 'root' ? 'https://drive.google.com/drive/my-drive' : driveFolderUrl(folderId)} target="_blank" rel="noopener" title="Abrir no navegador" aria-label="Abrir no navegador"><${Icon} name="external" /></a>` : null}
        <${MenuButton}
          class="more-menu"
          label="Mais"
          title="Mais ações da pasta"
          menuLabel="Mais ações da pasta"
          busy=${thumbsRunning || previasRunning}
          items=${[
            !searching && folder && (hasRawFiles(items) || thumbsRunning)
              ? { icon: 'photo', label: 'Gerar miniaturas', busy: thumbsRunning, title: 'Miniatura para os BRAW/R3D, a partir dos originais no computador', onSelect: () => openRawThumbs({ accountId, folder: { id: folderId, name: folderLabel(folder, drives) } }) }
              : null,
            !searching && folder && (hasVideoFiles(items, folder) || previasRunning)
              ? { icon: 'film', label: 'Gerar proxies da pasta', busy: previasRunning, title: 'Proxy (cópia leve 1080p, pasta Proxy) dos vídeos desta pasta, para a prévia tocar fluida', onSelect: () => openPrevias({ accountId, folder: { id: folderId, name: folderLabel(folder, drives) } }) }
              : null,
            { icon: 'folder-plus', label: 'Nova pasta', disabled: searching, onSelect: newFolder },
          ]}
        />
        <${Button} variant="primary" icon="upload" onClick=${uploadHere} disabled=${searching}>Enviar para esta pasta</${Button}>
      </div>
    </div>
    ${!searching && accountId
      ? html`<${FolderSummary}
          accountId=${accountId}
          folderId=${folderId}
          items=${data?.items || null}
          count=${shown.counts.all}
          ready=${!!folder && !error}
          filtro=${filtro}
          extra=${macLine}
        />`
      : searching && items && (filtro || macLine)
        ? html`<div class="drive-sum is-filtered">
            <span class="dsum-main" aria-live="polite">${filtro ? html`<span class="dsum-count"><b>${filtro}</b></span>` : null}</span>
            ${macLine ? html`<span class="dsum-end">${macLine}</span>` : null}
          </div>`
        : null}
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
            sizeOf=${sizeOf}
            comProxy=${comProxy}
            loading=${searching ? search.loading : loading}
            error=${searching ? search.error : error}
            onRetry=${reload}
            resetKey=${searching ? 'q:' + q : folderId}
            empty=${emptyView}
          />`
        : html`<${DriveTable}
            items=${items}
            sorted=${sorted}
            selected=${selected}
            onSelect=${setSelected}
            onOpen=${open}
            onPreview=${preview}
            accountId=${accountId}
            proxies=${proxies}
            sizeOf=${sizeOf}
            onCalcSize=${calcFolder}
            onCopyLink=${copyItemLink}
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
          accountId=${accountId}
          onPreview=${() => preview(selItems.find((x) => !isOpenable(x)))}
          onProxy=${(item) => openProxyArquivo({ accountId, item })}
          onCopyLink=${copyItemLink}
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

