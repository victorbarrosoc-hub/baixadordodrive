// Miniaturas e prévia dos arquivos do Drive, servidas pelo servidor local.
//
// Por que passa por aqui e não direto do Google para a tela:
//  - O `thumbnailLink` do Drive é curto (expira em horas) e, para arquivos privados, só abre com o token da conta.
//    O servidor busca com o token certo (contas locais e `nuvem:`), guarda em cache (memória + disco, com teto)
//    e a tela usa um <img loading="lazy"> comum.
//  - O <video> do Chromium só consegue pular para um ponto do vídeo se o servidor aceitar Range. O stream repassa o
//    Range para `files/<id>?alt=media` com o token e devolve 206 com os cabeçalhos certos.
//
// Segurança: <img> e <video> não mandam cabeçalhos próprios, então as rotas exigem a chave de mídia (`k`, aleatória a
// cada vez que o app abre) que só a interface conhece (vem em /api/state, que nenhuma outra origem consegue ler).
// Pedido de outro site (Sec-Fetch-Site cross-site/same-site) é recusado mesmo com a chave, e as respostas levam
// Cross-Origin-Resource-Policy: same-origin. Conteúdo que não é vídeo/áudio/imagem sai como octet-stream com CSP
// sandbox: um HTML do Drive nunca roda com a origem do app.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { endpoints } from '../config.js'
import { httpRequest, drain } from '../net/http.js'
import { abortError } from '../util/backoff.js'
import { BROWSE_FIELDS, FOLDER_MIME, escapeQueryValue, toDriveItem } from '../google/drive.js'
import { HttpProblem, baseHeaders } from './routes.js'

// Proxy de câmera: o original (BRAW, R3D, MXF, ProRes…) não toca no Chromium, mas a câmera grava junto um arquivo leve
// com o mesmo nome-base (H.264/HEVC), na mesma pasta ou numa subpasta "Proxy" (Blackmagic: A001_…_C001.braw +
// Proxy/A001_…_C001.mp4). A prévia toca o proxy; o Baixar continua baixando o original.
const PROXY_EXT = ['.mp4', '.mov', '.m4v']
const PROXY_DIRS = new Set(['proxy', 'proxies'])
const PROXY_TTL_MS = 5 * 60_000

function splitExt(name) {
  const s = String(name || '')
  const i = s.lastIndexOf('.')
  return i > 0 ? [s.slice(0, i), s.slice(i).toLowerCase()] : [s, '']
}

/** Tamanhos pedidos ao Google (lado maior, em px). Pedidos no meio sobem para o próximo: o cache fica pequeno. */
export const THUMB_SIZES = Object.freeze([64, 128, 220, 320, 480, 640, 960, 1280, 1600, 2000])
const MAX_THUMB_BYTES = 8 * 1024 * 1024
const MEDIA_CSP = "default-src 'none'; sandbox"
const SAFE_MEDIA = /^(video|audio)\/[\w.+-]+$|^image\/(jpeg|png|gif|webp|avif|bmp|heic|heif|x-icon|vnd\.microsoft\.icon)$/i

export function thumbSize(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 220
  return THUMB_SIZES.find(s => s >= n) ?? THUMB_SIZES[THUMB_SIZES.length - 1]
}

/** `…=s220` → `…=s<size>` (o Google gera o tamanho pedido na hora). */
export function resizeThumbLink(link, size) {
  const s = String(link)
  if (/=s\d+(-[\w-]+)?$/.test(s)) return s.replace(/=s\d+(-[\w-]+)?$/, `=s${size}`)
  if (/=w\d+-h\d+[\w-]*$/.test(s)) return s.replace(/=w\d+-h\d+[\w-]*$/, `=s${size}`)
  return `${s}=s${size}`
}

/** Tipo da imagem pelos primeiros bytes (o Google às vezes manda octet-stream). */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.readUInt32BE(0) === 0x89504e47) return 'image/png'
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif'
  return null
}

/** Range simples do navegador: "bytes=a-b", "bytes=a-" ou "bytes=-n". Vários trechos ou lixo = sem Range. */
export function parseClientRange(header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] !== '' && m[2] !== '' && Number(m[2]) < Number(m[1])) return null
  return `bytes=${m[1]}-${m[2]}`
}

