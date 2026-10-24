// Dados do Drive para as telas: listagem de pastas (com cache para voltar rápido), busca, drives compartilhados,
// "Compartilhados comigo" e as escritas do menu de contexto (renomear, mover).
import { useEffect, useRef, useState, useCallback } from '/vendor/preact-htm.js'
import { api, enc, withQuery } from '../lib/api.js'

/**
 * "Compartilhados comigo" é um lugar, não uma pasta: o id de mentira abre a lista do /compartilhados (rota
 * `#/drive/compartilhados`). Nenhum id do Drive é assim (os de verdade têm 19 ou mais caracteres).
 */
export const SHARED_ID = 'compartilhados'
export const SHARED_NAME = 'Compartilhados comigo'
export const SHARED_URL = 'https://drive.google.com/drive/shared-with-me'

const listCache = new Map() // `${acc}:${folderId}` -> { folder, path, items, at }
const drivesCache = new Map() // acc -> drives[]

export function invalidateFolder(accountId, folderId) {
  listCache.delete(`${accountId}:${folderId}`)
}

/** Esquece todas as pastas desta conta (ex.: miniaturas novas em várias subpastas). */
export function invalidateAccount(accountId) {
  for (const k of listCache.keys()) if (k.startsWith(`${accountId}:`)) listCache.delete(k)
}

/** Lista uma pasta. Mostra o cache na hora e atualiza por trás (stale-while-revalidate). */
export function useDriveFolder(accountId, folderId) {
  const key = `${accountId}:${folderId}`
  const cached = listCache.get(key)
  const [state, setState] = useState(() => ({ data: cached || null, loading: !cached, error: null, key }))
  const seq = useRef(0)

  const load = useCallback(
    async (force = false) => {
      if (!accountId || !folderId) return
      const my = ++seq.current
      const hit = listCache.get(key)
      setState({ data: hit || null, loading: !hit || force, error: null, key })
      try {
        const data =
          folderId === SHARED_ID
            ? await sharedWithMe(accountId)
            : await api.get(withQuery(`/api/drive/${enc(accountId)}/list`, { folderId })).then((res) => ({ folder: res.folder, path: res.path || [], items: res.items || [], at: Date.now() }))
        listCache.set(key, data)
        if (my === seq.current) setState({ data, loading: false, error: null, key })
      } catch (err) {
        if (my === seq.current) setState({ data: hit || null, loading: false, error: err.message, errorStatus: err.status || 0, key })
      }
    },
    [key],
  )

  useEffect(() => {
    load()
  }, [load])

  // enquanto a chave nova não carregou, não mostra dados da pasta antiga
  const fresh = state.key === key ? state : { data: listCache.get(key) || null, loading: true, error: null }
  return { ...fresh, reload: () => load(true) }
}

/** A raiz de "Compartilhados comigo" no formato de uma pasta listada (só leitura: não dá para pôr nada ali). */
async function sharedWithMe(accountId) {
  const res = await api.get(`/api/drive/${enc(accountId)}/compartilhados`)
  const folder = { id: SHARED_ID, name: SHARED_NAME, isFolder: true, virtual: true, driveId: null, canAddChildren: false, webViewLink: SHARED_URL }
  return { folder, path: [{ id: SHARED_ID, name: SHARED_NAME }], items: res.items || [], at: Date.now() }
}

/**
 * A pasta aberta está em "Compartilhados comigo"? O caminho começa numa pasta que não é o Meu Drive nem um drive
 * compartilhado (o pai dela a conta não enxerga).
 */
export function isSharedTree(data, drives) {
  const first = data?.path?.[0]?.id
  if (!first || data?.folder?.driveId) return false
  return first === SHARED_ID || (first !== 'root' && !drives?.some((d) => d.id === first))
}

