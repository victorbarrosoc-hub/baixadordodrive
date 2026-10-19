// Folha "Gerar proxy" (seleção da aba Drive): pede ao app SOBEDESCE do computador uma cópia leve 720p e a tira de
// quadros de cada vídeo marcado (lib/proxies.js). Depois de pedir, acompanha cada um a cada 5 s com a folha aberta;
// fechar não cancela nada: o computador continua.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js'
import { MAX, cancelar, pedirProxies, situacao, tentarDeNovo } from '../lib/proxies.js'
import { count } from '../lib/format.js'
import { closeSheet, getState, toast } from '../lib/state.js'
import { Icon } from './icons.js'
import { Button, SheetHead, cx } from './ui.js'
import { FileName } from './queue.js'

const ACOMPANHAR_MS = 5000

const TEXTO = {
  pendente: 'Esperando o computador',
  gerando: 'Gerando no computador…',
  pronto: 'Pronto',
  erro: 'Não deu',
}

function Linha({ f, p, onDeNovo, onCancelar }) {
  const st = p?.status
  const detalhe = st === 'pronto' ? p.resultado || 'Proxy na pasta Proxy' : st === 'erro' ? p.erro || TEXTO.erro : st ? TEXTO[st] : 'Pedindo…'
  return html`<li class=${cx('selsheet-row', 'pxrow', st && `is-${st}`)}>
    <span class="pxrow-ico" aria-hidden="true">
      ${st === 'pronto'
        ? html`<${Icon} name="circle-check" size=${20} />`
        : st === 'erro'
          ? html`<${Icon} name="warning" size=${20} />`
          : st === 'gerando'
            ? html`<span class="spinner"></span>`
            : html`<${Icon} name="clock" size=${20} />`}
    </span>
    <span class="selsheet-name"><${FileName} name=${f.name} /><small>${detalhe}</small></span>
    ${st === 'erro' ? html`<button type="button" class="link-btn" onClick=${() => onDeNovo(p)}>De novo</button>` : null}
    ${st === 'pendente' ? html`<button type="button" class="link-btn" onClick=${() => onCancelar(p)} aria-label=${`Cancelar ${f.name}`}>Cancelar</button>` : null}
  </li>`
}

export function ProxySheet({ itens: todos, fora = 0 }) {
  const itens = todos.slice(0, MAX)
  const [fase, setFase] = useState('confirmar') // 'confirmar' | 'pedindo' | 'acompanhar'
  const [mapa, setMapa] = useState(() => new Map())
  const vivo = useRef(true)
  useEffect(() => () => (vivo.current = false), [])

  // Acompanhar: a cada 5 s com a folha aberta e a tela à vista.
  useEffect(() => {
    if (fase !== 'acompanhar') return undefined
    const ac = new AbortController()
    let t = 0
    const tick = async () => {
      if (document.visibilityState !== 'hidden') {
        try {
          const m = await situacao(
            itens.map((f) => f.id),
            ac.signal,
          )
          if (!ac.signal.aborted) setMapa(m)
        } catch {
          // segue tentando
        }
      }
      if (!ac.signal.aborted) t = setTimeout(tick, ACOMPANHAR_MS)
    }
    t = setTimeout(tick, ACOMPANHAR_MS)
    return () => {
      ac.abort()
      clearTimeout(t)
    }
  }, [fase])

  const pedir = async () => {
    setFase('pedindo')
    try {
      const r = await pedirProxies(itens)
      if (!vivo.current) return
      setMapa(new Map(r.pedidos.map((p) => [p.fileId, p])))
      setFase('acompanhar')
    } catch (err) {
      if (!vivo.current) return
      setFase('confirmar')
      toast(err?.message || 'Não deu para pedir agora.', { tone: 'error', ms: 4200 })
    }
  }
  const trocar = (p) => setMapa((m) => new Map(m).set(p.fileId, p))
  const deNovo = async (p) => {
    try {
      trocar(await tentarDeNovo(p.id))
    } catch (err) {
      toast(err?.message || 'Não deu agora.', { tone: 'error' })
    }
  }
  const cancelarUm = async (p) => {
    try {
      await cancelar(p.id)
      setMapa((m) => {
        const n = new Map(m)
        n.delete(p.fileId)
        return n
      })
    } catch (err) {
      toast(err?.message || 'Não deu agora.', { tone: 'error' })
    }
  }

  const n = itens.length
  const nome = n === 1 ? `“${itens[0].name}”` : `${count(n)} vídeos`
  const ligado = (getState().pc?.computadores || []).find((pc) => pc.online)
  const avisos = [
    fora ? `${count(fora)} ${fora === 1 ? 'item fica' : 'itens ficam'} de fora (só vídeos).` : null,
    todos.length > MAX ? `Até ${count(MAX)} por vez: os outros ${count(todos.length - MAX)} ficam para o próximo pedido.` : null,
  ].filter(Boolean)

  if (fase !== 'acompanhar') {
    return html`<${SheetHead} title="Gerar proxy" left=${html`<button type="button" class="link-btn" onClick=${closeSheet}>Cancelar</button>`} />
      <div class="sheet-body rsheet">
        <p class="rexplain">
          O app SOBEDESCE do computador gera uma cópia leve (720p) de ${nome} e a tira de quadros para ver o take passando o dedo. Sobe na
          pasta Proxy, ao lado do original.
        </p>
        <div class="ritem pxpc">
          <${Icon} name="laptop" size=${22} />
          <div>
            <b>${ligado ? `${ligado.nome} está ligado` : 'Precisa de um computador ligado'}</b>
            <p>
              ${ligado
                ? 'Ele pega o pedido em até 30 segundos. Se o original não estiver nele, baixa do Drive primeiro.'
                : 'Deixe o SOBEDESCE aberto num computador com a sua conta. O pedido fica guardado até ele pegar.'}
            </p>
          </div>
        </div>
        ${avisos.map((a) => html`<p class="group-foot">${a}</p>`)}
        <${Button} variant="down" size="lg" class="btn-block" icon="film" onClick=${pedir} disabled=${fase === 'pedindo'}>
          ${fase === 'pedindo' ? 'Pedindo…' : `Pedir proxy de ${n === 1 ? '1 vídeo' : `${count(n)} vídeos`}`}
        </${Button}>
      </div>`
  }

  const lista = itens.map((f) => ({ f, p: mapa.get(f.id) }))
  const prontos = lista.filter((x) => x.p?.status === 'pronto').length
  const erros = lista.filter((x) => x.p?.status === 'erro').length
  const resumo = prontos === n ? 'Todos prontos' : `${count(prontos)} de ${count(n)} prontos${erros ? ` · ${count(erros)} com erro` : ''}`
  return html`<${SheetHead} title="Gerar proxy" right=${html`<button type="button" class="link-btn is-strong" onClick=${closeSheet}>OK</button>`} />
    <div class="sheet-body selsheet">
      <p class="rexplain" role="status"><b>${resumo}.</b> Pode fechar: o computador continua e os proxies aparecem na pasta Proxy.</p>
      <ul class="group selsheet-list">
        ${lista.map(({ f, p }) => html`<${Linha} key=${f.id} f=${f} p=${p} onDeNovo=${deNovo} onCancelar=${cancelarUm} />`)}
      </ul>
    </div>`
}
ProxySheet.label = 'Gerar proxy'
