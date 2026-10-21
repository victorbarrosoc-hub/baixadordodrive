// Celular ↔ computador (e celular ↔ celular) pelo Wi-Fi (docs/CELULAR-WIFI.md, lib/p2p.js): o bloco "Mandar para…"
// no Início (aparelhos da conta e, embaixo, outras pessoas por perto), a folha do envio, a folha do que alguém quer
// mandar (aceitar, andamento, salvar) e a chave "Aceitar de outras pessoas por perto".
import { html, useState } from '../vendor/preact-htm.js'
import { bytes, percent, plural, speed } from '../lib/format.js'
import { closeSheet, openSheet, useApp } from '../lib/state.js'
import { aceitarOferta, cancelarEnvio, cancelarRecebimento, fecharRecebimento, limparEnvio, mandarPara, p2pAndando, quemManda, recusarOferta, salvar, setAceitarOutros } from '../lib/p2p.js'
import { Icon } from './icons.js'
import { Button, SheetHead, cx } from './ui.js'
import { BotaoGrande, Destaque, Item, Linhas, Rotulo } from './kit.js'

const pctW = (f) => `${(Math.max(0, Math.min(1, f)) * 100).toFixed(2)}%`
const primeiro = (nome) => String(nome || '').trim().split(/\s+/)[0]
const icone = (a) => (a?.conta === 'outra' ? 'user' : a?.tipo === 'celular' ? 'phone' : 'laptop')
/** "MacBook de Victor" (da conta) ou "Ana" (outra pessoa). */
const titulo = (a) => (a?.conta === 'outra' && a.dono ? primeiro(a.dono) : a?.nome || 'Aparelho')

/** O que dizer em cada fase (o envio espera o computador da conta ou alguém tocar em Aceitar). */
function faseTexto(t, alvo) {
  if (t.fase === 'conectando') return 'Conectando no Wi-Fi…'
  if (t.fase === 'esperando') return alvo && (alvo.tipo === 'celular' || alvo.conta === 'outra') ? `Esperando ${titulo(alvo)} aceitar…` : 'Esperando o computador…'
  if (t.fase === 'pronto') return 'Pronto'
  if (t.fase === 'erro') return 'Não passou'
  if (t.fase === 'cancelado') return 'Cancelado'
  return ''
}

/** O andamento de um envio ou recebimento: o cartão colorido com a %, a barra, o arquivo e a velocidade. */
function Andamento({ t, nomes, tom, alvo }) {
  const frac = t.total ? t.bytes / t.total : t.fase === 'pronto' ? 1 : 0
  const nomeAtual = nomes?.[t.atual || 0]
  const n = nomes?.length || 0
  const andando = t.fase === 'andando'
  const cor = t.fase === 'erro' || t.fase === 'cancelado' ? 'erro' : t.fase === 'pronto' ? 'ok' : tom
  return html`<${Destaque}
    class=${cx('p2p-andamento', `is-${t.fase}`)}
    tom=${cor}
    vivo=${andando}
    titulo=${andando ? (n > 1 ? `${(t.atual || 0) + 1} de ${n} arquivos` : 'Passando') : faseTexto(t, alvo) || 'Pronto'}
    numero=${t.fase === 'pronto' ? '100%' : andando ? percent(frac) : null}
    progresso=${t.fase === 'conectando' || t.fase === 'esperando' ? null : frac}
  >
    <span class="k-destaque-linha"><span class="p2p-nome">${andando && nomeAtual ? nomeAtual : plural(n, 'arquivo', 'arquivos')}</span><span>${bytes(t.bytes || 0)} de ${bytes(t.total || 0)}</span></span>
    ${andando ? html`<span class="k-destaque-linha"><span>${t.velocidade ? speed(t.velocidade) : 'Começando…'}</span></span>` : null}
  </${Destaque}>`
}

function ManterAberta() {
  return html`<p class="p2p-dica"><${Icon} name="info" size=${15} /> Mantenha esta tela aberta até terminar.</p>`
}

/** "Aceitar de outras pessoas por perto": no Início (embaixo da lista) e em Ajustes. */
export function AceitarOutros() {
  const on = useApp((s) => s.p2p.outros)
  return html`<div class="p2p-outros">
    <${Linhas}>
      <button type="button" class="k-linha is-botao" role="switch" aria-checked=${on ? 'true' : 'false'} onClick=${() => setAceitarOutros(!on)}>
        <span class="k-linha-ic" style="--c:var(--warn)"><${Icon} name="users" size=${17} strokeWidth=${1.8} /></span>
        <span class="k-linha-txt">
          <b>Aceitar de outras pessoas por perto</b>
          <span>${on ? 'Quem usa a SOBEDESCE no mesmo Wi-Fi vê este celular e pode pedir para mandar. Nada chega sem você tocar em Aceitar.' : 'Desligado: só os seus aparelhos veem este celular.'}</span>
        </span>
        <span class="k-linha-ctl"><span class=${cx('switch', on && 'is-on')} aria-hidden="true"><span></span></span></span>
      </button>
    </${Linhas}>
  </div>`
}

// ───── Início ─────

export function LinhaAparelho({ a, onEscolher }) {
  const outra = a.conta === 'outra'
  return html`<${Item}
    icone=${icone(a)}
    tom=${outra ? 'warn' : a.tipo === 'celular' ? 'up' : 'down'}
    titulo=${titulo(a)}
    sub=${outra ? a.nome : a.mesmaRede ? html`<span class="p2p-rede">● na mesma rede</span>` : 'Ligado agora'}
    fim=${html`<span class="p2p-enviar" aria-hidden="true"><${Icon} name="upload" size=${15} strokeWidth=${2.2} />Enviar</span>`}
    label=${`Enviar arquivos para ${outra ? `${titulo(a)}, ${a.nome}` : a.nome}`}
    onClick=${() => onEscolher(a.id)}
  />`
}

