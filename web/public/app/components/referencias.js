// Aba Referências (docs/REFERENCIAS.md §7): coleções como os "Salvos" do Instagram (capa 2×2 com as últimas
// miniaturas), a grade de cada coleção com a prévia de sempre e, no topo, os links esperando o computador baixar.
// "Salvar link" guarda o endereço na fila do site; o app do computador baixa e sobe para a pasta da coleção.
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.js'
import * as refs from '../lib/referencias.js'
import { closeSheet, getState, openSheet, setState, toast, useApp } from '../lib/state.js'
import { kindOf } from '../lib/browse.js'
import { duration, plural } from '../lib/format.js'
import { isIOS } from '../lib/platform.js'
import { BotaoGrande, Item, Passo, Rotulo, Stats, Vazio } from './kit.js'
import { Icon } from './icons.js'
import { Button, SheetHead, copyText, cx } from './ui.js'
import { KindGlyph, Thumb } from './thumb.js'
import { Preview } from './preview.js'
import { switchDrive } from './account.js'

const POLL_MS = 15_000

const colecaoById = (id) => (getState().refs.colecoes || []).find((c) => c.id === id) || null
const openOf = (fila, id) => (fila || []).filter((i) => i.colecao?.id === id)
const isOtherDrive = (c, drive) => Boolean(drive && c.contaGoogleId !== drive.id)
const driveEmail = (id) => (getState().drives || []).find((d) => d.id === id)?.email || 'outro Drive'

/** Arquivos da coleção (cache do lib), relidos quando a pasta muda. */
function useFiles(c, { enabled = true } = {}) {
  const [st, setSt] = useState(() => ({ list: c ? refs.cachedFiles(c.id) : null, error: null }))
  const [tick, setTick] = useState(0)
  useEffect(() => refs.onFiles((id) => id === c?.id && setTick((n) => n + 1)), [c?.id])
  useEffect(() => {
    if (!c || !enabled) return
    let alive = true
    refs.listFiles(c).then(
      (list) => alive && setSt({ list, error: null }),
      (err) => alive && setSt((s) => ({ list: s.list, error: err })),
    )
    return () => (alive = false)
  }, [c?.id, c?.driveFolderId, enabled, tick])
  return { ...st, reload: () => c && refs.listFiles(c, { force: true }).then((list) => setSt({ list, error: null }), (error) => setSt((s) => ({ ...s, error }))) }
}

/** Atualiza coleções e fila ao abrir a aba e, com links esperando, a cada 15 s (tela visível). */
function usePolling(active) {
  const busy = useApp((s) => (s.refs.fila || []).some((i) => i.status !== 'erro'))
  useEffect(() => {
    if (!active) return
    refs.loadRefs()
    const onVis = () => document.visibilityState === 'visible' && refs.loadRefs()
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [active])
  useEffect(() => {
    if (!active || !busy) return
    const t = setInterval(() => document.visibilityState === 'visible' && refs.loadRefs(), POLL_MS)
    return () => clearInterval(t)
  }, [active, busy])
}

// ───── tela inicial: coleções ─────

function Cover({ c, other }) {
  const { list } = useFiles(c, { enabled: !other })
  const four = (list || []).slice(0, 4)
  return html`<span class="rcover" aria-hidden="true">
    ${other || (list && !list.length)
      ? html`<span class="rcover-other"><${Icon} name=${other ? 'drive' : 'bookmark'} size=${26} strokeWidth=${1.5} /></span>`
      : [0, 1, 2, 3].map((i) => {
          const f = four[i]
          return html`<span key=${i} class=${cx('rcover-cell', !f && 'is-empty')}>${f ? html`<${Thumb} file=${f} px=${96} kind=${kindOf(f)} small />` : null}</span>`
        })}
  </span>`
}

function CollectionCard({ c, drive, onOpen }) {
  const other = isOtherDrive(c, drive)
  const { list } = useFiles(c, { enabled: !other })
  const n = list ? list.length : null
  const meta = other
    ? `Em ${driveEmail(c.contaGoogleId)}`
    : [n == null ? '' : plural(n, 'item', 'itens'), c.naFila ? `${c.naFila} na fila` : ''].filter(Boolean).join(' · ') || ' '
  return html`<li>
    <button type="button" class="rcard" onClick=${() => onOpen(c)} aria-label=${`${c.nome}, ${meta}`}>
      <${Cover} c=${c} other=${other} />
      <span class="rcard-name">${c.nome}${c.link ? html` <${Icon} name="sparkle" size=${13} class="rcard-ai" title="Link pra IA ligado" />` : null}</span>
      <span class=${cx('rcard-meta', c.naFila && 'has-queue')}>${meta}</span>
    </button>
  </li>`
}

function FirstUse() {
  const [seen, setSeen] = useState(refs.noticeSeen())
  if (seen) return null
  return html`<div class="notice notice-soft rnotice" role="note">
    <${Icon} name="info" size=${20} />
    <div>
      <b>Salve só para referência dos seus projetos.</b>
      <p>Respeite os direitos de quem criou.</p>
      <${Button} size="sm" variant="secondary" onClick=${() => (refs.markNoticeSeen(), setSeen(true))}>Entendi</${Button}>
    </div>
  </div>`
}

function SaveButton({ colecaoId, small }) {
  if (!small)
    return html`<div class="rsave-k k-entra" style="--i:1"><${BotaoGrande} icone="link" onClick=${() => openSheet('refSave', colecaoId ? { colecaoId } : {})} dica="Instagram, YouTube, TikTok. O computador baixa e guarda no seu Drive.">Salvar link</${BotaoGrande}></div>`
  return html`<button type="button" class=${cx('rsave', small && 'is-small')} onClick=${() => openSheet('refSave', colecaoId ? { colecaoId } : {})}>
    <span class="rsave-icon" aria-hidden="true"><${Icon} name="link" size=${small ? 19 : 23} strokeWidth=${1.9} /></span>
    <span class="rsave-text">
      <b>${small ? 'Salvar link aqui' : 'Salvar link'}</b>
      ${small ? null : html`<span>Instagram, YouTube, TikTok… O computador baixa.</span>`}
    </span>
    ${small ? null : html`<${Icon} name="plus" size=${20} strokeWidth=${2} class="rsave-plus" />`}
  </button>`
}

function Waiting({ fila }) {
  const waiting = (fila || []).filter((i) => i.status !== 'erro').length
  const failed = (fila || []).filter((i) => i.status === 'erro').length
  if (!waiting && !failed) return null
  return html`<div role="status"><${Item}
    icone=${waiting ? 'clock' : 'warning'}
    tom=${waiting ? 'warn' : 'erro'}
    titulo=${waiting ? `${plural(waiting, 'link esperando', 'links esperando')} o computador` : `${plural(failed, 'link não baixou', 'links não baixaram')}`}
    sub=${waiting ? 'Com o SOBEDESCE aberto no computador, eles baixam sozinhos.' : 'Abra a coleção para tentar de novo.'}
  /></div>`
}

// ───── procurar referência no app de cada rede (o "Abrir navegador" do computador, no celular) ─────
//
// O app do celular não consegue mostrar o Instagram por dentro (os sites bloqueiam). Então os botões abrem o app (ou o
// site) da rede; ao voltar para cá, aparece "Voltou do Instagram?" e um toque cola o link copiado na folha Salvar link.
const SOURCES = [
  { id: 'instagram', label: 'Instagram', href: 'https://www.instagram.com/' },
  { id: 'tiktok', label: 'TikTok', href: 'https://www.tiktok.com/' },
  { id: 'youtube', label: 'YouTube', href: 'https://www.youtube.com/' },
]
const AWAY_KEY = 'sobedesce.refs.fora' // sessionStorage: { label, em }
const AWAY_MS = 30 * 60_000
const away = {
  get() {
    try {
      const a = JSON.parse(sessionStorage.getItem(AWAY_KEY) || 'null')
      return a && Date.now() - a.em < AWAY_MS ? a : null
    } catch {
      return null
    }
  },
  set(v) {
    try {
      if (v) sessionStorage.setItem(AWAY_KEY, JSON.stringify(v))
      else sessionStorage.removeItem(AWAY_KEY)
    } catch {}
  },
}

/** De onde o usuário voltou (abriu uma rede pelos botões e a tela voltou a aparecer). */
function useBackFrom() {
  const [from, setFrom] = useState(null)
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return
      const a = away.get()
      if (a && Date.now() - a.em > 1500) setFrom(a.label)
    }
    check()
    document.addEventListener('visibilitychange', check)
    return () => document.removeEventListener('visibilitychange', check)
  }, [])
  const dismiss = () => {
    away.set(null)
    setFrom(null)
  }
  return { from, dismiss }
}

