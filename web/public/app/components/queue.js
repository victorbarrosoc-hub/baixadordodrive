// Fila de envios: cada arquivo é uma linha com ícone do tipo, nome, uma "timeline" (clipe com playhead, como no
// app do computador), velocidade, tempo restante em timecode e o estado.
import { html, useEffect, useState } from '../vendor/preact-htm.js'
import { LAN } from '../lib/config.js'
import { fileLink, folderLink, linkAccess, openLink, openLinkError } from '../lib/drive.js'
import { bytes, fileKind, KIND_ICON, percent, plural, speed, timecode } from '../lib/format.js'
import { closeSheet, folderTrail, openSheet, toast } from '../lib/state.js'
import { engine } from '../lib/uploader.js'
import { Icon } from './icons.js'
import { Button, Pill, copyText, cx, useEngine } from './ui.js'

const clamp01 = (x) => (x > 1 ? 1 : x < 0 ? 0 : x)
const pct = (x) => `${(clamp01(x) * 100).toFixed(3)}%`

export const STATUS = {
  queued: { label: 'Na fila', tone: 'neutral' },
  preparing: { label: 'Preparando', tone: 'up-soft' },
  running: { label: 'Enviando', tone: 'up' },
  paused: { label: 'Pausado', tone: 'muted' },
  needsFile: { label: 'Pausado', tone: 'warning' },
  done: { label: 'Concluído', tone: 'success' },
  skipped: { label: 'Já estava no Drive', tone: 'success-soft' },
  failed: { label: 'Com problema', tone: 'error' },
  // Modo Wi-Fi: chegou inteiro no computador, que está subindo pro Drive.
  mac: { label: `No ${LAN?.label || 'Mac'}`, tone: 'up-soft' },
}

/** Nome com reticências no MEIO: o fim (extensão) sempre aparece. "A001_C003_08…_RAW.mov" */
export function FileName({ name, class: klass = 'row-name' }) {
  const dot = name.lastIndexOf('.')
  const tail = Math.min(name.length, dot > 0 && name.length - dot <= 8 ? name.length - dot + 4 : 7)
  if (name.length <= 16) return html`<span class=${cx(klass, 'fname')} title=${name}><span class="fname-head">${name}</span></span>`
  // Espaço bem no corte viraria nada (fim/início de item flex): vira espaço que não quebra.
  const head = name.slice(0, -tail).replace(/ $/, '\u00a0')
  const end = name.slice(-tail).replace(/^ /, '\u00a0')
  return html`<span class=${cx(klass, 'fname')} title=${name}><span class="fname-head">${head}</span><span class="fname-tail">${end}</span></span>`
}

export const driveLink = fileLink

// ───── compartilhar link ─────

/**
 * Compartilhar o link de um arquivo ou pasta do Drive: o menu do sistema (navigator.share, no iPhone) e, sem ele,
 * copiar. Ao abrir, confere quem consegue abrir o link; se for só quem tem acesso, avisa e oferece liberar para
 * "qualquer pessoa com o link", sempre com uma confirmação na tela antes de mudar algo no Drive.
 * `children` vai antes do botão, na mesma linha (o "Abrir no Drive" da prévia).
 */