/** O token só vai para o Google (ou para o mesmo servidor da API, no Drive falso dos testes). */
function mayCarryToken(url) {
  const u = new URL(url)
  if (/(^|\.)(googleusercontent|googleapis|google)\.com$/i.test(u.hostname)) return u.protocol === 'https:'
  try {
    return u.host === new URL(endpoints().driveApi).host
  } catch {
    return false
  }
}

/** Fila simples: no máximo `max` ao mesmo tempo. */
class Gate {
  constructor(max) {
    this.max = max
    this.active = 0
    this.waiting = []
  }

  async run(fn, signal) {
    if (this.active >= this.max) {
      await new Promise((resolve, reject) => {
        const w = { resolve, reject }
        const onAbort = () => {
          const i = this.waiting.indexOf(w)
          if (i >= 0) this.waiting.splice(i, 1)
          reject(abortError(signal))
        }
        w.resolve = () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        this.waiting.push(w)
      })
    } else this.active++
    try {
      return await fn()
    } finally {
      const next = this.waiting.shift()
      if (next) next.resolve()
      else this.active--
    }
  }
}

/**
 * Cache das miniaturas: LRU na memória (teto em bytes) + pasta no disco (teto em bytes; saem as mais antigas).
 * A chave inclui a versão do arquivo (modifiedTime que a tela manda): arquivo novo = miniatura nova.
 */
export class ThumbCache {
  constructor({ dir = null, memoryBytes = 24 * 1024 * 1024, diskBytes = 256 * 1024 * 1024, log = () => {} } = {}) {
    this.dir = dir
    this.memoryBytes = memoryBytes
    this.diskBytes = diskBytes
    this.log = log
    this.mem = new Map() // key -> { buf, type }
    this.memSize = 0
    this.disk = null // Map key -> { size, at } (carregado na primeira vez)
    this.diskSize = 0
    this.diskReady = null
    this.pruning = null
  }

  static key(parts) {
    return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 40)
  }

  #fromMemory(key) {
    const hit = this.mem.get(key)
    if (!hit) return null
    this.mem.delete(key)
    this.mem.set(key, hit) // mais recente
    return hit
  }

  #toMemory(key, entry) {
    const old = this.mem.get(key)
    if (old) this.memSize -= old.buf.length
    this.mem.delete(key)
    this.mem.set(key, entry)
    this.memSize += entry.buf.length
    for (const [k, v] of this.mem) {
      if (this.memSize <= this.memoryBytes || this.mem.size <= 1) break
      this.mem.delete(k)
      this.memSize -= v.buf.length
    }
  }

  async #loadDisk() {
    if (!this.dir) return
    this.diskReady ??= (async () => {
      this.disk = new Map()
      let names = []
      try {
        await fs.mkdir(this.dir, { recursive: true })
        names = await fs.readdir(this.dir)
      } catch (err) {
        this.log('cache de miniaturas indisponível:', err?.code || err?.message)
        this.dir = null
        return
      }
      for (const name of names) {
        if (!/^[0-9a-f]{40}\.img$/.test(name)) continue
        try {
          const st = await fs.stat(path.join(this.dir, name))
          this.disk.set(name.slice(0, 40), { size: st.size, at: st.mtimeMs })
          this.diskSize += st.size
        } catch {}
      }
    })()
    await this.diskReady
  }

  async get(key) {
    const m = this.#fromMemory(key)
    if (m) return { ...m, source: 'memory' }
    await this.#loadDisk()
    if (!this.dir || !this.disk?.has(key)) return null
    const file = path.join(this.dir, `${key}.img`)
    try {
      const buf = await fs.readFile(file)
      const type = sniffImage(buf)
      if (!type) throw new Error('arquivo estragado')
      const now = Date.now()
      this.disk.get(key).at = now
      fs.utimes(file, new Date(now), new Date(now)).catch(() => {})
      const entry = { buf, type }
      this.#toMemory(key, entry)
      return { ...entry, source: 'disk' }
    } catch {
      this.#forget(key)
      return null
    }
  }

  async put(key, entry) {
    this.#toMemory(key, entry)
    await this.#loadDisk()
    if (!this.dir) return
    const file = path.join(this.dir, `${key}.img`)
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    try {
      await fs.writeFile(tmp, entry.buf)
      await fs.rename(tmp, file)
      const prev = this.disk.get(key)
      if (prev) this.diskSize -= prev.size
      this.disk.set(key, { size: entry.buf.length, at: Date.now() })
      this.diskSize += entry.buf.length
    } catch (err) {
      fs.rm(tmp, { force: true }).catch(() => {})
      this.log('não consegui gravar a miniatura:', err?.code || err?.message)
      return
    }
    if (this.diskSize > this.diskBytes) await this.prune()
  }

  #forget(key) {
    const d = this.disk?.get(key)
    if (!d) return
    this.disk.delete(key)
    this.diskSize -= d.size
    if (this.dir) fs.rm(path.join(this.dir, `${key}.img`), { force: true }).catch(() => {})
  }

  /** Apaga as menos usadas até ficar em 80% do teto. */
  async prune() {
    this.pruning ??= (async () => {
      const target = this.diskBytes * 0.8
      const order = [...this.disk.entries()].sort((a, b) => a[1].at - b[1].at)
      for (const [key] of order) {
        if (this.diskSize <= target) break
        this.#forget(key)
      }
    })().finally(() => (this.pruning = null))
    return this.pruning
  }

  stats() {
    return { memoryItems: this.mem.size, memoryBytes: this.memSize, diskItems: this.disk?.size ?? 0, diskBytes: this.diskSize }
  }
}