function BackFrom({ from, dismiss }) {
  if (!from) return null
  const pasteSave = async () => {
    dismiss()
    let texto = ''
    try {
      texto = (await navigator.clipboard?.readText?.()) || ''
    } catch {}
    openSheet('refSave', refs.findUrl(texto) ? { texto } : {})
  }
  return html`<div class="rback" role="status">
    <span class="rtip-icon" aria-hidden="true"><${Icon} name="clipboard" size=${20} /></span>
    <span class="rtip-text"><b>Voltou do ${from}?</b><span>Copiou o link do post? Cole e escolha a coleção.</span></span>
    <${Button} size="sm" variant="primary" onClick=${pasteSave}>Colar</${Button}>
    <button type="button" class="icon-btn rback-x" onClick=${dismiss} aria-label="Fechar"><${Icon} name="x" size=${18} /></button>
  </div>`
}

function Sources() {
  return html`<${Passo} icone="search" cor="up" titulo="Procurar referência" frase="Copie o link do post e volte para cá: um toque cola e salva." i=${3}>
    <div class="k-pilulas rsrc-row">
      ${SOURCES.map(
        (s) => html`<a
          key=${s.id}
          class="k-pilula rsrc-btn"
          href=${s.href}
          target="_blank"
          rel="noopener noreferrer"
          onClick=${() => away.set({ label: s.label, em: Date.now() })}
        >
          <span>${s.label}</span><${Icon} name="external" size=${13} strokeWidth=${2} />
        </a>`,
      )}
    </div>
  </${Passo}>`
}

// O atalho do iPhone já em uso? (null = ainda não sei). Só a chave gerada não basta: o atalho pode nunca ter sido
// montado no app Atalhos. Fica no topo até salvar o primeiro link; depois vai para o pé da página.
let atalhoAtivo = null
const ATALHO_EVT = 'sd-atalho'
function useAtalhoAtivo() {
  const [on, setOn] = useState(atalhoAtivo)
  useEffect(() => {
    if (!isIOS) return
    const upd = () => setOn(atalhoAtivo)
    window.addEventListener(ATALHO_EVT, upd)
    if (atalhoAtivo == null)
      refs.atalho.status().then(
        (r) => {
          atalhoAtivo = Boolean(r?.ativo && r?.ultimoUsoEm)
          upd()
        },
        () => {},
      )
    return () => window.removeEventListener(ATALHO_EVT, upd)
  }, [])
  return on
}
const setAtalhoAtivo = (v) => {
  atalhoAtivo = v
  window.dispatchEvent(new Event(ATALHO_EVT))
}

function ShortcutCard() {
  if (isIOS) {
    return html`<button type="button" class="rtip" onClick=${() => openSheet('refAtalho')}>
      <span class="rtip-icon" aria-hidden="true"><${Icon} name="share" size=${20} /></span>
      <span class="rtip-text"><b>Salvar direto do Instagram (iPhone)</b><span>Um atalho na Folha de Compartilhamento manda o link para cá.</span></span>
      <${Icon} name="chevron-right" size=${16} strokeWidth=${2} class="rtip-chev" />
    </button>`
  }
  return html`<p class="rtip is-static">
    <span class="rtip-icon" aria-hidden="true"><${Icon} name="share" size=${20} /></span>
    <span class="rtip-text"><b>Salvar direto do app</b><span>Com o SOBEDESCE instalado, toque em Compartilhar no Instagram ou no YouTube e escolha SOBEDESCE.</span></span>
  </p>`
}

/** Atalho no topo enquanto não está em uso (iPhone) e sempre no topo nos outros aparelhos; em uso, vai para o pé. */
function ShortcutSlot({ at }) {
  const on = useAtalhoAtivo()
  const top = !isIOS || on !== true
  return (at === 'top') === top ? html`<${ShortcutCard} />` : null
}