export function ShareLink({ id, name, folder = false, label, variant = 'secondary', class: klass, children }) {
  // undefined = conferindo; null = não deu para saber; { open: true|false|null, canShare, link }
  const [acc, setAcc] = useState(undefined)
  const [step, setStep] = useState(null) // null | 'confirm' | 'busy'
  const [err, setErr] = useState(null) // { policy, text }
  const [manual, setManual] = useState(null) // link para copiar à mão (o aparelho não deixou copiar)
  useEffect(() => {
    const ctl = new AbortController()
    setAcc(undefined)
    setStep(null)
    setErr(null)
    setManual(null)
    linkAccess(id, { folder, signal: ctl.signal }).then(
      (a) => !ctl.signal.aborted && setAcc(a),
      () => !ctl.signal.aborted && setAcc(null),
    )
    return () => ctl.abort()
  }, [id])
  const link = acc?.link || (folder ? folderLink(id) : fileLink(id))
  const copy = async () => {
    if (await copyText(link)) toast('Link copiado', { tone: 'success' })
    else setManual(link)
  }
  // O Safari só abre o menu de compartilhar dentro do toque: navigator.share é chamado na hora, sem nada antes.
  // Fechar o menu (AbortError) é só cancelar; outra recusa cai no copiar.
  const share = () => {
    if (typeof navigator.share !== 'function') return copy()
    let p
    try {
      p = navigator.share({ title: name, url: link })
    } catch (e) {
      p = Promise.reject(e)
    }
    Promise.resolve(p).catch((e) => {
      // AbortError: a pessoa fechou o menu. InvalidStateError: já havia um menu aberto (toque duplo).
      if (e?.name !== 'AbortError' && e?.name !== 'InvalidStateError') copy()
    })
  }
  const liberar = async () => {
    setStep('busy')
    setErr(null)
    try {
      await openLink(id)
      setAcc((a) => ({ ...(a || { canShare: true, link }), open: true }))
      setStep(null)
      // A prévia aberta deste arquivo troca para o player do Drive (vídeo pesado) sem precisar reabrir.
      window.dispatchEvent(new CustomEvent('sd-link-aberto', { detail: { id } }))
      toast('Liberado. Agora é só compartilhar', { tone: 'success' })
    } catch (e) {
      setErr(openLinkError(e))
      setStep(null)
    }
  }
  const what = folder ? 'o que está nesta pasta' : 'este arquivo'
  return html`<div class=${cx('share', klass)}>
    <div class="share-acts">
      ${children}
      <${Button} variant=${variant} class="share-btn" icon="share" onClick=${share}>${label || (folder ? 'Compartilhar pasta' : 'Compartilhar link')}</${Button}>
    </div>
    ${acc?.open === false
      ? html`<div class=${cx('share-note', 'is-closed', err?.policy && 'is-policy')} role="status">
          <${Icon} name="eye-off" size=${18} />
          <div>
            <b class="share-title">Só quem tem acesso consegue abrir</b>
            ${err
              ? html`<p class="share-err" role="alert">${err.text}</p>`
              : !acc.canShare
                ? html`<p>Você não pode mudar o compartilhamento deste item. Peça a quem é dono.</p>`
                : null}
            ${acc.canShare && !err?.policy
              ? step === 'confirm' || step === 'busy'
                ? html`<div class="share-confirm">
                    <p><b>Qualquer pessoa com o link vai poder ver e baixar</b> ${what}.</p>
                    <div class="share-confirm-acts">
                      <${Button} variant="primary" size="sm" loading=${step === 'busy'} disabled=${step === 'busy'} onClick=${liberar}>Liberar</${Button}>
                      <${Button} variant="secondary" size="sm" disabled=${step === 'busy'} onClick=${() => setStep(null)}>Cancelar</${Button}>
                    </div>
                  </div>`
                : html`<button type="button" class="link-btn share-open" onClick=${() => (setErr(null), setStep('confirm'))}>Liberar para quem tiver o link</button>`
              : null}
          </div>
        </div>`
      : acc?.open
        ? html`<p class="share-note is-open"><${Icon} name="link" size=${16} /> <span>Qualquer pessoa com o link consegue abrir.</span></p>`
        : null}
    ${manual
      ? html`<div class="share-manual">
          <p>Não consegui copiar sozinho. Toque e segure no link para copiar:</p>
          <input class="input mono" type="text" readonly value=${manual} aria-label="Link" onFocus=${(e) => e.currentTarget.select()} />
        </div>`
      : null}
  </div>`
}

/**
 * Fim do lote: os arquivos de uma pasta terminaram todos. "3 arquivos em Diária 02 · Compartilhar pasta".
 * Um cartão por pasta de destino (o Meu Drive e a raiz de um Drive compartilhado não se compartilham por link).
 */
