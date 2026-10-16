// Tela Referências: coleções de vídeos e fotos de referência guardadas no Drive (SOBEDESCE Referências/<Coleção>/).
// Grade de coleções (capa 2 × 2 com as últimas miniaturas) → dentro da coleção, a grade de referências com a mesma
// prévia da tela Drive (player, Baixar original, Abrir no Drive) e a origem de cada uma (link, autor, legenda).
// Salvar: "Colar link" (o computador baixa na hora) ou o navegador de referências (app de desktop).
import { html, useEffect, useMemo, useRef, useState } from '/vendor/preact-htm.js'
import { useStore } from '../lib/store.js'
import { navigate } from '../lib/router.js'
import { api, attempt } from '../lib/api.js'
import { cx, useDismiss } from '../lib/ui.js'
import { fullDate, plural, relTime, shortPath } from '../lib/format.js'
import { clipTime } from '../lib/media.js'
import { toast } from '../lib/toasts.js'
import { copyText } from '../lib/mobile.js'
import { announceBatch, driveFolderUrl } from '../lib/actions.js'
import { bridge, openExternal, pickFolderPath } from '../lib/desktop.js'
import { openModal, promptDialog, registerModal } from '../lib/modals.js'
import {
  ATIVAS, apagarColecao, cancelarTrabalho, carregarColecoes, colecaoPorId, consultarFila, criarColecao, editarColecao, esquecerItens, faseTexto,
  fracaoGeral, removerTrabalho, tentarItemFila, cancelarItemFila, tentarTrabalho, urlCurta, useColecoes, useItens,
} from '../lib/referencias.js'
import { Icon } from './icons.js'
import { Button, EmptyState, IconButton, Spinner, Switch } from './common.js'
import { Modal } from './modal.js'
import { Thumb } from './drive-thumb.js'
import { DrivePreview } from './drive-preview.js'
import { SalvarReferencia } from './referencias-salvar.js'

const AVISO = 'Salve só para referência dos seus projetos. Respeite os direitos de quem criou.'

// ─────────── janelas ───────────

