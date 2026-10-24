// Selecionar itens na aba Drive: segurar um item abre o menu dele (components/item-menu.js), que tem "Selecionar"
// (vibra no Android ao segurar); com a seleção ligada, tocar ou segurar marca e desmarca. A barra de baixo diz quantos e quanto pesam, marca todos ou nenhum e faz as ações só nos marcados:
// Baixar (um depois do outro), Copiar links, Gerar proxy (o computador gera; components/proxies.js), Frames (aba Criar,
// components/criar.js) e Mover para a
// lixeira (com confirmação; dá para recuperar por 30 dias).
//
// O gesto de segurar é o mesmo do "segurar e arrastar" das miniaturas com tira de quadros (components/scrub.js):
// segurou e arrastou para os lados = corre o take; segurou e soltou sem arrastar = seleciona.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js'
import { fileLink, folderLink, trashFile } from '../lib/drive.js'
import { canDownload, isFolder, target } from '../lib/browse.js'
import { streamReady, streamUrl } from '../lib/stream.js'
import { bytes, count } from '../lib/format.js'
import { closeSheet, openSheet, toast } from '../lib/state.js'
import { isIOS } from '../lib/platform.js'
import { Icon } from './icons.js'
import { Button, SheetHead, copyText, cx } from './ui.js'
import { FileName } from './queue.js'
import { podeProxy } from '../lib/proxies.js'
import { framesDoDrive } from './criar.js'

export const SEGURAR_MS = 380
const FOLGA_PX = 10 // mexeu mais que isso antes do tempo: é rolagem
const ARRASTO_PX = 12 // depois de segurar, mais que isso para os lados: é o arrastar do take
const DIRETO_PX = 8 // sem segurar: andou isso e decide se é correr o take (para os lados) ou rolar
const ENTRE_DOWNLOADS_MS = 1600

/** Engole o próximo clique (em qualquer lugar) nos próximos `ms`. */
function engolirClique(ms) {
  const ate = Date.now() + ms
  const f = (e) => {
    document.removeEventListener('click', f, true)
    if (Date.now() < ate) {
      e.preventDefault()
      e.stopPropagation()
    }
  }
  document.addEventListener('click', f, true)
  setTimeout(() => document.removeEventListener('click', f, true), ms)
}

/**
 * Gesto de segurar num item (só toque). `onSegurar()` ao soltar sem arrastar; `onMenu()` no botão direito do mouse
 * (o app aberto no computador; o "segurar" do sistema no toque não conta); `onArrastar(clientX|null)` enquanto
 * arrasta depois de segurar (null ao terminar). `direto`: arrastar para os lados já corre, sem segurar antes, quando o
 * dedo começa na área que tira o "voltar" (`[data-noswipe]`, a miniatura do vídeo); para cima e para baixo rola.
 * Devolve os handlers para o elemento e um ref (o touchmove não passivo, que segura a rolagem só com o gesto ligado,
 * precisa do elemento).
 */
