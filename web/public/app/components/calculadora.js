// Aba Criar → Calculadora: a mesma conta do app do computador e do site (lib/midia-conta.js e lib/midia-modos.js são
// cópias idênticas; test/midia-conta.test.js confere). Quanto cada câmera grava por hora, quantos cartões e HDs levar
// e o tempo de cópia, com a conta aberta. Os campos ficam guardados neste aparelho.
import { html, useMemo, useState } from '../vendor/preact-htm.js'
import { local } from '../lib/config.js'
import { calcular, comoOComputadorMostra, duracao, tamanho } from '../lib/midia-conta.js'
import { MODOS } from '../lib/midia-modos.js'
import { Icon } from './icons.js'
import { cx } from './ui.js'

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

function Seg({ value, options, onChange, label }) {
  return html`<div class="segmented" role="radiogroup" aria-label=${label}>
    ${options.map((o) => html`<button type="button" role="radio" aria-checked=${o.value === value ? 'true' : 'false'} class=${cx('segmented-opt', o.value === value && 'is-on')} onClick=${() => onChange(o.value)}>${o.label}</button>`)}
  </div>`
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
    <h2 class="cr-titulo">Calculadora</h2>
    <p class="cr-lead">Quanta mídia levar para o trabalho, com a conta aberta.</p>

    <section class="cr-card calc-res" aria-live="polite">
      ${r.linhas.length
        ? html`<div class="calc-kpis">
              <div><b>${r.totalCartoes}</b><span>${r.totalCartoes === 1 ? 'cartão' : 'cartões'} de ${tamanho(cartaoGB)}</span></div>
              <div><b>${tamanho(r.totalGB)}</b><span>de gravação</span></div>
              <div><b>${r.copias} × ${tamanho(r.totalGB)}</b><span>${r.copias === 1 ? 'HD de backup' : 'HDs (um por cópia)'}</span></div>
              <div><b>${r.tempoTotalS != null ? duracao(r.tempoTotalS) : '—'}</b><span>${r.tempoTotalS != null ? 'copiar e conferir' : 'diga a velocidade do leitor e do HD'}</span></div>
            </div>
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

    <h3 class="calc-sec">O que vai gravar</h3>
    ${cams.map((c, i) => {
      const modo = MODOS.find((m) => m.id === c.modo)
      return html`<section key=${c.id} class="cr-card calc-cam">
        <label class="cr-campo">
          <span>Câmera e modo</span>
          <select class="input" value=${c.modo} onChange=${(e) => muda(i, { ...c, modo: e.currentTarget.value })}>
            ${CAMERAS.map((cam) => html`<optgroup label=${cam}>${MODOS.filter((m) => m.camera === cam).map((m) => html`<option value=${m.id} selected=${m.id === c.modo}>${m.camera} · ${m.modo} · ${num(m.mbps)} Mb/s</option>`)}</optgroup>`)}
            <option value="manual" selected=${c.modo === 'manual'}>Outra: digitar o bitrate</option>
          </select>
          ${modo ? html`<small class="calc-fonte">Fonte: <a href=${modo.fonte} target="_blank" rel="noopener noreferrer">${modo.fonteNome}</a></small>` : null}
        </label>
        <div class="calc-dois">
          ${c.modo === 'manual'
            ? html`<label class="cr-campo"><span>Bitrate (Mb/s)</span><input class="input" inputmode="decimal" placeholder="ex.: 100" value=${c.mbps} onInput=${(e) => muda(i, { ...c, mbps: e.currentTarget.value })} /></label>`
            : null}
          <label class="cr-campo"><span>Horas gravando</span><input class="input" inputmode="decimal" value=${c.horas} onInput=${(e) => muda(i, { ...c, horas: e.currentTarget.value })} /></label>
        </div>
        ${cams.length > 1 ? html`<button type="button" class="link-btn calc-tirar" onClick=${() => setCams(cams.filter((_, j) => j !== i))}>Tirar esta câmera</button>` : null}
      </section>`
    })}
    <button type="button" class="cr-mais" onClick=${() => setCams([...cams, novaCamera()])}><${Icon} name="plus" size=${17} />Somar outra câmera</button>

    <h3 class="calc-sec">Cartões e backup</h3>
    <section class="cr-card">
      <div class="cr-linha">
        <span>Cartão<small>O de ${num(cartaoGB)} GB aparece com ~${num(mostra.windows)} GB no Windows e ${num(mostra.mac)} GB no Mac.</small></span>
        <${Seg} label="Cartão" value=${cartao} onChange=${setCartao} options=${CARTOES.map((g) => ({ value: String(g), label: g >= 1000 ? '1 TB' : `${g}` }))} />
      </div>
      <div class="cr-linha"><span>Margem</span><${Seg} label="Margem" value=${margem} onChange=${setMargem} options=${['0.1', '0.2', '0.3'].map((v) => ({ value: v, label: `${Number(v) * 100}%` }))} /></div>
      <div class="cr-linha"><span>Cópias de backup</span><${Seg} label="Cópias" value=${copias} onChange=${setCopias} options=${['1', '2', '3'].map((v) => ({ value: v, label: v === '1' ? '1 HD' : `${v} HDs` }))} /></div>
      <div class="calc-dois">
        <label class="cr-campo"><span>Leitor (MB/s)</span><input class="input" inputmode="decimal" placeholder="ex.: 280" value=${leitor} onInput=${(e) => setLeitor(e.currentTarget.value)} /></label>
        <label class="cr-campo"><span>HD mais lento (MB/s)</span><input class="input" inputmode="decimal" placeholder="ex.: 150" value=${hd} onInput=${(e) => setHd(e.currentTarget.value)} /></label>
      </div>
    </section>
  </div>`
}
