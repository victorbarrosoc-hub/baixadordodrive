// Prévia leve (src/media/previa*.js): a linha dos Ajustes, a sub-linha "Gerando prévia leve…" de cada envio na tela
// Transferências e a janela "Gerar prévias" da tela Drive (cópia leve para os vídeos que já estão lá, a partir dos
// originais no computador). A cópia fica em Proxy/<nome>.mp4 ao lado do original; o original nunca muda.
import { html, useEffect, useRef, useState } from '/vendor/preact-htm.js'
import { api, attempt, enc } from '../lib/api.js'
import { setPrevias, subscribe, useStore } from '../lib/store.js'
import { confirmDialog, openModal, registerModal } from '../lib/modals.js'
import { pickFolderPath } from '../lib/desktop.js'
import { toast } from '../lib/toasts.js'
import { bytes, count, extOf, percent, plural } from '../lib/format.js'
import { cx } from '../lib/ui.js'
import { Icon } from './icons.js'
import { Button, Checkbox, Select, Spinner, Switch } from './common.js'
import { Modal } from './modal.js'
import { invalidateAccount } from './drive-data.js'

const TERMINAL = new Set(['done', 'canceled', 'error'])
const VIDEO = new Set(['mp4', 'mov', 'm4v', 'mxf', 'mkv', 'avi', 'mts', 'm2ts', 'ts', 'mpg', 'mpeg', 'm2v', 'wmv', 'webm', '3gp', 'dv', 'flv', 'hevc', 'h265', 'h264', 'vob'])
const LIGHT_MP4 = 50e6
const PROXY_DIR = /^prox(y|ies)$/i

/** Cópia leve feita pelo SOBEDESCE? */
export const isPreviaItem = (item) => item?.appProperties?.sobedesce === 'previa'

/**
 * A pasta tem vídeo que pode precisar de cópia leve? (o botão "Gerar prévias" aparece só aí). Pasta Proxy, cópias
 * nossas e .mp4 pequeno ficam de fora; quem já tem proxy o lote descobre e pula.
 */
export function hasVideoFiles(items, folder) {
  if (!items?.length || PROXY_DIR.test(folder?.name || '')) return false
  return items.some((x) => {
    if (x.isFolder || isPreviaItem(x)) return false
    const ext = extOf(x.name)
    if (ext === 'braw') return true
    if (!VIDEO.has(ext)) return false
    return !(ext === 'mp4' && x.size != null && x.size < LIGHT_MP4)
  })
}

// ───── Ajustes ─────

/** O conversor deste computador (GET /api/previas). */
function usePreviaInfo(refresh = false) {
  const [info, setInfo] = useState(null)
  useEffect(() => {
    let live = true
    api
      .get(`/api/previas${refresh ? '?refresh=1' : ''}`)
      .then((r) => live && setInfo(r.previas || null))
      .catch(() => live && setInfo({ unknown: true, motor: {} }))
    return () => {
      live = false
    }
  }, [])
  return info
}

export const MODOS_PROXY = [
  { value: 'sempre', label: 'Sempre' },
  { value: 'perguntar', label: 'Perguntar a cada envio' },
  { value: 'nunca', label: 'Nunca' },
]

/** Padrão de proxy para quem não escolheu (só 'nunca' desliga). */
export const proxyPadrao = (settings) => (settings?.proxyAoEnviar || 'sempre') !== 'nunca'

/** Envio de vídeo que pode ter proxy (pela extensão; RAW de câmera fica de fora). */
export const isVideoName = (name) => VIDEO.has(extOf(name || ''))
/** Blackmagic RAW: tem proxy quando o app traz o decodificador (o motor decide; a tela só mostra o que veio). */
export const isBrawName = (name) => extOf(name || '') === 'braw'

/** Linha "Proxy ao enviar" (Ajustes → Arquivos). */
export function PreviaRow({ d, set }) {
  const info = usePreviaInfo()
  const modo = d.proxyAoEnviar || 'sempre'
  let note = null
  if (info && modo !== 'nunca' && !info.unknown) {
    const m = info.motor || {}
    if (!m.via) note = html`<span class="srow-note is-warn previa-warn"><${Icon} name="warning" size=${13} /><span>${m.aviso || 'Não encontramos o ffmpeg neste computador.'}</span></span>`
    else
      note = html`<span class=${cx('srow-note previa-engine', m.hardware && 'is-hw')}>
        <${Icon} name=${m.hardware ? 'bolt' : 'film'} size=${13} /> ${m.label}${m.versao && m.via === 'ffmpeg' ? html`<span class="sub"> · ffmpeg ${m.versao.replace(/-.*/, '')}</span>` : null}${m.braw?.ok ? html`<span class="sub"> · BRAW</span>` : null}
      </span>`
    if (m.via && m.braw && !m.braw.ok) note = html`${note}<br /><span class="srow-note">Sem proxy de BRAW: ${m.braw.motivo}.</span>`
    if (info.last && !info.last.ok) note = html`${note}<br /><span class="srow-note">O último vídeo ficou sem proxy (${info.last.motivo}).</span>`
  }
  return html`<div class="srow">
    <div class="srow-text">
      <div class="srow-label">Proxy ao enviar</div>
      <div class="srow-desc">
        Proxy (cópia leve 720p) na pasta Proxy, para a prévia tocar fluida no celular, no computador e para o cliente. O original não muda. Cada envio e cada arquivo podem mudar isso.
        ${note ? html`<br />${note}` : null}
      </div>
    </div>
    <div class="srow-control"><${Select} label="Proxy ao enviar" value=${modo} onChange=${(v) => set('proxyAoEnviar', v, { now: true })} options=${MODOS_PROXY} /></div>
  </div>`
}