export function BatchCards({ items }) {
  if (LAN) return null
  const groups = new Map()
  for (const it of items) {
    if (!it.folder) continue
    const g = groups.get(it.folder.id) || { folder: it.folder, n: 0, open: 0, at: 0 }
    if (it.status === 'done' || it.status === 'skipped') {
      g.n++
      g.at = Math.max(g.at, it.finishedAt || 0)
    } else g.open++
    groups.set(it.folder.id, g)
  }
  const done = [...groups.values()]
    .filter((g) => g.n && !g.open && g.folder.id !== 'root' && g.folder.id !== g.folder.driveId)
    .sort((a, b) => b.at - a.at)
  if (!done.length) return null
  return html`${done.map(
    (g) => html`<section key=${g.folder.id} class="group batch" aria-label=${`Lote enviado para ${g.folder.name}`}>
      <div class="batch-head">
        <span class="batch-icon" aria-hidden="true"><${Icon} name="circle-check" size=${20} /></span>
        <div class="batch-text">
          <b>${plural(g.n, 'arquivo', 'arquivos')} em ${g.folder.name}</b>
          <span class="sub">${folderTrail(g.folder, { skipLast: true }) || 'Meu Drive'}</span>
        </div>
      </div>
      <${ShareLink} id=${g.folder.id} name=${g.folder.name} folder class="batch-share" />
    </section>`,
  )}`
}

export function progressOf(it) {
  if (it.status === 'done' || it.status === 'skipped') return 1
  // No computador: a barra passa a mostrar a subida dele pro Drive.
  if (it.status === 'mac') return it.drive?.size ? clamp01((it.drive.bytesDone || 0) / it.drive.size) : 0
  return it.size ? clamp01((it.offset + it.inflight) / it.size) : 0
}

export function Timeline({ it }) {
  const p = progressOf(it)
  const live = it.status === 'running' || (it.status === 'mac' && it.drive?.status === 'running')
  const klass = cx(
    'tl',
    it.status === 'mac' && 'is-mac',
    it.status === 'paused' && 'is-paused',
    it.status === 'needsFile' && 'is-paused',
    it.status === 'queued' && 'is-queued',
    it.status === 'preparing' && 'is-queued',
    it.status === 'failed' && 'is-failed',
    it.status === 'done' && 'is-done',
    it.status === 'skipped' && 'is-skipped',
  )
  return html`<div class=${klass} role="progressbar" aria-label=${`${percent(p)} enviado`} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(p * 100)}>
    <div class="tl-clip">
      <div class="tl-fill" style=${`width:${pct(p)}`}></div>
      ${live ? html`<div class="tl-head" style=${`left:${pct(p)}`}></div>` : null}
    </div>
  </div>`
}

/** Barra do lote: um clipe por arquivo, proporcional ao tamanho (como clipes numa sequência). */
export function SequenceBar({ items }) {
  const list = items.length > 120 ? items.slice(-120) : items
  const total = list.reduce((a, it) => a + Math.max(it.size, 1), 0) || 1
  let left = 0
  return html`<div class="seq" aria-hidden="true">
    ${list.map((it) => {
      const w = Math.max(it.size, 1) / total
      const style = `left:${pct(left)};width:${pct(w)}`
      left += w
      return html`<div key=${it.id} class=${cx('seq-clip', it.status === 'running' && 'is-running', it.status === 'failed' && 'is-failed')} style=${style}>
        <div class="seq-fill" style=${`width:${pct(progressOf(it))}`}></div>
      </div>`
    })}
  </div>`
}

/** "33,6 de 200 MB" (mesma unidade) ou "812 KB de 2,1 GB". */
function partOf(done, total) {
  const a = bytes(done, { fixed: true })
  const b = bytes(total)
  const ua = a.split(' ')[1]
  const ub = b.split(' ')[1]
  return ua === ub ? `${a.split(' ')[0]} de ${b}` : `${a} de ${b}`
}