/** Trilha para mostrar: "Meu Drive", o nome do drive compartilhado ou "Compartilhados comigo" no começo. */
export function crumbsFor(data, drives) {
  let list = (data?.path || []).slice()
  const folder = data?.folder
  if (folder && (!list.length || list[list.length - 1].id !== folder.id)) list.push({ id: folder.id, name: folder.name })
  if (!list.length) return [{ id: 'root', name: 'Meu Drive' }]
  if (list[0].id !== SHARED_ID && isSharedTree(data, drives)) list = [{ id: SHARED_ID, name: SHARED_NAME }, ...list]
  return list.map((c, i) => {
    if (i !== 0) return c
    const shared = drives?.find((d) => d.id === c.id)
    return { ...c, name: shared ? shared.name : c.id === 'root' ? 'Meu Drive' : c.name }
  })
}

/** Renomeia um item do Drive. A lista da pasta é esquecida (volta com o nome novo). */
export async function renameDriveItem(accountId, item, name, parentId) {
  const res = await api.post(`/api/drive/${enc(accountId)}/renomear`, { id: item.id, name })
  if (parentId) invalidateFolder(accountId, parentId)
  invalidateFolder(accountId, item.id)
  return res.item
}

/** Move itens para a pasta `destId`: { movidos, ja, recusados }. As listas de origem e destino são esquecidas. */
export async function moveDriveItems(accountId, ids, destId, fromId) {
  const res = await api.post(`/api/drive/${enc(accountId)}/mover`, { ids, destId })
  invalidateFolder(accountId, destId)
  if (fromId) invalidateFolder(accountId, fromId)
  // As pastas movidas mudaram de caminho (o breadcrumb guardado ficou velho).
  for (const id of res.movidos || []) invalidateFolder(accountId, id)
  return res
}

export function useSharedDrives(accountId) {
  const [drives, setDrives] = useState(() => drivesCache.get(accountId) || [])
  useEffect(() => {
    if (!accountId) return undefined
    let alive = true
    setDrives(drivesCache.get(accountId) || [])
    api
      .get(`/api/drive/${enc(accountId)}/drives`)
      .then((res) => {
        drivesCache.set(accountId, res.drives || [])
        if (alive) setDrives(res.drives || [])
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [accountId])
  return drives
}

export function useDriveSearch(accountId, q) {
  const [state, setState] = useState({ items: null, loading: false, error: null })
  useEffect(() => {
    const term = (q || '').trim()
    if (!term || !accountId) {
      setState({ items: null, loading: false, error: null })
      return undefined
    }
    let alive = true
    setState((s) => ({ ...s, loading: true, error: null }))
    api
      .get(withQuery(`/api/drive/${enc(accountId)}/search`, { q: term }))
      .then((res) => alive && setState({ items: res.items || [], loading: false, error: null }))
      .catch((err) => alive && setState({ items: [], loading: false, error: err.message }))
    return () => {
      alive = false
    }
  }, [accountId, q])
  return state
}

/** Pastas pelo nome no Drive todo do escopo ('root' = Meu Drive, ou o id de um drive compartilhado). */
export function useFolderSearch(accountId, q, escopo = 'root') {
  const [state, setState] = useState({ items: null, loading: false, error: null })
  useEffect(() => {
    const term = (q || '').trim()
    if (!term || !accountId) {
      setState({ items: null, loading: false, error: null })
      return undefined
    }
    let alive = true
    setState((s) => ({ ...s, loading: true, error: null }))
    api
      .get(withQuery(`/api/drive/${enc(accountId)}/pastas`, { q: term, escopo }))
      .then((res) => alive && setState({ items: res.items || [], loading: false, error: null }))
      .catch((err) => alive && setState({ items: [], loading: false, error: err.message }))
    return () => {
      alive = false
    }
  }, [accountId, q, escopo])
  return state
}

export async function createDriveFolder(accountId, parentId, name) {
  const res = await api.post(`/api/drive/${enc(accountId)}/folders`, { parentId, name })
  invalidateFolder(accountId, parentId)
  return res.item
}

export function useAbout(accountId, enabled = true) {
  const [about, setAbout] = useState(null)
  useEffect(() => {
    if (!accountId || !enabled) return undefined
    let alive = true
    api
      .get(`/api/drive/${enc(accountId)}/about`)
      .then((res) => alive && setAbout(res.about || null))
      .catch(() => alive && setAbout(null))
    return () => {
      alive = false
    }
  }, [accountId, enabled])
  return about
}
