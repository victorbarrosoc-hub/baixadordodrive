// Tela Drive: navegar Meu Drive, Compartilhados comigo e drives compartilhados, buscar, criar pasta, enviar para a
// pasta atual e baixar a seleção (barra flutuante embaixo, translúcida como no macOS). No padrão do kit
// (docs/UI-KIT.md): cabeçalho com a ação principal, a faixa colorida com onde você está e o espaço no Drive, filtros em
// pílulas. Botão direito (ou a tecla de menu) numa linha abre o menu do item (drive-menu.js): abrir, baixar, copiar o
// link, renomear, mover para outra pasta… Arrastar linhas para cima de uma pasta também move.
import { html, useEffect, useMemo, useRef, useState } from '/vendor/preact-htm.js'
import { useStore } from '../lib/store.js'
import { navigate } from '../lib/router.js'
import { api, attempt } from '../lib/api.js'
import { bytes, plural, shortPath } from '../lib/format.js'
import { cx, storage, useDebounced, usePersistentState } from '../lib/ui.js'
import { announceBatch, driveFolderUrl, uploadPaths } from '../lib/actions.js'
import { pickDriveFolder, promptDialog } from '../lib/modals.js'
import { openExternal, pickFolderPath, pickUploadPaths } from '../lib/desktop.js'
import { FileDrop } from './drop.js'
import { toast } from '../lib/toasts.js'
import { Icon } from './icons.js'
import { Button, IconButton, MenuButton, Segmented, Spinner } from './common.js'
import { DriveTable, isOpenable } from './drive-table.js'
import { DriveGrid } from './drive-grid.js'
import { DrivePreview } from './drive-preview.js'
import { onProxies, knownProxy, siblingProxies } from '../lib/media.js'
import { SHARED_ID, SHARED_NAME, SHARED_URL, createDriveFolder, crumbsFor, invalidateFolder, isSharedTree, moveDriveItems, renameDriveItem, useAbout, useDriveFolder, useDriveSearch, useSharedDrives } from './drive-data.js'
import { abrirMenuContexto } from './drive-menu.js'
import { hasRawFiles, onRawThumbsDone, openRawThumbs, useRawThumbsRunning } from './raw-thumbs.js'
import { hasVideoFiles, isVideoName, onPreviasDone, openPrevias, openProxyArquivo, usePreviasRunning, useComProxy } from './previa.js'
import { FolderSummary, calcSize, focusSize, getSize, sizeId, useSizes } from './drive-tamanho.js'
import { copyDriveLink, driveLinkFor } from './link-share.js'
import { DEFAULT_SORT, FILTERS, driveView, filterChips, keepVisible, normalizeSort, visibleSummary } from '../lib/ordenar.js'
import { MacLine, SortMenu, openMacTrash } from './drive-ordenar.js'
import { openCopyLink, useCopiaRunning } from './copiar-link.js'
import { CenasPainel } from './cenas.js'
import { Vazio } from './kit.js'

const FOLDER_MIME = 'application/vnd.google-apps.folder'

/** O que copiar de um item da lista: atalho vira o alvo (o link do atalho só abre para quem o criou). */
export function linkTarget(it) {
  if (it.isShortcut && it.shortcutTargetId) return { id: it.shortcutTargetId, resourceKey: it.shortcutTargetResourceKey || null, url: null, isFolder: it.shortcutTargetMimeType === FOLDER_MIME }
  return { id: it.id, resourceKey: it.resourceKey || null, url: it.webViewLink || null, isFolder: !!it.isFolder }
}

/** "Meu Drive / SERHS / Diária 02": o caminho da pasta aberta, para lembrar nos destinos recentes. */
function folderPathText(data, drives) {
  return crumbsFor(data, drives)
    .map((c) => c.name)
    .join(' / ')
}

/** De onde é a pasta aberta: 'root' (Meu Drive), SHARED_ID (Compartilhados comigo) ou o id do drive compartilhado. */
export function sourceOf(data, drives) {
  const folder = data?.folder
  if (folder?.driveId) return folder.driveId
  const first = data?.path?.[0]?.id
  if (first && drives.some((d) => d.id === first)) return first
  return isSharedTree(data, drives) ? SHARED_ID : 'root'
}

