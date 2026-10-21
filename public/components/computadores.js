// Tela Dispositivos (docs/LAN.md e docs/CELULAR-WIFI.md), no padrão do kit (docs/UI-KIT.md): manda arquivos direto
// pela rede para os seus computadores e celulares, ou para quem está do lado (outra conta, sempre aceitando), cifrado e
// conferido, sem passar pela internet. Fluxo em três passos (Para quem → O quê → Como) e o botão grande ao lado; os
// pedidos de outras pessoas no topo; ao lado, o que está passando agora (com o gráfico) e o que este computador aceita
// receber. Computador ↔ computador vai pela rede local (/api/lan/*); celular pelo WebRTC (/api/celular/*).
import { html, useEffect, useRef, useState } from '/vendor/preact-htm.js'
import { useStore, setSettings } from '../lib/store.js'
import { api, attempt } from '../lib/api.js'
import { aprox, bytes, count, plural, speed, tildify, baseName, relTime } from '../lib/format.js'
import { cx, usePersistentState } from '../lib/ui.js'
import { bridge, pathsFromDrop, pickFolderPath, pickUploadPaths, revealLabel, revealPath } from '../lib/desktop.js'
import { pickDriveFolder } from '../lib/modals.js'
import { navigate } from '../lib/router.js'
import { Icon } from './icons.js'
import { Button, Spinner, Switch } from './common.js'
import { useLocalRoots } from './local-picker.js'
import { duracao } from './discos.js'
import { AvisoFirewall, AvisoRedeLocal, CEL_ATIVO, FalhaCelular, PedidoCelular, estadoCelular, mandarParaCelular, quemCelular, useCelularesAbertos } from './celular-wifi.js'
import { Barra, BotaoGrande, Destaque, GraficoVelocidade, Item, Linha, Linhas, Opcoes, Pagina, Passo, Resumo, Stats, Vazio } from './kit.js'

const FRASE = 'Mande direto pela rede para os seus computadores e celulares, ou para quem está do lado. Cifrado e conferido, sem passar pela internet.'
const LAN_ATIVO = new Set(['preparando', 'aguardando', 'enviando'])
const nomePlataforma = (p) => (p === 'windows' ? 'Windows' : p === 'mac' ? 'Mac' : 'Computador')

const salvarAjuste = async (patch) => {
  const r = await attempt(api.patch('/api/settings', patch))
  if (r?.settings) setSettings(r.settings)
}

// ───── para quem ─────

/** Um aparelho para onde mandar: computador ou celular, seu ou de quem está por perto. */
function Aparelho({ a, on, onEscolher, i }) {
  return html`<button
    type="button"
    role="radio"
    aria-checked=${on ? 'true' : 'false'}
    class=${cx('k-opcao dv-ap k-entra', on && 'is-on', a.outra && 'is-up')}
    style=${`--i:${i}`}
    disabled=${a.indisponivel}
    title=${a.indisponivel || undefined}
    onClick=${() => onEscolher(a.key)}
  >
    <span class="k-opcao-ic dv-ap-ic"><${Icon} name=${a.icone} size=${20} strokeWidth=${1.7} /><i class="dv-vivo" aria-hidden="true"></i></span>
    <b>${a.nome}</b>
    <span>${a.sub}</span>
    ${a.mesmaRede ? html`<span class="dv-rede"><${Icon} name="check" size=${10} strokeWidth=${2.6} />mesma rede</span>` : null}
    <span class="k-opcao-ok" aria-hidden="true"><${Icon} name="check" size=${12} strokeWidth=${2.4} /></span>
  </button>`
}

// ───── pedidos de outras contas (computador) ─────

