// Escolher a pasta de destino: Recentes (um toque, sempre no topo), Favoritas (a estrela do Google Drive; a estrela ao
// lado do caminho põe e tira), Buscar pasta (no Drive todo), Meu Drive, drives compartilhados e Compartilhadas comigo;
// nova pasta. Abre na última pasta usada. Abaixo das pastas, os arquivos que já estão ali (só para ver,
// apagados), para conferir o lugar antes de enviar.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js'
import { LAN } from '../lib/config.js'
import { createFolder, folderMeta, folderPath, listFolders, listSharedDrives, listSharedFolders, listStarredFolders, myDriveId, searchFolders, setStarred } from '../lib/drive.js'
import { isFolder, kindOf, listPage } from '../lib/browse.js'
import { bytes } from '../lib/format.js'
import { closeSheet, folderTrail, getRecents, getState, pushRecent, setState, toast, useApp } from '../lib/state.js'
import { BotaoGrande } from './kit.js'
import { Icon } from './icons.js'
import { Thumb } from './thumb.js'
import { Button, SheetHead, cx } from './ui.js'

const cache = new Map() // id → pastas (vale enquanto a página está aberta)
const porNome = (a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })
const COMIGO_VISIVEIS = 6

/** path = [{ id, name }] a partir da raiz do drive; driveId = null no Meu Drive. [] = Início. */
function toFolder(path, driveId) {
  const last = path[path.length - 1]
  return { id: last.id, name: last.name, driveId: driveId || null, path }
}