export function useSegurar({ onSegurar, onArrastar, onMenu, direto = false }) {
  const ref = useRef(null)
  const t = useRef({ timer: 0, segurou: false, arrastando: false, rolando: false, direto: false, x: 0, y: 0, engolir: 0, toque: 0 })
  const cbs = useRef({ onSegurar, onArrastar, onMenu, direto })
  cbs.current = { onSegurar, onArrastar, onMenu, direto }
  // Antes de segurar: andou mais para os lados que para cima = corre o take (com `direto`); senão é rolagem.
  const decidir = (x, y) => {
    const c = t.current
    if (c.segurou || c.rolando) return
    const dx = Math.abs(x - c.x)
    const dy = Math.abs(y - c.y)
    if (Math.hypot(dx, dy) <= DIRETO_PX) return
    clearTimeout(c.timer)
    if (c.direto && cbs.current.onArrastar && dx > dy * 1.2) {
      c.segurou = true
      c.arrastando = true
      cbs.current.onArrastar(x)
    } else c.rolando = true
  }
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const onMove = (e) => {
      const p = e.touches?.[0]
      if (p) decidir(p.clientX, p.clientY)
      if (t.current.segurou && e.cancelable) e.preventDefault()
    }
    el.addEventListener('touchmove', onMove, { passive: false })
    return () => {
      el.removeEventListener('touchmove', onMove)
      clearTimeout(t.current.timer)
    }
  }, [])
  const fim = (cancelado) => {
    const c = t.current
    clearTimeout(c.timer)
    if (c.segurou) {
      // Soltar depois de segurar nunca abre o arquivo. Nem toca no que acabou de abrir por cima (o fundo do menu do
      // item): o clique que alguns aparelhos ainda mandam depois do toque longo é engolido na página toda.
      c.engolir = Date.now() + 500
      engolirClique(500)
      if (c.arrastando) cbs.current.onArrastar?.(null)
      else if (!cancelado) cbs.current.onSegurar?.()
    }
    c.segurou = false
    c.arrastando = false
  }
  return {
    ref,
    onPointerDown: (e) => {
      if (e.pointerType !== 'touch') return
      const c = t.current
      c.toque = Date.now()
      clearTimeout(c.timer)
      c.segurou = false
      c.arrastando = false
      c.rolando = false
      c.direto = cbs.current.direto && Boolean(e.target?.closest?.('[data-noswipe]'))
      c.x = e.clientX
      c.y = e.clientY
      c.timer = setTimeout(() => {
        c.segurou = true
        navigator.vibrate?.(10)
      }, SEGURAR_MS)
    },
    onPointerMove: (e) => {
      if (e.pointerType !== 'touch') return
      const c = t.current
      if (!c.segurou) {
        decidir(e.clientX, e.clientY)
        if (!c.segurou) {
          if (Math.hypot(e.clientX - c.x, e.clientY - c.y) > FOLGA_PX) clearTimeout(c.timer)
          return
        }
      }
      if (!cbs.current.onArrastar) return
      if (!c.arrastando && Math.abs(e.clientX - c.x) > ARRASTO_PX) c.arrastando = true
      if (c.arrastando) cbs.current.onArrastar(e.clientX)
    },
    onPointerUp: () => fim(false),
    onPointerCancel: () => fim(true),
    onClickCapture: (e) => {
      if (Date.now() < t.current.engolir) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
    onContextMenu: (e) => {
      // O menu de segurar do sistema (iOS/Android) não aparece por cima do nosso gesto.
      e.preventDefault()
      // Botão direito do mouse (sem toque recente): o nosso menu, na hora.
      if (Date.now() - t.current.toque > 1500) cbs.current.onMenu?.()
    },
  }
}

/** Estado da seleção da tela: { ativa, ids }. Sair limpa tudo. */
export function useSelecao() {
  const [ids, setIds] = useState(() => new Set())
  const [ativa, setAtiva] = useState(false)
  return {
    ativa,
    ids,
    tem: (id) => ids.has(id),
    alternar: (id) => {
      setAtiva(true)
      setIds((s) => {
        const n = new Set(s)
        if (n.has(id)) n.delete(id)
        else n.add(id)
        return n
      })
    },
    todos: (lista) => setIds(new Set(lista.map((f) => f.id))),
    nenhum: () => setIds(new Set()),
    sair: () => {
      setAtiva(false)
      setIds(new Set())
    },
    // Itens que sumiram da lista (outra pasta, lixeira): fora da seleção.
    manter: (lista) =>
      setIds((s) => {
        const vivos = new Set(lista.map((f) => f.id))
        const n = new Set([...s].filter((id) => vivos.has(id)))
        return n.size === s.size ? s : n
      }),
  }
}

/** Marca de seleção no canto do item. */
export function Marca({ on }) {
  return html`<span class=${cx('selmark', on && 'is-on')} aria-hidden="true">${on ? html`<${Icon} name="check" size=${13} strokeWidth=${3} />` : null}</span>`
}

const soArquivos = (itens) => itens.filter((f) => !isFolder(f))
const pesoDe = (itens) => itens.reduce((t, f) => t + (Number(f.size) || 0), 0)

