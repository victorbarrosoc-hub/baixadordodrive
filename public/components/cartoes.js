// Aba Cartões (docs/CARTOES.md). Por enquanto, a Calculadora de mídia: quanto cada câmera grava por hora, quanto cabe
// no cartão, quantos cartões levar, o tamanho dos HDs de backup e o tempo de cópia, com a conta aberta.
// A conta fica em lib/midia-conta.js (a mesma do site, sobedesce.com/calculadora); os modos prontos, com a fonte, em
// lib/midia-modos.js.
import { html, useMemo, useState } from '/vendor/preact-htm.js'
import { calcular, comoOComputadorMostra, duracao, gbPorHora, tamanho } from '../lib/midia-conta.js'
import { MODOS } from '../lib/midia-modos.js'
import { usePersistentState } from '../lib/ui.js'
import { Icon } from './icons.js'
import { Button, Segmented } from './common.js'

const CARTOES = [64, 128, 256, 512, 1000]
const num = (n, casas = 1) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: casas }).format(n)
const lerNum = (s) => {
  const n = Number(String(s ?? '').replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}
const camerasDosModos = () => [...new Set(MODOS.map((m) => m.camera))]
const novaCamera = () => ({ id: Math.random().toString(36).slice(2), modo: MODOS[0]?.id || 'manual', mbps: '', horas: '8' })

function LinhaCamera({ c, onChange, onRemove, podeRemover }) {
  const modo = MODOS.find((m) => m.id === c.modo)
  const cameras = camerasDosModos()
  return html`<div class="calc-cam">
    <label class="field calc-cam-modo">
      <span class="field-label">Câmera e modo</span>
      <span class="select calc-select">
        <select value=${c.modo} onChange=${(e) => onChange({ ...c, modo: e.currentTarget.value })}>
          ${cameras.map(
            (cam) => html`<optgroup label=${cam}>
              ${MODOS.filter((m) => m.camera === cam).map((m) => html`<option value=${m.id}>${m.modo} · ${num(m.mbps)} Mb/s</option>`)}
            </optgroup>`,
          )}
          <option value="manual">Outra: digitar o bitrate</option>
        </select>
        <${Icon} name="chevron-down" size=${12} />
      </span>
      ${modo
        ? html`<span class="field-hint">Fonte: <a href=${modo.fonte} target="_blank" rel="noopener noreferrer">${modo.fonteNome}</a>${modo.nota ? ` · ${modo.nota}` : ''}</span>`
        : null}
    </label>
    ${c.modo === 'manual'
      ? html`<label class="field calc-cam-num">
          <span class="field-label">Bitrate (Mb/s)</span>
          <input class="input" inputmode="decimal" placeholder="ex.: 100" value=${c.mbps} onInput=${(e) => onChange({ ...c, mbps: e.currentTarget.value })} />
        </label>`
      : null}
    <label class="field calc-cam-num">
      <span class="field-label">Horas gravando</span>
      <input class="input" inputmode="decimal" value=${c.horas} onInput=${(e) => onChange({ ...c, horas: e.currentTarget.value })} />
    </label>
    ${podeRemover
      ? html`<button type="button" class="icon-btn calc-cam-x" onClick=${onRemove} aria-label="Tirar esta câmera"><${Icon} name="x" size=${15} /></button>`
      : html`<span class="calc-cam-x"></span>`}
  </div>`
}

function Calculadora() {
  const [cams, setCams] = usePersistentState('calc.cameras', () => [novaCamera()])
  const [cartao, setCartao] = usePersistentState('calc.cartao', '128')
  const [cartaoOutro, setCartaoOutro] = usePersistentState('calc.cartaoOutro', '')
  const [margem, setMargem] = usePersistentState('calc.margem', '0.2')
  const [copias, setCopias] = usePersistentState('calc.copias', '2')
  const [leitor, setLeitor] = usePersistentState('calc.leitor', '')
  const [hd, setHd] = usePersistentState('calc.hd', '')
  const [verConta, setVerConta] = useState(false)

  const cartaoGB = cartao === 'outro' ? lerNum(cartaoOutro) : Number(cartao)
  const entrada = cams.map((c) => {
    const m = MODOS.find((x) => x.id === c.modo)
    return { nome: m ? `${m.camera} · ${m.modo}` : 'Câmera (bitrate digitado)', mbps: m ? m.mbps : lerNum(c.mbps), horas: lerNum(c.horas) }
  })
  const r = useMemo(
    () => (cartaoGB ? calcular({ cameras: entrada, cartaoGB, margem: Number(margem), copias: Number(copias), leitorMBs: lerNum(leitor), hdMBs: lerNum(hd) }) : null),
    [JSON.stringify(entrada), cartaoGB, margem, copias, leitor, hd],
  )
  const mostra = cartaoGB ? comoOComputadorMostra(cartaoGB) : null
  const muda = (i, c) => setCams(cams.map((x, j) => (j === i ? c : x)))

  return html`<div class="calc">
    <section class="card calc-in">
      <header class="card-head"><h3>O que vai gravar</h3></header>
      <div class="calc-body">
        ${cams.map(
          (c, i) => html`<${LinhaCamera} key=${c.id} c=${c} onChange=${(x) => muda(i, x)} onRemove=${() => setCams(cams.filter((_, j) => j !== i))} podeRemover=${cams.length > 1} />`,
        )}
        <${Button} size="sm" icon="plus" onClick=${() => setCams([...cams, novaCamera()])}>Somar outra câmera</${Button}>
      </div>
      <header class="card-head calc-sub"><h3>Cartões e backup</h3></header>
      <div class="calc-body calc-grid">
        <div class="field">
          <span class="field-label">Cartão</span>
          <${Segmented}
            label="Capacidade do cartão"
            size="sm"
            value=${cartao}
            onChange=${setCartao}
            options=${[...CARTOES.map((g) => ({ value: String(g), label: g >= 1000 ? `${g / 1000} TB` : `${g} GB` })), { value: 'outro', label: 'Outro' }]}
          />
          ${cartao === 'outro'
            ? html`<input class="input calc-outro" inputmode="decimal" placeholder="GB impressos no cartão" value=${cartaoOutro} onInput=${(e) => setCartaoOutro(e.currentTarget.value)} />`
            : null}
          ${mostra
            ? html`<span class="field-hint">O de ${num(cartaoGB)} GB aparece com cerca de ${num(mostra.windows)} GB no Windows e ${num(mostra.mac)} GB no Mac (um pouco menos depois de formatar). A conta usa os GB do fabricante.</span>`
            : null}
        </div>
        <div class="field">
          <span class="field-label">Margem nos cartões</span>
          <${Segmented} label="Margem" size="sm" value=${margem} onChange=${setMargem} options=${['0.1', '0.2', '0.3'].map((v) => ({ value: v, label: `${Number(v) * 100}%` }))} />
        </div>
        <div class="field">
          <span class="field-label">Cópias de backup</span>
          <${Segmented} label="Cópias" size="sm" value=${copias} onChange=${setCopias} options=${['1', '2', '3'].map((v) => ({ value: v, label: v === '1' ? '1 HD' : `${v} HDs` }))} />
        </div>
        <label class="field">
          <span class="field-label">Leitor de cartão (MB/s, se souber)</span>
          <input class="input" inputmode="decimal" placeholder="ex.: 280" value=${leitor} onInput=${(e) => setLeitor(e.currentTarget.value)} />
        </label>
        <label class="field">
          <span class="field-label">HD mais lento (MB/s, se souber)</span>
          <input class="input" inputmode="decimal" placeholder="ex.: 150" value=${hd} onInput=${(e) => setHd(e.currentTarget.value)} />
        </label>
      </div>
    </section>

    <section class="card calc-out" aria-live="polite">
      <header class="card-head"><h3>Leve</h3></header>
      ${r?.linhas.length
        ? html`<div class="calc-body">
            <div class="calc-kpis">
              <div class="calc-kpi"><b>${r.totalCartoes}</b><span>${r.totalCartoes === 1 ? 'cartão' : 'cartões'} de ${tamanho(cartaoGB)}</span></div>
              <div class="calc-kpi"><b>${tamanho(r.totalGB)}</b><span>de gravação</span></div>
              <div class="calc-kpi"><b>${r.copias} × ${tamanho(r.totalGB)}</b><span>${r.copias === 1 ? 'HD de backup' : 'HDs de backup (um por cópia)'}</span></div>
              <div class="calc-kpi">
                <b>${r.tempoTotalS != null ? duracao(r.tempoTotalS) : '—'}</b>
                <span>${r.tempoTotalS != null ? (r.tempoConferenciaS != null ? 'copiar e conferir (estimativa)' : 'copiar, sem a conferência (estimativa)') : 'de cópia: diga a velocidade do leitor e do HD'}</span>
              </div>
            </div>
            <table class="calc-tab">
              <thead><tr><th>Câmera</th><th>Por hora</th><th>Cabe no cartão</th><th>Cartões</th></tr></thead>
              <tbody>
                ${r.linhas.map(
                  (l) => html`<tr>
                    <td>${l.nome}<small>${num(l.mbps)} Mb/s · ${num(l.horas)} h</small></td>
                    <td class="calc-n">${tamanho(l.gbh)}</td>
                    <td class="calc-n">${duracao(l.horasPorCartao * 3600)}</td>
                    <td class="calc-n">${l.cartoes}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
            <${Button} variant="ghost" size="sm" class="calc-conta-btn" icon=${verConta ? 'chevron-up' : 'chevron-down'} onClick=${() => setVerConta(!verConta)} aria-expanded=${verConta ? 'true' : 'false'}>
              ${verConta ? 'Esconder a conta' : 'Ver a conta, linha por linha'}
            </${Button}>
            ${verConta
              ? html`<div class="calc-conta">
                  ${r.linhas.map((l) => html`<p class="calc-conta-tit">${l.nome}</p><ul>${l.conta.map((t) => html`<li>${t}</li>`)}</ul>`)}
                  <p class="calc-conta-tit">Trabalho</p>
                  <ul>${r.conta.map((t) => html`<li>${t}</li>`)}</ul>
                  <p class="field-hint">GB por hora = bitrate em Mb/s × 3.600 ÷ 8 ÷ 1.000. ${gbPorHora(100)} GB por hora a 100 Mb/s.</p>
                </div>`
              : null}
          </div>`
        : html`<div class="calc-body calc-vazio">Escolha a câmera e as horas para ver a conta.</div>`}
    </section>
  </div>`
}

export function CartoesScreen() {
  return html`<section class="page">
    <header class="page-head">
      <div>
        <h1>Cartões</h1>
        <p class="page-lead">Quanta mídia levar para o trabalho, com a conta aberta.</p>
      </div>
    </header>
    <${Calculadora} />
  </section>`
}

