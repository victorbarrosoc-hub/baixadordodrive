// Onde estão o yt-dlp e o ffmpeg que as Referências usam.
//
// yt-dlp, na ordem: SOBEDESCE_YTDLP; o atualizado pelo próprio app (<dados>/yt-dlp/<versão>/, conferido por SHA-256 a
// cada uso; ver ytdlp-update.js) se for mais novo que o que veio no app; o que vem no app (<Resources>/yt-dlp/, baixado
// no CI por scripts/ytdlp-baixar.mjs); o baixado para desenvolvimento (build/yt-dlp/<os>[-<arch>]/); o do sistema.
// ffmpeg: a busca da prévia leve (ffmpegCandidates de src/media/previa.js): SOBEDESCE_FFMPEG, <Resources>/ffmpeg/,
// build/ffmpeg/<os>-<arch>/, Homebrew e PATH. O yt-dlp segue a mesma ideia, com <Resources>/yt-dlp/.
// QuickJS (JavaScript dos desafios do YouTube no app de desktop): SOBEDESCE_QJS, <Resources>/quickjs/, build/quickjs/.
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
  // Empacotado: o código fica em <Resources>/app.asar (ou app/), o yt-dlp em <Resources>/yt-dlp.
  app(P.join(appRoot, '..', 'yt-dlp'))
  app(P.join(appRoot, 'build', 'yt-dlp', ytdlpBundleDir(platform, arch)))
  if (platform === 'darwin') for (const p of ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp']) add(p, 'sistema')
  for (const dir of pathDirs(env, platform)) add(P.join(dir, exe), 'sistema')
  return out
}

/** Nome do executável do QuickJS dentro do app. */
export const quickjsExe = platform => (platform === 'win32' ? 'qjs.exe' : 'qjs')

/**
 * Candidatos ao QuickJS-ng, o interpretador de JavaScript que o yt-dlp usa nos desafios do YouTube dentro do app de
 * desktop. Antes era o próprio Electron com ELECTRON_RUN_AS_NODE=1, mas o fusível RunAsNode agora fica desligado
 * (ninguém usa o app como um Node com as permissões dele). Baixado no CI por scripts/quickjs-baixar.mjs para
 * build/quickjs/<os>-<arch>/ e posto pelo electron-builder em <Resources>/quickjs/.
 * Ordem: SOBEDESCE_QJS, <Resources>/quickjs/, <app>/../quickjs/, build/quickjs/<os>-<arch>/.
 */
export function quickjsCandidates({ env = process.env, platform = process.platform, arch = process.arch, resourcesPath = process.resourcesPath, appRoot = APP_ROOT } = {}) {
  const exe = quickjsExe(platform)
  const P = platform === 'win32' ? path.win32 : path.posix
  const out = []
  const add = (p, origem) => {
    if (p && !out.some(c => c.path === p)) out.push({ path: p, origem })
  }
  if (env.SOBEDESCE_QJS) add(env.SOBEDESCE_QJS, 'env')
  if (resourcesPath) add(P.join(resourcesPath, 'quickjs', exe), 'app')
  add(P.join(appRoot, '..', 'quickjs', exe), 'app')
  add(P.join(appRoot, 'build', 'quickjs', `${osTag(platform)}-${arch}`, exe), 'app')
  return out
}

/**
 * Interpretador de JavaScript para o yt-dlp (`--js-runtimes nome:caminho`).
 * Fora do Electron (npm start, testes): o próprio Node. No Electron: o QuickJS que vem no app; sem ele, null (o yt-dlp
 * procura um deno/node do sistema sozinho). Nunca o executável do Electron: o fusível RunAsNode está desligado.
 */
export function jsRuntimePadrao({ electron = Boolean(process.versions.electron), execPath = process.execPath, candidatos } = {}) {
  if (!electron) return { nome: 'node', path: execPath, env: {} }
  const qjs = primeiro(candidatos ?? quickjsCandidates())
  return qjs ? { nome: 'quickjs', path: qjs.path, env: {} } : null
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
