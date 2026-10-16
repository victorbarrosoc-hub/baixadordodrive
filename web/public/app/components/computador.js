// "No computador": quanto falta das transferências que ficaram rodando no app SOBEDESCE do computador.
// Cartão no topo da tela Enviar (quando algo anda ou terminou nas últimas 24 h) e a folha com tudo: progresso,
// velocidade, o que está passando agora, o que já passou e "Avisar no celular quando terminar".
import { html, useEffect, useState } from '../vendor/preact-htm.js'
import { bytes, count, percent, plural, speed } from '../lib/format.js'
import { closeSheet, openSheet, toast, useApp } from '../lib/state.js'
import { isIOS } from '../lib/platform.js'
import { ageOf, ago, aprox, disablePush, enablePush, fraction, isRelevant, pushNeedsInstall, pushStatus, pushSupported, watchFast } from '../lib/computador.js'
import { Icon } from './icons.js'
import { SheetHead, cx } from './ui.js'
import { FileName } from './queue.js'

const ATIVOS = new Set(['enviando', 'baixando'])
const pctW = (f) => `${(Math.max(0, Math.min(1, f)) * 100).toFixed(2)}%`

/** Tom da barra: violeta subindo, azul baixando, verde pronto, vermelho com erro, cinza pausado. */
function toneOf(s) {
  if (s.estado === 'concluido') return 'ok'
  if (s.estado === 'erro') return 'err'
  if (s.estado === 'parado') return 'ok'
  if (s.estado === 'pausado') return 'muted'
  if (s.estado === 'baixando') return 'down'
  return 'up'
}

function PcIcon({ plataforma, size = 20 }) {
  return html`<${Icon} name=${plataforma === 'mac' ? 'laptop' : 'monitor'} size=${size} />`
}

function Bar({ frac, tone, label }) {
  return html`<div class=${cx('pc-bar', `tone-${tone}`)} role="progressbar" aria-label=${label} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(frac * 100)}>
    <span style=${`width:${pctW(frac)}`}></span>
  </div>`
}

/** Uma linha de resumo: "5 de 8 arquivos · faltam ~14 min" (o número grande fica em bigLabel). */
function resumo(pc, pcState) {
  const s = pc.snapshot
  const g = s.geral
  const idade = ageOf(pc, pcState)
  const agora = (pcState.agora || Date.now()) + (Date.now() - (pcState.at || Date.now()))
  const ultimo = s.terminados?.[0]?.terminouEm
  if (s.estado === 'concluido') return `${plural(g.feitos, 'arquivo', 'arquivos')} · ${bytes(g.feitoBytes)}${ultimo ? ` · ${ago(agora - ultimo)}` : ''}`
  if (s.estado === 'erro') return `${plural(g.erros, 'arquivo não passou', 'arquivos não passaram')} · ${count(g.feitos)} de ${count(g.total)} prontos`
  if (s.estado === 'parado') {
    const n = (s.terminados || []).filter((t) => agora - t.terminouEm < 24 * 3600e3).length
    return `${plural(n, 'arquivo passou', 'arquivos passaram')} nas últimas 24 h`
  }
  const parts = [`${count(g.feitos)} de ${plural(g.total, 'arquivo', 'arquivos')}`]
  if (!pc.online) parts.push(`sem notícia ${ago(idade)}`)
  else if (s.estado === 'pausado') parts.push('pausado')
  else {
    const eta = aprox(g.eta)
    parts.push(eta ? `faltam ${eta}` : 'calculando…')
  }
  return parts.join(' · ')
}

function bigLabel(s) {
  if (s.estado === 'concluido' || s.estado === 'parado') return 'Pronto'
  if (s.estado === 'erro') return 'Parou'
  return percent(fraction(s))
}

function Dot({ online }) {
  return html`<span class=${cx('pc-dot', online && 'is-on')} aria-label=${online ? 'Ligado' : 'Sem notícia'}></span>`
}

// ───── cartão da tela principal ─────

