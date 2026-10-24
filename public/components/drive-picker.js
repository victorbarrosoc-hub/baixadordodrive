// Seletor de pasta do Drive (para Comparar e para escolher onde enviar). Reaproveita a tabela do Drive em modo pasta.
import { html, useEffect, useMemo, useState } from '/vendor/preact-htm.js'
import { attempt } from '../lib/api.js'
import { promptDialog } from '../lib/modals.js'
import { storage, useDebounced } from '../lib/ui.js'
import { esquecerDestino, recentes } from '../lib/destinos.js'
import { Icon } from './icons.js'
import { Button, Spinner } from './common.js'
import { useStore } from '../lib/store.js'
import { ProxyChoice, proxyPadrao } from './previa.js'
import { Modal } from './modal.js'
import { DriveTable } from './drive-table.js'
import { Breadcrumb, SourceChips, sourceOf } from './drive.js'
import { SHARED_ID, createDriveFolder, crumbsFor, useDriveFolder, useFolderSearch, useSharedDrives } from './drive-data.js'

/** "Meu Drive / SERHS / 01 Brutos / Diária 02" → "em 01 Brutos" (a pasta de cima; o caminho todo fica na dica). */
function parentOf(path) {
  const parts = String(path).split(' / ')
  return parts.length > 1 ? `em ${parts[parts.length - 2]}` : ''
}

function crumbsOf(data, drives) {
  return data?.folder || data?.path?.length ? crumbsFor(data, drives).map((c) => c.name) : []
}

/** Resultados de "Buscar pasta": nome e, embaixo, onde ela está (para diferenciar duas "Diária 02"). */
function FolderResults({ search, term, onOpen }) {
  if (search.loading && !search.items?.length) return html`<div class="table-msg"><${Spinner} size=${16} /><span>Procurando pastas…</span></div>`
  if (search.error) return html`<div class="table-msg is-error"><${Icon} name="warning" size=${18} /><span>${search.error}</span></div>`
  if (!search.items?.length) return html`<div class="table-msg"><div class="table-empty"><${Icon} name="search" size=${22} /><b>Nenhuma pasta com “${term}” no nome</b><span>O Drive acha pelo começo das palavras: tente outro pedaço do nome.</span></div></div>`
  return html`<ul class="folder-results" aria-label="Pastas encontradas" aria-busy=${search.loading ? 'true' : 'false'}>
    ${search.items.map((r) => {
      const where = r.path?.length ? r.path.join(' / ') : null
      return html`<li key=${r.id}>
        <button type="button" class="folder-result" onClick=${() => onOpen(r)} title=${where ? `${where} / ${r.name}` : r.name}>
          <${Icon} name="folder" size=${18} />
          <span class="folder-result-text">
            <span class="name">${r.name}</span>
            <span class="sub">${where ? `em ${where}` : 'pasta compartilhada com você'}</span>
          </span>
          <${Icon} name="chevron-right" size=${14} class="folder-result-go" />
        </button>
      </li>`
    })}
  </ul>`
}

/**
 * `arquivo`: escolher um ARQUIVO em vez de pasta (ex.: o vídeo do Frames). Recebe { aceita(item), nome } e devolve o
 * item do Drive escolhido (dois cliques também escolhem).
 */