// Aceita (e, se quiser, sobe pro Drive desta conta) ou recusa. Sem resposta em 5 min, cai.
function PedidoLan({ p, accountId, i }) {
  const [drive, setDrive] = usePersistentState('lan.pedido.drive', null) // { ligado, folder }
  const [ocupado, setOcupado] = useState(false)
  const responder = async (aceitar) => {
    setOcupado(true)
    await attempt(
      api.post('/api/lan/responder', {
        id: p.id,
        aceitar,
        drive: aceitar && drive?.ligado && drive.folder && accountId ? { accountId, folderId: drive.folder.id, folderName: drive.folder.name, driveId: drive.folder.driveId || null } : null,
      }),
    )
    setOcupado(false)
  }
  const ligarDrive = async (on) => {
    if (on && !drive?.folder) {
      const f = await pickDriveFolder({ accountId, title: 'Em qual pasta do seu Drive?', initialFolderId: 'root' })
      if (!f) return
      setDrive({ ligado: true, folder: f })
    } else setDrive({ ...(drive || {}), ligado: on })
  }
  return html`<section class="dv-pedido k-entra" style=${`--i:${i}`} role="alertdialog" aria-label=${`Pedido de ${p.pessoa || p.de}`}>
    <span class="dv-pedido-ic" aria-hidden="true"><${Icon} name="laptop" size=${22} strokeWidth=${1.8} /></span>
    <div class="dv-pedido-txt">
      <span class="k-rot">Pedido pela rede</span>
      <h2>${p.pessoa || p.de} quer te mandar ${plural(p.arquivos, 'arquivo', 'arquivos')}</h2>
      <p class="num">${p.pessoa ? `do ${p.de} · ` : ''}${bytes(p.bytes)} · pasta <b>${p.pasta}</b></p>
      <label class="dv-pedido-drive">
        <${Switch} checked=${!!drive?.ligado} label="Subir pro meu Drive quando chegar" onChange=${ligarDrive} />
        <span>
          <b>Subir pro meu Drive quando chegar</b>
          ${drive?.ligado && drive.folder
            ? html` · ${drive.folder.path || drive.folder.name} <button type="button" class="link-btn" onClick=${async () => {
                const f = await pickDriveFolder({ accountId, title: 'Em qual pasta do seu Drive?', initialFolderId: drive.folder.id })
                if (f) setDrive({ ligado: true, folder: f })
              }}>Trocar</button>`
            : ' · na sua conta, pela fila de Transferências'}
        </span>
      </label>
    </div>
    <div class="dv-pedido-acoes">
      <${Button} onClick=${() => responder(false)} disabled=${ocupado}>Recusar</${Button}>
      <button type="button" class="k-botao dv-aceitar" onClick=${() => responder(true)} disabled=${ocupado}>
        ${ocupado ? html`<${Spinner} size=${16} />` : html`<${Icon} name="check" size=${18} strokeWidth=${2} />`}Aceitar
      </button>
    </div>
  </section>`
}

// ───── envio para outro computador ─────

function EnvioLan({ e, pontos, onCancelar, onNovo }) {
  const frac = e.bytes ? Math.min(1, e.enviados / e.bytes) : e.fase === 'pronto' ? 1 : 0
  if (['pronto', 'com-falhas', 'erro', 'cancelado'].includes(e.fase)) {
    const ok = e.fase === 'pronto'
    const media = e.decorrido > 0 ? e.enviados / e.decorrido : 0
    return html`<${Passo} icone=${ok ? 'circle-check' : e.fase === 'cancelado' ? 'circle-x' : 'warning'} cor=${ok ? 'ok' : e.fase === 'cancelado' ? 'warn' : 'err'} titulo=${ok ? `Chegou em ${e.para}` : e.fase === 'cancelado' ? 'Envio parado' : e.fase === 'erro' ? 'Não deu para mandar' : 'Chegou com problemas'} frase=${e.fase === 'erro' ? e.erro : `${plural(e.prontos, 'arquivo conferido', 'arquivos conferidos')}${e.iguais ? ` · ${plural(e.iguais, 'já estava lá', 'já estavam lá')}` : ''}`} i=${1}>
      ${e.fase !== 'erro'
        ? html`<${Destaque} tom=${ok ? 'ok' : 'erro'} titulo=${ok ? 'Conferido arquivo por arquivo' : 'Parte não chegou'} numero=${bytes(e.enviados)} unidade=${`em ${duracao(e.decorrido)}${media ? ` · média ${bytes(media)}/s` : ''}`} />`
        : null}
      ${e.drive
        ? html`<p class="k-nota"><${Icon} name="cloud" size=${14} />${e.drive.ok === false ? `Drive: ${e.drive.erro}` : 'Drive: na fila de Transferências.'} ${e.drive.ok !== false ? html`<button type="button" class="link-btn" onClick=${() => navigate('transferencias')}>Ver</button>` : null}</p>`
        : null}
      ${e.falhas?.length ? html`<ul class="dv-falhas">${e.falhas.slice(0, 50).map((f) => html`<li><span class="mono-path">${f.relPath}</span><span>${f.erro}</span></li>`)}</ul>` : null}
      <div class="dv-fim-acoes"><${BotaoGrande} icone="plus" cheio=${false} onClick=${onNovo}>Mandar mais</${BotaoGrande}></div>
    </${Passo}>`
  }
  if (e.fase === 'aguardando') {
    return html`<${Passo} icone="user" cor="warn" titulo=${`Esperando ${e.dono || e.para} aceitar`} frase=${`Pedido enviado para ${e.para}: ${plural(e.arquivos, 'arquivo', 'arquivos')} · ${bytes(e.bytes)}. Quando aceitar, a cópia começa sozinha.`} acao=${html`<${Button} icon="x" onClick=${onCancelar}>Desistir</${Button}>`} i=${1}>
      <div class="dv-esperando" aria-hidden="true"><span></span><span></span><span></span></div>
    </${Passo}>`
  }
  return html`<${Passo} icone="arrow-up" cor="up" titulo=${e.fase === 'preparando' ? `Conectando com ${e.para}…` : `Mandando para ${e.para}`} frase=${e.endereco ? `Pela rede (${e.endereco})` : 'Pela rede local'} acao=${html`<${Button} icon="x" onClick=${onCancelar}>Parar</${Button}>`} i=${1}>
    <div aria-live="polite">
      <${Destaque} titulo="Mandando" numero=${Math.floor(frac * 100)} unidade=${`% · ${bytes(e.enviados)} de ${bytes(e.bytes)}`} progresso=${frac} linha=${`${count(e.prontos)} de ${plural(Math.max(0, e.arquivos - e.iguais), 'arquivo', 'arquivos')}`} vivo=${e.fase === 'enviando'} />
    </div>
    ${e.atual ? html`<p class="mono-path dv-atual" title=${e.atual}>${e.atual}</p>` : null}
    <${Stats}
      compacto
      colunas=${2}
      itens=${[
        { icone: 'bolt', valor: e.velocidade ? speed(e.velocidade) : '—', rotulo: 'agora', tom: 'up' },
        { icone: 'gauge', valor: e.velocidadeMedia ? speed(e.velocidadeMedia) : '—', rotulo: 'média', tom: 'up' },
        { icone: 'clock', valor: e.restante == null ? '—' : aprox(e.restante) || '—', rotulo: 'faltam', tom: 'neutro' },
        { icone: 'clock', valor: duracao(e.decorrido), rotulo: 'passou', tom: 'neutro' },
      ]}
    />
    <div class="k-caixa"><${GraficoVelocidade} pontos=${pontos} altura=${110} label="Velocidade do envio" /></div>
  </${Passo}>`
}

