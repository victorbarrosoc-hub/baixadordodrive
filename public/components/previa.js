// Prévia leve (src/media/previa*.js): a linha dos Ajustes, a sub-linha "Gerando prévia leve…" de cada envio na tela
// Transferências e a janela "Gerar prévias" da tela Drive (cópia leve para os vídeos que já estão lá, a partir dos
// originais no computador). A cópia fica em Proxy/<nome>.mp4 ao lado do original; o original nunca muda.
import { html, useEffect, useRef, useState } from '/vendor/preact-htm.js'
import { api, attempt, enc } from '../lib/api.js'
import { setPrevias, subscribe, useStore } from '../lib/store.js'
import { openModal, registerModal } from '../lib/modals.js'
import { pickFolderPath } from '../lib/desktop.js'
import { toast } from '../lib/toasts.js'
import { bytes, count, extOf, percent, plural } from '../lib/format.js'
import { cx } from '../lib/ui.js'
import { Icon } from './icons.js'
import { Button, Checkbox, Spinner, Switch } from './common.js'
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

/** Linha "Gerar prévia leve dos vídeos" (Ajustes → Arquivos). */
export function PreviaRow({ d, set }) {
  const info = usePreviaInfo()
  const on = d.previaLeve !== false
  let note = null
  if (info && on && !info.unknown) {
    const m = info.motor || {}
    if (!m.via) note = html`<span class="srow-note is-warn previa-warn"><${Icon} name="warning" size=${13} /><span>${m.aviso || 'Não encontramos o ffmpeg neste computador.'}</span></span>`
    else
      note = html`<span class=${cx('srow-note previa-engine', m.hardware && 'is-hw')}>
        <${Icon} name=${m.hardware ? 'bolt' : 'film'} size=${13} /> ${m.label}${m.versao && m.via === 'ffmpeg' ? html`<span class="sub"> · ffmpeg ${m.versao.replace(/-.*/, '')}</span>` : null}
      </span>`
    if (info.last && !info.last.ok) note = html`${note}<br /><span class="srow-note">O último vídeo ficou sem cópia leve (${info.last.motivo}).</span>`
  }
  return html`<div class="srow">
    <div class="srow-text">
      <div class="srow-label">Gerar prévia leve dos vídeos</div>
      <div class="srow-desc">
        Uma cópia leve em 1080p na pasta Proxy, para a prévia tocar fluida no celular, no computador e para o cliente. O original não muda.
        ${note ? html`<br />${note}` : null}
      </div>
    </div>
    <div class="srow-control"><${Switch} label="Gerar prévia leve dos vídeos" checked=${on} onChange=${(v) => set('previaLeve', v, { now: true })} /></div>
  </div>`
}

// ───── Transferências ─────

const LINE = {
  fila: 'Prévia leve na fila',
  pausada: 'Prévia leve pausada',
  analisando: 'Preparando a prévia leve…',
  gerando: 'Gerando prévia leve…',
  enviando: 'Enviando a prévia leve…',
}

