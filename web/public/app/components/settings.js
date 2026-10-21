// Conta e Ajustes: qual Drive recebe, espaço nele, a conta SOBEDESCE e o tipo de rede (que define quantos arquivos
// sobem juntos e o tamanho do pedaço).
import { html, useState } from '../vendor/preact-htm.js'
import { ACCOUNT, CHUNK_AUTO, DEV, LAN, VERSION, getSettings, saveSettings } from '../lib/config.js'
import { bytes, percent } from '../lib/format.js'
import { fraction, isActive } from '../lib/computador.js'
import { closeSheet, openSheet, useApp } from '../lib/state.js'
import { engine } from '../lib/uploader.js'
import { Icon } from './icons.js'
import { SheetHead } from './ui.js'
import { Barra, Linha, Linhas, Opcoes, Passo } from './kit.js'
import { Avatar } from './main.js'
import { AceitarOutros } from './p2p.js'

function Storage({ quota }) {
  if (!quota) return null
  const usage = Number(quota.usage) || 0
  const limit = quota.limit != null ? Number(quota.limit) : null
  const frac = limit ? Math.min(1, usage / limit) : 0
  return html`<div class="k-espaco">
    <div class="k-espaco-num"><b>${limit ? bytes(Math.max(0, limit - usage)) : bytes(usage)}</b><span>${limit ? 'livres' : 'usados · sem limite'}</span></div>
    ${limit ? html`<${Barra} p=${frac} tom=${frac > 0.9 ? 'erro' : null} label="Espaço usado no Drive" />` : null}
    ${limit ? html`<span class="k-espaco-sub">${bytes(usage)} de ${bytes(limit)} usados</span>` : null}
  </div>`
}

// Uma escolha só, no lugar de "arquivos ao mesmo tempo" e "tamanho do pedaço": por baixo, os mesmos valores que o
// motor de envio usa. Automático (o padrão) mede a rede e escolhe o pedaço sozinho; as outras duas são tamanhos
// fixos para quem prefere. Quem tinha valores salvos à mão: 3 ou mais arquivos juntos conta como Wi-Fi rápido.
const NETWORKS = {
  auto: { label: 'Automático', curto: 'Mede a rede', icone: 'gauge', help: 'Mede a rede e ajusta o tamanho de cada pedaço.', concurrency: 2, chunkMiB: CHUNK_AUTO },
  mobile: { label: 'Celular', curto: '4G e 5G', icone: 'phone', help: 'Pedaços pequenos: mais estável no 4G e 5G.', concurrency: 2, chunkMiB: 8 },
  wifi: { label: 'Wi-Fi rápido', curto: 'Rede boa', icone: 'wifi', help: 'Mais arquivos ao mesmo tempo, para rede boa.', concurrency: 4, chunkMiB: 16 },
}
const networkOf = (s) => (s.chunkMiB === CHUNK_AUTO ? 'auto' : s.concurrency >= 3 ? 'wifi' : 'mobile')

/** A linha de "No computador" em Ajustes: sempre aparece, mesmo sem nada nas últimas 24 h. */
function pcSummary(pcs = []) {
  const ativo = pcs.find((pc) => isActive(pc))
  if (ativo) return `${ativo.nome} · ${percent(fraction(ativo.snapshot))}`
  if (pcs.length) return pcs.length === 1 ? `${pcs[0].nome} · nada passando agora` : `${pcs.length} computadores · nada passando agora`
  return 'Acompanhe o app do computador'
}

export function SettingsSheet() {
  const { user, quota, lan, account, drives, pcs } = useApp((s) => ({ user: s.user, quota: s.quota, lan: s.lan, account: s.account, drives: s.drives, pcs: s.pc.computadores }))
  const [settings, setSettings] = useState(getSettings())
  const network = networkOf(settings)

  const update = (patch) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    saveSettings(next)
    engine.pump()
  }

  return html`<${SheetHead}
      title="Ajustes"
      right=${html`<button type="button" class="link-btn is-strong" onClick=${closeSheet}>OK</button>`}
    />
    <div class="sheet-body sheet-scroll settings k-folha">
      <${Passo} icone=${LAN ? 'wifi' : 'drive'} cor="down" titulo=${user?.displayName || 'Google Drive'} frase=${user?.emailAddress || (LAN ? `Pelo ${LAN.label} “${lan?.mac || LAN.mac}”` : 'O Drive que recebe os envios')} i=${0}
        acao=${html`<${Avatar} user=${user} size=${40} />`}
      >
        ${quota ? html`<${Storage} quota=${quota} />` : null}
      </${Passo}>

      <${Passo} icone="bolt" cor="up" titulo="Envio" frase=${NETWORKS[network].help} i=${1}>
        <${Opcoes}
          label="Sua rede"
          valor=${network}
          onEscolher=${(v) => update({ concurrency: NETWORKS[v].concurrency, chunkMiB: NETWORKS[v].chunkMiB })}
          itens=${Object.entries(NETWORKS).map(([value, n]) => ({ value, titulo: n.label, sub: n.curto, icone: n.icone, up: true }))}
        />
      </${Passo}>

      ${LAN
        ? html`<${Passo} icone="wifi" cor="ok" titulo="Wi-Fi" i=${2}>
            <p class="k-texto">
              Os arquivos vão deste celular para o ${LAN.label} pela rede local, e o SOBEDESCE de lá sobe pro Drive na conta
              acima${lan?.deleteAfterUpload ? ' (e apaga a cópia do computador depois de conferir)' : ''}. A pasta padrão e a conta
              se trocam no computador, em Ajustes → Celular.
            </p>
          </${Passo}>`
        : html`<${Passo} icone="laptop" cor="down" titulo="No computador" i=${2}>
            <${Linhas}>
              <${Linha} icone="transfers" titulo="Transferências do computador" sub=${pcSummary(pcs)} onClick=${() => openSheet('computador')} />
            </${Linhas}>
          </${Passo}>
          <${Passo} icone="users" cor="warn" titulo="No Wi-Fi" i=${3}>
            <${AceitarOutros} />
          </${Passo}>
          <${Passo} icone="user" cor="up" titulo="Conta SOBEDESCE" frase="Drives, computadores conectados e sair ficam na sua conta." i=${4}>
            <${Linhas}>
              <${Linha} icone="drive" titulo=${drives.length > 1 ? 'Trocar de Google Drive' : 'Google Drive'} onClick=${() => openSheet('drives')} />
              <a class="k-linha is-botao" href=${ACCOUNT.manage}>
                <span class="k-linha-ic" style="--c:var(--up)"><${Icon} name="user" size=${17} strokeWidth=${1.8} /></span>
                <span class="k-linha-txt"><b>Minha conta</b>${account?.email ? html`<span>${account.email}</span>` : null}</span>
                <span class="k-linha-ctl"><${Icon} name="chevron-right" size=${16} class="k-seta" /></span>
              </a>
            </${Linhas}>
          </${Passo}>`}

      <p class="foot">
        SOBEDESCE Celular ${VERSION}${DEV ? ' · modo de teste' : LAN ? ' · pelo Wi-Fi' : ''}<br />${LAN
          ? 'Nada passa pela internet até o computador; de lá, direto pro Google.'
          : 'Os arquivos vão direto deste aparelho para o Google.'}
      </p>
    </div>`
}
SettingsSheet.label = 'Ajustes'
SettingsSheet.tall = false