// ───── recentes ─────

function Recentes({ lan, cel, i }) {
  const itens = [
    ...(lan?.recebendo || []).map((o) => ({ tipo: 'lan', t: o.criadaEm || 0, o })),
    ...(cel?.transferencias || []).map((o) => ({ tipo: 'cel', t: o.inicio || 0, o })),
  ].sort((a, b) => b.t - a.t)
  if (!itens.length) return null
  const podeLimpar = (cel?.transferencias || []).some((t) => !CEL_ATIVO.has(t.estado))
  return html`<${Passo} icone="clock" cor="down" titulo="Recentes" frase="O que chegou aqui e o que foi para o celular." acao=${podeLimpar ? html`<${Button} size="sm" onClick=${() => attempt(api.post('/api/celular/limpar', {}))}>Limpar celular</${Button}>` : null} i=${i}>
    <div class="k-itens">
      ${itens.slice(0, 12).map(({ tipo, o }) => {
        if (tipo === 'lan') {
          const frac = o.bytes ? Math.min(1, o.recebidos / o.bytes) : o.estado === 'recebendo' ? 0 : 1
          const andando = o.estado === 'recebendo'
          return html`<${Item}
            icone="arrow-down"
            tom=${o.estado === 'pronta' ? 'ok' : andando ? 'down' : o.erros ? 'erro' : 'neutro'}
            titulo=${`${o.pasta}`}
            sub=${`de ${o.pessoa ? `${o.pessoa} (${o.de})` : o.de} · ${plural(o.arquivos, 'arquivo', 'arquivos')} · ${bytes(o.bytes)}${o.drive ? ` · ${o.drive.estado?.startsWith('erro') ? 'Drive: não deu' : o.drive.estado ? 'Drive: na fila' : 'depois sobe pro Drive'}` : ''}`}
            fim=${html`<span class="dv-estado">${andando ? `${Math.floor(frac * 100)}%` : o.estado === 'pronta' ? 'Chegou tudo' : o.estado === 'cancelada' ? 'Cancelado' : `${o.prontos} de ${o.arquivos}`}</span>${!andando ? html`<${Button} size="sm" onClick=${() => revealPath(o.caminho)}>${revealLabel()}</${Button}>` : null}`}
          ><${Barra} p=${frac} tom=${o.estado === 'pronta' ? 'ok' : o.erros ? 'erro' : undefined} vivo=${andando} label=${`Recebendo ${o.pasta}`} /></${Item}>`
        }
        const t = o
        const ativo = CEL_ATIVO.has(t.estado)
        const frac = t.estado === 'pronto' ? 1 : t.total ? Math.min(1, t.feitos / t.total) : 0
        const nomes = t.nomes?.length ? ` · ${t.nomes.join(', ')}${t.arquivos > t.nomes.length ? '…' : ''}` : ''
        return html`<${Item}
          icone=${t.direcao === 'recebendo' ? 'arrow-down' : 'arrow-up'}
          tom=${t.estado === 'pronto' ? 'ok' : ativo ? (t.direcao === 'recebendo' ? 'down' : 'up') : t.estado === 'cancelado' ? 'neutro' : 'erro'}
          titulo=${t.direcao === 'recebendo' ? `Do ${quemCelular(t)}` : `Para o ${quemCelular(t)}`}
          sub=${`${plural(t.arquivos, 'arquivo', 'arquivos')} · ${bytes(t.total)}${nomes}`}
          fim=${html`<span class="dv-estado">${estadoCelular(t)}</span>${ativo
            ? html`<${Button} size="sm" icon="x" onClick=${() => attempt(api.post(`/api/celular/cancelar/${t.id}`, {}))}>Cancelar</${Button}>`
            : t.direcao === 'recebendo' && t.estado === 'pronto'
              ? html`<${Button} size="sm" onClick=${() => revealPath(t.primeiro || t.pasta)}>${revealLabel()}</${Button}>`
              : null}`}
        ><${Barra} p=${frac} tom=${t.estado === 'pronto' ? 'ok' : !ativo && t.estado !== 'cancelado' ? 'erro' : undefined} vivo=${ativo} label=${`Transferência com ${t.aparelho}`} /></${Item}>`
      })}
    </div>
  </${Passo}>`
}

