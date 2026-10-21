// Tela Computadores ("Entre computadores", docs/LAN.md): manda arquivos direto para outro computador pela rede local
// (Mac ou Windows), da mesma conta SOBEDESCE ou de outra conta por perto, cifrado e conferido, com a opção de subir
// para o Drive ao mesmo tempo. Aqui também se liga "Este computador recebe", "Aceitar de outras contas por perto", se
// respondem os pedidos de outras contas e se escolhe onde chega o que vem dos outros.
import { html, useEffect, useRef, useState } from '/vendor/preact-htm.js'
import { useStore, setSettings } from '../lib/store.js'
import { api, attempt } from '../lib/api.js'
import { aprox, bytes, count, plural, tildify, baseName, relTime } from '../lib/format.js'
import { cx, usePersistentState } from '../lib/ui.js'
import { bridge, pathsFromDrop, pickFolderPath, pickUploadPaths, revealLabel, revealPath } from '../lib/desktop.js'
import { pickDriveFolder } from '../lib/modals.js'
import { navigate } from '../lib/router.js'
import { Icon } from './icons.js'
import { Button, Checkbox, EmptyState, Spinner, Switch } from './common.js'
import { useLocalRoots } from './local-picker.js'
import { Grafico, Velocidade, duracao } from './discos.js'
import { CelularSecao } from './celular-wifi.js'

const iconeDe = (plataforma) => (plataforma === 'windows' ? 'desktop' : 'laptop')

function Receber({ lan, settings, home }) {
  const ligado = !!settings?.lanReceber
  const salvar = async (patch) => {
    const r = await attempt(api.patch('/api/settings', patch))
    if (r?.settings) setSettings(r.settings)
  }
  return html`<section class=${cx('card pc-receber', ligado && 'is-on')}>
    <div class="pc-receber-topo">
      <span class="pc-receber-icon"><${Icon} name=${ligado ? 'circle-down' : 'download'} size=${20} /></span>
      <div>
        <h2>Este computador recebe</h2>
        <p class="sub">${ligado ? (lan?.rodando ? `Pronto para receber dos seus outros computadores${settings.lanOutros ? ' e de quem está por perto' : ''} (porta ${lan.porta}).` : 'Ligando…') : 'Desligado: os outros computadores não veem este.'}</p>
      </div>
      <${Switch} checked=${ligado} label="Este computador recebe" onChange=${(on) => salvar({ lanReceber: on })} />
    </div>
    ${ligado
      ? html`<div class="pc-pasta">
          <${Icon} name="folder" size=${15} />
          <span class="mono-path" title=${settings.lanPasta}>${tildify(settings.lanPasta, home)}</span>
          <${Button} size="sm" onClick=${async () => {
            const p = await pickFolderPath({ title: 'Onde chegam os arquivos?', defaultPath: settings.lanPasta })
            if (p) salvar({ lanPasta: p })
          }}>Trocar</${Button}>
          <button type="button" class="link-btn" onClick=${() => revealPath(settings.lanPasta)}>${revealLabel()}</button>
        </div>
        <div class="pc-outros">
          <div>
            <b>Aceitar de outras contas por perto</b>
            <span class="sub">Quem está na mesma rede com outra conta SOBEDESCE pode pedir para mandar. Nada chega sem você aceitar.</span>
          </div>
          <${Switch} checked=${!!settings.lanOutros} label="Aceitar de outras contas por perto" onChange=${(on) => salvar({ lanOutros: on })} />
        </div>`
      : null}
  </section>`
}