/** O que está passando agora: o pedido ou o recebimento e o envio, cada um uma linha que abre a folha. */
export function LinhasAgora() {
  const { envio, recebimento } = useApp((s) => s.p2p)
  return html`${recebimento
      ? html`<${Item}
          class="p2p-linha"
          icone="download"
          tom="down"
          on=${recebimento.fase === 'pedido'}
          titulo=${recebimento.fase === 'pedido' ? `${quemManda(recebimento.de)} quer mandar arquivos` : `De ${quemManda(recebimento.de)}`}
          sub=${recebimento.fase === 'pedido' ? 'Toque para ver' : recebimento.fase === 'pronto' ? `${plural(recebimento.recebidos?.length || 0, 'arquivo', 'arquivos')} para salvar` : recebimento.fase === 'andando' ? `${percent(recebimento.total ? recebimento.bytes / recebimento.total : 0)} · ${speed(recebimento.velocidade || 0)}` : faseTexto(recebimento)}
          fim=${html`<${Icon} name="chevron-right" size=${16} strokeWidth=${2} />`}
          onClick=${() => openSheet('p2pReceber')}
        />`
      : null}
    ${envio
      ? html`<${Item}
          class="p2p-linha"
          icone="upload"
          tom="up"
          titulo=${`Para ${titulo(envio.para)}`}
          sub=${envio.fase === 'andando' ? `${percent(envio.total ? envio.bytes / envio.total : 0)} · ${speed(envio.velocidade || 0)}` : faseTexto(envio, envio.para)}
          fim=${html`<${Icon} name="chevron-right" size=${16} strokeWidth=${2} />`}
          onClick=${() => openSheet('p2pEnvio')}
        />`
      : null}`
}

/** No Início, só o que está passando no Wi-Fi (mandar e receber ficam na aba Aparelhos). */
export function P2pAndamentoCompacto() {
  const { envio, recebimento } = useApp((s) => s.p2p)
  if (!(envio && p2pAndando(envio.fase)) && !(recebimento && (p2pAndando(recebimento.fase) || recebimento.fase === 'pedido'))) return null
  return html`<section class="p2p-bloco k-itens" aria-label="No Wi-Fi"><${LinhasAgora} /></section>`
}

/** Algo para a aba Aparelhos chamar atenção: alguém pedindo para mandar ou arquivo passando. */
export function useP2pAviso() {
  const { envio, recebimento } = useApp((s) => s.p2p)
  if (recebimento?.fase === 'pedido') return 'pedido'
  if ((envio && p2pAndando(envio.fase)) || (recebimento && p2pAndando(recebimento.fase))) return 'andando'
  return null
}

/** Não conectou: onde ligar (Mac sem Rede Local) e a linha técnica para mandar no print. */
function PorQue({ dica, detalhe }) {
  if (!dica && !detalhe) return null
  return html`${dica ? html`<p class="p2p-dica"><${Icon} name="info" size=${15} /> ${dica}</p>` : null}
    ${detalhe ? html`<p class="p2p-detalhe">${detalhe}</p>` : null}`
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
      <${PorQue} dica=${envio.dica} detalhe=${envio.detalhe} />
      ${andando ? html`<${ManterAberta} />` : null}
      <div class="p2p-acoes">
        ${andando
          ? html`<${Button} variant="secondary" onClick=${() => cancelarEnvio()}>Cancelar</${Button}>`
          : html`<${BotaoGrande} icone="check" onClick=${fechar}>OK</${BotaoGrande}>`}
      </div>
    </div>`
}
P2pEnvioSheet.label = 'Mandar para outro aparelho'

// ───── folha do recebimento ─────

function Arquivo({ a }) {
  const [salvando, setSalvando] = useState(false)
  const ic = /^image\//.test(a.tipo) ? 'photo' : /^video\//.test(a.tipo) ? 'film' : 'doc'
  return html`<${Item}
    class="p2p-arq"
    icone=${ic}
    tom="ok"
    titulo=${a.nome}
    sub=${bytes(a.tamanho)}
    fim=${html`<${Button}
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
      }}>Salvar</${Button}>`}
  />`
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
          <${BotaoGrande} icone="download" onClick=${() => aceitarOferta()}>Aceitar</${BotaoGrande}>
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
      <${PorQue} dica=${r.dica} detalhe=${r.detalhe} />
      ${andando ? html`<${ManterAberta} />` : null}
      ${r.fase === 'pronto' && recebidos.length
        ? html`<${Rotulo}>Chegou</${Rotulo}>
            <div class="k-itens">${recebidos.map((a) => html`<${Arquivo} key=${a.i} a=${a} />`)}</div>
            <p class="group-foot">Salvar abre as opções do celular: Salvar em Fotos, em Arquivos ou mandar para um app. Ao fechar, a cópia some daqui.</p>`
        : null}
      <div class="p2p-acoes">
        ${andando
          ? html`<${Button} variant="secondary" onClick=${() => cancelarRecebimento()}>Cancelar</${Button}>`
          : r.fase === 'pronto' && recebidos.length > 1
            ? html`<${BotaoGrande} icone="download" onClick=${() => salvar(recebidos.map((a) => a.file))}>Salvar todos</${BotaoGrande}>`
            : html`<${Button} variant=${r.fase === 'pronto' ? 'secondary' : 'primary'} onClick=${fechar}>Fechar</${Button}>`}
      </div>
    </div>`
}
P2pReceberSheet.label = 'Arquivos recebidos'
P2pReceberSheet.tall = true