// ───── lado: agora e este computador ─────

function Agora({ pontos, lanEnvio, lan, cel }) {
  const celAtivas = (cel?.transferencias || []).filter((t) => CEL_ATIVO.has(t.estado))
  const lanRec = (lan?.recebendo || []).filter((o) => o.estado === 'recebendo')
  const lanEnv = lanEnvio && LAN_ATIVO.has(lanEnvio.fase) ? lanEnvio : null
  if (!celAtivas.length && !lanRec.length && !lanEnv) return null
  let feito = 0
  let total = 0
  for (const t of celAtivas) (feito += t.feitos || 0), (total += t.total || 0)
  for (const o of lanRec) (feito += o.recebidos || 0), (total += o.bytes || 0)
  if (lanEnv) (feito += lanEnv.enviados || 0), (total += lanEnv.bytes || 0)
  const frac = total ? Math.min(1, feito / total) : null
  const ultimo = pontos.at(-1) || { up: 0, down: 0 }
  const n = celAtivas.length + lanRec.length + (lanEnv ? 1 : 0)
  return html`<${Resumo} titulo="Agora">
    <${Destaque} titulo=${n === 1 ? 'Passando pela rede' : `${n} passando pela rede`} numero=${frac == null ? '…' : Math.floor(frac * 100)} unidade=${frac == null ? 'conectando' : `% de ${bytes(total)}`} progresso=${frac} vivo=${true} />
    <div class="k-caixa">
      <div class="dv-graf-topo">
        <span class="k-rot">Velocidade</span>
        <span class="dv-legenda"><span class="is-down"><i></i>${ultimo.down ? speed(ultimo.down) : '—'}</span><span class="is-up"><i></i>${ultimo.up ? speed(ultimo.up) : '—'}</span></span>
      </div>
      <${GraficoVelocidade} pontos=${pontos} altura=${84} label="Velocidade pela rede no último minuto" />
    </div>
  </${Resumo}>`
}

function Pasta({ caminho, home, titulo, onTrocar }) {
  return html`<div class="dv-pasta">
    <span class="dv-pasta-ic"><${Icon} name="folder" size=${16} strokeWidth=${1.8} /></span>
    <span class="dv-pasta-txt"><span class="k-rot">${titulo}</span><span class="mono-path" title=${caminho}>${tildify(caminho, home)}</span></span>
    <span class="dv-pasta-acoes">
      <${Button} size="sm" onClick=${onTrocar}>Trocar</${Button}>
      <button type="button" class="link-btn" onClick=${() => revealPath(caminho)}>${revealLabel()}</button>
    </span>
  </div>`
}

