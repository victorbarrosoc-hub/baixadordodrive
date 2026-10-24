// "Baixar como…": o menu de formatos de uma referência (botão no cartão, botão direito na grade e na prévia).
// Onde salvar (computador, coleção ou os dois) em pílulas e os formatos em itens do kit; a última escolha fica lembrada.
// Quem converte é o motor (POST /api/referencias/exportar): o andamento aparece em "Salvando agora".
import { html, useEffect, useLayoutEffect, useRef, useState } from '/vendor/preact-htm.js'
import { attempt } from '../lib/api.js'
import { cx, useDismiss } from '../lib/ui.js'
import { toast } from '../lib/toasts.js'
import { DESTINOS, FORMATOS, conversor, exportar, formatosPara, lembrarDestino, lembrarFormato, tipoDoItem, ultimoDestino, ultimoFormato } from '../lib/referencias.js'
import { Icon } from './icons.js'
import { Pilulas } from './kit.js'
import { Spinner } from './common.js'

const LARGURA = 336
const MARGEM = 12

/** Por que este formato não dá agora (null = dá). */
function bloqueio(f, destino, conv) {
  if (f.id === 'original') return destino === 'drive' ? 'Já está na coleção' : null
  if (conv && !conv.ok) return 'Falta o ffmpeg'
  if (f.id === 'mp3-320' && conv && conv.mp3 === false) return 'Este ffmpeg não gera MP3'
  return null
}

/**
 * @param {{ it: object, colecaoId: string, x: number, y: number, dest: string, destLabel?: string,
 *   onChangeDest?: () => void, onOriginal: (it) => Promise<boolean>, onClose: () => void }} props
 *   `x`/`y`: canto de onde o menu abre (o clique com o botão direito ou o pé do botão), em coordenadas da janela.
 */
export function BaixarComo({ it, colecaoId, x, y, dest, destLabel, onChangeDest, onOriginal, onClose }) {
  const ref = useRef(null)
  const tipo = tipoDoItem(it)
  const [destino, setDestino] = useState(() => ultimoDestino())
  const [conv, setConv] = useState(null)
  const [busy, setBusy] = useState(null)
  const [pos, setPos] = useState({ left: x, top: y, pronto: false })
  const ultimo = ultimoFormato(tipo || 'video')
  // Clicar de novo no botão que abriu fecha (o próprio botão cuida disso); fora dele, fecha aqui.
  useDismiss(ref, (e) => {
    if (e?.type === 'pointerdown' && e.target?.closest?.('[data-fmt-abre]')) return
    onClose()
  })

  useEffect(() => {
    let vivo = true
    conversor().then((c) => vivo && setConv(c))
    return () => {
      vivo = false
    }
  }, [])

  // Cabe na janela: abre para o lado e para cima quando não há espaço.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const h = el.offsetHeight
    const W = window.innerWidth
    const H = window.innerHeight
    let left = x
    let top = y
    if (left + LARGURA + MARGEM > W) left = Math.max(MARGEM, x - LARGURA)
    if (top + h + MARGEM > H) top = Math.max(MARGEM, H - h - MARGEM)
    setPos({ left, top, pronto: true })
    // O foco vai para a última escolha (Enter repete o de sempre), senão para o primeiro que dá.
    ;(el.querySelector('.rf-fmt-item.is-ultimo:not(:disabled)') || el.querySelector('.rf-fmt-item:not(:disabled)'))?.focus({ preventScroll: true })
  }, [x, y, conv])

  const escolher = async (f) => {
    if (busy) return
    lembrarDestino(destino)
    if (tipo) lembrarFormato(tipo, f.id)
    setBusy(f.id)
    if (f.id === 'original') {
      const ok = await onOriginal(it)
      setBusy(null)
      if (ok) onClose()
      return
    }
    const res = await attempt(exportar({ colecaoId, fileId: it.id, formato: f.id, destino, destDir: destino === 'drive' ? null : dest }))
    setBusy(null)
    if (!res) return
    toast('info', `Convertendo para ${f.curto}…`)
    onClose()
  }

  const lista = tipo ? formatosPara(tipo) : [FORMATOS.original]
  const grupos = []
  for (const f of lista) {
    const g = f.grupo || ''
    if (!grupos.length || grupos[grupos.length - 1].nome !== g) grupos.push({ nome: g, itens: [] })
    grupos[grupos.length - 1].itens.push(f)
  }
  const titulo = (it.referencia?.titulo || it.name || '').replace(/\.[a-z0-9]+$/i, '')

  return html`<div
    class=${cx('menu rf-fmt', pos.pronto && 'is-pronto')}
    role="menu"
    aria-label="Baixar como"
    ref=${ref}
    style=${`left:${pos.left}px;top:${pos.top}px;width:${LARGURA}px`}
    onKeyDown=${(e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const itens = [...ref.current.querySelectorAll('.rf-fmt-item:not(:disabled)')]
      const i = itens.indexOf(document.activeElement)
      const n = itens[(i + (e.key === 'ArrowDown' ? 1 : -1) + itens.length) % itens.length]
      if (n) {
        e.preventDefault()
        n.focus()
      }
    }}
  >
    <div class="rf-fmt-head">
      <b>Baixar como…</b>
      <span title=${it.name}>${titulo}</span>
    </div>
    <div class="rf-fmt-onde">
      <span class="rf-fmt-rotulo">Onde</span>
      <${Pilulas} label="Onde salvar" valor=${destino} itens=${DESTINOS} onEscolher=${setDestino} />
    </div>
    ${destino !== 'drive'
      ? html`<button type="button" class="rf-fmt-pasta" onClick=${onChangeDest} disabled=${!onChangeDest} title=${dest}>
          <${Icon} name="folder" size=${14} />
          <span>Para <b>${destLabel || dest || 'Downloads'}</b></span>
          ${onChangeDest ? html`<span class="rf-fmt-trocar">Trocar</span>` : null}
        </button>`
      : html`<p class="rf-fmt-pasta is-nota"><${Icon} name="cloud" size=${14} /><span>Ao lado do original, na coleção</span></p>`}
    ${grupos.map(
      (g) => html`${g.nome ? html`<div class="menu-label">${g.nome}</div>` : html`<div class="rf-fmt-sep"></div>`}
        ${g.itens.map((f) => {
          const motivo = bloqueio(f, destino, conv)
          const tom = f.icone === 'music' ? 'up' : f.icone === 'photo' ? 'ok' : 'down'
          return html`<button
            type="button"
            role="menuitem"
            class=${cx('rf-fmt-item', f.id === ultimo && 'is-ultimo')}
            style=${`--c:var(--${tom})`}
            disabled=${Boolean(motivo) || (busy && busy !== f.id)}
            onClick=${() => escolher(f)}
          >
            <span class="rf-fmt-ic">${busy === f.id ? html`<${Spinner} size=${14} />` : html`<${Icon} name=${f.icone} size=${15} strokeWidth=${1.9} />`}</span>
            <span class="rf-fmt-txt"><b>${f.titulo}</b><span>${motivo || f.sub}</span></span>
            ${f.id === ultimo ? html`<span class="rf-fmt-ok" title="Última escolha"><${Icon} name="check" size=${13} strokeWidth=${2.4} /></span>` : null}
          </button>`
        })}`,
    )}
    ${conv && !conv.ok ? html`<p class="rf-fmt-aviso"><${Icon} name="warning" size=${14} />${conv.aviso}</p>` : null}
  </div>`
}
