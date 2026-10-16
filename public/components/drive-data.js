// Dados do Drive para as telas: listagem de pastas (com cache para voltar rápido), busca e drives compartilhados.
import { useEffect, useRef, useState, useCallback } from '/vendor/preact-htm.js'
import { api, enc, withQuery } from '../lib/api.js'

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
        const res = await api.get(withQuery(`/api/drive/${enc(accountId)}/list`, { folderId }))
        const data = { folder: res.folder, path: res.path || [], items: res.items || [], at: Date.now() }
        listCache.set(key, data)
        if (my === seq.current) setState({ data, loading: false, error: null, key })
      } catch (err) {
        if (my === seq.current) setState({ data: hit || null, loading: false, error: err.message, key })
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