/** Barra de baixo com a seleção ligada. */
export function BarraSelecao({ sel, visiveis, onSair, onRemovidos }) {
  const marcados = visiveis.filter((f) => sel.tem(f.id))
  const arquivos = soArquivos(marcados)
  const pastas = marcados.length - arquivos.length
  const todos = visiveis.length > 0 && marcados.length === visiveis.length
  const n = marcados.length
  const resumo = n ? `${count(n)} ${n === 1 ? 'selecionado' : 'selecionados'}` : 'Toque para marcar'
  const peso = arquivos.length ? bytes(pesoDe(arquivos)) : null
  const baixaveis = arquivos.filter(canDownload)
  const lixo = arquivos.filter((f) => f.capabilities?.canTrash !== false)
  const videos = arquivos.filter(podeProxy)
  return html`<div class="selbar" role="toolbar" aria-label="Itens selecionados">
    <div class="selbar-top">
      <button type="button" class="icon-btn selbar-x" onClick=${onSair} aria-label="Sair da seleção">
        <${Icon} name="x" size=${20} strokeWidth=${2} />
      </button>
      <span class="selbar-count" role="status"><b>${resumo}</b>${peso ? html`<small>${peso}</small>` : null}</span>
      <button type="button" class="link-btn is-strong" onClick=${() => (todos ? sel.nenhum() : sel.todos(visiveis))}>
        ${todos ? 'Desmarcar todos' : 'Selecionar todos'}
      </button>
    </div>
    <div class="selbar-acts">
      <button
        type="button"
        class="selact"
        disabled=${!baixaveis.length}
        onClick=${() => openSheet('baixarSelecao', { itens: baixaveis, pastas, semPermissao: arquivos.length - baixaveis.length })}
      >
        <${Icon} name="download" size=${20} /><span>Baixar</span>
      </button>
      <button type="button" class="selact" disabled=${!n} onClick=${() => copiarLinks(marcados)}>
        <${Icon} name="link" size=${20} /><span>Copiar links</span>
      </button>
      <button type="button" class="selact" disabled=${!videos.length} onClick=${() => openSheet('proxySelecao', { itens: videos, fora: n - videos.length })}>
        <${Icon} name="film" size=${20} /><span>Gerar proxy</span>
      </button>
      <button type="button" class="selact" disabled=${videos.length !== 1 || n !== 1} title="Um vídeo por vez" onClick=${() => (onSair(), framesDoDrive(videos[0]))}>
        <${Icon} name="sparkle" size=${20} /><span>Frames</span>
      </button>
      <button
        type="button"
        class="selact is-danger"
        disabled=${!lixo.length}
        onClick=${() => openSheet('lixeiraSelecao', { itens: lixo, pastas, semPermissao: arquivos.length - lixo.length, onFeito: onRemovidos })}
      >
        <${Icon} name="trash" size=${20} /><span>Lixeira</span>
      </button>
    </div>
  </div>`
}

export async function copiarLinks(itens) {
  const linhas = itens.map((f) => {
    const t = target(f)
    return `${f.name}\n${isFolder(f) ? folderLink(t.id) : fileLink(t.id)}`
  })
  const texto = linhas.join('\n\n')
  if (await copyText(texto)) toast(itens.length === 1 ? 'Link copiado' : `${count(itens.length)} links copiados`, { tone: 'success' })
  else if (typeof navigator.share === 'function') navigator.share({ text: texto }).catch(() => {})
  else toast('Não consegui copiar os links', { tone: 'error' })
}

