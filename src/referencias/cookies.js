// Cookies do navegador de referências para o yt-dlp (`--cookies <arquivo>`, formato Netscape).
// O arquivo é uma credencial (sessão do Instagram, do YouTube…): nasce com modo 0600 numa pasta temporária 0700
// só deste download e é apagado assim que o yt-dlp termina (deu certo, deu erro ou foi cancelado).
import fs from 'node:fs/promises'
import path from 'node:path'

const PROIBIDO = /[\t\r\n\u0000]/ // quebraria o formato (uma linha por cookie, campos por tab)

/** Cookie no formato do Electron (`session.cookies.get`) → linha Netscape, ou null se não dá para escrever. */
export function linhaNetscape(c) {
  if (!c || typeof c !== 'object') return null
  const name = String(c.name ?? '')
  const value = String(c.value ?? '')
  let domain = String(c.domain ?? '').trim().toLowerCase()
  if (!name || !domain || PROIBIDO.test(name) || PROIBIDO.test(value) || PROIBIDO.test(domain) || /\s/.test(domain)) return null
  // hostOnly = só aquele host; senão vale para os subdomínios (Netscape: domínio com ponto na frente + TRUE).
  const sub = c.hostOnly ? false : true
  if (sub && !domain.startsWith('.')) domain = `.${domain}`
  if (!sub) domain = domain.replace(/^\./, '')
  const p = String(c.path || '/')
  if (PROIBIDO.test(p)) return null
  const exp = c.session || !Number.isFinite(Number(c.expirationDate)) ? 0 : Math.max(0, Math.floor(Number(c.expirationDate)))
  const prefix = c.httpOnly ? '#HttpOnly_' : ''
  return [`${prefix}${domain}`, sub ? 'TRUE' : 'FALSE', p, c.secure ? 'TRUE' : 'FALSE', String(exp), name, value].join('\t')
}

/** Texto completo do arquivo de cookies (cabeçalho que o yt-dlp/curl reconhece). */
export function textoNetscape(cookies) {
  const linhas = ['# Netscape HTTP Cookie File', '# Gerado pelo SOBEDESCE só para este download. Apagado em seguida.', '']
  for (const c of cookies || []) {
    const l = linhaNetscape(c)
    if (l) linhas.push(l)
  }
  return `${linhas.join('\n')}\n`
}

/**
 * Grava os cookies em `<dir>/cookies.txt` (modo 0600). Sem cookies válidos não grava nada (devolve null).
 * @returns {Promise<string|null>} caminho do arquivo
 */
export async function gravarCookies(dir, cookies) {
  const validos = (cookies || []).filter(c => linhaNetscape(c))
  if (!validos.length) return null
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, 'cookies.txt')
  await fs.rm(file, { force: true })
  // 'wx': nunca reaproveita um arquivo (ou link) que já estivesse lá.
  const fh = await fs.open(file, 'wx', 0o600)
  try {
    await fh.writeFile(textoNetscape(validos), 'utf8')
    await fh.chmod(0o600).catch(() => {}) // umask não afrouxa, mas garante no Windows/macOS também
  } finally {
    await fh.close()
  }
  return file
}

/** Apaga o arquivo de cookies (melhor esforço; nunca lança). */
export async function apagarCookies(file) {
  if (!file) return
  await fs.rm(file, { force: true }).catch(() => {})
}
