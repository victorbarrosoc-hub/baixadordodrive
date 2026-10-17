// Tela Drive: os botões "Ordenar" e "Filtro" (lista e grade), o "N arquivos do Mac ocultos" da linha do total (com o
// mini-menu Mostrar · Mover para a lixeira…) e a janela "Mover para a lixeira…" (com confirmação, progresso e recusa).
// A lógica fica em lib/ordenar.js; aqui só a interface.
import { html, useEffect, useRef, useState } from '/vendor/preact-htm.js'
import { api, enc } from '../lib/api.js'
import { registerModal, openModal } from '../lib/modals.js'
import { bytes, count, plural } from '../lib/format.js'
import { cx } from '../lib/ui.js'
import { MAC_MAX_BYTES, SORTS, canTrashMac, chunks, filterButton, macHiddenText, nextSort, sortLabel } from '../lib/ordenar.js'
import { Icon } from './icons.js'
import { Button, MenuButton, Spinner } from './common.js'
import { Modal } from './modal.js'

const SORT_ICON = { name: 'list', modified: 'clock', size: 'disk', type: 'doc' }
const FILTER_ICON = { all: 'stack', video: 'film', image: 'photo', audio: 'music', folder: 'folder', other: 'doc' }
const TOOL = 'btn tool-btn'

/** "⇅ Nome ↑" (a dica e o nome acessível dizem "Ordenar: Nome: A a Z") com o menu. A opção ativa, de novo, inverte. */
export function SortMenu({ sort, onSort }) {
  const { short, long } = sortLabel(sort)
  return html`<${MenuButton}
    class="sort-menu"
    triggerClass=${TOOL}
    icon="sort"
    label=${short}
    ariaLabel=${`Ordenar: ${long}`}
    title=${`Ordenar: ${long}`}
    menuLabel="Ordenar por"
    heading="Ordenar por"
    items=${SORTS.map((s) => {
      const on = s.key === sort.key
      const next = nextSort(sort, s.key)
      return {
        icon: SORT_ICON[s.key],
        label: s.label,
        checked: on,
        hint: on ? `${sort.dir === 'asc' ? '↑' : '↓'} ${s.dirs[sort.dir]}` : '',
        title: on ? `Clique de novo para inverter (${s.dirs[next.dir]})` : s.dirs[s.first],
        onSelect: () => onSort(next),
      }
    })}
  />`
}

/**
 * "Filtro": funil + "Tudo" (só o funil com pouco espaço); com um tipo escolhido, "Vídeos" com o funil azul e um "×" que
 * volta a Tudo. O menu lista os tipos que existem na pasta, com quantos tem de cada (filterChips).
 */
export function FilterMenu({ chips, value, onChange }) {
  const { label, on, title } = filterButton(value)
  const limpar = (e) => {
    const trigger = e.currentTarget.parentElement?.querySelector('.menu-trigger')
    onChange('all')
    // o "×" some com o filtro: o foco passa para o botão Filtro
    requestAnimationFrame(() => trigger?.focus({ preventScroll: true }))
  }
  return html`<${MenuButton}
    class=${cx('filter-menu', on && 'is-active')}
    triggerClass=${TOOL}
    icon="filter"
    label=${label}
    ariaLabel=${title}
    title=${title}
    menuLabel="Filtrar por tipo"
    heading="Mostrar"
    items=${chips.map((c) => ({
      icon: FILTER_ICON[c.value],
      label: c.label,
      checked: c.value === value,
      hint: count(c.count),
      onSelect: () => onChange(c.value),
    }))}
  >
    ${on
      ? html`<button type="button" class="filter-clear" onClick=${limpar} aria-label="Limpar filtro (mostrar tudo)" title="Limpar filtro (mostrar tudo)">
          <${Icon} name="x" size=${12} strokeWidth=${1.8} />
        </button>`
      : null}
  </${MenuButton}>`
}

