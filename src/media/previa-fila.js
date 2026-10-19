// Fila da prévia leve: depois que um vídeo termina de subir, gera a cópia leve a partir do arquivo local e sobe em
// `Proxy/<nome>.mp4`, ao lado do original, com `appProperties { sobedesce: 'previa', original }`.
//
// Regras (docs/ARCHITECTURE.md, "media/previa-fila.js"):
//  - Só começa depois que o original terminou de subir; uma cópia por vez (a mesma vaga do "Gerar prévias" do Drive),
//    com prioridade baixa. Pausar tudo pausa a fila; retomar tudo volta.
//  - Se o original já tem proxy (da câmera ou de uma vez anterior) na mesma pasta ou em Proxy/Proxies, não faz nada.
//  - Falha da prévia nunca muda o status do envio: vira `record.previa = { estado: 'falhou', motivo }` e uma linha no log.
//  - O estado fica no próprio registro (vai para queue.json): o que estava na fila ou no meio volta depois de reabrir.
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { UploadTask } from '../engine/upload.js'
import { DownloadTask } from '../engine/download.js'
import { PART_SUFFIX, safeLocalName } from '../util/paths.js'
import { FOLDER_MIME, escapeQueryValue, toDriveItem } from '../google/drive.js'
import { abortError, isAbortError } from '../util/backoff.js'
import { newId } from '../util/ids.js'
import { PREVIA_MARCA, PREVIA_PASTA, detectarMotor, gerarPrevia, isProxyDirName, isProxyName, motorResumo, podeTerProxy, previaName, splitExt } from './previa.js'
import { QUADROS_MARCA, gerarQuadros, gradeTexto, quadrosName } from './quadros.js'

/** Estados que ainda vão andar (voltam para a fila ao reabrir o app). */
export const PREVIA_PENDENTE = Object.freeze(['fila', 'analisando', 'gerando', 'enviando', 'pausada'])
const PROXY_FIELDS = 'files(id,name,mimeType,size,parents,appProperties,capabilities(canDownload))'
const MOTOR_TTL_MS = 10 * 60_000 // "sem conversor" é conferido de novo depois disso (instalou o ffmpeg)

/** Espaço livre (bytes) no disco de `dir`, ou null. */
export async function espacoLivre(dir = os.tmpdir()) {
  try {
    const s = await fsp.statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/** Folga que sobra no disco depois de baixar um original para gerar o proxy (a cópia e o sistema precisam de espaço). */
export const FOLGA_BAIXAR = 1024 ** 3

/** É a nossa cópia leve? (appProperties.sobedesce === 'previa') */
export const isPrevia = item => item?.appProperties?.sobedesce === PREVIA_MARCA

async function query(drive, q, driveId, signal) {
  const params = { q, fields: PROXY_FIELDS, pageSize: 100, includeItemsFromAllDrives: 'true', supportsAllDrives: 'true' }
  if (driveId) Object.assign(params, { corpora: 'drive', driveId })
  const r = await drive.api('GET', 'files', { query: params, signal })
  return (r.files || []).map(f => ({ ...toDriveItem(f), appProperties: f.appProperties || null }))
}

/**
 * Proxy de um original no Drive: mesmo nome-base (.mp4/.mov/.m4v) na mesma pasta ou numa subpasta Proxy/Proxies.
 * Devolve { proxy: DriveItem|null (com appProperties), pastas: Array<{ id, name }> (as subpastas Proxy/Proxies) }.
 */
export async function procurarProxy(drive, { parentId, name, driveId = null, excludeId = null, signal } = {}) {
  const folders = await query(drive, `'${escapeQueryValue(parentId)}' in parents and mimeType = '${FOLDER_MIME}' and (name = 'Proxy' or name = 'Proxies') and trashed = false`, driveId, signal)
  const pastas = folders.filter(f => isProxyDirName(f.name)).map(f => ({ id: f.id, name: f.name }))
  // A pasta "Proxy" exata primeiro (é onde a cópia nova vai).
  pastas.sort((a, b) => (a.name === PREVIA_PASTA ? 0 : 1) - (b.name === PREVIA_PASTA ? 0 : 1))
  const where = [parentId, ...pastas.map(p => p.id)].map(p => `'${escapeQueryValue(p)}' in parents`).join(' or ')
  const base = splitExt(name)[0]
  const ext = splitExt(name)[1]
  const list = (await query(drive, `(${where}) and name contains '${escapeQueryValue(base)}' and trashed = false`, driveId, signal)).filter(c => {
    if (c.id === excludeId || c.isFolder || !isProxyName(c.name, name)) return false
    // O próprio original (outro arquivo com o mesmo nome e extensão na mesma pasta) não é proxy.
    return !(splitExt(c.name)[1] === ext && c.parents?.[0] === parentId)
  })
  const inProxy = c => pastas.some(p => p.id === c.parents?.[0])
  list.sort((a, b) => (inProxy(a) ? 0 : 2) + (splitExt(a.name)[1] === '.mp4' ? 0 : 1) - ((inProxy(b) ? 0 : 2) + (splitExt(b.name)[1] === '.mp4' ? 0 : 1)))
  return { proxy: list[0] ?? null, pastas }
}

/** Espera `p` ou o abort (o que vier primeiro). */
function waitAbortable(p, signal) {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      v => (signal.removeEventListener('abort', onAbort), resolve(v)),
      e => (signal.removeEventListener('abort', onAbort), reject(e)),
    )
  })
}

