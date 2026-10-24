// Menu de um item da aba Drive: abre ao segurar o dedo numa pasta ou arquivo (ou no botão direito do mouse). Só o que
// faz sentido para o tipo e a permissão: Abrir, Selecionar, Baixar, Enviar para esta pasta, Copiar link, Abrir no Google
// Drive, Renomear, Mover para… (o seletor de pastas, components/folders.js), Calcular tamanho, Gerar proxy, Frames e
// Mover para a lixeira. As ações que já existiam (Baixar, Lixeira, Gerar proxy, Copiar links, Frames) são as mesmas
// folhas e funções da seleção (components/selecao.js); aqui só com um item.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js'
import { driveUrl, folderSizes, isFolder, kindOf, canDownload, target } from '../lib/browse.js'
import { moveErrorText, moveFile, renameFile } from '../lib/drive.js'
import { podeProxy } from '../lib/proxies.js'
import { bytes, shortDate } from '../lib/format.js'
import { closeSheet, openSheet, toast } from '../lib/state.js'
import { Icon } from './icons.js'
import { Button, SheetHead, cx } from './ui.js'
import { Thumb } from './thumb.js'
import { FileName } from './queue.js'
import { copiarLinks } from './selecao.js'
import { framesDoDrive } from './criar.js'
import { enviarPara } from './browser.js'

function Item({ icon, label, sub, onClick, disabled, perigo, href }) {
  const inner = html`<${Icon} name=${icon} /><span class=${sub ? 'menu-text' : undefined}>${label}${sub ? html`<small>${sub}</small>` : null}</span>`
  if (href) return html`<li><a class="menu-item" href=${href} target="_blank" rel="noopener noreferrer" onClick=${() => closeSheet()}>${inner}<${Icon} name="external" size=${16} class="menu-chev" /></a></li>`
  return html`<li><button type="button" class=${cx('menu-item', perigo && 'is-danger')} onClick=${onClick} disabled=${disabled}>${inner}</button></li>`
}

/** "Enviar para esta pasta": o toque no rótulo abre o seletor de arquivos (o gesto que o iPhone exige). */
function EnviarAqui({ dest }) {
  const id = 'item-menu-enviar'
  const onChange = (e) => {
    const files = [...(e.currentTarget.files || [])]
    e.currentTarget.value = ''
    if (!files.length) return
    closeSheet()
    enviarPara(files, dest)
  }
  return html`<li>
    <input id=${id} class="offscreen" type="file" multiple onChange=${onChange} />
    <label for=${id} class="menu-item"><${Icon} name="upload" /><span>Enviar para esta pasta</span></label>
  </li>`
}

/** Renomear, dentro da própria folha. */
function Renomear({ f, onFeito, onVoltar }) {
  const [nome, setNome] = useState(f.name)
  const [busy, setBusy] = useState(false)
  const [erro, setErro] = useState(null)
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    // Seleciona o nome sem a extensão (como no Finder): trocar "Master_v1" sem apagar o ".mov".
    const ponto = isFolder(f) ? -1 : f.name.lastIndexOf('.')
    try {
      el.setSelectionRange(0, ponto > 0 ? ponto : f.name.length)
    } catch {
      // alguns teclados não deixam
    }
  }, [])
  const limpo = nome.trim()
  const salvar = async (e) => {
    e?.preventDefault()
    if (!limpo || limpo === f.name || busy) return limpo === f.name && onVoltar()
    setBusy(true)
    setErro(null)
    try {
      const r = await renameFile(f.id, limpo)
      toast(`Agora se chama “${r.name || limpo}”`, { tone: 'success' })
      closeSheet()
      onFeito?.()
    } catch (err) {
      setErro(moveErrorText(err, 'renomear'))
      setBusy(false)
    }
  }
  return html`<${SheetHead}
      title=${isFolder(f) ? 'Renomear pasta' : 'Renomear arquivo'}
      left=${html`<button type="button" class="link-btn" onClick=${onVoltar}>Voltar</button>`}
      right=${html`<button type="button" class="link-btn is-strong" onClick=${salvar} disabled=${!limpo || busy}>Salvar</button>`}
    />
    <form class="sheet-body rsheet" onSubmit=${salvar}>
      <label class="rfield">
        <span class="rfield-label">Nome</span>
        <input ref=${ref} class="input" type="text" value=${nome} enterkeyhint="done" autocomplete="off" autocorrect="off" spellcheck=${false} onInput=${(e) => setNome(e.currentTarget.value)} />
      </label>
      ${erro ? html`<p class="item-error" role="alert">${erro}</p>` : null}
      <${Button} variant="primary" size="lg" class="btn-block" loading=${busy} disabled=${!limpo} onClick=${salvar}>Renomear</${Button}>
    </form>`
}

