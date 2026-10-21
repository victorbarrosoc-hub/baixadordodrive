// Dispositivos → Celular (docs/CELULAR-WIFI.md): o app do celular manda e recebe direto pelo Wi-Fi, sem QR code e sem
// passar pela internet. Da mesma conta, entra sozinho; de outra pessoa por perto, só depois de Aceitar aqui. Nesta
// seção: ligar "Receber do celular" e "Aceitar de outras pessoas por perto", a pasta onde chega, os pedidos, os
// celulares abertos agora, "Mandar para o celular" e o que está passando (src/server/celular.js; o WebRTC roda na
// janela oculta).
import { html, useEffect, useState } from '/vendor/preact-htm.js'
import { useStore, setSettings } from '../lib/store.js'
import { api, attempt } from '../lib/api.js'
import { bytes, plural, speed, tildify } from '../lib/format.js'
import { cx } from '../lib/ui.js'
import { bridge, pickFolderPath, pickUploadPaths, revealLabel, revealPath } from '../lib/desktop.js'
import { Icon } from './icons.js'
import { Button, Switch } from './common.js'

const ATIVO = new Set(['esperando', 'conectando', 'andando'])

function estadoTexto(t) {
  if (t.estado === 'esperando') return 'Esperando o celular aceitar'
  if (t.estado === 'conectando') return 'Conectando…'
  if (t.estado === 'andando') {
    const frac = t.total ? t.feitos / t.total : 0
    return `${Math.floor(frac * 100)}%${t.velocidade ? ` · ${speed(t.velocidade)}` : ''}`
  }
  if (t.estado === 'pronto') return t.direcao === 'recebendo' ? 'Chegou tudo' : 'Foi tudo'
  if (t.estado === 'cancelado') return 'Cancelado'
  return t.erro || 'Parou'
}

const quem = (t) => (t.dono ? `${t.aparelho} (${t.dono})` : t.aparelho)

// Pedido de outra pessoa por perto: nada chega sem Aceitar. Sem resposta em 2 min, cai sozinho.
function Pedido({ p }) {
  const [ocupado, setOcupado] = useState(false)
  const responder = async (aceitar) => {
    setOcupado(true)
    await attempt(api.post('/api/celular/responder', { id: p.id, aceitar }))
    setOcupado(false)
  }
  const nomes = p.nomes?.length ? ` · ${p.nomes.join(', ')}${p.arquivos > p.nomes.length ? '…' : ''}` : ''
  return html`<div class="cel-pedido" role="alert">
    <span class="pc-comp-icon"><${Icon} name="user" size=${20} /></span>
    <div class="cel-pedido-txt">
      <b>${p.dono || 'Alguém por perto'} quer mandar ${plural(p.arquivos, 'arquivo', 'arquivos')}</b>
      <span class="sub">do ${p.nome} · ${bytes(p.bytes)}${nomes}</span>
    </div>
    <div class="cel-pedido-acoes">
      <${Button} size="sm" onClick=${() => responder(false)} disabled=${ocupado}>Recusar</${Button}>
      <${Button} size="sm" variant="primary" onClick=${() => responder(true)} loading=${ocupado}>Aceitar</${Button}>
    </div>
  </div>`
}

function Transferencia({ t }) {
  const frac = t.estado === 'pronto' ? 1 : t.total ? Math.min(1, t.feitos / t.total) : 0
  const ativo = ATIVO.has(t.estado)
  const nomes = t.nomes?.length ? `${t.nomes.join(', ')}${t.arquivos > t.nomes.length ? '…' : ''}` : ''
  return html`<li class=${cx(t.estado === 'pronto' ? 'is-pronta' : ativo ? 'is-recebendo' : `is-${t.estado}`)}>
    <div class="pc-chegando-linha">
      <b><${Icon} name=${t.direcao === 'recebendo' ? 'arrow-down' : 'arrow-up'} size=${13} /> ${t.direcao === 'recebendo' ? `Do ${quem(t)}` : `Para o ${quem(t)}`}</b>
      <span class="sub">${plural(t.arquivos, 'arquivo', 'arquivos')} · ${bytes(t.total)}${nomes ? ` · ${nomes}` : ''}</span>
      <span class="pc-chegando-estado">${estadoTexto(t)}</span>
      ${ativo
        ? html`<button type="button" class="link-btn" onClick=${() => attempt(api.post(`/api/celular/cancelar/${t.id}`, {}))}>Cancelar</button>`
        : t.direcao === 'recebendo' && t.estado === 'pronto'
          ? html`<button type="button" class="link-btn" onClick=${() => revealPath(t.primeiro || t.pasta)}>${revealLabel()}</button>`
          : null}
    </div>
    <div class="pc-barra"><i style=${`width:${(frac * 100).toFixed(1)}%`}></i></div>
  </li>`
}