/**
 * Miniaturas e stream. Pendurado no contexto do servidor (ctx.media).
 * @param {object} ctx { manager, auth, paths, log }
 */
export class MediaService {
  constructor(ctx, { concurrency = 6, linkTtlMs = 30 * 60_000, memoryBytes, diskBytes } = {}) {
    this.ctx = ctx
    this.key = crypto.randomBytes(24).toString('base64url')
    this.cache = new ThumbCache({ dir: ctx.paths?.thumbs ?? null, memoryBytes, diskBytes, log: ctx.log || (() => {}) })
    this.gate = new Gate(concurrency)
    this.linkTtlMs = linkTtlMs
    this.links = new Map() // `${acc}\n${id}` -> { link, hasThumbnail, at }
    this.inflight = new Map()
    this.proxyDirs = new Map() // `${acc}\n${pasta}` -> { ids, at }   (subpastas Proxy de cada pasta)
    this.proxies = new Map() // `${acc}\n${arquivo}` -> { item|null, at }
    this.counters = { google: 0, metadata: 0, memory: 0, disk: 0, streams: 0, proxyQueries: 0 }
  }

  async #query(drive, q, driveId, signal) {
    this.counters.proxyQueries++
    const query = { q, fields: `files(${BROWSE_FIELDS})`, pageSize: 100, includeItemsFromAllDrives: 'true', supportsAllDrives: 'true' }
    if (driveId) Object.assign(query, { corpora: 'drive', driveId })
    const r = await drive.api('GET', 'files', { query, signal })
    return (r.files || []).map(toDriveItem)
  }

  /**
   * Proxy de câmera do arquivo `id`: mesmo nome-base com .mp4/.mov/.m4v na mesma pasta ou numa subpasta irmã
   * Proxy/Proxies. Uma consulta pelas subpastas (cache por pasta) e uma pelo nome (cache por arquivo).
   * Devolve DriveItem (com campos de prévia) ou null.
   */
  async findProxy(accountId, id, { resourceKey = null, signal } = {}) {
    const key = `${accountId}\n${id}`
    const hit = this.proxies.get(key)
    if (hit && Date.now() - hit.at < PROXY_TTL_MS) return hit.item
    const drive = this.ctx.manager.driveFor(accountId)
    const item = await drive.getItem(id, { signal, resourceKey: resourceKey || undefined })
    const parent = item.parents?.[0]
    const [base, ext] = splitExt(item.name)
    let found = null
    if (parent && base && !item.isFolder) {
      const dirKey = `${accountId}\n${parent}`
      let dirs = this.proxyDirs.get(dirKey)
      if (!dirs || Date.now() - dirs.at >= PROXY_TTL_MS) {
        const q = `'${escapeQueryValue(parent)}' in parents and mimeType = '${FOLDER_MIME}' and (name = 'Proxy' or name = 'Proxies') and trashed = false`
        const folders = await this.#query(drive, q, item.driveId, signal)
        dirs = { ids: folders.filter(f => PROXY_DIRS.has(f.name.trim().toLowerCase())).map(f => f.id), at: Date.now() }
        this.proxyDirs.set(dirKey, dirs)
      }
      const where = [parent, ...dirs.ids].map(p => `'${escapeQueryValue(p)}' in parents`).join(' or ')
      const q = `(${where}) and name contains '${escapeQueryValue(base)}' and trashed = false`
      const want = base.normalize('NFC').toLowerCase()
      const candidates = (await this.#query(drive, q, item.driveId, signal)).filter(c => {
        const [b, e] = splitExt(c.name)
        return c.id !== item.id && !c.isFolder && c.canDownload && PROXY_EXT.includes(e) && b.normalize('NFC').toLowerCase() === want && !(e === ext && c.parents?.[0] === parent)
      })
      // Subpasta Proxy primeiro (é o que a câmera grava), depois .mp4 antes de .mov.
      const rank = c => (dirs.ids.includes(c.parents?.[0]) ? 0 : 2) + (splitExt(c.name)[1] === '.mp4' ? 0 : 1)
      candidates.sort((a, b) => rank(a) - rank(b))
      found = candidates[0] ?? null
    }
    this.proxies.set(key, { item: found, at: Date.now() })
    if (found) this.remember(accountId, [found])
    if (this.proxies.size > 5000) this.proxies.delete(this.proxies.keys().next().value)
    return found
  }

  /** Recusa pedido sem a chave da interface ou vindo de outro site. */
  check(req, query) {
    const site = String(req.headers['sec-fetch-site'] || '').toLowerCase()
    if (site === 'cross-site' || site === 'same-site') throw new HttpProblem(403, 'Origem não permitida.')
    const given = Buffer.from(String(query.get('k') || ''))
    const want = Buffer.from(this.key)
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new HttpProblem(403, 'Acesso negado.')
  }

  /** Guarda os links de miniatura que a listagem já trouxe (evita uma consulta por arquivo). */
  remember(accountId, items) {
    const now = Date.now()
    for (const it of items || []) {
      if (!it?.id || it.hasThumbnail === undefined) continue
      this.links.set(`${accountId}\n${it.id}`, { link: it.thumbnailLink || null, hasThumbnail: !!it.hasThumbnail, at: now })
    }
    if (this.links.size > 20_000) {
      let drop = 5000
      for (const k of this.links.keys()) {
        if (drop-- <= 0) break
        this.links.delete(k)
      }
    }
  }

  /** Esquece o que sabe da miniatura destes arquivos (ganharam uma nova: "Gerar miniaturas"). */
  forget(accountId, ids) {
    for (const id of ids || []) this.links.delete(`${accountId}\n${id}`)
  }

  async #link(accountId, id, { resourceKey, signal, fresh = false }) {
    const k = `${accountId}\n${id}`
    const hit = this.links.get(k)
    if (hit && !fresh && Date.now() - hit.at < this.linkTtlMs) return { ...hit, cached: true }
    this.counters.metadata++
    const item = await this.ctx.manager.driveFor(accountId).getItem(id, { signal, resourceKey: resourceKey || undefined, media: true })
    this.remember(accountId, [item])
    return { link: item.thumbnailLink || null, hasThumbnail: !!item.hasThumbnail, cached: false }
  }

  async #fetchImage(accountId, link, size, signal) {
    const url = resizeThumbLink(link, size)
    const drive = this.ctx.manager.driveFor(accountId)
    const carry = mayCarryToken(url)
    for (let attempt = 0; ; attempt++) {
      const headers = carry ? await drive.authHeader({ forceRefresh: attempt > 0 }) : {}
      try {
        const res = await httpRequest(url, { headers, signal, expect: [200] })
        const chunks = []
        let total = 0
        for await (const chunk of res.body) {
          total += chunk.length
          if (total > MAX_THUMB_BYTES) {
            res.body.destroy()
            throw new HttpProblem(502, 'Miniatura grande demais.')
          }
          chunks.push(chunk)
        }
        const buf = Buffer.concat(chunks)
        const type = sniffImage(buf)
        if (!type) throw new HttpProblem(502, 'O Google não mandou uma imagem.')
        return { buf, type }
      } catch (err) {
        if (err?.status === 401 && carry && attempt === 0) continue
        throw err
      }
    }
  }

  /**
   * Miniatura (do cache ou do Google). Devolve { buf, type, source: 'memory'|'disk'|'google' }.
   * Sem miniatura → HttpProblem 404.
   */
  async thumb({ accountId, id, size, version = '', resourceKey = null, signal }) {
    const s = thumbSize(size)
    const key = ThumbCache.key([accountId, id, String(s), String(version || '')])
    const cached = await this.cache.get(key)
    if (cached) {
      this.counters[cached.source]++
      return cached
    }
    let p = this.inflight.get(key)
    if (!p) {
      // O pedido de quem chegou primeiro não pode cancelar o dos outros: roda sem o signal de ninguém.
      const ac = new AbortController()
      p = this.gate
        .run(async () => {
          let info = await this.#link(accountId, id, { resourceKey, signal: ac.signal })
          if (!info.hasThumbnail || !info.link) throw new HttpProblem(404, 'Este arquivo não tem miniatura.')
          let img
          try {
            img = await this.#fetchImage(accountId, info.link, s, ac.signal)
          } catch (err) {
            // Link vencido (403/404/410): pede um novo ao Drive e tenta uma vez.
            if (!info.cached || ![403, 404, 410].includes(err?.status)) throw err
            info = await this.#link(accountId, id, { resourceKey, signal: ac.signal, fresh: true })
            if (!info.hasThumbnail || !info.link) throw new HttpProblem(404, 'Este arquivo não tem miniatura.')
            img = await this.#fetchImage(accountId, info.link, s, ac.signal)
          }
          this.counters.google++
          await this.cache.put(key, img)
          return img
        })
        .finally(() => this.inflight.delete(key))
      this.inflight.set(key, p)
    }
    const img = await abortableWait(p, signal)
    return { ...img, source: 'google' }
  }

  /** Repassa o arquivo do Drive para o <video>/<audio>/<img>, com Range. Escreve direto em `res`. */
  async stream({ req, res, accountId, id, resourceKey = null, signal }) {
    const drive = this.ctx.manager.driveFor(accountId)
    const range = parseClientRange(req.headers.range)
    const extra = resourceKey ? { 'x-goog-drive-resource-keys': `${id}/${resourceKey}` } : {}
    if (range) extra.range = range
    let upstream
    for (let attempt = 0; ; attempt++) {
      const auth = await drive.authHeader({ forceRefresh: attempt > 0 })
      try {
        upstream = await httpRequest(drive.mediaUrl(id), { headers: { ...extra, ...auth }, signal, expect: [200, 206, 416] })
        break
      } catch (err) {
        if (err?.status === 401 && attempt === 0) continue
        throw err
      }
    }
    this.counters.streams++
    // Cancelar no meio (a tela pulou para outro ponto) faz o corpo emitir AbortError depois: não pode virar exceção solta.
    upstream.body.on('error', () => {})
    const h = upstream.headers
    const rawType = String(h['content-type'] || '').split(';')[0].trim().toLowerCase()
    const headers = baseHeaders({
      'content-type': SAFE_MEDIA.test(rawType) ? rawType : 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-disposition': 'inline',
      'content-security-policy': MEDIA_CSP,
    })
    if (h['content-length'] != null) headers['content-length'] = h['content-length']
    if (h['content-range'] != null) headers['content-range'] = h['content-range']
    const status = upstream.status === 206 && !range ? 200 : upstream.status
    if (upstream.status === 416) {
      await drain(upstream.body)
      res.writeHead(416, baseHeaders({ 'content-range': h['content-range'] || 'bytes */*', 'content-length': 0, 'cache-control': 'no-store' }))
      return res.end()
    }
    res.writeHead(status, headers)
    if (req.method === 'HEAD') {
      upstream.body.destroy()
      return res.end()
    }
    try {
      await pipeline(upstream.body, res)
    } catch {
      // A tela fechou ou pulou para outro ponto do vídeo: normal.
      upstream.body.destroy()
      if (!res.writableEnded) res.destroy()
    }
  }

  stats() {
    return { ...this.counters, cache: this.cache.stats(), inflight: this.inflight.size }
  }
}

function abortableWait(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(abortError(signal))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {})
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      v => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      e => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}
