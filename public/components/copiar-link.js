// Tela Drive: "Copiar de um link". Cola o link do Drive de outra pessoa, vê o que tem, escolhe a pasta no seu Drive e
// copia (src/server/copiar.js; a cópia é do Google, nada passa por este computador). A janela pode fechar no meio: a
// cópia segue e o botão do topo mostra o andamento e reabre a janela.
import { html, useEffect, useRef, useState } from '/vendor/preact-htm.js'
import { api, enc } from '../lib/api.js'
import { openModal, pickDriveFolder, registerModal } from '../lib/modals.js'
import { useStore } from '../lib/store.js'
import { bytes, count, plural } from '../lib/format.js'
import { cx } from '../lib/ui.js'
import { driveFolderUrl } from '../lib/actions.js'
import { pickFolderPath } from '../lib/desktop.js'
import { navigate } from '../lib/router.js'
import { Icon } from './icons.js'
import { Button, Checkbox, Spinner } from './common.js'
import { Modal } from './modal.js'
import { invalidateAccount } from './drive-data.js'

const DRIVE_LINK = /https?:\/\/(drive|docs)\.google\.com\/\S+/

function Resumo({ p }) {
  const parts = [plural(p.arquivos, 'arquivo', 'arquivos')]
  if (p.subpastas) parts.push(plural(p.subpastas, 'subpasta', 'subpastas'))
  if (p.bytes) parts.push(bytes(p.bytes))
  return html`<div class="cl-what">
    <span class="cl-icon"><${Icon} name=${p.pasta ? 'folder' : 'doc'} size=${22} /></span>
    <span class="cl-text">
      <b title=${p.nome}>${p.nome}</b>
      <span class="sub">${parts.join(' · ')}${p.dono ? ` · de ${p.dono}` : ''}</span>
    </span>
  </div>`
}

function Falhas({ list }) {
  if (!list?.length) return null
  return html`<details class="rt-details">
    <summary>${plural(list.length, 'arquivo não copiado', 'arquivos não copiados')}</summary>
    <ul class="cl-fails">
      ${list.slice(0, 300).map((f) => html`<li><span class="mono-path" title=${f.name}>${f.name}</span><span class="sub">${f.why}</span></li>`)}
    </ul>
  </details>`
}