export function ComputerCard() {
  const pcState = useApp((s) => s.pc)
  const lista = (pcState.computadores || []).filter((pc) => isRelevant(pc, pcState))
  if (!lista.length) return null
  // O que mais interessa primeiro: andando e ligado; depois o mais recente.
  const pc = [...lista].sort((a, b) => Number(ATIVOS.has(b.snapshot.estado) && b.online) - Number(ATIVOS.has(a.snapshot.estado) && a.online))[0]
  const s = pc.snapshot
  const frac = s.estado === 'concluido' || s.estado === 'parado' ? 1 : fraction(s)
  const outros = lista.length - 1
  return html`<button type="button" class=${cx('pc-card', `is-${s.estado}`)} onClick=${() => openSheet('computador')} aria-label=${`No computador: ${pc.nome}. ${resumo(pc, pcState)}. Ver detalhes`}>
    <span class="pc-card-top">
      <span class="pc-card-icon" aria-hidden="true"><${PcIcon} plataforma=${pc.plataforma} size=${18} /></span>
      <span class="pc-card-name">${pc.nome}</span>
      <${Dot} online=${pc.online} />
      ${outros > 0 ? html`<span class="pc-card-more">+${outros}</span>` : null}
      <${Icon} name="chevron-right" size=${15} strokeWidth=${2} class="pc-card-chev" />
    </span>
    <span class="pc-card-main">
      <span class="pc-card-pct">${bigLabel(s)}</span>
      <span class="pc-card-sub">${resumo(pc, pcState)}</span>
    </span>
    <${Bar} frac=${frac} tone=${toneOf(s)} label=${`${percent(frac)} no computador`} />
  </button>`
}

// ───── folha "No computador" ─────

const ITEM_LABEL = { na_fila: 'Na fila', esperando: 'Esperando a internet', pausado: 'Pausado', conferindo: 'Conferindo' }

function ItemRow({ it }) {
  const frac = it.total ? it.feito / it.total : 0
  const sobe = it.direcao === 'sobe'
  const andando = it.estado === 'enviando' || it.estado === 'baixando'
  const meta = andando
    ? `${bytes(it.feito)} de ${bytes(it.total)}${it.velocidade ? ` · ${speed(it.velocidade)}` : ''}`
    : `${ITEM_LABEL[it.estado] || ''}${it.total ? ` · ${bytes(it.total)}` : ''}`
  return html`<li class="pc-row">
    <span class=${cx('pc-row-icon', sobe ? 'is-up' : 'is-down')} aria-label=${sobe ? 'Enviando para o Drive' : 'Baixando do Drive'}>
      <${Icon} name=${sobe ? 'arrow-up' : 'arrow-down'} size=${16} strokeWidth=${2.1} />
    </span>
    <span class="pc-row-main">
      <span class="pc-row-top">
        <${FileName} name=${it.nome} class="pc-row-name" />
        <span class="pc-row-pct">${andando || it.feito ? percent(frac) : ''}</span>
      </span>
      ${it.destino ? html`<span class="pc-row-dest">${sobe ? 'para' : 'em'} ${it.destino}</span>` : null}
      <${Bar} frac=${frac} tone=${andando ? (sobe ? 'up' : 'down') : 'muted'} label=${`${percent(frac)} de ${it.nome}`} />
      <span class="pc-row-meta">${meta}</span>
      ${it.erro ? html`<span class="pc-row-err">${it.erro}</span>` : null}
    </span>
  </li>`
}

function DoneRow({ t, agora }) {
  return html`<li class="pc-row is-done">
    <span class=${cx('pc-row-icon', t.ok ? 'is-ok' : 'is-err')} aria-label=${t.ok ? 'Passou' : 'Não passou'}>
      <${Icon} name=${t.ok ? 'check' : 'x'} size=${16} strokeWidth=${2.2} />
    </span>
    <span class="pc-row-main">
      <span class="pc-row-top">
        <${FileName} name=${t.nome} class="pc-row-name" />
        <span class="pc-row-when">${ago(agora - t.terminouEm)}</span>
      </span>
      <span class="pc-row-meta">${!t.ok ? 'Não passou' : t.direcao === 'sobe' ? 'Enviado' : 'Baixado'}${t.total != null ? ` · ${bytes(t.total)}` : ''}</span>
      ${!t.ok && t.erro ? html`<span class="pc-row-err">${t.erro}</span>` : null}
    </span>
  </li>`
}

