// Miniatura de vídeo RAW (Blackmagic RAW e afins) para o Google Drive.
//
// O Drive não gera miniatura de .braw: no Drive web, no app do Drive e no SOBEDESCE o arquivo aparece com o ícone
// genérico. A API aceita uma miniatura nossa (`contentHints.thumbnail`, usada só quando o Drive não tem a dele), então
// ao terminar o envio de um .braw o motor tira um frame com o que o computador já sabe fazer e grava no arquivo.
//
// De onde vem o frame (docs/ARCHITECTURE.md, "media/raw-thumb.js"):
//  - Ajudante nativo (native/raw-frame/): usa o Blackmagic RAW SDK (a biblioteca vem junto do app). Só entra se
//    existir (SOBEDESCE_RAW_HELPER ou <resources>/raw-frame/). Contrato no fim deste arquivo.
//  - Mac: Quick Look (`qlmanage -t`), que usa a extensão de miniatura instalada para o tipo (Blackmagic RAW,
//    Calibrated QuickLook…), e `sips` (do próprio macOS) para virar JPEG pequeno.
//  - Windows: a miniatura do Explorer (IShellItemImageFactory, só "thumbnail", nunca o ícone), pelo PowerShell
//    que vem com o Windows. O manipulador de miniatura é o que o Blackmagic RAW instala.
// Nada aqui lança para fora nem trava o envio: tempo limite, um processo por vez (dois no máximo), resultado null
// com o motivo no log.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { abortError } from '../util/backoff.js'

const KiB = 1024
const MiB = 1024 * KiB

/** Extensões que o Drive não miniaturiza e que um extrator do sistema pode saber abrir. */
export const RAW_THUMB_EXTS = Object.freeze(['.braw', '.r3d'])
// 960 px basta para a grade do Drive e sai bem mais rápido: o leitor do Blackmagic RAW decodifica em resolução reduzida
// quando a miniatura pedida é menor.
export const DEFAULT_WIDTH = 960
// O Quick Look do Blackmagic RAW num SSD externo leva de 20 a 60 s na primeira leitura (sobe o decodificador e lê o
// arquivo); 20 s cortava quase todos. Passou disso, desiste (o envio nunca espera por isto).
export const DEFAULT_TIMEOUT_MS = 90_000
/** O Drive aceita até 2 MB; com folga, porque vai em base64 dentro do JSON. */
export const MAX_THUMB_BYTES = Math.floor(1.5 * MiB)
/** Página oficial do Blackmagic RAW (Player + SDK; instala o suporte a miniatura). */
export const BLACKMAGIC_RAW_URL = 'https://www.blackmagicdesign.com/products/blackmagicraw'

const OUTPUT_LIMIT = 16 * KiB // stdout/stderr guardados de cada processo (só para o log)
const MIN_WIDTH = 320

/** true se o nome termina numa extensão RAW que vale miniatura (sem diferenciar maiúsculas). */
export function isRawThumbCandidate(name) {
  const ext = path.extname(String(name ?? '')).toLowerCase()
  return RAW_THUMB_EXTS.includes(ext)
}

/** Tipo da imagem pelos primeiros bytes ('image/jpeg' | 'image/png' | 'image/gif' | null). */
export function imageMime(buf) {
  if (!buf || buf.length < 4) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'
  return null
}

// ─────────── processos ───────────

/**
 * Roda um programa sem shell, com tempo limite. Nunca rejeita: devolve { code, timedOut, aborted, error, stderr }.
 * No tempo limite ou no abort, mata o processo (SIGKILL) e não espera ele "pensar".
 */
export function runProcess(cmd, args, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, env, cwd } = {}) {
  return new Promise(resolve => {
    let child
    let stderr = ''
    let stdout = ''
    let done = false
    let timedOut = false
    let aborted = false
    const finish = result => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ stdout, stderr, timedOut, aborted, ...result })
    }
    const kill = () => {
      try {
        child?.kill('SIGKILL')
      } catch {}
    }
    const onAbort = () => {
      aborted = true
      kill()
      finish({ code: null })
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
      finish({ code: null })
    }, Math.max(1, timeoutMs))
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      return finish({ code: null, error })
    }
    child.stdout.on('data', d => {
      if (stdout.length < OUTPUT_LIMIT) stdout += d.toString('utf8')
    })
    child.stderr.on('data', d => {
      if (stderr.length < OUTPUT_LIMIT) stderr += d.toString('utf8')
    })
    child.on('error', error => finish({ code: null, error }))
    child.on('close', code => finish({ code }))
  })
}

