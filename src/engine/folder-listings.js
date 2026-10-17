// Nomes que já existem nas pastas de destino do envio: UMA listagem por pasta em vez de um files.list por arquivo.
//
// Por que é assim:
//  - Antes de cada envio o motor procurava um arquivo com o mesmo nome (findChild = 1 files.list, 100 unidades de
//    cota). Com milhares de arquivos pequenos, isso era metade das requisições e esbarrava no limitador de 20 req/s.
//  - Aqui cada pasta é listada uma vez (por conta, compartilhada entre os lotes) e a pergunta "tem alguém com esse
//    nome?" vira consulta local. Pasta que o próprio app acabou de criar nasce vazia: nem lista.
//  - Arquivo que o app cria entra na listagem na hora (dois envios com o mesmo nome continuam se enxergando, no
//    mesmo lote ou em lotes diferentes). O que OUTRA pessoa cria só aparece na próxima listagem: por isso ela vale
//    10 min. A listagem só responde "não tem": quando tem, quem decide é uma busca nova (findChild), então pular,
//    substituir ou renomear continuam exatamente como eram.
//  - Pasta enorme (mais de 5.000 itens) não é listada inteira: responde "não sei" e o envio procura como antes.
import { abortError } from '../util/backoff.js'
import { toNFC } from '../util/paths.js'

export const LISTING_TTL_MS = 10 * 60_000
export const LISTING_MAX_ITEMS = 5000
const SWEEP_AT = 256 // pastas guardadas antes de jogar fora as vencidas (o app fica aberto por dias)

const noop = () => {}

export class FolderListings {
  /** @param {{ ttlMs?: number, maxItems?: number, now?: () => number }} [opts] */
  constructor({ ttlMs = LISTING_TTL_MS, maxItems = LISTING_MAX_ITEMS, now = Date.now } = {}) {
    this.ttlMs = ttlMs
    this.maxItems = maxItems
    this.now = now
    /** @type {Map<string, { at: number, names: Set<string>|null, extra: Set<string>, p: Promise|null, ac: AbortController|null, waiters: number, settled: boolean }>} */
    this.map = new Map()
    this.counters = { listings: 0, hits: 0, seeded: 0 }
  }

  /**
   * Existe arquivo (não pasta) com exatamente esse nome (NFC) na pasta? true/false; null = não sei (pasta grande demais).
   * Erros da listagem sobem para quem perguntou (o envio trata como trataria o erro do findChild).
   */
  async has(drive, folderId, name, { signal, driveId } = {}) {
    if (signal?.aborted) throw abortError(signal)
    const wanted = toNFC(name)
    let e = this.map.get(folderId)
    if (e && e.settled && this.now() - e.at > this.ttlMs) {
      this.map.delete(folderId)
      e = null
    }
    if (!e) e = this.#fetch(drive, folderId, driveId)
    else this.counters.hits++
    const names = e.settled ? e.names : await this.#join(folderId, e, signal)
    if (!names) return null
    return names.has(wanted) || e.extra.has(wanted)
  }

  /** Pasta que o app acabou de criar: está vazia (sem listar). */
  created(folderId) {
    if (!folderId) return
    this.#sweep()
    this.counters.seeded++
    this.map.set(folderId, { at: this.now(), names: new Set(), extra: new Set(), p: null, ac: null, waiters: 0, settled: true })
  }

  /** O app criou um arquivo com esse nome na pasta: as próximas consultas já enxergam. */
  added(folderId, name) {
    const e = this.map.get(folderId)
    if (!e || !name) return
    e.extra.add(toNFC(name))
  }

  /** Esquece a pasta (ex.: ela foi apagada no Drive). */
  forget(folderId) {
    const e = this.map.get(folderId)
    if (!e) return
    this.map.delete(folderId)
    if (!e.settled) e.ac?.abort()
  }

  #sweep() {
    if (this.map.size < SWEEP_AT) return
    const now = this.now()
    for (const [id, e] of this.map) if (e.settled && now - e.at > this.ttlMs) this.map.delete(id)
  }

  #fetch(drive, folderId, driveId) {
    this.#sweep()
    this.counters.listings++
    // A listagem é compartilhada: não usa o signal de quem pediu primeiro (a pausa dele não pode derrubar os outros).
    // Ela só é cancelada quando todos que esperavam desistiram.
    const ac = new AbortController()
    const e = { at: this.now(), names: null, extra: new Set(), p: null, ac, waiters: 0, settled: false }
    e.p = drive.listChildren(folderId, { signal: ac.signal, driveId, limit: this.maxItems + 1 }).then(
      items => {
        e.settled = true
        e.ac = null
        if (items.length > this.maxItems) return null
        const names = new Set()
        for (const it of items) if (!it.isFolder) names.add(toNFC(it.name))
        e.names = names
        return names
      },
      err => {
        e.settled = true
        e.ac = null
        if (this.map.get(folderId) === e) this.map.delete(folderId) // a próxima pergunta lista de novo
        throw err
      },
    )
    e.p.catch(noop)
    this.map.set(folderId, e)
    return e
  }

  async #join(folderId, e, signal) {
    e.waiters++
    try {
      return await abortable(e.p, signal)
    } finally {
      e.waiters--
      if (e.waiters === 0 && !e.settled) {
        // Ninguém mais espera (todos pausaram): quem chegar depois lista de novo.
        if (this.map.get(folderId) === e) this.map.delete(folderId)
        e.ac?.abort()
      }
    }
  }
}

function abortable(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      v => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      err => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}