/**
 * @param {{ f: object, onAbrir: () => void, onSelecionar: () => void, dest: object|null, inicio: object|null,
 *           driveId: string|null, onMudou: (o: { removidos?: string[], destId?: string, recarregar?: boolean }) => void }} props
 * `dest`: a pasta como destino de envio (só pastas em que dá para pôr arquivos). `inicio`: onde o "Mover para…" abre.
 */
export function ItemMenuSheet({ f, onAbrir, onSelecionar, dest, inicio, driveId, onMudou }) {
  const [fase, setFase] = useState('menu')
  if (fase === 'renomear') return html`<${Renomear} f=${f} onVoltar=${() => setFase('menu')} onFeito=${() => onMudou?.({ recarregar: true })} />`

  const kind = kindOf(f)
  const pasta = kind === 'folder'
  const caps = f.capabilities || {}
  const t = target(f)
  const video = podeProxy(f)
  const podeMover = !f.isDrive && caps.canMoveItemWithinDrive !== false && caps.canEdit !== false && (f.parents?.length ?? 1) > 0
  const podeRenomear = !f.isDrive && caps.canRename !== false
  const meta = pasta ? (f.isDrive ? 'Drive compartilhado' : 'Pasta') : [f.size != null ? bytes(Number(f.size)) : null, shortDate(f.modifiedTime)].filter(Boolean).join(' · ')
  const fechar = (fn) => () => {
    closeSheet()
    fn()
  }

  const mover = () =>
    openSheet('folders', {
      titulo: 'Mover para',
      verb: 'Mover para',
      icone: 'arrow-right',
      recente: false,
      inicio,
      onCancel: closeSheet,
      onChoose: async (para) => {
        closeSheet()
        try {
          const r = await moveFile(f.id, para)
          toast(r.moved ? `“${f.name}” foi para “${para.name}”` : `Já estava em “${para.name}”`, { tone: r.moved ? 'success' : 'neutral' })
          if (r.moved) onMudou?.({ removidos: [f.id], destId: para.id })
        } catch (err) {
          toast(moveErrorText(err, 'mover'), { tone: 'error', ms: 4200 })
        }
      },
    })

  return html`<${SheetHead} title="" right=${html`<button type="button" class="link-btn is-strong" onClick=${closeSheet}>OK</button>`} />
    <div class="sheet-body rsheet imenu">
      <div class="item-head">
        <span class="imenu-thumb"><${Thumb} file=${f} px=${56} kind=${kind} small /></span>
        <div class="item-titles">
          ${pasta ? html`<b class="item-name">${f.name}</b>` : html`<${FileName} name=${f.name} class="item-name" />`}
          <p class="sub">${meta}</p>
        </div>
      </div>
      <ul class="group menu">
        <${Item} icon=${pasta ? 'folder' : 'eye'} label=${pasta ? 'Abrir' : 'Ver'} onClick=${fechar(onAbrir)} />
        ${f.isDrive ? null : html`<${Item} icon="check" label="Selecionar" sub="Para baixar, copiar ou mover vários" onClick=${fechar(onSelecionar)} />`}
      </ul>
      ${f.isDrive
        ? null
        : html`<ul class="group menu">
            ${!pasta && kind !== 'gdoc' ? html`<${Item} icon="download" label="Baixar" disabled=${!canDownload(f)} onClick=${() => openSheet('baixarSelecao', { itens: [f], semPermissao: 0 })} />` : null}
            ${pasta && dest ? html`<${EnviarAqui} dest=${dest} />` : null}
            <${Item} icon="link" label="Copiar link" onClick=${fechar(() => copiarLinks([f]))} />
            <${Item} icon="drive" label="Abrir no Google Drive" href=${driveUrl(f)} />
          </ul>
          <ul class="group menu">
            <${Item} icon="pencil" label="Renomear" disabled=${!podeRenomear} onClick=${() => setFase('renomear')} />
            <${Item} icon="arrow-right" label="Mover para…" sub=${podeMover ? null : 'Só quem é dono ou edita pode mudar de lugar'} disabled=${!podeMover} onClick=${mover} />
            ${pasta ? html`<${Item} icon="disk" label="Calcular tamanho" onClick=${fechar(() => folderSizes.start({ id: t.id, driveId: driveId || f.driveId || null }, { refresh: true }))} />` : null}
            ${video ? html`<${Item} icon="film" label="Gerar proxy" sub="O computador gera a cópia leve" onClick=${() => openSheet('proxySelecao', { itens: [f], fora: 0 })} />` : null}
            ${video ? html`<${Item} icon="sparkle" label="Frames" onClick=${fechar(() => framesDoDrive(f))} />` : null}
          </ul>
          ${!pasta && caps.canTrash !== false
            ? html`<ul class="group menu rmenu-danger">
                <${Item} icon="trash" label="Mover para a lixeira" perigo onClick=${() => openSheet('lixeiraSelecao', { itens: [f], onFeito: (ids) => onMudou?.({ removidos: ids }) })} />
              </ul>`
            : null}`}
    </div>`
}
ItemMenuSheet.label = 'Ações do item'