/**
 * Gera e sobe cópias leves. O TransferManager chama `enqueue(record, drive)` quando um envio de vídeo termina;
 * o "Gerar prévias" da tela Drive chama `gerarESubir` (a mesma vaga: uma conversão por vez no app inteiro).
 */
export class GeradorPrevias {
  /**
   * @param {object} opts
   * @param {{ get(): object }} [opts.settings] `proxyAoEnviar` (padrão de quem não escolheu) lido a cada uso
   * @param {Function} [opts.detect] troca o detectarMotor (testes)
   * @param {Function} [opts.gerar] troca o gerarPrevia (testes)
   * @param {(record, ctx) => { run(signal): Promise<void> }} [opts.createUpload] troca o UploadTask (testes)
   * @param {object} [opts.limiter] limitador de banda de envio (o mesmo dos envios)
   * @param {(record, { estado: boolean }) => void} [opts.onChange] o registro mudou (estado = mudou de fase)
   */
  constructor({ settings = null, log = () => {}, detect = detectarMotor, gerar = gerarPrevia, createUpload, createDownload = null, downloadOptions, limiter = null, downloadLimiter = null, onChange = null, tmpRoot = os.tmpdir(), retryBaseMs, selfCheck = true, espaco = espacoLivre } = {}) {
    this.settings = settings
    this.log = log
    this.detect = detect
    this.gerar = gerar
    this.createUpload = createUpload || ((rec, ctx) => new UploadTask(rec, ctx))
    this.createDownload = createDownload
    this.downloadOptions = downloadOptions
    this.downloadLimiter = downloadLimiter
    this.espaco = espaco
    this.limiter = limiter
    this.onChange = onChange
    this.tmpRoot = tmpRoot
    this.retryBaseMs = retryBaseMs
    this.selfCheck = selfCheck
    this.queue = [] // [{ record, drive }]
    this.current = null // { record, drive, ac, requeue }
    this.paused = false
    this.closing = false
    this.tail = Promise.resolve() // vaga única de conversão (fila + lote)
    this.motorP = null
    this.motorAt = 0
    this.last = null // { ok, motivo, name, at }
    this.pumping = null
    this.folderCache = new Map()
  }

  /** Padrão para quem não escolheu (envios antigos, celular, Comparar): só 'nunca' desliga. */
  padrao() {
    const s = this.settings?.get?.()
    return s ? s.proxyAoEnviar !== 'nunca' : true
  }

  /** Este envio quer proxy? A escolha do envio/arquivo (`record.proxy`) vale; sem ela, o ajuste. */
  quer(record) {
    return typeof record?.proxy === 'boolean' ? record.proxy : this.padrao()
  }

  /** Vídeo que pode ter proxy (pela extensão; .braw só com o Blackmagic RAW funcionando neste computador). */
  elegivel(record) {
    // Referências (vídeos salvos de redes sociais) não ganham proxy.
    if (!(record && record.type === 'upload' && !record.referencia && record.local?.path)) return false
    const name = record.name || record.local.path
    // Motor ainda sem resposta (app abrindo, fila restaurada): o .braw entra e o gerarPrevia decide.
    return this.motorResult ? podeTerProxy(name, this.motorResult) : podeTerProxy(name, { braw: { ok: true } })
  }

  /** Vale cópia leve para este envio? */
  wants(record) {
    return !this.closing && this.elegivel(record) && this.quer(record)
  }

