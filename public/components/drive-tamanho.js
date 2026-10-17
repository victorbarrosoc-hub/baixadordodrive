// Tamanho das pastas na tela Drive. O motor soma a árvore (src/server/tamanho.js); aqui ficam as contas desta
// sessão por conta/pasta, a pergunta de progresso (~0,7 s, só enquanto alguma anda), a linha de resumo da pasta
// aberta e a célula de tamanho das subpastas (sob pedido: "Calcular").
import { html, useEffect, useState } from '/vendor/preact-htm.js'
import { api, enc, withQuery } from '../lib/api.js'
import { getState, subscribe as subscribeStore } from '../lib/store.js'
import { bytes, count, plural } from '../lib/format.js'
import { Icon } from './icons.js'
import { Spinner } from './common.js'
import { cx } from '../lib/ui.js'

const POLL_MS = 700
const BIG_ITEMS = 20_000 // acima disso (ou de BIG_MS) mostra "…+" e "Parar"
const BIG_MS = 30_000

const sizes = new Map() // accountId -> Map(folderId -> TamanhoView)
const listeners = new Set()
let timer = null

const isLive = (v) => v?.status === 'running' || v?.status === 'queued'
export const isBig = (v) => !!v && (v.files + v.folders > BIG_ITEMS || (v.elapsedMs || 0) > BIG_MS)

/** Id que a conta usa: atalho de pasta conta a pasta de verdade. */
export const sizeId = (it) => (it?.isShortcut && it.shortcutTargetId ? it.shortcutTargetId : it?.id)

export function getSize(accountId, folderId) {
  return sizes.get(accountId)?.get(folderId) || null
}

function put(accountId, folderId, view) {
  let m = sizes.get(accountId)
  if (!m) sizes.set(accountId, (m = new Map()))
  if (view) m.set(folderId, view)
  else m.delete(folderId)
}

function notify() {
  for (const fn of listeners) fn()
}

/** Re-renderiza quando alguma conta muda. */
export function useSizes() {
  const [n, force] = useState(0)
  useEffect(() => {
    const fn = () => force((x) => x + 1)
    listeners.add(fn)
    return () => listeners.delete(fn)
  }, [])
  return n
}

function schedule() {
  if (!timer) timer = setTimeout(poll, POLL_MS)
}

async function poll() {
  timer = null
  let again = false
  for (const [accountId, m] of sizes) {
    const ids = [...m].filter(([, v]) => isLive(v)).map(([id]) => id)
    if (!ids.length) continue
    try {
      const res = await api.get(withQuery(`/api/drive/${enc(accountId)}/tamanho`, { ids: ids.join(',') }))
      for (const id of ids) {
        const cur = m.get(id)
        // Esquecida aqui enquanto a pergunta ia (saiu da pasta): não ressuscita.
        if (!cur || !isLive(cur)) continue
        const v = res.tamanhos?.[id] || null
        put(accountId, id, v)
        if (isLive(v)) again = true
      }
    } catch {
      again = true // motor ocupado ou reiniciando: tenta de novo na próxima
    }
  }
  notify()
  if (again) schedule()
}

/** Começa (ou pega o que o motor já sabe). `auto`: abrir a pasta; não recomeça uma conta parada à mão. */
export async function calcSize(accountId, folderId, { refresh = false, auto = false } = {}) {
  if (!accountId || !folderId) return null
  const cur = getSize(accountId, folderId)
  if (!refresh && (isLive(cur) || cur?.status === 'done' || (auto && cur?.status === 'stopped'))) return cur
  put(accountId, folderId, { ...(cur || {}), folderId, status: 'queued', bytes: cur?.bytes ?? 0, files: cur?.files ?? 0, folders: cur?.folders ?? 0, docs: 0, shortcuts: 0, elapsedMs: 0, error: undefined })
  notify()
  try {
    const res = await api.post(`/api/drive/${enc(accountId)}/tamanho`, { folderId, refresh, auto })
    put(accountId, folderId, res.tamanho)
  } catch (err) {
    put(accountId, folderId, { folderId, status: 'error', bytes: 0, files: 0, folders: 0, docs: 0, shortcuts: 0, error: err.message })
  }
  notify()
  if (isLive(getSize(accountId, folderId))) schedule()
  return getSize(accountId, folderId)
}

