// "Copiar de um link": cola o link do Drive de alguém, vê o que tem, escolhe a pasta no seu Drive e copia.
// O trabalho fica em lib/copiar.js (estado `copia`): a folha pode fechar e reabrir no meio sem perder nada.
import { html, useEffect, useState } from '../vendor/preact-htm.js'
import { closeSheet, folderTrail, getState, openSheet, toast, useApp } from '../lib/state.js'
import { folderLink } from '../lib/drive.js'
import { inspect, parseDriveLink, resetCopy, runCopy, setCopyDest, stopCopy } from '../lib/copiar.js'
import { bytes, count, plural } from '../lib/format.js'
import { Icon } from './icons.js'
import { Button, SheetHead } from './ui.js'

/** Abre o seletor de pastas e volta para esta folha com a pasta escolhida. */
function pickDest() {
  openSheet('folders', {
    verb: 'Copiar para',
    onChoose: (f) => {
      setCopyDest(f)
      openSheet('copiar')
    },
    onCancel: () => openSheet('copiar'),
  })
}

function DestRow({ dest, disabled }) {
  return html`<button type="button" class="cdest" onClick=${pickDest} disabled=${disabled} aria-label=${dest ? `Salvar em ${folderTrail(dest)}. Trocar pasta` : 'Escolher onde salvar'}>
    <${Icon} name="folder" />
    <span class="cdest-text">
      <small>Salvar em</small>
      <b>${dest ? folderTrail(dest) : 'Escolha a pasta no seu Drive'}</b>
    </span>
    <span class="cdest-go">${dest ? 'Trocar' : 'Escolher'}</span>
  </button>`
}

function Summary({ plan }) {
  const n = plan.files.length
  const parts = [plural(n, 'arquivo', 'arquivos')]
  if (plan.folders.length) parts.push(plural(plan.folders.length, 'subpasta', 'subpastas'))
  if (plan.bytes) parts.push(bytes(plan.bytes, { precise: true }))
  return html`<div class="ccard">
    <span class="ccard-icon"><${Icon} name=${plan.root.folder ? 'folder' : 'doc'} size=${26} /></span>
    <span class="ccard-text">
      <b>${plan.root.name}</b>
      <small>${parts.join(' · ')}${plan.owner ? ` · de ${plan.owner}` : ''}</small>
    </span>
  </div>`
}

function Failed({ list }) {
  if (!list?.length) return null
  return html`<details class="cfail">
    <summary>${plural(list.length, 'arquivo não copiado', 'arquivos não copiados')}</summary>
    <ul>
      ${list.slice(0, 200).map((f) => html`<li><b>${f.name}</b><small>${f.why}</small></li>`)}
    </ul>
  </details>`
}

