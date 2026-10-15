// Navegação no disco local: atalhos (Início, Mesa, discos externos) e listagem de pastas para a UI.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isJunkFile } from '../util/paths.js'

const STAT_CONCURRENCY = 64

// Ordena como o Finder/Explorer: sem diferenciar maiúsculas/acentos e com números em ordem natural (2 < 10).
const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' })

// Itens de sistema do Windows que ninguém quer ver ao escolher arquivos (tratados como ocultos).
const WIN_SYSTEM = new Set(['$recycle.bin', 'system volume information', 'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log.tmp', 'config.msi', 'recovery'])

/** Roda `fn` sobre `items` com no máximo `limit` ao mesmo tempo, preservando a ordem do resultado. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  const n = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: n }, worker))
  return out
}

/** '~' e '~/x' viram caminhos dentro da pasta do usuário; o resto só é resolvido para absoluto. */
export function expandHome(p, home = os.homedir()) {
  // Sem trim: nomes de pasta podem terminar com espaço de verdade.
  const s = String(p ?? '')
  if (!s.trim()) return home
  if (s === '~') return home
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(home, s.slice(2))
  // "D:" sozinho seria "a pasta atual no disco D"; o usuário quer a raiz do disco.
  if (process.platform === 'win32' && /^[a-z]:$/i.test(s)) return `${s}\\`
  return path.resolve(s)
}

/** Erro de disco com mensagem para o usuário e status HTTP (404/403/500) para o servidor repassar. */
export function fsError(err, p, what = 'pasta') {
  const code = err?.code
  let message
  let status
  if (code === 'ENOENT') {
    message = what === 'pasta' ? 'Não encontrei esta pasta. Ela pode ter sido movida ou o disco foi desconectado.' : 'Não encontrei este item. Ele pode ter sido movido ou o disco foi desconectado.'
    status = 404
  } else if (code === 'ENOTDIR') {
    message = 'Isso não é uma pasta.'
    status = 404
  } else if (code === 'EACCES' || code === 'EPERM') {
    message = what === 'pasta' ? 'Sem permissão para abrir esta pasta.' : 'Sem permissão para ler este item.'
    status = 403
  } else {
    message = what === 'pasta' ? 'Não consegui abrir esta pasta.' : 'Não consegui ler este item.'
    status = 500
  }
  const out = new Error(message)
  out.status = status
  out.code = code
  out.path = p
  out.cause = err
  return out
}

