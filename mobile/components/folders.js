// Escolher a pasta de destino: Recentes (um toque), Meu Drive e drives compartilhados; só pastas; nova pasta.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js'
import { LAN } from '../lib/config.js'
import { createFolder, listFolders, listSharedDrives } from '../lib/drive.js'
import { closeSheet, folderTrail, getRecents, pushRecent, setState, toast, useApp } from '../lib/state.js'
import { Icon } from './icons.js'
import { Button, SheetHead, cx } from './ui.js'

const cache = new Map() // id → pastas (vale enquanto a página está aberta)

/** path = [{ id, name }] a partir da raiz do drive; driveId = null no Meu Drive. [] = Início. */
function toFolder(path, driveId) {
  const last = path[path.length - 1]
  return { id: last.id, name: last.name, driveId: driveId || null, path }
}

function useList(key, load) {
  const [state, setLocal] = useState(() => (cache.has(key) ? { data: cache.get(key) } : { loading: true }))
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (cache.has(key)) {
      setLocal({ data: cache.get(key) })
      return
    }
    const ctl = new AbortController()
    setLocal({ loading: true })
    load(ctl.signal).then(
      (data) => {
        cache.set(key, data)
        if (!ctl.signal.aborted) setLocal({ data })
      },
      (err) => {
        if (!ctl.signal.aborted) setLocal({ error: err })
      },
    )
    return () => ctl.abort()
  }, [key, nonce])
  const reload = () => {
    cache.delete(key)
    setNonce((n) => n + 1)
  }
  const add = (item) => {
    const next = [...(cache.get(key) || []), item].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }))
    cache.set(key, next)
    setLocal({ data: next })
  }
  return { ...state, reload, add }
}

function SkeletonRows({ n = 6 }) {
  return html`${Array.from({ length: n }, (_, i) => html`<li key=${i} class="frow is-skeleton" aria-hidden="true">
      <span class="frow-icon skeleton"></span><span class="skeleton skeleton-line" style=${`width:${40 + ((i * 17) % 40)}%`}></span>
    </li>`)}`
}

function ErrorRow({ error, onRetry }) {
  return html`<li class="frow-msg">
    <${Icon} name="warning" size=${20} />
    <p>${error?.lan ? error.message : error?.status === 0 ? 'Sem conexão com o Google.' : 'Não consegui abrir esta pasta.'}</p>
    <${Button} size="sm" variant="secondary" icon="refresh" onClick=${onRetry}>Tentar de novo</${Button}>
  </li>`
}

function FolderRow({ icon = 'folder', name, sub, onClick, chevron = true, tone }) {
  return html`<li>
    <button type="button" class=${cx('frow', tone && `is-${tone}`)} onClick=${onClick}>
      <span class="frow-icon" aria-hidden="true"><${Icon} name=${icon} size=${20} /></span>
      <span class="frow-text">
        <span class="frow-name">${name}</span>
        ${sub ? html`<span class="frow-sub">${sub}</span>` : null}
      </span>
      ${chevron ? html`<${Icon} name="chevron-right" size=${16} strokeWidth=${2} class="frow-chev" />` : null}
    </button>
  </li>`
}

function Home({ account, onOpen, onPick }) {
  const recents = getRecents(account)
  const drives = useList('#drives', (signal) => listSharedDrives(signal))
  return html`<div class="fhome">
    ${recents.length
      ? html`<h3 class="list-label">Recentes</h3>
          <ul class="group flist">
            ${recents.map(
              (r) => html`<${FolderRow}
                key=${r.id}
                icon="clock"
                name=${r.name}
                sub=${folderTrail(r, { skipLast: true }) || (r.driveId ? 'Drive compartilhado' : 'Meu Drive')}
                onClick=${() => onPick(r)}
                chevron=${false}
                tone="recent"
              />`,
            )}
          </ul>`
      : null}
    <h3 class="list-label">Locais</h3>
    <ul class="group flist">
      <${FolderRow} icon="disk" name="Meu Drive" onClick=${() => onOpen([{ id: 'root', name: 'Meu Drive' }], null)} />
    </ul>
    ${drives.loading || drives.error || drives.data?.length
      ? html`<h3 class="list-label">Drives compartilhados</h3>
          <ul class="group flist">
            ${drives.loading ? html`<${SkeletonRows} n=${2} />` : null}
            ${drives.error ? html`<${ErrorRow} error=${drives.error} onRetry=${drives.reload} />` : null}
            ${(drives.data || []).map(
              (d) => html`<${FolderRow} key=${d.id} icon="shared-drive" name=${d.name} onClick=${() => onOpen([{ id: d.id, name: d.name }], d.id)} />`,
            )}
          </ul>`
      : null}
  </div>`
}

