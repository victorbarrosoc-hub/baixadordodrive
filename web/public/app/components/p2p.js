// Celular ↔ computador (e celular ↔ celular) pelo Wi-Fi (docs/CELULAR-WIFI.md, lib/p2p.js): o bloco "Mandar para…"
// no Início (aparelhos da conta e, embaixo, outras pessoas por perto), a folha do envio, a folha do que alguém quer
// mandar (aceitar, andamento, salvar) e a chave "Aceitar de outras pessoas por perto".
import { html, useRef, useState } from '../vendor/preact-htm.js'
import { bytes, percent, plural, speed } from '../lib/format.js'
import { closeSheet, openSheet, useApp } from '../lib/state.js'
import { aceitarOferta, cancelarEnvio, cancelarRecebimento, fecharRecebimento, limparEnvio, mandarPara, p2pAndando, quemManda, recusarOferta, salvar, setAceitarOutros } from '../lib/p2p.js'
import { Icon } from './icons.js'
import { Button, SheetHead, cx } from './ui.js'

const pctW = (f) => `${(Math.max(0, Math.min(1, f)) * 100).toFixed(2)}%`
const primeiro = (nome) => String(nome || '').trim().split(/\s+/)[0]
const icone = (a) => (a?.conta === 'outra' ? 'user' : a?.tipo === 'celular' ? 'phone' : 'laptop')
/** "MacBook de Victor" (da conta) ou "Ana" (outra pessoa). */
const titulo = (a) => (a?.conta === 'outra' && a.dono ? primeiro(a.dono) : a?.nome || 'Aparelho')

function Barra({ frac, tom = 'up', label }) {
  return html`<div class=${cx('pc-bar', `tone-${tom}`)} role="progressbar" aria-label=${label} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(frac * 100)}>
    <span style=${`width:${pctW(frac)}`}></span>
  </div>`
}

/** O que dizer em cada fase (o envio espera o computador da conta ou alguém tocar em Aceitar). */
function faseTexto(t, alvo) {
  if (t.fase === 'conectando') return 'Conectando no Wi-Fi…'
  if (t.fase === 'esperando') return alvo && (alvo.tipo === 'celular' || alvo.conta === 'outra') ? `Esperando ${titulo(alvo)} aceitar…` : 'Esperando o computador…'
  if (t.fase === 'pronto') return 'Pronto'
  if (t.fase === 'erro') return 'Não passou'
  if (t.fase === 'cancelado') return 'Cancelado'
  return ''
}

/** O andamento de um envio ou recebimento: nome do arquivo, barra, quanto e a velocidade. */
function Andamento({ t, nomes, tom, alvo }) {
  const frac = t.total ? t.bytes / t.total : t.fase === 'pronto' ? 1 : 0
  const nomeAtual = nomes?.[t.atual || 0]
  const n = nomes?.length || 0
  const andando = t.fase === 'andando'
  return html`<div class=${cx('group pc-summary p2p-andamento', `is-${t.fase}`)}>
    <div class="pc-summary-top">
      <span class="pc-summary-pct">${t.fase === 'pronto' ? '100%' : andando ? percent(frac) : faseTexto(t, alvo)}</span>
      ${andando ? html`<span class="pc-summary-state">${n > 1 ? `${(t.atual || 0) + 1} de ${n}` : ''}</span>` : null}
    </div>
    <${Barra} frac=${frac} tom=${t.fase === 'erro' ? 'err' : t.fase === 'pronto' ? 'ok' : tom} label=${`${percent(frac)}`} />
    <div class="pc-summary-nums">
      <span class="p2p-nome">${andando && nomeAtual ? nomeAtual : plural(n, 'arquivo', 'arquivos')}</span>
      <span>${bytes(t.bytes || 0)} de ${bytes(t.total || 0)}</span>
    </div>
    ${andando ? html`<div class="pc-summary-nums is-live"><span>${t.velocidade ? speed(t.velocidade) : 'Começando…'}</span><span></span></div>` : null}
  </div>`
}

function ManterAberta() {
  return html`<p class="p2p-dica"><${Icon} name="info" size=${15} /> Mantenha esta tela aberta até terminar.</p>`
}