class ExtractError extends Error {
  constructor(message, { timedOut = false } = {}) {
    super(message)
    this.name = 'ExtractError'
    this.timedOut = timedOut
  }
}

function checkRun(r, what) {
  if (r.aborted) throw abortError()
  if (r.timedOut) throw new ExtractError(`${what}: tempo esgotado`, { timedOut: true })
  if (r.error) throw new ExtractError(`${what}: ${r.error.code || r.error.message}`)
}

async function readIfExists(file) {
  try {
    return await fsp.readFile(file)
  } catch {
    return null
  }
}

async function exists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

const remaining = deadline => Math.max(1, deadline - Date.now())

// ─────────── extratores ───────────
// Extrator = { id, label, extract(file, { width, maxBytes, deadline, signal, tmp }) → Promise<Buffer|null> }.
// null = "não tem miniatura para este arquivo"; lançar ExtractError = falhou (o motivo vai para o log).

/** Mac: Quick Look gera PNG; `sips` (do sistema) vira JPEG e reduz até caber. */
export function quickLookExtractor({ qlmanage = '/usr/bin/qlmanage', sips = '/usr/bin/sips' } = {}) {
  return {
    id: 'quicklook',
    label: 'Quick Look do macOS',
    async extract(file, { width, maxBytes, deadline, signal, tmp }) {
      const qlDir = path.join(tmp, 'ql')
      await fsp.mkdir(qlDir, { recursive: true })
      const r = await runProcess(qlmanage, ['-t', '-s', String(width), '-o', qlDir, file], { timeoutMs: remaining(deadline), signal })
      checkRun(r, 'Quick Look')
      // O nome de saída é "<arquivo>.png", mas o macOS pode mudar a forma Unicode do nome: pega o PNG que apareceu.
      const png = (await fsp.readdir(qlDir).catch(() => [])).find(n => n.toLowerCase().endsWith('.png'))
      if (!png) return null
      const pngPath = path.join(qlDir, png)
      const pngBuf = await readIfExists(pngPath)
      if (!pngBuf || !imageMime(pngBuf)) return null
      // JPEG fica muito menor que PNG. Se não couber, baixa a qualidade e depois o tamanho.
      const tries = [
        [80, width],
        [65, width],
        [60, Math.max(MIN_WIDTH, Math.round(width * 0.6))],
      ]
      for (const [quality, w] of tries) {
        const out = path.join(tmp, `frame-${quality}-${w}.jpg`)
        const s = await runProcess(sips, ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), '-Z', String(w), pngPath, '--out', out], {
          timeoutMs: remaining(deadline),
          signal,
        })
        if (s.aborted) throw abortError()
        if (s.timedOut || s.error || s.code !== 0) break // sem sips: fica o PNG, se couber
        const jpg = await readIfExists(out)
        if (jpg && imageMime(jpg) === 'image/jpeg' && jpg.length <= maxBytes) return jpg
      }
      return pngBuf
    },
  }
}