  /** O que o computador tem para converter (em cache; "sem conversor" é conferido de novo a cada 10 min). */
  motor({ refresh = false } = {}) {
    const stale = this.motorP && this.motorAt && Date.now() - this.motorAt > MOTOR_TTL_MS
    if (refresh || !this.motorP || (stale && this.motorResult && !this.motorResult.via)) {
      this.motorAt = Date.now()
      this.motorResult = null
      this.motorP = Promise.resolve(this.detect())
        .catch(err => ({ via: null, aviso: `Não consegui verificar o conversor (${err?.message || err}).` }))
        .then(m => (this.motorResult = m))
    }
    return this.motorP
  }

  /** Verificação na abertura do app: uma linha no log do motor (motor.log no app de desktop). */
  init() {
    if (!this.selfCheck) return Promise.resolve(null)
    return this.motor().then(m => {
      console.log(`[motor] prévia leve: ${motorResumo(m)}`)
      return m
    })
  }

  #set(rec, patch, estado = true) {
    rec.previa = { ...(rec.previa || {}), ...patch, at: Date.now() }
    if (estado) {
      if (!('frac' in patch)) delete rec.previa.frac
      if (!('motivo' in patch)) delete rec.previa.motivo
    }
    try {
      this.onChange?.(rec, { estado })
    } catch {}
  }

  #has(rec) {
    return this.current?.record?.id === rec.id || this.queue.some(j => j.record.id === rec.id)
  }

  /**
   * Põe o envio na fila da prévia (não espera). `restore`: veio da fila gravada (reabriu o app).
   * `forcar`: pedido à mão ("Gerar proxy"): gera mesmo que o vídeo já seja leve.
   */
  enqueue(record, drive, { restore = false, forcar = false } = {}) {
    if (!this.wants(record) || !drive) return false
    if (!record.target?.fileId || !record.target?.parentId) return false
    if (this.#has(record)) return false
    if (restore && !PREVIA_PENDENTE.includes(record.previa?.estado)) return false
    this.queue.push({ record, drive, forcar: forcar || !!record.previa?.forcar })
    if (forcar) record.previa = { ...(record.previa || {}), forcar: true }
    this.#set(record, { estado: this.paused ? 'pausada' : 'fila' })
    this.#pump()
    return true
  }

  /** Pausar tudo: a conversão em andamento para (recomeça depois) e a fila espera. */
  pause() {
    if (this.paused) return
    this.paused = true
    for (const j of this.queue) this.#set(j.record, { estado: 'pausada' })
    if (this.current) {
      this.current.requeue = true
      this.current.ac.abort()
    }
  }

  resume() {
    if (!this.paused) return
    this.paused = false
    for (const j of this.queue) this.#set(j.record, { estado: 'fila' })
    this.#pump()
  }

  /** Pula a prévia destes envios (ids). */
  cancel(ids) {
    const set = new Set(Array.isArray(ids) ? ids : [ids])
    let n = 0
    this.queue = this.queue.filter(j => {
      if (!set.has(j.record.id)) return true
      this.#set(j.record, { estado: 'cancelada' })
      n++
      return false
    })
    if (this.current && set.has(this.current.record.id)) {
      this.current.requeue = false
      this.current.canceled = true
      this.current.ac.abort()
      n++
    }
    return n
  }

  #pump() {
    if (this.current || this.paused || this.closing || !this.queue.length) return
    const job = this.queue.shift()
    job.ac = new AbortController()
    job.requeue = false
    this.current = job
    const done = this.#slot(() => this.#process(job, job.ac.signal), job.ac.signal)
      .catch(err => {
        const rec = job.record
        if (job.ac.signal.aborted || isAbortError(err)) {
          if (job.requeue && !this.closing) {
            this.queue.unshift({ record: rec, drive: job.drive, forcar: job.forcar })
            this.#set(rec, { estado: this.paused ? 'pausada' : 'fila' })
          } else if (this.closing) {
            // Fecha o app: na próxima abertura volta para a fila (o estado gravado continua pendente).
            if (rec.previa) rec.previa.estado = 'fila'
          } else this.#set(rec, { estado: 'cancelada' })
          return
        }
        const motivo = String(err?.message || err || 'falhou').slice(0, 300)
        this.log(`prévia leve: "${rec.name}" ficou sem cópia leve (${motivo})`)
        this.last = { ok: false, motivo, name: rec.name, at: Date.now() }
        this.#set(rec, { estado: 'falhou', motivo })
      })
      .finally(() => {
        if (this.current === job) this.current = null
        this.#pump()
      })
    this.pumping = done
  }

  /** Vaga única de conversão (envios e lote). Desistir na espera não fura a fila. */
  async #slot(fn, signal) {
    const prev = this.tail
    let release
    this.tail = new Promise(r => (release = r))
    try {
      await waitAbortable(prev, signal)
    } catch (err) {
      prev.then(release)
      throw err
    }
    try {
      return await fn()
    } finally {
      release()
    }
  }

  async #process(job, signal) {
    const rec = job.record
    const drive = job.drive
    if (!this.quer(rec)) {
      delete rec.previa
      this.onChange?.(rec, { estado: true })
      return
    }
    const st = await fsp.stat(rec.local.path).catch(() => null)
    if (!st?.isFile()) return this.#set(rec, { estado: 'dispensada', motivo: 'o arquivo não está mais neste computador' })
    if ((rec.local.size != null && st.size !== rec.local.size) || (rec.local.mtimeMs != null && Math.abs(st.mtimeMs - rec.local.mtimeMs) >= 1)) {
      return this.#set(rec, { estado: 'dispensada', motivo: 'o arquivo mudou depois do envio' })
    }
    this.#set(rec, { estado: 'analisando' })
    const t = rec.target
    const found = await procurarProxy(drive, { parentId: t.parentId, name: rec.name, driveId: t.driveId, excludeId: t.fileId, signal })
    if (found.proxy) {
      return this.#set(rec, { estado: 'dispensada', motivo: isPrevia(found.proxy) ? 'já tinha prévia leve' : 'já tem o proxy da câmera', fileId: found.proxy.id })
    }
    const r = await this.#gerarESubir({
      drive,
      localPath: rec.local.path,
      name: rec.name,
      size: rec.size ?? st.size,
      parentId: t.parentId,
      driveId: t.driveId,
      originalId: t.fileId,
      pastas: found.pastas,
      forcar: job.forcar,
      signal,
      onFase: (estado, frac) => this.#set(rec, frac == null ? { estado } : { estado, frac }, rec.previa?.estado !== estado),
    })
    if (r.estado === 'pronta') {
      this.last = { ok: true, motivo: null, name: rec.name, at: Date.now() }
      this.log(`prévia leve: "${rec.name}" → ${PREVIA_PASTA}/${previaName(rec.name)} (${r.encoder})`)
      this.#set(rec, { estado: 'pronta', fileId: r.fileId, size: r.size, encoder: r.encoder })
    } else {
      this.#set(rec, { estado: 'dispensada', motivo: r.motivo })
    }
  }

  /**
   * Gera a cópia de `localPath` e sobe em <parentId>/Proxy (ou substitui `replaceFileId`). Usado pelo lote, na mesma
   * vaga da fila. Devolve { estado: 'pronta', fileId, size, encoder } | { estado: 'dispensada', motivo }.
   * Lança em falha (motivo na mensagem) e AbortError ao cancelar.
   */
  gerarESubir(opts) {
    return this.#slot(() => this.#gerarESubir(opts), opts.signal)
  }

  async #gerarESubir({ drive, localPath, name, size, parentId, driveId = null, originalId, pastas = null, replaceFileId = null, forcar = false, signal, onFase }) {
    const motor = await this.motor()
    if (signal?.aborted) throw abortError(signal)
    const g = await this.gerar(localPath, { motor, name, size, forcar, signal, tmpRoot: this.tmpRoot, log: this.log, onProgress: (fase, frac) => onFase?.(fase, frac) })
    if (g.estado !== 'pronta') return g
    try {
      onFase?.('enviando', 0)
      let folderId = null
      if (!replaceFileId) {
        pastas ??= (await procurarProxy(drive, { parentId, name, driveId, signal })).pastas
        folderId = pastas[0]?.id ?? (await drive.ensureFolderPath(parentId, PREVIA_PASTA, { signal, cache: this.folderCache, driveId }))
      }
      const fileId = await this.#subir(drive, {
        localPath: g.path,
        name: previaName(name),
        parentId: folderId || parentId,
        driveId,
        replaceFileId,
        appProperties: { sobedesce: PREVIA_MARCA, ...(originalId ? { original: originalId } : {}) },
        signal,
        onFrac: f => onFase?.('enviando', f),
      })
      // Tira de quadros (hover scrub) a partir do proxy que acabou de sair: nunca derruba o proxy.
      if (originalId) {
        await (async () => {
          // Refazendo um proxy (replaceFileId): a tira vai para a pasta dele, não para a do original.
          const pasta = folderId || (replaceFileId ? (await drive.getItem(replaceFileId, { signal }).catch(() => null))?.parents?.[0] : null) || parentId
          await this.#quadros(drive, { motor, proxyPath: g.path, proxyId: fileId, name, folderId: pasta, driveId, originalId, signal })
        })().catch(err => {
          if (signal?.aborted || isAbortError(err)) throw err
          this.log(`tira de quadros: "${name}" ficou sem (${err?.message || err})`)
        })
      }
      return { estado: 'pronta', fileId, size: g.size, encoder: g.encoder, motivo: g.motivo }
    } finally {
      await g.limpar?.()
    }
  }

  /** Sobe um arquivo gerado aqui (proxy, tira de quadros) com o UploadTask de sempre. Devolve o id no Drive. */
  async #subir(drive, { localPath, name, parentId, driveId = null, replaceFileId = null, appProperties, signal, onFrac }) {
    const st = await fsp.stat(localPath)
    const up = {
      id: newId('prv'),
      type: 'upload',
      status: 'running',
      name,
      size: st.size,
      bytesDone: 0,
      attempts: 0,
      note: null,
      verify: null,
      local: { path: localPath, size: st.size, mtimeMs: st.mtimeMs },
      target: { rootId: parentId, relDir: '', parentId, driveId, replaceFileId, fileId: null, appProperties },
      session: null,
    }
    let sent = 0
    const ctx = {
      drive,
      // Arquivo novo e temporário: sem MD5 (nada a conferir depois) e, se o nome existir, sobe ao lado.
      settings: { get: () => ({ ...(this.settings?.get?.() ?? {}), uploadConflict: 'rename', verifyChecksums: false }) },
      limiter: this.limiter,
      hasher: null,
      folderCache: this.folderCache,
      persist: () => {},
      onBytes: n => {
        sent += n
        onFrac?.(Math.min(0.999, sent / Math.max(1, st.size)))
      },
      log: this.log,
    }
    if (this.retryBaseMs != null) ctx.retryBaseMs = this.retryBaseMs
    const task = this.createUpload(up, ctx)
    await task.run(signal)
    if (!up.target.fileId) throw new Error(`o Drive não devolveu o arquivo "${name}"`)
    return up.target.fileId
  }

  /**
   * Tira de quadros de um proxy local (media/quadros.js): gera, sobe em `folderId` (substitui a anterior, se o original
   * já apontava para uma) e grava o endereço no original. Lança com motivo curto.
   */
  async #quadros(drive, { motor, proxyPath, proxyId, name, folderId, driveId, originalId, original = null, signal }) {
    if (!motor?.ffmpeg?.path) return null
    const q = await gerarQuadros(motor, proxyPath, { dir: path.dirname(proxyPath), signal })
    const orig = original ?? (await drive.getItem(originalId, { signal, media: true }).catch(() => null))
    let replaceFileId = null
    const antiga = orig?.appProperties?.quadros
    if (antiga) {
      const it = await drive.getItem(antiga, { signal }).catch(() => null)
      if (it && !it.trashed && it.parents?.includes(folderId)) replaceFileId = it.id
    }
    const id = await this.#subir(drive, {
      localPath: q.path,
      name: quadrosName(name),
      parentId: folderId,
      driveId,
      replaceFileId,
      appProperties: { sobedesce: QUADROS_MARCA, original: originalId, ...(proxyId ? { proxy: proxyId } : {}) },
      signal,
    })
    await drive.setAppProperties(originalId, { quadros: id, quadrosGrade: gradeTexto(q.grade) }, { signal })
    return { id, grade: q.grade }
  }

  /**
   * Tira de quadros para um vídeo que já tem proxy no Drive (do app ou da câmera): baixa só o proxy (leve), gera e
   * sobe ao lado dele. Na mesma vaga da fila. Usado pelo lote ("Gerar proxies da pasta").
   */
  quadrosDoProxy(opts) {
    return this.#slot(() => this.#quadrosDoProxy(opts), opts.signal)
  }

  async #quadrosDoProxy({ drive, original, proxy, signal, onFase }) {
    const motor = await this.motor()
    if (!motor?.ffmpeg?.path) throw new Error('sem ffmpeg neste computador')
    const b = await this.baixarOriginal(drive, proxy, { signal, onFase })
    try {
      onFase?.('gerando', 0)
      return await this.#quadros(drive, {
        motor,
        proxyPath: b.path,
        proxyId: proxy.id,
        name: original.name,
        folderId: proxy.parents?.[0],
        driveId: original.driveId ?? null,
        originalId: original.id,
        original,
        signal,
      })
    } finally {
      await b.limpar()
    }
  }

  /**
   * Baixa o original do Drive para um temporário (o mesmo DownloadTask dos downloads: segmentado, com retomada das
   * conexões que caem), para gerar o proxy de um vídeo que não está neste computador. Confere o espaço livre antes
   * (original + folga de 1 GB). Devolve { path, limpar() }; o temporário some em falha ou cancelamento.
   */
  async baixarOriginal(drive, item, { signal, onFase, tmpRoot = this.tmpRoot } = {}) {
    const size = Number(item.size) || 0
    const livre = await this.espaco(tmpRoot)
    if (livre != null && livre < size + FOLGA_BAIXAR) {
      const gb = n => `${(n / 1e9).toFixed(1).replace('.', ',')} GB`
      throw new Error(`sem espaço para baixar o original (precisa de ${gb(size + FOLGA_BAIXAR)}, livre ${gb(livre)})`)
    }
    const dir = await fsp.mkdtemp(path.join(tmpRoot, 'sobedesce-original-'))
    const limpar = () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    const dest = path.join(dir, safeLocalName(item.name || 'original'))
    const rec = {
      id: newId('org'),
      type: 'download',
      status: 'running',
      name: item.name,
      size,
      bytesDone: 0,
      attempts: 0,
      verify: null,
      source: { fileId: item.id, mimeType: item.mimeType || null, md5: item.md5 || null, modifiedTime: item.modifiedTime || null, headRevisionId: item.headRevisionId || null, resourceKey: item.resourceKey || null },
      dest: { path: dest, tempPath: dest + PART_SUFFIX },
      segments: null,
    }
    let got = 0
    const ctx = {
      drive,
      settings: { get: () => ({ ...(this.settings?.get?.() ?? {}), verifyChecksums: false }) },
      limiter: this.downloadLimiter ?? null,
      hasher: null,
      persist: () => {},
      onBytes: n => {
        got += n
        onFase?.('baixando', size ? Math.min(0.999, got / size) : null)
      },
      log: this.log,
    }
    try {
      onFase?.('baixando', 0)
      const task = this.createDownload ? this.createDownload(rec, ctx) : new DownloadTask(rec, ctx, this.downloadOptions)
      await task.run(signal)
      return { path: rec.dest.path, limpar }
    } catch (err) {
      await limpar()
      throw err
    }
  }

  /** Para os Ajustes e a tela Drive. */
  async status({ refresh = false } = {}) {
    const m = await this.motor({ refresh })
    const cur = this.current?.record
    return {
      enabled: this.padrao(),
      modo: this.settings?.get?.()?.proxyAoEnviar ?? 'sempre',
      motor: {
        via: m?.via ?? null,
        label: m?.label || '',
        aviso: m?.aviso || null,
        versao: m?.ffmpeg?.versao ?? null,
        origem: m?.ffmpeg?.origem ?? null,
        encoder: m?.encoder?.nome ?? (m?.via === 'avconvert' ? 'avconvert' : null),
        hardware: !!(m?.encoder?.hardware || m?.via === 'avconvert'),
        // Proxy de Blackmagic RAW (media/braw.js): null = o app não tem o decodificador.
        braw: m?.braw ? { ok: !!m.braw.ok, motivo: m.braw.motivo || null } : null,
      },
      fila: this.queue.length + (cur ? 1 : 0),
      pausada: this.paused,
      atual: cur ? { id: cur.id, name: cur.name, estado: cur.previa?.estado ?? null, frac: cur.previa?.frac ?? null } : null,
      last: this.last,
    }
  }

  /** Espera a fila esvaziar (testes). */
  async idle() {
    for (let i = 0; i < 10_000 && (this.current || (this.queue.length && !this.paused)); i++) {
      await (this.pumping || Promise.resolve())
      await new Promise(r => setImmediate(r))
    }
  }

  async close() {
    this.closing = true
    for (const j of this.queue) if (j.record.previa) j.record.previa.estado = 'fila'
    this.queue = []
    if (this.current) {
      this.current.requeue = false
      this.current.ac.abort()
      await Promise.race([this.pumping, new Promise(r => setTimeout(r, 3000).unref?.())]).catch(() => {})
    }
  }
}

