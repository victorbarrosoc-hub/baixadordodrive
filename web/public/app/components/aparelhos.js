// Aba Aparelhos: mandar e receber pelo Wi-Fi, direto entre os aparelhos (docs/CELULAR-WIFI.md, lib/p2p.js). Os da conta
// primeiro, embaixo as outras pessoas por perto, a chave "Aceitar de outras pessoas por perto" e como funciona.
import { html, useEffect, useRef } from '../vendor/preact-htm.js'
import { openSheet, useApp } from '../lib/state.js'
import { atualizarAparelhos, mandarPara, p2pAndando } from '../lib/p2p.js'
import { Icon } from './icons.js'
import { Item, Rotulo, Vazio } from './kit.js'
import { TopoMarca } from './main.js'
import { AceitarOutros, LinhaAparelho, LinhasAgora } from './p2p.js'

const COMO = [
  { icone: 'laptop', tom: 'down', titulo: 'Para o computador', sub: 'Chega na pasta “SOBEDESCE do celular”, em Downloads. Fica só no computador.' },
  { icone: 'phone', tom: 'up', titulo: 'Para outro celular', sub: 'Quem recebe toca em Aceitar e depois em Salvar (Fotos ou Arquivos).' },
  { icone: 'wifi', tom: 'ok', titulo: 'No mesmo Wi-Fi', sub: 'Os dois com a SOBEDESCE aberta. Nada passa pela internet.' },
]

export function AparelhosScreen({ active }) {
  const { aparelhos, envio, recebimento } = useApp((s) => s.p2p)
  const input = useRef(null)
  const para = useRef(null)
  useEffect(() => {
    if (active) atualizarAparelhos()
  }, [active])
  const escolher = (id) => {
    if (envio && p2pAndando(envio.fase)) return openSheet('p2pEnvio')
    para.current = id
    input.current.value = ''
    input.current.click()
  }
  const meus = aparelhos.filter((a) => a.conta !== 'outra')
  const outros = aparelhos.filter((a) => a.conta === 'outra')
  return html`<div class="screen ap-screen">
    <${TopoMarca} />
    <main class="ap-body">
      <header class="k-cabeca k-entra" style="--i:0">
        <div class="k-cabeca-txt">
          <h1>Aparelhos</h1>
          <p>Toque num aparelho para enviar fotos, vídeos e arquivos direto no Wi-Fi.</p>
        </div>
        <div class="k-cabeca-acoes">
          <button type="button" class="icon-btn" onClick=${() => atualizarAparelhos()} aria-label="Procurar aparelhos de novo">
            <${Icon} name="refresh" size=${20} strokeWidth=${1.9} />
          </button>
        </div>
      </header>

      ${envio || recebimento
        ? html`<section class="ap-grupo k-entra" style="--i:1" aria-label="Agora">
            <${Rotulo}>Agora</${Rotulo}>
            <div class="k-itens"><${LinhasAgora} /></div>
          </section>`
        : null}

      <section class="ap-grupo k-entra" style="--i:2" aria-label="Seus aparelhos">
        <${Rotulo}>Enviar para seus aparelhos</${Rotulo}>
        ${meus.length
          ? html`<div class="k-itens">${meus.map((a) => html`<${LinhaAparelho} key=${a.id} a=${a} onEscolher=${escolher} />`)}</div>`
          : html`<${Vazio} icone="wifi" titulo="Nenhum aparelho seu aberto agora">
              Abra a SOBEDESCE no computador ou em outro celular, no mesmo Wi-Fi. Ele aparece aqui sozinho.
            </${Vazio}>`}
      </section>

      ${outros.length
        ? html`<section class="ap-grupo k-entra" style="--i:3" aria-label="Por perto">
            <${Rotulo}>Enviar para quem está por perto</${Rotulo}>
            <div class="k-itens">${outros.map((a) => html`<${LinhaAparelho} key=${a.id} a=${a} onEscolher=${escolher} />`)}</div>
          </section>`
        : null}

      <div class="k-entra" style="--i:4"><${AceitarOutros} /></div>

      <section class="ap-grupo ap-como k-entra" style="--i:5" aria-label="Como funciona">
        <${Rotulo}>Como funciona</${Rotulo}>
        <div class="k-itens">${COMO.map((c) => html`<${Item} key=${c.titulo} icone=${c.icone} tom=${c.tom} titulo=${c.titulo} sub=${c.sub} />`)}</div>
      </section>

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
    </main>
  </div>`
}
