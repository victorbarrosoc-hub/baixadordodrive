// Peças da tela Comparar usadas nos dois modos (compare.js e discos.js): o cartão da pasta e a rota do resumo.
import { html, useRef, useState } from '/vendor/preact-htm.js'
import { cx } from '../lib/ui.js'
import { bridge, droppedIsFolder, pathsFromDrop } from '../lib/desktop.js'
import { toast } from '../lib/toasts.js'
import { Icon } from './icons.js'
import { Button } from './common.js'

/** Arrastar uma pasta do Finder/Explorer para o cartão (só no app do computador). */
function useSoltarPasta(onPasta) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  if (!onPasta || !bridge) return [false, {}]
  const accepts = (e) => Array.from(e.dataTransfer?.types || []).includes('Files')
  return [
    over,
    {
      onDragEnter: (e) => {
        if (!accepts(e)) return
        depth.current++
        setOver(true)
      },
      onDragOver: (e) => {
        if (!accepts(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      },
      onDragLeave: (e) => {
        if (!accepts(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (!depth.current) setOver(false)
      },
      onDrop: (e) => {
        if (!accepts(e)) return
        e.preventDefault()
        depth.current = 0
        setOver(false)
        if (droppedIsFolder(e.dataTransfer) === false) {
          toast('info', 'Solte uma pasta (não um arquivo).')
          return
        }
        const [p] = pathsFromDrop(e.dataTransfer)
        if (p) onPasta(p)
      },
    },
  ]
}

/**
 * Cartão de uma pasta: vazio, é um botão grande para escolher (como "Do computador" no Frames); escolhida, mostra o
 * nome, o caminho e Trocar. `tom`: 'down' (computador/origem), 'drive' (Drive), 'up' (destino).
 */
export function Fonte({ icone, tom = 'down', rotulo, valor, caminho, vazio, dica, onTrocar, onTirar, onSoltarPasta, tirarLabel = 'Tirar' }) {
  const [over, dropProps] = useSoltarPasta(onSoltarPasta)
  if (!valor) {
    return html`<button type="button" class=${cx('cp-fonte is-vazio', `is-${tom}`, over && 'is-sobre')} onClick=${onTrocar} ...${dropProps}>
      <span class="cp-fonte-ic"><${Icon} name=${icone} size=${22} strokeWidth=${1.7} /></span>
      <span class="cp-fonte-txt"><b>${vazio}</b><span>${over ? 'Solte a pasta aqui' : dica}</span></span>
      <span class="cp-fonte-mais" aria-hidden="true"><${Icon} name="plus" size=${16} strokeWidth=${2} /></span>
    </button>`
  }
  return html`<div class=${cx('cp-fonte', `is-${tom}`, over && 'is-sobre')} ...${dropProps}>
    <span class="cp-fonte-ic"><${Icon} name=${icone} size=${20} strokeWidth=${1.7} /></span>
    <span class="cp-fonte-txt">
      ${rotulo ? html`<span class="cp-fonte-rot">${rotulo}</span>` : null}
      <b title=${valor}>${valor}</b>
      ${caminho ? html`<span class="cp-fonte-caminho" title=${caminho}>${over ? 'Solte a pasta aqui' : caminho}</span>` : null}
    </span>
    <${Button} size="sm" icon="folder" onClick=${onTrocar}>Trocar</${Button}>
    ${onTirar ? html`<button type="button" class="icon-btn" onClick=${onTirar} aria-label=${tirarLabel}><${Icon} name="x" size=${14} /></button>` : null}
  </div>`
}

/** Origem → destino no resumo: as duas pontas e a seta. */
export function Rota({ de, para, deIcone, paraIcone, paraTom = 'drive' }) {
  return html`<div class="k-caixa cp-rota">
    <div class="cp-rota-ponta is-down">
      <span class="cp-rota-ic"><${Icon} name=${deIcone} size=${16} strokeWidth=${1.8} /></span>
      <span class=${cx('cp-rota-nome', !de && 'is-falta')}>${de || 'Falta escolher'}</span>
    </div>
    <span class="cp-rota-linha" aria-hidden="true"><i></i></span>
    ${(Array.isArray(para) ? para : [para]).map(
      (p) => html`<div class=${cx('cp-rota-ponta', `is-${paraTom}`)}>
        <span class="cp-rota-ic"><${Icon} name=${paraIcone} size=${16} strokeWidth=${1.8} /></span>
        <span class=${cx('cp-rota-nome', !p && 'is-falta')}>${p || 'Falta escolher'}</span>
      </div>`,
    )}
  </div>`
}