function EsteComputador({ lan, settings, cel, home }) {
  const lanOn = !!settings?.lanReceber
  const celOn = !!settings?.celularReceber
  return html`<${Resumo} titulo="Este computador recebe">
    <div class="dv-canal">
      <div class="dv-canal-topo">
        <span class=${cx('dv-canal-ic', lanOn && 'is-on')}><${Icon} name="laptop" size=${17} strokeWidth=${1.8} /></span>
        <div class="dv-canal-txt">
          <b>Dos computadores</b>
          <span>${lanOn ? (lan?.rodando ? `Ligado · porta ${lan.porta}` : 'Ligando…') : 'Desligado: os outros não veem este'}</span>
        </div>
        <${Switch} checked=${lanOn} label="Receber dos computadores" onChange=${(on) => salvarAjuste({ lanReceber: on })} />
      </div>
      ${lanOn
        ? html`<${Pasta} titulo="Chega em" caminho=${settings.lanPasta} home=${home} onTrocar=${async () => {
              const p = await pickFolderPath({ title: 'Onde chegam os arquivos?', defaultPath: settings.lanPasta })
              if (p) salvarAjuste({ lanPasta: p })
            }} />
            <${Linhas}>
              <${Linha} titulo="Aceitar de outras pessoas" sub="Outra conta, na mesma rede. Nada chega sem você aceitar.">
                <${Switch} checked=${!!settings.lanOutros} label="Aceitar computadores de outras pessoas" onChange=${(on) => salvarAjuste({ lanOutros: on })} />
              </${Linha}>
            </${Linhas}>`
        : null}
    </div>
    <div class="dv-canal">
      <div class="dv-canal-topo">
        <span class=${cx('dv-canal-ic', celOn && 'is-on')}><${Icon} name="phone" size=${17} strokeWidth=${1.8} /></span>
        <div class="dv-canal-txt">
          <b>Do celular</b>
          <span>${celOn ? (bridge && cel?.pronto ? 'Ligado · pelo Wi-Fi, fica só aqui' : 'Ligado · só no app do computador') : 'Desligado: o celular não manda para cá'}</span>
        </div>
        <${Switch} checked=${celOn} label="Receber do celular" onChange=${(on) => salvarAjuste({ celularReceber: on })} />
      </div>
      ${celOn
        ? html`<${Pasta} titulo="Chega em" caminho=${settings.celularPasta} home=${home} onTrocar=${async () => {
              const p = await pickFolderPath({ title: 'Onde chegam os arquivos do celular?', defaultPath: settings.celularPasta })
              if (p) salvarAjuste({ celularPasta: p })
            }} />
            <${Linhas}>
              <${Linha} titulo="Aceitar de outras pessoas" sub="Celulares de outra conta, na mesma rede. Sempre pergunta antes.">
                <${Switch} checked=${!!settings.celularOutros} label="Aceitar celulares de outras pessoas" onChange=${(on) => salvarAjuste({ celularOutros: on })} />
              </${Linha}>
            </${Linhas}>`
        : null}
    </div>
  </${Resumo}>`
}

/** Velocidade pela rede a cada segundo, enquanto algo passa: ↑ envios (computador e celular), ↓ o que chega. */
function useVelocidadeRede({ lanEnvio, lan, cel }) {
  const [pontos, setPontos] = useState([])
  const ref = useRef({ lanEnvio, lan, cel, rec: null })
  ref.current.lanEnvio = lanEnvio
  ref.current.lan = lan
  ref.current.cel = cel
  const ativo =
    (lanEnvio && LAN_ATIVO.has(lanEnvio.fase)) ||
    (cel?.transferencias || []).some((t) => CEL_ATIVO.has(t.estado)) ||
    (lan?.recebendo || []).some((o) => o.estado === 'recebendo')
  useEffect(() => {
    if (!ativo) return undefined
    const t = setInterval(() => {
      const { lanEnvio: e, lan: l, cel: c } = ref.current
      let up = e?.fase === 'enviando' ? e.velocidade || 0 : 0
      let down = 0
      for (const x of c?.transferencias || []) if (x.estado === 'andando') x.direcao === 'recebendo' ? (down += x.velocidade || 0) : (up += x.velocidade || 0)
      // O que chega de outro computador não traz velocidade: sai da diferença do que já chegou.
      const rec = (l?.recebendo || []).filter((o) => o.estado === 'recebendo').reduce((s, o) => s + (o.recebidos || 0), 0)
      const antes = ref.current.rec
      if (antes != null && rec >= antes.bytes) down += ((rec - antes.bytes) * 1000) / Math.max(1, Date.now() - antes.at)
      ref.current.rec = { bytes: rec, at: Date.now() }
      setPontos((p) => [...p.slice(-59), { up, down }])
    }, 1000)
    return () => clearInterval(t)
  }, [ativo])
  return pontos
}

// ───── tela ─────

