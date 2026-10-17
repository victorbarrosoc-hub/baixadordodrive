// Referências (docs/REFERENCIAS.md): coleções e fila no site (/api/referencias/*, cookie da conta) e os arquivos na
// pasta de cada coleção, lidos direto do Drive com o token de sempre (lib/drive.js). Quem baixa é o computador.
import { local } from './config.js'
import { getState, setState } from './state.js'
import { FOLDER_MIME, driveCall, q } from './drive.js'

export const API = {
  colecoes: '/api/referencias/colecoes',
  fila: '/api/referencias/fila',
  atalho: '/api/referencias/atalho/token',
}

const LAST_KEY = 'sobedesce.refs.ultima' // última coleção usada no "Salvar link"
const NOTICE_KEY = 'sobedesce.refs.aviso' // aviso de primeiro uso já visto

// ───── texto (cópia em JS de web/src/lib/referencias/texto.ts) ─────

const PLATFORMS = [
  ['Instagram', /(^|\.)(instagram\.com|instagr\.am)$/],
  ['YouTube', /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/],
  ['TikTok', /(^|\.)tiktok\.com$/],
  ['Vimeo', /(^|\.)vimeo\.com$/],
  ['Pinterest', /(^|\.)(pinterest\.[a-z.]+|pin\.it)$/],
  ['X', /(^|\.)(x\.com|twitter\.com)$/],
  ['Facebook', /(^|\.)(facebook\.com|fb\.watch|fb\.com)$/],
]

export function platformOf(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\.|^m\./, '')
    return PLATFORMS.find(([, re]) => re.test(host))?.[0] || host
  } catch {
    return ''
  }
}

function platformName(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  if (s.toLowerCase() === 'twitter') return 'X'
  return PLATFORMS.find(([n]) => n.toLowerCase() === s.toLowerCase())?.[0] || s
}

/** Primeiro link http(s) de um texto compartilhado ("Olha isso https://..."). */
export function findUrl(text) {
  const m = /https?:\/\/[^\s<>"'`]+/i.exec(String(text || ''))
  return m ? m[0].replace(/[).,;!?\]}»”]+$/, '') : ''
}

const KEYS = { titulo: 'titulo', title: 'titulo', autor: 'autor', author: 'autor', plataforma: 'plataforma', platform: 'plataforma', 'salvo em': 'salvoEm', salvo: 'salvoEm' }
const fold = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()

/** Descrição gravada pelo computador: 1ª linha o link, depois "Chave: valor", linha em branco e a legenda. */
export function readDescription(text) {
  const out = { url: '', titulo: '', autor: '', plataforma: '', salvoEm: '', legenda: '' }
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  if (/^https?:\/\/\S+$/i.test((lines[i] || '').trim())) out.url = lines[i++].trim()
  for (; i < lines.length; i++) {
    if (!lines[i].trim()) {
      i++
      break
    }
    const m = /^\s*([^:]{2,20}):\s*(.*)$/.exec(lines[i])
    const k = m && KEYS[fold(m[1])]
    if (!k) break
    if (m[2].trim()) out[k] = m[2].trim()
  }
  out.legenda = lines.slice(i).join('\n').trim()
  return out
}

/** O que a folha do item mostra: título, plataforma, autor, link original e legenda. */
export function refMeta(file) {
  const d = readDescription(file?.description)
  const ap = file?.appProperties || {}
  const url = /^https?:\/\//i.test(d.url) ? d.url : /^https?:\/\//i.test(ap.fonte || '') ? ap.fonte : ''
  const base = (file?.name || '').replace(/\.[^.]+$/, '')
  return {
    url,
    titulo: d.titulo || ap.titulo || base,
    autor: d.autor || ap.autor || '',
    plataforma: platformName(d.plataforma || ap.plataforma) || (url ? platformOf(url) : ''),
    legenda: d.legenda,
  }
}

// ───── site ─────

async function api(path, { method = 'GET', body } = {}) {
  let res
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw Object.assign(new Error('Sem conexão. Confira a internet.'), { status: 0 })
  }
  let json = null
  try {
    json = await res.json()
  } catch {
    // corpo vazio
  }
  if (!res.ok || json?.ok === false) {
    throw Object.assign(new Error(json?.mensagem || 'O SOBEDESCE não respondeu. Tente de novo.'), { status: res.status, code: json?.erro || null })
  }
  return json || {}
}

function setRefs(patch) {
  setState((s) => ({ refs: { ...s.refs, ...(typeof patch === 'function' ? patch(s.refs) : patch) } }))
}

