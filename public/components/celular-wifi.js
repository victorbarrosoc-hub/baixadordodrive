// Dispositivos → o celular pelo Wi-Fi (docs/CELULAR-WIFI.md): o app do celular manda e recebe direto pela rede, sem QR
// code e sem passar pela internet. Da mesma conta, entra sozinho; de outra pessoa por perto, só depois de Aceitar aqui.
// Aqui ficam as peças do celular que a tela Dispositivos (components/computadores.js) usa: a lista de quem está aberto
// agora, o pedido de outra pessoa, o texto de cada transferência e o envio (src/server/celular.js; o WebRTC roda na
// janela oculta).
import { html, useEffect, useState } from '/vendor/preact-htm.js'
import { api, attempt } from '../lib/api.js'
import { bytes, plural, speed } from '../lib/format.js'
import { abrirAjustesRede } from '../lib/desktop.js'
import { Icon } from './icons.js'
import { Button } from './common.js'

export const CEL_ATIVO = new Set(['esperando', 'conectando', 'andando'])

export function estadoCelular(t) {
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

export const quemCelular = (t) => (t.dono && !String(t.aparelho || '').includes(t.dono) ? `${t.aparelho} (${t.dono})` : t.aparelho)

/** Pergunta ao site quem está com o app aberto agora, de novo a cada 15 s enquanto a tela está aberta. */
export function useCelularesAbertos() {
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
}

/** Manda os caminhos escolhidos para um celular (o app do celular pede para salvar cada arquivo). */
export function mandarParaCelular(id, caminhos) {
  return attempt(api.post('/api/celular/enviar', { para: id, caminhos }))
}

// Pedido de outra pessoa por perto: nada chega sem Aceitar. Sem resposta em 2 min, cai sozinho.
export function PedidoCelular({ p, i = 0 }) {
  const [ocupado, setOcupado] = useState(false)
  const responder = async (aceitar) => {
    setOcupado(true)
    await attempt(api.post('/api/celular/responder', { id: p.id, aceitar }))
    setOcupado(false)
  }
  const nomes = p.nomes?.length ? `${p.nomes.join(', ')}${p.arquivos > p.nomes.length ? '…' : ''}` : ''
  return html`<section class="dv-pedido k-entra" style=${`--i:${i}`} role="alertdialog" aria-label=${`Pedido de ${p.dono || p.nome}`}>
    <span class="dv-pedido-ic" aria-hidden="true"><${Icon} name="phone" size=${22} strokeWidth=${1.8} /></span>
    <div class="dv-pedido-txt">
      <span class="k-rot">Pedido pelo Wi-Fi</span>
      <h2>${p.dono || 'Alguém por perto'} quer te mandar ${plural(p.arquivos, 'arquivo', 'arquivos')}</h2>
      <p>do ${p.nome} · ${bytes(p.bytes)}${nomes ? ` · ${nomes}` : ''}</p>
    </div>
    <div class="dv-pedido-acoes">
      <${Button} onClick=${() => responder(false)} disabled=${ocupado}>Recusar</${Button}>
      <button type="button" class="k-botao dv-aceitar" onClick=${() => responder(true)} disabled=${ocupado}>
        <${Icon} name="check" size=${18} strokeWidth=${2} />Aceitar
      </button>
    </div>
  </section>`
}

// macOS 15+ sem a permissão de Rede Local (src/celular/rede-local.js): o celular acha o computador pelo site, mas a
// conexão direta nunca abre. Mostra onde ligar e confere de novo.
export function AvisoRedeLocal({ i = 0 }) {
  const [ocupado, setOcupado] = useState(false)
  const conferir = async () => {
    setOcupado(true)
    await attempt(api.post('/api/celular/aparelhos', {}))
    setOcupado(false)
  }
  return html`<section class="dv-pedido is-aviso k-entra" style=${`--i:${i}`} role="alert" aria-label="Rede local bloqueada">
    <span class="dv-pedido-ic" aria-hidden="true"><${Icon} name="warning" size=${22} strokeWidth=${1.8} /></span>
    <div class="dv-pedido-txt">
      <span class="k-rot">Wi-Fi com o celular</span>
      <h2>O Mac está bloqueando a rede local para o SOBEDESCE</h2>
      <p>Sem isso, o celular acha este computador mas não conecta. Em Ajustes do Sistema → Privacidade e Segurança → Rede Local, ligue o SOBEDESCE.</p>
    </div>
    <div class="dv-pedido-acoes">
      <${Button} onClick=${conferir} disabled=${ocupado}>Conferir de novo</${Button}>
      <button type="button" class="k-botao dv-aceitar" onClick=${() => abrirAjustesRede()}>
        <${Icon} name="sliders" size=${18} strokeWidth=${2} />Abrir Ajustes
      </button>
    </div>
  </section>`
}

// Firewall do macOS ligado sem "Permitir" para o SOBEDESCE (src/celular/firewall.js): o celular manda as checagens para
// o IP do Mac e elas são recusadas.
export function AvisoFirewall({ fw, i = 0 }) {
  const [ocupado, setOcupado] = useState(false)
  const conferir = async () => {
    setOcupado(true)
    await attempt(api.post('/api/celular/aparelhos', {}))
    setOcupado(false)
  }
  return html`<section class="dv-pedido is-aviso k-entra" style=${`--i:${i}`} role="alert" aria-label="Firewall bloqueando">
    <span class="dv-pedido-ic" aria-hidden="true"><${Icon} name="shield" size=${22} strokeWidth=${1.8} /></span>
    <div class="dv-pedido-txt">
      <span class="k-rot">Wi-Fi com o celular</span>
      <h2>${fw.bloquearTudo ? 'O Firewall do Mac está bloqueando todas as conexões' : 'O Firewall do Mac não deixa o SOBEDESCE receber conexões'}</h2>
      <p>${fw.bloquearTudo
        ? 'Em Ajustes do Sistema → Rede → Firewall → Opções, desligue “Bloquear todas as conexões de entrada”.'
        : 'Em Ajustes do Sistema → Rede → Firewall → Opções, clique em +, escolha o SOBEDESCE em Aplicativos e deixe “Permitir conexões de entrada”.'}</p>
    </div>
    <div class="dv-pedido-acoes">
      <${Button} onClick=${conferir} disabled=${ocupado}>Conferir de novo</${Button}>
      <button type="button" class="k-botao dv-aceitar" onClick=${() => abrirAjustesRede('firewall')}>
        <${Icon} name="sliders" size=${18} strokeWidth=${2} />Abrir Ajustes
      </button>
    </div>
  </section>`
}

/** A última vez que um celular tentou e a ligação direta não abriu (com o que cada lado anunciou). */
export function FalhaCelular({ f, i = 0 }) {
  return html`<p class="k-nota dv-falha k-entra" style=${`--i:${i}`} role="status">
    <${Icon} name="warning" size=${14} /> <span><b>O celular tentou e não conectou.</b> ${f.erro}</span>
  </p>`
}