/** "Aceitar de outras pessoas por perto": no Início (embaixo da lista) e em Ajustes. */
export function AceitarOutros() {
  const on = useApp((s) => s.p2p.outros)
  return html`<div class="group pc-push p2p-outros">
    <button type="button" class="pc-push-row" role="switch" aria-checked=${on ? 'true' : 'false'} onClick=${() => setAceitarOutros(!on)}>
      <span class="pc-push-icon" aria-hidden="true"><${Icon} name="users" size=${19} /></span>
      <span class="pc-push-text">Aceitar de outras pessoas por perto</span>
      <span class=${cx('switch', on && 'is-on')} aria-hidden="true"><span></span></span>
    </button>
    <p class="pc-push-help">${on
      ? 'Quem usa a SOBEDESCE no mesmo Wi-Fi vê este celular e pode pedir para mandar arquivos. Nada chega sem você tocar em Aceitar.'
      : 'Desligado: só os seus aparelhos veem este celular.'}</p>
  </div>`
}

// ───── Início ─────

function LinhaAparelho({ a, onEscolher }) {
  const outra = a.conta === 'outra'
  return html`<li>
    <button type="button" onClick=${() => onEscolher(a.id)} aria-label=${`Mandar para ${outra ? `${titulo(a)}, ${a.nome}` : a.nome}`}>
      <span class=${cx('p2p-ico', outra && 'is-pessoa')}><${Icon} name=${icone(a)} size=${17} /></span>
      <span class="ini-pasta-txt">
        <b>${titulo(a)}</b>
        <span>${outra ? a.nome : a.mesmaRede ? html`<span class="p2p-rede">● na mesma rede</span>` : 'Ligado agora'}</span>
      </span>
      <${Icon} name="chevron-right" size=${15} strokeWidth=${2} class="ini-pasta-ir" />
    </button>
  </li>`
}

/** "Mandar para…": os aparelhos ligados agora. Escolher um abre a escolha de arquivos. */
export function MandarComputador({ i = 6, compacto = false }) {
  const { aparelhos, envio, recebimento } = useApp((s) => s.p2p)
  const input = useRef(null)
  const para = useRef(null)
  const ocupado = envio && p2pAndando(envio.fase)
  const escolher = (id) => {
    if (ocupado) return openSheet('p2pEnvio')
    para.current = id
    input.current.value = ''
    input.current.click()
  }
  const meus = aparelhos.filter((a) => a.conta !== 'outra')
  const outros = aparelhos.filter((a) => a.conta === 'outra')
  const linhaRec =
    recebimento &&
    html`<button type="button" class="p2p-linha" onClick=${() => openSheet('p2pReceber')}>
      <span class="p2p-ico is-down"><${Icon} name="arrow-down" size=${17} strokeWidth=${2.1} /></span>
      <span class="ini-pasta-txt">
        <b>${recebimento.fase === 'pedido' ? `${quemManda(recebimento.de)} quer mandar arquivos` : `De ${quemManda(recebimento.de)}`}</b>
        <span>${recebimento.fase === 'pedido' ? 'Toque para ver' : recebimento.fase === 'pronto' ? `${plural(recebimento.recebidos?.length || 0, 'arquivo', 'arquivos')} para salvar` : recebimento.fase === 'andando' ? `${percent(recebimento.total ? recebimento.bytes / recebimento.total : 0)} · ${speed(recebimento.velocidade || 0)}` : faseTexto(recebimento)}</span>
      </span>
      <${Icon} name="chevron-right" size=${15} strokeWidth=${2} class="ini-pasta-ir" />
    </button>`
  const linhaEnvio =
    envio &&
    html`<button type="button" class="p2p-linha" onClick=${() => openSheet('p2pEnvio')}>
      <span class="p2p-ico is-up"><${Icon} name="arrow-up" size=${17} strokeWidth=${2.1} /></span>
      <span class="ini-pasta-txt">
        <b>Para ${titulo(envio.para)}</b>
        <span>${envio.fase === 'andando' ? `${percent(envio.total ? envio.bytes / envio.total : 0)} · ${speed(envio.velocidade || 0)}` : faseTexto(envio, envio.para)}</span>
      </span>
      <${Icon} name="chevron-right" size=${15} strokeWidth=${2} class="ini-pasta-ir" />
    </button>`
  if (!aparelhos.length && !envio && !recebimento) return null
  if (compacto)
    return html`<section class="ini-recentes p2p-bloco" aria-label="No Wi-Fi">
      <ul>${recebimento ? html`<li>${linhaRec}</li>` : null}${envio ? html`<li>${linhaEnvio}</li>` : null}</ul>
    </section>`
  return html`<section class="ini-recentes p2p-bloco ini-entra" style=${`--i:${i}`} aria-label="Mandar para outro aparelho">
    <h2 class="ini-rotulo">Mandar para…</h2>
    <ul>
      ${recebimento ? html`<li>${linhaRec}</li>` : null}
      ${envio ? html`<li>${linhaEnvio}</li>` : null}
      ${meus.map((a) => html`<${LinhaAparelho} key=${a.id} a=${a} onEscolher=${escolher} />`)}
    </ul>
    ${outros.length
      ? html`<h2 class="ini-rotulo p2p-perto">Por perto</h2>
          <ul>${outros.map((a) => html`<${LinhaAparelho} key=${a.id} a=${a} onEscolher=${escolher} />`)}</ul>`
      : null}
    <${AceitarOutros} />
    <input
      ref=${input}
      type="file"
      multiple
      hidden
      onChange=${(e) => {
        const files = Array.from(e.currentTarget.files || [])
        if (files.length && para.current) mandarPara(para.current, files)
      }}
    />
  </section>`
}

