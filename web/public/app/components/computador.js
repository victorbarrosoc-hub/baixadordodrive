// "No computador": quanto falta das transferências que ficaram rodando no app SOBEDESCE do computador.
// Cartão no topo da tela Início (quando algo anda ou terminou nas últimas 24 h) e a folha com tudo: progresso,
// velocidade, o que está passando agora, o que já passou e "Avisar no celular quando terminar".
import { html, useEffect, useState } from '../vendor/preact-htm.js'
import { bytes, count, percent, plural, speed } from '../lib/format.js'
import { closeSheet, openSheet, toast, useApp } from '../lib/state.js'
import { isIOS } from '../lib/platform.js'
import { ageOf, ago, aprox, disablePush, enablePush, fraction, isRelevant, pushNeedsInstall, pushStatus, pushSupported, watchFast } from '../lib/computador.js'
import { Icon } from './icons.js'
import { SheetHead, cx } from './ui.js'
import { FileName } from './queue.js'
import { Destaque, Linhas, Pilulas, Rotulo, Stats, Vazio } from './kit.js'

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

// ───── pedidos (lotes), como a tela Transferências do computador ─────

const FILTROS_LOTE = [
  { id: 'tudo', label: 'Tudo', test: () => true },
  { id: 'andando', label: 'Em andamento', test: (l) => l.andando + l.esperando > 0 || (l.pausados > 0 && !l.erros) },
  { id: 'fila', label: 'Na fila', test: (l) => l.naFila > 0 && !l.andando && !l.esperando },
  { id: 'prontas', label: 'Concluídas', test: (l) => l.terminouEm != null && !l.erros && !l.divergentes },
  { id: 'problema', label: 'Com problema', test: (l) => l.erros > 0 || l.divergentes > 0 },
]

/** "3 baixando · 5 na fila" · "1 concluído · 8 cancelados" (a mesma linha do computador). */
function situacao(l) {
  const sobe = l.direcao === 'sobe'
  const parts = []
  if (l.andando) parts.push(`${count(l.andando)} ${sobe ? 'enviando' : l.direcao === 'misto' ? 'passando' : 'baixando'}`)
  if (l.esperando) parts.push(`${count(l.esperando)} esperando a internet`)
  if (l.naFila) parts.push(`${count(l.naFila)} na fila`)
  if (l.pausados) parts.push(plural(l.pausados, 'pausado', 'pausados'))
  if (l.concluidos) parts.push(plural(l.concluidos, 'concluído', 'concluídos'))
  if (l.cancelados) parts.push(plural(l.cancelados, 'cancelado', 'cancelados'))
  if (l.erros) parts.push(`${count(l.erros)} com problema`)
  return parts.join(' · ')
}

/** "1 de 1 conferido (MD5)" · "8 de 9 conferidos · 1 sem conferência". */
function conferencia(l) {
  if (!l.concluidos) return null
  const de = `${count(l.conferidos)} de ${count(l.concluidos)} ${l.concluidos === 1 ? 'conferido' : 'conferidos'}`
  if (l.conferidos === l.concluidos) return { ok: true, text: `${de} (MD5)` }
  const parts = [de]
  if (l.divergentes) parts.push(`${count(l.divergentes)} ${l.divergentes === 1 ? 'chegou diferente' : 'chegaram diferentes'}`)
  const sem = l.concluidos - l.conferidos - l.divergentes
  if (sem > 0) parts.push(`${count(sem)} sem conferência`)
  return { ok: false, text: parts.join(' · ') }
}

