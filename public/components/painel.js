// Início: o painel do app. Pouca coisa, a que importa: como estão os envios, quanto do Drive já foi, quais
// computadores estão por perto e para onde vai o próximo envio; o botão grande de enviar; os atalhos; o que está
// subindo agora e o que terminou por último. Tudo entra com movimento suave (e parado, para quem pediu menos movimento).
import { html, useEffect, useMemo, useRef, useState } from '/vendor/preact-htm.js'
import { useStore, ACTIVE } from '../lib/store.js'
import { api, attempt } from '../lib/api.js'
import { bytes, count, plural, relTime, aprox, speed } from '../lib/format.js'
import { cx, storage } from '../lib/ui.js'
import { navigate } from '../lib/router.js'
import { batchAction, driveFolderUrl, uploadFlow } from '../lib/actions.js'
import { openExternal } from '../lib/desktop.js'
import { pastaInicial } from '../lib/destinos.js'
import { Icon } from './icons.js'
import { FileIcon } from './common.js'
import { useAbout } from './drive-data.js'

const FINISHED = new Set(['completed', 'skipped', 'canceled'])
const calmo = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Número que corre até o valor novo (600 ms), em vez de pular. */
function useContador(valor) {
  const [mostrado, setMostrado] = useState(valor)
  const de = useRef(valor)
  useEffect(() => {
    if (!Number.isFinite(valor)) return setMostrado(valor)
    if (calmo()) return setMostrado(valor)
    const inicio = performance.now()
    const a = Number.isFinite(de.current) ? de.current : 0
    let id = 0
    const passo = (t) => {
      const k = Math.min(1, (t - inicio) / 600)
      const e = 1 - (1 - k) ** 3
      setMostrado(a + (valor - a) * e)
      if (k < 1) id = requestAnimationFrame(passo)
      else de.current = valor
    }
    id = requestAnimationFrame(passo)
    return () => cancelAnimationFrame(id)
  }, [valor])
  return mostrado
}

function Barra({ frac, tom = 'up' }) {
  return html`<div class=${cx('pn-barra', `is-${tom}`)}><i style=${`width:${(Math.max(0, Math.min(1, frac || 0)) * 100).toFixed(1)}%`}></i></div>`
}

/** Envios agrupados por lote: os que estão andando e os que terminaram por último. */
function useLotes() {
  const transfers = useStore((s) => s.transfers)
  const batches = useStore((s) => s.batches)
  return useMemo(() => {
    const meta = new Map((batches || []).map((b) => [b.id, b]))
    const por = new Map()
    for (const t of transfers.values()) {
      let l = por.get(t.batchId)
      if (!l) por.set(t.batchId, (l = []))
      l.push(t)
    }
    const lotes = []
    for (const [id, itens] of por) {
      const b = meta.get(id) || { id, label: itens[0]?.name || 'Envio', type: itens[0]?.type, createdAt: Math.min(...itens.map((t) => t.createdAt || 0)) }
      let total = 0
      let feito = 0
      let vel = 0
      let ativos = 0
      let pausados = 0
      let falhas = 0
      let fim = 0
      for (const t of itens) {
        if (t.status === 'canceled') continue
        total += t.size || 0
        feito += t.status === 'completed' || t.status === 'skipped' ? t.size || 0 : t.bytesDone || 0
        if (t.status === 'running') vel += t.speed || 0
        if (ACTIVE.has(t.status)) ativos++
        if (t.status === 'paused') pausados++
        if (t.status === 'failed') falhas++
        fim = Math.max(fim, t.finishedAt || 0)
      }
      const terminado = itens.every((t) => FINISHED.has(t.status))
      lotes.push({ b, itens, total, feito, vel, ativos, pausados, falhas, terminado, fim: fim || b.createdAt || 0, tipo: b.type || itens[0]?.type || 'upload' })
    }
    const andando = lotes.filter((l) => l.ativos || l.pausados).sort((a, b) => (b.b.createdAt || 0) - (a.b.createdAt || 0))
    const recentes = lotes.filter((l) => l.terminado).sort((a, b) => b.fim - a.fim)
    return { andando, recentes }
  }, [transfers, batches])
}

