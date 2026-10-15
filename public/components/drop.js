// Soltar arquivos e pastas do Finder/Explorer para enviar ao Drive.
// No desktop: um véu calmo cobre a área de conteúdo ("Solte para enviar para <pasta>").
// No navegador não há caminho dos arquivos soltos, então só aparece uma dica discreta.
import { html, useEffect, useRef, useState } from '/vendor/preact-htm.js'
import { bridge, pathsFromDrop } from '../lib/desktop.js'
import { Icon } from './icons.js'

const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files')
const modalOpen = () => document.documentElement.classList.contains('has-modal')

/**
 * @param {{ label: string, onPaths: (paths: string[]) => void, enabled?: boolean }} props
 */
export function FileDrop({ label, onPaths, enabled = true }) {
  const [over, setOver] = useState(false)
  const cb = useRef(onPaths)
  cb.current = onPaths

  useEffect(() => {
    if (!enabled) return undefined
    let depth = 0
    const reset = () => {
      depth = 0
      setOver(false)
    }
    const enter = (e) => {
      if (!hasFiles(e) || modalOpen()) return
      depth++
      setOver(true)
    }
    const dragover = (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = bridge && !modalOpen() ? 'copy' : 'none'
    }
    const leave = (e) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (!depth || e.relatedTarget === null) reset()
    }
    const drop = (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      reset()
      if (modalOpen() || !bridge) return
      const paths = pathsFromDrop(e.dataTransfer)
      if (paths.length) cb.current(paths)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', dragover)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', dragover)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
      window.removeEventListener('blur', reset)
    }
  }, [enabled])

  if (!over) return null
  if (!bridge) {
    return html`<div class="drop-hint" role="status">
      <${Icon} name="info" size=${15} />
      <span>Arrastar do Finder funciona no app de desktop. Aqui no navegador, use “Enviar”.</span>
    </div>`
  }
  return html`<div class="drop-veil" role="status" aria-live="polite">
    <div class="drop-target">
      <span class="drop-icon"><${Icon} name="upload" size=${26} /></span>
      <b>Solte para enviar para “${label}”</b>
      <span class="sub">Pastas vão com tudo dentro.</span>
    </div>
  </div>`
}
