// "Gerar prévias" (tela Drive): cópia leve para os vídeos que JÁ estão no Drive, a partir dos originais no computador.
//
// Mesmo jeito do "Gerar miniaturas" (raw-thumb-lote.js), que é a referência:
//  1. lista os vídeos da pasta do Drive (e subpastas, se pedido) e os proxies que já existem (mesma pasta ou Proxy/
//     Proxies); quem já tem proxy é pulado (com `refazer`, só as NOSSAS cópias são refeitas; proxy de câmera fica);
//  2. varre a pasta do computador atrás de vídeos (mesmos limites e cuidados: sem ocultas/sistema, sem seguir links);
//  3. casa pelo NOME (sem diferenciar maiúsculas, NFC) + TAMANHO;
//  4. gera e sobe a cópia na mesma vaga das prévias dos envios (GeradorPrevias.gerarESubir: uma conversão por vez).
// Falha de um arquivo vira "falhou (motivo)" e o lote segue; cancelar para tudo.
import fs from 'node:fs/promises'
import { FOLDER_MIME } from '../google/drive.js'
import { classifyError } from '../google/errors.js'
import { abortError, isAbortError } from '../util/backoff.js'
import { LOTE_LIMITS, indexLocalRaw, nameKey } from './raw-thumb-lote.js'
import { PEQUENO_BYTES, PREVIA_LADO, PROXY_EXTS, baseKey, isProxyDirName, isVideoName, splitExt } from './previa.js'
import { isPrevia } from './previa-fila.js'

function badRequest(message, status = 400) {
  const err = new Error(message)
  err.status = status
  return err
}

const LEVES = new Set(['já é leve', 'a cópia não ficou menor que o original'])

/** Pelo que o Drive já sabe: .mp4 pequeno até 1080p não precisa de cópia (sem abrir o arquivo). */
export function levePeloDrive(item) {
  const ext = splitExt(item.name)[1]
  if (!(ext === '.mp4' || ext === '.m4v') || item.size == null || item.size >= PEQUENO_BYTES) return false
  const long = Math.max(item.video?.width || 0, item.video?.height || 0)
  return long <= PREVIA_LADO
}

/**
 * Vídeos de uma pasta do Drive e os proxies que já existem para eles.
 * @returns {Promise<{ root, videos: DriveItem[], proxyOf(v): DriveItem|null }>}
 */
export async function listDriveVideos(drive, folderId, { recursive = true, signal } = {}) {
  let root
  try {
    root = await drive.getItem(folderId, { signal })
    if (root.isShortcut && root.shortcutTargetId && root.shortcutTargetMimeType === FOLDER_MIME) root = await drive.getItem(root.shortcutTargetId, { signal, resourceKey: root.shortcutTargetResourceKey || undefined })
  } catch (err) {
    if (classifyError(err).kind === 'notfound') throw badRequest('Não achei esta pasta no Drive. Ela pode ter sido apagada, movida ou deixado de ser compartilhada com você.', 404)
    throw err
  }
  if (!root.isFolder) throw badRequest('Escolha uma pasta do Drive (não um arquivo).')
  let items
  if (recursive) {
    items = (await drive.walk(root.id, { signal, media: true })).items
  } else {
    items = await drive.listChildren(root.id, { signal, media: true })
    for (const it of items) it.relPath = it.name
    // Sem subpastas, ainda assim olha dentro de Proxy/Proxies (é onde a cópia fica).
    for (const dir of items.filter(it => it.isFolder && isProxyDirName(it.name))) {
      for (const c of await drive.listChildren(dir.id, { signal, media: true })) {
        c.relPath = `${dir.name}/${c.name}`
        items.push(c)
      }
    }
  }
  const folders = new Map([[root.id, root]])
  for (const it of items) if (it.isFolder) folders.set(it.id, it)
  const inProxyDir = it => isProxyDirName(folders.get(it.parents?.[0])?.name)
  // Índice dos possíveis proxies: pasta do ORIGINAL + nome-base.
  const index = new Map()
  const put = (folder, it) => {
    if (!folder) return
    const k = `${folder}\n${baseKey(it.name)}`
    const list = index.get(k)
    if (list) list.push(it)
    else index.set(k, [it])
  }
  for (const it of items) {
    if (it.isFolder || it.isShortcut || !PROXY_EXTS.includes(splitExt(it.name)[1])) continue
    const parent = it.parents?.[0]
    if (inProxyDir(it)) put(folders.get(parent)?.parents?.[0], it)
    else put(parent, it)
  }
  const videos = items.filter(it => !it.isFolder && !it.isShortcut && !it.isGoogleDoc && it.size != null && isVideoName(it.name) && !inProxyDir(it) && !isPrevia(it))
  const proxyOf = v => {
    const parent = v.parents?.[0]
    const ext = splitExt(v.name)[1]
    const list = (index.get(`${parent}\n${baseKey(v.name)}`) || []).filter(c => c.id !== v.id && !(c.parents?.[0] === parent && splitExt(c.name)[1] === ext))
    // Na subpasta Proxy primeiro, depois .mp4.
    const rank = c => (c.parents?.[0] === parent ? 2 : 0) + (splitExt(c.name)[1] === '.mp4' ? 0 : 1)
    return list.sort((a, b) => rank(a) - rank(b))[0] ?? null
  }
  return { root, videos, proxyOf }
}