/** Sub-linha do envio: "Gerando prévia leve… 42%" → "Prévia leve pronta". Nada quando foi dispensada. */
export function PreviaLine({ t }) {
  const p = t.previa
  if (!p || t.type !== 'upload') return null
  if (p.estado === 'pronta') {
    return html`<div class="trow-previa is-done">
      <${Icon} name="check" size=${13} strokeWidth=${2} />
      <span>Prévia leve pronta${p.size ? html`<span class="sub"> · ${bytes(p.size)} em Proxy</span>` : null}</span>
    </div>`
  }
  if (p.estado === 'falhou') {
    return html`<div class="trow-previa is-fail" title=${p.motivo || ''}>
      <${Icon} name="info" size=${13} />
      <span>Ficou sem prévia leve${p.motivo ? html`<span class="sub"> · ${p.motivo}</span>` : null}</span>
    </div>`
  }
  const label = LINE[p.estado]
  if (!label) return null
  const frac = p.estado === 'gerando' || p.estado === 'enviando' ? p.frac : null
  const active = p.estado === 'analisando' || p.estado === 'gerando' || p.estado === 'enviando'
  const skip = () => attempt(api.post('/api/previas/pular', { ids: [t.id] }))
  return html`<div class=${cx('trow-previa', active && 'is-active', p.estado === 'pausada' && 'is-paused')}>
    ${active ? html`<${Spinner} size=${12} />` : html`<${Icon} name=${p.estado === 'pausada' ? 'pause' : 'clock'} size=${13} />`}
    <span class=${cx(active && 'shimmer-text')}>${label}</span>
    ${frac != null ? html`<span class="previa-pct num">${percent(frac)}</span>` : null}
    ${frac != null ? html`<span class="previa-bar" aria-hidden="true"><i style=${`width:${(Math.max(0, Math.min(1, frac)) * 100).toFixed(1)}%`}></i></span>` : null}
    <button type="button" class="link previa-skip" onClick=${skip} title="Não gerar a prévia leve deste vídeo">Pular</button>
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

const FASE = { analisando: 'Olhando o original', gerando: 'Gerando a cópia leve', enviando: 'Enviando para a pasta Proxy' }

function Running({ job, here }) {
  const p = job.progress || {}
  const total = p.aGerar || 0
  const done = (p.feitos || 0) + (p.falhou || 0)
  let label
  let frac = null
  if (!p.phase || p.phase === 'drive') label = 'Procurando os vídeos no Drive…'
  else if (p.phase === 'local') label = `Procurando no computador… ${plural(p.localFiles || 0, 'vídeo achado', 'vídeos achados')}`
  else {
    label = total ? `Gerando ${count(Math.min(total, done + 1))} de ${count(total)}` : 'Terminando…'
    // Cada arquivo conta pelo andamento dele (a conversão é a parte longa).
    frac = total ? Math.min(1, (done + (p.frac || 0)) / total) : 1
  }
  return html`<div class="rt-run" aria-live="polite">
    ${!here && job.folderName ? html`<p class="rt-other"><${Icon} name="info" size=${14} /> Gerando para “${job.folderName}”.</p>` : null}
    <div class="rt-phase">
      <${Spinner} size=${16} />
      <span>${label}</span>
    </div>
    <div class=${cx('rt-bar', frac == null && 'is-indeterminate')}><i style=${frac == null ? '' : `width:${(frac * 100).toFixed(1)}%`}></i></div>
    <div class="rt-current mono-path" title=${p.current || ''}>
      ${p.current || ' '}${p.current && p.fase ? html`<span class="sub"> · ${FASE[p.fase] || ''}${p.frac != null ? ` ${percent(p.frac)}` : ''}</span>` : null}
    </div>
    ${p.phase === 'gerar' ? html`<${Stats} p=${p} />` : null}
  </div>`
}

function Finished({ job }) {
  const p = job.progress || {}
  const good = job.status === 'done' && p.feitos > 0
  const head = job.status !== 'done' ? job.error || 'O lote parou.' : p.feitos && p.phase === 'fim' ? `${plural(p.feitos, 'prévia leve gerada', 'prévias leves geradas')}.` : resumo(p)
  const extra = []
  if (job.status === 'done' && p.jaTinham && p.total) extra.push(`${plural(p.jaTinham, 'vídeo já tinha', 'vídeos já tinham')} prévia ou proxy da câmera.`)
  if (job.status === 'done' && p.jaLeves && p.total) extra.push(`${plural(p.jaLeves, 'vídeo já é leve', 'vídeos já são leves')} e ficou como estava.`)
  return html`<div class="rt-done">
    <div class=${cx('rt-summary', good && 'is-good', job.status !== 'done' && 'is-stopped')}>
      <span class="rt-summary-icon"><${Icon} name=${job.status === 'done' ? (p.feitos ? 'circle-check' : 'info') : 'warning'} size=${20} /></span>
      <div>
        <b>${head}</b>
        ${good ? html`<span class="sub">Ficam na pasta Proxy ao lado de cada original. A prévia já toca a cópia leve.</span>` : null}
        ${extra.map((x) => html`<span class="sub">${x}</span>`)}
      </div>
    </div>
    ${p.total && p.phase === 'fim' ? html`<${Stats} p=${p} />` : null}
    ${p.localTruncated ? html`<p class="rt-note"><${Icon} name="info" size=${14} /> A pasta do computador é grande demais: parei de procurar no meio. Escolha uma pasta mais perto dos originais.</p>` : null}
    ${p.semLocal && !p.feitos && p.localFiles === 0 ? html`<p class="rt-note"><${Icon} name="info" size=${14} /> Não achei nenhum vídeo nessa pasta do computador. O disco ou o cartão está conectado?</p>` : null}
    <${Details} p=${p} />
  </div>`
}

/**
 * @param {{ accountId: string, folder: { id, name }, onClose: Function }} props
 */
export function PreviasDialog({ accountId, folder, onClose }) {
  const settings = useStore((s) => s.settings)
  const job = useStore((s) => s.previas)
  const info = usePreviaInfo(true)
  const [localDir, setLocalDir] = useState(() => settings?.previaLocalDir || settings?.rawThumbLocalDir || '')
  const [recursive, setRecursive] = useState(true)
  const [refazer, setRefazer] = useState(false)
  const [starting, setStarting] = useState(false)
  const [mine, setMine] = useState(() => (job?.status === 'running' ? job.jobId : null))
  const started = useRef(false)

  useEffect(() => {
    openDialogs++
    return () => {
      openDialogs--
    }
  }, [])

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

  const start = async (e) => {
    e?.preventDefault()
    const dir = localDir.trim()
    if (!dir || starting) return
    setStarting(true)
    const res = await attempt(api.post('/api/previas/lote', { accountId, driveFolderId: folder.id, folderName: folder.name, localDir: dir, recursive, refazer }))
    setStarting(false)
    if (!res?.jobId) return
    started.current = true
    setMine(res.jobId)
    setPrevias({ jobId: res.jobId, accountId, driveFolderId: folder.id, folderName: folder.name, localDir: dir, status: 'running', progress: null })
  }

  const stop = () => current && attempt(api.del(`/api/previas/lote/${enc(current.jobId)}`))
  const m = info?.motor || {}
  const blocked = info && !info.unknown && !m.via
  const here = current?.driveFolderId === folder.id

  let footer
  if (running) {
    footer = html`<span class="rt-foot-hint sub">Pode fechar: continua em segundo plano.</span>
      <${Button} onClick=${stop} icon="x">Parar</${Button}>
      <${Button} variant="primary" onClick=${() => onClose()}>Fechar</${Button}>`
  } else if (finished) {
    footer = html`<${Button} onClick=${() => setMine(null)} icon="retry">Gerar de novo</${Button}>
      <${Button} variant="primary" onClick=${() => onClose()} data-autofocus>Concluir</${Button}>`
  } else if (blocked) {
    footer = html`<${Button} variant="primary" onClick=${() => onClose()}>Fechar</${Button}>`
  } else {
    footer = html`<${Button} onClick=${() => onClose()}>Cancelar</${Button}>
      <${Button} variant="primary" icon="film" onClick=${start} loading=${starting} disabled=${!localDir.trim() || !info}>Gerar prévias</${Button}>`
  }

  return html`<${Modal}
    size="md"
    class="dialog rt-dialog previa-dialog"
    title="Gerar prévias leves"
    subtitle=${`Vídeos de “${folder.name}” no Drive`}
    onClose=${() => onClose()}
    footer=${footer}
  >
    ${running
      ? html`<${Running} job=${current} here=${here} />`
      : finished
        ? html`<${Finished} job=${current} />`
        : html`<form class="rt-setup" onSubmit=${start}>
            <p class="dialog-text">Escolha onde estão os originais (HD ou cartão). Para cada vídeo pesado sem prévia, o SOBEDESCE gera uma cópia leve em 1080p e sobe na pasta Proxy ao lado do original. O original não muda.</p>
            ${blocked
              ? html`<div class="rt-warn" role="alert">
                  <${Icon} name="warning" size=${18} />
                  <div><b>Este computador não tem como converter vídeo.</b><span>${m.aviso || 'Não encontramos o ffmpeg.'} O app instalado já traz o ffmpeg; no modo de desenvolvimento, instale o ffmpeg ou rode “node scripts/ffmpeg-baixar.mjs”.</span></div>
                </div>`
              : html`
                  ${m.label ? html`<p class=${cx('previa-engine-line', m.hardware && 'is-hw')}><${Icon} name=${m.hardware ? 'bolt' : 'film'} size=${14} /> ${m.label}</p>` : null}
                  <div class="field">
                    <label class="field-label" for="pv-dir">Originais no computador</label>
                    <div class="rt-pick">
                      <input
                        id="pv-dir"
                        class="input mono"
                        type="text"
                        value=${localDir}
                        placeholder="Escolha a pasta ou cole o caminho"
                        onInput=${(e) => setLocalDir(e.currentTarget.value)}
                        autocomplete="off"
                        spellcheck="false"
                        data-autofocus=${localDir ? undefined : true}
                      />
                      <${Button} icon="folder" onClick=${choose}>Escolher…</${Button}>
                    </div>
                  </div>
                  <div class="rt-checks">
                    <label class="check-label">
                      <${Checkbox} checked=${recursive} onChange=${setRecursive} label="Incluir subpastas" />
                      <span>Incluir subpastas <span class="sub">do Drive</span></span>
                    </label>
                    <label class="check-label">
                      <${Checkbox} checked=${refazer} onChange=${setRefazer} label="Refazer as prévias leves que já existem" />
                      <span>Refazer as prévias leves que já existem <span class="sub">(proxy da câmera fica como está)</span></span>
                    </label>
                  </div>
                  <p class="previa-cost sub"><${Icon} name="disk" size=${13} /> Cada cópia ocupa cerca de 2 a 5% do original no Drive (≈ 40 MB por minuto).</p>
                  <button type="submit" hidden></button>
                `}
          </form>`}
  </${Modal}>`
}

registerModal('previas', PreviasDialog)

export function openPrevias({ accountId, folder }) {
  return openModal('previas', { accountId, folder })
}

export function usePreviasRunning() {
  return useStore((s) => s.previas?.status === 'running')
}
