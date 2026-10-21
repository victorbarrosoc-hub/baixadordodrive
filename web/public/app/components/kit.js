// Kit visual do celular: as mesmas peças do app do computador (public/components/kit.js, docs/UI-KIT.md) em tamanho
// de celular — uma coluna, gutter de 16 px, alvos de 44 px, cabe em folha. Estilos `k-*` no fim do app.css.
import { html } from '../vendor/preact-htm.js'
import { Icon } from './icons.js'
import { cx } from './ui.js'

/** Cabeçalho de tela (aba): título grande, frase curta e ações à direita. */
export function Pagina({ titulo, frase, acoes, class: klass, children }) {
  return html`<div class=${cx('k-pagina', klass)}>
    <header class="k-cabeca k-entra" style="--i:0">
      <div class="k-cabeca-txt">
        <h1>${titulo}</h1>
        ${frase ? html`<p>${frase}</p>` : null}
      </div>
      ${acoes ? html`<div class="k-cabeca-acoes">${acoes}</div>` : null}
    </header>
    ${children}
  </div>`
}

/** Bloco numerado (fluxo com ordem) ou com ícone (seção). `i` = ordem da entrada em cascata. */
export function Passo({ n, icone, cor, titulo, sub, frase, acao, i = 1, class: klass, children }) {
  return html`<section class=${cx('k-passo k-entra', klass)} style=${`--i:${i}`} aria-label=${titulo}>
    <div class="k-passo-cabeca">
      ${icone
        ? html`<span class="k-n is-icone" style=${cor ? `--c:var(--${cor})` : null}><${Icon} name=${icone} size=${16} strokeWidth=${1.9} /></span>`
        : n != null
          ? html`<span class="k-n">${n}</span>`
          : null}
      <div class="k-passo-tit">
        <h2>${titulo}${sub ? html`<small>${sub}</small>` : null}</h2>
        ${frase ? html`<p>${frase}</p>` : null}
      </div>
      ${acao ? html`<div class="k-passo-acao">${acao}</div>` : null}
    </div>
    ${children}
  </section>`
}

/** Opções em cartões com o check. itens: [{ value, titulo, sub?, icone?, up? }] */
export function Opcoes({ valor, itens, onEscolher, colunas, label }) {
  return html`<div class="k-opcoes" role="radiogroup" aria-label=${label} data-n=${colunas || Math.min(itens.length, 3)} style=${`--n:${colunas || Math.min(itens.length, 3)}`}>
    ${itens.map(
      (o) => html`<button
        type="button"
        role="radio"
        aria-checked=${o.value === valor ? 'true' : 'false'}
        class=${cx('k-opcao', o.value === valor && 'is-on', o.up && 'is-up')}
        disabled=${o.disabled}
        onClick=${() => onEscolher?.(o.value)}
      >
        ${o.icone ? html`<span class="k-opcao-ic"><${Icon} name=${o.icone} size=${17} strokeWidth=${1.9} /></span>` : null}
        <b>${o.titulo}</b>
        ${o.sub ? html`<span>${o.sub}</span>` : null}
        <span class="k-opcao-ok" aria-hidden="true"><${Icon} name="check" size=${12} strokeWidth=${2.6} /></span>
      </button>`,
    )}
  </div>`
}

/** Pílulas (uma escolhida). itens: [{ value, label, conta? }] */
export function Pilulas({ valor, itens, onEscolher, label, rolar = false }) {
  return html`<div class=${cx('k-pilulas', rolar && 'is-rolar')} role="radiogroup" aria-label=${label}>
    ${itens.map(
      (o) => html`<button type="button" role="radio" aria-checked=${o.value === valor ? 'true' : 'false'} class=${cx('k-pilula', o.value === valor && 'is-on')} onClick=${() => onEscolher?.(o.value)}>
        ${o.label}${o.conta ? html`<span class="k-conta">${o.conta}</span>` : null}
      </button>`,
    )}
  </div>`
}

/** Cartão colorido com o número grande. tom: 'grad' | 'up' | 'down' | 'ok' | 'erro'. `vivo` = brilho passando. */
export function Destaque({ titulo, numero, unidade, linha, progresso, tom = 'grad', vivo = false, class: klass, children }) {
  return html`<div class=${cx('k-destaque', tom !== 'grad' && `is-${tom}`, vivo && 'is-vivo', klass)}>
    ${titulo ? html`<span class="k-destaque-tit">${titulo}</span>` : null}
    ${numero != null ? html`<div class="k-destaque-num"><b>${numero}</b>${unidade ? html`<span>${unidade}</span>` : null}</div>` : null}
    ${progresso != null ? html`<${Barra} p=${progresso} vivo=${vivo} />` : null}
    ${linha ? html`<span class="k-destaque-linha">${linha}</span>` : null}
    ${children}
  </div>`
}