/** "Gerar proxy dos vídeos": a escolha de um envio (diálogo de envio e seletor de pasta). */
export function ProxyChoice({ checked, onChange, ask }) {
  return html`<label class=${cx('proxy-choice', ask && 'is-ask', checked && 'is-on')}>
    <span class="proxy-choice-icon"><${Icon} name="film" size=${15} /></span>
    <span class="proxy-choice-text">
      <b>Gerar proxy dos vídeos</b>
      <span>Proxy (cópia leve 720p) em Proxy/, para a prévia tocar fluida. O original não muda.</span>
    </span>
    <${Switch} label="Gerar proxy dos vídeos" checked=${checked} onChange=${onChange} />
  </label>`
}

/**
 * Janela de envio (quando o ajuste é "Perguntar a cada envio" e a escolha não veio do seletor de pasta):
 * o que vai subir e a escolha do proxy em destaque. Devolve { proxy } ou null (cancelou).
 */
export function EnvioDialog({ paths, destName, onClose }) {
  const [proxy, setProxy] = useState(true)
  const names = (paths || []).map((p) => String(p).split(/[\\/]/).pop())
  const shown = names.slice(0, 4)
  return html`<${Modal}
    size="sm"
    class="dialog envio-dialog"
    title=${destName ? `Enviar para “${destName}”` : 'Enviar para o Drive'}
    subtitle=${plural(names.length, 'item escolhido', 'itens escolhidos')}
    onClose=${() => onClose(null)}
    footer=${html`<${Button} onClick=${() => onClose(null)}>Cancelar</${Button}>
      <${Button} variant="primary" icon="upload" onClick=${() => onClose({ proxy })} data-autofocus>Enviar</${Button}>`}
  >
    <ul class="envio-list">
      ${shown.map((n) => html`<li><${Icon} name=${/\.[^.]+$/.test(n) ? 'doc' : 'folder'} size=${14} /><span class="mono-path" title=${n}>${n}</span></li>`)}
      ${names.length > shown.length ? html`<li class="sub">e mais ${count(names.length - shown.length)}</li>` : null}
    </ul>
    <${ProxyChoice} checked=${proxy} onChange=${setProxy} ask />
    <p class="previa-cost sub">Dá para mudar por arquivo em Transferências, e gerar depois na tela Drive.</p>
  </${Modal}>`
}

registerModal('envio', EnvioDialog)

// ───── Transferências ─────

const LINE = {
  fila: 'Proxy na fila',
  pausada: 'Proxy pausado',
  analisando: 'Preparando o proxy…',
  gerando: 'Gerando proxy…',
  enviando: 'Enviando o proxy…',
  baixando: 'Baixando o original…',
}
const PENDENTE = new Set(['fila', 'pausada', 'analisando', 'gerando', 'enviando'])
const FIM_ENVIO = new Set(['completed', 'skipped'])

const setProxy = (id, on) => attempt(api.post('/api/transfers/proxy', { ids: [id], proxy: on }))

/**
 * Sub-linha do envio de vídeo. Antes de terminar: "Proxy: sim/não" (troca na hora). Depois: o andamento
 * ("Gerando proxy… 42%" → "Proxy pronto"), ou "Sem proxy" com "Gerar proxy".
 */
