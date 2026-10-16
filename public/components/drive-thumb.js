// Miniatura de um item do Drive (rota /api/drive/thumb do servidor local). Enquanto carrega, ou se não houver
// miniatura, fica o ícone do tipo no visual da casa; a imagem entra por cima com um fade.
import { html, useState } from '/vendor/preact-htm.js'
import { cx } from '../lib/ui.js'
import { thumbUrl } from '../lib/media.js'
import { FileIcon } from './common.js'

const broken = new Set() // URLs que já falharam: não tenta de novo a cada desenho

/**
 * @param {{ accountId: string, item: object, proxy?: object, size?: number, iconSize?: number, class?: string, fit?: 'cover'|'contain' }} props
 * `proxy`: item cuja miniatura vale no lugar (proxy de câmera do original sem miniatura).
 */
export function Thumb({ accountId, item, proxy, size = 220, iconSize = 28, class: klass, fit = 'cover', folderLike }) {
  const src = folderLike ? null : thumbUrl(accountId, item, size) || (proxy ? thumbUrl(accountId, proxy, size) : null)
  const [state, setState] = useState('loading')
  const [, force] = useState(0)
  const icon = html`<${FileIcon} name=${item.name} mimeType=${item.mimeType} isFolder=${folderLike} size=${iconSize} shortcut=${item.isShortcut} />`
  if (!src || broken.has(src)) return html`<span class=${cx('thumb', 'is-icon', klass)}>${icon}</span>`
  return html`<span class=${cx('thumb', state === 'ok' && 'is-loaded', klass)}>
    ${state !== 'ok' ? icon : null}
    <img
      key=${src}
      src=${src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable="false"
      style=${`object-fit:${fit}`}
      onLoad=${() => setState('ok')}
      onError=${() => {
        broken.add(src)
        setState('error')
        force((n) => n + 1)
      }}
    />
  </span>`
}