// Pedido de outra conta: aceita (e, se quiser, sobe pro Drive desta conta) ou recusa. Sem resposta em 5 min, cai.
function Pedido({ p, accountId }) {
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
  return html`<section class="card pc-pedido" role="alertdialog" aria-label=${`Pedido de ${p.pessoa || p.de}`}>
    <div class="pc-pedido-topo">
      <span class="pc-pedido-icon"><${Icon} name="circle-down" size=${22} /></span>
      <div>
        <h2>${p.pessoa ? `${p.pessoa} quer te mandar arquivos` : `${p.de} quer te mandar arquivos`}</h2>
        <p class="sub num">${p.pessoa ? `${p.de} · ` : ''}${plural(p.arquivos, 'arquivo', 'arquivos')} · ${bytes(p.bytes)} · pasta <b>${p.pasta}</b></p>
      </div>
    </div>
    <label class="dk-opcao">
      <${Checkbox} checked=${!!drive?.ligado} onChange=${async (on) => {
        if (on && !drive?.folder) {
          const f = await pickDriveFolder({ accountId, title: 'Em qual pasta do seu Drive?', initialFolderId: 'root' })
          if (!f) return
          setDrive({ ligado: true, folder: f })
        } else setDrive({ ...(drive || {}), ligado: on })
      }} label="Subir pro meu Drive quando chegar" />
      <span><b>Subir pro meu Drive quando chegar</b>${drive?.ligado && drive.folder ? html`<span class="sub"> · ${drive.folder.path || drive.folder.name} </span><button type="button" class="link-btn" onClick=${async () => {
        const f = await pickDriveFolder({ accountId, title: 'Em qual pasta do seu Drive?', initialFolderId: drive.folder.id })
        if (f) setDrive({ ligado: true, folder: f })
      }}>Trocar</button>` : html`<span class="sub"> · na sua conta, pela fila de Transferências</span>`}</span>
    </label>
    <div class="dk-go">
      <${Button} variant="primary" icon="check" onClick=${() => responder(true)} loading=${ocupado}>Aceitar</${Button}>
      <${Button} variant="ghost" onClick=${() => responder(false)} disabled=${ocupado}>Recusar</${Button}>
    </div>
  </section>`
}

function Recebendo({ lista }) {
  if (!lista?.length) return null
  return html`<section class="card pc-chegando">
    <h2>Chegando aqui</h2>
    <ul>
      ${lista.slice(0, 8).map((o) => {
        const frac = o.bytes ? Math.min(1, o.recebidos / o.bytes) : o.estado === 'recebendo' ? 0 : 1
        return html`<li class=${cx(`is-${o.estado}`)}>
          <div class="pc-chegando-linha">
            <b>${o.pasta}</b>
            <span class="sub">de ${o.pessoa ? `${o.pessoa} (${o.de})` : o.de} · ${plural(o.arquivos, 'arquivo', 'arquivos')} · ${bytes(o.bytes)}${o.drive ? ` · ${o.drive.estado?.startsWith('erro') ? 'Drive: não deu' : o.drive.estado ? 'Drive: na fila' : 'depois sobe pro Drive'}` : ''}</span>
            <span class="pc-chegando-estado">
              ${o.estado === 'recebendo' ? `${Math.floor(frac * 100)}%` : o.estado === 'pronta' ? 'Chegou tudo' : o.estado === 'cancelada' ? 'Cancelado' : `${o.prontos} de ${o.arquivos}`}
            </span>
            ${o.estado !== 'recebendo' ? html`<button type="button" class="link-btn" onClick=${() => revealPath(o.caminho)}>${revealLabel()}</button>` : null}
          </div>
          <div class="pc-barra"><i style=${`width:${(frac * 100).toFixed(1)}%`}></i></div>
        </li>`
      })}
    </ul>
  </section>`
}