function Home({ onOpen }) {
  const { st, drive } = useApp((s) => ({ st: s.refs, drive: s.drive }))
  const list = st.colecoes || []
  const back = useBackFrom()
  const fila = st.fila || []
  const naFila = fila.filter((i) => i.status !== 'erro').length
  return html`<div class="screen refs-screen">
    <header class="k-cabeca k-entra rtop-k" style="--i:0">
      <div class="k-cabeca-txt">
        <h1>Referências</h1>
        <p>Vídeos que inspiram, salvos no seu Drive.</p>
      </div>
      <div class="k-cabeca-acoes">
        <button type="button" class="icon-btn" onClick=${() => openSheet('refName')} aria-label="Nova coleção">
          <${Icon} name="plus" size=${22} strokeWidth=${2} />
        </button>
      </div>
    </header>
    <main class="refs-body" aria-busy=${st.status === 'loading' ? 'true' : 'false'}>
      <${FirstUse} />
      <${BackFrom} ...${back} />
      <${SaveButton} />
      ${st.status === 'ready' && list.length
        ? html`<div class="k-entra" style="--i:2"><${Stats}
            itens=${[
              { icone: 'bookmark', valor: list.length, rotulo: list.length === 1 ? 'coleção' : 'coleções', tom: 'warn' },
              { icone: 'clock', valor: naFila, rotulo: 'na fila', tom: naFila ? 'up' : 'neutro' },
              { icone: 'laptop', valor: fila.length - naFila, rotulo: 'não baixaram', tom: fila.length - naFila ? 'erro' : 'neutro' },
            ]}
          /></div>`
        : null}
      <${Sources} />
      <${ShortcutSlot} at="top" />
      <${Waiting} fila=${st.fila} />
      ${st.status === 'error'
        ? html`<div class="drive-msg" role="alert">
            <${Icon} name="warning" size=${26} />
            <b>Não consegui abrir as Referências</b>
            <p>${st.error || 'Confira a internet e tente de novo.'}</p>
            <${Button} size="sm" variant="secondary" icon="refresh" onClick=${() => refs.loadRefs()}>Tentar de novo</${Button}>
          </div>`
        : null}
      ${st.status === 'loading' || st.status === 'idle'
        ? html`<ul class="rgrid is-skeleton" aria-hidden="true">
            ${[0, 1, 2, 3].map((i) => html`<li key=${i}><span class="rcard"><span class="rcover skeleton"></span><span class="skeleton skeleton-line" style="width:60%"></span></span></li>`)}
          </ul>`
        : null}
      ${st.status === 'ready' && list.length
        ? html`<${Rotulo}>Coleções · ${list.length}</${Rotulo}>
            <ul class="rgrid">
              ${list.map((c) => html`<${CollectionCard} key=${c.id} c=${c} drive=${drive} onOpen=${onOpen} />`)}
              <li>
                <button type="button" class="rcard rcard-new" onClick=${() => openSheet('refName')}>
                  <span class="rcover is-new" aria-hidden="true"><${Icon} name="plus" size=${28} strokeWidth=${1.6} /></span>
                  <span class="rcard-name">Nova coleção</span>
                  <span class="rcard-meta"> </span>
                </button>
              </li>
            </ul>`
        : null}
      ${st.status === 'ready' && !list.length
        ? html`<${Vazio} icone="bookmark" titulo="Suas referências, num lugar só" acoes=${html`<${Button} variant="primary" icon="plus" onClick=${() => openSheet('refName')}>Criar a primeira coleção</${Button}>`}>
            Crie coleções como “Planos-sequência” ou “Luz de janela” e salve os vídeos que inspiram. Tudo fica no seu Drive.
          </${Vazio}>`
        : null}
      <${ShortcutSlot} at="bottom" />
      <p class="foot">Tudo fica no seu Drive, na pasta SOBEDESCE Referências.</p>
    </main>
  </div>`
}

// ───── dentro de uma coleção ─────

function PendingTile({ it }) {
  const err = it.status === 'erro'
  const label = err ? 'Não baixou' : it.status === 'baixando' ? 'Baixando no computador…' : 'Aguardando o computador baixar…'
  const motivo = err ? refs.motivoCurto(it.erro) : null
  return html`<li>
    <button type="button" class=${cx('rtile', 'is-pending', err && 'is-error')} onClick=${() => openSheet('refItem', { id: it.id })} aria-label=${`${it.plataforma || 'Link'}: ${label}${motivo ? `. ${motivo}` : ''}. Ver detalhes`}>
      <span class="rtile-media">
        <span class="rpend">
          ${err
            ? html`<${Icon} name="warning" size=${22} />`
            : it.status === 'baixando'
              ? html`<span class="spinner" aria-hidden="true"></span>`
              : html`<${Icon} name="clock" size=${22} strokeWidth=${1.6} />`}
          <span class="rpend-plat">${it.plataforma || 'Link'}</span>
          <span class="rpend-text">${label}</span>
          ${motivo ? html`<span class="rpend-why">${motivo}</span>` : null}
        </span>
      </span>
    </button>
  </li>`
}

function ItemTile({ f, onOpen }) {
  const kind = kindOf(f)
  const dur = f.videoMediaMetadata?.durationMillis
  const meta = refs.refMeta(f)
  return html`<li>
    <button type="button" class="rtile" onClick=${() => onOpen(f)} aria-label=${meta.titulo || f.name}>
      <span class="rtile-media">
        <${Thumb} file=${f} px=${130} kind=${kind} />
        ${dur ? html`<span class="tile-badge">${duration(dur)}</span>` : null}
        ${meta.plataforma ? html`<span class="rtile-plat">${meta.plataforma}</span>` : null}
      </span>
    </button>
  </li>`
}