/** Folha "Baixar": um arquivo depois do outro; cada linha tem o seu Baixar (o iPhone às vezes segura os seguintes). */
export function BaixarSheet({ itens, pastas = 0, semPermissao = 0 }) {
  const [st, setSt] = useState(() => ({ fase: 'pronto', feitos: new Set(), atual: -1 }))
  const parar = useRef(false)
  useEffect(() => () => (parar.current = true), [])
  const baixarUm = (f) => {
    const a = document.createElement('a')
    a.href = streamUrl(f, { download: true })
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setSt((s) => ({ ...s, feitos: new Set([...s.feitos, f.id]) }))
  }
  const todos = async () => {
    if (!(await streamReady())) return toast('O app ainda está preparando os downloads. Tente de novo em instantes.', { tone: 'error', ms: 4200 })
    setSt((s) => ({ ...s, fase: 'baixando' }))
    for (let i = 0; i < itens.length; i++) {
      if (parar.current) return
      setSt((s) => ({ ...s, atual: i }))
      baixarUm(itens[i])
      if (i < itens.length - 1) await new Promise((r) => setTimeout(r, ENTRE_DOWNLOADS_MS))
    }
    if (parar.current) return
    setSt((s) => ({ ...s, fase: 'fim', atual: -1 }))
    toast(isIOS ? 'Baixando. Ficam em Arquivos › Downloads' : 'Baixando', { tone: 'success', ms: 3600 })
  }
  const umSo = async (f) => {
    if (!(await streamReady())) return toast('O app ainda está preparando os downloads. Tente de novo em instantes.', { tone: 'error', ms: 4200 })
    baixarUm(f)
  }
  const fora = [pastas ? `${count(pastas)} ${pastas === 1 ? 'pasta fica' : 'pastas ficam'} de fora (só arquivos)` : null, semPermissao ? `${count(semPermissao)} sem permissão para baixar` : null].filter(Boolean)
  return html`<${SheetHead}
      title=${`Baixar ${itens.length === 1 ? '1 arquivo' : `${count(itens.length)} arquivos`}`}
      left=${html`<button type="button" class="link-btn" onClick=${closeSheet}>${st.fase === 'baixando' ? 'Parar' : 'Fechar'}</button>`}
    />
    <div class="sheet-body selsheet">
      <p class="rexplain">
        ${bytes(pesoDe(itens))} no total. Os arquivos começam a baixar um depois do outro${isIOS ? ' e ficam em Arquivos › Downloads' : ''}.
        ${isIOS ? ' Se o iPhone perguntar, toque em Permitir. Se algum não começar, toque no Baixar dele.' : ''}
      </p>
      ${fora.length ? html`<p class="group-foot">${fora.join(' · ')}.</p>` : null}
      ${st.fase === 'pronto'
        ? html`<${Button} variant="down" size="lg" class="btn-block" icon="download" onClick=${todos}>Baixar todos</${Button}>`
        : st.fase === 'baixando'
          ? html`<div class="selsheet-prog" role="status"><span class="spinner" aria-hidden="true"></span> Baixando ${count(st.atual + 1)} de ${count(itens.length)}…</div>`
          : html`<div class="ritem is-ok"><${Icon} name="circle-check" size=${22} /><div><b>Todos enviados para o download</b><p>${isIOS ? 'Acompanhe em Arquivos › Downloads (ou na seta azul do Safari).' : 'Acompanhe nos downloads do navegador.'}</p></div></div>`}
      <ul class="group selsheet-list">
        ${itens.map(
          (f, i) => html`<li class=${cx('selsheet-row', i === st.atual && 'is-now')}>
            <span class="selsheet-name"><${FileName} name=${f.name} /><small>${f.size != null ? bytes(Number(f.size)) : ''}</small></span>
            ${st.feitos.has(f.id)
              ? html`<span class="selsheet-ok" aria-label="Enviado para o download"><${Icon} name="check" size=${16} strokeWidth=${2.5} /></span>`
              : null}
            <button type="button" class="link-btn" onClick=${() => umSo(f)} aria-label=${`Baixar ${f.name}`}>${st.feitos.has(f.id) ? 'De novo' : 'Baixar'}</button>
          </li>`,
        )}
      </ul>
    </div>`
}
BaixarSheet.label = 'Baixar selecionados'