function SalvarDialog({ url = '', colecaoId = null, onClose }) {
  return html`<${Modal} size="sm" class="ref-dialog" title="Salvar referência" subtitle="O computador baixa o vídeo e guarda na coleção do seu Drive." onClose=${() => onClose(null)}>
    <${SalvarReferencia}
      alvo=${{ tipo: 'video', url }}
      colecaoInicial=${colecaoId}
      editarLink=${true}
      onCancelar=${() => onClose(null)}
      onSalvo=${(t) => {
        toast('info', `Salvando em ${t?.colecao?.nome || 'sua coleção'}…`, { action: t?.colecao ? { label: 'Ver', href: `#/referencias/${encodeURIComponent(t.colecao.id)}` } : null })
        onClose(t)
      }}
    />
  </${Modal}>`
}

function LinkIaDialog({ colecao: inicial, onClose }) {
  const [c, setC] = useState(inicial)
  const [busy, setBusy] = useState(null)
  const mudar = async (link, label) => {
    setBusy(label)
    const res = await attempt(editarColecao(c.id, { link }))
    if (res) setC({ ...c, ...res })
    setBusy(null)
  }
  const trocar = async () => {
    const ok = await openModal('confirm', { title: 'Trocar o link?', message: 'O link atual para de funcionar. Quem tiver ele não vê mais esta coleção.', confirmLabel: 'Trocar link', danger: true })
    if (ok) mudar('trocar', 'trocar')
  }
  const copiar = async () => {
    const ok = await copyText(c.link)
    toast(ok ? 'success' : 'error', ok ? 'Link copiado.' : 'Não consegui copiar o link.')
  }
  return html`<${Modal} size="sm" class="ref-dialog ref-ia" title="Link pra IA" icon=${html`<${Icon} name="sparkle" size=${20} />`} onClose=${() => onClose(c)}>
    <p class="dialog-text">Uma página com a lista dos vídeos, links e legendas, no formato que IAs leem bem. Cole na IA que vai ajudar no roteiro.</p>
    <div class="ref-ia-row">
      <div>
        <b>Link da coleção</b>
        <span class="sub">${c.link ? 'Ligado. Quem tiver o link vê a lista (não os arquivos).' : 'Desligado.'}</span>
      </div>
      <${Switch} checked=${Boolean(c.link)} label="Link pra IA" disabled=${!!busy} onChange=${(on) => mudar(on, on ? 'ligar' : 'desligar')} />
    </div>
    ${c.link
      ? html`<div class="ref-ia-link">
          <input class="input mono" readonly value=${c.link} onFocus=${(e) => e.currentTarget.select()} aria-label="Link pra IA" />
          <${Button} variant="primary" icon="copy" onClick=${copiar}>Copiar</${Button}>
        </div>
        <div class="ref-ia-actions">
          <${Button} size="sm" variant="ghost" icon="refresh" loading=${busy === 'trocar'} onClick=${trocar}>Trocar link</${Button}>
          <${Button} size="sm" variant="ghost" icon="external" onClick=${() => openExternal(c.link)}>Abrir</${Button}>
        </div>`
      : null}
  </${Modal}>`
}

function ApagarDialog({ colecao, onClose }) {
  const [drive, setDrive] = useState(false)
  return html`<${Modal}
    size="sm"
    class="dialog"
    title=${`Apagar “${colecao.nome}”?`}
    icon=${html`<${Icon} name="warning" size=${20} />`}
    onClose=${() => onClose(null)}
    footer=${html`
      <${Button} onClick=${() => onClose(null)}>Voltar</${Button}>
      <${Button} variant="danger" onClick=${() => onClose({ apagarNoDrive: drive })}>Apagar coleção</${Button}>
    `}
  >
    <p class="dialog-text">A coleção sai da sua lista e o link pra IA para de funcionar.</p>
    <label class="ref-check">
      <input type="checkbox" checked=${drive} onChange=${(e) => setDrive(e.currentTarget.checked)} />
      <span>Apagar também a pasta no Drive <span class="sub">(vai para a lixeira do Drive)</span></span>
    </label>
  </${Modal}>`
}

registerModal('ref-salvar', SalvarDialog)
registerModal('ref-link-ia', LinkIaDialog)
registerModal('ref-apagar', ApagarDialog)

export const abrirSalvar = (props = {}) => openModal('ref-salvar', props)

// ─────────── peças ───────────

/** "Abrir navegador" (app de desktop) e o campo "Colar link". */
function Acoes({ colecaoId }) {
  const [url, setUrl] = useState('')
  const abrir = (u = url) => {
    abrirSalvar({ url: u.trim(), colecaoId }).then((t) => t && setUrl(''))
  }
  return html`<div class="ref-actions">
    <form class="ref-paste" onSubmit=${(e) => (e.preventDefault(), abrir())}>
      <${Icon} name="link" size=${15} />
      <input
        type="url"
        inputmode="url"
        placeholder="Colar link de vídeo ou post"
        value=${url}
        onInput=${(e) => setUrl(e.currentTarget.value)}
        onPaste=${(e) => {
          const t = e.clipboardData?.getData('text') || ''
          if (/^\s*https?:\/\//i.test(t)) {
            e.preventDefault()
            setUrl(t.trim())
            abrir(t)
          }
        }}
        aria-label="Colar link de vídeo ou post"
      />
      <button type="submit" class="ref-paste-go" disabled=${!url.trim()}>Salvar</button>
    </form>
    ${bridge?.abrirNavegador ? html`<${Button} variant="primary" icon="globe" onClick=${() => bridge.abrirNavegador()}>Abrir navegador</${Button}>` : null}
  </div>`
}

function Aviso() {
  const visto = useStore((s) => s.settings?.referenciasAvisoVisto)
  if (visto) return null
  const ok = () => attempt(api.patch('/api/settings', { referenciasAvisoVisto: true }))
  return html`<div class="ref-aviso" role="note">
    <${Icon} name="info" size=${17} />
    <p>${AVISO}</p>
    <${Button} size="sm" onClick=${ok}>Entendi</${Button}>
  </div>`
}

/** Linha de um download em andamento (ou que deu erro). */
function TrabalhoLinha({ t, mostrarColecao }) {
  const ativo = ATIVAS.has(t.fase)
  const frac = fracaoGeral(t)
  const titulo = t.nome ? t.nome.replace(/\.[a-z0-9]+$/i, '') : urlCurta(t.url)
  return html`<div class=${cx('ref-job', `is-${t.fase}`)}>
    <span class="ref-job-icon">${ativo ? html`<${Spinner} size=${16} />` : t.fase === 'pronto' ? html`<${Icon} name="circle-check" size=${18} />` : html`<${Icon} name="warning" size=${17} />`}</span>
    <div class="ref-job-main">
      <div class="ref-job-top">
        <span class="ref-plat">${t.plataformaNome || 'Link'}</span>
        <b class="ref-job-title" title=${t.url}>${titulo}</b>
        ${mostrarColecao && t.colecao ? html`<span class="sub ref-job-col">em ${t.colecao.nome}</span>` : null}
      </div>
      <span class="ref-job-status">${faseTexto(t)}</span>
      ${ativo ? html`<span class=${cx('ref-bar', frac == null && 'is-indeterminate')}><i style=${frac != null ? `width:${(frac * 100).toFixed(1)}%` : ''}></i></span>` : null}
    </div>
    <div class="ref-job-actions">
      ${ativo && t.fase !== 'concluindo' ? html`<${IconButton} icon="x" label="Cancelar" onClick=${() => attempt(cancelarTrabalho(t.id))} />` : null}
      ${!ativo && t.fase !== 'pronto' ? html`<${Button} size="sm" icon="retry" onClick=${() => attempt(tentarTrabalho(t.id))}>Tentar de novo</${Button}>` : null}
      ${!ativo ? html`<${IconButton} icon="x" label="Tirar da lista" onClick=${() => attempt(removerTrabalho(t.id))} />` : null}
      ${!ativo && t.fase === 'erro' ? html`<${IconButton} icon="external" label="Abrir o link original" onClick=${() => openExternal(t.url)} />` : null}
    </div>
  </div>`
}

/** Link que veio do celular e ainda está na fila do site (pendente ou com erro). */
function FilaLinha({ i, onMudou }) {
  const erro = i.status === 'erro'
  return html`<div class=${cx('ref-job', erro ? 'is-erro' : 'is-na_fila')}>
    <span class="ref-job-icon">${erro ? html`<${Icon} name="warning" size=${17} />` : html`<${Icon} name="clock" size=${17} />`}</span>
    <div class="ref-job-main">
      <div class="ref-job-top">
        <span class="ref-plat">Do celular</span>
        <b class="ref-job-title" title=${i.url}>${urlCurta(i.url)}</b>
      </div>
      <span class="ref-job-status">${erro ? i.erro || 'Não deu para salvar.' : i.status === 'baixando' ? 'Baixando em outro computador' : 'Na fila: o computador baixa em instantes'}</span>
    </div>
    <div class="ref-job-actions">
      ${erro ? html`<${Button} size="sm" icon="retry" onClick=${async () => (await attempt(tentarItemFila(i.id))) && onMudou?.()}>Tentar de novo</${Button}>` : null}
      <${IconButton} icon="external" label="Abrir o link original" onClick=${() => openExternal(i.url)} />
      ${i.status !== 'baixando' ? html`<${IconButton} icon="x" label="Tirar da fila" onClick=${async () => (await attempt(cancelarItemFila(i.id))) && onMudou?.()} />` : null}
    </div>
  </div>`
}

function Trabalhos({ lista, fila = [], mostrarColecao, onMudou }) {
  if (!lista.length && !fila.length) return null
  return html`<section class="ref-jobs card" aria-label="Salvando agora">
    ${lista.map((t) => html`<${TrabalhoLinha} key=${t.id} t=${t} mostrarColecao=${mostrarColecao} />`)}
    ${fila.map((i) => html`<${FilaLinha} key=${i.id} i=${i} onMudou=${onMudou} />`)}
  </section>`
}

/** Capa 2 × 2 com as últimas miniaturas da coleção. */
function Capa({ colecao, versao }) {
  const { data, loading } = useItens(colecao.id, { versao, capa: true })
  const itens = (data?.itens || []).slice(0, 4)
  return html`<div class=${cx('ref-cover', `n-${itens.length}`)}>
    ${loading && !data
      ? Array.from({ length: 4 }, () => html`<span class="ref-cover-tile sk"></span>`)
      : itens.length
        ? itens.map((it) => html`<span class="ref-cover-tile"><${Thumb} accountId=${data.accountId} item=${it} size=${320} iconSize=${26} /></span>`)
        : html`<span class="ref-cover-empty"><${Icon} name="bookmark" size=${26} /></span>`}
  </div>`
}

function ColecaoCard({ c, versao }) {
  const { data } = useItens(c.id, { versao, capa: true })
  const n = data?.itens?.length
  return html`<a class="ref-col" href=${`#/referencias/${encodeURIComponent(c.id)}`} title=${c.nome}>
    <${Capa} colecao=${c} versao=${versao} />
    <div class="ref-col-meta">
      <b>${c.nome}</b>
      <span class="sub">${n == null ? ' ' : n === 0 ? 'Vazia' : plural(n, 'referência', 'referências')}${c.link ? html` · <span class="ref-col-ia"><${Icon} name="sparkle" size=${12} /> link pra IA</span>` : null}</span>
    </div>
  </a>`
}

function Bloqueio({ motivo, status }) {
  if (motivo === 'plano' || status === 403)
    return html`<${EmptyState}
      art=${html`<${Icon} name="bookmark" size=${40} strokeWidth=${1.2} />`}
      title="Disponível no plano Produtora"
    >Com as Referências você guarda vídeos e fotos que inspiram seus projetos direto em coleções no seu Drive.</${EmptyState}>`
  return html`<${EmptyState}
    art=${html`<${Icon} name="bookmark" size=${40} strokeWidth=${1.2} />`}
    title="Entre na conta SOBEDESCE"
    actions=${html`<${Button} variant="primary" icon="cloud" onClick=${() => navigate('ajustes')}>Entrar na conta</${Button}>`}
  >As coleções de referências ficam no Drive da sua conta SOBEDESCE.</${EmptyState}>`
}

// ─────────── grade de coleções ───────────

function Colecoes({ estado }) {
  const { colecoes, loading, error, status, reload } = useColecoes()
  const novas = async () => {
    const nome = await promptDialog({ title: 'Nova coleção', label: 'Nome', placeholder: 'Ex.: Clipes, Luz natural, Making of', confirmLabel: 'Criar' })
    if (!nome) return
    const c = await attempt(criarColecao({ nome }))
    if (c) navigate(`referencias/${encodeURIComponent(c.id)}`)
  }
  const ativos = (estado.trabalhos || []).filter((t) => ATIVAS.has(t.fase) || t.fase === 'erro')
  if (status === 403) return html`<${Bloqueio} status=${403} />`
  return html`
    <${Trabalhos} lista=${ativos} mostrarColecao=${true} />
    <div class="toolbar ref-toolbar">
      <h2 class="ref-h2">Coleções</h2>
      <div class="toolbar-right">
        <${IconButton} icon="refresh" label="Atualizar" onClick=${() => (esquecerItens(), reload())} class=${loading && colecoes ? 'is-spinning' : ''} />
        <${Button} icon="plus" onClick=${novas}>Nova coleção</${Button}>
      </div>
    </div>
    ${!colecoes && loading
      ? html`<div class="ref-cols">${Array.from({ length: 4 }, () => html`<div class="ref-col"><div class="ref-cover"><span class="ref-cover-tile sk"></span><span class="ref-cover-tile sk"></span><span class="ref-cover-tile sk"></span><span class="ref-cover-tile sk"></span></div><div class="ref-col-meta"><span class="sk sk-line" style="width:60%"></span></div></div>`)}</div>`
      : !colecoes && error
        ? html`<div class="table-msg is-error"><${Icon} name="warning" size=${18} /><span>${error}</span><${Button} size="sm" onClick=${reload}>Tentar de novo</${Button}></div>`
        : !colecoes?.length
          ? html`<${EmptyState}
              compact
              art=${html`<${Icon} name="bookmark" size=${34} strokeWidth=${1.2} />`}
              title="Nenhuma coleção ainda"
              actions=${html`<${Button} variant="primary" icon="plus" onClick=${novas}>Criar a primeira</${Button}>`}
            >Crie uma coleção por projeto ou por ideia: “Clipes”, “Luz natural”, “Campanha verão”.</${EmptyState}>`
          : html`<div class="ref-cols">
              ${colecoes.map((c) => html`<${ColecaoCard} key=${c.id} c=${c} versao=${estado.versoes?.[c.id] || 0} />`)}
              <button type="button" class="ref-col ref-col-new" onClick=${novas}><span class="ref-cover ref-cover-new"><${Icon} name="plus" size=${26} /></span><div class="ref-col-meta"><b>Nova coleção</b><span class="sub">Uma pasta nova no Drive</span></div></button>
            </div>`}
  `
}

// ─────────── dentro da coleção ───────────

function RefCard({ it, accountId, onOpen }) {
  const r = it.referencia || {}
  const dur = it.video?.durationMs ? clipTime(it.video.durationMs / 1000) : ''
  const titulo = r.titulo || it.name.replace(/\.[a-z0-9]+$/i, '')
  return html`<button type="button" class="ref-card" onClick=${onOpen} title=${titulo}>
    <span class="ref-card-thumb">
      <${Thumb} accountId=${accountId} item=${it} size=${640} iconSize=${36} />
      ${r.plataforma ? html`<span class="ref-card-plat">${r.plataforma}</span>` : null}
      ${dur ? html`<span class="gbadge">${dur}</span>` : null}
      <span class="ref-card-play"><${Icon} name=${it.video || /^video\//.test(it.mimeType) ? 'play' : 'eye'} size=${18} /></span>
    </span>
    <span class="ref-card-meta">
      <b>${titulo}</b>
      <span class="sub">${[r.autor, it.createdTime ? relTime(it.createdTime) : null].filter(Boolean).join(' · ')}</span>
    </span>
  </button>`
}

function Origem({ it }) {
  const r = it.referencia || {}
  const [aberta, setAberta] = useState(false)
  if (!r.url && !r.legenda && !r.autor) return null
  const longa = (r.legenda || '').length > 280
  return html`<div class="ref-origem">
    <div class="ref-origem-head">
      ${r.plataforma ? html`<span class="ref-plat">${r.plataforma}</span>` : null}
      ${r.autor ? html`<b>${r.autor}</b>` : null}
    </div>
    ${r.url ? html`<${Button} size="sm" icon="external" onClick=${() => openExternal(r.url)}>Abrir original</${Button}>` : null}
    ${r.nota ? html`<p class="ref-origem-nota"><span class="eyebrow">Nota</span>${r.nota}</p>` : null}
    ${r.legenda
      ? html`<div class=${cx('ref-origem-legenda', longa && !aberta && 'is-clamped')}>
          <span class="eyebrow">Legenda</span>
          <p>${r.legenda}</p>
        </div>
        ${longa ? html`<button type="button" class="link-btn" onClick=${() => setAberta(!aberta)}>${aberta ? 'Mostrar menos' : 'Mostrar tudo'}</button>` : null}`
      : null}
    ${r.salvoEm ? html`<span class="sub ref-origem-quando">Salvo ${fullDate(r.salvoEm)}</span>` : null}
  </div>`
}

function MenuColecao({ c, onClose, onRenomear, onIa, onApagar }) {
  const ref = useRef(null)
  useDismiss(ref, onClose)
  const item = (icon, label, fn, danger) => html`<button type="button" role="menuitem" class=${cx('menu-item', danger && 'is-danger')} onClick=${() => (onClose(), fn())}><${Icon} name=${icon} size=${15} /><span class="menu-item-text">${label}</span></button>`
  return html`<div class="menu ref-menu" role="menu" ref=${ref}>
    ${item('pencil', 'Renomear', onRenomear)}
    ${item('sparkle', 'Link pra IA', onIa)}
    ${c.driveFolderId ? item('external', 'Abrir no Drive', () => openExternal(driveFolderUrl(c.driveFolderId))) : null}
    <div class="menu-sep"></div>
    ${item('trash', 'Apagar coleção', onApagar, true)}
  </div>`
}

function Colecao({ id, estado }) {
  const { colecoes, status } = useColecoes()
  const versao = estado.versoes?.[id] || 0
  const { data, loading, error, reload } = useItens(id, { versao })
  const settings = useStore((s) => s.settings)
  const home = useStore((s) => s.app?.home)
  const [menu, setMenu] = useState(false)
  const [peek, setPeek] = useState(null)
  const [destDir, setDestDir] = useState(null)
  const c = data?.colecao || colecaoPorId(id) || (colecoes ? null : { id, nome: '' })
  const itens = data?.itens || []
  const trabalhos = (estado.trabalhos || []).filter((t) => t.colecao?.id === id && (ATIVAS.has(t.fase) || t.fase === 'erro'))
  const dest = destDir || settings?.downloadDir || ''

  useEffect(() => {
    consultarFila()
  }, [id])

  if (status === 403) return html`<${Bloqueio} status=${403} />`
  if (colecoes && !c && !loading)
    return html`<${EmptyState} title="Esta coleção não existe mais" actions=${html`<${Button} onClick=${() => navigate('referencias')}>Ver coleções</${Button}>`}>Ela pode ter sido apagada em outro aparelho.</${EmptyState}>`

  const renomear = async () => {
    const nome = await promptDialog({ title: 'Renomear coleção', label: 'Nome', initial: c.nome, confirmLabel: 'Renomear' })
    if (nome && nome !== c.nome && (await attempt(editarColecao(c.id, { nome })))) {
      esquecerItens(c.id)
      reload()
    }
  }
  const apagar = async () => {
    const r = await openModal('ref-apagar', { colecao: c })
    if (!r) return
    const ok = await attempt(apagarColecao(c.id, r).then(() => true))
    if (ok) {
      toast('success', `“${c.nome}” apagada.`)
      navigate('referencias')
    }
  }
  const ia = () => openModal('ref-link-ia', { colecao: colecaoPorId(c.id) || c })
  const baixar = async (it) => {
    const res = await attempt(api.post('/api/transfers/download', { accountId: data.accountId, items: [it], destDir: dest }))
    if (res) announceBatch(res, 'na fila')
    return !!res?.count
  }
  const peekIndex = peek ? itens.findIndex((x) => x.id === peek) : -1

  return html`
    <nav class="ref-crumbs" aria-label="Caminho"><a href="#/referencias">Referências</a><${Icon} name="chevron-right" size=${13} /><span>${c?.nome || ''}</span></nav>
    <header class="page-head ref-head">
      <div>
        <h1>${c?.nome || html`<span class="sk sk-line" style="width:240px;height:28px"></span>`}</h1>
        <p class="page-lead">${data ? (itens.length ? plural(itens.length, 'referência', 'referências') : 'Nada salvo aqui ainda') : ' '}${c?.link ? html` · <span class="ref-col-ia"><${Icon} name="sparkle" size=${13} /> link pra IA ligado</span>` : null}</p>
      </div>
      <div class="page-head-actions">
        <${Acoes} colecaoId=${id} />
        <div class="ref-more">
          <${IconButton} icon="more" label="Mais opções" onClick=${() => setMenu(!menu)} class=${menu ? 'is-on' : ''} />
          ${menu && c ? html`<${MenuColecao} c=${c} onClose=${() => setMenu(false)} onRenomear=${renomear} onIa=${ia} onApagar=${apagar} />` : null}
        </div>
      </div>
    </header>
    <${Trabalhos} lista=${trabalhos} fila=${data?.pendentes || []} onMudou=${reload} />
    ${!data && loading
      ? html`<div class="ref-grid">${Array.from({ length: 8 }, () => html`<div class="ref-card"><span class="ref-card-thumb sk"></span><span class="ref-card-meta"><span class="sk sk-line" style="width:70%"></span></span></div>`)}</div>`
      : !data && error
        ? html`<div class="table-msg is-error"><${Icon} name="warning" size=${18} /><span>${error}</span><${Button} size="sm" onClick=${reload}>Tentar de novo</${Button}></div>`
        : !itens.length
          ? html`<${EmptyState}
              compact
              art=${html`<${Icon} name="film" size=${34} strokeWidth=${1.2} />`}
              title="Nada salvo aqui ainda"
            >Cole o link de um vídeo ou post${bridge?.abrirNavegador ? ', ou abra o navegador e use “Salvar referência”' : ''}. Do celular, use Compartilhar → SOBEDESCE.</${EmptyState}>`
          : html`<div class="ref-grid">${itens.map((it) => html`<${RefCard} key=${it.id} it=${it} accountId=${data.accountId} onOpen=${() => setPeek(it.id)} />`)}</div>`}
    ${peekIndex >= 0
      ? html`<${DrivePreview}
          accountId=${data.accountId}
          items=${itens}
          index=${peekIndex}
          onIndex=${(i) => setPeek(itens[i].id)}
          onClose=${() => setPeek(null)}
          onDownload=${baixar}
          dest=${dest}
          destLabel=${shortPath(dest, home)}
          onChangeDest=${async () => {
            const p = await pickFolderPath({ title: 'Onde salvar os downloads?', defaultPath: dest })
            if (p) setDestDir(p)
          }}
          extra=${(it) => html`<${Origem} it=${it} />`}
        />`
      : null}
  `
}

// ─────────── tela ───────────

export function ReferenciasScreen({ route }) {
  const ref = useStore((s) => s.referencias)
  const id = route.parts[1] || null

  useEffect(() => {
    if (ref?.ativo) carregarColecoes()
  }, [ref?.ativo])

  // Voltar para a janela: olha a fila do celular agora (além do relógio de 60 s do motor).
  useEffect(() => {
    const onFocus = () => document.visibilityState === 'visible' && ref?.ativo && consultarFila()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [ref?.ativo])

  return html`<div class="page page-ref">
    ${!id
      ? html`<header class="page-head">
          <div>
            <h1>Referências</h1>
            <p class="page-lead">Vídeos e fotos que inspiram seus projetos, guardados em coleções no seu Drive.</p>
          </div>
          ${ref?.ativo ? html`<div class="page-head-actions"><${Acoes} /></div>` : null}
        </header>`
      : null}
    ${!ref ? html`<div class="table-msg"><${Spinner} size=${16} /></div>` : !ref.ativo ? html`<${Bloqueio} motivo=${ref.motivo} />` : html`<${Aviso} />${id ? html`<${Colecao} key=${id} id=${id} estado=${ref} />` : html`<${Colecoes} estado=${ref} />`}`}
  </div>`
}