/** Fontes: Meu Drive, Compartilhados comigo e drives compartilhados, em pílulas. */
export function SourceChips({ drives, current, onPick, vertical }) {
  return html`<div class=${cx('sources', vertical && 'is-vertical')} role="tablist" aria-label="Onde procurar">
    <button type="button" role="tab" aria-selected=${current === 'root' ? 'true' : 'false'} class=${cx('source', current === 'root' && 'is-on')} onClick=${() => onPick('root')}>
      <${Icon} name="cloud" size=${15} /> Meu Drive
    </button>
    <button type="button" role="tab" aria-selected=${current === SHARED_ID ? 'true' : 'false'} class=${cx('source', current === SHARED_ID && 'is-on')} onClick=${() => onPick(SHARED_ID)} title="Compartilhados comigo: pastas que outras pessoas compartilharam com você">
      <${Icon} name="user" size=${15} /> <span>Compartilhados</span>
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
  const crumbs = crumbsFor({ path, folder }, drives)
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

/** Espaço no Drive da conta, na faixa: quanto está usado e a barra (ou "Sem limite"). */
function Espaco({ accountId }) {
  const about = useAbout(accountId)
  const q = about?.quota
  if (!q) return null
  const frac = q.limit ? Math.min(1, (q.usage || 0) / q.limit) : null
  return html`<div class=${cx('dv-espaco', frac != null && frac > 0.9 && 'is-cheio')} title=${q.limit ? `${bytes(q.usage)} usados de ${bytes(q.limit)}` : `${bytes(q.usage)} usados`}>
    <span class="dv-rot">Espaço no Drive</span>
    <b>${bytes(q.usage || 0)}</b>
    ${frac != null
      ? html`<span class="dv-espaco-barra" role="progressbar" aria-label="Espaço usado no Drive" aria-valuenow=${Math.round(frac * 100)} aria-valuemin="0" aria-valuemax="100"><i style=${`--p:${(frac * 100).toFixed(1)}%`}></i></span>
          <span class="dv-sub">de ${bytes(q.limit)} · ${bytes(Math.max(0, q.limit - (q.usage || 0)))} livres</span>`
      : html`<span class="dv-sub">Sem limite de espaço</span>`}
  </div>`
}

/** Meu Drive, Compartilhados comigo e os drives compartilhados, em pílulas. */
function Fontes({ drives, current, onPick }) {
  return html`<div class="k-pilulas dv-fontes" role="tablist" aria-label="Onde procurar">
    <button type="button" role="tab" aria-selected=${current === 'root' ? 'true' : 'false'} class=${cx('k-pilula', current === 'root' && 'is-on')} onClick=${() => onPick('root')}>
      <${Icon} name="cloud" size=${14} /> Meu Drive
    </button>
    <button type="button" role="tab" aria-selected=${current === SHARED_ID ? 'true' : 'false'} class=${cx('k-pilula', current === SHARED_ID && 'is-on')} onClick=${() => onPick(SHARED_ID)} title="Pastas e arquivos que outras pessoas compartilharam com você">
      <${Icon} name="user" size=${14} /> ${SHARED_NAME}
    </button>
    ${drives.map(
      (d) => html`<button type="button" role="tab" aria-selected=${current === d.id ? 'true' : 'false'} class=${cx('k-pilula', current === d.id && 'is-on')} onClick=${() => onPick(d.id)} title=${d.name}>
        <${Icon} name="users" size=${14} /> <span class="dv-fonte-nome">${d.name}</span>
      </button>`,
    )}
  </div>`
}

/** Filtro por tipo em pílulas, com quantos de cada (só os tipos que existem na pasta). */
function Filtros({ chips, value, onChange }) {
  if (chips.length < 2 && value === 'all') return null
  return html`<div class="k-pilulas dv-filtros" role="radiogroup" aria-label="Mostrar">
    ${chips.map(
      (c) => html`<button type="button" role="radio" aria-checked=${c.value === value ? 'true' : 'false'} class=${cx('k-pilula', c.value === value && 'is-on')} onClick=${() => onChange(c.value === value ? 'all' : c.value)}>
        ${c.label}<span class="k-conta">${c.count}</span>
      </button>`,
    )}
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
      ? html`<${Button} icon="film" onClick=${() => onProxy(files[0])} title="Proxy (cópia leve 720p) para a prévia tocar fluida">Gerar proxy</${Button}>`
      : null}
    <button type="button" class="k-botao dv-baixar" onClick=${onDownload} disabled=${busy} aria-busy=${busy ? 'true' : 'false'}>
      ${busy ? html`<${Spinner} size=${15} />` : html`<${Icon} name="download" size=${16} strokeWidth=${1.9} />`}Baixar
    </button>
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
  // Busca por cena: o painel aberto e o resultado aberto na prévia (o vídeo pode estar em outra pasta).
  const [cenasAberto, setCenasAberto] = usePersistentState('drive.cenas', false)
  const [cenaPrevia, setCenaPrevia] = useState(null) // { item, t }
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
  const sourceId = sourceOf(data, drives)
  // "Compartilhados comigo" (a raiz) não é pasta: não dá para enviar, criar pasta nem somar o tamanho ali. Pasta de
  // outra pessoa em que a conta só lê: também não recebe nada.
  const virtual = !!folder?.virtual
  const podeEnviar = !!folder && !virtual && folder.canAddChildren !== false

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
    if (!podeEnviar) return
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
    if (!podeEnviar) return
    const paths = await pickUploadPaths({ title: `Enviar para “${folderLabel(folder, drives)}”`, anchor: e?.currentTarget })
    if (!paths?.length) return
    await uploadPaths({ accountId, paths, destFolderId: folderId, driveId: folder?.driveId || null, destName: folderLabel(folder, drives), destPath: folderPathText(data, drives) })
  }

  // Copiar de um link: a pasta aberta vira o destino (dá para trocar na janela).
  const copiando = useCopiaRunning()
  const copiarDeLink = () =>
    openCopyLink({ accountId, dest: podeEnviar && !searching ? { id: folderId, name: folderLabel(folder, drives), path: folderPathText(data, drives), driveId: folder.driveId || null } : null })
  // Cópia terminou nesta pasta (ou dentro dela): recarrega para aparecer o que chegou.
  const copiaFim = useStore((s) => (s.copia && s.copia.status !== 'running' ? s.copia : null))
  useEffect(() => {
    if (copiaFim?.dest?.id === folderId) reload()
  }, [copiaFim?.jobId])

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

  // ─────────── menu de contexto e mover ───────────

  // Move `alvo` (itens da lista) para `dest` ({ id, name }). Usado pelo "Mover para…" e pelo arrastar e soltar.
  const mover = async (alvo, dest) => {
    if (!alvo.length || !dest) return
    const res = await attempt(moveDriveItems(accountId, alvo.map((x) => x.id), dest.id, folder?.virtual ? null : folderId))
    if (!res) return
    const n = res.movidos.length
    const para = `“${dest.name}”`
    if (n) toast('success', n === 1 ? `“${alvo.find((x) => x.id === res.movidos[0])?.name || 'Item'}” foi para ${para}.` : `${plural(n, 'item foi', 'itens foram')} para ${para}.`)
    else if (res.ja.length) toast('info', res.ja.length === 1 ? `Já estava em ${para}.` : `Já estavam em ${para}.`)
    if (res.recusados.length) toast('warning', `${plural(res.recusados.length, 'item ficou', 'itens ficaram')} onde ${res.recusados.length === 1 ? 'estava' : 'estavam'}: ${res.recusados[0].error}`)
    if (n) {
      setSelected(new Set())
      reloadRef.current()
    }
  }

  const moverPara = async (alvo) => {
    const nome = alvo.length === 1 ? `“${alvo[0].name}”` : plural(alvo.length, 'item', 'itens')
    const dest = await pickDriveFolder({
      accountId,
      title: `Mover ${nome} para…`,
      subtitle: 'Abra a pasta de destino e clique em Mover para cá (ou marque uma subpasta).',
      confirmLabel: 'Mover para cá',
      initialFolderId: folder && !virtual ? folderId : 'root',
    })
    if (dest) await mover(alvo, dest)
  }

  // Soltar linhas em cima de uma pasta da lista.
  const soltar = (ids, pasta) => {
    const alvo = ids.map((id) => byId.get(id)).filter(Boolean)
    const destId = pasta.isShortcut && pasta.shortcutTargetId ? pasta.shortcutTargetId : pasta.id
    if (alvo.length) mover(alvo, { id: destId, name: pasta.name })
  }

  const renomear = async (it) => {
    const nome = await promptDialog({ title: it.isFolder ? 'Renomear pasta' : 'Renomear arquivo', label: 'Nome', initial: it.name, confirmLabel: 'Renomear' })
    if (!nome || nome === it.name) return
    const item = await attempt(renameDriveItem(accountId, it, nome, folder?.virtual ? null : folderId))
    if (item) {
      toast('success', `Agora se chama “${item.name}”.`)
      await reload()
      setSelected(new Set([item.id]))
    }
  }

  const enviarPara = async (pasta) => {
    const destId = pasta.isShortcut && pasta.shortcutTargetId ? pasta.shortcutTargetId : pasta.id
    const paths = await pickUploadPaths({ title: `Enviar para “${pasta.name}”` })
    if (!paths?.length) return
    const caminho = folderPathText(data, drives)
    await uploadPaths({ accountId, paths, destFolderId: destId, driveId: pasta.driveId || folder?.driveId || null, destName: pasta.name, destPath: caminho ? `${caminho} / ${pasta.name}` : pasta.name })
  }

  const abrirNoDrive = (it) => {
    const t = linkTarget(it)
    openExternal(t.url || driveLinkFor(t.id, t.isFolder, t.resourceKey))
  }

  // O menu do item. Com várias linhas marcadas e o clique numa delas, Baixar e Mover valem para todas.
  const abrirMenu = async (it, ponto) => {
    const varios = selected.has(it.id) && selected.size > 1 ? [...selected].map((id) => byId.get(id)).filter(Boolean) : null
    const alvo = varios || [it]
    const pasta = isOpenable(it)
    const n = alvo.length
    const video = !pasta && isVideoName(it.name)
    const itens = [
      { id: 'abrir', icon: pasta ? 'folder' : 'eye', label: pasta ? 'Abrir' : 'Prévia', hint: pasta ? '' : 'espaço' },
      { id: 'baixar', icon: 'download', label: n > 1 ? `Baixar ${plural(n, 'item', 'itens')}` : 'Baixar', disabled: !n || alvo.every((x) => x.canDownload === false), title: `Baixar em ${shortPath(dest, home) || 'Downloads'}` },
      pasta && !it.isShortcut && it.canAddChildren !== false ? { id: 'enviar', icon: 'upload', label: 'Enviar para esta pasta…' } : null,
      { id: 'link', icon: 'link', label: 'Copiar link', sep: true, disabled: n > 1 },
      { id: 'drive', icon: 'external', label: 'Abrir no Google Drive', disabled: n > 1 },
      { id: 'renomear', icon: 'pencil', label: 'Renomear…', sep: true, disabled: n > 1 || it.canRename === false },
      { id: 'mover', icon: 'arrow-right', label: n > 1 ? `Mover ${plural(n, 'item', 'itens')} para…` : 'Mover para…', disabled: alvo.some((x) => x.canMove === false), title: alvo.some((x) => x.canMove === false) ? 'Sua conta não pode mudar este item de lugar' : undefined },
      pasta && !it.isShortcut ? { id: 'tamanho', icon: 'disk', label: 'Calcular tamanho', sep: true } : null,
      video && n === 1 ? { id: 'proxy', icon: 'film', label: 'Gerar proxy', sep: !pasta } : null,
    ]
    const escolha = await abrirMenuContexto({ titulo: n > 1 ? plural(n, 'item selecionado', 'itens selecionados') : it.name, itens, x: ponto.x, y: ponto.y })
    if (escolha === 'abrir') pasta ? open(it) : preview(it)
    else if (escolha === 'baixar') {
      const res = await attempt(api.post('/api/transfers/download', { accountId, items: alvo, destDir: dest }))
      if (res) announceBatch(res, 'na fila')
    } else if (escolha === 'enviar') enviarPara(it)
    else if (escolha === 'link') copyItemLink(it)
    else if (escolha === 'drive') abrirNoDrive(it)
    else if (escolha === 'renomear') renomear(it)
    else if (escolha === 'mover') moverPara(alvo)
    else if (escolha === 'tamanho') calcFolder(it)
    else if (escolha === 'proxy') openProxyArquivo({ accountId, item: it })
  }

  const emptyView =
    shown.filter !== 'all' && items?.length
      ? html`<${Vazio} icone="filter" titulo=${`Nenhum ${filterDef.one} ${searching ? 'nos resultados' : 'nesta pasta'}`} acoes=${html`<${Button} onClick=${() => setFilter('all')}>Mostrar tudo</${Button}>`} />`
      : shown.mac.length && !showMac && items?.length === shown.mac.length
        ? html`<${Vazio} icone="eye" titulo="Só arquivos de controle do Mac aqui" acoes=${html`<${Button} onClick=${() => setShowMac(true)}>Mostrar</${Button}>`}>${shown.mac.length === 1 ? 'Ele está oculto.' : 'Eles estão ocultos.'}</${Vazio}>`
        : searching
          ? html`<${Vazio} icone="search" titulo=${`Nada com “${q.trim()}” no nome`} acoes=${html`<${Button} icon="x" onClick=${() => setQuery('')}>Limpar a busca</${Button}>`}>Confira a escrita ou procure por outra parte do nome.</${Vazio}>`
          : virtual
            ? html`<${Vazio} icone="user" titulo="Nada compartilhado com você">Quando alguém compartilhar uma pasta ou arquivo com esta conta, aparece aqui.</${Vazio}>`
            : !podeEnviar
              ? html`<${Vazio} icone="folder" titulo="Pasta vazia">Você só pode ver esta pasta: quem é dono não liberou enviar para ela.</${Vazio}>`
              : html`<${Vazio} icone="folder" titulo="Pasta vazia" acoes=${html`<${Button} icon="upload" onClick=${uploadHere}>Enviar para esta pasta</${Button}>`}>Mande arquivos do computador para cá, ou arraste e solte em qualquer lugar da tela.</${Vazio}>`

  const macLine = shown.mac.length
    ? html`<${MacLine} mac=${shown.mac} shown=${showMac} onToggle=${() => setShowMac(!showMac)} onTrash=${!searching && folder ? () => trashMac() : null} />`
    : null
  const filtro = shown.filter !== 'all' ? visibleSummary(sorted, shown.filter) : null

  const onKeyDownPage = (e) => {
    if (e.key === 'Escape' && selected.size) setSelected(new Set())
  }

  const ondeIcone = searching ? 'search' : folderId === 'root' ? 'cloud' : virtual ? 'user' : drives.some((d) => d.id === folderId) ? 'users' : 'folder'
  const resumoPasta =
    !searching && accountId && virtual
      ? html`<div class="drive-sum"><span class="dsum-main" aria-live="polite"><span class="dsum-count">${data?.items ? plural(data.items.length, 'item compartilhado com você', 'itens compartilhados com você') : 'Carregando…'}</span></span></div>`
      : !searching && accountId
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
        : searching && items
          ? html`<div class="drive-sum"><span class="dsum-main" aria-live="polite"><span class="dsum-count">${plural(items.length, 'resultado', 'resultados')}</span></span></div>`
          : null

  if (!accountId) {
    return html`<div class="page page-drive k-pagina">
      <header class="k-cabeca k-entra" style="--i:0"><div><h1>Drive</h1><p>Seus arquivos no Google Drive: abra as pastas, veja a prévia e baixe no computador.</p></div></header>
      <${Vazio} icone="cloud" titulo="Nenhuma conta do Google conectada" acoes=${html`<${Button} variant="primary" icon="sliders" onClick=${() => navigate('ajustes')}>Abrir os Ajustes</${Button}>`}>Entre com a conta SOBEDESCE ou conecte um Google Drive para ver os arquivos aqui.</${Vazio}>
    </div>`
  }

  return html`<div class=${cx('page page-drive k-pagina', selected.size && 'has-selbar')} onKeyDown=${onKeyDownPage}>
    <${FileDrop}
      label=${folderLabel(folder, drives)}
      enabled=${podeEnviar && !!accountId}
      onPaths=${(paths) => uploadPaths({ accountId, paths, destFolderId: folderId, driveId: folder?.driveId || null, destName: folderLabel(folder, drives), destPath: folderPathText(data, drives) })}
    />
    <header class="k-cabeca k-entra" style="--i:0">
      <div>
        <h1>Drive</h1>
        <p>Seus arquivos no Google Drive: abra as pastas, veja a prévia e baixe no computador.</p>
      </div>
      <div class="k-cabeca-acoes">
        <${Button} icon="link" class=${cx(copiando && 'is-copying')} onClick=${copiarDeLink} title="Copiar uma pasta ou arquivo do Drive de outra pessoa (pelo link) para o seu Drive">
          ${copiando ? `Copiando ${copiando.progress?.done || 0}/${copiando.progress?.total || 0}` : 'Copiar de um link'}
        </${Button}>
        <button type="button" class="k-botao dv-enviar" onClick=${uploadHere} disabled=${searching || (folder && !podeEnviar)} title=${searching ? 'Saia da busca para escolher a pasta de destino' : virtual ? 'Abra uma das pastas compartilhadas para enviar para ela' : folder && !podeEnviar ? 'Você só pode ver esta pasta' : `Enviar arquivos do computador para “${folderLabel(folder, drives)}”`}>
          <${Icon} name="upload" size=${17} strokeWidth=${1.9} />Enviar para esta pasta
        </button>
      </div>
    </header>
    <${Fontes} drives=${drives} current=${searching ? null : sourceId} onPick=${(id) => { setQuery(''); openId(id) }} />
    <section class=${cx('dv-faixa k-entra', searching && 'is-busca')} style="--i:1" aria-label="Onde você está">
      <span class="dv-onde-ic" aria-hidden="true"><${Icon} name=${ondeIcone} size=${20} strokeWidth=${1.8} /></span>
      <div class="dv-onde">
        ${searching
          ? html`<div class="crumbs"><span class="crumb is-current">Resultados para “${q.trim()}”</span>${search.loading ? html`<${Spinner} size=${14} />` : null}</div>`
          : html`<${Breadcrumb} path=${data?.path} folder=${folder} drives=${drives} onOpen=${openId} />`}
        ${resumoPasta}
      </div>
      <${Espaco} accountId=${accountId} />
    </section>
    <div class="dv-barra k-entra" style="--i:2">
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
      <${Filtros} chips=${chips} value=${shown.filter} onChange=${setFilter} />
      <div class="dv-ferramentas">
        <div class="drive-tools" role="group" aria-label="Ordenar">
          <${SortMenu} sort=${sort} onSort=${setSort} />
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
        ${!searching && folder && folderId !== 'root' && !virtual ? html`<${IconButton} icon="link" label="Copiar link da pasta" onClick=${copyFolderLink} />` : null}
        ${!searching && folder ? html`<a class="icon-btn" href=${folderId === 'root' ? 'https://drive.google.com/drive/my-drive' : virtual ? SHARED_URL : driveFolderUrl(folderId)} target="_blank" rel="noopener" title="Abrir no navegador" aria-label="Abrir no navegador"><${Icon} name="external" /></a>` : null}
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
              ? { icon: 'film', label: 'Gerar proxies da pasta', busy: previasRunning, title: 'Proxy (cópia leve 720p, pasta Proxy) dos vídeos desta pasta, para a prévia tocar fluida', onSelect: () => openPrevias({ accountId, folder: { id: folderId, name: folderLabel(folder, drives) } }) }
              : null,
            { icon: 'folder-plus', label: 'Nova pasta', disabled: searching || !podeEnviar, onSelect: newFolder },
            { icon: 'link', label: 'Copiar de um link para cá…', title: 'Copiar uma pasta ou arquivo do Drive de outra pessoa (pelo link) para esta pasta', disabled: searching || !podeEnviar, onSelect: copiarDeLink },
          ]}
        />
        <button type="button" class=${cx('cn-botao dv-cenas', cenasAberto && 'is-on')} aria-pressed=${cenasAberto ? 'true' : 'false'} onClick=${() => setCenasAberto(!cenasAberto)} title="Achar momentos nos vídeos escrevendo o que você quer (noiva, DJ, criança entrando…)">
          <${Icon} name="sparkle" size=${15} />Procurar cenas
        </button>
      </div>
    </div>
    ${cenasAberto && !searching
      ? html`<${CenasPainel}
          accountId=${accountId}
          folderId=${folderId}
          folderNome=${folder ? folderLabel(folder, drives) : ''}
          videosAqui=${(data?.items || []).filter((it) => !it.isFolder && isVideoName(it.name)).length}
          onAbrir=${(item, t) => setCenaPrevia({ item, t })}
          onFechar=${() => setCenasAberto(false)}
        />`
      : null}
    <div class=${cx('card dv-lista k-entra', view === 'grid' ? 'card-grid' : 'card-table')} style="--i:3">
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
            onMenu=${abrirMenu}
            onSoltar=${soltar}
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
            onMenu=${abrirMenu}
            onSoltar=${soltar}
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
    ${cenaPrevia
      ? html`<${DrivePreview}
          accountId=${accountId}
          items=${[cenaPrevia.item]}
          index=${0}
          inicioDe=${() => cenaPrevia.t}
          onIndex=${() => {}}
          onClose=${() => setCenaPrevia(null)}
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
  if (folder.id === SHARED_ID) return SHARED_NAME
  const shared = drives?.find((d) => d.id === folder.id)
  return shared ? shared.name : folder.name
}