/** "37 arquivos do Mac ocultos ⌄" no fim da linha do total: abre Mostrar/Ocultar e "Mover para a lixeira…". */
export function MacLine({ mac, shown, onToggle, onTrash }) {
  if (!mac.length) return null
  const lixo = mac.filter(canTrashMac)
  return html`<${MenuButton}
    class="dsum-mac"
    triggerClass="dsum-mac-link"
    icon=${null}
    label=${shown ? `${plural(mac.length, 'arquivo', 'arquivos')} do Mac à vista` : macHiddenText(mac.length)}
    after=${html`<${Icon} name="chevron-down" size=${11} strokeWidth=${1.8} />`}
    title="Arquivos de controle do macOS (._, .DS_Store) e do Windows (Thumbs.db) que vieram junto com os originais"
    menuLabel="Arquivos do Mac"
    items=${[
      { icon: shown ? 'eye-off' : 'eye', label: shown ? 'Ocultar' : 'Mostrar', onSelect: onToggle },
      onTrash && lixo.length
        ? { icon: 'trash', label: 'Mover para a lixeira…', title: 'Mover os arquivos de controle do Mac para a lixeira do Drive (com confirmação)', onSelect: () => onTrash(lixo) }
        : null,
    ]}
  />`
}

// ───── janela "Mover para a lixeira…" ─────

const LOTE = 10 // ids por chamada: a barra anda e "Parar" vale logo
// Clique que chega logo depois de abrir (o segundo clique de um duplo clique) não conta como confirmar.
const CONFIRM_GUARD_MS = 600

/**
 * @param {{ accountId: string, folderId: string, folderName: string, items: any[], big: number, onClose: (r)=>void }} props
 * `items`: os que podem ir (canTrashMac). `big`: quantos "._" com 4 MB ou mais ficam. `onMoved`: chamado quando algo
 * foi para a lixeira (a tela recarrega a pasta por trás da janela).
 */