export function DrivePicker({ accountId, title = 'Escolha uma pasta do Drive', subtitle, confirmLabel, initialFolderId = 'root', proxyChoice = false, destinos = false, arquivo = null, onClose }) {
  const [folderId, setFolderId] = useState(initialFolderId || 'root')
  const [query, setQuery] = useState('')
  const q = useDebounced(query, 300).trim()
  const [recent, setRecent] = useState(() => (destinos ? recentes(storage, accountId) : []))
  // Envio: "Gerar proxy dos vídeos" deste envio (marcado pelo ajuste; em "Perguntar", em destaque).
  const settings = useStore((s) => s.settings)
  const [proxy, setProxy] = useState(() => proxyPadrao(settings))
  const extra = proxyChoice ? { proxy } : {}
  const [selected, setSelected] = useState(new Set())
  const drives = useSharedDrives(accountId)
  const { data, loading, error, errorStatus, reload } = useDriveFolder(accountId, folderId)
  const folder = data?.folder
  const sourceId = sourceOf(data, drives)
  // Buscar pasta: no escopo aberto (Meu Drive ou o drive compartilhado da pasta atual). A busca do Meu Drive já
  // inclui o que foi compartilhado com você.
  const searching = !!q
  const search = useFolderSearch(accountId, q, sourceId === SHARED_ID ? 'root' : sourceId)
  const scopeName = sourceId === 'root' ? 'Meu Drive' : sourceId === SHARED_ID ? 'Meu Drive e compartilhados' : drives.find((d) => d.id === sourceId)?.name || 'neste drive'
  // "Compartilhados comigo" não é pasta, e pasta de outra pessoa só para ver não recebe nada: aí só vale marcar uma subpasta.
  const soVer = !!folder && (folder.virtual || folder.canAddChildren === false)

  // A última pasta de destino sumiu (apagada, sem acesso): sai dos Recentes e o seletor abre no Meu Drive.
  useEffect(() => {
    if (error && errorStatus === 404 && !data && folderId === initialFolderId && folderId !== 'root') {
      if (destinos) setRecent(esquecerDestino(storage, accountId, folderId))
      setFolderId('root')
    }
  }, [error, errorStatus, folderId])

  const open = (it) => {
    setSelected(new Set())
    setQuery('')
    setFolderId(it.isShortcut && it.shortcutTargetId ? it.shortcutTargetId : it.id)
  }
  // Recente: um clique escolhe (é o destino de sempre).
  const pickRecent = (r) => onClose({ id: r.id, name: r.name, path: r.path || r.name, driveId: r.driveId || null, ...extra })
  const byId = useMemo(() => new Map((data?.items || []).map((x) => [x.id, x])), [data])
  const chosenSub = [...selected].map((id) => byId.get(id)).find(Boolean)
  const crumbs = crumbsOf(data, drives)

  const confirm = () => {
    if (!folder) return
    if (arquivo) {
      if (chosenSub) onClose(chosenSub)
      return
    }
    if (!chosenSub && soVer) return
    if (chosenSub) {
      onClose({ id: chosenSub.id, name: chosenSub.name, path: [...crumbs, chosenSub.name].join(' / '), driveId: chosenSub.driveId || folder.driveId || null, ...extra })
    } else {
      onClose({ id: folder.id, name: crumbs[crumbs.length - 1] || folder.name, path: crumbs.join(' / '), driveId: folder.driveId || null, ...extra })
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

  const label =
    !arquivo && soVer && !chosenSub
      ? 'Escolha uma pasta'
      : confirmLabel || (arquivo ? (chosenSub ? `Escolher “${chosenSub.name}”` : `Escolha ${arquivo.nome || 'o arquivo'}`) : chosenSub ? `Escolher “${chosenSub.name}”` : 'Escolher esta pasta')

  return html`<${Modal}
    size="xl"
    class="picker picker-drive"
    title=${title}
    subtitle=${subtitle || (arquivo ? 'Dê dois cliques para entrar numa pasta ou para escolher o arquivo.' : 'Dê dois cliques para entrar numa pasta. Sem nada marcado, vale a pasta aberta.')}
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
      ${arquivo ? null : html`<${Button} icon="folder-plus" onClick=${newFolder} disabled=${!folder || soVer}>Nova pasta</${Button}>`}
      <${Button} onClick=${() => onClose(null)}>Cancelar</${Button}>
      <${Button} variant="primary" onClick=${confirm} disabled=${!folder || (arquivo && !chosenSub) || (!arquivo && soVer && !chosenSub)}>${label}</${Button}>
    `}
  >
    <div class="picker-grid">
      <aside class="picker-side" aria-label="Drives">
        <div class="side-label">Drives</div>
        <${SourceChips} vertical drives=${drives} current=${sourceId} onPick=${(id) => { setSelected(new Set()); setQuery(''); setFolderId(id) }} />
        ${recent.length
          ? html`<div class="side-label picker-recent-label">Recentes</div>
              <ul class="picker-recent" aria-label="Pastas de destino recentes">
                ${recent.map(
                  (r) => html`<li key=${r.id}>
                    <button type="button" class="picker-recent-item" onClick=${() => pickRecent(r)} title=${`Escolher ${r.path || r.name}`}>
                      <${Icon} name="clock" size=${15} />
                      <span class="picker-recent-text"><span class="name">${r.name}</span>${r.path && r.path !== r.name ? html`<span class="sub">${parentOf(r.path)}</span>` : null}</span>
                    </button>
                  </li>`,
                )}
              </ul>`
          : null}
      </aside>
      <section class="picker-main">
        <div class="picker-bar">
          ${searching
            ? html`<div class="crumbs"><span class="crumb is-current">Pastas com “${q}” em ${scopeName}</span>${search.loading ? html`<${Spinner} size=${14} />` : null}</div>`
            : html`<${Breadcrumb} path=${data?.path} folder=${folder} drives=${drives} onOpen=${(id) => { setSelected(new Set()); setFolderId(id) }} />`}
          <label class="search picker-search">
            <${Icon} name="search" size=${15} />
            <input
              type="search"
              placeholder="Buscar pasta"
              value=${query}
              onInput=${(e) => setQuery(e.currentTarget.value)}
              onKeyDown=${(e) => {
                if (e.key === 'Escape' && query) {
                  e.preventDefault()
                  e.stopPropagation()
                  setQuery('')
                }
              }}
              aria-label=${`Buscar pasta em ${scopeName}`}
              title=${`Procura pelo nome em ${scopeName} inteiro`}
              autocomplete="off"
              spellcheck="false"
            />
          </label>
        </div>
        ${searching
          ? html`<div class="picker-results"><${FolderResults} search=${search} term=${q} onOpen=${open} /></div>`
          : html`<${DriveTable}
          mode=${arquivo ? 'file' : 'folder'}
          pode=${arquivo?.aceita}
          onPick=${(it) => onClose(it)}
          accountId=${arquivo ? accountId : undefined}
          compact
          items=${data?.items || null}
          selected=${selected}
          onSelect=${setSelected}
          onOpen=${open}
          loading=${loading}
          error=${error}
          onRetry=${reload}
          resetKey=${folderId}
          empty=${arquivo
            ? html`<div class="table-empty"><${Icon} name="film" size=${22} /><b>Pasta vazia</b><span>Volte e abra outra pasta.</span></div>`
            : html`<div class="table-empty"><${Icon} name="folder" size=${22} /><b>Sem subpastas</b><span>Escolha esta mesma ou crie uma nova.</span></div>`}
        />`}
        ${proxyChoice ? html`<div class="picker-proxy"><${ProxyChoice} checked=${proxy} onChange=${setProxy} ask=${settings?.proxyAoEnviar === 'perguntar'} /></div>` : null}
      </section>
    </div>
  </${Modal}>`
}