/** Blocos de número. itens: [{ icone?, valor, rotulo, tom? }] */
export function Stats({ itens, colunas }) {
  return html`<div class="k-stats" data-n=${colunas || itens.length} style=${`--n:${colunas || itens.length}`}>
    ${itens.map(
      (s) => html`<div class=${cx('k-stat', s.tom && s.tom !== 'down' && `is-${s.tom}`)}>
        ${s.icone ? html`<span class="k-stat-ic"><${Icon} name=${s.icone} size=${14} strokeWidth=${2} /></span>` : null}
        <b>${s.valor}</b>
        <span>${s.rotulo}</span>
      </div>`,
    )}
  </div>`
}

/** Barra de progresso (0–1; null = indeterminada). */
export function Barra({ p, tom, vivo = false, label }) {
  const pct = p == null ? 100 : Math.max(0, Math.min(1, p)) * 100
  return html`<div class=${cx('k-barra', tom && `is-${tom}`, (vivo || p == null) && 'is-vivo')} role="progressbar" aria-label=${label} aria-valuenow=${p == null ? undefined : Math.round(pct)} aria-valuemin="0" aria-valuemax="100">
    <i style=${`width:${pct}%`}></i>
  </div>`
}

/** Linhas de ajuste dentro de um Passo. */
export function Linhas({ children }) {
  return html`<div class="k-linhas">${children}</div>`
}
export function Linha({ titulo, sub, icone, cor, onClick, children }) {
  const conteudo = html`
    ${icone ? html`<span class="k-linha-ic" style=${cor ? `--c:var(--${cor})` : null}><${Icon} name=${icone} size=${17} strokeWidth=${1.8} /></span>` : null}
    <span class="k-linha-txt"><b>${titulo}</b>${sub ? html`<span>${sub}</span>` : null}</span>
    <span class="k-linha-ctl">${children}${onClick ? html`<${Icon} name="chevron-right" size=${16} class="k-seta" />` : null}</span>`
  return onClick ? html`<button type="button" class="k-linha is-botao" onClick=${onClick}>${conteudo}</button>` : html`<div class="k-linha">${conteudo}</div>`
}

/** Item de lista (aparelho, coleção, lote). Com onClick vira botão. tom = cor do ícone. */
export function Item({ icone, tom = 'down', titulo, sub, fim, on = false, onClick, label, disabled, class: klass, children }) {
  const conteudo = html`
    ${icone ? html`<span class="k-item-ic"><${Icon} name=${icone} size=${19} strokeWidth=${1.8} /></span>` : null}
    <span class="k-item-txt"><b>${titulo}</b>${sub ? html`<span>${sub}</span>` : null}${children}</span>
    ${fim ? html`<span class="k-item-fim">${fim}</span>` : null}`
  const estilo = `--c:var(--${tom === 'erro' ? 'err' : tom})`
  return onClick
    ? html`<button type="button" class=${cx('k-item', on && 'is-on', klass)} style=${estilo} onClick=${onClick} disabled=${disabled} aria-label=${label}>${conteudo}</button>`
    : html`<div class=${cx('k-item', on && 'is-on', klass)} style=${estilo}>${conteudo}</div>`
}

/** O botão principal da tela (gradiente azul→violeta, 54 px). */
export function BotaoGrande({ icone, children, dica, class: klass, ...rest }) {
  return html`<button type="button" class=${cx('k-botao', klass)} ...${rest}>
      ${icone ? html`<${Icon} name=${icone} size=${19} strokeWidth=${2} />` : null}<span>${children}</span>
    </button>
    ${dica ? html`<p class="k-botao-dica">${dica}</p>` : null}`
}

/** Estado vazio com o desenho que respira. */
export function Vazio({ icone = 'sparkle', titulo, children, acoes }) {
  return html`<div class="k-vazio k-entra" style="--i:1">
    <div class="k-vazio-arte" aria-hidden="true"><span class="k-vazio-ic"><${Icon} name=${icone} size=${24} strokeWidth=${1.8} /></span></div>
    <h3>${titulo}</h3>
    ${children ? html`<p>${children}</p>` : null}
    ${acoes ? html`<div class="k-vazio-acoes">${acoes}</div>` : null}
  </div>`
}

/** Rótulo pequeno em caixa alta (antes de um grupo). */
export function Rotulo({ children, acao }) {
  return html`<div class="k-rotulo"><span>${children}</span>${acao || null}</div>`
}