/** Bloco da prévia: de onde veio, quem fez e a legenda. */
function RefInfo({ file }) {
  const m = refs.refMeta(file)
  if (!m.url && !m.autor && !m.legenda) return null
  return html`<div class="rinfo">
    ${m.titulo ? html`<p class="rinfo-title">${m.titulo}</p>` : null}
    ${m.plataforma || m.autor ? html`<p class="rinfo-meta">${[m.plataforma, m.autor].filter(Boolean).join(' · ')}</p>` : null}
    ${m.legenda ? html`<p class="rinfo-caption">${m.legenda}</p>` : null}
    ${m.url
      ? html`<a class="btn btn-secondary rinfo-open" href=${m.url} target="_blank" rel="noopener noreferrer">
          <${Icon} name="external" size=${17} /><span>Abrir ${m.plataforma && m.plataforma.includes('.') ? 'o original' : `no ${m.plataforma || 'site'}`}</span>
        </a>`
      : null}
  </div>`
}

function OtherDrive({ c }) {
  return html`<div class="drive-msg">
    <${Icon} name="drive" size=${26} />
    <b>Esta coleção está em outro Drive</b>
    <p>Ela fica em ${driveEmail(c.contaGoogleId)}. Para ver os vídeos aqui, use esse Drive no celular.</p>
    <${Button} size="sm" variant="secondary" onClick=${() => switchDrive(c.contaGoogleId)}>Usar ${driveEmail(c.contaGoogleId)}</${Button}>
  </div>`
}

function Collection({ c, onBack }) {
  const { fila, drive } = useApp((s) => ({ fila: s.refs.fila, drive: s.drive }))
  const other = isOtherDrive(c, drive)
  const { list, error, reload } = useFiles(c, { enabled: !other })
  const [preview, setPreview] = useState(null)
  const pending = openOf(fila, c.id)
  const items = list || []
  const waiting = pending.filter((i) => i.status !== 'erro').length
  const sub = [list ? plural(items.length, 'item', 'itens') : '', waiting ? `${waiting} na fila do computador` : ''].filter(Boolean).join(' · ')

  return html`<div class="screen refs-screen">
    <header class="topbar dtop rtop">
      <div class="dtop-row">
        <button type="button" class="icon-btn dtop-back" onClick=${onBack} aria-label="Voltar para as coleções">
          <${Icon} name="chevron-left" size=${22} strokeWidth=${2} />
        </button>
        <h1 class="dtop-title">${c.nome}</h1>
        <div class="dtop-actions">
          <button type="button" class="icon-btn" onClick=${() => openSheet('refMenu', { id: c.id })} aria-label="Opções da coleção">
            <${Icon} name="more" size=${24} strokeWidth=${2.6} />
          </button>
        </div>
      </div>
      ${sub ? html`<p class="rsub">${sub}${c.link ? html` · <span class="rsub-ai"><${Icon} name="sparkle" size=${12} /> link pra IA</span>` : null}</p>` : null}
    </header>
    <main class="refs-body">
      <${SaveButton} colecaoId=${c.id} small />
      ${other ? html`<${OtherDrive} c=${c} />` : null}
      ${!other && error && !list
        ? html`<div class="drive-msg" role="alert">
            <${Icon} name="warning" size=${26} />
            <b>${error.status === 404 ? 'A pasta desta coleção sumiu do Drive' : 'Não consegui abrir a pasta no Drive'}</b>
            <p>${error.status === 404 ? 'Ela pode ter ido para a lixeira. Apague a coleção aqui ou restaure a pasta no Drive.' : 'Confira a internet e tente de novo.'}</p>
            <${Button} size="sm" variant="secondary" icon="refresh" onClick=${reload}>Tentar de novo</${Button}>
          </div>`
        : null}
      ${!other && !list && !error
        ? html`<ul class="rtiles is-skeleton" aria-hidden="true">${[0, 1, 2, 3, 4, 5].map((i) => html`<li key=${i}><span class="rtile"><span class="rtile-media skeleton"></span></span></li>`)}</ul>`
        : null}
      ${(pending.length || items.length) && !other
        ? html`<ul class="rtiles">
            ${pending.map((it) => html`<${PendingTile} key=${it.id} it=${it} />`)}
            ${items.map((f) => html`<${ItemTile} key=${f.id} f=${f} onOpen=${(x) => setPreview({ index: items.findIndex((y) => y.id === x.id) })} />`)}
          </ul>`
        : null}
      ${list && !items.length && !pending.length && !other
        ? html`<div class="rempty is-small">
            <span class="rempty-art" aria-hidden="true"><${KindGlyph} kind="folder" size=${30} label=${false} /></span>
            <b>Nada aqui ainda</b>
            <p>Salve um link e o computador baixa para esta pasta.</p>
          </div>`
        : null}
    </main>
    ${preview
      ? html`<${Preview}
          files=${items}
          index=${preview.index}
          onIndex=${(i) => setPreview({ index: i })}
          onClose=${() => setPreview(null)}
          extra=${(f) => html`<${RefInfo} file=${f} />`}
          album=${c.nome}
        />`
      : null}
  </div>`
}

export function RefsScreen({ active }) {
  usePolling(active)
  const { openId, colecoes } = useApp((s) => ({ openId: s.refsOpen, colecoes: s.refs.colecoes }))
  const open = openId ? (colecoes || []).find((c) => c.id === openId) : null
  const scrollHome = useRef(0)
  const go = (c) => {
    scrollHome.current = window.scrollY
    setState({ refsOpen: c.id })
    window.scrollTo(0, 0)
  }
  const back = () => {
    setState({ refsOpen: null })
    requestAnimationFrame(() => window.scrollTo(0, scrollHome.current))
  }
  return open ? html`<${Collection} key=${open.id} c=${open} onBack=${back} />` : html`<${Home} onOpen=${go} />`
}

// ───── folhas ─────

function Field({ label, children, help, error }) {
  return html`<label class="rfield">
    <span class="rfield-label">${label}</span>
    ${children}
    ${error ? html`<span class="field-help is-error" role="alert">${error}</span>` : help ? html`<span class="field-help">${help}</span>` : null}
  </label>`
}