function newSummary() {
  return {
    phase: 'drive', // 'drive' → 'local' → 'gerar' → 'fim'
    videos: 0, // vídeos achados no Drive (fora das pastas Proxy)
    jaTinham: 0, // já tinham proxy/prévia (e `refazer` desligado, ou proxy da câmera)
    jaLeves: 0, // leves o bastante (não precisam de cópia)
    total: 0, // precisam de cópia
    aGerar: 0, // com par no computador
    feitos: 0,
    semLocal: 0,
    semLocalBytes: 0, // quanto seria preciso baixar do Drive para gerar os que não estão no computador
    baixados: 0, // originais baixados do Drive para gerar (com `baixar`)
    tamanhoDiferente: 0,
    falhou: 0,
    localFiles: 0,
    localTruncated: false,
    current: '',
    fase: null, // do arquivo atual: 'analisando' | 'gerando' | 'enviando'
    frac: null, // andamento do arquivo atual (0–1)
    falhas: [],
    semLocalNomes: [],
    semLocalIds: [], // ids do Drive (a tela oferece "Baixar do Drive e gerar" só para eles)
    tamanhoNomes: [],
    feitosIds: [], // ids das cópias novas
  }
}

/**
 * Roda o lote. Só lança em erro "do lote" (pasta inválida, Drive fora, sem conversor, cancelado → AbortError).
 * @param {object} o
 * @param {object} o.drive DriveClient
 * @param {import('./previa-fila.js').GeradorPrevias} o.gerador
 * @param {string} [o.localDir] pasta dos originais no computador (sem ela, só `dicas` e `baixar`)
 * @param {Map<string, string>} [o.dicas] fileId → caminho local já conhecido (envios da fila), conferido pelo tamanho
 * @param {string[]} [o.somente] só estes ids do Drive ("Gerar proxy" de um arquivo, ou os que faltaram)
 * @param {boolean} [o.forcar] gera mesmo que o vídeo seja leve (foi pedido à mão)
 * @param {boolean} [o.baixar] sem original no computador: baixa do Drive para um temporário, gera e apaga
 */