function Meta({ it, waiting }) {
  const done = it.offset + it.inflight
  switch (it.status) {
    case 'running': {
      const eta = it.speed > 0 ? (it.size - done) / it.speed : null
      if (it.note) return html`<span class="row-note">${it.note}</span>`
      return html`<span class="row-left row-nums">${partOf(done, it.size)} · ${speed(it.speed)}</span>
        <span class="tc row-tc" aria-label=${`faltam ${timecode(eta)}`}>${timecode(eta)}</span>`
    }
    case 'preparing':
      return html`<span class="row-nums">${bytes(it.size)}</span><span class="row-dot" aria-hidden="true">·</span>
        <span class="row-note">${waiting ? 'esperando a conta' : (it.note || 'um instante…').toLowerCase()}</span>`
    case 'queued':
      return html`<span class="row-nums">${bytes(it.size)}</span><span class="row-dot" aria-hidden="true">·</span><span class="row-note">aguardando a vez</span>`
    case 'paused':
      return html`<span class="row-nums">${partOf(done, it.size)}</span><span class="row-dot" aria-hidden="true">·</span><span class="row-note">${it.authPaused ? 'espera reconectar' : percent(progressOf(it))}</span>`
    case 'needsFile':
      return html`<span class="row-note is-wrap">${percent(progressOf(it))} enviado · escolha o arquivo de novo para continuar</span>`
    case 'done':
      return html`<span class="row-nums">${bytes(it.size)}</span>
        ${it.sizeOk
          ? html`<span class="row-ok" title="O Drive recebeu exatamente o tamanho do arquivo" aria-label="tamanho confere com o Drive"><${Icon} name="check" size=${13} strokeWidth=${2.4} /><span aria-hidden="true">confere</span></span>`
          : null}
        ${it.fileId
          ? html`<a class="row-link" href=${driveLink(it.fileId)} target="_blank" rel="noopener noreferrer" onClick=${(e) => e.stopPropagation()}>
              Abrir no Drive <${Icon} name="external" size=${13} />
            </a>`
          : null}`
    case 'skipped':
      return html`<span class="row-nums">${bytes(it.size)}</span>
        ${LAN ? null : html`<button type="button" class="row-link" onClick=${(e) => (e.stopPropagation(), engine.sendAnyway(it))}>Enviar mesmo assim</button>`}`
    case 'failed':
      return html`<span class="row-error">${it.error}</span>`
    case 'mac': {
      const where = `No ${LAN?.label || 'Mac'}`
      if (it.note) return html`<span class="row-note">${where} · ${it.note.toLowerCase()}</span>`
      const d = it.drive
      const what =
        d?.status === 'paused'
          ? 'pausado no computador'
          : d?.status === 'waiting'
            ? 'esperando o limite do Google'
            : d?.status === 'verifying'
              ? 'conferindo no Drive'
              : 'subindo pro Drive'
      const extra = d?.status === 'running' && d.speed > 0 ? ` · ${speed(d.speed)}` : ''
      return html`<span class="row-left row-nums">${where} · ${what}${extra}</span>
        <span class="tc row-tc">${percent(progressOf(it))}</span>`
    }
    default:
      return null
  }
}

export function QueueRow({ it, waiting }) {
  const kind = fileKind(it.name, it.type)
  const st = STATUS[it.status] || STATUS.queued
  return html`<li class=${cx('row', `is-${it.status}`)}>
    <button type="button" class="row-hit" onClick=${() => openSheet('item', { id: it.id })} aria-label=${`${it.name}, ${st.label}. Mais opções`}>
      <span class=${cx('row-tile', `tone-${it.status}`)} aria-hidden="true"><${Icon} name=${KIND_ICON[kind]} size=${20} /></span>
      <span class="row-main">
        <span class="row-top">
          <${FileName} name=${it.name} />
          <${Pill} tone=${st.tone}>${st.label}</${Pill}>
        </span>
        <${Timeline} it=${it} />
      </span>
    </button>
    <div class="row-meta">
      <${Meta} it=${it} waiting=${waiting} />
    </div>
    ${it.status === 'failed'
      ? html`<div class="row-actions">
          <button type="button" class="btn btn-secondary btn-sm" onClick=${() => engine.retry(it)}>
            <${Icon} name="retry" size=${15} /><span>Tentar de novo</span>
          </button>
        </div>`
      : null}
  </li>`
}

