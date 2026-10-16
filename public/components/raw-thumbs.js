// "Gerar miniaturas" (tela Drive): miniatura para os BRAW/R3D que já estão no Drive. A pessoa aponta onde estão os
// originais (HD ou cartão); o motor acha os mesmos arquivos (nome + tamanho), tira um frame e grava no Drive
// (src/media/raw-thumb-lote.js). Nada é enviado de novo.
import { html, useEffect, useRef, useState } from '/vendor/preact-htm.js'
import { api, attempt, enc } from '../lib/api.js'
import { setRawThumbs, subscribe, useStore } from '../lib/store.js'
import { openModal, registerModal } from '../lib/modals.js'
import { pickFolderPath } from '../lib/desktop.js'
import { bustThumbs } from '../lib/media.js'
import { toast } from '../lib/toasts.js'
import { bytes, count, extOf, plural } from '../lib/format.js'
import { cx } from '../lib/ui.js'
import { Icon } from './icons.js'
import { Button, Checkbox, Spinner } from './common.js'
import { Modal } from './modal.js'
import { invalidateAccount } from './drive-data.js'

const RAW_EXT = new Set(['braw', 'r3d'])
const TERMINAL = new Set(['done', 'canceled', 'error'])

/** A lista tem .braw/.r3d? (o botão aparece só aí) */
export const hasRawFiles = (items) => !!items?.some((x) => !x.isFolder && RAW_EXT.has(extOf(x.name)))

/** "12 miniaturas gravadas · 3 sem arquivo no computador · 1 com tamanho diferente" (igual ao resumoLote do motor). */
export function resumo(p) {
  if (!p) return ''
  if (!p.total) return p.jaTinham ? `Nada a fazer: ${plural(p.jaTinham, 'RAW já tinha miniatura', 'RAW já tinham miniatura')}.` : 'Nenhum RAW sem miniatura nesta pasta.'
  const parts = [plural(p.feitos, 'miniatura gravada', 'miniaturas gravadas')]
  if (p.semLocal) parts.push(`${count(p.semLocal)} sem arquivo no computador`)
  if (p.tamanhoDiferente) parts.push(`${count(p.tamanhoDiferente)} com tamanho diferente`)
  if (p.falhou) parts.push(plural(p.falhou, 'falhou', 'falharam'))
  return parts.join(' · ')
}

// ───── fim do lote: miniaturas novas aparecem em qualquer tela, aviso quando a janela está fechada ─────

let openDialogs = 0
const doneSubs = new Set()
const seenStatus = new Map() // jobId -> último status visto

/** Avisa quando um lote termina (a tela Drive recarrega a pasta). Devolve a função para parar. */
export function onRawThumbsDone(fn) {
  doneSubs.add(fn)
  return () => doneSubs.delete(fn)
}

subscribe((state) => {
  const job = state.rawThumbs
  if (!job?.jobId) return
  const prev = seenStatus.get(job.jobId)
  if (prev === job.status) return
  seenStatus.set(job.jobId, job.status)
  // Só a passagem de "rodando" para o fim conta (o resumo que já vem no hello não repete aviso).
  if (prev !== 'running' || !TERMINAL.has(job.status)) return
  const ids = job.progress?.feitosIds || []
  if (ids.length) {
    bustThumbs(job.accountId, ids)
    invalidateAccount(job.accountId)
  }
  for (const fn of doneSubs) {
    try {
      fn(job)
    } catch {}
  }
  if (!openDialogs) {
    if (job.status === 'done') toast(job.progress?.feitos ? 'success' : 'info', resumo(job.progress))
    else if (job.status === 'error') toast('error', job.error || 'O lote de miniaturas não terminou.')
  }
})

// ───── janela ─────

/** O que este computador tem para tirar o frame (GET /api/raw-thumbs). */
function useExtractorInfo() {
  const [info, setInfo] = useState(null)
  useEffect(() => {
    let live = true
    api
      .get('/api/raw-thumbs?refresh=1')
      .then((r) => live && setInfo(r.rawThumbs || { supported: false }))
      .catch(() => live && setInfo({ supported: true, found: true, unknown: true }))
    return () => {
      live = false
    }
  }, [])
  return info
}

function Stat({ n, label, tone }) {
  return html`<div class=${cx('rt-stat', tone && `is-${tone}`, !n && 'is-zero')}>
    <b class="num">${count(n || 0)}</b>
    <span>${label}</span>
  </div>`
}