export function PreviaLine({ t }) {
  const settings = useStore((s) => s.settings)
  // Cancelado ou com problema: o chip "Proxy: sim" só faria ruído ao lado do erro.
  // .braw: só depois que o motor pegou o envio para o proxy (o computador tem o decodificador).
  const ok = isVideoName(t.name) || (isBrawName(t.name) && t.previa && !/^BRAW:|decodificador/.test(t.previa.motivo || ''))
  if (t.type !== 'upload' || t.referencia || !ok || t.status === 'canceled' || t.status === 'failed') return null
  const p = t.previa
  const want = typeof t.proxy === 'boolean' ? t.proxy : proxyPadrao(settings)
  if (!FIM_ENVIO.has(t.status)) {
    return html`<div class="trow-previa">
      <button
        type="button"
        class=${cx('proxy-chip', want ? 'is-on' : 'is-off')}
        aria-pressed=${want ? 'true' : 'false'}
        onClick=${() => setProxy(t.id, !want)}
        title=${want ? 'Ao terminar de subir, gera o proxy (cópia leve 720p). Clique para não gerar.' : 'Não vai gerar proxy. Clique para gerar ao terminar de subir.'}
      ><${Icon} name="film" size=${12} /> Proxy: ${want ? 'sim' : 'não'}</button>
    </div>`
  }
  if (p?.estado === 'pronta') {
    return html`<div class="trow-previa is-done">
      <${Icon} name="check" size=${13} strokeWidth=${2} />
      <span>Proxy pronto${p.size ? html`<span class="sub"> · ${bytes(p.size)} em Proxy</span>` : null}</span>
    </div>`
  }
  if (p && PENDENTE.has(p.estado)) {
    const frac = p.estado === 'gerando' || p.estado === 'enviando' ? p.frac : null
    const active = p.estado === 'analisando' || p.estado === 'gerando' || p.estado === 'enviando'
    return html`<div class=${cx('trow-previa', active && 'is-active', p.estado === 'pausada' && 'is-paused')}>
      ${active ? html`<${Spinner} size=${12} />` : html`<${Icon} name=${p.estado === 'pausada' ? 'pause' : 'clock'} size=${13} />`}
      <span class=${cx(active && 'shimmer-text')}>${LINE[p.estado]}</span>
      ${frac != null ? html`<span class="previa-pct num">${percent(frac)}</span>` : null}
      ${frac != null ? html`<span class="previa-bar" aria-hidden="true"><i style=${`width:${(Math.max(0, Math.min(1, frac)) * 100).toFixed(1)}%`}></i></span>` : null}
      <button type="button" class="link previa-skip" onClick=${() => setProxy(t.id, false)} title="Não gerar o proxy deste vídeo">Pular</button>
    </div>`
  }
  // Já tem proxy (da câmera ou de antes): nada a oferecer.
  if (p?.estado === 'dispensada' && /proxy|prévia leve/.test(p.motivo || '')) {
    return html`<div class="trow-previa is-quiet"><${Icon} name="check" size=${13} /><span>${p.motivo === 'já tinha prévia leve' ? 'Já tinha proxy' : 'Já tem o proxy da câmera'}</span></div>`
  }
  const why = p?.estado === 'falhou' ? p.motivo : p?.estado === 'dispensada' ? p.motivo : null
  return html`<div class=${cx('trow-previa', p?.estado === 'falhou' ? 'is-fail' : 'is-quiet')} title=${why || ''}>
    <${Icon} name=${p?.estado === 'falhou' ? 'info' : 'minus'} size=${13} />
    <span>${p?.estado === 'falhou' ? 'Ficou sem proxy' : 'Sem proxy'}${why ? html`<span class="sub"> · ${why}</span>` : null}</span>
    <button type="button" class="link proxy-gerar" onClick=${() => setProxy(t.id, true)}>${p?.estado === 'falhou' ? 'Tentar de novo' : 'Gerar proxy'}</button>
  </div>`
}

// ───── lote "Gerar prévias" ─────

/** "3 prévias geradas · 2 sem arquivo no computador" (igual ao resumoPrevias do motor). */
export function resumo(p) {
  if (!p) return ''
  if (!p.total) {
    if (p.jaTinham || p.jaLeves) {
      const parts = []
      if (p.jaTinham) parts.push(plural(p.jaTinham, 'vídeo já tinha prévia', 'vídeos já tinham prévia'))
      if (p.jaLeves) parts.push(`${count(p.jaLeves)} ${p.jaLeves === 1 ? 'já é leve' : 'já são leves'}`)
      return `Nada a fazer: ${parts.join(' e ')}.`
    }
    return 'Nenhum vídeo sem prévia nesta pasta.'
  }
  const parts = [plural(p.feitos, 'prévia gerada', 'prévias geradas')]
  if (p.semLocal) parts.push(`${count(p.semLocal)} sem arquivo no computador`)
  if (p.tamanhoDiferente) parts.push(`${count(p.tamanhoDiferente)} com tamanho diferente`)
  if (p.falhou) parts.push(plural(p.falhou, 'falhou', 'falharam'))
  return parts.join(' · ')
}

let openDialogs = 0
const doneSubs = new Set()
const seenStatus = new Map()

/** Avisa quando um lote termina (a tela Drive recarrega a pasta). Devolve a função para parar. */
export function onPreviasDone(fn) {
  doneSubs.add(fn)
  return () => doneSubs.delete(fn)
}