function Envio({ e, pontos, onCancelar, onNovo }) {
  const frac = e.bytes ? Math.min(1, e.enviados / e.bytes) : e.fase === 'pronto' ? 1 : 0
  const fim = ['pronto', 'com-falhas', 'erro', 'cancelado'].includes(e.fase)
  if (fim) {
    const ok = e.fase === 'pronto'
    const media = e.decorrido > 0 ? e.enviados / e.decorrido : 0
    return html`<section class=${cx('card dk-fim', ok ? 'is-ok' : 'is-problema')}>
      <div class="dk-fim-topo">
        <span class="dk-fim-icon"><${Icon} name=${ok ? 'circle-check' : e.fase === 'cancelado' ? 'circle-x' : 'warning'} size=${26} /></span>
        <div>
          <h2>${ok ? `Chegou em ${e.para}` : e.fase === 'cancelado' ? 'Envio parado' : e.fase === 'erro' ? 'Não deu para mandar' : 'Chegou com problemas'}</h2>
          <p class="sub num">
            ${e.fase === 'erro' ? e.erro : html`${plural(e.prontos, 'arquivo conferido', 'arquivos conferidos')}${e.iguais ? ` · ${plural(e.iguais, 'já estava lá', 'já estavam lá')}` : ''} · ${bytes(e.enviados)} em ${duracao(e.decorrido)}${media ? ` · média ${bytes(media)}/s` : ''}`}
          </p>
          ${e.drive ? html`<p class="sub">${e.drive.ok === false ? `Drive: ${e.drive.erro}` : 'Drive: na fila de Transferências.'} ${e.drive.ok !== false ? html`<button type="button" class="link-btn" onClick=${() => navigate('transferencias')}>Ver</button>` : null}</p>` : null}
        </div>
      </div>
      ${e.falhas?.length ? html`<ul class="dk-falhas">${e.falhas.slice(0, 50).map((f) => html`<li><span class="mono-path">${f.relPath}</span><span class="sub">${f.erro}</span></li>`)}</ul>` : null}
      <div class="dk-go"><${Button} variant="primary" icon="plus" onClick=${onNovo}>Mandar mais</${Button}></div>
    </section>`
  }
  if (e.fase === 'aguardando') {
    return html`<section class="card pc-esperando" aria-live="polite">
      <span class="pc-pedido-icon"><${Icon} name="user" size=${22} /></span>
      <div>
        <h2>Esperando ${e.dono || e.para} aceitar…</h2>
        <p class="sub num">Pedido enviado para ${e.para}: ${plural(e.arquivos, 'arquivo', 'arquivos')} · ${bytes(e.bytes)}. Quando aceitar, a cópia começa sozinha.</p>
      </div>
      <${Button} variant="ghost" size="sm" icon="x" onClick=${onCancelar}>Desistir</${Button}>
    </section>`
  }
  return html`<section class="card dk-andamento" aria-live="polite">
    <div class="dk-and-topo">
      <div class="dk-anel" style=${`--p:${(frac * 100).toFixed(1)}`}><span class="num">${Math.floor(frac * 100)}<small>%</small></span></div>
      <div class="dk-and-txt">
        <h2>${e.fase === 'preparando' ? `Conectando com ${e.para}…` : e.fase === 'aguardando' ? `Esperando ${e.dono || e.para} aceitar…` : `Mandando para ${e.para}…`}</h2>
        <p class="sub num">${bytes(e.enviados)} de ${bytes(e.bytes)} · ${count(e.prontos)} de ${plural(Math.max(0, e.arquivos - e.iguais), 'arquivo', 'arquivos')}${e.endereco ? ` · pela rede (${e.endereco})` : ''}</p>
        ${e.atual ? html`<p class="mono-path dk-atual" title=${e.atual}>${e.atual}</p>` : null}
      </div>
      <${Button} variant="ghost" size="sm" icon="x" onClick=${onCancelar}>Parar</${Button}>
    </div>
    <div class="dk-nums">
      <${Velocidade} bps=${e.velocidade} rotulo="agora" />
      <${Velocidade} bps=${e.velocidadeMedia} rotulo="média" />
      <div class="dk-num"><span class="dk-num-v">${e.restante == null ? '—' : aprox(e.restante) || '—'}</span><span class="dk-num-l">faltam</span></div>
      <div class="dk-num"><span class="dk-num-v">${duracao(e.decorrido)}</span><span class="dk-num-l">passou</span></div>
    </div>
    <${Grafico} pontos=${pontos} />
  </section>`
}