export async function gerarPreviasLote({ drive, gerador, driveFolderId, localDir = null, recursive = true, refazer = false, dicas = null, somente = null, forcar = false, baixar = false, signal, onProgress, limits } = {}) {
  if (!drive || !gerador) throw new Error('gerarPreviasLote: drive e gerador são obrigatórios')
  if (signal?.aborted) throw abortError(signal)
  const lim = { ...LOTE_LIMITS, ...limits }
  const s = newSummary()
  const report = () => {
    try {
      onProgress?.(s)
    } catch {}
  }
  const keep = (list, v) => {
    if (list.length < lim.maxDetails) list.push(v)
  }
  report()

  const motor = await gerador.motor()
  if (!motor?.via) throw badRequest(motor?.aviso || 'Não encontramos o ffmpeg neste computador.', 409)

  const inner = new AbortController()
  const sig = signal ? AbortSignal.any([signal, inner.signal]) : inner.signal
  let failure = null
  const guard = p => {
    const g = p.catch(err => {
      failure ??= err
      inner.abort()
      throw err
    })
    g.catch(() => {})
    return g
  }
  const driveP = guard(listDriveVideos(drive, driveFolderId, { recursive, signal: sig }))
  const localP = localDir
    ? guard(indexLocalRaw(localDir, { signal: sig, limits: lim, accept: isVideoName, onProgress: p => ((s.localFiles = p.files), s.phase === 'local' && report()) }))
    : Promise.resolve({ byName: new Map(), files: 0, truncated: false })
  let listed
  let local
  try {
    listed = await driveP
    s.videos = listed.videos.length
    s.phase = 'local'
    report()
    local = await localP
  } catch (err) {
    if (signal?.aborted) throw abortError(signal)
    throw failure ?? err
  }
  s.localFiles = local.files
  s.localTruncated = local.truncated

  const work = []
  const only = somente?.length ? new Set(somente) : null
  // Original conhecido pela fila (o envio que subiu ele): vale se ainda existe com o mesmo tamanho.
  const hinted = async v => {
    const p = dicas?.get?.(v.id)
    if (!p) return null
    const st = await fs.stat(p).catch(() => null)
    return st?.isFile() && st.size === v.size ? { path: p, size: st.size } : null
  }
  for (const v of listed.videos.filter(x => !only || only.has(x.id))) {
    const proxy = listed.proxyOf(v)
    let replaceFileId = null
    if (proxy) {
      if (!refazer || !isPrevia(proxy)) {
        s.jaTinham++
        continue
      }
      replaceFileId = proxy.id
    } else if (!forcar && levePeloDrive(v)) {
      s.jaLeves++
      continue
    }
    s.total++
    const hint = await hinted(v)
    if (hint) {
      work.push({ item: v, local: hint, replaceFileId })
      continue
    }
    const list = local.byName.get(nameKey(v.name))
    if (!list?.length) {
      if (baixar) {
        work.push({ item: v, local: null, replaceFileId })
        continue
      }
      s.semLocal++
      s.semLocalBytes += v.size || 0
      keep(s.semLocalNomes, v.relPath || v.name)
      if (s.semLocalIds.length < 5000) s.semLocalIds.push(v.id)
      continue
    }
    const hit = list.find(l => l.size === v.size)
    if (!hit) {
      s.tamanhoDiferente++
      keep(s.tamanhoNomes, { name: v.relPath || v.name, drive: v.size, local: list[0].size })
      continue
    }
    work.push({ item: v, local: hit, replaceFileId })
  }
  s.aGerar = work.length
  s.phase = 'gerar'
  report()

  const fail = (it, reason) => {
    s.falhou++
    keep(s.falhas, { name: it.relPath || it.name, reason: String(reason || 'sem motivo').slice(0, 300) })
  }
  for (const { item, local: lf, replaceFileId } of work) {
    if (signal?.aborted) break
    s.current = item.relPath || item.name
    s.fase = 'analisando'
    s.frac = null
    report()
    let baixado = null
    try {
      if (!lf) {
        baixado = await gerador.baixarOriginal(drive, item, {
          signal,
          onFase: (fase, frac) => {
            s.fase = fase
            s.frac = frac ?? null
            report()
          },
        })
        s.baixados++
      }
      const r = await gerador.gerarESubir({
        drive,
        localPath: lf ? lf.path : baixado.path,
        name: item.name,
        size: item.size,
        parentId: item.parents?.[0],
        driveId: item.driveId,
        originalId: item.id,
        replaceFileId,
        forcar: forcar || !!replaceFileId,
        signal,
        onFase: (fase, frac) => {
          s.fase = fase
          s.frac = frac ?? null
          report()
        },
      })
      if (r.estado === 'pronta') {
        s.feitos++
        if (s.feitosIds.length < 5000) s.feitosIds.push(r.fileId)
      } else if (LEVES.has(r.motivo)) {
        s.total--
        s.aGerar--
        s.jaLeves++
      } else fail(item, r.motivo)
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) break
      const info = classifyError(err)
      fail(item, info.kind === 'fatal' && info.status === 403 ? 'o Drive não deixou criar a cópia nesta pasta (sem permissão de edição)' : err?.message || String(err))
    } finally {
      await baixado?.limpar()
    }
    report()
  }
  if (signal?.aborted) throw abortError(signal)
  s.current = ''
  s.fase = null
  s.frac = null
  s.phase = 'fim'
  report()
  return s
}

/** Resumo curto ("3 prévias geradas · 2 sem arquivo no computador"). */
export function resumoPrevias(s) {
  if (!s) return ''
  const n = (v, one, many) => `${v} ${v === 1 ? one : many}`
  if (!s.total) {
    if (s.jaTinham || s.jaLeves) return `Nada a fazer: ${[s.jaTinham ? n(s.jaTinham, 'vídeo já tinha prévia', 'vídeos já tinham prévia') : '', s.jaLeves ? n(s.jaLeves, 'já é leve', 'já são leves') : ''].filter(Boolean).join(' e ')}.`
    return 'Nenhum vídeo sem prévia nesta pasta.'
  }
  const parts = [n(s.feitos, 'prévia gerada', 'prévias geradas')]
  if (s.semLocal) parts.push(`${s.semLocal} sem arquivo no computador`)
  if (s.tamanhoDiferente) parts.push(`${s.tamanhoDiferente} com tamanho diferente`)
  if (s.falhou) parts.push(n(s.falhou, 'falhou', 'falharam'))
  return parts.join(' · ')
}