subscribe((state) => {
  const job = state.previas
  if (!job?.jobId) return
  const prev = seenStatus.get(job.jobId)
  if (prev === job.status) return
  seenStatus.set(job.jobId, job.status)
  if (prev !== 'running' || !TERMINAL.has(job.status)) return
  if (job.progress?.feitos) invalidateAccount(job.accountId)
  for (const fn of doneSubs) {
    try {
      fn(job)
    } catch {}
  }
  if (!openDialogs) {
    if (job.status === 'done') toast(job.progress?.feitos ? 'success' : 'info', resumo(job.progress))
    else if (job.status === 'error') toast('error', job.error || 'O lote de prévias não terminou.')
  }
})

function Stat({ n, label, tone }) {
  return html`<div class=${cx('rt-stat', tone && `is-${tone}`, !n && 'is-zero')}>
    <b class="num">${count(n || 0)}</b>
    <span>${label}</span>
  </div>`
}

function Stats({ p }) {
  return html`<div class="rt-stats">
    <${Stat} n=${p.feitos} label=${p.feitos === 1 ? 'gerada' : 'geradas'} tone="ok" />
    <${Stat} n=${p.semLocal} label="sem arquivo no computador" />
    <${Stat} n=${p.tamanhoDiferente} label="com tamanho diferente" tone="warn" />
    <${Stat} n=${p.falhou} label=${p.falhou === 1 ? 'falhou' : 'falharam'} tone="err" />
  </div>`
}

function Details({ p }) {
  const groups = []
  if (p.falhas?.length) groups.push({ title: 'Falharam', rows: p.falhas.map((f) => ({ name: f.name, note: f.reason })), total: p.falhou })
  if (p.tamanhoNomes?.length)
    groups.push({ title: 'Tamanho diferente', rows: p.tamanhoNomes.map((f) => ({ name: f.name, note: `${bytes(f.drive)} no Drive · ${bytes(f.local)} aqui` })), total: p.tamanhoDiferente })
  if (p.semLocalNomes?.length) groups.push({ title: 'Sem arquivo no computador', rows: p.semLocalNomes.map((name) => ({ name })), total: p.semLocal })
  if (!groups.length) return null
  return html`<details class="rt-details">
    <summary><${Icon} name="chevron-right" size=${12} /> Ver arquivos</summary>
    ${groups.map(
      (g) => html`<div class="rt-group">
        <div class="rt-group-title">${g.title}</div>
        <ul>
          ${g.rows.map((r) => html`<li><span class="mono-path" title=${r.name}>${r.name}</span>${r.note ? html`<span class="sub" title=${r.note}>${r.note}</span>` : null}</li>`)}
          ${g.total > g.rows.length ? html`<li class="sub">e mais ${count(g.total - g.rows.length)}</li>` : null}
        </ul>
      </div>`,
    )}
  </details>`
}

const FASE = { analisando: 'Olhando o original', gerando: 'Gerando o proxy', enviando: 'Enviando para a pasta Proxy', baixando: 'Baixando o original do Drive' }

function Running({ job, here }) {
  const p = job.progress || {}
  const total = p.aGerar || 0
  const done = (p.feitos || 0) + (p.falhou || 0)
  let label
  let frac = null
  if (!p.phase || p.phase === 'drive') label = job.arquivo ? 'Olhando o arquivo no Drive…' : 'Procurando os vídeos no Drive…'
  else if (p.phase === 'local') label = `Procurando no computador… ${plural(p.localFiles || 0, 'vídeo achado', 'vídeos achados')}`
  else {
    label = job.arquivo ? (p.fase === 'baixando' ? 'Baixando o original…' : 'Gerando o proxy…') : total ? `Gerando ${count(Math.min(total, done + 1))} de ${count(total)}` : 'Terminando…'
    // Cada arquivo conta pelo andamento dele (a conversão é a parte longa).
    frac = total ? Math.min(1, (done + (p.frac || 0)) / total) : 1
  }
  return html`<div class="rt-run" aria-live="polite">
    ${!here && job.folderName ? html`<p class="rt-other"><${Icon} name="info" size=${14} /> Gerando para “${job.arquivo || job.folderName}”.</p>` : null}
    <div class="rt-phase">
      <${Spinner} size=${16} />
      <span>${label}</span>
    </div>
    <div class=${cx('rt-bar', frac == null && 'is-indeterminate')}><i style=${frac == null ? '' : `width:${(frac * 100).toFixed(1)}%`}></i></div>
    <div class="rt-current mono-path" title=${p.current || ''}>
      ${p.current || ' '}${p.current && p.fase ? html`<span class="sub"> · ${FASE[p.fase] || ''}${p.frac != null ? ` ${percent(p.frac)}` : ''}</span>` : null}
    </div>
    ${p.phase === 'gerar' && !job.arquivo ? html`<${Stats} p=${p} />` : null}
  </div>`
}