function Stats({ p }) {
  return html`<div class="rt-stats">
    <${Stat} n=${p.feitos} label=${p.feitos === 1 ? 'gravada' : 'gravadas'} tone="ok" />
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

function Running({ job, here }) {
  const p = job.progress || {}
  const total = p.aGerar || 0
  const done = (p.feitos || 0) + (p.falhou || 0)
  let label
  let frac = null
  if (!p.phase || p.phase === 'drive') label = 'Procurando os RAW no Drive…'
  else if (p.phase === 'local') label = `Procurando no computador… ${plural(p.localFiles || 0, 'RAW achado', 'RAW achados')}`
  else {
    label = total ? `Gravando ${count(Math.min(total, done + 1))} de ${count(total)}` : 'Terminando…'
    frac = total ? done / total : 1
  }
  return html`<div class="rt-run" aria-live="polite">
    ${!here && job.folderName ? html`<p class="rt-other"><${Icon} name="info" size=${14} /> Gerando para “${job.folderName}”.</p>` : null}
    <div class="rt-phase">
      <${Spinner} size=${16} />
      <span>${label}</span>
    </div>
    <div class=${cx('rt-bar', frac == null && 'is-indeterminate')}><i style=${frac == null ? '' : `width:${(frac * 100).toFixed(1)}%`}></i></div>
    <div class="rt-current mono-path" title=${p.current || ''}>${p.current || ' '}</div>
    ${p.phase === 'gerar' ? html`<${Stats} p=${p} />` : null}
  </div>`
}

function Finished({ job }) {
  const p = job.progress || {}
  const good = job.status === 'done' && p.feitos > 0
  // Com os quadros de números embaixo, o título fica só com o principal.
  const head = job.status !== 'done' ? job.error || 'O lote parou.' : p.feitos && p.phase === 'fim' ? `${plural(p.feitos, 'miniatura gravada', 'miniaturas gravadas')}.` : resumo(p)
  return html`<div class="rt-done">
    <div class=${cx('rt-summary', good && 'is-good', job.status !== 'done' && 'is-stopped')}>
      <span class="rt-summary-icon"><${Icon} name=${job.status === 'done' ? (p.feitos ? 'circle-check' : 'info') : 'warning'} size=${20} /></span>
      <div>
        <b>${head}</b>
        ${job.status === 'done' && p.feitos ? html`<span class="sub">Já aparecem aqui e no Google Drive.</span>` : null}
        ${job.status === 'done' && p.jaTinham && p.total ? html`<span class="sub">${plural(p.jaTinham, 'RAW já tinha', 'RAW já tinham')} miniatura e ficou como estava.</span>` : null}
      </div>
    </div>
    ${p.total && p.phase === 'fim' ? html`<${Stats} p=${p} />` : null}
    ${p.localTruncated ? html`<p class="rt-note"><${Icon} name="info" size=${14} /> A pasta do computador é grande demais: parei de procurar no meio. Escolha uma pasta mais perto dos originais.</p>` : null}
    ${p.semLocal && !p.feitos && p.localFiles === 0 ? html`<p class="rt-note"><${Icon} name="info" size=${14} /> Não achei nenhum RAW nessa pasta do computador. O disco ou o cartão está conectado?</p>` : null}
    <${Details} p=${p} />
  </div>`
}

/**
 * @param {{ accountId: string, folder: { id, name }, onClose: Function }} props
 */
export function RawThumbsDialog({ accountId, folder, onClose }) {
  const settings = useStore((s) => s.settings)
  const job = useStore((s) => s.rawThumbs)
  const info = useExtractorInfo()
  const [localDir, setLocalDir] = useState(() => settings?.rawThumbLocalDir || '')
  const [recursive, setRecursive] = useState(true)
  const [refazer, setRefazer] = useState(false)
  const [starting, setStarting] = useState(false)
  const [mine, setMine] = useState(() => (job?.status === 'running' ? job.jobId : null))
  const startedHere = useRef(false)

  useEffect(() => {
    openDialogs++
    return () => {
      openDialogs--
    }
  }, [])

  const current = job && (job.jobId === mine || job.status === 'running') ? job : null
  const running = current?.status === 'running'
  const finished = current && TERMINAL.has(current.status) && current.jobId === mine

  // Se o SSE cair, consulta de vez em quando enquanto roda.
  useEffect(() => {
    if (!running) return undefined
    const t = setInterval(async () => {
      try {
        setRawThumbs(await api.get(`/api/raw-thumbs/lote/${enc(current.jobId)}`))
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
    const res = await attempt(api.post('/api/raw-thumbs/lote', { accountId, driveFolderId: folder.id, folderName: folder.name, localDir: dir, recursive, refazer }))
    setStarting(false)
    if (!res?.jobId) return
    startedHere.current = true
    setMine(res.jobId)
    setRawThumbs({ jobId: res.jobId, accountId, driveFolderId: folder.id, folderName: folder.name, localDir: dir, status: 'running', progress: null })
  }

  const stop = () => current && attempt(api.del(`/api/raw-thumbs/lote/${enc(current.jobId)}`))
  const again = () => setMine(null)

  const blocked = info && !info.supported
  const unsure = info && info.supported && !info.found && !info.unknown
  const here = current?.driveFolderId === folder.id

  let footer
  if (running) {
    footer = html`<span class="rt-foot-hint sub">Pode fechar: continua em segundo plano.</span>
      <${Button} onClick=${stop} icon="x">Parar</${Button}>
      <${Button} variant="primary" onClick=${() => onClose()}>Fechar</${Button}>`
  } else if (finished) {
    footer = html`<${Button} onClick=${again} icon="retry">Gerar de novo</${Button}>
      <${Button} variant="primary" onClick=${() => onClose()} data-autofocus>Concluir</${Button}>`
  } else if (blocked) {
    footer = html`<${Button} variant="primary" onClick=${() => onClose()}>Fechar</${Button}>`
  } else {
    footer = html`<${Button} onClick=${() => onClose()}>Cancelar</${Button}>
      <${Button} variant=${unsure ? 'secondary' : 'primary'} icon="photo" onClick=${start} loading=${starting} disabled=${!localDir.trim() || !info}>
        ${unsure ? 'Tentar assim mesmo' : 'Gerar miniaturas'}
      </${Button}>`
  }

  return html`<${Modal}
    size="md"
    class="dialog rt-dialog"
    title="Gerar miniaturas"
    subtitle=${`RAW de “${folder.name}” no Drive`}
    onClose=${() => onClose()}
    footer=${footer}
  >
    ${running
      ? html`<${Running} job=${current} here=${here} />`
      : finished
        ? html`<${Finished} job=${current} />`
        : html`<form class="rt-setup" onSubmit=${start}>
            <p class="dialog-text">Escolha onde estão os originais (HD ou cartão). O SOBEDESCE acha os mesmos arquivos, tira um frame e grava a miniatura no Drive. Nada é enviado de novo.</p>
            ${blocked
              ? html`<div class="rt-warn" role="alert">
                  <${Icon} name="warning" size=${18} />
                  <div><b>Este computador não tem como tirar frame de RAW.</b><span>Funciona no Mac (Quick Look) e no Windows (miniatura do Explorer), com o Blackmagic RAW instalado.</span>
                    <a href=${info.downloadUrl || 'https://www.blackmagicdesign.com/products/blackmagicraw'} target="_blank" rel="noopener noreferrer">Baixar o Blackmagic RAW</a></div>
                </div>`
              : html`
                  ${unsure
                    ? html`<div class="rt-warn" role="status">
                        <${Icon} name="warning" size=${18} />
                        <div><b>Não encontramos o Blackmagic RAW neste computador.</b><span>Sem ele (ou outro leitor, como o Calibrated QuickLook), o frame não sai.</span>
                          <a href=${info.downloadUrl} target="_blank" rel="noopener noreferrer">Baixar o Blackmagic RAW</a></div>
                      </div>`
                    : null}
                  <div class="field">
                    <label class="field-label" for="rt-dir">Originais no computador</label>
                    <div class="rt-pick">
                      <input
                        id="rt-dir"
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
                      <${Checkbox} checked=${refazer} onChange=${setRefazer} label="Refazer as que já têm miniatura" />
                      <span>Refazer as que já têm miniatura</span>
                    </label>
                  </div>
                  <button type="submit" hidden></button>
                `}
          </form>`}
  </${Modal}>`
}

registerModal('rawthumbs', RawThumbsDialog)

/** Abre a janela para a pasta do Drive. */
export function openRawThumbs({ accountId, folder }) {
  return openModal('rawthumbs', { accountId, folder })
}

/** Estado do lote, para o botão da barra mostrar que está rodando. */
export function useRawThumbsRunning() {
  return useStore((s) => s.rawThumbs?.status === 'running')
}
