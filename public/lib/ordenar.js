// Ordenar e filtrar a tela Drive: lista e grade usam a mesma ordem (botão "Ordenar" e cabeçalho da lista), o filtro
// por tipo (botão "Filtro": Tudo · Vídeos · Fotos · Áudio · Pastas · Outros) e os arquivos de controle do Mac
// escondidos por padrão.
// Sem preact aqui: os testes (test/ordenar.test.js) importam direto.
import { CAMERA_EXT, bytes, extOf, fileKind, plural } from './format.js'

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const GAPPS = 'application/vnd.google-apps.'

/** Pasta ou atalho para pasta (abre ao clicar). Vai sempre antes dos arquivos. */
export const isFolderLike = (it) => !!it && (it.isFolder || (it.isShortcut && it.shortcutTargetMimeType === FOLDER_MIME))

// ───── ordem ─────

/** `first`: a direção quando a opção é escolhida (a ativa, escolhida de novo, inverte). */
export const SORTS = [
  { key: 'name', label: 'Nome', first: 'asc', dirs: { asc: 'A a Z', desc: 'Z a A' } },
  { key: 'modified', label: 'Modificado', first: 'desc', dirs: { desc: 'Mais novos primeiro', asc: 'Mais antigos primeiro' } },
  { key: 'size', label: 'Tamanho', first: 'desc', dirs: { desc: 'Maiores primeiro', asc: 'Menores primeiro' } },
  { key: 'type', label: 'Tipo', first: 'asc', dirs: { asc: 'Por extensão, A a Z', desc: 'Por extensão, Z a A' } },
]
export const DEFAULT_SORT = Object.freeze({ key: 'name', dir: 'asc' })

/** O que veio do localStorage (de uma versão antiga, ou mexido à mão) vira uma ordem válida. */
export function normalizeSort(s) {
  const def = SORTS.find((x) => x.key === s?.key)
  if (!def) return DEFAULT_SORT
  return { key: def.key, dir: s.dir === 'desc' ? 'desc' : 'asc' }
}

/** Escolher `key` no menu ou no cabeçalho: a ordem ativa inverte; outra começa na direção natural dela. */
export function nextSort(cur, key) {
  const c = normalizeSort(cur)
  const def = SORTS.find((x) => x.key === key) || SORTS[0]
  if (c.key === def.key) return { key: def.key, dir: c.dir === 'asc' ? 'desc' : 'asc' }
  return { key: def.key, dir: def.first }
}

/** "Nome ↑" (o texto do botão) e a dica longa ("Nome: A a Z"). */
export function sortLabel(s) {
  const c = normalizeSort(s)
  const def = SORTS.find((x) => x.key === c.key)
  return { short: `${def.label} ${c.dir === 'asc' ? '↑' : '↓'}`, long: `${def.label}: ${def.dirs[c.dir]}` }
}

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' })
const byName = (a, b) => collator.compare(a.name || '', b.name || '')
const timeOf = (it) => {
  const t = Date.parse(it.modifiedTime || '')
  return Number.isFinite(t) ? t : 0
}
const typeOf = (it) => (isFolderLike(it) || it.isGoogleDoc ? '' : extOf(it.name || ''))

/**
 * Comparador da tela. Pastas sempre primeiro (em qualquer direção). Empate em Modificado/Tamanho/Tipo: pelo nome, de
 * A a Z (dois BRAW do mesmo tamanho não trocam de lugar ao inverter).
 */
export function compareItems(key, dir) {
  const m = dir === 'desc' ? -1 : 1
  return (a, b) => {
    const fa = isFolderLike(a)
    const fb = isFolderLike(b)
    if (fa !== fb) return fa ? -1 : 1
    let r = 0
    if (key === 'size') r = (a.size ?? -1) - (b.size ?? -1)
    else if (key === 'modified') r = timeOf(a) - timeOf(b)
    else if (key === 'type') r = collator.compare(typeOf(a), typeOf(b))
    else return byName(a, b) * m
    return r ? r * m : byName(a, b)
  }
}

// ───── arquivos do Mac ─────

// Mesma regra do servidor (src/util/paths.js isMacClutter): o servidor confere de novo antes de mover qualquer coisa.
export const MAC_MAX_BYTES = 4_000_000
const MAC_EXACT = new Set(['.ds_store', 'thumbs.db'])

/** AppleDouble ("._A003_C001.braw"), .DS_Store ou Thumbs.db: escondidos por padrão. */
export function isMacFile(it) {
  if (!it || isFolderLike(it) || it.isShortcut || it.isGoogleDoc) return false
  const name = String(it.name || '')
  return name.startsWith('._') || MAC_EXACT.has(name.toLowerCase())
}

/** O que "Mover para a lixeira…" leva: ._ com menos de 4 MB, .DS_Store e Thumbs.db. */
export function canTrashMac(it) {
  if (!isMacFile(it)) return false
  if (MAC_EXACT.has(String(it.name).toLowerCase())) return true
  return Number.isFinite(it.size) && it.size >= 0 && it.size < MAC_MAX_BYTES
}

