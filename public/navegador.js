// Barra do navegador de referências (janela própria do app de desktop; desktop/navegador.js).
// Esta página ocupa a janela inteira; a página do site (Instagram, YouTube…) é outra view por cima, abaixo da barra e
// à esquerda do painel. Aqui ficam: voltar/avançar/recarregar, o endereço, os atalhos, "Salvar referência" e o painel.
// A ponte `window.navegador` (preload-navegador.cjs) só existe no app; no navegador comum a página mostra uma prévia
// estática (usada nas capturas de tela).
import { html, render, useEffect, useMemo, useRef, useState } from '/vendor/preact-htm.js'
import { start, useStore } from './lib/store.js'
import { cx } from './lib/ui.js'
import { ATALHOS, ATIVAS, faseTexto, fracaoGeral, urlCurta } from './lib/referencias.js'
import { Icon } from './components/icons.js'
import { IconButton, Spinner } from './components/common.js'
import { Toasts } from './components/toasts.js'
import { SalvarReferencia } from './components/referencias-salvar.js'

const ponte = window.navegador || null
const params = new URLSearchParams(location.search)
// Prévia sem o app (capturas de tela): estado de mentira pelo endereço (?demo=…&url=…&painel=1).
const demo = !ponte

function useNavegador() {
  const [st, setSt] = useState(() =>
    demo
      ? { url: params.get('url') || 'https://www.instagram.com/reel/DQx1AbCdEfG/', titulo: '', podeVoltar: true, podeAvancar: false, carregando: false, deteccao: { plataforma: 'instagram', nome: 'Instagram', salvavel: params.get('salvavel') !== '0' } }
      : null,
  )
  useEffect(() => {
    if (!ponte) return undefined
    ponte.estado().then((s) => s && setSt(s))
    return ponte.aoEstado(setSt)
  }, [])
  return st
}

function Endereco({ st }) {
  const [texto, setTexto] = useState('')
  const [foco, setFoco] = useState(false)
  useEffect(() => {
    if (!foco) setTexto(st?.url || '')
  }, [st?.url, foco])
  const ir = (e) => {
    e.preventDefault()
    ponte?.ir(texto)
    e.currentTarget.querySelector('input')?.blur()
  }
  const det = st?.deteccao
  return html`<form class="nav-address" onSubmit=${ir}>
    ${st?.carregando ? html`<${Spinner} size=${14} />` : html`<${Icon} name=${/^https:/.test(st?.url || '') ? 'shield' : 'globe'} size=${14} />`}
    <input
      type="text"
      value=${foco ? texto : urlCurta(st?.url || '', 200)}
      placeholder="Busque ou digite um endereço"
      onFocus=${(e) => {
        setFoco(true)
        setTexto(st?.url || '')
        requestAnimationFrame(() => e.target.select())
      }}
      onBlur=${() => setFoco(false)}
      onInput=${(e) => setTexto(e.currentTarget.value)}
      onKeyDown=${(e) => e.key === 'Escape' && e.currentTarget.blur()}
      spellcheck="false"
      autocomplete="off"
      aria-label="Endereço"
    />
    ${det?.salvavel ? html`<span class="nav-det"><${Icon} name="film" size=${12} />${det.nome}</span>` : null}
  </form>`
}

function Atalhos({ url }) {
  return html`<div class="nav-quick" aria-label="Atalhos">
    ${ATALHOS.map((a) => {
      const on = url && new URL(a.url).hostname.replace(/^(www|br)\./, '') === (() => {
        try {
          return new URL(url).hostname.replace(/^(www|br|m)\./, '')
        } catch {
          return ''
        }
      })()
      return html`<button type="button" class=${cx('nav-chip', on && 'is-on')} onClick=${() => ponte?.ir(a.url)}>${a.nome}</button>`
    })}
  </div>`
}

/** Progresso dos salvamentos feitos por aqui (no painel e, com ele fechado, um resumo na barra). */
function useRecentes() {
  const ref = useStore((s) => s.referencias)
  const desde = useRef(Date.now() - (demo ? 3600_000 : 0))
  return useMemo(() => (ref?.trabalhos || []).filter((t) => t.criadoEm >= desde.current - 1000 && t.origem === 'navegador').slice(0, 6), [ref])
}

function Recentes({ lista }) {
  if (!lista.length) return null
  return html`<div class="nav-recent">
    <span class="eyebrow">Salvos por aqui</span>
    ${lista.map((t) => {
      const frac = fracaoGeral(t)
      const ativo = ATIVAS.has(t.fase)
      return html`<div key=${t.id} class=${cx('nav-recent-row', `is-${t.fase}`)}>
        <span class="nav-recent-icon">${ativo ? html`<${Spinner} size=${14} />` : t.fase === 'pronto' ? html`<${Icon} name="circle-check" size=${16} />` : html`<${Icon} name="warning" size=${15} />`}</span>
        <div class="nav-recent-main">
          <b title=${t.url}>${t.nome ? t.nome.replace(/\.[a-z0-9]+$/i, '') : urlCurta(t.url, 40)}</b>
          <span>${faseTexto(t)}</span>
          ${ativo ? html`<span class=${cx('ref-bar', frac == null && 'is-indeterminate')}><i style=${frac != null ? `width:${(frac * 100).toFixed(1)}%` : ''}></i></span>` : null}
        </div>
      </div>`
    })}
  </div>`
}

