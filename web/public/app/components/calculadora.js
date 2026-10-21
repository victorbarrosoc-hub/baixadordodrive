// Aba Criar → Calculadora: a mesma conta do app do computador e do site (lib/midia-conta.js e lib/midia-modos.js são
// cópias idênticas; test/midia-conta.test.js confere). Quanto cada câmera grava por hora, quantos cartões e HDs levar
// e o tempo de cópia, com a conta aberta. Os campos ficam guardados neste aparelho.
import { html, useMemo, useState } from '../vendor/preact-htm.js'
import { local } from '../lib/config.js'
import { calcular, comoOComputadorMostra, duracao, tamanho } from '../lib/midia-conta.js'
import { MODOS } from '../lib/midia-modos.js'
import { Icon } from './icons.js'
import { Destaque, Opcoes, Passo, Pilulas, Stats } from './kit.js'

const CARTOES = [64, 128, 256, 512, 1000]
const num = (n, casas = 1) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: casas }).format(n)
const lerNum = (s) => {
  const n = Number(String(s ?? '').replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}
const CAMERAS = [...new Set(MODOS.map((m) => m.camera))]
const novaCamera = () => ({ id: Math.random().toString(36).slice(2), modo: MODOS[0]?.id || 'manual', mbps: '', horas: '8' })

function useGuardado(chave, inicial) {
  const [v, setV] = useState(() => local.get(`sobedesce.calc.${chave}`, typeof inicial === 'function' ? inicial() : inicial))
  return [
    v,
    (x) => {
      setV(x)
      local.set(`sobedesce.calc.${chave}`, x)
    },
  ]
}

export function Calculadora() {
  const [cams, setCams] = useGuardado('cameras', () => [novaCamera()])
  const [cartao, setCartao] = useGuardado('cartao', '128')
  const [margem, setMargem] = useGuardado('margem', '0.2')
  const [copias, setCopias] = useGuardado('copias', '2')
  const [leitor, setLeitor] = useGuardado('leitor', '')
  const [hd, setHd] = useGuardado('hd', '')
  const [verConta, setVerConta] = useState(false)
  const cartaoGB = Number(cartao)
  const entrada = cams.map((c) => {
    const m = MODOS.find((x) => x.id === c.modo)
    return { nome: m ? `${m.camera} · ${m.modo}` : 'Bitrate digitado', mbps: m ? m.mbps : lerNum(c.mbps), horas: lerNum(c.horas) }
  })
  const r = useMemo(() => calcular({ cameras: entrada, cartaoGB, margem: Number(margem), copias: Number(copias), leitorMBs: lerNum(leitor), hdMBs: lerNum(hd) }), [JSON.stringify(entrada), cartaoGB, margem, copias, leitor, hd])
  const mostra = comoOComputadorMostra(cartaoGB)
  const muda = (i, c) => setCams(cams.map((x, j) => (j === i ? c : x)))

  return html`<div class="calc-cel">
    <header class="k-cabeca k-entra" style="--i:0">
      <div class="k-cabeca-txt">
        <h1>Calculadora</h1>
        <p>Quanta mídia levar para o trabalho, com a conta aberta.</p>
      </div>
    </header>

    <section class="calc-res k-entra" style="--i:1" aria-live="polite">
      ${r.linhas.length
        ? html`<${Destaque} titulo="Leve" numero=${r.totalCartoes} unidade=${`${r.totalCartoes === 1 ? 'cartão' : 'cartões'} de ${tamanho(cartaoGB)}`}>
              <div class="calc-sds" aria-hidden="true">${Array.from({ length: Math.min(r.totalCartoes, 24) }, (_, i) => html`<i style=${`--d:${i * 40}ms`}></i>`)}</div>
            </${Destaque}>
            <${Stats}
              colunas=${3}
              itens=${[
                { icone: 'film', valor: tamanho(r.totalGB), rotulo: 'de gravação' },
                { icone: 'disk', valor: `${r.copias} × ${tamanho(r.totalGB)}`, rotulo: r.copias === 1 ? 'HD de backup' : 'HDs, um por cópia', tom: 'up' },
                { icone: 'clock', valor: r.tempoTotalS != null ? duracao(r.tempoTotalS) : '—', rotulo: r.tempoTotalS != null ? 'copiar e conferir' : 'diga o leitor e o HD', tom: 'neutro' },
              ]}
            />
            <div class="calc-cams">
              ${r.linhas.map((l) => html`<div class="calc-l"><span>${l.nome}<small>${num(l.mbps)} Mb/s · ${num(l.horas)} h</small></span><b>${tamanho(l.gbh)}/h · ${duracao(l.horasPorCartao * 3600)} por cartão</b></div>`)}
            </div>
            <button type="button" class="link-btn calc-ver" aria-expanded=${verConta ? 'true' : 'false'} onClick=${() => setVerConta(!verConta)}>${verConta ? 'Esconder a conta' : 'Ver a conta, linha por linha'}</button>
            ${verConta
              ? html`<div class="calc-conta">
                  ${r.linhas.map((l) => html`<p>${l.nome}</p><ul>${l.conta.map((t) => html`<li>${t}</li>`)}</ul>`)}
                  <p>Trabalho</p>
                  <ul>${r.conta.map((t) => html`<li>${t}</li>`)}</ul>
                </div>`
              : null}`
        : html`<p class="calc-vazio">Escolha a câmera e as horas para ver a conta.</p>`}
    </section>

    <${Passo} n=${1} titulo="O que vai gravar" frase="Câmera, modo e quantas horas cada uma grava." i=${2}>
      ${cams.map((c, i) => {
        const modo = MODOS.find((m) => m.id === c.modo)
        return html`<div key=${c.id} class="calc-cam">
          <label class="cr-campo">
            <span>Câmera ${cams.length > 1 ? i + 1 : ''}</span>
            <select class="input" value=${c.modo} onChange=${(e) => muda(i, { ...c, modo: e.currentTarget.value })}>
              ${CAMERAS.map((cam) => html`<optgroup label=${cam}>${MODOS.filter((m) => m.camera === cam).map((m) => html`<option value=${m.id} selected=${m.id === c.modo}>${m.camera} · ${m.modo} · ${num(m.mbps)} Mb/s</option>`)}</optgroup>`)}
              <option value="manual" selected=${c.modo === 'manual'}>Outra: digitar o bitrate</option>
            </select>
            ${modo ? html`<small class="calc-fonte">Fonte: <a href=${modo.fonte} target="_blank" rel="noopener noreferrer">${modo.fonteNome}</a></small>` : null}
          </label>
          ${c.modo === 'manual'
            ? html`<label class="cr-campo"><span>Bitrate (Mb/s)</span><input class="input" inputmode="decimal" placeholder="ex.: 100" value=${c.mbps} onInput=${(e) => muda(i, { ...c, mbps: e.currentTarget.value })} /></label>`
            : null}
          <span class="k-rotulo">Horas gravando</span>
          <div class="calc-horas">
            <${Pilulas} label="Horas gravando" valor=${String(lerNum(c.horas) ?? '')} onEscolher=${(v) => muda(i, { ...c, horas: v })} itens=${['2', '4', '8', '10', '12'].map((h) => ({ value: h, label: `${h} h` }))} />
            <input class="input calc-horas-campo" inputmode="decimal" aria-label="Outras horas" value=${c.horas} onInput=${(e) => muda(i, { ...c, horas: e.currentTarget.value })} />
          </div>
          ${cams.length > 1 ? html`<button type="button" class="link-btn calc-tirar" onClick=${() => setCams(cams.filter((_, j) => j !== i))}>Tirar esta câmera</button>` : null}
        </div>`
      })}
      <button type="button" class="cr-mais" onClick=${() => setCams([...cams, novaCamera()])}><span class="cr-mais-ic"><${Icon} name="plus" size=${16} strokeWidth=${2.2} /></span>Somar outra câmera</button>
    </${Passo}>

    <${Passo} n=${2} titulo="Cartões e backup" frase="O cartão que você usa e quantas cópias de segurança." i=${3}>
      <span class="k-rotulo">Cartão</span>
      <${Pilulas} label="Cartão" valor=${cartao} onEscolher=${setCartao} itens=${CARTOES.map((g) => ({ value: String(g), label: g >= 1000 ? '1 TB' : `${g} GB` }))} />
      <p class="calc-nota"><${Icon} name="info" size=${14} />O de ${num(cartaoGB)} GB aparece com ~${num(mostra.windows)} GB no Windows e ${num(mostra.mac)} GB no Mac.</p>
      <span class="k-rotulo">Margem nos cartões</span>
      <${Pilulas} label="Margem" valor=${margem} onEscolher=${setMargem} itens=${['0.1', '0.2', '0.3'].map((v) => ({ value: v, label: `${Number(v) * 100}%` }))} />
      <span class="k-rotulo">Cópias de backup</span>
      <${Opcoes} label="Cópias" valor=${copias} onEscolher=${setCopias} itens=${['1', '2', '3'].map((v) => ({ value: v, titulo: v === '1' ? '1 HD' : `${v} HDs`, sub: v === '1' ? 'Uma cópia' : `${v} cópias`, icone: 'disk', up: true }))} />
      <span class="k-rotulo">Velocidade da cópia <small>opcional</small></span>
      <div class="calc-dois">
        <label class="cr-campo"><span>Leitor (MB/s)</span><input class="input" inputmode="decimal" placeholder="ex.: 280" value=${leitor} onInput=${(e) => setLeitor(e.currentTarget.value)} /></label>
        <label class="cr-campo"><span>HD mais lento (MB/s)</span><input class="input" inputmode="decimal" placeholder="ex.: 150" value=${hd} onInput=${(e) => setHd(e.currentTarget.value)} /></label>
      </div>
    </${Passo}>
  </div>`
}