function LoteCard({ l, s, agora, online }) {
  const [aberto, setAberto] = useState(false)
  const frac = l.bytes ? l.feitoBytes / l.bytes : l.terminouEm != null ? 1 : 0
  const sobe = l.direcao === 'sobe'
  const vivo = l.terminouEm == null
  const tone = l.erros || l.divergentes ? 'err' : !vivo ? 'ok' : l.andando ? (sobe ? 'up' : 'down') : 'muted'
  const conf = conferencia(l)
  const eta = vivo && online ? aprox(l.eta) : null
  const arquivos = [...(s.itens || []).filter((it) => it.lote === l.id)]
  const feitos = (s.terminados || []).filter((t) => t.lote === l.id)
  return html`<li class=${cx('pc-lote', aberto && 'is-open', !vivo && 'is-done')}>
    <button type="button" class="pc-lote-head" aria-expanded=${aberto ? 'true' : 'false'} onClick=${() => setAberto(!aberto)}>
      <span class=${cx('pc-row-icon', l.direcao === 'misto' ? 'is-mix' : sobe ? 'is-up' : 'is-down')} aria-label=${sobe ? 'Enviando para o Drive' : l.direcao === 'misto' ? 'Enviando e baixando' : 'Baixando do Drive'}>
        <${Icon} name=${l.direcao === 'misto' ? 'swap' : sobe ? 'arrow-up' : 'arrow-down'} size=${16} strokeWidth=${2.1} />
      </span>
      <span class="pc-lote-main">
        <span class="pc-lote-top">
          <b class="pc-lote-title">${l.titulo}</b>
          <span class="pc-lote-pct">${vivo ? percent(frac) : ago(agora - l.terminouEm)}</span>
        </span>
        <span class="pc-lote-sub">${plural(l.arquivos, 'arquivo', 'arquivos')} · ${bytes(l.bytes)}${l.destino ? ` · ${sobe ? 'para' : 'em'} ${l.destino}` : ''}</span>
        <${Bar} frac=${frac} tone=${tone} label=${`${percent(frac)} de ${l.titulo}`} />
        <span class="pc-lote-meta">
          <span>${situacao(l)}</span>
          ${eta ? html`<span class="pc-lote-eta">${l.velocidade ? `${speed(l.velocidade)} · ` : ''}faltam ${eta}</span>` : null}
        </span>
        ${conf ? html`<span class=${cx('pc-lote-conf', conf.ok && 'is-ok')}><${Icon} name=${conf.ok ? 'shield' : 'info'} size=${14} /> ${conf.text}</span>` : null}
      </span>
      <${Icon} name="chevron-down" size=${16} strokeWidth=${2} class="pc-lote-chev" />
    </button>
    ${aberto
      ? arquivos.length || feitos.length
        ? html`<ul class="pc-rows pc-lote-rows">
            ${arquivos.map((it) => html`<${ItemRow} key=${it.id} it=${it} />`)}
            ${feitos.map((t, i) => html`<${DoneRow} key=${`${t.nome}-${t.terminouEm}-${i}`} t=${t} agora=${agora} />`)}
          </ul>`
        : html`<p class="pc-lote-none">${vivo ? 'Os arquivos deste pedido aparecem aqui quando começarem a passar.' : 'Os nomes dos arquivos deste pedido já saíram do resumo (mostramos os 30 últimos).'}</p>`
      : null}
  </li>`
}