/** O que o motor já sabe destas pastas (contas feitas antes nesta sessão do app, até com a tela recarregada). */
export async function primeSizes(accountId, ids) {
  const m = sizes.get(accountId)
  const want = [...new Set(ids)].filter((id) => id && !m?.has(id)).slice(0, 200)
  if (!accountId || !want.length) return
  try {
    const res = await api.get(withQuery(`/api/drive/${enc(accountId)}/tamanho`, { ids: want.join(',') }))
    let live = false
    for (const id of want) {
      const v = res.tamanhos?.[id]
      if (!v || getSize(accountId, id)) continue
      put(accountId, id, v)
      live ||= isLive(v)
    }
    notify()
    if (live) schedule()
  } catch {
    // só um atalho: sem resposta, a coluna fica com "—"
  }
}

/** "Parar" (guarda o parcial) ou, com `discard`, esquece. */
export async function stopSize(accountId, folderId, { discard = false } = {}) {
  const cur = getSize(accountId, folderId)
  if (discard) put(accountId, folderId, null)
  else if (isLive(cur)) put(accountId, folderId, { ...cur, status: 'stopped' })
  notify()
  try {
    const res = await api.del(`/api/drive/${enc(accountId)}/tamanho`, { folderId, discard })
    if (!discard && res.tamanho) put(accountId, folderId, res.tamanho)
  } catch {
    // o motor esquece sozinho quem ninguém pergunta
  }
  notify()
}

/** A tela está nesta pasta (ou saiu do Drive, com null): contas que andam em outras pastas são esquecidas. */
export function focusSize(accountId, folderId) {
  for (const [acc, m] of sizes) {
    for (const [id, v] of m) if (isLive(v) && !(acc === accountId && id === folderId)) stopSize(acc, id, { discard: true })
  }
}

// Envio que termina muda o tamanho das pastas de cima (qualquer uma): esquece as contas prontas daquela conta.
let lastTransfers = null
const doneUploads = new Set()
subscribeStore((s) => {
  if (s.transfers === lastTransfers) return
  const first = lastTransfers === null
  lastTransfers = s.transfers
  let changed = false
  for (const t of s.transfers.values()) {
    if (t.type !== 'upload' || t.status !== 'completed' || doneUploads.has(t.id)) continue
    doneUploads.add(t.id)
    if (first) continue // já estavam prontos quando a tela abriu
    const m = sizes.get(t.accountId)
    if (!m) continue
    for (const [id, v] of m) if (!isLive(v)) m.delete(id)
    changed = true
  }
  if (changed) notify()
})
if (getState().transfers) for (const t of getState().transfers.values()) if (t.type === 'upload' && t.status === 'completed') doneUploads.add(t.id)

// ─────────── textos ───────────

/** "412,3 GB" para o pronto; ao vivo, sem casa quebrando a leitura. */
const total = (n) => bytes(n, { precise: true })

/** Célula de tamanho de uma subpasta na lista (e o pedaço "· 412 GB" da grade). */
export function sizeShort(v) {
  if (!v) return ''
  if (v.status === 'done') return total(v.bytes)
  if (v.status === 'stopped') return `≥ ${bytes(v.bytes)}`
  if (isLive(v)) return v.bytes ? `${bytes(v.bytes)}…` : 'Calculando…'
  return ''
}

function detail(v, { shortcuts = true, docs = true } = {}) {
  if (!v) return ''
  const parts = [v.folders ? `${plural(v.files, 'arquivo', 'arquivos')} em ${plural(v.folders, 'pasta', 'pastas')}` : plural(v.files, 'arquivo', 'arquivos')]
  // Docs do Google não têm tamanho de arquivo: no texto da linha só quando há Doc na própria pasta; no resto, na dica.
  if (v.docs && docs) parts.push('Docs do Google não entram na soma')
  if (v.shortcuts && shortcuts) parts.push(`${plural(v.shortcuts, 'atalho', 'atalhos')} fora da conta (não são seguidos)`)
  return parts.join(' · ')
}

/** Célula "Tamanho" de uma pasta na lista: "—" até calcular (com "Calcular" ao passar o mouse), depois o valor. */
export function FolderSizeCell({ v, onCalc, name }) {
  if (v?.status === 'done') return html`<span class="fsize is-done" title=${detail(v)}>${total(v.bytes)}</span>`
  if (isLive(v))
    return html`<span class="fsize is-live" title="Calculando o tamanho desta pasta…"><${Spinner} size=${11} /><span>${v.bytes ? bytes(v.bytes) : ''}</span></span>`
  if (v?.status === 'stopped') return html`<span class="fsize" title=${`Parado no meio: ${detail(v)}`}>≥ ${bytes(v.bytes)}</span>`
  return html`<span class="fsize">
    <span class="fsize-dash" title=${v?.error || ''}>—</span>
    ${onCalc
      ? html`<button
          type="button"
          class="fsize-calc"
          tabindex="-1"
          title="Somar tudo o que tem dentro desta pasta"
          aria-label=${`Calcular o tamanho de ${name}`}
          onClick=${(e) => {
            e.stopPropagation()
            onCalc()
          }}
          onDblClick=${(e) => e.stopPropagation()}
        >Calcular</button>`
      : null}
  </span>`
}