function Cartao({ icone, tom, titulo, valor, children, onClick, atraso }) {
  return html`<button type="button" class=${cx('pn-cartao', `is-${tom}`)} onClick=${onClick} style=${`--i:${atraso}`}>
    <div class="pn-cartao-topo">
      <span class="pn-cartao-icone"><${Icon} name=${icone} size=${20} strokeWidth=${1.8} /></span>
      <div class="pn-cartao-txt">
        <span class="pn-cartao-titulo">${titulo}</span>
        <span class="pn-cartao-valor num">${valor}</span>
      </div>
      <span class="pn-seta"><${Icon} name="chevron-right" size=${16} /></span>
    </div>
    <div class="pn-cartao-pe">${children}</div>
  </button>`
}

function Resumo({ andando, conta, computadores }) {
  const about = useAbout(conta?.id)
  const q = about?.quota
  let total = 0
  let feito = 0
  let vel = 0
  let arquivos = 0
  for (const l of andando) {
    total += l.total
    feito += l.feito
    vel += l.vel
    arquivos += l.ativos + l.pausados
  }
  const nArquivos = useContador(arquivos)
  const usado = useContador(q?.usage || 0)
  const dest = conta ? pastaInicial(storage, conta.id) : null
  const nComp = useContador((computadores?.length || 0) + 1)
  return html`<div class="pn-cartoes">
    <${Cartao} icone="arrow-up" tom="up" titulo="Enviando agora" valor=${count(Math.round(nArquivos))} onClick=${() => navigate('transferencias')} atraso=${1}>
      ${arquivos
        ? html`<${Barra} frac=${total ? feito / total : 0} tom="ok" />
            <span class="sub num">${bytes(feito)} de ${bytes(total)}${vel > 0 ? ` · ${aprox((total - feito) / vel) || ''}` : ''}</span>`
        : html`<span class="sub">Nada na fila. Tudo em dia.</span>`}
    </${Cartao}>
    <${Cartao} icone="cloud" tom="down" titulo="Espaço no Drive" valor=${q ? bytes(usado) : '—'} onClick=${() => navigate('drive')} atraso=${2}>
      ${q?.limit
        ? html`<${Barra} frac=${q.usage / q.limit} />
            <span class="sub num">de ${bytes(q.limit)} · ${Math.round((q.usage / q.limit) * 100)}%</span>`
        : html`<span class="sub">${q ? 'Sem limite de espaço' : 'Lendo o Drive…'}</span>`}
    </${Cartao}>
    <${Cartao} icone="laptop" tom="ok" titulo="Computadores" valor=${count(Math.round(nComp))} onClick=${() => navigate('computadores')} atraso=${3}>
      <ul class="pn-comps">
        <li><span class="pn-ponto is-on"></span>Este computador</li>
        ${(computadores || []).slice(0, 1).map((c) => html`<li><span class="pn-ponto is-on"></span>${c.nome}</li>`)}
        ${!computadores?.length ? html`<li class="sub"><span class="pn-ponto"></span>Nenhum outro por perto</li>` : null}
      </ul>
    </${Cartao}>
    <div class="pn-cartao is-drive" style="--i:4">
      <div class="pn-cartao-topo">
        <span class="pn-cartao-icone"><${Icon} name="folder" size=${20} strokeWidth=${1.8} /></span>
        <div class="pn-cartao-txt">
          <span class="pn-cartao-titulo">Próximo envio vai para</span>
          <span class="pn-cartao-valor pn-pasta" title=${dest?.path || dest?.name}>${dest?.name || 'Meu Drive'}</span>
        </div>
      </div>
      <div class="pn-cartao-pe">
        <button type="button" class="pn-link" onClick=${() => openExternal(!dest || dest.id === 'root' ? 'https://drive.google.com/drive/my-drive' : driveFolderUrl(dest.id))}>
          Abrir no Drive <${Icon} name="external" size=${13} />
        </button>
      </div>
    </div>
  </div>`
}

