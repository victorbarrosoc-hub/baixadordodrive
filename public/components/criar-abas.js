// "Criar" no menu junta Frames e Cartões: as duas telas mostram estas abas no topo.
import { html } from '/vendor/preact-htm.js'
import { navigate } from '../lib/router.js'
import { Segmented } from './common.js'

const ABAS = [
  { value: 'frames', label: 'Frames', icon: 'frames' },
  { value: 'cartoes', label: 'Cartões', icon: 'sdcard' },
]

export function CriarAbas({ atual }) {
  return html`<${Segmented} label="Criar" value=${atual} onChange=${(v) => v !== atual && navigate(v)} options=${ABAS} />`
}