function Finished({ job, onBaixar }) {
  const p = job.progress || {}
  const good = job.status === 'done' && p.feitos > 0
  let head
  if (job.status !== 'done') head = job.error || 'O lote parou.'
  else if (job.arquivo) {
    head = p.feitos ? 'Proxy gerado.' : p.falhou ? `Não deu para gerar o proxy: ${p.falhas?.[0]?.reason || 'sem motivo'}.` : p.jaTinham ? 'Este vídeo já tem proxy.' : p.jaLeves ? 'Este vídeo já é leve: não precisa de proxy.' : p.tamanhoDiferente ? 'O arquivo do computador tem outro tamanho: não é o mesmo original.' : p.semLocal ? 'Não achei o original no computador.' : resumo(p)
  } else head = p.feitos && p.phase === 'fim' ? `${plural(p.feitos, 'proxy gerado', 'proxies gerados')}.` : resumo(p)
  const extra = []
  if (!job.arquivo && job.status === 'done' && p.jaTinham && p.total) extra.push(`${plural(p.jaTinham, 'vídeo já tinha', 'vídeos já tinham')} proxy.`)
  if (!job.arquivo && job.status === 'done' && p.jaLeves && p.total) extra.push(`${plural(p.jaLeves, 'vídeo já é leve', 'vídeos já são leves')} e ficou como estava.`)
  if (job.status === 'done' && p.baixados) extra.push(`${plural(p.baixados, 'original baixado', 'originais baixados')} do Drive para gerar (já apagados deste computador).`)
  const podeBaixar = job.status === 'done' && p.semLocal > 0 && onBaixar
  return html`<div class="rt-done">
    <div class=${cx('rt-summary', good && 'is-good', job.status !== 'done' && 'is-stopped')}>
      <span class="rt-summary-icon"><${Icon} name=${job.status === 'done' ? (p.feitos ? 'circle-check' : 'info') : 'warning'} size=${20} /></span>
      <div>
        <b>${head}</b>
        ${good ? html`<span class="sub">${job.arquivo ? 'Fica na pasta Proxy ao lado do original. A prévia já toca ele.' : 'Ficam na pasta Proxy ao lado de cada original. A prévia já toca o proxy.'}</span>` : null}
        ${extra.map((x) => html`<span class="sub">${x}</span>`)}
      </div>
    </div>
    ${p.total && p.phase === 'fim' && !job.arquivo ? html`<${Stats} p=${p} />` : null}
    ${podeBaixar
      ? html`<div class="proxy-baixar">
          <${Icon} name="cloud" size=${16} />
          <span><b>${plural(p.semLocal, 'vídeo não está', 'vídeos não estão')} neste computador.</b> Dá para baixar ${p.semLocal === 1 ? 'o original' : 'os originais'} do Drive (${bytes(p.semLocalBytes || 0)}), gerar o proxy e apagar a cópia daqui.</span>
          <${Button} icon="download" onClick=${onBaixar}>Baixar do Drive para gerar</${Button}>
        </div>`
      : null}
    ${p.localTruncated ? html`<p class="rt-note"><${Icon} name="info" size=${14} /> A pasta do computador é grande demais: parei de procurar no meio. Escolha uma pasta mais perto dos originais.</p>` : null}
    ${!job.arquivo && p.semLocal && !p.feitos && p.localFiles === 0 && job.localDir ? html`<p class="rt-note"><${Icon} name="info" size=${14} /> Não achei nenhum vídeo nessa pasta do computador. O disco ou o cartão está conectado?</p>` : null}
    ${job.arquivo ? null : html`<${Details} p=${p} />`}
  </div>`
}

/** Confirma baixar originais do Drive: mostra o tamanho e o espaço livre; sem espaço, não deixa. */
async function confirmarBaixar(n, total) {
  const r = await api.get('/api/previas/espaco').catch(() => null)
  const livre = r?.livre ?? null
  const falta = livre != null && livre < total + 1e9
  return confirmDialog({
    title: `Baixar ${n === 1 ? 'o original' : `${count(n)} originais`} do Drive?`,
    message: falta
      ? `Precisa de ${bytes(total)} livres (e uma folga de 1 GB), mas só há ${bytes(livre)} neste computador. Libere espaço e tente de novo.`
      : `São ${bytes(total)} para baixar${livre != null ? ` (livre: ${bytes(livre)})` : ''}. Cada original vai para uma pasta temporária, vira proxy e é apagado em seguida.`,
    confirmLabel: falta ? 'Entendi' : 'Baixar e gerar',
  }).then((ok) => ok && !falta)
}

/**
 * "Gerar proxies da pasta" (folder) ou "Gerar proxy" de um vídeo (arquivo: { id, name, size, parentId }).
 * @param {{ accountId: string, folder?: { id, name }, arquivo?: object, onClose: Function }} props
 */