/** Sheet de um item: detalhes e ações. */
export function ItemSheet({ id }) {
  useEngine()
  const it = engine.items.find((x) => x.id === id)
  if (!it) return html`<div class="sheet-body"><p class="sub center">Este item saiu da fila.</p></div>`
  const st = STATUS[it.status] || STATUS.queued
  const act = (fn) => () => {
    fn()
    closeSheet()
  }
  const kind = fileKind(it.name, it.type)
  return html`<div class="sheet-body item-sheet">
    <div class="item-head" data-drag>
      <span class=${cx('row-tile', 'row-tile-lg', `tone-${it.status}`)} aria-hidden="true"><${Icon} name=${KIND_ICON[kind]} size=${24} /></span>
      <div class="item-titles">
        <h2 class="item-name">${it.name}</h2>
        <p class="sub">${bytes(it.size)} · ${folderTrail(it.folder)}</p>
      </div>
    </div>
    <div class="item-state">
      <${Pill} tone=${st.tone}>${st.label}</${Pill}>
      <span class="sub">${it.status === 'failed' ? '' : it.status === 'done' && it.sizeOk ? 'Tamanho confere com o Drive' : percent(progressOf(it))}</span>
    </div>
    ${it.status === 'failed' ? html`<p class="item-error">${it.error}</p>` : null}
    ${it.status === 'needsFile'
      ? html`<p class="item-explain">A página foi recarregada no meio do envio. Escolha este mesmo arquivo de novo que ele continua de onde parou.</p>`
      : null}
    ${(it.status === 'done' || it.status === 'skipped') && it.fileId && !LAN
      ? html`<${ShareLink} id=${it.fileId} name=${it.name} variant="primary" class="item-share" />`
      : null}
    ${it.status === 'mac'
      ? html`<p class="item-explain">O arquivo já está inteiro no ${LAN?.label || 'computador'}. O SOBEDESCE de lá está subindo pro Drive — pode fechar esta tela.</p>`
      : null}
    <ul class="group menu">
      ${it.status === 'running' || it.status === 'queued' || it.status === 'preparing'
        ? html`<li><button type="button" class="menu-item" onClick=${act(() => engine.pause(it))}><${Icon} name="pause" /><span>Pausar este arquivo</span></button></li>`
        : null}
      ${it.status === 'paused'
        ? html`<li><button type="button" class="menu-item" onClick=${act(() => engine.resume(it))}><${Icon} name="play" /><span>Continuar</span></button></li>`
        : null}
      ${it.status === 'failed'
        ? html`<li><button type="button" class="menu-item" onClick=${act(() => engine.retry(it))}><${Icon} name="retry" /><span>Tentar de novo</span></button></li>`
        : null}
      ${(it.status === 'done' || it.status === 'skipped') && it.fileId
        ? html`<li><a class="menu-item" href=${driveLink(it.fileId)} target="_blank" rel="noopener noreferrer"><${Icon} name="external" /><span>Abrir no Drive</span></a></li>`
        : null}
      ${it.status === 'skipped' && !LAN
        ? html`<li><button type="button" class="menu-item" onClick=${act(() => engine.sendAnyway(it))}><${Icon} name="copy" /><span>Enviar mesmo assim (outra cópia)</span></button></li>`
        : null}
      <li>
        <button type="button" class=${cx('menu-item', !(it.status === 'done' || it.status === 'skipped' || it.status === 'mac') && 'is-danger')} onClick=${act(() => engine.remove(it))}>
          <${Icon} name=${it.status === 'done' || it.status === 'skipped' || it.status === 'mac' ? 'x' : 'trash'} />
          <span>${it.status === 'done' || it.status === 'skipped' || it.status === 'mac' ? 'Tirar da lista' : it.status === 'needsFile' ? 'Descartar este envio' : 'Cancelar este envio'}</span>
        </button>
      </li>
    </ul>
  </div>`
}
ItemSheet.label = 'Opções do arquivo'