/** Com a fila de envio andando (Início encolhido), só o que está passando no Wi-Fi. */
export function P2pAndamentoCompacto() {
  const { envio, recebimento } = useApp((s) => s.p2p)
  if (!(envio && p2pAndando(envio.fase)) && !(recebimento && (p2pAndando(recebimento.fase) || recebimento.fase === 'pedido'))) return null
  return html`<${MandarComputador} compacto />`
}

// ───── folha do envio ─────

function prontoTexto(envio) {
  const n = plural(envio.arquivos.length, 'arquivo chegou', 'arquivos chegaram')
  const p = envio.para || {}
  if (p.tipo === 'computador' && p.conta !== 'outra') return `${n} no computador, na pasta “SOBEDESCE do celular”.`
  return `${n} ${p.conta === 'outra' ? `para ${titulo(p)}` : `no ${p.nome || 'outro aparelho'}`}.`
}

export function P2pEnvioSheet() {
  const envio = useApp((s) => s.p2p.envio)
  if (!envio) return html`<${SheetHead} title="Mandar" right=${html`<button type="button" class="link-btn is-strong" onClick=${closeSheet}>OK</button>`} />`
  const andando = p2pAndando(envio.fase)
  const fechar = () => {
    if (!andando) limparEnvio()
    closeSheet()
  }
  return html`<${SheetHead}
      title=${`Para ${titulo(envio.para)}`}
      right=${html`<button type="button" class="link-btn is-strong" onClick=${fechar}>${andando ? 'Esconder' : 'OK'}</button>`}
    />
    <div class="sheet-body p2p-sheet">
      <${Andamento} t=${envio} nomes=${envio.arquivos.map((a) => a.nome)} tom="up" alvo=${envio.para} />
      ${envio.fase === 'pronto' ? html`<p class="p2p-ok"><${Icon} name="circle-check" size=${18} /> ${prontoTexto(envio)}</p>` : null}
      ${envio.erro ? html`<p class="p2p-erro" role="alert"><${Icon} name="warning" size=${18} /> ${envio.erro}</p>` : null}
      ${andando ? html`<${ManterAberta} />` : null}
      <div class="p2p-acoes">
        ${andando
          ? html`<${Button} variant="secondary" onClick=${() => cancelarEnvio()}>Cancelar</${Button}>`
          : html`<${Button} variant="primary" onClick=${fechar}>OK</${Button}>`}
      </div>
    </div>`
}
P2pEnvioSheet.label = 'Mandar para outro aparelho'

// ───── folha do recebimento ─────

function Arquivo({ a }) {
  const [salvando, setSalvando] = useState(false)
  return html`<li class="pc-row p2p-arq">
    <span class="pc-row-icon is-ok"><${Icon} name=${/^image\//.test(a.tipo) ? 'photo' : /^video\//.test(a.tipo) ? 'film' : 'doc'} size=${16} /></span>
    <span class="pc-row-main">
      <span class="pc-row-name">${a.nome}</span>
      <span class="pc-row-meta">${bytes(a.tamanho)}</span>
    </span>
    <${Button}
      size="sm"
      variant="secondary"
      loading=${salvando}
      onClick=${async () => {
        setSalvando(true)
        try {
          await salvar(a.file)
        } finally {
          setSalvando(false)
        }
      }}>Salvar</${Button}>
  </li>`
}

