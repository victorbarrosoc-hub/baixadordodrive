// Pastas de destino do envio que se repetem: as últimas 5 de cada conta (seletor "Para qual pasta do Drive?") e a
// pasta onde o seletor abre. Fica neste navegador/computador (localStorage), como o resto das preferências da tela.
// Sem dependência do navegador: quem chama passa o `store` ({ get(key, fallback), set(key, value) }, o `storage` de
// lib/ui.js) — assim dá para testar no Node.

export const MAX_RECENTES = 5
const KEY = 'drive.destinos'
const MAX_CONTAS = 20
const ID = /^[\w-]{1,200}$/

function limpa(d) {
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !ID.test(d.id)) return null
  const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 255) : d.id === 'root' ? 'Meu Drive' : null
  if (!name) return null
  return {
    id: d.id,
    name,
    driveId: typeof d.driveId === 'string' && ID.test(d.driveId) ? d.driveId : null,
    path: typeof d.path === 'string' && d.path.trim() ? d.path.trim().slice(0, 1000) : null,
    at: Number.isFinite(d.at) ? d.at : 0,
  }
}

function todas(store) {
  const all = store.get(KEY, null)
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
}

/** As últimas pastas de destino desta conta, da mais recente para a mais antiga (no máximo 5). */
export function recentes(store, accountId) {
  if (!accountId) return []
  const list = todas(store)[accountId]
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const raw of list) {
    const d = limpa(raw)
    if (!d || seen.has(d.id)) continue
    seen.add(d.id)
    out.push(d)
    if (out.length >= MAX_RECENTES) break
  }
  return out
}

/** Um envio foi para `dest` ({ id, name, driveId, path }): vai para o topo dos recentes da conta. */
export function lembrarDestino(store, accountId, dest, now = Date.now()) {
  const d = limpa({ ...dest, at: now })
  if (!accountId || !d) return recentes(store, accountId)
  const all = todas(store)
  const list = [d, ...recentes(store, accountId).filter((x) => x.id !== d.id)].slice(0, MAX_RECENTES)
  const next = { ...all, [accountId]: list }
  // Conta que saiu há tempos não guarda lixo para sempre: ficam as que enviaram por último.
  const contas = Object.keys(next)
  if (contas.length > MAX_CONTAS) {
    const ult = (id) => Math.max(0, ...(Array.isArray(next[id]) ? next[id].map((x) => x?.at || 0) : [0]))
    for (const id of contas.sort((a, b) => ult(a) - ult(b)).slice(0, contas.length - MAX_CONTAS)) delete next[id]
  }
  store.set(KEY, next)
  return list
}

/** A pasta sumiu (apagada, sem acesso): sai dos recentes. */
export function esquecerDestino(store, accountId, id) {
  const all = todas(store)
  if (!accountId || !Array.isArray(all[accountId])) return recentes(store, accountId)
  const list = recentes(store, accountId).filter((x) => x.id !== id)
  store.set(KEY, { ...all, [accountId]: list })
  return list
}

/**
 * Onde o seletor de destino abre: a última pasta usada como destino nesta conta; sem nenhuma, a última pasta aberta
 * na tela Drive desta conta (`drive.last`); senão, Meu Drive.
 */
export function pastaInicial(store, accountId) {
  const r = recentes(store, accountId)[0]
  if (r) return r
  const last = store.get('drive.last', null)
  if (last && last.accountId === accountId) {
    const d = limpa(last)
    if (d) return d
  }
  return { id: 'root', name: 'Meu Drive', driveId: null, path: 'Meu Drive', at: 0 }
}