let loading = null
/** Coleções e fila (pendente, baixando e erro). Sem `quiet`, mostra o esqueleto na primeira vez. */
export function loadRefs() {
  if (loading) return loading
  if (getState().refs.status === 'idle') setRefs({ status: 'loading' })
  loading = Promise.all([api(API.colecoes), api(API.fila)])
    .then(([c, f]) => {
      const before = getState().refs.fila || []
      const fila = f.itens || []
      // Saiu da fila aberta (ficou pronto): a pasta tem arquivo novo.
      const open = new Set(fila.map((i) => i.id))
      for (const it of before) if (!open.has(it.id)) forget(it.colecao?.id)
      setRefs({ status: 'ready', colecoes: c.colecoes || [], raiz: c.raiz || null, fila, error: null, at: Date.now() })
    })
    .catch((err) => setRefs((r) => ({ status: r.colecoes?.length ? 'ready' : 'error', error: err.message })))
    .finally(() => (loading = null))
  return loading
}

function upsert(c) {
  setRefs((r) => ({ colecoes: [c, ...(r.colecoes || []).filter((x) => x.id !== c.id)].sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm))) }))
}

export async function createColecao(nome) {
  const r = await api(API.colecoes, { method: 'POST', body: { nome, contaGoogleId: getState().drive?.id || undefined } })
  upsert(r.colecao)
  return r.colecao
}

export async function renameColecao(id, nome) {
  const r = await api(`${API.colecoes}/${encodeURIComponent(id)}`, { method: 'PATCH', body: { nome } })
  upsert(r.colecao)
  return r.colecao
}

/** 'ligar' | 'trocar' | 'desligar' */
export async function setLink(id, link) {
  const r = await api(`${API.colecoes}/${encodeURIComponent(id)}`, { method: 'PATCH', body: { link } })
  upsert(r.colecao)
  return r.colecao
}

export async function deleteColecao(id, noDrive) {
  await api(`${API.colecoes}/${encodeURIComponent(id)}${noDrive ? '?apagarNoDrive=1' : ''}`, { method: 'DELETE' })
  setRefs((r) => ({ colecoes: (r.colecoes || []).filter((c) => c.id !== id), fila: (r.fila || []).filter((i) => i.colecao?.id !== id) }))
  forget(id)
}

export async function saveLink({ url, colecaoId, nota }) {
  const r = await api(API.fila, { method: 'POST', body: { url, colecaoId, nota: nota || undefined } })
  local.set(LAST_KEY, colecaoId)
  setRefs((s) => ({ fila: [r.item, ...(s.fila || []).filter((i) => i.id !== r.item.id)] }))
  loadRefs()
  return r
}

export async function retryItem(id) {
  const r = await api(`${API.fila}/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status: 'pendente' } })
  setRefs((s) => ({ fila: (s.fila || []).map((i) => (i.id === id ? r.item : i)) }))
}

export async function removeItem(id) {
  await api(`${API.fila}/${encodeURIComponent(id)}`, { method: 'DELETE' })
  setRefs((s) => ({ fila: (s.fila || []).filter((i) => i.id !== id) }))
}

export const atalho = {
  status: () => api(API.atalho),
  create: () => api(API.atalho, { method: 'POST' }),
  revoke: () => api(API.atalho, { method: 'DELETE' }),
}

export const lastColecao = () => local.get(LAST_KEY)
export const noticeSeen = () => local.get(NOTICE_KEY) === 1
export const markNoticeSeen = () => local.set(NOTICE_KEY, 1)

// ───── arquivos de cada coleção (Drive) ─────

const FIELDS = [
  'id',
  'name',
  'mimeType',
  'size',
  'createdTime',
  'modifiedTime',
  'thumbnailLink',
  'hasThumbnail',
  'videoMediaMetadata',
  'imageMediaMetadata',
  'webViewLink',
  'driveId',
  'parents',
  'description',
  'appProperties',
  'capabilities(canDownload)',
].join(',')

const files = new Map() // colecaoId → { list, at, promise }
const waiters = []
let running = 0
const MAX = 3 // listagens ao mesmo tempo (as capas da tela inicial)

function slot(fn) {
  return new Promise((resolve, reject) => {
    const go = () => {
      running++
      fn()
        .then(resolve, reject)
        .finally(() => {
          running--
          waiters.shift()?.()
        })
    }
    running < MAX ? go() : waiters.push(go)
  })
}

const listeners = new Set()
export function onFiles(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function forget(colecaoId) {
  if (!colecaoId) return
  const cur = files.get(colecaoId)
  if (cur) cur.at = 0
  for (const fn of listeners) fn(colecaoId)
}

/** Arquivos da pasta (sem subpastas), mais novos primeiro. Cache de 2 min; `force` relê. */
export function listFiles(colecao, { force = false } = {}) {
  const cur = files.get(colecao.id)
  if (cur?.promise) return cur.promise
  if (cur?.list && !force && Date.now() - cur.at < 120_000) return Promise.resolve(cur.list)
  const promise = slot(async () => {
    const out = []
    let pageToken
    do {
      const r = await driveCall('/files', {
        query: {
          q: `'${q(colecao.driveFolderId)}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          orderBy: 'createdTime desc',
          pageSize: 200,
          pageToken,
          fields: `nextPageToken,files(${FIELDS})`,
        },
      })
      out.push(...(r.files || []))
      pageToken = r.nextPageToken
    } while (pageToken && out.length < 1000)
    return out
  }).then(
    (list) => {
      files.set(colecao.id, { list, at: Date.now() })
      for (const fn of listeners) fn(colecao.id)
      return list
    },
    (err) => {
      files.set(colecao.id, { list: cur?.list || null, at: 0, error: err })
      throw err
    },
  )
  files.set(colecao.id, { ...(cur || {}), promise })
  return promise
}