/** "Salvar link": cola o endereço (área de transferência num toque), escolhe a coleção, nota opcional. */
export function RefSaveSheet({ texto = '', colecaoId }) {
  const { colecoes, status } = useApp((s) => ({ colecoes: s.refs.colecoes || [], status: s.refs.status }))
  const [url, setUrl] = useState(() => refs.findUrl(texto) || '')
  const [pick, setPick] = useState(() => colecaoId || (colecoes.some((c) => c.id === refs.lastColecao()) ? refs.lastColecao() : colecoes[0]?.id || null))
  const [newName, setNewName] = useState('')
  const [nota, setNota] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Criar ou renomear coleção aqui mesmo, sem perder o link colado: edit = 'nova' | id da coleção | null.
  const [edit, setEdit] = useState(null)
  const [draft, setDraft] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState(null)
  const editInput = useRef(null)
  useEffect(() => {
    if (!edit) return
    const t = setTimeout(() => editInput.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [edit])
  const canPaste = typeof navigator.clipboard?.readText === 'function'
  const found = refs.findUrl(url)
  const plat = found ? refs.platformOf(found) : ''

  useEffect(() => {
    if (status === 'idle') refs.loadRefs()
  }, [])
  useEffect(() => {
    if (!pick && colecoes.length) setPick(colecoes[0].id)
  }, [colecoes.length])

  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText()
      const u = refs.findUrl(t)
      if (u) {
        setUrl(u)
        setError(null)
      } else toast('Não achei um link na área de transferência.')
    } catch {
      toast('Toque e segure no campo para colar.')
    }
  }
  const startEdit = (which, nome = '') => {
    setEdit(which)
    setDraft(nome)
    setEditError(null)
  }
  const commitEdit = async () => {
    const v = draft.trim()
    if (!v) return setEditError('Dê um nome para a coleção.')
    const atual = edit !== 'nova' ? colecoes.find((c) => c.id === edit) : null
    if (atual && atual.nome === v) return setEdit(null)
    setEditBusy(true)
    setEditError(null)
    try {
      if (atual) await refs.renameColecao(atual.id, v)
      else {
        const nova = await refs.createColecao(v)
        setPick(nova.id)
        toast(`Coleção ${nova.nome} criada no seu Drive.`, { tone: 'success' })
      }
      setEdit(null)
    } catch (err) {
      setEditError(err.message)
    } finally {
      setEditBusy(false)
    }
  }
  const editRow = (label) => html`<li key="edit" class="rpick-edit">
    <form class="rpick-form" onSubmit=${(e) => (e.preventDefault(), commitEdit())}>
      <${Icon} name=${edit === 'nova' ? 'plus' : 'pencil'} />
      <input
        class="input"
        type="text"
        maxlength="80"
        placeholder=${edit === 'nova' ? 'Nome da nova coleção' : 'Nome da coleção'}
        value=${draft}
        aria-label=${label}
        ref=${editInput}
        onInput=${(e) => setDraft(e.currentTarget.value)}
        onKeyDown=${(e) => e.key === 'Escape' && (e.stopPropagation(), setEdit(null))}
        disabled=${editBusy}
      />
      <${Button} size="sm" variant="primary" type="submit" loading=${editBusy} disabled=${editBusy || !draft.trim()}>${edit === 'nova' ? 'Criar' : 'OK'}</${Button}>
      <button type="button" class="icon-btn rpick-x" onClick=${() => setEdit(null)} aria-label="Cancelar" disabled=${editBusy}><${Icon} name="x" size=${18} /></button>
    </form>
    ${editError ? html`<p class="form-error rpick-err" role="alert"><${Icon} name="warning" size=${16} /> <span>${editError}</span></p>` : null}
  </li>`

  const save = async () => {
    if (!found) return setError('Cole um link que comece com https://')
    setBusy(true)
    setError(null)
    try {
      let target = pick
      if (!colecoes.length && status === 'ready') {
        const nome = newName.trim()
        if (!nome) {
          setBusy(false)
          return setError('Dê um nome para a primeira coleção.')
        }
        target = (await refs.createColecao(nome)).id
      }
      const r = await refs.saveLink({ url: found, colecaoId: target, nota: nota.trim() })
      const nome = (getState().refs.colecoes || []).find((c) => c.id === target)?.nome || 'a coleção'
      toast(r.novo ? `Salvo em ${nome}. O computador baixa.` : `Esse link já está na fila de ${nome}.`, { tone: 'success', ms: 3200 })
      closeSheet()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return html`<${SheetHead}
      title="Salvar link"
      left=${html`<button type="button" class="link-btn" onClick=${closeSheet}>Cancelar</button>`}
      right=${html`<button type="button" class="link-btn is-strong" onClick=${save} disabled=${busy || !found}>Salvar</button>`}
    />
    <div class="sheet-body sheet-scroll rsheet">
      <${Field} label="Link" help=${plat ? `${plat} · o computador baixa e guarda no seu Drive` : 'Do Instagram, YouTube, TikTok, Vimeo, Pinterest…'}>
        <span class="rurl">
          <input
            class="input"
            type="url"
            inputmode="url"
            placeholder="https://"
            value=${url}
            autocomplete="off"
            autocapitalize="off"
            spellcheck=${false}
            onInput=${(e) => setUrl(e.currentTarget.value)}
            aria-label="Link"
          />
          ${canPaste ? html`<${Button} size="sm" variant="secondary" icon="clipboard" class="rurl-paste" onClick=${paste}>Colar</${Button}>` : null}
        </span>
      </${Field}>
      ${status === 'idle' || status === 'loading'
        ? html`<p class="rfield-label rpick-label">Coleção</p><div class="group rpick-wait"><span class="spinner" aria-label="Carregando as coleções"></span></div>`
        : colecoes.length
        ? html`<p class="rfield-label rpick-label">Coleção</p>
            <ul class="group menu rpick" role="radiogroup" aria-label="Coleção">
              ${colecoes.map((c) =>
                edit === c.id
                  ? editRow(`Novo nome para ${c.nome}`)
                  : html`<li key=${c.id} class="rpick-row">
                      <button type="button" role="radio" aria-checked=${pick === c.id ? 'true' : 'false'} class="menu-item" onClick=${() => setPick(c.id)}>
                        <${Icon} name="bookmark" />
                        <span class="menu-text">${c.nome}</span>
                        ${pick === c.id ? html`<${Icon} name="check" size=${18} strokeWidth=${2.2} class="rpick-check" />` : null}
                      </button>
                      <button type="button" class="icon-btn rpick-ren" onClick=${() => startEdit(c.id, c.nome)} aria-label=${`Renomear ${c.nome}`}>
                        <${Icon} name="pencil" size=${17} />
                      </button>
                    </li>`,
              )}
              ${edit === 'nova'
                ? editRow('Nome da nova coleção')
                : html`<li key="nova">
                    <button type="button" class="menu-item rpick-new" onClick=${() => startEdit('nova')}>
                      <${Icon} name="plus" />
                      <span class="menu-text">Nova coleção</span>
                    </button>
                  </li>`}
            </ul>`
        : html`<${Field} label="Primeira coleção">
            <input class="input" type="text" placeholder="Ex.: Planos-sequência" maxlength="80" value=${newName} onInput=${(e) => setNewName(e.currentTarget.value)} />
          </${Field}>`}
      <${Field} label="Nota (opcional)">
        <textarea class="input rnote" rows="2" maxlength="2000" placeholder="Por que guardou: a luz, o corte, a trilha…" value=${nota} onInput=${(e) => setNota(e.currentTarget.value)}></textarea>
      </${Field}>
      ${error ? html`<p class="form-error" role="alert"><${Icon} name="warning" size=${16} /> <span>${error}</span></p>` : null}
      <${Button} variant="primary" class="btn-block btn-lg rsheet-go" loading=${busy} disabled=${busy || !found} onClick=${save}>Salvar</${Button}>
      <p class="group-foot">Fica na fila até o app do computador baixar. Salve só para referência e respeite quem criou.</p>
    </div>`
}
RefSaveSheet.label = 'Salvar link'

/** Nova coleção ou Renomear. */
export function RefNameSheet({ id }) {
  const c = id ? colecaoById(id) : null
  const [nome, setNome] = useState(c?.nome || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const input = useRef(null)
  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 350)
    return () => clearTimeout(t)
  }, [])
  const save = async () => {
    const v = nome.trim()
    if (!v) return setError('Dê um nome para a coleção.')
    setBusy(true)
    setError(null)
    try {
      if (c) await refs.renameColecao(c.id, v)
      else {
        const nova = await refs.createColecao(v)
        toast(`Coleção ${nova.nome} criada no seu Drive.`, { tone: 'success' })
      }
      closeSheet()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }
  return html`<${SheetHead}
      title=${c ? 'Renomear' : 'Nova coleção'}
      left=${html`<button type="button" class="link-btn" onClick=${closeSheet}>Cancelar</button>`}
      right=${html`<button type="button" class="link-btn is-strong" onClick=${save} disabled=${busy || !nome.trim()}>${c ? 'Salvar' : 'Criar'}</button>`}
    />
    <div class="sheet-body rsheet">
      <${Field} label="Nome" help=${c ? 'A pasta no Drive muda junto.' : 'Vira uma pasta em SOBEDESCE Referências, no seu Drive.'} error=${error}>
        <input
          ref=${input}
          class="input"
          type="text"
          maxlength="80"
          placeholder="Ex.: Luz de janela"
          value=${nome}
          onInput=${(e) => setNome(e.currentTarget.value)}
          onKeyDown=${(e) => e.key === 'Enter' && save()}
        />
      </${Field}>
      <${Button} variant="primary" class="btn-block btn-lg rsheet-go" loading=${busy} disabled=${busy || !nome.trim()} onClick=${save}>${c ? 'Salvar' : 'Criar coleção'}</${Button}>
    </div>`
}
RefNameSheet.label = 'Coleção'

export function RefMenuSheet({ id }) {
  const c = useApp((s) => (s.refs.colecoes || []).find((x) => x.id === id))
  if (!c) return null
  const folder = `https://drive.google.com/drive/folders/${encodeURIComponent(c.driveFolderId)}`
  return html`<${SheetHead} title=${c.nome} right=${html`<button type="button" class="link-btn is-strong" onClick=${closeSheet}>OK</button>`} />
    <div class="sheet-body rsheet">
      <ul class="group menu">
        <li>
          <button type="button" class="menu-item" onClick=${() => openSheet('refName', { id })}>
            <${Icon} name="pencil" /><span>Renomear</span><${Icon} name="chevron-right" size=${16} strokeWidth=${2} class="menu-chev" />
          </button>
        </li>
        <li>
          <button type="button" class="menu-item" onClick=${() => openSheet('refLink', { id })}>
            <${Icon} name="sparkle" /><span class="menu-text">Link pra IA<small>${c.link ? 'Ligado' : 'Desligado'}</small></span><${Icon} name="chevron-right" size=${16} strokeWidth=${2} class="menu-chev" />
          </button>
        </li>
        <li>
          <a class="menu-item" href=${folder} target="_blank" rel="noopener noreferrer">
            <${Icon} name="drive" /><span>Abrir a pasta no Drive</span><${Icon} name="external" size=${16} class="menu-chev" />
          </a>
        </li>
      </ul>
      <ul class="group menu rmenu-danger">
        <li>
          <button type="button" class="menu-item is-danger" onClick=${() => openSheet('refDelete', { id })}>
            <${Icon} name="trash" /><span>Apagar coleção</span>
          </button>
        </li>
      </ul>
    </div>`
}
RefMenuSheet.label = 'Opções da coleção'

export function RefLinkSheet({ id }) {
  const { c, drive } = useApp((s) => ({ c: (s.refs.colecoes || []).find((x) => x.id === id), drive: s.drive }))
  const [busy, setBusy] = useState(null)
  const [open, setOpen] = useState(undefined) // pasta aberta para quem tem o link? undefined = conferindo
  const sameDrive = c && !isOtherDrive(c, drive)
  useEffect(() => {
    if (!c || !sameDrive) return setOpen(null)
    let alive = true
    refs.folderIsOpen(c.driveFolderId).then(
      (v) => alive && setOpen(v),
      () => alive && setOpen(null),
    )
    return () => (alive = false)
  }, [c?.driveFolderId, sameDrive])
  if (!c) return null

  const act = async (what) => {
    setBusy(what)
    try {
      const nova = await refs.setLink(c.id, what)
      if (what === 'ligar' && nova.link) {
        const ok = await copyText(nova.link)
        toast(ok ? 'Link ligado e copiado.' : 'Link ligado.', { tone: 'success' })
      } else if (what === 'trocar') toast('Link novo. O antigo parou de abrir.', { tone: 'success' })
      else if (what === 'desligar') toast('Link desligado.')
    } catch (err) {
      toast(err.message, { tone: 'error', ms: 4000 })
    }
    setBusy(null)
  }
  const copy = async () => toast((await copyText(c.link)) ? 'Link copiado.' : 'Não consegui copiar.', { tone: 'success' })
  const share = async () => {
    try {
      await navigator.share({ title: c.nome, url: c.link })
    } catch {
      // cancelado
    }
  }
  const toggleVideos = async (v) => {
    setBusy('videos')
    try {
      await refs.setFolderOpen(c.driveFolderId, v)
      setOpen(v)
      toast(v ? 'Quem tiver o link também assiste os vídeos.' : 'Os vídeos voltaram a ser só seus.', { tone: 'success' })
    } catch (err) {
      toast(err?.status === 403 ? 'O Drive não deixou mudar o compartilhamento desta pasta.' : 'Não consegui mudar agora. Tente de novo.', { tone: 'error', ms: 4000 })
    }
    setBusy(null)
  }

  return html`<${SheetHead} title="Link pra IA" right=${html`<button type="button" class="link-btn is-strong" onClick=${closeSheet}>OK</button>`} />
    <div class="sheet-body sheet-scroll rsheet">
      <p class="rexplain">Uma página que o ChatGPT, o Claude e o Gemini conseguem ler: título, autor, link original e legenda de cada referência.</p>
      ${c.link
        ? html`<div class="group rlink">
              <p class="rlink-url mono">${c.link}</p>
              <div class="rlink-acts">
                <${Button} size="sm" variant="primary" icon="copy" onClick=${copy}>Copiar</${Button}>
                ${typeof navigator.share === 'function' ? html`<${Button} size="sm" variant="secondary" icon="share" onClick=${share}>Compartilhar</${Button}>` : null}
                <a class="btn btn-secondary btn-sm" href=${c.link} target="_blank" rel="noopener noreferrer"><span>Abrir</span></a>
              </div>
            </div>
            ${sameDrive
              ? html`<h3 class="list-label">Vídeos</h3>
                  <ul class="group menu" role="radiogroup" aria-label="Vídeos no link">
                    <li>
                      <button type="button" role="radio" aria-checked=${open === false ? 'true' : 'false'} class="menu-item" disabled=${busy || open === undefined} onClick=${() => open && toggleVideos(false)}>
                        <${Icon} name="eye-off" /><span class="menu-text">Só a lista<small>Os vídeos continuam só seus</small></span>
                        ${open === false ? html`<${Icon} name="check" size=${18} strokeWidth=${2.2} class="rpick-check" />` : null}
                      </button>
                    </li>
                    <li>
                      <button type="button" role="radio" aria-checked=${open ? 'true' : 'false'} class="menu-item" disabled=${busy || open === undefined} onClick=${() => open === false && toggleVideos(true)}>
                        <${Icon} name="eye" /><span class="menu-text">Com os vídeos<small>Quem tiver o link assiste no Drive</small></span>
                        ${busy === 'videos' ? html`<span class="spinner" aria-hidden="true"></span>` : open ? html`<${Icon} name="check" size=${18} strokeWidth=${2.2} class="rpick-check" />` : null}
                      </button>
                    </li>
                  </ul>
                  <p class="group-foot">Com os vídeos, a pasta da coleção fica aberta para quem tiver o endereço do Drive.</p>`
              : null}
            <ul class="group menu rmenu-danger">
              <li>
                <button type="button" class="menu-item" disabled=${!!busy} onClick=${() => act('trocar')}>
                  <${Icon} name="refresh" /><span class="menu-text">Trocar link<small>O endereço antigo para de abrir</small></span>
                  ${busy === 'trocar' ? html`<span class="spinner" aria-hidden="true"></span>` : null}
                </button>
              </li>
              <li>
                <button type="button" class="menu-item is-danger" disabled=${!!busy} onClick=${() => act('desligar')}>
                  <${Icon} name="x" /><span>Desligar link</span>
                  ${busy === 'desligar' ? html`<span class="spinner" aria-hidden="true"></span>` : null}
                </button>
              </li>
            </ul>`
        : html`<${Button} variant="primary" class="btn-block btn-lg rsheet-go" icon="sparkle" loading=${busy === 'ligar'} onClick=${() => act('ligar')}>Ligar o link</${Button}>
            <p class="group-foot">Qualquer pessoa com o endereço vê a lista. Fica fora do Google. Dá para trocar ou desligar quando quiser.</p>`}
    </div>`
}
RefLinkSheet.label = 'Link pra IA'

export function RefDeleteSheet({ id }) {
  const c = colecaoById(id)
  const [busy, setBusy] = useState(null)
  if (!c) return null
  const go = async (noDrive) => {
    setBusy(noDrive ? 'drive' : 'app')
    try {
      await refs.deleteColecao(c.id, noDrive)
      setState({ refsOpen: null })
      toast(noDrive ? 'Coleção apagada. A pasta foi para a lixeira do Drive.' : 'Coleção tirada daqui. A pasta continua no Drive.', { tone: 'success', ms: 3600 })
      closeSheet()
    } catch (err) {
      toast(err.message, { tone: 'error', ms: 4000 })
      setBusy(null)
    }
  }
  return html`<${SheetHead} title=${`Apagar “${c.nome}”?`} left=${html`<button type="button" class="link-btn" onClick=${closeSheet}>Cancelar</button>`} />
    <div class="sheet-body rsheet">
      <${Button} variant="secondary" class="btn-block btn-lg" loading=${busy === 'app'} disabled=${!!busy} onClick=${() => go(false)}>Tirar só daqui</${Button}>
      <p class="group-foot rdel-foot">A pasta e os vídeos continuam no seu Drive.</p>
      <${Button} variant="secondary" class="btn-block btn-lg is-danger" loading=${busy === 'drive'} disabled=${!!busy} onClick=${() => go(true)}>Apagar também no Drive</${Button}>
      <p class="group-foot rdel-foot">A pasta vai para a lixeira do Drive (dá para recuperar por 30 dias).</p>
    </div>`
}
RefDeleteSheet.label = 'Apagar coleção'

/** Link na fila: o que está acontecendo, tentar de novo, tirar da fila. */
export function RefItemSheet({ id }) {
  const it = useApp((s) => (s.refs.fila || []).find((i) => i.id === id))
  const [busy, setBusy] = useState(null)
  if (!it) return null
  const run = async (what, fn, done) => {
    setBusy(what)
    try {
      await fn()
      toast(done, { tone: 'success' })
      closeSheet()
    } catch (err) {
      toast(err.message, { tone: 'error', ms: 4000 })
      setBusy(null)
    }
  }
  const state =
    it.status === 'erro'
      ? { icon: 'warning', title: 'Não baixou', text: it.erro || 'O computador não conseguiu baixar este link.' }
      : it.status === 'baixando'
        ? { icon: 'laptop', title: 'Baixando no computador', text: 'Aparece na coleção quando terminar.' }
        : { icon: 'clock', title: 'Aguardando o computador', text: 'Com o SOBEDESCE aberto e conectado à sua conta, o computador baixa e guarda no seu Drive.' }
  return html`<${SheetHead} title=${it.plataforma || 'Link'} right=${html`<button type="button" class="link-btn is-strong" onClick=${closeSheet}>OK</button>`} />
    <div class="sheet-body rsheet">
      <div class=${cx('ritem', it.status === 'erro' && 'is-error')}>
        <${Icon} name=${state.icon} size=${22} />
        <div><b>${state.title}</b><p>${state.text}</p></div>
      </div>
      <p class="rlink-url mono ritem-url">${it.url}</p>
      ${it.nota ? html`<p class="ritem-note">${it.nota}</p>` : null}
      <div class="ritem-acts">
        ${it.status === 'erro'
          ? html`<${Button} variant="primary" class="btn-block btn-lg" icon="retry" loading=${busy === 'retry'} disabled=${!!busy} onClick=${() => run('retry', () => refs.retryItem(it.id), 'Voltou para a fila.')}>Tentar de novo</${Button}>`
          : null}
        <a class="btn btn-secondary btn-block btn-lg" href=${it.url} target="_blank" rel="noopener noreferrer"><${Icon} name="external" size=${17} /><span>Abrir o link</span></a>
        <${Button} variant="secondary" class="btn-block btn-lg is-danger" loading=${busy === 'rm'} disabled=${!!busy} onClick=${() => run('rm', () => refs.removeItem(it.id), 'Tirado da fila.')}>Tirar da fila</${Button}>
      </div>
    </div>`
}
RefItemSheet.label = 'Link na fila'

/** iPhone: chave do Atalho e o caminho para o passo a passo. */
export function RefAtalhoSheet() {
  const [st, setSt] = useState(null) // { ativo, ultimoUsoEm }
  const [fresh, setFresh] = useState(null) // { token, endpoint, instalar } (só logo depois de gerar)
  const [busy, setBusy] = useState(null)
  useEffect(() => {
    refs.atalho.status().then(setSt, () => setSt({ ativo: false }))
  }, [])
  const make = async () => {
    setBusy('make')
    try {
      const r = await refs.atalho.create()
      setFresh(r)
      setSt({ ativo: true })
      setAtalhoAtivo(false) // chave nova: ainda não usada
    } catch (err) {
      toast(err.message, { tone: 'error', ms: 4000 })
    }
    setBusy(null)
  }
  const revoke = async () => {
    setBusy('revoke')
    try {
      await refs.atalho.revoke()
      setFresh(null)
      setSt({ ativo: false })
      setAtalhoAtivo(false)
      toast('Atalho desligado.')
    } catch (err) {
      toast(err.message, { tone: 'error', ms: 4000 })
    }
    setBusy(null)
  }
  const copy = async (text, what) => toast((await copyText(text)) ? `${what} copiado.` : 'Não consegui copiar.', { tone: 'success' })
  return html`<${SheetHead} title="Atalho do iPhone" right=${html`<button type="button" class="link-btn is-strong" onClick=${closeSheet}>OK</button>`} />
    <div class="sheet-body sheet-scroll rsheet">
      <p class="rexplain">No Instagram, toque em Compartilhar e escolha “Salvar na SOBEDESCE”: o link entra na fila e o computador baixa. Monta uma vez, no app Atalhos, em uns dois minutos.</p>
      ${fresh
        ? html`<ol class="rsteps">
              <li>Abra o passo a passo (a chave já vai junto).</li>
              <li>No app Atalhos, crie o atalho como mostrado.</li>
              <li>Compartilhe um vídeo para testar.</li>
            </ol>
            <a class="btn btn-primary btn-block btn-lg rsheet-go" href=${fresh.instalar} target="_blank" rel="noopener noreferrer"><span>Abrir o passo a passo</span></a>
            <div class="group rlink">
              <p class="rfield-label">Sua chave</p>
              <p class="rlink-url mono">${fresh.token}</p>
              <div class="rlink-acts">
                <${Button} size="sm" variant="secondary" icon="copy" onClick=${() => copy(fresh.token, 'Chave')}>Copiar chave</${Button}>
                <${Button} size="sm" variant="secondary" icon="copy" onClick=${() => copy(fresh.endpoint, 'Endereço')}>Copiar endereço</${Button}>
              </div>
            </div>
            <p class="group-foot">A chave aparece só agora. Ela só põe links na sua fila: não abre a conta nem lê nada.</p>`
        : st?.ativo
          ? html`<div class="ritem is-ok"><${Icon} name="circle-check" size=${22} /><div><b>Atalho ligado</b><p>${st.ultimoUsoEm ? 'Já recebeu links por ele.' : 'Ainda não recebeu nenhum link.'} Perdeu a chave? Gere outra: a antiga para de valer.</p></div></div>
              <${Button} variant="primary" class="btn-block btn-lg rsheet-go" loading=${busy === 'make'} disabled=${!!busy} onClick=${make}>Gerar outra chave</${Button}>
              <${Button} variant="secondary" class="btn-block btn-lg is-danger" loading=${busy === 'revoke'} disabled=${!!busy} onClick=${revoke}>Desligar o Atalho</${Button}>`
          : html`<${Button} variant="primary" class="btn-block btn-lg rsheet-go" icon="key" loading=${busy === 'make' || !st} disabled=${!!busy || !st} onClick=${make}>Gerar a chave e começar</${Button}>`}
    </div>`
}
RefAtalhoSheet.label = 'Atalho do iPhone'
RefAtalhoSheet.tall = false