function Resumo({ lista, onAbrir }) {
  const t = lista[0]
  if (!t) return null
  const ativo = ATIVAS.has(t.fase)
  if (!ativo && Date.now() - t.atualizadoEm > 8000) return null
  return html`<button type="button" class=${cx('nav-status', `is-${t.fase}`)} onClick=${onAbrir}>
    ${ativo ? html`<${Spinner} size=${13} />` : t.fase === 'pronto' ? html`<${Icon} name="circle-check" size=${15} />` : html`<${Icon} name="warning" size=${14} />`}
    <span>${faseTexto(t)}</span>
  </button>`
}

function App() {
  const status = useStore((s) => s.status)
  const ref = useStore((s) => s.referencias)
  const st = useNavegador()
  const [alvo, setAlvo] = useState(demo && params.get('painel') ? { tipo: params.get('imagem') ? 'imagem' : 'video', url: st?.url, imagemUrl: params.get('imagem') || null, paginaUrl: st?.url } : null)
  const recentes = useRecentes()
  const [, tick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 2000)
    return () => clearInterval(t)
  }, [])
  // Menu de contexto da página ("Salvar imagem como referência", "Salvar link como referência").
  useEffect(() => (ponte ? ponte.aoSalvar((d) => setAlvo({ ...d, chave: Date.now() })) : undefined), [])
  useEffect(() => {
    ponte?.painel(Boolean(alvo))
  }, [Boolean(alvo)])
  useEffect(() => {
    const t = st?.titulo
    document.title = t ? `${t} · Navegador de referências` : 'Navegador de referências'
  }, [st?.titulo])

  const salvavel = Boolean(st?.deteccao?.salvavel)
  const abrirSalvar = () => setAlvo({ tipo: 'video', url: st.url, chave: Date.now() })
  const bloqueado = status === 'ready' && ref && !ref.ativo

  return html`<div class=${cx('nav-shell', alvo && 'has-panel', demo && 'is-demo')}>
    <header class="nav-bar">
      <div class="nav-btns">
        <${IconButton} icon="chevron-left" label="Voltar" disabled=${!st?.podeVoltar} onClick=${() => ponte?.acao('voltar')} />
        <${IconButton} icon="chevron-right" label="Avançar" disabled=${!st?.podeAvancar} onClick=${() => ponte?.acao('avancar')} />
        <${IconButton} icon=${st?.carregando ? 'x' : 'refresh'} label=${st?.carregando ? 'Parar' : 'Recarregar'} onClick=${() => ponte?.acao(st?.carregando ? 'parar' : 'recarregar')} />
      </div>
      <${Endereco} st=${st} />
      <${Atalhos} url=${st?.url} />
      <${Resumo} lista=${recentes} onAbrir=${() => !alvo && abrirSalvar()} />
      <button
        type="button"
        class=${cx('btn btn-primary nav-save', !salvavel && 'is-off')}
        disabled=${!salvavel || bloqueado}
        onClick=${abrirSalvar}
        title=${bloqueado ? 'Entre na conta SOBEDESCE no app para salvar referências.' : salvavel ? 'Salvar este vídeo/post numa coleção do seu Drive' : 'Abra um vídeo ou post para salvar'}
      >
        <${Icon} name="bookmark" size=${16} /><span>Salvar referência</span>
      </button>
    </header>
    ${demo ? html`<div class="nav-demo-page"><div class="nav-demo-frame"><span>Aqui aparece a página do site (${urlCurta(st?.url || '', 60)}).</span></div></div>` : null}
    ${alvo
      ? html`<aside class="nav-panel" aria-label="Salvar referência">
          <div class="nav-panel-head">
            <h2>${alvo.tipo === 'imagem' ? 'Salvar imagem' : 'Salvar referência'}</h2>
            <${IconButton} icon="x" label="Fechar" onClick=${() => setAlvo(null)} />
          </div>
          ${bloqueado
            ? html`<p class="nav-panel-msg">${ref.motivo === 'plano' ? 'As Referências fazem parte do plano Produtora.' : 'Entre na conta SOBEDESCE no app para salvar referências.'}</p>`
            : html`<${SalvarReferencia}
                key=${alvo.chave || alvo.url || alvo.imagemUrl}
                alvo=${alvo}
                origem="navegador"
                rotulo="Salvar"
                onSalvo=${() => {}}
              />`}
          <${Recentes} lista=${recentes} />
          <p class="nav-panel-foot">Salve só para referência dos seus projetos. Respeite os direitos de quem criou.</p>
        </aside>`
      : null}
    <${Toasts} />
  </div>`
}

render(html`<${App} />`, document.getElementById('app'))
start()