export function cachedFiles(colecaoId) {
  return files.get(colecaoId)?.list || null
}

// ───── vídeos abertos no link pra IA (permissão da pasta no Drive) ─────

const ANYONE = ['anyoneWithLink', 'anyone']

export async function folderIsOpen(folderId) {
  const r = await driveCall(`/files/${encodeURIComponent(folderId)}`, { query: { supportsAllDrives: true, fields: 'id,permissionIds' } })
  return (r.permissionIds || []).some((p) => ANYONE.includes(p))
}

/** Abre (qualquer pessoa com o link, só leitura) ou fecha a pasta da coleção no Drive. */
export async function setFolderOpen(folderId, open) {
  const path = `/files/${encodeURIComponent(folderId)}/permissions`
  if (open) {
    await driveCall(path, { method: 'POST', query: { supportsAllDrives: true, fields: 'id' }, body: { type: 'anyone', role: 'reader', allowFileDiscovery: false }, retries: 1 })
  } else {
    for (const id of ANYONE) {
      try {
        await driveCall(`${path}/${id}`, { method: 'DELETE', query: { supportsAllDrives: true }, retries: 1 })
      } catch (err) {
        if (err?.status !== 404) throw err
      }
    }
  }
}

// ───── motivo curto do erro (quadrado da coleção) ─────

/**
 * A mensagem do computador ("O Instagram pediu login: entre no Instagram pelo navegador de referências.") cabe no
 * quadrado só como uma linha curta: "Instagram pediu login". A mensagem inteira continua na folha do item.
 */
export function motivoCurto(erro) {
  const t = String(erro || '').trim()
  if (!t) return 'Não baixou'
  const login = /^(?:O |A )?(.+?) pediu login/i.exec(t)
  if (login) return `${login[1][0].toUpperCase()}${login[1].slice(1)} pediu login`
  const regras = [
    [/privado ou removido/i, 'Privado ou removido'],
    [/não está disponível no Brasil/i, 'Bloqueado no Brasil'],
    [/não tem vídeo/i, 'Post sem vídeo'],
    [/não é de um vídeo/i, 'Link sem vídeo'],
    [/grande demais/i, 'Grande demais'],
    [/limitou/i, 'Limite do site, tente depois'],
    [/recusou/i, 'Recusado, tente depois'],
    [/sem conexão/i, 'Sem conexão'],
    [/ffmpeg/i, 'Faltou o ffmpeg'],
    [/formato/i, 'Formato indisponível'],
    [/coleção não existe/i, 'Coleção apagada'],
    [/não deu para salvar/i, 'Não deu para salvar'],
    [/não deu para baixar/i, 'Não deu para baixar'],
  ]
  for (const [re, curto] of regras) if (re.test(t)) return curto
  const first = t.split(/[:.]/)[0].replace(/^(?:O|A) /, '').trim()
  if (first.length <= 28) return first || 'Não baixou'
  const cut = first.slice(0, 28)
  return `${cut.slice(0, cut.lastIndexOf(' ') > 12 ? cut.lastIndexOf(' ') : 27).trimEnd()}…`
}