function NewFolder({ parent, onCreated, onCancel }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const input = useRef(null)
  useEffect(() => {
    input.current?.focus()
  }, [])
  const submit = async (e) => {
    e.preventDefault()
    const clean = name.trim()
    if (!clean) return
    setBusy(true)
    setError(null)
    try {
      const f = await createFolder(clean, parent.id)
      onCreated({ id: f.id, name: f.name || clean })
    } catch (err) {
      setError(err?.status === 0 ? 'Sem conexão com o Google.' : 'O Google não deixou criar a pasta aqui.')
      setBusy(false)
    }
  }
  return html`<form class="newfolder" onSubmit=${submit}>
    <span class="frow-icon is-new" aria-hidden="true"><${Icon} name="folder-plus" size=${20} /></span>
    <input
      ref=${input}
      class="input newfolder-input"
      type="text"
      placeholder="Nome da pasta"
      aria-label="Nome da nova pasta"
      value=${name}
      maxlength="200"
      enterkeyhint="done"
      onInput=${(e) => setName(e.currentTarget.value)}
    />
    <button type="button" class="link-btn" onClick=${onCancel} disabled=${busy}>Cancelar</button>
    <${Button} type="submit" size="sm" variant="primary" loading=${busy} disabled=${!name.trim() || busy}>Criar</${Button}>
    ${error ? html`<p class="field-help is-error newfolder-error" role="alert">${error}</p>` : null}
  </form>`
}

function FolderList({ path, driveId, onEnter, creating, setCreating }) {
  const here = path[path.length - 1]
  const list = useList(`${driveId || 'my'}:${here.id}`, (signal) => listFolders(here.id, driveId, signal))
  return html`<div>
    ${creating
      ? html`<${NewFolder}
          parent=${here}
          onCancel=${() => setCreating(false)}
          onCreated=${(f) => {
            list.add({ ...f, driveId })
            setCreating(false)
            toast(`Pasta “${f.name}” criada`, { tone: 'success' })
            onEnter(f)
          }}
        />`
      : null}
    <ul class="group flist">
      ${list.loading ? html`<${SkeletonRows} />` : null}
      ${list.error ? html`<${ErrorRow} error=${list.error} onRetry=${list.reload} />` : null}
      ${list.data && !list.data.length && !creating
        ? html`<li class="frow-msg is-empty">
            <${Icon} name="folder" size=${22} />
            <p>${LAN ? 'Nenhuma pasta aqui dentro. Dá para enviar para cá mesmo.' : 'Nenhuma pasta aqui dentro. Dá para enviar para cá mesmo, ou criar uma nova.'}</p>
          </li>`
        : null}
      ${(list.data || []).map((f) => html`<${FolderRow} key=${f.id} name=${f.name} onClick=${() => onEnter(f)} />`)}
    </ul>
  </div>`
}

export function FolderSheet() {
  const { dest, account } = useApp((s) => ({ dest: s.dest, account: s.user?.emailAddress }))
  const [nav, setNav] = useState(() => (dest && dest.path?.length ? { path: dest.path, driveId: dest.driveId } : { path: [], driveId: null }))
  const [creating, setCreating] = useState(false)
  const bodyRef = useRef(null)
  const crumbsRef = useRef(null)
  const atHome = nav.path.length === 0
  useEffect(() => {
    const el = crumbsRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [nav])
  const here = atHome ? null : toFolder(nav.path, nav.driveId)

  const go = (path, driveId) => {
    setCreating(false)
    setNav({ path, driveId })
    bodyRef.current?.scrollTo?.(0, 0)
  }
  const choose = (folder) => {
    setState({ dest: folder })
    pushRecent(folder, account)
    closeSheet()
  }

  return html`<${SheetHead}
      title="Destino"
      left=${html`<button type="button" class="link-btn" onClick=${closeSheet}>Cancelar</button>`}
      right=${!atHome && !LAN
        ? html`<button type="button" class="link-btn" onClick=${() => setCreating(true)} disabled=${creating}>Nova pasta</button>`
        : null}
    />
    <nav class="crumbs" aria-label="Caminho" ref=${crumbsRef}>
      <button type="button" class=${cx('crumb', atHome && 'is-here')} onClick=${() => go([], null)} aria-current=${atHome ? 'location' : undefined}>
        <${Icon} name="home" size=${15} /> Início
      </button>
      ${nav.path.map(
        (p, i) => html`<${Icon} name="chevron-right" size=${12} strokeWidth=${2} class="crumb-sep" />
          <button
            type="button"
            class=${cx('crumb', i === nav.path.length - 1 && 'is-here')}
            onClick=${() => go(nav.path.slice(0, i + 1), nav.driveId)}
            aria-current=${i === nav.path.length - 1 ? 'location' : undefined}
          >
            ${p.name}
          </button>`,
      )}
    </nav>
    <div class="sheet-body sheet-scroll" ref=${bodyRef}>
      ${atHome
        ? html`<${Home} account=${account} onOpen=${go} onPick=${choose} />`
        : html`<${FolderList}
            key=${here.id}
            path=${nav.path}
            driveId=${nav.driveId}
            creating=${creating}
            setCreating=${setCreating}
            onEnter=${(f) => go([...nav.path, { id: f.id, name: f.name }], nav.driveId)}
          />`}
    </div>
    <footer class="sheet-foot">
      <${Button} variant="up" size="lg" class="btn-block" disabled=${atHome} onClick=${() => here && choose(here)}>
        ${atHome ? 'Escolha um lugar' : html`Enviar para “${here.name}”`}
      </${Button}>
    </footer>`
}
FolderSheet.label = 'Escolher a pasta de destino'
FolderSheet.tall = true