export function ComputadoresScreen() {
  const lan = useStore((s) => s.lan)
  const cel = useStore((s) => s.celular)
  const settings = useStore((s) => s.settings)
  const cloud = useStore((s) => s.cloud)
  const accountId = useStore((s) => s.activeAccountId)
  const roots = useLocalRoots()
  const [pcs, setPcs] = useState(null)
  const [para, setPara] = usePersistentState('disp.para', null) // "pc:<id>" | "cel:<id>"
  const [origens, setOrigens] = useState([])
  const [pasta, setPasta] = useState('')
  const [drive, setDrive] = usePersistentState('lan.drive', null) // { ligado, folder: { id, name, path } }
  const [mandando, setMandando] = useState(false)
  const [sobre, setSobre] = useState(false)
  const e = lan?.envio
  const conectado = !!cloud?.conectado
  useCelularesAbertos()
  const pontos = useVelocidadeRede({ lanEnvio: e, lan, cel })

  // Os computadores da conta e os de outras contas por perto: de novo a cada 15 s enquanto a tela está aberta.
  useEffect(() => {
    if (!conectado) return undefined
    let vivo = true
    const buscar = () =>
      api.get('/api/lan/computadores').then(
        (r) => vivo && setPcs([...(r.computadores || []), ...(r.porPerto || [])]),
        () => vivo && setPcs((l) => l || []),
      )
    buscar()
    const t = setInterval(buscar, 15_000)
    return () => {
      vivo = false
      clearInterval(t)
    }
  }, [conectado])

  const celPronto = !!bridge && !!cel?.pronto
  const aparelhos = [
    ...(pcs || []).map((c) => ({
      key: `pc:${c.id}`,
      kind: 'pc',
      id: c.id,
      nome: c.nome,
      outra: (c.tipo || 'conta') === 'outro',
      dono: c.dono || null,
      icone: c.plataforma === 'windows' ? 'desktop' : 'laptop',
      sub: (c.tipo === 'outro' && c.dono ? `de ${c.dono} · ` : '') + `${nomePlataforma(c.plataforma)} · visto ${relTime(Date.parse(c.vistoEm))}`,
      mesmaRede: false,
    })),
    ...(cel?.celulares || []).map((c) => ({
      key: `cel:${c.id}`,
      kind: 'cel',
      id: c.id,
      nome: c.nome,
      outra: c.conta === 'outra',
      dono: c.dono || null,
      icone: 'phone',
      sub: c.conta === 'outra' ? `de ${c.dono || 'alguém'} · aceita no celular` : 'Celular · app aberto',
      mesmaRede: !!c.mesmaRede,
      indisponivel: celPronto ? null : 'Só no app SOBEDESCE do computador. Se ele já está aberto, feche e abra de novo.',
    })),
  ]
  const seus = aparelhos.filter((a) => !a.outra)
  const porPerto = aparelhos.filter((a) => a.outra)
  const destino = aparelhos.find((a) => a.key === para && !a.indisponivel) || null
  const nomePadrao = origens.length ? baseName(origens[0]) : ''
  const procurando = pcs == null && conectado

  const escolher = async (ev) => {
    const p = await pickUploadPaths({ title: 'O que mandar?', anchor: ev?.currentTarget })
    if (p?.length) setOrigens((o) => [...new Set([...o, ...p])])
  }
  const soltar = (ev) => {
    if (!bridge) return
    ev.preventDefault()
    setSobre(false)
    const p = pathsFromDrop(ev.dataTransfer)
    if (p.length) setOrigens((o) => [...new Set([...o, ...p])])
  }
  const ligarDrive = async (on) => {
    if (on && !drive?.folder) {
      const f = await pickDriveFolder({ accountId, title: 'Em qual pasta do Drive?', initialFolderId: 'root' })
      if (!f) return
      setDrive({ ligado: true, folder: f })
    } else setDrive({ ...(drive || {}), ligado: on })
  }
  const mandar = async () => {
    if (!destino || !origens.length) return
    setMandando(true)
    if (destino.kind === 'cel') {
      const r = await mandarParaCelular(destino.id, origens)
      if (r) setOrigens([])
    } else {
      await attempt(
        api.post('/api/lan/enviar', {
          para: destino.id,
          origens,
          pasta: pasta.trim() || null,
          drive: drive?.ligado && drive.folder && accountId ? { accountId, folderId: drive.folder.id, folderName: drive.folder.name, driveId: drive.folder.driveId || null } : null,
        }),
      )
    }
    setMandando(false)
  }
  const novo = () => {
    setOrigens([])
    setPasta('')
    attempt(api.post('/api/lan/limpar', {}))
  }

  const pedidos = [
    ...(lan?.pedidos || []).map((p) => ({ tipo: 'lan', p })),
    ...(cel?.pedidos || []).map((p) => ({ tipo: 'cel', p })),
  ]
  const envioLanVisivel = !!e
  const dica = !destino
    ? 'Escolha para quem mandar.'
    : !origens.length
      ? 'Escolha o que mandar.'
      : destino.outra
        ? html`<b>${destino.dono || 'A pessoa'}</b> recebe um pedido e escolhe aceitar.`
        : destino.kind === 'cel'
          ? html`Chega no <b>${destino.nome}</b>, com Salvar em cada arquivo.`
          : html`Chega em <b>${destino.nome} › Recebidos › ${pasta.trim() || nomePadrao}</b>.`

  const lado = html`
    ${conectado && !envioLanVisivel
      ? html`<${Resumo} titulo="Envio">
          <div class="dv-rota" aria-hidden=${destino ? undefined : 'true'}>
            <span class="dv-rota-ponto"><${Icon} name="laptop" size=${18} strokeWidth=${1.8} /></span>
            <span class=${cx('dv-rota-fio', destino && origens.length && 'is-pronto')}><i></i></span>
            <span class=${cx('dv-rota-ponto', destino && 'is-on')}><${Icon} name=${destino?.icone || 'users'} size=${18} strokeWidth=${1.8} /></span>
          </div>
          <${Stats}
            compacto
            colunas=${2}
            itens=${[
              { icone: 'doc', valor: count(origens.length), rotulo: origens.length === 1 ? 'item escolhido' : 'itens escolhidos', tom: origens.length ? 'up' : 'neutro' },
              { icone: destino?.kind === 'cel' ? 'phone' : 'laptop', valor: destino ? (destino.kind === 'cel' ? 'Celular' : 'Computador') : '—', rotulo: destino ? (destino.outra ? `${destino.nome} · ${destino.dono || 'por perto'}` : destino.nome) : 'para quem', tom: destino ? (destino.outra ? 'up' : 'down') : 'neutro' },
            ]}
          />
          <${BotaoGrande} icone="arrow-right" onClick=${mandar} disabled=${!destino || !origens.length || mandando} dica=${dica}>
            ${mandando ? 'Mandando…' : destino ? `Mandar para ${destino.nome}` : 'Mandar'}
          </${BotaoGrande}>
        </${Resumo}>`
      : null}
    <${Agora} pontos=${pontos} lanEnvio=${e} lan=${lan} cel=${cel} />
    <${EsteComputador} lan=${lan} settings=${settings} cel=${cel} home=${roots?.home} />
  `

  if (!conectado) {
    return html`<${Pagina} titulo="Dispositivos" frase=${FRASE} class="dv" lado=${html`<${EsteComputador} lan=${lan} settings=${settings} cel=${cel} home=${roots?.home} />`}>
      <section class="k-passo k-entra" style="--i:1">
        <${Vazio} icone="laptop" titulo="Entre na sua conta SOBEDESCE" acoes=${html`<${BotaoGrande} icone="user" cheio=${false} onClick=${() => navigate('ajustes')}>Abrir Ajustes</${BotaoGrande}>`}>
          Os aparelhos se acham pela sua conta. Entre nela neste computador e no outro aparelho (no celular, em sobedesce.com/app).
        </${Vazio}>
      </section>
    </${Pagina}>`
  }

  return html`<${Pagina} titulo="Dispositivos" frase=${FRASE} class="dv" larga lado=${lado}>
    ${cel?.redeLocal === 'bloqueada' ? html`<${AvisoRedeLocal} i=${1} />` : null}
    ${cel?.firewall?.atrapalha ? html`<${AvisoFirewall} fw=${cel.firewall} i=${1} />` : null}
    ${cel?.ultimaFalha && cel?.redeLocal !== 'bloqueada' && !cel?.firewall?.atrapalha ? html`<${FalhaCelular} f=${cel.ultimaFalha} i=${1} />` : null}
    ${pedidos.map(({ tipo, p }, i) => (tipo === 'lan' ? html`<${PedidoLan} key=${`l${p.id}`} p=${p} accountId=${accountId} i=${i + 1} />` : html`<${PedidoCelular} key=${`c${p.id}`} p=${p} i=${i + 1} />`))}

    ${envioLanVisivel
      ? html`<${EnvioLan} e=${e} pontos=${pontos} onCancelar=${() => attempt(api.post('/api/lan/cancelar', {}))} onNovo=${novo} />`
      : html`
          <${Passo} n=${1} titulo="Para quem" frase="Os aparelhos com o SOBEDESCE aberto agora. Toque em um." i=${1}>
            ${procurando
              ? html`<div class="dv-procurando"><span class="dv-radar" aria-hidden="true"><i></i><i></i></span>Procurando os seus aparelhos…</div>`
              : !aparelhos.length
                ? html`<${Vazio} icone="users" titulo="Nenhum aparelho por perto agora">
                    No outro computador, abra o SOBEDESCE e ligue “Dos computadores” em Dispositivos. No celular, abra sobedesce.com/app com a sua conta, no mesmo Wi-Fi.
                  </${Vazio}>`
                : html`${[
                    ['Seus aparelhos', seus],
                    ['Por perto, de outras pessoas', porPerto],
                  ].map(([titulo, grupo], g) =>
                    grupo.length
                      ? html`<div class="dv-grupo">
                          ${porPerto.length ? html`<span class="k-rot">${titulo}</span>` : null}
                          <div class="k-opcoes dv-aps" role="radiogroup" aria-label=${titulo}>
                            ${grupo.map((a, k) => html`<${Aparelho} key=${a.key} a=${a} on=${para === a.key} onEscolher=${setPara} i=${g * 4 + k + 2} />`)}
                          </div>
                        </div>`
                      : null,
                  )}`}
          </${Passo}>

          <${Passo} n=${2} titulo="O quê" frase="Arquivos ou pastas inteiras, do tamanho que for." i=${2}>
            <div
              class=${cx('k-soltar dv-soltar', sobre && 'is-sobre', origens.length && 'tem')}
              onDragOver=${(ev) => bridge && (ev.preventDefault(), setSobre(true))}
              onDragLeave=${() => setSobre(false)}
              onDrop=${soltar}
            >
              ${origens.length
                ? html`<ul class="dv-origens">
                    ${origens.map(
                      (o) => html`<li class="k-entra"><span class="dv-origem-ic"><${Icon} name="doc" size=${14} /></span><span class="mono-path" title=${o}>${tildify(o, roots?.home)}</span><button type="button" class="icon-btn" aria-label="Tirar" onClick=${() => setOrigens(origens.filter((x) => x !== o))}><${Icon} name="x" size=${13} /></button></li>`,
                    )}
                  </ul>
                  <${Button} size="sm" icon="plus" onClick=${escolher}>Adicionar</${Button}>`
                : html`<span class="k-soltar-ic"><${Icon} name="upload" size=${18} strokeWidth=${1.9} /></span>
                    <span class="dv-soltar-txt"><b>${bridge ? 'Arraste arquivos e pastas para cá' : 'Escolha arquivos ou uma pasta'}</b><span>ou</span></span>
                    <${Button} icon="plus" onClick=${escolher}>Escolher arquivos ou pasta</${Button}>`}
            </div>
          </${Passo}>

          <${Passo} n=${3} titulo="Como" frase=${destino?.kind === 'cel' ? 'No celular, cada arquivo chega com Salvar (Fotos ou Arquivos).' : 'O nome da pasta lá e se sobe pro Drive junto.'} i=${3}>
            ${destino?.kind === 'cel'
              ? html`<div class="dv-cel-nota">
                  <span class="dv-cel-nota-ic"><${Icon} name="phone" size=${18} strokeWidth=${1.8} /></span>
                  <span>Mantenha o app aberto no ${destino.nome} enquanto passa. ${destino.outra ? `${destino.dono || 'A pessoa'} toca em Aceitar antes.` : 'Da sua conta, o pedido aparece e é só aceitar.'}</span>
                </div>`
              : html`<div class="dv-nome">
                    <label class="k-rot" for="dv-pasta">Pasta no destino</label>
                    <input id="dv-pasta" class="input" type="text" maxlength="120" placeholder=${nomePadrao || 'Nome da pasta'} value=${pasta} onInput=${(ev) => setPasta(ev.currentTarget.value)} />
                  </div>
                  <${Opcoes}
                    label="Drive junto"
                    colunas=${2}
                    valor=${drive?.ligado && drive.folder ? 'drive' : 'so'}
                    onEscolher=${(v) => ligarDrive(v === 'drive')}
                    itens=${[
                      { value: 'so', titulo: 'Só no computador', sub: 'Vai direto pela rede', icone: 'laptop' },
                      { value: 'drive', titulo: 'Subir pro Drive junto', sub: drive?.ligado && drive.folder ? drive.folder.path || drive.folder.name : 'Os mesmos arquivos entram na fila', icone: 'cloud', up: true },
                    ]}
                  />
                  ${drive?.ligado && drive.folder
                    ? html`<p class="k-nota"><${Icon} name="cloud" size=${14} />No Drive: ${drive.folder.path || drive.folder.name} <button type="button" class="link-btn" onClick=${async () => {
                        const f = await pickDriveFolder({ accountId, title: 'Em qual pasta do Drive?', initialFolderId: drive.folder.id })
                        if (f) setDrive({ ligado: true, folder: f })
                      }}>Trocar</button></p>`
                    : null}`}
          </${Passo}>
        `}

    <${Recentes} lan=${lan} cel=${cel} i=${4} />
  </${Pagina}>`
}