// ───── filtro por tipo ─────

export const FILTERS = [
  { value: 'all', label: 'Tudo' },
  { value: 'video', label: 'Vídeos', one: 'vídeo', many: 'vídeos' },
  { value: 'image', label: 'Fotos', one: 'foto', many: 'fotos' },
  { value: 'audio', label: 'Áudio', one: 'áudio', many: 'áudios' },
  { value: 'folder', label: 'Pastas', one: 'pasta', many: 'pastas' },
  { value: 'other', label: 'Outros', one: 'outro arquivo', many: 'outros arquivos' },
]

/**
 * 'video' | 'image' | 'audio' | 'folder' | 'other'. A classificação dos ícones e da prévia (fileKind + formatos de
 * câmera): BRAW, R3D, ARRI, MXF e ProRes são vídeo mesmo com o Drive dizendo application/octet-stream. Atalho conta
 * pelo alvo; Doc do Google e arquivo do Mac (._A003.braw não é vídeo) contam em Outros.
 */
export function kindOf(it) {
  if (isFolderLike(it)) return 'folder'
  if (isMacFile(it)) return 'other'
  const mime = (it.isShortcut ? it.shortcutTargetMimeType : it.mimeType) || ''
  if (it.isGoogleDoc || mime.startsWith(GAPPS)) return 'other'
  const name = String(it.name || '')
  if (CAMERA_EXT.has(extOf(name))) return 'video'
  const k = fileKind(name, mime)
  return k === 'video' || k === 'image' || k === 'audio' ? k : 'other'
}

/**
 * O que a tela mostra: sem os arquivos do Mac (a menos que `showMac`), só o tipo do filtro, na ordem escolhida.
 * `counts` (por tipo, sem os do Mac escondidos) alimenta o menu Filtro; `mac` são os arquivos do Mac da pasta.
 */
export function driveView(items, { sort = DEFAULT_SORT, filter = 'all', showMac = false } = {}) {
  // A tira de quadros do hover scrub (Proxy/<nome>.quadros.jpg) é peça interna do app: não aparece na lista.
  const all = (items || []).filter((it) => it?.appProperties?.sobedesce !== 'quadros')
  const mac = all.filter(isMacFile)
  const base = showMac || !mac.length ? all : all.filter((it) => !isMacFile(it))
  const counts = { all: base.length, video: 0, image: 0, audio: 0, folder: 0, other: 0 }
  for (const it of base) counts[kindOf(it)]++
  const f = FILTERS.some((x) => x.value === filter) ? filter : 'all'
  const visible = f === 'all' ? base : base.filter((it) => kindOf(it) === f)
  const s = normalizeSort(sort)
  return { sorted: visible.slice().sort(compareItems(s.key, s.dir)), counts, mac, filter: f }
}

/** Opções do menu "Filtro": Tudo, os tipos que existem aqui e o ativo (mesmo vazio, para dar para sair dele). */
export function filterChips(counts, active = 'all') {
  return FILTERS.filter((x) => x.value === 'all' || x.value === active || counts[x.value] > 0).map((x) => ({ ...x, count: counts[x.value] ?? 0 }))
}

/** O botão "Filtro" da barra: o texto ("Tudo", "Vídeos"), se tem filtro ativo e a dica/nome acessível. */
export function filterButton(filter) {
  const def = FILTERS.find((x) => x.value === filter) || FILTERS[0]
  const on = def.value !== 'all'
  return { label: def.label, on, title: on ? `Filtro: só ${def.many}` : 'Filtro: Tudo' }
}

/** Linha do total com o filtro ativo: "12 vídeos · 380 GB" (só o que está visível). */
export function visibleSummary(sorted, filter) {
  const def = FILTERS.find((x) => x.value === filter)
  const n = sorted.length
  const total = sorted.reduce((a, it) => a + (!isFolderLike(it) && Number.isFinite(it.size) ? it.size : 0), 0)
  const parts = [def?.one ? plural(n, def.one, def.many) : plural(n, 'item', 'itens')]
  if (total) parts.push(bytes(total, { precise: true }))
  return parts.join(' · ')
}

/** "38 arquivos do Mac ocultos" / "1 arquivo do Mac oculto". */
export function macHiddenText(n) {
  return n === 1 ? '1 arquivo do Mac oculto' : `${plural(n, 'arquivo', 'arquivos')} do Mac ocultos`
}

/** A seleção só com o que está visível (o filtro mudou: o que sumiu da tela sai da seleção). */
export function keepVisible(selected, sorted) {
  if (!selected.size) return selected
  const ids = new Set(sorted.map((x) => x.id))
  let changed = false
  const out = new Set()
  for (const id of selected) {
    if (ids.has(id)) out.add(id)
    else changed = true
  }
  return changed ? out : selected
}

/** Em lotes de `n` (a tela manda à rota da lixeira aos poucos para mostrar o progresso). */
export function chunks(list, n) {
  const out = []
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
  return out
}
