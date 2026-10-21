// Aba Cartões (docs/CARTOES.md): o Backup Automático (components/backup.js; espete o cartão e ele passa sozinho,
// organizado por diária e por dono) e a Calculadora de mídia: quanto cada câmera grava por hora, quanto cabe no
// cartão, quantos cartões levar, o tamanho dos HDs de backup e o tempo de cópia, com a conta aberta.
// A conta fica em lib/midia-conta.js (a mesma do site, sobedesce.com/calculadora); os modos prontos, com a fonte, em
// lib/midia-modos.js.
import { html, useEffect, useMemo, useRef, useState } from '/vendor/preact-htm.js'
import { calcular, comoOComputadorMostra, duracao, gbPorHora, tamanho } from '../lib/midia-conta.js'
import { MODOS } from '../lib/midia-modos.js'
import { cx, usePersistentState } from '../lib/ui.js'
import { Icon } from './icons.js'
import { Opcoes } from './kit.js'
import { BackupPanel } from './backup.js'

const CARTOES = [64, 128, 256, 512, 1000]
const num = (n, casas = 1) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: casas }).format(n)
const lerNum = (s) => {
  const n = Number(String(s ?? '').replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}
const camerasDosModos = () => [...new Set(MODOS.map((m) => m.camera))]
const novaCamera = () => ({ id: Math.random().toString(36).slice(2), modo: MODOS[0]?.id || 'manual', mbps: '', horas: '8' })

// Uma cor por câmera (no gráfico e nos cartões desenhados).
const CORES = ['var(--down)', 'var(--up)', 'var(--ok)', 'var(--warn)', '#ff375f', '#64d2ff']
const HORAS = [2, 4, 8, 10, 12]

/** O número anda até o valor novo (em vez de trocar de uma vez). */
function useContagem(alvo, ms = 650) {
  const [v, setV] = useState(alvo)
  const de = useRef(alvo)
  useEffect(() => {
    if (!Number.isFinite(alvo)) return setV(alvo)
    const ini = de.current
    if (ini === alvo || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      de.current = alvo
      return setV(alvo)
    }
    const t0 = performance.now()
    let raf = 0
    const passo = (t) => {
      const k = Math.min(1, (t - t0) / ms)
      const e = 1 - (1 - k) ** 3
      const x = ini + (alvo - ini) * e
      de.current = x
      setV(x)
      if (k < 1) raf = requestAnimationFrame(passo)
    }
    raf = requestAnimationFrame(passo)
    return () => cancelAnimationFrame(raf)
  }, [alvo])
  return v
}

function Contagem({ valor, casas = 0, fmt }) {
  const v = useContagem(valor)
  return fmt ? fmt(v) : num(v, casas)
}

/** O cartão desenhado (SD), cheio até `uso` (0 a 1). */
function CartaoSD({ uso, cor, i }) {
  return html`<span class="ct-sd" style=${`--uso:${Math.round(uso * 100)}%;--cor:${cor};--i:${i}`} aria-hidden="true"><i></i></span>`
}

/** Os HDs desenhados (1, 2 ou 3 de pé). */
function HDs({ n }) {
  return html`<span class="ct-hds" aria-hidden="true">${Array.from({ length: n }, (_, i) => html`<i style=${`--i:${i}`}></i>`)}</span>`
}

function CameraCard({ c, i, onChange, onRemove, podeRemover }) {
  const modo = MODOS.find((m) => m.id === c.modo)
  const cameras = camerasDosModos()
  const horas = lerNum(c.horas) || 0
  const muda = (h) => onChange({ ...c, horas: String(Math.max(0.5, Math.round(h * 2) / 2)).replace('.', ',') })
  return html`<div class="ct-cam" style=${`--cor:${CORES[i % CORES.length]}`}>
    <div class="ct-cam-top">
      <span class="ct-cam-ic"><${Icon} name="film" size=${18} /></span>
      <label class="ct-cam-modo">
        <span class="ct-rot">Câmera ${i + 1}</span>
        <span class="select calc-select">
          <select value=${c.modo} onChange=${(e) => onChange({ ...c, modo: e.currentTarget.value })} aria-label="Câmera e modo">
            ${cameras.map(
              (cam) => html`<optgroup label=${cam}>
                ${MODOS.filter((m) => m.camera === cam).map((m) => html`<option value=${m.id}>${m.camera} · ${m.modo} · ${num(m.mbps)} Mb/s</option>`)}
              </optgroup>`,
            )}
            <option value="manual">Outra: digitar o bitrate</option>
          </select>
          <${Icon} name="chevron-down" size=${12} />
        </span>
      </label>
      ${podeRemover ? html`<button type="button" class="icon-btn ct-cam-x" onClick=${onRemove} aria-label="Tirar esta câmera" title="Tirar esta câmera"><${Icon} name="x" size=${15} /></button>` : null}
    </div>
    ${modo
      ? html`<p class="ct-fonte"><b>${num(modo.mbps)} Mb/s</b> · Fonte: <a href=${modo.fonte} target="_blank" rel="noopener noreferrer">${modo.fonteNome}</a>${modo.nota ? ` · ${modo.nota}` : ''}</p>`
      : html`<label class="ct-bitrate"><span class="ct-rot">Bitrate</span><span class="ct-unid"><input class="input" inputmode="decimal" placeholder="ex.: 100" value=${c.mbps} onInput=${(e) => onChange({ ...c, mbps: e.currentTarget.value })} /><em>Mb/s</em></span></label>`}
    <div class="ct-horas">
      <span class="ct-rot">Horas gravando</span>
      <div class="ct-horas-ctl">
        <div class="ct-passo">
          <button type="button" onClick=${() => muda(horas - 1)} aria-label="Uma hora a menos"><${Icon} name="minus" size=${14} /></button>
          <input class="ct-passo-v" inputmode="decimal" aria-label="Horas gravando" value=${c.horas} onInput=${(e) => onChange({ ...c, horas: e.currentTarget.value })} />
          <button type="button" onClick=${() => muda(horas + 1)} aria-label="Uma hora a mais"><${Icon} name="plus" size=${14} /></button>
        </div>
        <div class="ct-chips">${HORAS.map((h) => html`<button type="button" class=${cx('ct-chip', horas === h && 'is-on')} onClick=${() => muda(h)}>${h} h</button>`)}</div>
      </div>
    </div>
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
  // Os cartões desenhados: cada câmera enche os dela (o último, até onde a gravação chega).
  const sds = []
  if (r?.linhas.length)
    entrada
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.mbps > 0 && e.horas > 0)
      .forEach(({ i }, k) => {
        const l = r.linhas[k]
        for (let j = 0; j < l.cartoes; j++) sds.push({ uso: Math.max(0.06, Math.min(1, (l.gb - j * cartaoGB) / cartaoGB)), cor: CORES[i % CORES.length] })
      })
  const maxGB = r?.linhas.length ? Math.max(...r.linhas.map((l) => l.gb)) : 1
  const corDaLinha = (k) => {
    const idx = entrada.map((e, i) => ({ e, i })).filter(({ e }) => e.mbps > 0 && e.horas > 0)[k]?.i ?? k
    return CORES[idx % CORES.length]
  }

  return html`<div class="ct">
    <div class="ct-in">
      <section class="ct-bloco">
        <header class="ct-bloco-head"><span class="ct-bloco-n">1</span><div><h2>O que vai gravar</h2><p>Câmera, modo e quantas horas cada uma grava.</p></div></header>
        <div class="ct-cams">
          ${cams.map((c, i) => html`<${CameraCard} key=${c.id} c=${c} i=${i} onChange=${(x) => muda(i, x)} onRemove=${() => setCams(cams.filter((_, j) => j !== i))} podeRemover=${cams.length > 1} />`)}
          <button type="button" class="ct-mais" onClick=${() => setCams([...cams, novaCamera()])}><span><${Icon} name="plus" size=${16} /></span>Somar outra câmera</button>
        </div>
      </section>

      <section class="ct-bloco">
        <header class="ct-bloco-head"><span class="ct-bloco-n">2</span><div><h2>Cartões e backup</h2><p>O cartão que você usa e quantas cópias de segurança.</p></div></header>
        <span class="ct-rot">Cartão</span>
        <div class="ct-opcoes" role="radiogroup" aria-label="Capacidade do cartão">
          ${[...CARTOES.map((g) => ({ v: String(g), t: g >= 1000 ? `${g / 1000} TB` : `${g} GB` })), { v: 'outro', t: 'Outro' }].map(
            (o) => html`<button type="button" role="radio" aria-checked=${cartao === o.v ? 'true' : 'false'} class=${cx('ct-op', cartao === o.v && 'is-on')} onClick=${() => setCartao(o.v)}>
              <${CartaoSD} uso=${cartao === o.v ? 1 : 0.35} cor="var(--down)" i=${0} />
              <b>${o.t}</b>
            </button>`,
          )}
        </div>
        ${cartao === 'outro' ? html`<span class="ct-unid ct-outro"><input class="input" inputmode="decimal" placeholder="GB impressos no cartão" value=${cartaoOutro} onInput=${(e) => setCartaoOutro(e.currentTarget.value)} /><em>GB</em></span>` : null}
        ${mostra ? html`<p class="ct-nota"><${Icon} name="info" size=${13} />No Windows aparece ~${num(mostra.windows)} GB; no Mac, ${num(mostra.mac)} GB. A conta usa os GB do fabricante.</p>` : null}

        <div class="ct-dupla">
          <div class="ct-campo">
            <span class="ct-rot">Margem nos cartões</span>
            <div class="ct-chips">${['0.1', '0.2', '0.3'].map((v) => html`<button type="button" class=${cx('ct-chip', margem === v && 'is-on')} onClick=${() => setMargem(v)}>${Number(v) * 100}%</button>`)}</div>
          </div>
          <div class="ct-campo">
            <span class="ct-rot">Cópias de backup</span>
            <div class="ct-opcoes is-hd" role="radiogroup" aria-label="Cópias de backup">
              ${['1', '2', '3'].map(
                (v) => html`<button type="button" role="radio" aria-checked=${copias === v ? 'true' : 'false'} class=${cx('ct-op is-hd', copias === v && 'is-on')} onClick=${() => setCopias(v)}>
                  <${HDs} n=${Number(v)} /><b>${v === '1' ? '1 HD' : `${v} HDs`}</b>
                </button>`,
              )}
            </div>
          </div>
        </div>

        <div class="ct-dupla">
          <label class="ct-campo"><span class="ct-rot">Leitor de cartão <small>se souber</small></span><span class="ct-unid"><input class="input" inputmode="decimal" placeholder="ex.: 280" value=${leitor} onInput=${(e) => setLeitor(e.currentTarget.value)} /><em>MB/s</em></span></label>
          <label class="ct-campo"><span class="ct-rot">HD mais lento <small>se souber</small></span><span class="ct-unid"><input class="input" inputmode="decimal" placeholder="ex.: 150" value=${hd} onInput=${(e) => setHd(e.currentTarget.value)} /><em>MB/s</em></span></label>
        </div>
      </section>
    </div>

    <aside class="ct-out" aria-live="polite">
      ${r?.linhas.length
        ? html`<div class="ct-res">
            <div class="ct-hero">
              <span class="ct-hero-tit">Leve</span>
              <div class="ct-hero-num"><b><${Contagem} valor=${r.totalCartoes} /></b><span>${r.totalCartoes === 1 ? 'cartão' : 'cartões'} de ${tamanho(cartaoGB)}</span></div>
              <div class="ct-sds">${sds.slice(0, 24).map((x, i) => html`<${CartaoSD} key=${`${i}-${sds.length}`} uso=${x.uso} cor=${x.cor} i=${i} />`)}${sds.length > 24 ? html`<em>+${sds.length - 24}</em>` : null}</div>
            </div>
            <div class="ct-kpis">
              <div class="ct-kpi is-azul"><span class="ct-kpi-ic"><${Icon} name="film" size=${16} /></span><b><${Contagem} valor=${r.totalGB} fmt=${tamanho} /></b><span>de gravação</span></div>
              <div class="ct-kpi is-roxo"><span class="ct-kpi-ic"><${Icon} name="copy" size=${16} /></span><b>${r.copias} × <${Contagem} valor=${r.totalGB} fmt=${tamanho} /></b><span>${r.copias === 1 ? 'HD de backup' : 'HDs, um por cópia'}</span></div>
              <div class=${cx('ct-kpi', r.tempoTotalS != null ? 'is-verde' : 'is-vazio')}>
                <span class="ct-kpi-ic"><${Icon} name="clock" size=${16} /></span>
                <b>${r.tempoTotalS != null ? html`<${Contagem} valor=${r.tempoTotalS} fmt=${(v) => duracao(v)} />` : '—'}</b>
                <span>${r.tempoTotalS != null ? (r.tempoConferenciaS != null ? 'copiar e conferir' : 'copiar (sem conferir)') : 'de cópia: diga o leitor e o HD'}</span>
              </div>
            </div>
            <div class="ct-grafico">
              <p class="ct-grafico-tit">Por câmera</p>
              ${r.linhas.map(
                (l, k) => html`<div class="ct-barra" style=${`--cor:${corDaLinha(k)};--w:${Math.max(4, (l.gb / maxGB) * 100)}%`}>
                  <div class="ct-barra-top"><b>${l.nome}</b><span>${tamanho(l.gb)}</span></div>
                  <div class="ct-barra-trilho"><i></i></div>
                  <div class="ct-barra-pe"><span>${tamanho(l.gbh)} por hora</span><span>${duracao(l.horasPorCartao * 3600)} por cartão</span><span><b>${l.cartoes}</b> ${l.cartoes === 1 ? 'cartão' : 'cartões'}</span></div>
                </div>`,
              )}
            </div>
            <button type="button" class="ct-conta-btn" aria-expanded=${verConta ? 'true' : 'false'} onClick=${() => setVerConta(!verConta)}>
              <${Icon} name=${verConta ? 'chevron-up' : 'chevron-down'} size=${14} />${verConta ? 'Esconder a conta' : 'Ver a conta, linha por linha'}
            </button>
            ${verConta
              ? html`<div class="calc-conta">
                  ${r.linhas.map((l) => html`<p class="calc-conta-tit">${l.nome}</p><ul>${l.conta.map((t) => html`<li>${t}</li>`)}</ul>`)}
                  <p class="calc-conta-tit">Trabalho</p>
                  <ul>${r.conta.map((t) => html`<li>${t}</li>`)}</ul>
                  <p class="field-hint">GB por hora = bitrate em Mb/s × 3.600 ÷ 8 ÷ 1.000. ${gbPorHora(100)} GB por hora a 100 Mb/s.</p>
                </div>`
              : null}
          </div>`
        : html`<div class="ct-res ct-vazio"><span class="ct-vazio-ic"><${Icon} name="film" size=${22} /></span><b>A conta aparece aqui</b><span>Escolha a câmera e as horas.</span></div>`}
    </aside>
  </div>`
}

const ABAS = [
  { value: 'backup', titulo: 'Backup Automático', sub: 'Espete o cartão: passa sozinho, por diária e por dono', icone: 'sdcard', up: true },
  { value: 'calc', titulo: 'Calculadora', sub: 'Quanta mídia e quantos HDs levar', icone: 'film' },
]

export function CartoesScreen() {
  const [aba, setAba] = usePersistentState('cartoes.aba', 'backup')
  const topo = html`<div class="k-entra ct-abas" style="--i:1"><${Opcoes} label="Cartões" valor=${aba} onEscolher=${setAba} itens=${ABAS} colunas=${2} /></div>`
  if (aba !== 'calc') return html`<${BackupPanel} topo=${topo} />`
  return html`<section class="page page-cartoes">
    <header class="page-head">
      <div>
        <h1>Cartões</h1>
        <p class="page-lead">Quanta mídia levar para o trabalho, com a conta aberta.</p>
      </div>
    </header>
    ${topo}
    <${Calculadora} />
  </section>`
}