/**
 * Linha embaixo da trilha: "75 itens · 412,3 GB · 1.234 arquivos em 56 pastas".
 * Começa sozinha ao abrir a pasta (menos no Meu Drive inteiro, que pode ser enorme: lá é no botão).
 * Com um filtro de tipo (`filtro`: "12 vídeos · 380 GB") a linha mostra só o que está visível (o "×" do botão Filtro
 * volta a Tudo). `extra`: o "N arquivos do Mac ocultos", no fim da linha.
 */
export function FolderSummary({ accountId, folderId, items, ready, count: n0, filtro, extra }) {
  useSizes()
  const v = getSize(accountId, folderId)
  const auto = folderId !== 'root'
  useEffect(() => {
    if (ready && auto && accountId && !v) calcSize(accountId, folderId, { auto: true })
  }, [ready, accountId, folderId, !v])
  useEffect(() => {
    if (ready && items?.length) primeSizes(accountId, items.filter((it) => it.isFolder || (it.isShortcut && it.shortcutTargetMimeType === 'application/vnd.google-apps.folder')).map(sizeId))
  }, [ready, accountId, items])

  // `count`: os itens à vista (sem os arquivos do Mac ocultos); sem ele, todos da pasta.
  const n = n0 ?? items?.length ?? 0
  const head = items ? html`<span class="dsum-count">${plural(n, 'item', 'itens')}</span>` : null
  const sep = html`<span class="dsum-sep" aria-hidden="true">·</span>`
  const end = extra ? html`<span class="dsum-end">${extra}</span>` : null
  if (filtro) {
    return html`<div class="drive-sum is-filtered">
      <span class="dsum-main" aria-live="polite"><span class="dsum-count"><b>${filtro}</b></span></span>
      ${end}
    </div>`
  }
  let body = null
  if (!v) {
    body = auto
      ? null
      : html`<button type="button" class="dsum-act" onClick=${() => calcSize(accountId, folderId)} title="Somar tudo o que tem no Meu Drive (pode demorar)">
          <${Icon} name="disk" size=${13} /> Calcular o tamanho total
        </button>`
  } else if (isLive(v)) {
    const big = isBig(v)
    body = html`<span class="dsum-live" role="status">
        <${Spinner} size=${12} />
        <span>Calculando… ${count(v.files)}${big ? '+' : ''} ${v.files === 1 ? 'arquivo' : 'arquivos'} · <b>${bytes(v.bytes)}${big ? '…+' : ''}</b></span>
      </span>
      ${big ? html`<button type="button" class="dsum-act" onClick=${() => stopSize(accountId, folderId)}><${Icon} name="pause" size=${12} /> Parar</button>` : null}`
  } else if (v.status === 'done') {
    const docHere = !!items?.some((it) => it.isGoogleDoc)
    body = html`<span class="dsum-total" title=${detail(v)}><b>${total(v.bytes)}</b> · ${detail(v, { shortcuts: false, docs: docHere })}</span>
      <button type="button" class="dsum-icon" onClick=${() => calcSize(accountId, folderId, { refresh: true })} title="Recalcular" aria-label="Recalcular o tamanho"><${Icon} name="refresh" size=${13} /></button>`
  } else if (v.status === 'stopped') {
    body = html`<span class="dsum-total">Pelo menos <b>${bytes(v.bytes)}</b> · ${count(v.files)}+ arquivos (parado)</span>
      <button type="button" class="dsum-act" onClick=${() => calcSize(accountId, folderId, { refresh: true })}>Calcular de novo</button>`
  } else {
    body = html`<span class="dsum-err">${v.error || 'Não consegui somar esta pasta.'}</span>
      <button type="button" class="dsum-act" onClick=${() => calcSize(accountId, folderId, { refresh: true })}>Tentar de novo</button>`
  }
  if (!head && !body && !extra) return null
  // O mini-menu do Mac fica fora da região "aria-live" (abrir o menu não é anunciado como mudança do total).
  return html`<div class=${cx('drive-sum', v && isLive(v) && 'is-live')}>
    <span class="dsum-main" aria-live="polite">${head}${head && body ? sep : null}${body}</span>
    ${end}
  </div>`
}