function Computer({ pc, pcState }) {
  const s = pc.snapshot
  const g = s.geral
  const frac = s.estado === 'concluido' ? 1 : fraction(s)
  const idade = ageOf(pc, pcState)
  const agora = (pcState.agora || Date.now()) + (Date.now() - (pcState.at || Date.now()))
  const andando = ATIVOS.has(s.estado)
  const eta = aprox(g.eta)
  const estado = !pc.online && (andando || s.estado === 'pausado') ? 'Última notícia' : {
    enviando: 'Enviando para o Drive',
    baixando: 'Baixando do Drive',
    pausado: 'Pausado',
    parado: 'Nada passando agora',
    concluido: 'Tudo pronto',
    erro: 'Parou com erro',
  }[s.estado]
  return html`<section class="pc-block">
    <header class="pc-head">
      <span class="pc-head-icon" aria-hidden="true"><${PcIcon} plataforma=${pc.plataforma} size=${22} /></span>
      <span class="pc-head-text">
        <b>${pc.nome}</b>
        <span class="pc-head-sub"><${Dot} online=${pc.online} /> ${pc.online ? `Ligado · atualizado ${ago(idade)}` : `Sem notícia ${ago(idade)}`}</span>
      </span>
    </header>

    ${!pc.online && (andando || s.estado === 'pausado')
      ? html`<div class="notice pc-offline" role="status">
          <${Icon} name="wifi" size=${20} />
          <div>
            <b>Sem notícia ${ago(idade)}</b>
            <p>${s.fechado ? 'O SOBEDESCE foi fechado neste computador. As transferências continuam quando ele abrir de novo.' : 'O computador pode estar desligado ou sem internet.'}</p>
          </div>
        </div>`
      : null}

    ${s.estado !== 'parado'
      ? html`<div class=${cx('group pc-summary', `is-${s.estado}`)}>
          <div class="pc-summary-top">
            <span class="pc-summary-pct">${s.estado === 'concluido' ? '100%' : percent(frac)}</span>
            <span class="pc-summary-state">${estado}</span>
          </div>
          <${Bar} frac=${frac} tone=${toneOf(s)} label=${`${percent(frac)} no total`} />
          <div class="pc-summary-nums">
            <span>${count(g.feitos)} de ${plural(g.total, 'arquivo', 'arquivos')}${g.erros ? html` · <span class="is-err">${plural(g.erros, 'com erro', 'com erro')}</span>` : null}</span>
            <span>${bytes(g.feitoBytes)} de ${bytes(g.totalBytes)}</span>
          </div>
          ${andando && pc.online
            ? html`<div class="pc-summary-nums is-live">
                <span>${g.velocidade ? speed(g.velocidade) : 'Esperando…'}</span>
                <span>${eta ? `faltam ${eta}` : ''}</span>
              </div>`
            : null}
        </div>`
      : null}

    ${s.itens?.length
      ? html`<h3 class="list-label">Agora</h3>
          <ul class="group pc-rows">
            ${s.itens.map((it) => html`<${ItemRow} key=${it.id} it=${it} />`)}
          </ul>
          ${g.fora ? html`<p class="group-foot">E mais ${plural(g.fora, 'arquivo na fila', 'arquivos na fila')}.</p>` : null}`
      : null}

    ${s.terminados?.length
      ? html`<h3 class="list-label">Já passou</h3>
          <ul class="group pc-rows">
            ${s.terminados.map((t, i) => html`<${DoneRow} key=${`${t.nome}-${t.terminouEm}-${i}`} t=${t} agora=${agora} />`)}
          </ul>`
      : null}
  </section>`
}