export function P2pReceberSheet() {
  const r = useApp((s) => s.p2p.recebimento)
  if (!r) return html`<${SheetHead} title="Recebendo" right=${html`<button type="button" class="link-btn is-strong" onClick=${closeSheet}>OK</button>`} />`
  const de = r.de || {}
  const outra = de.conta === 'outra'
  const quem = quemManda(de)
  const andando = p2pAndando(r.fase)
  const n = Number(r.resumo?.arquivos) || r.lista?.length || 0
  const fechar = () => {
    if (!andando && r.fase !== 'pedido') fecharRecebimento()
    closeSheet()
  }
  if (r.fase === 'pedido') {
    const nomes = Array.isArray(r.resumo?.nomes) ? r.resumo.nomes.slice(0, 5) : []
    return html`<${SheetHead} title=${outra ? 'Alguém por perto' : 'Recebendo'} />
      <div class="sheet-body p2p-sheet">
        <div class=${cx('p2p-pedido', outra && 'is-pessoa')}>
          <span class="p2p-pedido-ico" aria-hidden="true"><${Icon} name=${icone(de)} size=${28} /></span>
          <h3>${quem} quer mandar ${plural(n, 'arquivo', 'arquivos')}</h3>
          <p>${bytes(Number(r.resumo?.bytes) || 0)} · ${outra ? `do ${de.nome || 'aparelho'} de outra conta SOBEDESCE, no mesmo Wi-Fi` : 'direto pelo Wi-Fi'}</p>
          ${nomes.length ? html`<ul class="p2p-nomes">${nomes.map((x, k) => html`<li key=${k}>${x}</li>`)}${n > nomes.length ? html`<li class="is-mais">e mais ${n - nomes.length}</li>` : null}</ul>` : null}
        </div>
        ${outra ? html`<p class="p2p-dica"><${Icon} name="shield" size=${15} /> Só aceite se você conhece ${quem}. Os arquivos ficam neste celular até você salvar.</p>` : null}
        <div class="p2p-acoes is-duas">
          <${Button}
            variant="secondary"
            onClick=${() => {
              recusarOferta()
              closeSheet()
            }}>Recusar</${Button}>
          <${Button} variant="primary" onClick=${() => aceitarOferta()}>Aceitar</${Button}>
        </div>
      </div>`
  }
  const recebidos = r.recebidos || []
  return html`<${SheetHead}
      title=${`De ${quem}`}
      right=${html`<button type="button" class="link-btn is-strong" onClick=${fechar}>${andando ? 'Esconder' : 'Fechar'}</button>`}
    />
    <div class="sheet-body sheet-scroll p2p-sheet">
      <${Andamento} t=${r} nomes=${(r.lista || []).map((a) => a.nome)} tom="down" />
      ${r.erro ? html`<p class="p2p-erro" role="alert"><${Icon} name="warning" size=${18} /> ${r.erro}</p>` : null}
      ${andando ? html`<${ManterAberta} />` : null}
      ${r.fase === 'pronto' && recebidos.length
        ? html`<h3 class="list-label">Chegou</h3>
            <ul class="group pc-rows">${recebidos.map((a) => html`<${Arquivo} key=${a.i} a=${a} />`)}</ul>
            <p class="group-foot">Salvar abre as opções do celular: Salvar em Fotos, em Arquivos ou mandar para um app. Ao fechar, a cópia some daqui.</p>`
        : null}
      <div class="p2p-acoes">
        ${andando
          ? html`<${Button} variant="secondary" onClick=${() => cancelarRecebimento()}>Cancelar</${Button}>`
          : r.fase === 'pronto' && recebidos.length > 1
            ? html`<${Button} variant="primary" icon="download" onClick=${() => salvar(recebidos.map((a) => a.file))}>Salvar todos</${Button}>`
            : html`<${Button} variant=${r.fase === 'pronto' ? 'secondary' : 'primary'} onClick=${fechar}>Fechar</${Button}>`}
      </div>
    </div>`
}
P2pReceberSheet.label = 'Arquivos recebidos'
P2pReceberSheet.tall = true