/** Folha "Lixeira": confirma e manda para a lixeira do Drive, 3 de cada vez. */
export function LixeiraSheet({ itens, pastas = 0, semPermissao = 0, onFeito }) {
  const [st, setSt] = useState({ fase: 'confirmar' })
  const ctl = useRef(null)
  useEffect(() => () => ctl.current?.abort(), [])
  const mover = async () => {
    const c = new AbortController()
    ctl.current = c
    setSt({ fase: 'movendo', feitos: 0 })
    const res = { movidos: [], recusados: 0, falhas: 0 }
    let prox = 0
    let feitos = 0
    const worker = async () => {
      while (prox < itens.length && !c.signal.aborted) {
        const f = itens[prox++]
        try {
          await trashFile(f.id, c.signal)
          res.movidos.push(f.id)
        } catch (err) {
          if (c.signal.aborted) break
          if (err?.status === 403 || err?.status === 404) res.recusados++
          else res.falhas++
        }
        feitos++
        if (!c.signal.aborted) setSt({ fase: 'movendo', feitos })
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, itens.length) }, worker))
    // Mesmo parada no meio, a tela tira da lista os que já foram.
    if (res.movidos.length) onFeito?.(res.movidos)
    if (!c.signal.aborted) setSt({ fase: 'fim', res })
  }
  const nome = itens.length === 1 ? `“${itens[0].name}”` : `${count(itens.length)} arquivos`
  if (st.fase === 'confirmar') {
    return html`<${SheetHead} title="Mover para a lixeira" left=${html`<button type="button" class="link-btn" onClick=${closeSheet}>Cancelar</button>`} />
      <div class="sheet-body rsheet">
        <p class="rexplain">${nome} ${itens.length === 1 ? 'vai' : 'vão'} para a lixeira do Drive (${bytes(pesoDe(itens))}). Dá para recuperar por 30 dias, na lixeira do Drive.</p>
        ${pastas ? html`<p class="group-foot">${count(pastas)} ${pastas === 1 ? 'pasta selecionada fica' : 'pastas selecionadas ficam'} de fora: só arquivos vão para a lixeira por aqui.</p>` : null}
        ${semPermissao ? html`<p class="group-foot mjunk-warn">${count(semPermissao)} sem permissão para mover (falta permissão nesta pasta).</p>` : null}
        <${Button} variant="secondary" class="btn-block btn-lg is-danger" icon="trash" onClick=${mover}>
          ${`Mover ${itens.length === 1 ? '1 arquivo' : `${count(itens.length)} arquivos`} para a lixeira`}
        </${Button}>
      </div>`
  }
  if (st.fase === 'movendo') {
    const pct = Math.round((st.feitos / itens.length) * 100)
    return html`<${SheetHead} title="Movendo para a lixeira" left=${html`<button type="button" class="link-btn" onClick=${() => (ctl.current?.abort(), closeSheet())}>Parar</button>`} />
      <div class="sheet-body rsheet">
        <div class="mjunk-prog" role="progressbar" aria-valuemin="0" aria-valuemax=${itens.length} aria-valuenow=${st.feitos} aria-label="Movendo para a lixeira">
          <span style=${`width:${pct}%`}></span>
        </div>
        <p class="mjunk-count">${count(st.feitos)} de ${count(itens.length)}</p>
      </div>`
  }
  const r = st.res
  const m = r.movidos.length
  return html`<${SheetHead} title=${m ? 'Pronto' : 'Não deu'} right=${html`<button type="button" class="link-btn is-strong" onClick=${closeSheet}>OK</button>`} />
    <div class="sheet-body rsheet">
      <div class=${cx('ritem', m ? 'is-ok' : 'is-error')}>
        <${Icon} name=${m ? 'circle-check' : 'warning'} size=${22} />
        <div>
          <b>${m ? `${m === 1 ? '1 arquivo foi' : `${count(m)} arquivos foram`} para a lixeira do Drive` : 'Nenhum arquivo foi para a lixeira'}</b>
          <p>${[
            m ? 'Dá para recuperar por 30 dias, na lixeira do Drive.' : null,
            r.recusados ? `${count(r.recusados)} sem permissão (num Drive compartilhado, só quem gerencia o conteúdo pode).` : null,
            r.falhas ? `${count(r.falhas)} falharam (conexão). Tente de novo.` : null,
          ]
            .filter(Boolean)
            .join(' ')}</p>
        </div>
      </div>
    </div>`
}
LixeiraSheet.label = 'Mover para a lixeira'
