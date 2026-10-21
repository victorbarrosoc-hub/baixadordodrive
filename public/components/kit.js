// Kit visual das telas (docs/UI-KIT.md, estilos em /kit.css): as peças de Frames, Cartões e Início para todas as telas.
import { html } from '/vendor/preact-htm.js'
import { Icon } from './icons.js'
import { cx } from '../lib/ui.js'

/** Página: título, frase e ações no topo; `lado` vira a coluna da direita (resumo e botão grande). */
export function Pagina({ titulo, frase, acoes, lado, larga = false, class: klass, children }) {
  return html`<div class=${cx('page k-pagina', klass)}>
    <header class="k-cabeca k-entra" style="--i:0">
      <div>
        <h1>${titulo}</h1>
        ${frase ? html`<p>${frase}</p>` : null}
      </div>
      ${acoes ? html`<div class="k-cabeca-acoes">${acoes}</div>` : null}
    </header>
    ${lado
      ? html`<div class=${cx('k-colunas', larga && 'is-larga')}>
          <div class="k-principal">${children}</div>
          <aside class="k-lado k-entra" style="--i:2">${lado}</aside>
        </div>`
      : html`<div class="k-principal">${children}</div>`}
  </div>`
}

/** Passo numerado (ou com ícone): o bloco de cada tela. `i` = ordem da entrada em cascata. */
export function Passo({ n, icone, cor, titulo, sub, frase, acao, i = 1, id, class: klass, children }) {
  return html`<section class=${cx('k-passo k-entra', klass)} style=${`--i:${i}`} id=${id} aria-label=${titulo}>
    <div class="k-passo-cabeca">
      ${icone
        ? html`<span class="k-n is-icone" style=${cor ? `--c:var(--${cor})` : null}><${Icon} name=${icone} size=${16} strokeWidth=${1.8} /></span>`
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

/** Opções em cartões (uma escolhida). itens: [{ value, titulo, sub?, icone?, selo?, up?, disabled? }] */
export function Opcoes({ valor, itens, onEscolher, colunas, label }) {
  return html`<div class="k-opcoes" role="radiogroup" aria-label=${label} style=${`--n:${colunas || Math.min(itens.length, 4)}`}>
    ${itens.map(
      (o) => html`<button
        type="button"
        role="radio"
        aria-checked=${o.value === valor ? 'true' : 'false'}
        class=${cx('k-opcao', o.value === valor && 'is-on', o.up && 'is-up')}
        disabled=${o.disabled}
        onClick=${() => onEscolher?.(o.value)}
      >
        ${o.icone ? html`<span class="k-opcao-ic"><${Icon} name=${o.icone} size=${17} strokeWidth=${1.8} /></span>` : null}
        <b>${o.titulo}</b>
        ${o.sub ? html`<span>${o.sub}</span>` : null}
        ${o.selo && o.value !== valor ? html`<span class="k-selo">${o.selo}</span>` : null}
        <span class="k-opcao-ok" aria-hidden="true"><${Icon} name="check" size=${12} strokeWidth=${2.4} /></span>
      </button>`,
    )}
  </div>`
}

/** Pílulas (uma escolhida). itens: [{ value, label, conta? }] */
export function Pilulas({ valor, itens, onEscolher, label }) {
  return html`<div class="k-pilulas" role="radiogroup" aria-label=${label}>
    ${itens.map(
      (o) => html`<button type="button" role="radio" aria-checked=${o.value === valor ? 'true' : 'false'} class=${cx('k-pilula', o.value === valor && 'is-on')} onClick=${() => onEscolher?.(o.value)}>
        ${o.label}${o.conta != null ? html`<span class="k-conta">${o.conta}</span>` : null}
      </button>`,
    )}
  </div>`
}

/** Cartão colorido com o número grande. tom: 'grad' | 'ok' | 'erro'. `vivo`: brilho passando (algo andando). */
export function Destaque({ titulo, numero, unidade, linha, progresso, tom = 'grad', vivo = false, children }) {
  return html`<div class=${cx('k-destaque', tom === 'ok' && 'is-ok', tom === 'erro' && 'is-erro', vivo && 'is-vivo')}>
    ${titulo ? html`<span class="k-destaque-tit">${titulo}</span>` : null}
    ${numero != null ? html`<div class="k-destaque-num"><b>${numero}</b>${unidade ? html`<span>${unidade}</span>` : null}</div>` : null}
    ${progresso != null ? html`<${Barra} p=${progresso} vivo=${vivo} />` : null}
    ${linha ? html`<span class="k-destaque-linha">${linha}</span>` : null}
    ${children}
  </div>`
}

/** Painel lateral com título pequeno em caixa alta. */
export function Resumo({ titulo, children }) {
  return html`<div class="k-resumo">
    ${titulo ? html`<p class="k-resumo-tit">${titulo}</p>` : null}
    ${children}
  </div>`
}

/** Blocos de número. itens: [{ icone, valor, rotulo, tom? ('down'|'up'|'ok'|'warn'|'erro'|'neutro') }]. `compacto`: coluna lateral. */
export function Stats({ itens, colunas, compacto = false }) {
  return html`<div class=${cx('k-stats', compacto && 'is-compacto')} style=${`--n:${colunas || itens.length}`}>
    ${itens.map(
      (s) => html`<div class=${cx('k-stat', s.tom && s.tom !== 'down' && `is-${s.tom}`)}>
        ${s.icone ? html`<span class="k-stat-ic"><${Icon} name=${s.icone} size=${15} strokeWidth=${1.9} /></span>` : null}
        <b>${s.valor}</b>
        <span>${s.rotulo}</span>
      </div>`,
    )}
  </div>`
}

/** Barra de progresso (0–1 ou null = indeterminada). */
export function Barra({ p, tom, vivo = false, label }) {
  const pct = p == null ? 100 : Math.max(0, Math.min(1, p)) * 100
  return html`<div class=${cx('k-barra', tom === 'ok' && 'is-ok', tom === 'erro' && 'is-erro', (vivo || p == null) && 'is-vivo')} role="progressbar" aria-label=${label} aria-valuenow=${p == null ? undefined : Math.round(pct)} aria-valuemin="0" aria-valuemax="100">
    <i style=${`--p:${pct}%`}></i>
  </div>`
}

/** Linhas de ajuste: cada uma com texto à esquerda e o controle à direita. */
export function Linhas({ children }) {
  return html`<div class="k-linhas">${children}</div>`
}
export function Linha({ titulo, sub, children }) {
  return html`<div class="k-linha">
    <div class="k-linha-txt"><b>${titulo}</b>${sub ? html`<span>${sub}</span>` : null}</div>
    <div class="k-linha-ctl">${children}</div>
  </div>`
}

/** Item de lista (aparelho, coleção, lote). Com onClick vira botão. tom = cor do ícone. */
export function Item({ icone, tom = 'down', titulo, sub, fim, on = false, onClick, disabled, children }) {
  const conteudo = html`
    ${icone ? html`<span class="k-item-ic"><${Icon} name=${icone} size=${19} strokeWidth=${1.8} /></span>` : null}
    <span class="k-item-txt"><b>${titulo}</b>${sub ? html`<span>${sub}</span>` : null}${children}</span>
    ${fim ? html`<span class="k-item-fim">${fim}</span>` : null}`
  const estilo = `--c:var(--${tom === 'erro' ? 'err' : tom})`
  return onClick
    ? html`<button type="button" class=${cx('k-item', on && 'is-on')} style=${estilo} onClick=${onClick} disabled=${disabled} aria-pressed=${on ? 'true' : 'false'}>${conteudo}</button>`
    : html`<div class=${cx('k-item', on && 'is-on')} style=${estilo}>${conteudo}</div>`
}

/** O botão grande da tela (gradiente). */
export function BotaoGrande({ icone, children, dica, cheio = true, ...rest }) {
  return html`<button type="button" class=${cx('k-botao', cheio && 'is-cheio')} ...${rest}>
      ${icone ? html`<${Icon} name=${icone} size=${18} strokeWidth=${1.9} />` : null}${children}
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

/**
 * Gráfico de velocidade (área + linha), em SVG. pontos: [{ down, up }] (bytes/s), do mais antigo ao mais novo.
 * Escala pelo maior valor (mínimo `piso`).
 */
export function GraficoVelocidade({ pontos, piso = 5e6, altura = 120, label = 'Velocidade nos últimos minutos' }) {
  const n = Math.max(2, pontos.length)
  const max = Math.max(piso, ...pontos.map((p) => Math.max(p.down || 0, p.up || 0)))
  const x = (i) => (i / (n - 1)) * 100
  const y = (v) => altura - 4 - (Math.max(0, v) / max) * (altura - 12)
  const linha = (k) => pontos.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(p[k] || 0).toFixed(2)}`).join(' ')
  const area = (k) => (pontos.length ? `${linha(k)} L${x(pontos.length - 1).toFixed(2)},${altura} L0,${altura} Z` : '')
  // Série toda em zero (só sobe ou só desce) não vira linha reta no fundo: só aparece se andou alguma vez.
  const tem = (k) => pontos.some((p) => (p[k] || 0) > 0)
  const series = pontos.length ? ['down', 'up'].filter((k) => tem(k) || !tem(k === 'down' ? 'up' : 'down')) : []
  return html`<svg class="k-grafico" viewBox=${`0 0 100 ${altura}`} preserveAspectRatio="none" role="img" aria-label=${label} style=${`height:${altura}px`}>
    ${series.map((k) => html`<path class=${`k-area is-${k}`} d=${area(k)} />`)}
    ${series.map((k) => html`<path class=${`k-linha-g is-${k}`} d=${linha(k)} vector-effect="non-scaling-stroke" />`)}
  </svg>`
}