export function PreviasDialog({ accountId, folder, arquivo = null, onClose }) {
  const settings = useStore((s) => s.settings)
  const job = useStore((s) => s.previas)
  const info = usePreviaInfo(true)
  const [localDir, setLocalDir] = useState(() => settings?.previaLocalDir || settings?.rawThumbLocalDir || '')
  const [recursive, setRecursive] = useState(true)
  const [refazer, setRefazer] = useState(false)
  const [starting, setStarting] = useState(false)
  const [mine, setMine] = useState(() => (job?.status === 'running' ? job.jobId : null))
  // Um arquivo: onde está o original, se já tem proxy, quanto baixar.
  const [fileInfo, setFileInfo] = useState(null)
  const [origem, setOrigem] = useState('pasta') // 'pasta' | 'baixar'

  useEffect(() => {
    openDialogs++
    return () => {
      openDialogs--
    }
  }, [])
  useEffect(() => {
    if (!arquivo) return undefined
    let live = true
    api
      .get(`/api/previas/arquivo?accountId=${enc(accountId)}&id=${enc(arquivo.id)}`)
      .then((r) => {
        if (!live) return
        setFileInfo(r)
        if (!r.local && !(settings?.previaLocalDir || settings?.rawThumbLocalDir)) setOrigem('baixar')
      })
      .catch((err) => live && setFileInfo({ erro: err?.message || 'Não consegui olhar o arquivo.' }))
    return () => {
      live = false
    }
  }, [arquivo?.id])

  const current = job && (job.jobId === mine || job.status === 'running') ? job : null
  const running = current?.status === 'running'
  const finished = current && TERMINAL.has(current.status) && current.jobId === mine

  useEffect(() => {
    if (!running) return undefined
    const t = setInterval(async () => {
      try {
        setPrevias(await api.get(`/api/previas/lote/${enc(current.jobId)}`))
      } catch {}
    }, 2500)
    return () => clearInterval(t)
  }, [running, current?.jobId])

  const choose = async () => {
    const p = await pickFolderPath({ title: 'Onde estão os originais?', defaultPath: localDir || undefined, subtitle: 'O HD ou o cartão da câmera. Subpastas entram junto.' })
    if (p) setLocalDir(p)
  }

  const launch = async (body) => {
    setStarting(true)
    const res = await attempt(api.post('/api/previas/lote', { accountId, folderName: folder?.name || '', ...body }))
    setStarting(false)
    if (!res?.jobId) return
    setMine(res.jobId)
    setPrevias({ jobId: res.jobId, accountId, driveFolderId: body.driveFolderId, folderName: folder?.name || '', arquivo: body.arquivo || null, localDir: body.localDir || null, status: 'running', progress: null })
  }

  const start = async (e) => {
    e?.preventDefault()
    if (starting) return
    if (arquivo) {
      const fi = fileInfo
      if (!fi || fi.erro) return
      const body = { driveFolderId: fi.arquivo.parentId, somente: [fi.arquivo.id], forcar: true, refazer: !!fi.proxy?.nosso, recursive: false, arquivo: fi.arquivo.name }
      if (!fi.local) {
        if (origem === 'baixar') {
          if (!(await confirmarBaixar(1, fi.arquivo.size || 0))) return
          body.baixar = true
        } else {
          if (!localDir.trim()) return
          body.localDir = localDir.trim()
        }
      }
      return launch(body)
    }
    const dir = localDir.trim()
    if (!dir) return
    launch({ driveFolderId: folder.id, localDir: dir, recursive, refazer })
  }

  // Os que não estavam no computador: baixa do Drive, gera e apaga (pergunta antes, com o tamanho).
  const baixarFaltantes = async () => {
    const p = current?.progress
    if (!p?.semLocalIds?.length) return
    if (!(await confirmarBaixar(p.semLocalIds.length, p.semLocalBytes || 0))) return
    launch({ driveFolderId: current.driveFolderId, somente: p.semLocalIds, baixar: true, recursive: current.recursive !== false, refazer: !!current.refazer, arquivo: current.arquivo || undefined })
  }

  const stop = () => current && attempt(api.del(`/api/previas/lote/${enc(current.jobId)}`))
  const m = info?.motor || {}
  const blocked = info && !info.unknown && !m.via
  const here = current?.driveFolderId === (arquivo ? fileInfo?.arquivo?.parentId : folder?.id)
  const fi = fileInfo
  const cameraProxy = arquivo && fi?.proxy && !fi.proxy.nosso
  const needDir = !arquivo || (fi && !fi.local && origem === 'pasta')
  const canStart = info && (!arquivo || (fi && !fi.erro && !cameraProxy)) && (!needDir || localDir.trim())

  let footer
  if (running) {
    footer = html`<span class="rt-foot-hint sub">Pode fechar: continua em segundo plano.</span>
      <${Button} onClick=${stop} icon="x">Parar</${Button}>
      <${Button} variant="primary" onClick=${() => onClose()}>Fechar</${Button}>`
  } else if (finished) {
    footer = html`<${Button} onClick=${() => setMine(null)} icon="retry">${arquivo ? 'Voltar' : 'Gerar de novo'}</${Button}>
      <${Button} variant="primary" onClick=${() => onClose()} data-autofocus>Concluir</${Button}>`
  } else if (blocked || cameraProxy) {
    footer = html`<${Button} variant="primary" onClick=${() => onClose()}>Fechar</${Button}>`
  } else {
    footer = html`<${Button} onClick=${() => onClose()}>Cancelar</${Button}>
      <${Button} variant="primary" icon="film" onClick=${start} loading=${starting} disabled=${!canStart}>${arquivo ? (fi?.proxy?.nosso ? 'Refazer o proxy' : 'Gerar proxy') : 'Gerar proxies'}</${Button}>`
  }

  const setup = arquivo
    ? html`<form class="rt-setup" onSubmit=${start}>
        <p class="dialog-text">Proxy (cópia leve 720p) na pasta Proxy ao lado do original, para a prévia tocar fluida. O original não muda.</p>
        ${!fi
          ? html`<div class="rt-phase"><${Spinner} size=${16} /><span>Olhando o arquivo…</span></div>`
          : fi.erro
            ? html`<div class="rt-warn" role="alert"><${Icon} name="warning" size=${18} /><div><b>${fi.erro}</b></div></div>`
            : html`
                ${cameraProxy
                  ? html`<div class="rt-warn" role="status"><${Icon} name="info" size=${18} /><div><b>Este vídeo já tem o proxy da câmera.</b><span>${fi.proxy.name} já toca na prévia.</span></div></div>`
                  : null}
                ${fi.proxy?.nosso ? html`<p class="previa-engine-line"><${Icon} name="check" size=${14} /> Já tem proxy. Gerar de novo troca pelo novo.</p>` : null}
                ${!cameraProxy && fi.local
                  ? html`<div class="proxy-origem is-found"><${Icon} name="laptop" size=${16} /><div><b>Original neste computador</b><span class="mono-path" title=${fi.local}>${fi.local}</span></div></div>`
                  : null}
                ${!cameraProxy && !fi.local
                  ? html`<div class="proxy-origens" role="radiogroup" aria-label="De onde vem o original">
                      <label class=${cx('proxy-origem', origem === 'pasta' && 'is-on')}>
                        <input type="radio" name="pv-origem" checked=${origem === 'pasta'} onChange=${() => setOrigem('pasta')} />
                        <div>
                          <b>Procurar o original no computador</b>
                          <span>Mesmo nome e tamanho, numa pasta (HD ou cartão).</span>
                          ${origem === 'pasta'
                            ? html`<div class="rt-pick">
                                <input id="pv-dir" class="input mono" type="text" value=${localDir} placeholder="Escolha a pasta ou cole o caminho" onInput=${(e) => setLocalDir(e.currentTarget.value)} autocomplete="off" spellcheck="false" />
                                <${Button} icon="folder" onClick=${choose}>Escolher…</${Button}>
                              </div>`
                            : null}
                        </div>
                      </label>
                      <label class=${cx('proxy-origem', origem === 'baixar' && 'is-on')}>
                        <input type="radio" name="pv-origem" checked=${origem === 'baixar'} onChange=${() => setOrigem('baixar')} />
                        <div>
                          <b>Baixar do Drive para gerar · ${bytes(fi.arquivo.size || 0)}</b>
                          <span>Para o que subiu pelo celular, por exemplo. Vai para uma pasta temporária e é apagado depois.${fi.livre != null ? ` Livre: ${bytes(fi.livre)}.` : ''}</span>
                          ${fi.livre != null && fi.livre < (fi.arquivo.size || 0) + 1e9 ? html`<span class="proxy-falta"><${Icon} name="warning" size=${13} /> Não há espaço livre suficiente.</span>` : null}
                        </div>
                      </label>
                    </div>`
                  : null}
              `}
        <button type="submit" hidden></button>
      </form>`
    : html`<form class="rt-setup" onSubmit=${start}>
        <p class="dialog-text">Escolha onde estão os originais (HD ou cartão). Para cada vídeo pesado sem proxy, o SOBEDESCE gera o proxy (cópia leve 720p) e sobe na pasta Proxy ao lado do original. O original não muda.</p>
        ${m.label ? html`<p class=${cx('previa-engine-line', m.hardware && 'is-hw')}><${Icon} name=${m.hardware ? 'bolt' : 'film'} size=${14} /> ${m.label}</p>` : null}
        <div class="field">
          <label class="field-label" for="pv-dir">Originais no computador</label>
          <div class="rt-pick">
            <input id="pv-dir" class="input mono" type="text" value=${localDir} placeholder="Escolha a pasta ou cole o caminho" onInput=${(e) => setLocalDir(e.currentTarget.value)} autocomplete="off" spellcheck="false" data-autofocus=${localDir ? undefined : true} />
            <${Button} icon="folder" onClick=${choose}>Escolher…</${Button}>
          </div>
        </div>
        <div class="rt-checks">
          <label class="check-label">
            <${Checkbox} checked=${recursive} onChange=${setRecursive} label="Incluir subpastas" />
            <span>Incluir subpastas <span class="sub">do Drive</span></span>
          </label>
          <label class="check-label">
            <${Checkbox} checked=${refazer} onChange=${setRefazer} label="Refazer os proxies que o SOBEDESCE já gerou" />
            <span>Refazer os proxies que o SOBEDESCE já gerou <span class="sub">(proxy da câmera fica como está)</span></span>
          </label>
        </div>
        <p class="previa-cost sub"><${Icon} name="disk" size=${13} /> Cada proxy ocupa cerca de 2 a 5% do original no Drive (≈ 40 MB por minuto). O que não estiver no computador dá para baixar do Drive no fim.</p>
        <button type="submit" hidden></button>
      </form>`

  return html`<${Modal}
    size="md"
    class="dialog rt-dialog previa-dialog"
    title=${arquivo ? 'Gerar proxy' : 'Gerar proxies da pasta'}
    subtitle=${arquivo ? arquivo.name : `Vídeos de “${folder.name}” no Drive`}
    onClose=${() => onClose()}
    footer=${footer}
  >
    ${running
      ? html`<${Running} job=${current} here=${here} />`
      : finished
        ? html`<${Finished} job=${current} onBaixar=${current.baixar ? null : baixarFaltantes} />`
        : blocked
          ? html`<div class="rt-warn" role="alert">
              <${Icon} name="warning" size=${18} />
              <div><b>Este computador não tem como converter vídeo.</b><span>${m.aviso || 'Não encontramos o ffmpeg.'} O app instalado já traz o ffmpeg; no modo de desenvolvimento, instale o ffmpeg ou rode “node scripts/ffmpeg-baixar.mjs”.</span></div>
            </div>`
          : setup}
  </${Modal}>`
}