export function ComputadoresScreen() {
  const lan = useStore((s) => s.lan)
  const settings = useStore((s) => s.settings)
  const cloud = useStore((s) => s.cloud)
  const accountId = useStore((s) => s.activeAccountId)
  const roots = useLocalRoots()
  const [lista, setLista] = useState(null)
  const [para, setPara] = usePersistentState('lan.para', null)
  const [origens, setOrigens] = useState([])
  const [pasta, setPasta] = useState('')
  const [drive, setDrive] = usePersistentState('lan.drive', null) // { ligado, folder: { id, name, path } }
  const [mandando, setMandando] = useState(false)
  const [sobre, setSobre] = useState(false)
  const [pontos, setPontos] = useState([])
  const e = lan?.envio
  const conectado = !!cloud?.conectado

  // Os computadores da conta e os de outras contas por perto: de novo a cada 15 s enquanto a tela está aberta.
  useEffect(() => {
    if (!conectado) return undefined
    let vivo = true
    const buscar = () =>
      api.get('/api/lan/computadores').then(
        (r) => vivo && setLista([...(r.computadores || []), ...(r.porPerto || [])]),
        () => vivo && setLista((l) => l || []),
      )
    buscar()
    const t = setInterval(buscar, 15_000)
    return () => {
      vivo = false
      clearInterval(t)
    }
  }, [conectado])
  useEffect(() => {
    if (e?.fase !== 'enviando') return
    setPontos((p) => [...p.slice(-59), e.velocidade || 0])
  }, [e?.enviados])

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
  const mandar = async () => {
    setMandando(true)
    setPontos([])
    await attempt(
      api.post('/api/lan/enviar', {
        para,
        origens,
        pasta: pasta.trim() || null,
        drive: drive?.ligado && drive.folder && accountId ? { accountId, folderId: drive.folder.id, folderName: drive.folder.name, driveId: drive.folder.driveId || null } : null,
      }),
    )
    setMandando(false)
  }
  const destino = lista?.find((c) => c.id === para) || null
  const ocupado = e && ['preparando', 'aguardando', 'enviando'].includes(e.fase)
  const nomePadrao = origens.length ? baseName(origens[0]) : ''

  return html`<div class="page page-computadores">
    <header class="page-head">
      <div>
        <h1>Dispositivos</h1>
        <p class="page-lead">Mande arquivos direto pela rede para outro computador (o seu ou o de quem está do lado) e para o seu celular. Criptografado e conferido.</p>
      </div>
    </header>

    ${!conectado
      ? html`<${EmptyState} title="Entre na sua conta SOBEDESCE" art=${html`<span class="src-icon dk-ic-org"><${Icon} name="laptop" size=${22} /></span>`}>
          Os computadores se acham pela sua conta. Entre nela em Ajustes, neste e no outro computador.
          <div class="dk-go" style="justify-content:center;margin-top:12px"><${Button} variant="primary" onClick=${() => navigate('ajustes')}>Abrir Ajustes</${Button}></div>
        </${EmptyState}>`
      : html`
          ${(lan?.pedidos || []).map((p) => html`<${Pedido} key=${p.id} p=${p} accountId=${accountId} />`)}
          <${Receber} lan=${lan} settings=${settings} home=${roots?.home} />
          <${Recebendo} lista=${lan?.recebendo} />
          <${CelularSecao} home=${roots?.home} />

          ${e
            ? html`<${Envio} e=${e} pontos=${pontos} onCancelar=${() => attempt(api.post('/api/lan/cancelar', {}))} onNovo=${() => {
                setOrigens([])
                setPasta('')
                setPontos([])
                attempt(api.post('/api/lan/limpar', {}))
              }} />`
            : null}

          ${!e
            ? html`<section class="card pc-mandar">
                <h2>Mandar para</h2>
                ${lista == null
                  ? html`<div class="pc-carregando"><${Spinner} size=${16} /> Procurando seus computadores…</div>`
                  : !lista.length
                    ? html`<p class="sub pc-vazio"><span>Nenhum computador com a recepção ligada. No outro computador, abra o SOBEDESCE e ligue <b>Este computador recebe</b> nesta tela. Se for de outra conta, ligue também <b>Aceitar de outras contas por perto</b>.</span></p>`
                    : html`${[
                        ['conta', 'Seus computadores'],
                        ['outro', 'Por perto, de outras contas'],
                      ].map(([tipo, titulo]) => {
                        const grupo = lista.filter((c) => (c.tipo || 'conta') === tipo)
                        if (!grupo.length) return null
                        return html`<div class="pc-grupo">
                          ${lista.some((c) => c.tipo === 'outro') ? html`<h3 class="pc-grupo-titulo">${titulo}</h3>` : null}
                          <div class="pc-lista" role="radiogroup" aria-label=${titulo}>
                            ${grupo.map(
                              (c) => html`<button type="button" role="radio" aria-checked=${para === c.id ? 'true' : 'false'} class=${cx('pc-comp', para === c.id && 'is-on', tipo === 'outro' && 'is-outro')} onClick=${() => setPara(c.id)}>
                                <span class="pc-comp-icon"><${Icon} name=${tipo === 'outro' ? 'user' : iconeDe(c.plataforma)} size=${20} /></span>
                                <span class="pc-comp-txt"><b>${c.nome}</b><span class="sub">${tipo === 'outro' && c.dono ? `de ${c.dono} · ` : ''}${c.plataforma === 'windows' ? 'Windows' : c.plataforma === 'mac' ? 'Mac' : 'Computador'} · visto ${relTime(Date.parse(c.vistoEm))}</span></span>
                                <span class="pc-online" aria-hidden="true"></span>
                              </button>`,
                            )}
                          </div>
                        </div>`
                      })}`}
                ${destino?.tipo === 'outro' ? html`<p class="sub pc-aviso-outro"><${Icon} name="info" size=${13} /> <span>${destino.dono || 'A pessoa'} recebe um pedido na tela e escolhe aceitar. Os arquivos chegam no ${destino.nome}${drive?.ligado ? '; o seu "Subir pro Drive" vai para a sua conta' : ''}.</span></p>` : null}

                <div
                  class=${cx('pc-drop', sobre && 'is-sobre', origens.length && 'tem')}
                  onDragOver=${(ev) => bridge && (ev.preventDefault(), setSobre(true))}
                  onDragLeave=${() => setSobre(false)}
                  onDrop=${soltar}
                >
                  ${origens.length
                    ? html`<ul class="pc-origens">
                        ${origens.map(
                          (o) => html`<li><${Icon} name="doc" size=${14} /><span class="mono-path" title=${o}>${tildify(o, roots?.home)}</span><button type="button" class="icon-btn" aria-label="Tirar" onClick=${() => setOrigens(origens.filter((x) => x !== o))}><${Icon} name="x" size=${13} /></button></li>`,
                        )}
                      </ul>`
                    : html`<p class="sub">${bridge ? 'Arraste arquivos e pastas para cá' : 'Escolha arquivos ou uma pasta'}</p>`}
                  <${Button} size="sm" icon="plus" onClick=${escolher}>${origens.length ? 'Adicionar' : 'Escolher arquivos ou pasta'}</${Button}>
                </div>

                <div class="dk-nome">
                  <label for="pc-pasta">Pasta no destino</label>
                  <input id="pc-pasta" class="input" type="text" maxlength="120" placeholder=${nomePadrao || 'Nome da pasta'} value=${pasta} onInput=${(ev) => setPasta(ev.currentTarget.value)} />
                  <span class="sub mono-path">${destino ? `${destino.nome} › Recebidos › ${pasta.trim() || nomePadrao || '…'}` : ''}</span>
                </div>

                <label class="dk-opcao">
                  <${Checkbox} checked=${!!drive?.ligado} onChange=${async (on) => {
                    if (on && !drive?.folder) {
                      const f = await pickDriveFolder({ accountId, title: 'Em qual pasta do Drive?', initialFolderId: 'root' })
                      if (!f) return
                      setDrive({ ligado: true, folder: f })
                    } else setDrive({ ...(drive || {}), ligado: on })
                  }} label="Subir pro Drive ao mesmo tempo" />
                  <span><b>Subir pro Drive ao mesmo tempo</b><span class="sub"> · os mesmos arquivos entram na fila de Transferências</span></span>
                </label>
                ${drive?.ligado && drive.folder
                  ? html`<div class="pc-pasta"><${Icon} name="cloud" size=${15} /><span>${drive.folder.path || drive.folder.name}</span><${Button} size="sm" onClick=${async () => {
                      const f = await pickDriveFolder({ accountId, title: 'Em qual pasta do Drive?', initialFolderId: drive.folder.id })
                      if (f) setDrive({ ligado: true, folder: f })
                    }}>Trocar</${Button}></div>`
                  : null}

                <div class="dk-go">
                  <${Button} variant="primary" size="lg" icon="arrow-right" onClick=${mandar} loading=${mandando} disabled=${!destino || !origens.length}>
                    ${destino ? `Mandar para ${destino.nome}` : 'Mandar'}
                  </${Button}>
                  <span class="sub">Na mesma rede (Wi-Fi ou cabo). Conferido arquivo por arquivo.</span>
                </div>
              </section>`
            : null}
        `}
  </div>`
}