/** @param {{ accountId: string, dest?: { id, name, path, driveId }|null, onClose: () => void }} props */
function CopyLinkDialog({ accountId, dest: destInicial = null, onClose }) {
  const copia = useStore((s) => s.copia)
  const pastaDownloads = useStore((s) => s.settings?.downloadDir || null)
  const [link, setLink] = useState('')
  const [plano, setPlano] = useState(null)
  const [dest, setDest] = useState(destInicial)
  const [lendo, setLendo] = useState(false)
  const [erro, setErro] = useState(null)
  const [indo, setIndo] = useState(false)
  // "Também baixar para…": pasta no HD/SSD/cartão (null = só copiar para o Drive).
  const [localDir, setLocalDir] = useState(null)
  const [jobId, setJobId] = useState(() => (copia?.status === 'running' ? copia.jobId : null))
  const ac = useRef(null)
  useEffect(() => () => ac.current?.abort(), [])

  const job = jobId && copia?.jobId === jobId ? copia : null
  // Terminou: a pasta de destino (e as outras desta conta) recarregam na próxima vez que aparecerem.
  const fim = job && job.status !== 'running'
  useEffect(() => {
    if (fim) invalidateAccount(job.accountId)
  }, [fim])

  const ler = async (texto = link) => {
    if (!DRIVE_LINK.test(texto)) return setErro('Cole um link do Google Drive (pasta ou arquivo).')
    ac.current?.abort()
    ac.current = new AbortController()
    setLendo(true)
    setErro(null)
    setPlano(null)
    try {
      const r = await api.post(`/api/copiar/${enc(accountId)}/ler`, { link: texto.trim() })
      setPlano(r.plano)
    } catch (err) {
      setErro(err?.message || 'Não consegui abrir esse link agora.')
    } finally {
      setLendo(false)
    }
  }
  // Colou um link: já lê (como o "Salvar link" das Referências).
  useEffect(() => {
    if (!DRIVE_LINK.test(link) || plano || lendo) return
    const t = setTimeout(() => ler(link), 250)
    return () => clearTimeout(t)
  }, [link])

  const escolher = async () => {
    const f = await pickDriveFolder({ accountId, title: 'Para qual pasta do seu Drive?', confirmLabel: 'Copiar para cá', initialFolderId: dest?.id || 'root' })
    if (f) setDest(f)
  }
  const [, redesenhar] = useState(0)
  const escolherLocal = async () => {
    const p = await pickFolderPath({ title: 'Baixar para qual pasta do computador (HD, SSD, cartão)?', defaultPath: localDir || pastaDownloads || undefined })
    if (p) setLocalDir(p)
    else redesenhar((n) => n + 1) // cancelou: a caixa volta a ficar desmarcada
  }
  const copiar = async () => {
    if (!plano || !dest || indo) return
    setIndo(true)
    setErro(null)
    try {
      const r = await api.post(`/api/copiar/${enc(accountId)}`, {
        planoId: plano.planoId,
        dest: { id: dest.id, name: dest.name, path: dest.path || null, driveId: dest.driveId || null },
        localDir: localDir || null,
      })
      setJobId(r.copia?.jobId || null)
    } catch (err) {
      setErro(err?.message || 'Não consegui começar a cópia.')
    } finally {
      setIndo(false)
    }
  }
  const parar = () => job && api.del(`/api/copiar/${enc(job.jobId)}`).catch(() => {})
  const outro = () => {
    setJobId(null)
    setPlano(null)
    setLink('')
    setErro(null)
  }

  let body
  let footer
  let title = 'Copiar de um link'
  if (job) {
    const p = job.progress || { done: 0, total: 0, bytesDone: 0, bytesTotal: 0, failed: [] }
    const frac = p.total ? Math.min(1, p.done / p.total) : 0
    const bloqueados = job.plano?.bloqueados || 0
    const copiados = p.done - Math.max(0, (p.failed?.length || 0) - bloqueados)
    const aberto = p.newFolderId || job.dest?.id
    const dl = job.download
    const pasta = (d) => html`<span class="mono-path" title=${d.destDir}>${d.destDir}</span>`
    const baixando = dl
      ? html`<div class="cl-local">
          <${Icon} name=${dl.status === 'erro' ? 'warning' : 'download'} size=${16} />
          <span>${dl.status === 'aguardando'
            ? html`Quando a cópia terminar, baixa da sua cópia no Drive para ${pasta(dl)}.`
            : dl.status === 'erro'
              ? html`Não consegui baixar para ${pasta(dl)}: ${dl.error}`
              : dl.count
                ? html`<b>${plural(dl.count, 'arquivo', 'arquivos')}${dl.bytes ? ` · ${bytes(dl.bytes)}` : ''}</b> baixando da sua cópia para ${pasta(dl)}`
                : html`Nada para baixar para ${pasta(dl)}${dl.skipped ? ' (já estava lá)' : ''}.`}</span>
          ${dl.count ? html`<button type="button" class="link-btn" onClick=${() => (onClose(), navigate('transferencias'))}>Ver em Transferências</button>` : null}
        </div>`
      : null
    if (job.status === 'running') {
      title = 'Copiando…'
      body = html`<${Resumo} p=${job.plano} />
        <div class="rt-run" aria-live="polite">
          <div class="rt-phase"><${Spinner} size=${16} /><span>${count(p.done)} de ${count(p.total)} arquivos${p.bytesTotal ? ` · ${bytes(p.bytesDone)} de ${bytes(p.bytesTotal)}` : ''}</span></div>
          <div class="rt-bar"><i style=${`width:${(frac * 100).toFixed(1)}%`}></i></div>
          <span class="sub rt-current" title=${p.current || ''}>${p.current ? `Copiando ${p.current}` : 'Criando as pastas…'}</span>
          <span class="sub">A cópia para o Drive acontece no Google, sem usar a internet deste computador. Pode fechar esta janela: a cópia continua.</span>
        </div>
        ${baixando}`
      footer = html`<${Button} icon="pause" onClick=${parar}>Parar</${Button}>
        <${Button} variant="primary" onClick=${onClose} data-autofocus>Fechar</${Button}>`
    } else {
      const ok = job.status === 'done' && !p.stopped && !p.failed?.length
      const head =
        job.status === 'error'
          ? job.error
          : job.status === 'canceled'
            ? job.error
            : p.stopped
              ? `Parou: ${p.stopped}`
              : `${plural(copiados, 'arquivo copiado', 'arquivos copiados')} para “${job.dest?.name}”.`
      body = html`<${Resumo} p=${job.plano} />
        <div class="rt-done">
          <div class=${cx('rt-summary', ok ? 'is-good' : 'is-stopped')}>
            <span class="rt-summary-icon"><${Icon} name=${ok ? 'circle-check' : 'warning'} size=${20} /></span>
            <div>
              <b>${head}</b>
              ${job.status !== 'done' || p.stopped ? html`<span class="sub">${plural(copiados, 'arquivo já tinha sido copiado', 'arquivos já tinham sido copiados')}.</span>` : null}
              ${job.dest?.path ? html`<span class="sub">Em ${job.dest.path}${job.plano?.pasta ? ` / ${job.plano.nome}` : ''}</span>` : null}
            </div>
          </div>
          <${Falhas} list=${p.failed} />
        </div>
        ${baixando}`
      footer = html`${aberto ? html`<a class="btn btn-secondary" href=${driveFolderUrl(aberto)} target="_blank" rel="noopener"><${Icon} name="external" size=${16} /><span>Abrir no Drive</span></a>` : null}
        <${Button} onClick=${outro}>Copiar outro link</${Button}>
        <${Button} variant="primary" onClick=${onClose} data-autofocus>OK</${Button}>`
    }
  } else {
    body = html`<label class="field">
        <span class="field-label">Link do Drive</span>
        <input
          class="input"
          type="url"
          placeholder="https://drive.google.com/…"
          value=${link}
          spellcheck=${false}
          autocomplete="off"
          data-autofocus
          onInput=${(e) => {
            setLink(e.currentTarget.value)
            setPlano(null)
          }}
          onKeyDown=${(e) => e.key === 'Enter' && (e.preventDefault(), ler())}
        />
        <span class="field-hint">Pasta ou arquivo compartilhado com você, ou liberado para quem tem o link.</span>
      </label>
      ${lendo ? html`<div class="cl-what is-wait" role="status"><${Spinner} size=${16} /><span>Lendo o link…</span></div>` : null}
      ${plano
        ? html`<${Resumo} p=${plano} />
            ${plano.bloqueados
              ? html`<p class="cl-warn"><${Icon} name="warning" size=${16} /> ${plural(plano.bloqueados, 'arquivo tem', 'arquivos têm')} cópia bloqueada pelo dono e ${plano.bloqueados === 1 ? 'vai' : 'vão'} ficar de fora.</p>`
              : null}
            ${plano.atalhos ? html`<p class="sub">${plural(plano.atalhos, 'atalho fica', 'atalhos ficam')} de fora.</p>` : null}`
        : null}
      ${erro ? html`<p class="ref-field-error" role="alert">${erro}</p>` : null}
      <button type="button" class="cl-dest" onClick=${escolher}>
        <${Icon} name="folder" size=${18} />
        <span class="cl-text">
          <span class="field-label">Salvar em</span>
          <b>${dest ? dest.path || dest.name : 'Escolha a pasta no seu Drive'}</b>
        </span>
        <span class="cl-dest-go">${dest ? 'Trocar' : 'Escolher'}</span>
      </button>
      ${plano?.pasta && dest ? html`<span class="sub">Cria a pasta “${plano.nome}” lá dentro, com tudo igual.</span>` : null}
      <label class="check-label cl-also">
        <${Checkbox} checked=${!!localDir} onChange=${(on) => (on ? escolherLocal() : setLocalDir(null))} label="Também baixar para uma mídia física" />
        <span>Também baixar para uma mídia física (HD, SSD, cartão)</span>
      </label>
      ${localDir
        ? html`<button type="button" class="cl-dest" onClick=${escolherLocal}>
            <${Icon} name="download" size=${18} />
            <span class="cl-text">
              <span class="field-label">Baixar em</span>
              <b class="mono-path" title=${localDir}>${localDir}</b>
            </span>
            <span class="cl-dest-go">Trocar</span>
          </button>
          <span class="sub">Quando a cópia terminar, baixa da sua cópia no Drive para essa pasta (o link de outra pessoa o Google costuma entregar bem mais devagar), pela fila de Transferências: retoma se cair e confere cada arquivo no fim${plano?.pasta ? `, dentro de “${plano.nome}”` : ''}.</span>`
        : null}
      <span class="sub">A cópia acontece no Google: os arquivos não passam por este computador. Ocupa espaço no Drive de destino.</span>`
    const pode = plano && dest && plano.arquivos > plano.bloqueados && !(copia?.status === 'running')
    footer = html`<${Button} onClick=${onClose}>Cancelar</${Button}>
      ${plano ? null : html`<${Button} onClick=${() => ler()} disabled=${!link.trim() || lendo}>Ver o que tem</${Button}>`}
      <${Button} variant="primary" icon="copy" loading=${indo} disabled=${!pode} onClick=${copiar}>${dest ? `${localDir ? 'Copiar e baixar' : 'Copiar para'} “${dest.name}”` : 'Copiar'}</${Button}>`
    if (copia?.status === 'running') {
      body = html`${body}<p class="cl-warn"><${Icon} name="warning" size=${16} /> Já tem uma cópia em andamento. Espere terminar para começar outra.</p>`
    }
  }

  return html`<${Modal} size="md" class="dialog cl-dialog" title=${title} icon=${html`<${Icon} name="link" size=${20} />`} onClose=${onClose} footer=${footer}>
    <div class="cl-body">${body}</div>
  </${Modal}>`
}

registerModal('copiar-link', CopyLinkDialog)

/** Abre a janela. `dest`: a pasta aberta na tela Drive (vira o destino), ou null. */
export function openCopyLink({ accountId, dest = null }) {
  return openModal('copiar-link', { accountId, dest })
}

/** A cópia em andamento (ou null), para o botão do topo mostrar "Copiando 12/32". */
export function useCopiaRunning() {
  return useStore((s) => (s.copia?.status === 'running' ? s.copia : null))
}