// Windows: miniatura do Shell (a mesma do Explorer). Add-Type compila este C# na memória (PowerShell 5.1 vem no
// Windows 10/11); nada é instalado. SIIGBF_THUMBNAILONLY garante que sem manipulador de miniatura não vem o ícone.
// Caminhos chegam por variável de ambiente: nada do nome do arquivo entra no texto do script.
const WIN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class SobeDesceThumb {
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItemImageFactory {
    [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm);
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct SIZE { public int cx; public int cy; }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  private static extern int SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory item);
  [DllImport("gdi32.dll")]
  private static extern bool DeleteObject(IntPtr h);

  private static byte[] Jpeg(Image img, long quality) {
    ImageCodecInfo codec = null;
    foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") codec = c;
    using (var ms = new MemoryStream()) {
      var p = new EncoderParameters(1);
      p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
      img.Save(ms, codec, p);
      return ms.ToArray();
    }
  }

  private static Bitmap Scale(Image src, double f) {
    int w = Math.Max(1, (int)(src.Width * f)), h = Math.Max(1, (int)(src.Height * f));
    var b = new Bitmap(w, h, PixelFormat.Format24bppRgb);
    using (var g = Graphics.FromImage(b)) {
      g.InterpolationMode = InterpolationMode.HighQualityBicubic;
      g.DrawImage(src, 0, 0, w, h);
    }
    return b;
  }

  public static int Run(string input, string output, int width, long maxBytes) {
    Guid iid = typeof(IShellItemImageFactory).GUID;
    IShellItemImageFactory factory;
    if (SHCreateItemFromParsingName(input, IntPtr.Zero, ref iid, out factory) != 0 || factory == null) return 3;
    IntPtr hbm;
    SIZE size; size.cx = width; size.cy = width;
    // 0x8 = SIIGBF_THUMBNAILONLY, 0x1 = SIIGBF_BIGGERSIZEOK
    if (factory.GetImage(size, 0x8 | 0x1, out hbm) != 0 || hbm == IntPtr.Zero) return 2;
    try {
      using (var raw = Image.FromHbitmap(hbm)) {
        double[] scales = { 1.0, 1.0, 0.6, 0.4 };
        long[] qualities = { 82, 68, 65, 60 };
        for (int i = 0; i < scales.Length; i++) {
          using (var img = Scale(raw, scales[i])) {
            byte[] bytes = Jpeg(img, qualities[i]);
            if (bytes.Length <= maxBytes) { File.WriteAllBytes(output, bytes); return 0; }
          }
        }
        return 4;
      }
    } finally {
      DeleteObject(hbm);
    }
  }
}
'@
exit [SobeDesceThumb]::Run($env:SOBEDESCE_THUMB_IN, $env:SOBEDESCE_THUMB_OUT, [int]$env:SOBEDESCE_THUMB_WIDTH, [long]$env:SOBEDESCE_THUMB_MAX)
`

const WIN_EXIT = { 2: null, 3: 'o Windows não abriu o arquivo', 4: 'a miniatura ficou grande demais' }

export function windowsPowerShellPath(env = process.env) {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** Windows: miniatura do Explorer pelo PowerShell do sistema. */
export function windowsShellExtractor({ powershell = windowsPowerShellPath() } = {}) {
  const encoded = Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64')
  return {
    id: 'shell',
    label: 'Miniatura do Windows',
    async extract(file, { width, maxBytes, deadline, signal, tmp }) {
      const out = path.join(tmp, 'frame.jpg')
      const r = await runProcess(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        timeoutMs: remaining(deadline),
        signal,
        env: { SOBEDESCE_THUMB_IN: file, SOBEDESCE_THUMB_OUT: out, SOBEDESCE_THUMB_WIDTH: String(width), SOBEDESCE_THUMB_MAX: String(maxBytes) },
      })
      checkRun(r, 'PowerShell')
      if (r.code in WIN_EXIT) {
        if (WIN_EXIT[r.code]) throw new ExtractError(WIN_EXIT[r.code])
        return null
      }
      if (r.code !== 0) throw new ExtractError(`PowerShell saiu com ${r.code}${r.stderr ? `: ${r.stderr.trim().split('\n')[0].slice(0, 200)}` : ''}`)
      return readIfExists(out)
    },
  }
}

/**
 * Ajudante nativo (peça trocável, ver o contrato no fim do arquivo):
 * `<helper> --input <arquivo> --output <saida.jpg> --width <px> --max-bytes <n>` → código 0 e a imagem gravada;
 * código 2 = "este arquivo não tem como" (null); outro código = falha.
 */
export function helperExtractor(helperPath) {
  return {
    id: 'helper',
    label: 'Ajudante do Blackmagic RAW',
    async extract(file, { width, maxBytes, deadline, signal, tmp }) {
      const out = path.join(tmp, 'frame.jpg')
      const r = await runProcess(helperPath, ['--input', file, '--output', out, '--width', String(width), '--max-bytes', String(maxBytes)], {
        timeoutMs: remaining(deadline),
        signal,
      })
      checkRun(r, 'Ajudante')
      if (r.code === 2) return null
      if (r.code !== 0) throw new ExtractError(`ajudante saiu com ${r.code}${r.stderr ? `: ${r.stderr.trim().split('\n')[0].slice(0, 200)}` : ''}`)
      return readIfExists(out)
    },
  }
}

/** Onde procurar o ajudante nativo: SOBEDESCE_RAW_HELPER, ou ao lado do app empacotado (resources/raw-frame/). */
export function helperCandidates({ env = process.env, platform = process.platform, resourcesPath = process.resourcesPath } = {}) {
  const exe = platform === 'win32' ? 'sobedesce-raw-frame.exe' : 'sobedesce-raw-frame'
  const out = []
  if (env.SOBEDESCE_RAW_HELPER) out.push(env.SOBEDESCE_RAW_HELPER)
  if (resourcesPath) out.push(path.join(resourcesPath, 'raw-frame', exe))
  return out
}

/** Extratores na ordem de preferência para esta plataforma (ajudante nativo primeiro, se existir). */
export async function systemExtractors({ platform = process.platform, env = process.env, resourcesPath = process.resourcesPath, bins = {} } = {}) {
  const list = []
  for (const p of helperCandidates({ env, platform, resourcesPath })) {
    if (await exists(p)) {
      list.push(helperExtractor(p))
      break
    }
  }
  if (platform === 'darwin') {
    const qlmanage = bins.qlmanage || '/usr/bin/qlmanage'
    if (await exists(qlmanage)) list.push(quickLookExtractor({ qlmanage, sips: bins.sips || '/usr/bin/sips' }))
  } else if (platform === 'win32') {
    const powershell = bins.powershell || windowsPowerShellPath(env)
    if (await exists(powershell)) list.push(windowsShellExtractor({ powershell }))
  }
  return list
}

// ─────────── detecção (para os Ajustes) ───────────

// Chave do Shell para manipuladores de miniatura (IThumbnailProvider).
const THUMB_HANDLER = '{e357fccd-a995-4576-b01f-234630154e96}'

/** Pastas onde o Blackmagic RAW (Player/SDK) ou o DaVinci Resolve costumam ficar. */
export function blackmagicPaths({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'darwin') {
    return [
      '/Applications/Blackmagic RAW',
      '/Applications/DaVinci Resolve',
      '/Applications/DaVinci Resolve.app',
      '/Library/Frameworks/BlackmagicRawAPI.framework',
      path.join(home, 'Applications', 'Blackmagic RAW'),
      path.join(home, 'Applications', 'DaVinci Resolve'),
    ]
  }
  if (platform === 'win32') {
    const roots = [...new Set([env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter(Boolean))]
    if (!roots.length) roots.push('C:\\Program Files')
    const out = []
    for (const r of roots) {
      out.push(path.win32.join(r, 'Blackmagic Design', 'Blackmagic RAW'))
      out.push(path.win32.join(r, 'Blackmagic Design', 'DaVinci Resolve'))
    }
    return out
  }
  return []
}

/**
 * Mac: extensão de Quick Look de terceiros que abre RAW (Calibrated{Q} QuickLook e afins). Só olha nomes nas pastas
 * onde elas costumam ficar; não abre nada.
 */
async function macQuickLookPlugin(home) {
  const dirs = ['/Library/QuickLook', path.join(home, 'Library', 'QuickLook'), '/Applications', path.join(home, 'Applications')]
  for (const d of dirs) {
    const names = await fsp.readdir(d).catch(() => [])
    if (names.some(n => /calibrated|braw|blackmagic\s*raw/i.test(n))) return true
  }
  return false
}

async function windowsThumbHandler(env, signal) {
  const reg = path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'reg.exe')
  for (const key of [`HKCR\\.braw\\ShellEx\\${THUMB_HANDLER}`, `HKCR\\SystemFileAssociations\\.braw\\ShellEx\\${THUMB_HANDLER}`]) {
    const r = await runProcess(reg, ['query', key], { timeoutMs: 5000, signal })
    if (r.code === 0) return true
  }
  return false
}

/**
 * O que este computador tem para gerar miniatura de BRAW (para os Ajustes; barato, sem abrir arquivo nenhum).
 * { supported: há caminho nesta plataforma, found: Blackmagic RAW/Resolve (ou o ajudante) encontrado,
 *   via: 'helper'|'quicklook'|'shell'|null, downloadUrl }
 */
export async function detectExtractor({ platform = process.platform, env = process.env, resourcesPath = process.resourcesPath, bins = {}, home, signal } = {}) {
  const extractors = await systemExtractors({ platform, env, resourcesPath, bins })
  const via = extractors[0]?.id ?? null
  let found = via === 'helper'
  if (!found) {
    for (const p of blackmagicPaths({ platform, env, home })) {
      if (await exists(p)) {
        found = true
        break
      }
    }
  }
  if (!found && platform === 'darwin' && via) found = await macQuickLookPlugin(home ?? os.homedir()).catch(() => false)
  if (!found && platform === 'win32' && via) found = await windowsThumbHandler(env, signal).catch(() => false)
  return { supported: extractors.length > 0, found, via, downloadUrl: BLACKMAGIC_RAW_URL }
}

// ─────────── extrairFrame ───────────

/**
 * Tira um frame de um vídeo RAW local para usar como miniatura no Drive.
 * Devolve a imagem (JPEG; PNG se a conversão não existir e couber) ou null. Nunca lança.
 * @param {string} file caminho local
 * @param {{ largura?: number, maxBytes?: number, timeoutMs?: number, signal?: AbortSignal,
 *           extractors?: Array<object>, log?: Function, platform?: string }} [opts]
 *   `extractors` troca a detecção (testes, ajudante específico). `log(motivo)` recebe o motivo curto quando é null.
 */
export async function extrairFrame(file, { largura = DEFAULT_WIDTH, maxBytes = MAX_THUMB_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS, signal, extractors, log = () => {}, platform } = {}) {
  const deadline = Date.now() + timeoutMs
  const width = Math.max(MIN_WIDTH, Math.round(Number(largura) || DEFAULT_WIDTH))
  let tmp = null
  // O tempo limite vale para tudo (inclusive extrator que não respeita prazo): corre contra um relógio.
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let timer
  const clock = new Promise(resolve => {
    timer = setTimeout(() => {
      ac.abort()
      resolve({ timeout: true })
    }, Math.max(1, timeoutMs))
    // Pausa/encerramento: não espera um extrator que não respeita o signal.
    ac.signal.addEventListener('abort', () => resolve({ timeout: true }), { once: true })
  })
  const work = (async () => {
    const list = extractors ?? (await systemExtractors({ platform: platform ?? process.platform }))
    if (!list.length) return { reason: 'nenhum extrator neste computador' }
    const st = await fsp.stat(file).catch(() => null)
    if (!st?.isFile()) return { reason: 'arquivo local não encontrado' }
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sobedesce-thumb-'))
    const reasons = []
    for (const ex of list) {
      if (ac.signal.aborted) break
      try {
        const sub = await fsp.mkdtemp(path.join(tmp, `${ex.id}-`))
        const buf = await ex.extract(file, { width, maxBytes, deadline, signal: ac.signal, tmp: sub })
        if (!buf?.length) {
          reasons.push(`${ex.label}: sem miniatura para este arquivo`)
          continue
        }
        if (!imageMime(buf)) {
          reasons.push(`${ex.label}: imagem em formato desconhecido`)
          continue
        }
        if (buf.length > maxBytes) {
          reasons.push(`${ex.label}: miniatura grande demais (${Math.round(buf.length / KiB)} KB)`)
          continue
        }
        return { buf, via: ex.id }
      } catch (err) {
        if (ac.signal.aborted) break
        reasons.push(`${ex.label}: ${err?.message || err}`)
      }
    }
    return { reason: reasons.join('; ') || 'sem miniatura' }
  })().catch(err => ({ reason: err?.message || String(err) }))

  try {
    const result = await Promise.race([work, clock])
    if (result.timeout) {
      log(signal?.aborted ? 'interrompido' : `tempo esgotado (${Math.round(timeoutMs / 1000)} s)`)
      return null
    }
    if (result.buf) return result.buf
    log(signal?.aborted ? 'interrompido' : result.reason)
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    ac.abort()
    // Espera o trabalho largar os arquivos antes de apagar a pasta (o processo já foi morto pelo abort);
    // um extrator que nunca devolve não segura a pasta para sempre.
    const grace = new Promise(resolve => setTimeout(resolve, 5000).unref?.())
    Promise.race([work, grace])
      .then(() => (tmp ? fsp.rm(tmp, { recursive: true, force: true }) : null))
      .catch(() => {})
  }
}

// ─────────── serviço usado pelo motor ───────────

const CACHE_MAX = 16
const FAILS_TO_PAUSE = 3 // falhas seguidas (sem nenhum sucesso) antes de dar um tempo
const PAUSE_MS = 10 * 60_000

/**
 * Miniaturas de RAW dos envios. O TransferManager chama `prepare(record)` quando um envio começa (o frame sai em
 * paralelo ao envio) e `attach(record, drive)` quando ele termina bem (grava no Drive em segundo plano).
 * Nada daqui muda o status da transferência; `onResult(record, ok)` só avisa.
 */
export class RawThumbnailer {
  /**
   * @param {object} opts
   * @param {{ get(): object }} [opts.settings] lê `brawThumbnails` a cada uso (ligado se não houver settings)
   * @param {(file: string, opts: object) => Promise<Buffer|null>} [opts.extract] troca o extrairFrame (testes)
   * @param {number} [opts.maxConcurrent] extrações ao mesmo tempo (decodificar RAW pesa)
   */
  constructor({ settings = null, extract = extrairFrame, detect = detectExtractor, log = () => {}, maxConcurrent = 2, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_THUMB_BYTES, width = DEFAULT_WIDTH, onResult = null } = {}) {
    this.settings = settings
    this.extract = extract
    this.detect = detect
    this.log = log
    this.maxConcurrent = Math.max(1, maxConcurrent)
    this.timeoutMs = timeoutMs
    this.maxBytes = maxBytes
    this.width = width
    this.onResult = onResult
    this.cache = new Map() // chave (caminho|tamanho|mtime) → Promise<Buffer|null>
    this.pending = new Set()
    this.running = 0
    this.queue = []
    this.fails = 0
    this.pausedUntil = 0
    this.last = null // { ok, reason, at, name }
    this.closing = new AbortController()
    this.detected = null
  }

  enabled() {
    const s = this.settings?.get?.()
    return s ? s.brawThumbnails !== false : true
  }

  /** Vale miniatura para este registro de envio? */
  wants(record) {
    return !!(record && record.type === 'upload' && record.local?.path && !this.closing.signal.aborted && this.enabled() &&
      isRawThumbCandidate(record.name || record.local.path))
  }

  #key(local) {
    return `${local.path}|${local.size ?? ''}|${local.mtimeMs ?? ''}`
  }

  /** Começa a tirar o frame (se ainda não começou). Não espera. */
  prepare(record) {
    if (!this.wants(record)) return
    if (Date.now() < this.pausedUntil) return
    this.#frame(record.local)
  }

  /** Promise<{ buf: Buffer|null, reason: string|null }> do frame deste arquivo (uma extração por versão do arquivo). */
  #frame(local) {
    const key = this.#key(local)
    let p = this.cache.get(key)
    if (p) {
      this.cache.delete(key) // reinsere no fim (mais recente)
      this.cache.set(key, p)
      return p
    }
    let reason = null
    p = this.#limit(() =>
      Promise.resolve(
        this.extract(local.path, {
          largura: this.width,
          maxBytes: this.maxBytes,
          timeoutMs: this.timeoutMs,
          signal: this.closing.signal,
          log: r => (reason = r),
        }),
      ),
    ).then(
      buf => (Buffer.isBuffer(buf) && buf.length ? { buf, reason: null } : { buf: null, reason: reason || 'sem miniatura' }),
      err => ({ buf: null, reason: err?.message || String(err) }),
    )
    this.cache.set(key, p)
    while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value)
    return p
  }

  /**
   * Frame de um arquivo local para o "Gerar miniaturas" do Drive (raw-thumb-lote.js): mesma fila e mesmos limites
   * dos envios, mas sem cache, sem a pausa depois de falhas e sem olhar o ajuste `brawThumbnails` (foi pedido).
   * Devolve { buf, reason } e nunca rejeita, a não ser AbortError quando `signal` (ou o encerramento) interrompe.
   */
  async frameFor(file, { signal } = {}) {
    const sig = signal ? AbortSignal.any([this.closing.signal, signal]) : this.closing.signal
    if (sig.aborted) throw abortError(sig)
    let reason = null
    const job = this.#limit(() => {
      if (sig.aborted) return null
      return this.extract(file, { largura: this.width, maxBytes: this.maxBytes, timeoutMs: this.timeoutMs, signal: sig, log: r => (reason = r) })
    })
    job.catch(() => {})
    // Cancelar não espera a vez na fila (nem um extrator que demora a largar).
    let onAbort
    const stop = new Promise((_, reject) => {
      onAbort = () => reject(abortError(sig))
      sig.addEventListener('abort', onAbort, { once: true })
    })
    stop.catch(() => {})
    try {
      const buf = await Promise.race([job, stop])
      if (sig.aborted) throw abortError(sig)
      if (Buffer.isBuffer(buf) && buf.length) return { buf, reason: null }
      return { buf: null, reason: reason || 'sem miniatura' }
    } catch (err) {
      if (sig.aborted) throw abortError(sig)
      return { buf: null, reason: err?.message || String(err) }
    } finally {
      sig.removeEventListener('abort', onAbort)
    }
  }

  async #limit(fn) {
    if (this.running >= this.maxConcurrent) await new Promise(resolve => this.queue.push(resolve))
    this.running++
    try {
      return await fn()
    } finally {
      this.running--
      this.queue.shift()?.()
    }
  }

  /**
   * O envio terminou: grava a miniatura no arquivo do Drive em segundo plano. Devolve a promessa (para testes);
   * ela nunca rejeita (true = gravou).
   */
  attach(record, drive) {
    if (!this.wants(record) || !record.target?.fileId || !drive?.setThumbnail) return Promise.resolve(false)
    const fileId = record.target.fileId
    const name = record.name || path.basename(record.local.path)
    const key = this.#key(record.local)
    const job = (async () => {
      if (Date.now() < this.pausedUntil && !this.cache.has(key)) return false
      const { buf, reason } = await this.#frame(record.local)
      this.cache.delete(key)
      if (!buf) return this.#result(record, false, reason, name)
      if (this.closing.signal.aborted || !this.enabled()) return false
      const mime = imageMime(buf)
      if (!mime || buf.length > this.maxBytes) return this.#result(record, false, 'imagem inválida ou grande demais', name)
      try {
        await drive.setThumbnail(fileId, buf, mime, { signal: this.closing.signal })
      } catch (err) {
        if (this.closing.signal.aborted) return false
        return this.#result(record, false, `o Drive recusou: ${err?.message || err}`, name, { drive: true })
      }
      return this.#result(record, true, null, name)
    })().catch(err => this.#result(record, false, err?.message || String(err), name))
    this.pending.add(job)
    job.finally(() => this.pending.delete(job))
    return job
  }

  #result(record, ok, reason, name, { drive = false } = {}) {
    this.last = { ok, reason: ok ? null : reason, at: Date.now(), name }
    if (ok) {
      this.fails = 0
      this.pausedUntil = 0
      this.log(`miniatura: gravada em "${name}"`)
    } else {
      this.log(`miniatura: "${name}" ficou sem miniatura (${reason})`)
      // Falha do Drive não diz nada sobre o extrator; a do extrator, repetida, diz: dá um tempo para não insistir.
      if (!drive && ++this.fails >= FAILS_TO_PAUSE) {
        this.pausedUntil = Date.now() + PAUSE_MS
        this.fails = 0
      }
    }
    try {
      this.onResult?.(record, ok)
    } catch {}
    return ok
  }

  /** Espera as gravações em andamento (testes, encerramento). */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }

  /** Para os Ajustes: o que existe no computador + o último resultado. Detecção em cache por 1 min. */
  async status({ refresh = false, detect = this.detect } = {}) {
    if (refresh || !this.detected || Date.now() - this.detected.at > 60_000) {
      const d = await detect().catch(() => ({ supported: false, found: false, via: null, downloadUrl: BLACKMAGIC_RAW_URL }))
      this.detected = { ...d, at: Date.now() }
    }
    const { at, ...d } = this.detected
    return { ...d, enabled: this.enabled(), last: this.last }
  }

  async close() {
    this.closing.abort()
    await Promise.race([this.idle(), new Promise(resolve => setTimeout(resolve, 2000).unref?.())])
    this.cache.clear()
  }
}

// ─────────── contrato do ajudante nativo ───────────
//
// `sobedesce-raw-frame` (native/raw-frame/, C++ com o Blackmagic RAW SDK) vem no app quando o CI tem o cadastro do
// SDK (scripts/raw-frame-build.mjs), com a biblioteca da Blackmagic ao lado (<resources>/raw-frame/BlackmagicRawAPI/);
// sem ela, usa a do Blackmagic RAW ou do DaVinci Resolve instalados. Decodifica um frame (~1 s do começo) na menor
// escala do SDK que dá a largura pedida, em Rec.709, e grava JPEG (stb_image_write).
// Linha de comando: --input <arquivo> --output <saida.jpg> --width <px> --max-bytes <n>
// Saída: código 0 + imagem gravada; 2 = sem como abrir (biblioteca ausente, formato); outro = falha.
// Se existir em SOBEDESCE_RAW_HELPER ou em <resources>/raw-frame/, ele é tentado antes do sistema. O mesmo executável
// gera o proxy de .braw (media/braw.js: --check, --info, --frames).