/** "Avisar no celular quando terminar". */
function PushToggle() {
  const push = useApp((s) => s.pc.push)
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)
  const supported = pushSupported()
  const needsInstall = pushNeedsInstall(isIOS)
  useEffect(() => {
    pushStatus().then(setSt, () => setSt({ suportado: false }))
  }, [])
  const on = Boolean(st?.inscrito)
  const blocked = st?.permissao === 'denied'
  const disabled = busy || !supported || needsInstall || blocked || push?.ativo === false
  const toggle = async () => {
    if (disabled) return
    setBusy(true)
    try {
      if (on) {
        await disablePush()
        toast('Avisos desligados neste celular')
      } else {
        await enablePush()
        toast('Pronto. Avisamos quando terminar', { tone: 'success' })
      }
    } catch (err) {
      if (err?.code === 'denied') toast('As notificações ficaram bloqueadas. Libere nos ajustes do navegador.', { tone: 'error', ms: 4500 })
      else if (err?.code !== 'default') toast(err?.message?.length > 20 ? err.message : 'Não deu para ligar os avisos agora.', { tone: 'error', ms: 4000 })
    } finally {
      setSt(await pushStatus().catch(() => null))
      setBusy(false)
    }
  }
  let help = 'Chega uma notificação quando os arquivos terminarem de passar ou se parar com erro.'
  if (!supported && !needsInstall) help = 'Este navegador não mostra avisos de sites.'
  else if (needsInstall) help = null
  else if (blocked) help = 'As notificações estão bloqueadas para este site. Libere nos ajustes do navegador e volte aqui.'
  else if (push?.ativo === false) help = 'Os avisos ainda não estão ligados no servidor.'
  return html`<div class="group pc-push">
    <button type="button" class="pc-push-row" role="switch" aria-checked=${on ? 'true' : 'false'} aria-disabled=${disabled ? 'true' : undefined} onClick=${toggle}>
      <span class="pc-push-icon" aria-hidden="true"><${Icon} name="bell" size=${19} /></span>
      <span class="pc-push-text">Avisar no celular quando terminar</span>
      <span class=${cx('switch', on && 'is-on', disabled && 'is-disabled', busy && 'is-busy')} aria-hidden="true"><span></span></span>
    </button>
    ${needsInstall
      ? html`<p class="pc-push-help is-hint"><${Icon} name="share" size=${15} /> <span>No iPhone, os avisos só funcionam com o app na Tela de Início: toque em <b>Compartilhar</b> e depois em <b>Adicionar à Tela de Início</b>.</span></p>`
      : help
        ? html`<p class="pc-push-help">${help}</p>`
        : null}
  </div>`
}

export function ComputerSheet() {
  const pcState = useApp((s) => s.pc)
  useEffect(() => watchFast(), [])
  const lista = pcState.computadores || []
  return html`<${SheetHead}
      title="No computador"
      right=${html`<button type="button" class="link-btn is-strong" onClick=${closeSheet}>OK</button>`}
    />
    <div class="sheet-body sheet-scroll pc-sheet">
      ${lista.length
        ? lista.map((pc) => html`<${Computer} key=${pc.id} pc=${pc} pcState=${pcState} />`)
        : pcState.status === 'idle' || (pcState.status === 'loading' && !lista.length)
          ? html`<div class="pc-empty"><span class="spinner" aria-hidden="true"></span></div>`
          : html`<div class="empty pc-empty">
              <span class="pc-empty-icon" aria-hidden="true"><${Icon} name="laptop" size=${30} /></span>
              <b>Nenhuma notícia do computador</b>
              <p>No app SOBEDESCE do computador, entre na sua conta e deixe ligado Ajustes → Acompanhar pelo celular. O que estiver passando aparece aqui.</p>
            </div>`}
      <h3 class="list-label">Avisos</h3>
      <${PushToggle} />
      <p class="foot">Atualiza sozinho a cada 5 segundos com esta tela aberta. Os nomes dos arquivos ficam guardados na sua conta por até 7 dias.</p>
    </div>`
}
ComputerSheet.label = 'No computador'
ComputerSheet.tall = true