export function CelularSecao({ home }) {
  const celular = useStore((s) => s.celular)
  const settings = useStore((s) => s.settings)
  const [mandando, setMandando] = useState(null)
  const ligado = !!settings?.celularReceber
  const lista = celular?.celulares || []
  const transferencias = celular?.transferencias || []
  const pronto = !!celular?.pronto

  // Pergunta ao site quem está aberto agora, de novo a cada 15 s enquanto a tela está aberta.
  useEffect(() => {
    let vivo = true
    const buscar = () => vivo && api.post('/api/celular/aparelhos', {}).catch(() => {})
    buscar()
    const t = setInterval(buscar, 15_000)
    return () => {
      vivo = false
      clearInterval(t)
    }
  }, [])

  const salvar = async (patch) => {
    const r = await attempt(api.patch('/api/settings', patch))
    if (r?.settings) setSettings(r.settings)
  }
  const mandar = async (c, ev) => {
    const caminhos = await pickUploadPaths({ title: `O que mandar para o ${c.dono ? `${c.nome} (${c.dono})` : c.nome}?`, anchor: ev?.currentTarget })
    if (!caminhos?.length) return
    setMandando(c.id)
    await attempt(api.post('/api/celular/enviar', { para: c.id, caminhos }))
    setMandando(null)
  }

  return html`<section class=${cx('card pc-receber pc-celular', ligado && 'is-on')}>
    <div class="pc-receber-topo">
      <span class="pc-receber-icon"><${Icon} name="phone" size=${20} /></span>
      <div>
        <h2>Celular</h2>
        <p class="sub">${ligado ? 'O app do celular, com a sua conta, manda direto para cá pelo Wi-Fi. Fica só neste computador, sem subir pro Drive.' : 'Desligado: o celular não manda para este computador.'}</p>
      </div>
      <${Switch} checked=${ligado} label="Receber do celular" onChange=${(on) => salvar({ celularReceber: on })} />
    </div>
    ${ligado
      ? html`<div class="pc-pasta">
          <${Icon} name="folder" size=${15} />
          <span class="mono-path" title=${settings.celularPasta}>${tildify(settings.celularPasta, home)}</span>
          <${Button} size="sm" onClick=${async () => {
            const p = await pickFolderPath({ title: 'Onde chegam os arquivos do celular?', defaultPath: settings.celularPasta })
            if (p) salvar({ celularPasta: p })
          }}>Trocar</${Button}>
          <button type="button" class="link-btn" onClick=${() => revealPath(settings.celularPasta)}>${revealLabel()}</button>
        </div>`
      : null}
    ${ligado
      ? html`<div class="pc-outros">
          <div>
            <b>Aceitar de outras pessoas por perto</b>
            <span class="sub">Quem está na mesma rede, com outra conta SOBEDESCE, pode pedir para mandar do celular. Nada chega sem você aceitar.</span>
          </div>
          <${Switch} checked=${!!settings.celularOutros} label="Aceitar de outras pessoas por perto" onChange=${(on) => salvar({ celularOutros: on })} />
        </div>`
      : null}

    ${(celular?.pedidos || []).map((p) => html`<${Pedido} key=${p.id} p=${p} />`)}

    <div class="pc-grupo">
      <h3 class="pc-grupo-titulo">Mandar para o celular</h3>
      ${!bridge || !pronto
        ? html`<p class="sub pc-vazio"><span>Só no app SOBEDESCE do computador. Se ele já está aberto, feche e abra de novo.</span></p>`
        : !lista.length
          ? html`<p class="sub pc-vazio"><span>Nenhum celular aberto agora. No celular, abra o SOBEDESCE (sobedesce.com/app) com a sua conta, no mesmo Wi-Fi deste computador.</span></p>`
          : [
              ['minha', 'Seus celulares'],
              ['outra', 'Por perto'],
            ].map(([conta, titulo]) => {
              const grupo = lista.filter((c) => (c.conta || 'minha') === conta)
              if (!grupo.length) return null
              return html`<div class="pc-grupo">
                ${lista.some((c) => c.conta === 'outra') ? html`<h3 class="pc-grupo-titulo">${titulo}</h3>` : null}
                <div class="pc-lista">
                  ${grupo.map(
                    (c) => html`<button type="button" class=${cx('pc-comp', conta === 'outra' && 'is-outro')} disabled=${mandando === c.id} onClick=${(ev) => mandar(c, ev)}>
                      <span class="pc-comp-icon"><${Icon} name=${conta === 'outra' ? 'user' : 'phone'} size=${20} /></span>
                      <span class="pc-comp-txt"><b>${conta === 'outra' && c.dono ? `${c.dono} · ${c.nome}` : c.nome}</b><span class="sub">${conta === 'outra' ? 'A pessoa aceita no celular · ' : c.mesmaRede ? 'Na mesma rede · ' : ''}Escolher arquivos ou pasta</span></span>
                      <span class="pc-online" aria-hidden="true"></span>
                    </button>`,
                  )}
                </div>
              </div>`
            })}
    </div>

    ${transferencias.length
      ? html`<div class="pc-chegando pc-celular-lista">
          <ul>
            ${transferencias.slice(0, 8).map((t) => html`<${Transferencia} key=${t.id} t=${t} />`)}
          </ul>
          ${transferencias.some((t) => !ATIVO.has(t.estado)) ? html`<button type="button" class="link-btn" onClick=${() => attempt(api.post('/api/celular/limpar', {}))}>Limpar a lista</button>` : null}
        </div>`
      : null}
    <p class="sub">Os dois precisam estar na mesma rede (Wi-Fi ou cabo). Mantenha o app aberto no celular enquanto passa.</p>
  </section>`
}
