// Onde estão o yt-dlp e o ffmpeg que as Referências usam.
//
// yt-dlp, na ordem: SOBEDESCE_YTDLP; o atualizado pelo próprio app (<dados>/yt-dlp/<versão>/, conferido por SHA-256 a
// cada uso; ver ytdlp-update.js) se for mais novo que o que veio no app; o que vem no app (<Resources>/yt-dlp/, baixado
// no CI por scripts/ytdlp-baixar.mjs); o baixado para desenvolvimento (build/yt-dlp/<os>[-<arch>]/); o do sistema.
// ffmpeg: a busca da prévia leve (ffmpegCandidates de src/media/previa.js): SOBEDESCE_FFMPEG, <Resources>/ffmpeg/,
// build/ffmpeg/<os>-<arch>/, Homebrew e PATH. O yt-dlp segue a mesma ideia, com <Resources>/yt-dlp/.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ffmpegCandidates } from '../media/previa.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const APP_ROOT = path.resolve(HERE, '..', '..')

export const osTag = platform => (platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux')

/** Nome do executável do yt-dlp dentro do app e na pasta de atualizações. */
export const ytdlpExe = platform => (platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')

/**
 * Arquivo do Release do yt-dlp para esta máquina (nomes de https://github.com/yt-dlp/yt-dlp/releases).
 * Mac: o universal (Intel e Apple Silicon). null = não publicam para esta combinação.
 */
export function ytdlpAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return 'yt-dlp_macos'
  if (platform === 'win32') return arch === 'arm64' ? 'yt-dlp_arm64.exe' : arch === 'ia32' ? 'yt-dlp_x86.exe' : 'yt-dlp.exe'
  if (platform === 'linux') return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : arch === 'x64' ? 'yt-dlp_linux' : null
  return null
}

/** Pasta do yt-dlp que vem no app para esta máquina (Mac: uma só, o binário é universal). */
export const ytdlpBundleDir = (platform, arch) => (platform === 'darwin' ? 'mac' : `${osTag(platform)}-${arch}`)

function pathDirs(env, platform) {
  const sep = platform === 'win32' ? ';' : ':'
  return String(env.PATH || env.Path || '').split(sep).filter(Boolean)
}

/**
 * Candidatos ao yt-dlp que NÃO dependem da atualização (essa é decidida em ytdlp-update.js).
 * @returns {Array<{ path: string, origem: 'env'|'app'|'sistema', versaoArquivo?: string }>}
 *   `versaoArquivo`: versao.txt ao lado do binário do app (gravado pelo scripts/ytdlp-baixar.mjs), quando existe.
 */
export function ytdlpCandidates({ env = process.env, platform = process.platform, arch = process.arch, resourcesPath = process.resourcesPath, appRoot = APP_ROOT } = {}) {
  const exe = ytdlpExe(platform)
  const P = platform === 'win32' ? path.win32 : path.posix
  const out = []
  const add = (p, origem, extra = {}) => {
    if (p && !out.some(c => c.path === p)) out.push({ path: p, origem, ...extra })
  }
  if (env.SOBEDESCE_YTDLP) add(env.SOBEDESCE_YTDLP, 'env')
  const app = dir => add(P.join(dir, exe), 'app', { versaoArquivo: P.join(dir, 'versao.txt') })
  if (resourcesPath) app(P.join(resourcesPath, 'yt-dlp'))
  // Empacotado sem asar: o código fica em <Resources>/app/src, o yt-dlp em <Resources>/yt-dlp.
  app(P.join(appRoot, '..', 'yt-dlp'))
  app(P.join(appRoot, 'build', 'yt-dlp', ytdlpBundleDir(platform, arch)))
  if (platform === 'darwin') for (const p of ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp']) add(p, 'sistema')
  for (const dir of pathDirs(env, platform)) add(P.join(dir, exe), 'sistema')
  return out
}

/** Candidatos ao ffmpeg: a mesma busca da prévia leve (src/media/previa.js), reaproveitada aqui. */
export { ffmpegCandidates }

/** Arquivo comum que existe (síncrono e barato: chamado uma vez por download). */
export function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** O primeiro candidato que existe (ou null). */
export function primeiro(candidatos) {
  return candidatos.find(c => isFile(c.path)) || null
}

/** Versão do yt-dlp (datas: "2026.08.19", "2026.08.19.1"). Compara como números. */
export function compararVersao(a, b) {
  const pa = String(a || '').split(/[.\-]/).map(n => Number.parseInt(n, 10) || 0)
  const pb = String(b || '').split(/[.\-]/).map(n => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

export const versaoValida = v => typeof v === 'string' && /^\d{4}\.\d{1,2}\.\d{1,2}(\.\d+)?$/.test(v.trim())

/** versao.txt ao lado do binário do app (ou null). */
export function lerVersaoArquivo(file) {
  if (!file) return null
  try {
    const v = fs.readFileSync(file, 'utf8').trim()
    return versaoValida(v) ? v : null
  } catch {
    return null
  }
}
