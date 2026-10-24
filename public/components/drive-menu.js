// Menu de contexto da tela Drive: botão direito numa linha (lista) ou num cartão (miniaturas), ou a tecla de menu /
// Shift+F10 no item em foco. Abre na camada das janelas (ModalHost, fora da página): nunca fica atrás de painel nem é
// cortado por quem tem overflow, e se ajeita para não sair da janela (abre para a esquerda ou para cima quando não
// cabe). Teclado: setas andam (dão a volta), Home/End, a primeira letra pula para o item, Enter escolhe, Esc e Tab
// fecham; clicar fora, rolar ou trocar de janela também fecham. Devolve o `id` do item escolhido (ou null).
import { html, useEffect, useLayoutEffect, useRef, useState } from '/vendor/preact-htm.js'
import { openModal, registerModal } from '../lib/modals.js'
import { cx } from '../lib/ui.js'
import { Icon } from './icons.js'

const LARGURA = 252
const MARGEM = 8

/** { left, top, maxHeight } para um menu de `w`×`h` aberto em (x, y), sem sair da janela. */
export function posicaoMenu(x, y, w, h, vw, vh, margem = MARGEM) {
  let left = x
  let top = y
  if (left + w + margem > vw) left = x - w // não cabe à direita: abre para a esquerda do ponteiro
  if (top + h + margem > vh) top = y - h // não cabe embaixo: abre para cima
  left = Math.max(margem, Math.min(left, vw - w - margem))
  top = Math.max(margem, Math.min(top, vh - h - margem))
  return { left, top, maxHeight: Math.max(120, vh - margem * 2) }
}

/**
 * @param {{ titulo?: string, itens: Array<{ id: string, icon: string, label: string, hint?: string, disabled?: boolean,
 *           perigo?: boolean, sep?: boolean, title?: string }|null>, x: number, y: number, onClose: (id: string|null) => void }} props
 */
function MenuContexto({ titulo, itens, x, y, onClose }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)
  const lista = itens.filter(Boolean)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos(posicaoMenu(x, y, r.width, Math.min(r.height, window.innerHeight - MARGEM * 2), window.innerWidth, window.innerHeight))
  }, [])
  // O foco vai para o primeiro item depois de posicionado (escondido, o menu não recebe foco).
  useLayoutEffect(() => {
    if (pos) ref.current?.querySelector('.menu-item:not(:disabled)')?.focus({ preventScroll: true })
  }, [!pos])

  // Rolar a página, mudar o tamanho da janela ou sair dela: o menu some (como no Finder).
  useEffect(() => {
    const fechar = () => onClose(null)
    const rolou = (e) => !ref.current?.contains(e.target) && fechar()
    window.addEventListener('resize', fechar)
    window.addEventListener('blur', fechar)
    document.addEventListener('scroll', rolou, true)
    return () => {
      window.removeEventListener('resize', fechar)
      window.removeEventListener('blur', fechar)
      document.removeEventListener('scroll', rolou, true)
    }
  }, [])

  const onKey = (e) => {
    const els = [...(ref.current?.querySelectorAll('.menu-item:not(:disabled)') || [])]
    const i = els.indexOf(document.activeElement)
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation() // o Esc não chega na tela (lá ele limparia a seleção)
      onClose(null)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      els[(i + (e.key === 'ArrowDown' ? 1 : els.length - 1)) % els.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      els[e.key === 'Home' ? 0 : els.length - 1]?.focus()
    } else if (e.key.length === 1 && /\p{L}/u.test(e.key) && !e.metaKey && !e.ctrlKey) {
      // primeira letra: pula para o próximo item que começa com ela
      const k = e.key.toLowerCase()
      const ordem = [...els.slice(i + 1), ...els.slice(0, i + 1)]
      ordem.find((el) => el.textContent.trim().toLowerCase().startsWith(k))?.focus()
    }
  }

  const style = pos ? `left:${pos.left}px;top:${pos.top}px;max-height:${pos.maxHeight}px;width:${LARGURA}px` : `left:${x}px;top:${y}px;width:${LARGURA}px;visibility:hidden`
  return html`<div
    class="popover-backdrop ctx-fundo"
    onMouseDown=${(e) => e.target === e.currentTarget && onClose(null)}
    onContextMenu=${(e) => {
      e.preventDefault()
      onClose(null)
    }}
  >
    <div class="menu ctx-menu" role="menu" aria-label=${titulo || 'Ações'} style=${style} ref=${ref} onKeyDown=${onKey}>
      ${titulo ? html`<div class="menu-label ctx-titulo" title=${titulo}>${titulo}</div>` : null}
      ${lista.map(
        (it) => html`${it.sep ? html`<div class="menu-sep" role="separator"></div>` : null}
          <button
            type="button"
            role="menuitem"
            class=${cx('menu-item', it.perigo && 'is-perigo')}
            title=${it.title}
            disabled=${it.disabled}
            onClick=${() => onClose(it.id)}
          >
            <${Icon} name=${it.icon} size=${15} />
            <span class="menu-item-text">${it.label}</span>
            ${it.hint ? html`<span class="menu-item-hint">${it.hint}</span>` : null}
          </button>`,
      )}
    </div>
  </div>`
}

registerModal('menu-contexto', MenuContexto)

/** Abre o menu em (x, y) da janela. Promessa com o `id` escolhido, ou null. */
export function abrirMenuContexto({ titulo, itens, x, y }) {
  return openModal('menu-contexto', { titulo, itens, x: Math.round(x), y: Math.round(y) })
}

/** Ponto para abrir pelo teclado (tecla de menu / Shift+F10): logo abaixo do começo do nome do item. */
export function pontoDoItem(el) {
  const r = el?.getBoundingClientRect?.()
  if (!r) return { x: window.innerWidth / 2, y: window.innerHeight / 3 }
  return { x: r.left + Math.min(56, r.width / 3), y: r.top + Math.min(r.height, 40) }
}

/** É o atalho de teclado do menu de contexto? */
export const teclaDeMenu = (e) => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')

// ─────────── arrastar e soltar (mover para uma pasta) ───────────
//
// Só entre itens desta tela: o tipo próprio no dataTransfer não é 'Files', então o véu de "Solte para enviar"
// (components/drop.js) não reage. Durante o arrasto o Chromium não deixa ler o conteúdo, só os tipos: os ids ficam
// aqui também, para a pasta saber se é ela mesma que está sendo arrastada.

export const TIPO_ARRASTO = 'application/x-sobedesce-drive-itens'
let arrastando = null // Set de ids

export function comecarArrasto(e, ids, nome) {
  arrastando = new Set(ids)
  try {
    e.dataTransfer.setData(TIPO_ARRASTO, JSON.stringify(ids))
    e.dataTransfer.setData('text/plain', nome || '')
    e.dataTransfer.effectAllowed = 'move'
  } catch {
    // dataTransfer indisponível: segue sem arrastar
  }
}

export function fimArrasto() {
  arrastando = null
  for (const el of document.querySelectorAll('.is-alvo')) el.classList.remove('is-alvo')
}

/** A pasta `id` pode receber o que está sendo arrastado? (é um arrasto nosso e não é ela mesma) */
export function podeSoltar(e, id) {
  return Boolean(arrastando) && Array.from(e.dataTransfer?.types || []).includes(TIPO_ARRASTO) && !arrastando.has(id)
}

export function idsSoltos(e) {
  try {
    const ids = JSON.parse(e.dataTransfer.getData(TIPO_ARRASTO) || '[]')
    return Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}