async function exists(p) {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function subdirs(dir) {
  let names
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names.sort(collator.compare)) {
    if (name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (await exists(full)) out.push({ name, path: full })
  }
  return out
}

function currentUser() {
  if (process.env.USER) return process.env.USER
  try {
    return os.userInfo().username
  } catch {
    return ''
  }
}

// No Linux as pastas do usuário podem ter nome traduzido ("Área de Trabalho"); o XDG diz qual é.
async function xdgDir(home, key) {
  try {
    const text = await fs.readFile(path.join(home, '.config', 'user-dirs.dirs'), 'utf8')
    const m = text.match(new RegExp(`^${key}="([^"]*)"`, 'm'))
    if (!m) return null
    const value = m[1].replace(/^\$HOME/, home)
    return value && value !== home ? path.resolve(value) : null
  } catch {
    return null
  }
}

/**
 * Atalhos para o navegador local.
 * @param {object} [opts] só para testes: { platform, home, user, volumesDir, mountBases }
 * @returns {Promise<Array<{ name: string, path: string, kind: 'home'|'desktop'|'downloads'|'documents'|'movies'|'volume'|'drive' }>>}
 */
export async function listRoots(opts = {}) {
  const platform = opts.platform || process.platform
  const home = opts.home || os.homedir()
  const roots = [{ name: 'Início', path: home, kind: 'home' }]
  const seen = new Set([home])
  const add = async (name, p, kind) => {
    if (!p || seen.has(p) || !(await exists(p))) return false
    seen.add(p)
    roots.push({ name, path: p, kind })
    return true
  }

  if (platform === 'darwin') {
    await add('Mesa', path.join(home, 'Desktop'), 'desktop')
    await add('Downloads', path.join(home, 'Downloads'), 'downloads')
    await add('Documentos', path.join(home, 'Documents'), 'documents')
    await add('Filmes', path.join(home, 'Movies'), 'movies')
    // /Volumes tem os discos externos e também um link para o disco do sistema (realpath '/'): esse fica de fora.
    for (const v of await subdirs(opts.volumesDir || '/Volumes')) {
      if (v.name.startsWith('com.apple.')) continue
      const real = await fs.realpath(v.path).catch(() => null)
      if (!real || real === '/') continue
      await add(v.name, v.path, 'volume')
    }
  } else if (platform === 'win32') {
    // Com o OneDrive ligado, a Área de Trabalho mora dentro dele.
    if (!(await add('Área de Trabalho', path.join(home, 'Desktop'), 'desktop'))) {
      await add('Área de Trabalho', path.join(home, 'OneDrive', 'Desktop'), 'desktop')
    }
    await add('Downloads', path.join(home, 'Downloads'), 'downloads')
    const letters = opts.driveLetters || 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
    const found = await Promise.all(letters.map(async l => {
      const root = `${l}:\\`
      let timer
      // Unidade de rede desconectada pode demorar muitos segundos para responder: se demorar, ela existe.
      const slow = new Promise(resolve => {
        timer = setTimeout(() => resolve(root), 2000)
      })
      const check = fs.access(root).then(() => root, () => null)
      try {
        return await Promise.race([check, slow])
      } finally {
        clearTimeout(timer)
      }
    }))
    for (const root of found) {
      if (!root || seen.has(root)) continue
      seen.add(root)
      roots.push({ name: `Disco ${root.slice(0, 2)}`, path: root, kind: 'drive' })
    }
  } else {
    const desktop = await xdgDir(home, 'XDG_DESKTOP_DIR')
    if (!(desktop && (await add('Área de Trabalho', desktop, 'desktop')))) {
      if (!(await add('Área de Trabalho', path.join(home, 'Desktop'), 'desktop'))) {
        await add('Área de Trabalho', path.join(home, 'Área de Trabalho'), 'desktop')
      }
    }
    const downloads = await xdgDir(home, 'XDG_DOWNLOAD_DIR')
    if (!(downloads && (await add('Downloads', downloads, 'downloads')))) {
      await add('Downloads', path.join(home, 'Downloads'), 'downloads')
    }
    const user = opts.user ?? currentUser()
    const bases = opts.mountBases || [user && path.join('/media', user), user && path.join('/run/media', user), '/mnt'].filter(Boolean)
    const realSeen = new Set()
    for (const base of bases) {
      for (const v of await subdirs(base)) {
        // O mesmo disco pode aparecer por dois caminhos (ex.: /media/eu/X e um link em /mnt).
        const real = await fs.realpath(v.path).catch(() => v.path)
        if (realSeen.has(real)) continue
        realSeen.add(real)
        await add(v.name, v.path, 'volume')
      }
    }
  }
  return roots
}

/**
 * Conteúdo de uma pasta para o navegador local.
 * @returns {Promise<{ path: string, parent: string|null, entries: Array<{ name, path, isDir, size, mtimeMs, hidden, isLink }> }>}
 */
export async function listDir(dirPath, { showHidden = false, platform = process.platform } = {}) {
  const dir = expandHome(dirPath)
  let dirents
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    throw fsError(err, dir)
  }

  const candidates = []
  for (const d of dirents) {
    const name = d.name
    if (isJunkFile(name)) continue
    const hidden = name.startsWith('.') || (platform === 'win32' && (name.startsWith('$') || WIN_SYSTEM.has(name.toLowerCase())))
    if (hidden && !showHidden) continue
    candidates.push({ d, hidden })
  }

  const stated = await mapLimit(candidates, STAT_CONCURRENCY, async ({ d, hidden }) => {
    const full = path.join(dir, d.name)
    const isLink = d.isSymbolicLink()
    try {
      // stat segue links: um atalho para pasta aparece como pasta.
      const st = await fs.stat(full)
      const isDir = st.isDirectory()
      return { name: d.name, path: full, isDir, size: isDir ? 0 : st.size, mtimeMs: st.mtimeMs, hidden, isLink }
    } catch (err) {
      // Link quebrado ou item que sumiu no meio do caminho: não mostra.
      if (isLink || err.code === 'ENOENT') return null
      // Sem permissão para o stat (ex.: pastas protegidas do macOS): mostra assim mesmo, sem tamanho.
      const isDir = d.isDirectory()
      return { name: d.name, path: full, isDir, size: 0, mtimeMs: null, hidden, isLink }
    }
  })

  const entries = stated.filter(Boolean)
  entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : collator.compare(a.name, b.name)))
  const up = path.dirname(dir)
  return { path: dir, parent: up === dir ? null : up, entries }
}

/**
 * Situação de vários caminhos (para conferir uma seleção antes de subir).
 * @returns {Promise<Array<{ path, isDir, size, mtimeMs, exists }>>}
 */
export async function statPaths(paths) {
  return mapLimit(Array.from(paths || []), STAT_CONCURRENCY, async p => {
    const full = expandHome(p)
    try {
      const st = await fs.stat(full)
      const isDir = st.isDirectory()
      return { path: full, isDir, size: isDir ? 0 : st.size, mtimeMs: st.mtimeMs, exists: true }
    } catch {
      return { path: full, isDir: false, size: 0, mtimeMs: null, exists: false }
    }
  })
}