function Atalhos() {
  const enviar = (ev) => uploadFlow({ anchor: ev.currentTarget })
  return html`<div class="pn-atalhos">
    <button type="button" class="pn-enviar" onClick=${enviar} style="--i:5">
      <span class="pn-enviar-icone"><${Icon} name="upload" size=${26} strokeWidth=${1.8} /></span>
      <span class="pn-enviar-txt"><b>Enviar arquivos</b><span>Vídeos, fotos, qualquer tamanho</span></span>
      <span class="pn-enviar-seta"><${Icon} name="chevron-right" size=${18} /></span>
    </button>
    ${[
      { id: 'drive', icone: 'cloud', titulo: 'Drive', sub: 'Seus arquivos', tom: 'down' },
      { id: 'referencias', icone: 'bookmark', titulo: 'Referências', sub: 'O que você salvou', tom: 'warn' },
      { id: 'frames', icone: 'frames', titulo: 'Frames', sub: 'Posts do filme', tom: 'up' },
      { id: 'cartoes', icone: 'sdcard', titulo: 'Cartões', sub: 'Backup automático', tom: 'ok' },
    ].map(
      (a, i) => html`<button type="button" class=${cx('pn-atalho', `is-${a.tom}`)} onClick=${() => navigate(a.id)} style=${`--i:${6 + i}`}>
        <span class="pn-atalho-icone"><${Icon} name=${a.icone} size=${20} strokeWidth=${1.8} /></span>
        <span class="pn-atalho-txt"><b>${a.titulo}</b><span class="sub">${a.sub}</span></span>
      </button>`,
    )}
  </div>`
}

const CELULAR_ATIVO = new Set(['esperando', 'conectando', 'andando'])

/** O que está passando com o celular pelo Wi-Fi (components/celular-wifi.js), no topo do "Em andamento". */
function Celular({ t }) {
  const frac = t.total ? t.feitos / t.total : 0
  return html`<li class="pn-item" key=${t.id}>
    <span class=${cx('pn-dir', t.direcao === 'enviando' ? 'is-up' : 'is-down')}><${Icon} name=${t.direcao === 'enviando' ? 'arrow-up' : 'arrow-down'} size=${16} strokeWidth=${2} /></span>
    <div class="pn-item-txt">
      <b>${t.direcao === 'recebendo' ? 'Do' : 'Para o'} ${t.dono ? `${t.aparelho} (${t.dono})` : t.aparelho}</b>
      <span class="sub num">${plural(t.arquivos, 'arquivo', 'arquivos')} · ${bytes(t.total)} · ${t.estado === 'esperando' ? 'esperando o celular aceitar' : t.estado === 'conectando' ? 'conectando' : t.velocidade ? `${speed(t.velocidade)} pelo Wi-Fi` : 'pelo Wi-Fi'}</span>
      <${Barra} frac=${frac} tom="ok" />
    </div>
    <span class="pn-pct num">${Math.floor(frac * 100)}%</span>
    <button type="button" class="pn-redondo" aria-label="Cancelar" onClick=${() => attempt(api.post(`/api/celular/cancelar/${t.id}`, {}))}><${Icon} name="x" size=${14} /></button>
  </li>`
}

function Andando({ lotes }) {
  const celular = (useStore((s) => s.celular)?.transferencias || []).filter((t) => CELULAR_ATIVO.has(t.estado))
  const n = lotes.length + celular.length
  return html`<section class="pn-bloco" style="--i:9">
    <header class="pn-bloco-topo">
      <h2>Em andamento ${n ? html`<span class="pn-conta">${n}</span>` : null}</h2>
      <button type="button" class="pn-link" onClick=${() => navigate('transferencias')}>Ver todos <${Icon} name="chevron-right" size=${13} /></button>
    </header>
    ${n
      ? html`<ul class="pn-lista">
          ${celular.slice(0, 3).map((t) => html`<${Celular} key=${t.id} t=${t} />`)}
          ${lotes.slice(0, Math.max(0, 3 - celular.length)).map((l) => {
            const frac = l.total ? l.feito / l.total : 0
            return html`<li class="pn-item" key=${l.b.id}>
              <span class=${cx('pn-dir', l.tipo === 'upload' ? 'is-up' : 'is-down')}><${Icon} name=${l.tipo === 'upload' ? 'arrow-up' : 'arrow-down'} size=${16} strokeWidth=${2} /></span>
              <div class="pn-item-txt">
                <b title=${l.b.label}>${l.b.label || 'Envio'}</b>
                <span class="sub num">${bytes(l.total)} · ${l.pausados && !l.ativos ? 'pausado' : l.vel > 0 ? `${aprox((l.total - l.feito) / l.vel) || ''} restantes` : 'na fila'}</span>
                <${Barra} frac=${frac} tom="ok" />
              </div>
              <span class="pn-pct num">${Math.floor(frac * 100)}%</span>
              ${l.ativos
                ? html`<button type="button" class="pn-redondo" aria-label="Pausar" onClick=${() => batchAction('pause', l.b.id)}><${Icon} name="pause-fill" size=${14} /></button>`
                : html`<button type="button" class="pn-redondo" aria-label="Retomar" onClick=${() => batchAction('resume', l.b.id)}><${Icon} name="play" size=${14} /></button>`}
            </li>`
          })}
        </ul>`
      : html`<div class="pn-vazio">
          <span class="pn-vazio-arte" aria-hidden="true"><${Icon} name="circle-check" size=${26} /></span>
          <span>Nada enviando agora.</span>
        </div>`}
  </section>`
}