registerModal('previas', PreviasDialog)

/** "Gerar proxies da pasta" (barra da tela Drive). */
export function openPrevias({ accountId, folder }) {
  return openModal('previas', { accountId, folder })
}

/** "Gerar proxy" de um vídeo (seleção na tela Drive). */
export function openProxyArquivo({ accountId, item }) {
  return openModal('previas', { accountId, arquivo: { id: item.id, name: item.name, size: item.size } })
}

export function usePreviasRunning() {
  return useStore((s) => s.previas?.status === 'running')
}

// ───── selo "Proxy" na tela Drive ─────

const proxyDirCache = new Map() // `${acc}:${pasta Proxy}` → Promise<Set<nome-base>>
const baseOf = (name) => {
  const i = name.lastIndexOf('.')
  return (i > 0 ? name.slice(0, i) : name).normalize('NFC').toLowerCase()
}
const PROXY_EXT = new Set(['mp4', 'mov', 'm4v'])

/**
 * Ids dos vídeos da lista que têm proxy: mesmo nome-base (.mp4/.mov/.m4v) na mesma pasta ou dentro da subpasta
 * Proxy/Proxies que está na lista (uma consulta por subpasta, guardada). O selo é só informação.
 */
export function useComProxy(accountId, items) {
  const [names, setNames] = useState(null) // Set de nomes-base dentro de Proxy/Proxies
  const dirs = (items || []).filter((x) => x.isFolder && PROXY_DIR.test(x.name || ''))
  const key = dirs.map((d) => d.id).join(',')
  useEffect(() => {
    setNames(null)
    if (!accountId || !dirs.length) return undefined
    let live = true
    Promise.all(
      dirs.map((d) => {
        const k = `${accountId}:${d.id}:${d.modifiedTime || ''}`
        if (!proxyDirCache.has(k)) {
          proxyDirCache.set(
            k,
            api.get(`/api/drive/${enc(accountId)}/list?folderId=${enc(d.id)}`).then(
              (r) => new Set((r.items || []).filter((x) => !x.isFolder && PROXY_EXT.has(extOf(x.name))).map((x) => baseOf(x.name))),
              () => (proxyDirCache.delete(k), new Set()),
            ),
          )
        }
        return proxyDirCache.get(k)
      }),
    ).then((sets) => live && setNames(new Set(sets.flatMap((x) => [...x]))))
    return () => {
      live = false
    }
  }, [accountId, key])
  const out = new Set()
  if (!items?.length) return out
  const side = new Map()
  for (const it of items) if (!it.isFolder && PROXY_EXT.has(extOf(it.name))) side.set(`${baseOf(it.name)}`, (side.get(baseOf(it.name)) || []).concat(it))
  for (const it of items) {
    if (it.isFolder || !(isVideoName(it.name) || /^(braw|r3d)$/.test(extOf(it.name))) || isPreviaItem(it)) continue
    const b = baseOf(it.name)
    if (names?.has(b) || (side.get(b) || []).some((c) => c.id !== it.id && extOf(c.name) !== extOf(it.name))) out.add(it.id)
  }
  return out
}
