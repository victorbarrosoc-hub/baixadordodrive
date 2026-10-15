// Ajudantes compartilhados pelos testes: Drive falso com uma conta já conectada (pelo fluxo OAuth de verdade),
// pastas temporárias e arquivos de teste determinísticos. Mantenha pequeno e estável: vários testes dependem disto.
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { request } from 'undici'
import { startMockDrive, virtualBytes } from './mock-drive.js'
import { dataPaths } from '../src/config.js'
import { dispatcherFor } from '../src/net/http.js'
import { AuthManager } from '../src/google/oauth.js'
import { DriveClient } from '../src/google/drive.js'

const MiB = 1024 * 1024

/** redirect_uri usado nos logins de teste (o mock só exige que seja loopback http). */
export const REDIRECT_URI = 'http://127.0.0.1:4317/oauth/callback'

/** Pasta temporária nova (quem chama apaga). */
export function makeTmpDir(prefix = 'sobedesce-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/**
 * Começa um login e segue a tela de consentimento do mock (o 302) à mão.
 * Devolve o que o Google mandaria para o callback: { code, state, error, scope, redirectUri }.
 */
export async function authorizeInMock(auth, redirectUri = REDIRECT_URI) {
  const { url } = auth.beginLogin(redirectUri)
  const res = await request(url, { method: 'GET', dispatcher: dispatcherFor(url) })
  await res.body.dump()
  const location = res.headers.location
  if (res.statusCode !== 302 || !location) throw new Error(`o consentimento do mock não redirecionou (HTTP ${res.statusCode})`)
  const back = new URL(location)
  const get = k => back.searchParams.get(k)
  return { code: get('code'), state: get('state'), error: get('error'), scope: get('scope'), redirectUri }
}

/** Login completo pelo fluxo real (beginLogin → consentimento → completeLogin). Devolve a conta pública. */
export async function loginWithMock(auth, redirectUri = REDIRECT_URI) {
  const cb = await authorizeInMock(auth, redirectUri)
  return auth.completeLogin({ code: cb.code, state: cb.state, error: cb.error, redirectUri })
}

/**
 * Sobe o Drive falso, aponta os endpoints para ele, cria SOBEDESCE_HOME temporário, configura a chave OAuth
 * do mock e conecta a conta. Chame `cleanup()` no fim (t.after). closeHttp() fica para o after() do arquivo.
 * As `failures` só são ligadas depois do login (o login não sorteia falhas, então a sequência do PRNG é a mesma).
 * @param {object} [mockOptions] opções de startMockDrive
 */
export async function setupDrive(mockOptions = {}) {
  const home = await makeTmpDir()
  process.env.SOBEDESCE_HOME = home
  let mock = null
  try {
    const { failures, ...options } = mockOptions
    mock = await startMockDrive(options)
    mock.applyEnv()
    const paths = dataPaths(home)
    const auth = new AuthManager({ paths })
    await auth.init()
    await auth.setClientCredentials(mock.client)
    const account = await loginWithMock(auth)
    if (failures) mock.setOptions({ failures })
    const drive = new DriveClient(auth, account.id)
    let cleaned = false
    const cleanup = async () => {
      if (cleaned) return
      cleaned = true
      await mock.close()
      await fs.rm(home, { recursive: true, force: true, maxRetries: 3 })
    }
    return { mock, home, paths, settingsFile: paths.settings, auth, drive, accountId: account.id, account, cleanup }
  } catch (err) {
    await mock?.close().catch(() => {})
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

/**
 * Grava um arquivo de `size` bytes com conteúdo determinístico por `seed` (rápido: GB/s).
 * O conteúdo é o mesmo do arquivo virtual do mock com essa semente (addFile(name, parent, { size, seed })).
 * Devolve o MD5 (hex).
 */
export async function randomFile(filePath, size, seed = 1) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const hash = crypto.createHash('md5')
  const fh = await fs.open(filePath, 'w')
  try {
    for (let pos = 0; pos < size;) {
      const n = Math.min(4 * MiB, size - pos)
      const buf = virtualBytes(seed, pos, pos + n)
      hash.update(buf)
      await fh.write(buf, 0, n, pos)
      pos += n
    }
  } finally {
    await fh.close()
  }
  return hash.digest('hex')
}

/** MD5 (hex) de um arquivo local. */
export async function md5File(filePath) {
  const hash = crypto.createHash('md5')
  for await (const chunk of createReadStream(filePath, { highWaterMark: 4 * MiB })) hash.update(chunk)
  return hash.digest('hex')
}

/** Espera `fn()` (pode ser async) ficar verdadeiro; falha depois de `timeoutMs`. */
export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 10, message = 'a condição não aconteceu a tempo' } = {}) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - t0 > timeoutMs) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}