function MacTrashDialog({ accountId, folderId, folderName, items, big = 0, onMoved, onClose }) {
  const [fase, setFase] = useState('confirmar') // confirmar | movendo | fim | erro
  const [feitos, setFeitos] = useState(0)
  const [res, setRes] = useState({ movidos: 0, recusados: [], pulados: 0, parado: false })
  const [erro, setErro] = useState(null)
  const [parando, setParando] = useState(false)
  const opened = useRef(Date.now())
  const stop = useRef(false)
  const alive = useRef(true)
  const started = useRef(false)
  useEffect(() => () => {
    alive.current = false
    stop.current = true // fechou no meio: termina o lote que está indo e para
  }, [])

  const total = items.length
  const peso = items.reduce((a, it) => a + (it.size || 0), 0)
  const fechar = () => onClose({ movidos: res.movidos })

  const mover = async () => {
    if (started.current || Date.now() - opened.current < CONFIRM_GUARD_MS) return
    started.current = true
    setFase('movendo')
    let movidos = 0
    let pulados = 0
    const recusados = []
    try {
      for (const lote of chunks(items.map((it) => it.id), LOTE)) {
        if (stop.current) break
        // `confirmado: true` só sai daqui, do botão da confirmação.
        const r = await api.post(`/api/drive/${enc(accountId)}/lixeira/mac`, { folderId, ids: lote, confirmado: true })
        movidos += r.movidos?.length || 0
        pulados += r.pulados?.length || 0
        recusados.push(...(r.recusados || []))
        if (!alive.current) break // fechou a janela: para aqui (a pasta recarrega embaixo)
        setFeitos((n) => n + lote.length)
        setRes({ movidos, recusados: [...recusados], pulados, parado: false })
      }
      if (movidos) onMoved?.()
      if (!alive.current) return
      setRes({ movidos, recusados, pulados, parado: stop.current && movidos + pulados + recusados.length < total })
      setFase('fim')
    } catch (err) {
      if (movidos) onMoved?.()
      if (!alive.current) return
      setRes({ movidos, recusados, pulados, parado: false })
      setErro(err?.message || 'Não consegui mover para a lixeira.')
      setFase('erro')
    }
  }

  const exemplos = items.slice(0, 3).map((it) => it.name)
  let body
  let footer
  if (fase === 'confirmar') {
    body = html`<p class="dialog-text">Esses são arquivos de controle do Mac (._) que vieram junto com os originais. Os vídeos não são afetados. Vão para a lixeira do Drive e podem ser recuperados por 30 dias.</p>
      <div class="mt-what">
        <b>${plural(total, 'arquivo', 'arquivos')} · ${bytes(peso)}</b>
        <ul class="mt-names">
          ${exemplos.map((n) => html`<li class="mono-path" title=${n}>${n}</li>`)}
          ${total > exemplos.length ? html`<li class="sub">e mais ${count(total - exemplos.length)}</li>` : null}
        </ul>
        ${big ? html`<span class="sub">${plural(big, 'arquivo ._ com', 'arquivos ._ com')} ${bytes(MAC_MAX_BYTES)} ou mais ${big === 1 ? 'fica' : 'ficam'} onde ${big === 1 ? 'está' : 'estão'}.</span>` : null}
      </div>`
    footer = html`<${Button} onClick=${() => onClose(null)} data-autofocus>Cancelar</${Button}>
      <${Button} variant="danger" icon="trash" onClick=${mover}>Mover para a lixeira</${Button}>`
  } else if (fase === 'movendo') {
    const frac = total ? Math.min(1, feitos / total) : 1
    body = html`<div class="rt-run" aria-live="polite">
      <div class="rt-phase"><${Spinner} size=${16} /><span>Movendo para a lixeira… ${count(Math.min(feitos, total))} de ${count(total)}</span></div>
      <div class="rt-bar"><i style=${`width:${(frac * 100).toFixed(1)}%`}></i></div>
      <span class="sub">Os vídeos não são tocados. Dá para parar a qualquer hora.</span>
    </div>`
    footer = html`<${Button} icon="pause" onClick=${() => {
        stop.current = true
        setParando(true)
      }} disabled=${parando}>${parando ? 'Parando…' : 'Parar'}</${Button}>`
  } else {
    const ok = fase === 'fim' && !res.recusados.length && !res.parado
    const head =
      fase === 'erro'
        ? erro
        : res.movidos
          ? `${plural(res.movidos, 'arquivo foi', 'arquivos foram')} para a lixeira do Drive.`
          : 'Nada foi para a lixeira.'
    body = html`<div class="rt-done">
      <div class=${cx('rt-summary', ok && 'is-good', !ok && 'is-stopped')}>
        <span class="rt-summary-icon"><${Icon} name=${ok ? 'circle-check' : 'warning'} size=${20} /></span>
        <div>
          <b>${head}</b>
          ${fase === 'erro' && res.movidos ? html`<span class="sub">${plural(res.movidos, 'arquivo já tinha ido', 'arquivos já tinham ido')} para a lixeira antes disso.</span>` : null}
          ${res.parado ? html`<span class="sub">Parado no meio: o resto ficou na pasta.</span>` : null}
          ${res.recusados.length ? html`<span class="sub">${plural(res.recusados.length, 'não foi', 'não foram')}: ${res.recusados[0].error}</span>` : null}
          ${res.pulados ? html`<span class="sub">${plural(res.pulados, 'arquivo mudou', 'arquivos mudaram')} desde que a pasta abriu e ${res.pulados === 1 ? 'ficou' : 'ficaram'} onde ${res.pulados === 1 ? 'estava' : 'estavam'}.</span>` : null}
          ${res.movidos ? html`<span class="sub">Dá para recuperar pela lixeira do Google Drive por 30 dias.</span>` : null}
        </div>
      </div>
    </div>`
    footer = html`${res.movidos ? html`<a class="btn btn-secondary" href="https://drive.google.com/drive/trash" target="_blank" rel="noopener"><${Icon} name="external" size=${16} /><span>Abrir a lixeira do Drive</span></a>` : null}
      <${Button} variant="primary" onClick=${fechar} data-autofocus>OK</${Button}>`
  }

  return html`<${Modal}
    size="sm"
    class="dialog mt-dialog"
    title=${fase === 'confirmar' ? 'Mover para a lixeira do Drive?' : fase === 'movendo' ? 'Movendo para a lixeira…' : 'Lixeira do Drive'}
    subtitle=${folderName ? `Arquivos do Mac em “${folderName}”` : null}
    icon=${fase === 'confirmar' ? html`<${Icon} name="trash" size=${20} />` : null}
    onClose=${() => (fase === 'confirmar' ? onClose(null) : fechar())}
    footer=${footer}
  >
    ${body}
  </${Modal}>`
}

registerModal('lixo-mac', MacTrashDialog)

/** Abre a confirmação. Devolve { movidos } (ou null se cancelou). */
export function openMacTrash({ accountId, folderId, folderName, mac, onMoved }) {
  const items = mac.filter(canTrashMac)
  const big = mac.length - items.length
  return openModal('lixo-mac', { accountId, folderId, folderName, items, big, onMoved })
}