function useList(chave, load) {
  // Por Drive escolhido: trocar de conta não mostra as pastas da outra.
  const key = `${getState().drive?.id || '-'}|${chave}`
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
  const put = (next) => {
    cache.set(key, next)
    setLocal({ data: next })
  }
  const add = (item) => put([...(cache.get(key) || []), item].sort(porNome))
  return { ...state, reload, add, put }
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

function FolderRow({ icon = 'folder', name, sub, onClick, chevron = true, tone, busy = false }) {
  return html`<li>
    <button type="button" class=${cx('frow', tone && `is-${tone}`)} onClick=${onClick} disabled=${busy}>
      <span class="frow-icon" aria-hidden="true"><${Icon} name=${icon} size=${20} /></span>
      <span class="frow-text">
        <span class="frow-name">${name}</span>
        ${sub ? html`<span class="frow-sub">${sub}</span>` : null}
      </span>
      ${busy
        ? html`<span class="spinner" aria-hidden="true"></span>`
        : chevron
          ? html`<${Icon} name="chevron-right" size=${16} strokeWidth=${2} class="frow-chev" />`
          : null}
    </button>
  </li>`
}

/** Pastas com estrela no Drive. Uma leitura por vez que a página abre; a estrela daqui atualiza a lista na hora. */
const useFavoritas = () => useList('#favoritas', (signal) => listStarredFolders(signal))

/** Onde fica cada pasta da lista (nome da pasta de cima), aos poucos. */
function useOnde(files) {
  const [onde, setOnde] = useState({})
  const ids = (files || []).map((f) => f.id).join(',')
  useEffect(() => {
    if (!files?.length) return undefined
    const ctl = new AbortController()
    for (const f of files) {
      if (f.path?.length) {
        setOnde((w) => ({ ...w, [f.id]: folderTrail(f, { skipLast: true }) }))
        continue
      }
      parentLabel(f, ctl.signal).then(
        (label) => !ctl.signal.aborted && setOnde((w) => ({ ...w, [f.id]: label })),
        () => {},
      )
    }
    return () => ctl.abort()
  }, [ids])
  return onde
}

function Favoritas({ onOpenFound, opening }) {
  const favs = useFavoritas()
  const onde = useOnde(favs.data)
  if (!favs.loading && !favs.error && !favs.data?.length) {
    return html`<h3 class="list-label">Favoritas</h3>
      <p class="group-foot ffav-dica">
        Entre numa pasta e toque na <${Icon} name="star" size=${13} /> ao lado do caminho. Ela aparece aqui e no Google Drive.
      </p>`
  }
  return html`<h3 class="list-label">Favoritas</h3>
    <ul class="group flist">
      ${favs.loading ? html`<${SkeletonRows} n=${2} />` : null}
      ${favs.error ? html`<${ErrorRow} error=${favs.error} onRetry=${favs.reload} />` : null}
      ${(favs.data || []).map(
        (f) => html`<${FolderRow}
          key=${f.id}
          icon="star-fill"
          tone="fav"
          name=${f.name}
          sub=${onde[f.id] ? `em ${onde[f.id]}` : '…'}
          onClick=${() => onOpenFound(f)}
          busy=${opening === f.id}
        />`,
      )}
    </ul>`
}

function Comigo({ onOpen }) {
  const lista = useList('#comigo', (signal) => listSharedFolders(signal))
  const [todas, setTodas] = useState(false)
  const pastas = lista.data || []
  if (!lista.loading && !lista.error && !pastas.length) return null
  const visiveis = todas ? pastas : pastas.slice(0, COMIGO_VISIVEIS)
  return html`<h3 class="list-label">Compartilhadas comigo</h3>
    <ul class="group flist">
      ${lista.loading ? html`<${SkeletonRows} n=${3} />` : null}
      ${lista.error ? html`<${ErrorRow} error=${lista.error} onRetry=${lista.reload} />` : null}
      ${visiveis.map(
        (f) => html`<${FolderRow}
          key=${f.id}
          icon="users"
          name=${f.name}
          sub=${f.sharingUser?.displayName ? `de ${f.sharingUser.displayName}` : null}
          onClick=${() => onOpen([{ id: f.id, name: f.name }], null)}
        />`,
      )}
      ${pastas.length > COMIGO_VISIVEIS
        ? html`<li>
            <button type="button" class="frow frow-mais" onClick=${() => setTodas(!todas)}>
              <span class="frow-text"><span class="frow-name">${todas ? 'Mostrar menos' : `Ver todas (${pastas.length})`}</span></span>
            </button>
          </li>`
        : null}
    </ul>`
}

/** Estrela da pasta aberta: põe e tira a pasta das Favoritas (e do "Com estrela" do Google Drive). */
function Estrela({ here }) {
  const favs = useFavoritas()
  const lista = favs.data || []
  const on = lista.some((f) => f.id === here.id)
  const alternar = async () => {
    const antes = lista
    const quer = !on
    favs.put(quer ? [...lista, { id: here.id, name: here.name, driveId: here.driveId, path: here.path }].sort(porNome) : lista.filter((f) => f.id !== here.id))
    try {
      await setStarred(here.id, quer)
      toast(quer ? `“${here.name}” nas Favoritas` : `“${here.name}” saiu das Favoritas`, { tone: quer ? 'success' : undefined })
    } catch (err) {
      favs.put(antes)
      toast(err?.status === 0 ? 'Sem conexão com o Google.' : 'O Google não deixou mudar a estrela desta pasta.', { tone: 'error' })
    }
  }
  return html`<button
    type="button"
    class=${cx('icon-btn', 'fstar', on && 'is-on')}
    onClick=${alternar}
    disabled=${favs.loading}
    aria-pressed=${on ? 'true' : 'false'}
    aria-label=${on ? `Tirar “${here.name}” das Favoritas` : `Pôr “${here.name}” nas Favoritas`}
  >
    <${Icon} name=${on ? 'star-fill' : 'star'} size=${20} />
  </button>`
}

function Home({ account, onOpen, onPick, onOpenFound, opening }) {
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
    ${LAN ? null : html`<${Favoritas} onOpenFound=${onOpenFound} opening=${opening} />`}
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
    ${LAN ? null : html`<${Comigo} onOpen=${onOpen} />`}
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

/** Arquivos que já estão na pasta: só para ver (sem toque), com miniatura. Uma página basta para conferir. */
function FilesHere({ folder, driveId }) {
  const list = useList(`files:${driveId || 'my'}:${folder.id}`, (signal) =>
    listPage({ folder, driveId }, { sort: 'name', signal }).then((r) => ({ files: r.files.filter((f) => !isFolder(f)), more: Boolean(r.next) })),
  )
  const files = list.data?.files || []
  if (list.error || (list.data && !files.length)) return null
  return html`<h3 class="list-label">${list.data ? `Já estão aqui · ${files.length}${list.data.more ? '+' : ''} ${files.length === 1 ? 'arquivo' : 'arquivos'}` : 'Já estão aqui'}</h3>
    <ul class="group flist fhere" aria-label="Arquivos nesta pasta">
      ${list.loading ? html`<${SkeletonRows} n=${3} />` : null}
      ${files.map((f) => {
        const kind = kindOf(f)
        return html`<li key=${f.id} class="fhere-row">
          <span class="fhere-media"><${Thumb} file=${f} px=${40} kind=${kind} small /></span>
          <span class="frow-text">
            <span class="frow-name">${f.name}</span>
            ${f.size != null ? html`<span class="frow-sub">${bytes(Number(f.size))}</span>` : null}
          </span>
        </li>`
      })}
    </ul>`
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
    ${LAN ? null : html`<${FilesHere} folder=${here} driveId=${driveId} />`}
  </div>`
}

/** Recentes numa linha que rola de lado, em cima de qualquer pasta aberta (no Início elas já são a primeira lista). */
function RecentChips({ account, here, onPick }) {
  const recents = getRecents(account)
  if (!recents.length) return null
  return html`<div class="fchips" role="group" aria-label="Recentes">
    <span class="fchips-label">Recentes</span>
    ${recents.map(
      (r) => html`<button
        key=${r.id}
        type="button"
        class=${cx('fchip', here?.id === r.id && 'is-here')}
        onClick=${() => onPick(r)}
        aria-label=${`Enviar para ${r.name} (${folderTrail(r) || 'recente'})`}
      >
        <${Icon} name="clock" size=${14} /><span>${r.name}</span>
      </button>`,
    )}
  </div>`
}

/** De onde é a pasta achada na busca: o nome da pasta de cima ("em SERHS Grand Hotel"). */
async function parentLabel(f, signal) {
  const pid = f.parents?.[0]
  if (!pid) return f.driveId ? 'Drive compartilhado' : 'Compartilhada com você'
  if (pid === 'root') return 'Meu Drive'
  const root = await myDriveId(signal).catch(() => null)
  if (pid === root) return 'Meu Drive'
  const m = await folderMeta(pid, signal)
  if (m) return m.name
  return f.driveId ? 'Drive compartilhado' : 'Compartilhada com você'
}

function FolderSearch({ text, onOpen, onRetry, opening }) {
  const [st, setSt] = useState({ loading: true })
  const [where, setWhere] = useState({})
  useEffect(() => {
    const ctl = new AbortController()
    setSt({ loading: true })
    setWhere({})
    searchFolders(text, ctl.signal).then(
      (files) => {
        if (ctl.signal.aborted) return
        setSt({ files })
        // O pai de cada resultado, aos poucos (uma consulta por pai diferente, guardada).
        for (const f of files) {
          parentLabel(f, ctl.signal).then(
            (label) => !ctl.signal.aborted && setWhere((w) => ({ ...w, [f.id]: label })),
            () => {},
          )
        }
      },
      (error) => !ctl.signal.aborted && setSt({ error }),
    )
    return () => ctl.abort()
  }, [text])
  const files = st.files || []
  return html`<h3 class="list-label fsearch-label">${st.loading ? 'Buscando…' : st.error ? 'Busca' : `${files.length}${files.length >= 30 ? '+' : ''} ${files.length === 1 ? 'pasta' : 'pastas'} com “${text}”`}</h3>
    <ul class="group flist" aria-busy=${st.loading ? 'true' : 'false'}>
      ${st.loading ? html`<${SkeletonRows} n=${4} />` : null}
      ${st.error ? html`<${ErrorRow} error=${st.error} onRetry=${onRetry} />` : null}
      ${st.files && !files.length
        ? html`<li class="frow-msg is-empty">
            <${Icon} name="search" size=${22} />
            <p>Nenhuma pasta com esse nome. A busca do Drive procura pelo começo das palavras.</p>
          </li>`
        : null}
      ${files.map(
        (f) => html`<li key=${f.id}>
          <button type="button" class="frow" onClick=${() => onOpen(f)} disabled=${Boolean(opening)}>
            <span class="frow-icon" aria-hidden="true"><${Icon} name="folder" size=${20} /></span>
            <span class="frow-text">
              <span class="frow-name">${f.name}</span>
              <span class="frow-sub">${where[f.id] ? `em ${where[f.id]}` : '…'}</span>
            </span>
            ${opening === f.id ? html`<span class="spinner" aria-hidden="true"></span>` : html`<${Icon} name="chevron-right" size=${16} strokeWidth=${2} class="frow-chev" />`}
          </button>
        </li>`,
      )}
    </ul>`
}

/**
 * Seletor de pasta. Sem props escolhe o destino dos envios; com `onChoose` devolve a pasta para quem abriu (o "Copiar de
 * um link", o "Mover para…" do menu do item), com `verb` e `icone` no botão e `onCancel` para voltar. `inicio`
 * ({ path, driveId }) abre numa pasta; `recente: false` não guarda a escolha nos Recentes (mover não é destino de envio).
 */
export function FolderSheet({ titulo = 'Destino', verb, icone = 'upload', onChoose, onCancel, inicio = null, recente = true } = {}) {
  const { dest, account } = useApp((s) => ({ dest: s.dest, account: s.user?.emailAddress }))
  // Abre em `inicio` ou na última pasta usada: o destino de agora ou, sem ele, a mais recente.
  const [nav, setNav] = useState(() => {
    if (inicio?.path?.length) return { path: inicio.path, driveId: inicio.driveId || null }
    const last = dest?.path?.length ? dest : getRecents(account)[0]
    return last?.path?.length ? { path: last.path, driveId: last.driveId || null } : { path: [], driveId: null }
  })
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [opening, setOpening] = useState(null) // id do resultado da busca que está montando o caminho
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 350)
    return () => clearTimeout(t)
  }, [query])
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
  const clearSearch = () => {
    setQuery('')
    setSearch('')
  }
  // Resultado da busca: monta o caminho (Meu Drive › … › pasta) e abre a pasta, para conferir ou entrar mais.
  const openFound = async (f) => {
    if (f.path?.length) {
      clearSearch()
      return go(f.path, f.driveId || null)
    }
    setOpening(f.id)
    try {
      const folder = await folderPath(f)
      clearSearch()
      go(folder.path, folder.driveId)
    } catch (err) {
      toast(err?.status === 0 ? 'Sem conexão com o Google.' : 'Não consegui abrir esta pasta.', { tone: 'error' })
    }
    setOpening(null)
  }
  const searching = Boolean(search) && !LAN
  const choose = (folder) => {
    if (recente) pushRecent(folder, account)
    if (onChoose) return onChoose(folder)
    setState({ dest: folder })
    closeSheet()
  }

  return html`<${SheetHead}
      title=${titulo}
      left=${html`<button type="button" class="link-btn" onClick=${onCancel || closeSheet}>Cancelar</button>`}
      right=${!atHome && !LAN && !searching
        ? html`<button type="button" class="link-btn" onClick=${() => setCreating(true)} disabled=${creating}>Nova pasta</button>`
        : null}
    />
    ${LAN
      ? null
      : html`<div class="fsearch">
          <label class="search">
            <${Icon} name="search" size=${17} />
            <input
              type="search"
              placeholder="Buscar pasta"
              aria-label="Buscar pasta no Drive todo"
              value=${query}
              enterkeyhint="search"
              autocomplete="off"
              autocorrect="off"
              spellcheck=${false}
              onInput=${(e) => setQuery(e.currentTarget.value)}
              onKeyDown=${(e) => e.key === 'Enter' && (setSearch(query.trim()), e.currentTarget.blur())}
            />
            ${query
              ? html`<button type="button" class="search-x" onClick=${clearSearch} aria-label="Limpar busca">
                  <${Icon} name="circle-x" size=${17} />
                </button>`
              : null}
          </label>
        </div>`}
    ${searching || atHome ? null : html`<${RecentChips} account=${account} here=${here} onPick=${choose} />`}
    ${searching
      ? null
      : html`<div class="fnav"><nav class="crumbs" aria-label="Caminho" ref=${crumbsRef}>
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
        </nav>${here && !LAN && here.id !== 'root' && here.id !== here.driveId ? html`<${Estrela} key=${here.id} here=${here} />` : null}</div>`}
    <div class="sheet-body sheet-scroll" ref=${bodyRef}>
      ${searching
        ? html`<${FolderSearch} key=${`${search}#${retry}`} text=${search} onOpen=${openFound} onRetry=${() => setRetry((n) => n + 1)} opening=${opening} />`
        : atHome
          ? html`<${Home} account=${account} onOpen=${go} onPick=${choose} onOpenFound=${openFound} opening=${opening} />`
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
      <${BotaoGrande} icone=${atHome ? null : icone} disabled=${atHome} onClick=${() => here && choose(here)}>
        ${atHome ? 'Escolha um lugar' : html`${verb || 'Enviar para'} “${here.name}”`}
      </${BotaoGrande}>
    </footer>`
}
FolderSheet.label = 'Escolher a pasta de destino'
FolderSheet.tall = true