export function CopySheet({ texto = '' }) {
  const copia = useApp((s) => s.copia)
  const quota = useApp((s) => s.quota)
  const [url, setUrl] = useState(() => texto || copia?.link || '')
  const canPaste = typeof navigator.clipboard?.readText === 'function'
  const st = copia?.status || 'vazio'
  const busy = st === 'lendo' || st === 'copiando'

  // Chegou com um link (compartilhado do app do Drive, por exemplo): já lê.
  useEffect(() => {
    if (texto && parseDriveLink(texto) && st !== 'copiando') inspect(texto)
  }, [])

  const read = (text = url) => {
    if (!parseDriveLink(text)) return toast('Cole um link do Google Drive (pasta ou arquivo).')
    inspect(text)
  }
  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText()
      const ref = parseDriveLink(t)
      if (!ref) return toast('Não achei um link do Drive na área de transferência.')
      setUrl(ref.url)
      read(ref.url)
    } catch {
      toast('Toque e segure no campo para colar.')
    }
  }

  const plan = copia?.plan
  const dest = copia?.dest || null
  const free = quota?.limit ? Number(quota.limit) - Number(quota.usage || 0) : null
  const tooBig = plan && free != null && !dest?.driveId && plan.bytes > free

  const head = html`<${SheetHead}
    title="Copiar de um link"
    left=${st === 'copiando'
      ? html`<button type="button" class="link-btn" onClick=${closeSheet}>Fechar</button>`
      : html`<button type="button" class="link-btn" onClick=${() => (st === 'feito' || st === 'parado' ? resetCopy() : null, closeSheet())}>${st === 'feito' ? 'OK' : 'Cancelar'}</button>`}
  />`

  if (st === 'copiando' || st === 'feito' || st === 'parado') {
    const frac = copia.total ? copia.done / copia.total : 0
    // `failed` já começa com os bloqueados pelo dono, que não entram em done/total.
    const copied = copia.done - Math.max(0, (copia.failed?.length || 0) - (plan?.blocked || 0))
    const opened = copia.newFolder || dest?.id
    return html`${head}
      <div class="sheet-body sheet-scroll rsheet">
        <${Summary} plan=${plan} />
        <div class="cprog" role="progressbar" aria-label="Cópia" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(frac * 100)}>
          <div class="cprog-fill" style=${`width:${(frac * 100).toFixed(1)}%`}></div>
        </div>
        <p class="cnums">
          <b>${count(copia.done)} de ${count(copia.total)}</b> arquivos${copia.bytesTotal ? html` · ${bytes(copia.bytesDone || 0)} de ${bytes(copia.bytesTotal)}` : null}
        </p>
        ${st === 'copiando'
          ? html`<p class="cnow">${copia.current ? html`Copiando <b>${copia.current}</b>` : 'Criando as pastas…'}</p>
              <p class="group-foot">A cópia acontece no Google, sem usar a sua internet. Deixe o app aberto até terminar: se ele sair da tela, a cópia pausa.</p>
              <${Button} variant="secondary" class="btn-block" onClick=${stopCopy}>Parar</${Button}>`
          : html`<p class=${st === 'feito' && !copia.stopped ? 'cdone' : 'cwarn'} role="status">
                ${copia.stopped
                  ? html`<${Icon} name="warning" size=${17} /> Parou: ${copia.stopped}`
                  : st === 'parado'
                    ? html`<${Icon} name="warning" size=${17} /> Você parou a cópia. O que já foi copiado ficou no seu Drive.`
                    : html`<${Icon} name="check" size=${17} /> ${plural(copied, 'arquivo copiado', 'arquivos copiados')} para “${dest?.name}”.`}
              </p>
              ${opened ? html`<a class="btn btn-secondary btn-block" href=${folderLink(opened)} target="_blank" rel="noopener">Abrir no Drive</a>` : null}
              <${Button} variant="primary" class="btn-block" onClick=${resetCopy}>Copiar outro link</${Button}>`}
        <${Failed} list=${copia.failed} />
      </div>`
  }

  return html`${head}
    <div class="sheet-body sheet-scroll rsheet">
      <label class="rfield">
        <span class="rfield-label">Link do Drive</span>
        <span class="rurl">
          <input
            class="input"
            type="url"
            inputmode="url"
            placeholder="https://drive.google.com/…"
            value=${url}
            autocomplete="off"
            autocapitalize="off"
            spellcheck=${false}
            onInput=${(e) => setUrl(e.currentTarget.value)}
            onKeyDown=${(e) => e.key === 'Enter' && read()}
            aria-label="Link do Drive"
          />
          ${canPaste ? html`<${Button} size="sm" variant="secondary" icon="clipboard" class="rurl-paste" onClick=${paste}>Colar</${Button}>` : null}
        </span>
        <span class="field-help">Pasta ou arquivo compartilhado com você, ou liberado para quem tem o link.</span>
      </label>
      ${st === 'vazio' || st === 'erro'
        ? html`${st === 'erro' ? html`<p class="form-error" role="alert"><${Icon} name="warning" size=${16} /> <span>${copia.error}</span></p>` : null}
            <${Button} variant="secondary" class="btn-block" disabled=${!url.trim()} onClick=${() => read()}>Ver o que tem</${Button}>`
        : null}
      ${st === 'lendo'
        ? html`<div class="ccard is-wait" role="status"><span class="spinner"></span><span>Lendo o link…${copia.found ? ` ${plural(copia.found, 'arquivo', 'arquivos')}` : ''}</span></div>`
        : null}
      ${st === 'pronto'
        ? html`<${Summary} plan=${plan} />
            ${plan.blocked
              ? html`<p class="cwarn"><${Icon} name="warning" size=${16} /> ${plural(plan.blocked, 'arquivo tem', 'arquivos têm')} cópia bloqueada pelo dono e ${plan.blocked === 1 ? 'vai' : 'vão'} ficar de fora.</p>`
              : null}
            ${plan.skipped.length ? html`<p class="field-help">${plural(plan.skipped.length, 'atalho fica', 'atalhos ficam')} de fora.</p>` : null}
            ${tooBig ? html`<p class="cwarn"><${Icon} name="warning" size=${16} /> Seu Drive tem ${bytes(free)} livres: não cabe tudo.</p>` : null}`
        : null}
      <${DestRow} dest=${dest} disabled=${busy} />
      ${st === 'pronto'
        ? html`${plan.root.folder ? html`<p class="field-help cdest-help">Cria a pasta “${plan.root.name}” lá dentro, com tudo igual.</p>` : null}
            <${Button} variant="up" size="lg" class="btn-block" disabled=${!dest || plan.files.length === plan.blocked} onClick=${runCopy}>
              ${dest ? `Copiar para “${dest.name}”` : 'Escolha onde salvar'}
            </${Button}>`
        : null}
      <p class="group-foot">A cópia acontece no Google: os arquivos não passam pelo celular. Ocupa espaço no Drive de destino.</p>
    </div>`
}
CopySheet.label = 'Copiar de um link'
CopySheet.tall = true

/** Botão da aba Drive. Durante a cópia mostra o andamento e reabre a folha. */
export function CopyButton({ dest, source }) {
  const copia = useApp((s) => s.copia)
  const running = copia?.status === 'copiando'
  const open = () => {
    if (running) return openSheet('copiar')
    // Numa pasta em "Comigo": é ela que vai ser copiada. No seu Drive: a pasta aberta é o destino.
    if (source) {
      resetCopy()
      return openSheet('copiar', { texto: folderLink(source.id) })
    }
    if (dest && !getState().copia?.plan) setCopyDest(dest)
    openSheet('copiar')
  }
  return html`<button type="button" class=${running ? 'dchip ccopying' : 'icon-btn'} onClick=${open} aria-label=${running ? `Copiando ${copia.done} de ${copia.total}. Ver` : source ? `Copiar ${source.name} para o seu Drive` : 'Copiar de um link do Drive'}>
    <${Icon} name="link" size=${20} />${running ? html`<span>${copia.done}/${copia.total}</span>` : null}
  </button>`
}