function Recentes({ lotes }) {
  return html`<section class="pn-bloco" style="--i:10">
    <header class="pn-bloco-topo">
      <h2>Recentes</h2>
      <button type="button" class="pn-link" onClick=${() => navigate('transferencias')}>Ver todos <${Icon} name="chevron-right" size=${13} /></button>
    </header>
    ${lotes.length
      ? html`<ul class="pn-lista">
          ${lotes.slice(0, 4).map(
            (l) => html`<li class="pn-item" key=${l.b.id}>
              <${FileIcon} name=${l.itens.length === 1 ? l.itens[0].name : ''} isFolder=${l.itens.length > 1} size=${38} />
              <div class="pn-item-txt">
                <b title=${l.b.label}>${l.b.label || l.itens[0]?.name}</b>
                <span class="sub num">${plural(l.itens.length, 'arquivo', 'arquivos')} · ${bytes(l.total)} ·
                  ${l.falhas ? html`<span class="tone-warning">${l.falhas} com problema</span>` : html`<span class="pn-ok"><${Icon} name="circle-check" size=${13} /> ${l.tipo === 'upload' ? 'No Drive' : 'Baixado'}</span>`}</span>
              </div>
              <span class="sub pn-quando">${relTime(l.fim)}</span>
            </li>`,
          )}
        </ul>`
      : html`<div class="pn-vazio"><span>Os envios terminados aparecem aqui.</span></div>`}
  </section>`
}

export function PainelScreen() {
  const cloud = useStore((s) => s.cloud)
  const accounts = useStore((s) => s.accounts)
  const activeId = useStore((s) => s.activeAccountId)
  const conta = accounts.find((a) => a.id === activeId) || accounts[0]
  const { andando, recentes } = useLotes()
  const [computadores, setComputadores] = useState(null)
  useEffect(() => {
    if (!cloud?.conectado) return undefined
    let vivo = true
    const buscar = () => api.get('/api/lan/computadores').then((r) => vivo && setComputadores([...(r.computadores || []), ...(r.porPerto || [])]), () => {})
    buscar()
    const t = setInterval(buscar, 30_000)
    return () => {
      vivo = false
      clearInterval(t)
    }
  }, [cloud?.conectado])
  const nome = (cloud?.usuario?.nome || conta?.name || '').trim().split(/\s+/)[0]
  const hora = new Date().getHours()
  const saudacao = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite'

  return html`<div class="page page-painel">
    <header class="pn-ola" style="--i:0">
      <h1>${saudacao}${nome ? `, ${nome}` : ''}</h1>
      <p class="page-lead">${andando.length ? `${plural(andando.length, 'envio', 'envios')} em andamento. A gente cuida do resto.` : 'Seus arquivos organizados e seguros no Drive.'}</p>
    </header>
    <${Resumo} andando=${andando} conta=${conta} computadores=${cloud?.conectado ? computadores : []} />
    <${Atalhos} />
    <div class="pn-colunas">
      <${Andando} lotes=${andando} />
      <${Recentes} lotes=${recentes} />
    </div>
  </div>`
}
