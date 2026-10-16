// Sessões de upload guardadas no IndexedDB, para retomar depois de recarregar a página.
// Chave: nome + tamanho + data de modificação + pasta de destino. Sem IndexedDB (modo privado antigo), fica em memória.

const DB_NAME = 'sobedesce'
const STORE = 'uploads'
const memory = new Map()
let dbPromise = null

function open() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' })
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function run(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve(fn(null)?.result)
        try {
          const tx = db.transaction(STORE, mode)
          const req = fn(tx.objectStore(STORE))
          tx.oncomplete = () => resolve(req?.result)
          tx.onerror = () => resolve(undefined)
          tx.onabort = () => resolve(undefined)
        } catch {
          resolve(fn(null)?.result)
        }
      }),
  )
}

export function sessionKey({ name, size, lastModified }, folderId) {
  return `${name}\u0000${size}\u0000${lastModified}\u0000${folderId}`
}

export function getRecord(key) {
  return run('readonly', (s) => (s ? s.get(key) : { result: memory.get(key) }))
}

export function putRecord(rec) {
  memory.set(rec.key, rec)
  return run('readwrite', (s) => (s ? s.put(rec) : null))
}

export function deleteRecord(key) {
  memory.delete(key)
  return run('readwrite', (s) => (s ? s.delete(key) : null))
}

export function allRecords() {
  return run('readonly', (s) => (s ? s.getAll() : { result: [...memory.values()] })).then((r) => r || [])
}