function Lotes({ pc, agora }) {
  const s = pc.snapshot
  const [filtro, setFiltro] = useState('tudo')
  const contagem = Object.fromEntries(FILTROS_LOTE.map((f) => [f.id, s.lotes.filter(f.test).length]))
  const atual = FILTROS_LOTE.find((f) => f.id === filtro) || FILTROS_LOTE[0]
  const lista = s.lotes.filter(atual.test)
  return html`<div class="pc-filtros"><${Pilulas}
      rolar
      label="Mostrar pedidos"
      valor=${filtro}
      onEscolher=${setFiltro}
      itens=${FILTROS_LOTE.map((f) => ({ value: f.id, label: f.label, conta: f.id !== 'tudo' && contagem[f.id] ? contagem[f.id] : null }))}
    /></div>
    ${lista.length
      ? html`<ul class="pc-lotes">${lista.map((l) => html`<${LoteCard} key=${l.id} l=${l} s=${s} agora=${agora} online=${pc.online} />`)}</ul>`
      : html`<p class="pc-lote-none">Nenhum pedido ${atual.label.toLowerCase()}.</p>`}`
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
      ? html`<${Destaque}
            class=${cx('pc-summary', `is-${s.estado}`)}
            tom=${s.estado === 'erro' ? 'erro' : s.estado === 'concluido' ? 'ok' : s.estado === 'baixando' ? 'down' : s.estado === 'pausado' || !pc.online ? 'grad' : 'up'}
            vivo=${andando && pc.online}
            titulo=${estado}
            numero=${s.estado === 'concluido' ? '100%' : percent(frac)}
            progresso=${frac}
          >
            <span class="k-destaque-linha"><span>${count(g.feitos)} de ${plural(g.total, 'arquivo', 'arquivos')}</span><span>${bytes(g.feitoBytes)} de ${bytes(g.totalBytes)}</span></span>
          </${Destaque}>
          <${Stats}
            itens=${[
              { icone: 'gauge', valor: andando && pc.online && g.velocidade ? speed(g.velocidade) : '—', rotulo: 'agora', tom: s.estado === 'baixando' ? 'down' : 'up' },
              { icone: 'clock', valor: andando && pc.online && eta ? eta : '—', rotulo: 'falta', tom: 'neutro' },
              { icone: g.erros ? 'warning' : 'check', valor: g.erros ? count(g.erros) : count(g.feitos), rotulo: g.erros ? 'com erro' : 'prontos', tom: g.erros ? 'erro' : 'ok' },
            ]}
          />`
      : null}

    ${s.lotes?.length ? html`<${Rotulo}>Pedidos</${Rotulo}><${Lotes} pc=${pc} agora=${agora} />` : null}

    ${!s.lotes?.length && s.itens?.length
      ? html`<${Rotulo}>Agora</${Rotulo}>
          <ul class="group pc-rows">
            ${s.itens.map((it) => html`<${ItemRow} key=${it.id} it=${it} />`)}
          </ul>
          ${g.fora ? html`<p class="group-foot">E mais ${plural(g.fora, 'arquivo na fila', 'arquivos na fila')}.</p>` : null}`
      : null}

    ${!s.lotes?.length && s.terminados?.length
      ? html`<${Rotulo}>Já passou</${Rotulo}>
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
  return html`<div class="pc-push">
    <${Linhas}>
      <button type="button" class="k-linha is-botao" role="switch" aria-checked=${on ? 'true' : 'false'} aria-disabled=${disabled ? 'true' : undefined} onClick=${toggle}>
        <span class="k-linha-ic" style="--c:var(--warn)"><${Icon} name="bell" size=${17} strokeWidth=${1.8} /></span>
        <span class="k-linha-txt"><b>Avisar no celular quando terminar</b>${help ? html`<span>${help}</span>` : null}</span>
        <span class="k-linha-ctl"><span class=${cx('switch', on && 'is-on', disabled && 'is-disabled', busy && 'is-busy')} aria-hidden="true"><span></span></span></span>
      </button>
    </${Linhas}>
    ${needsInstall
      ? html`<p class="pc-push-help is-hint"><${Icon} name="share" size=${15} /> <span>No iPhone, os avisos só funcionam com o app na Tela de Início: toque em <b>Compartilhar</b> e depois em <b>Adicionar à Tela de Início</b>.</span></p>`
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
          : html`<${Vazio} icone="laptop" titulo="Nenhuma notícia do computador">
              No app SOBEDESCE do computador, entre na sua conta e deixe ligado Ajustes → Acompanhar pelo celular. O que estiver passando aparece aqui.
            </${Vazio}>`}
      <${Rotulo}>Avisos</${Rotulo}>
      <${PushToggle} />
      <p class="foot">Atualiza sozinho a cada 5 segundos com esta tela aberta. Os nomes dos arquivos ficam guardados na sua conta por até 7 dias.</p>
    </div>`
}
ComputerSheet.label = 'No computador'
ComputerSheet.tall = true
