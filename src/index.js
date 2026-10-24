#!/usr/bin/env node
// Entrada do SOBEDESCE: sobe o motor e o servidor local, abre o navegador e encerra com pausa limpa.
// Importar este arquivo não inicia nada (o app de desktop e o demo usam startApp); só roda main() quando executado direto.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { APP_NAME, APP_VERSION, Settings, dataDir, dataPaths } from './config.js'
import { AuthManager } from './google/oauth.js'
import { CloudAuth } from './google/cloud-auth.js'
import { Hasher } from './engine/hasher.js'
import { TransferManager } from './engine/manager.js'
import { startServer, DEFAULT_PORT } from './server/app.js'
import { MobileReceiver } from './mobile/receiver.js'
import { VersionChecker } from './version.js'
import { Updater } from './updater.js'
import { ReferenciasService } from './referencias/service.js'
import { PedidosProxy } from './engine/pedidos-proxy.js'
import { PedidosFrames } from './engine/pedidos-frames.js'
import { PedidosFormato } from './referencias/pedidos-formato.js'
import { AcompanharCelular } from './engine/acompanhar.js'
import { UsoDiario } from './engine/uso.js'
import { closeHttp, requestJSON } from './net/http.js'

// O libuv tem 4 threads para todo o disco (gravações dos downloads, fdatasync dos checkpoints, leitura do MD5,
// stat/readdir da interface). Com vários arquivos a 1–10 Gbps, alguns fdatasync longos ocupam as 4 e as gravações
// param atrás deles. Precisa valer antes do primeiro uso do pool: por isso aqui, no carregamento do módulo.
export const THREADPOOL_SIZE = 16
if (!(Number(process.env.UV_THREADPOOL_SIZE) >= THREADPOOL_SIZE)) process.env.UV_THREADPOOL_SIZE = String(THREADPOOL_SIZE)

const LOCK_NAME = 'engine.lock'
const STARTING_GRACE_MS = 60_000 // trava sem URL ainda: outro motor está subindo
const PROBE_TIMEOUT_MS = 2000
const EXIT_DEADLINE_MS = 9500 // Ctrl+C sempre sai em menos de 10 s

// ─────────── trava de instância ───────────

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** O pid da trava pode ter sido reaproveitado depois de reiniciar o computador: confirma perguntando ao motor. */
async function engineAnswers(url) {
  try {
    const data = await requestJSON(`${url}/api/state`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return data?.ok === true && data?.app?.name === APP_NAME
  } catch {
    return false
  }
}

async function lockAlive(info) {
  if (!info || !pidAlive(Number(info.pid))) return false
  if (info.url) return engineAnswers(info.url)
  return Date.now() - (Number(info.startedAt) || 0) < STARTING_GRACE_MS
}

async function readLock(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** Cria <home>/engine.lock. Outro motor vivo na mesma pasta de dados → Error ALREADY_RUNNING (+ url). */
async function acquireLock(file) {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  for (let i = 0; i < 3; i++) {
    try {
      await fsp.writeFile(file, JSON.stringify({ pid: process.pid, url: null, startedAt: Date.now(), token }), { flag: 'wx', mode: 0o600 })
      return token
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    const info = await readLock(file)
    if (await lockAlive(info)) {
      const err = new Error('O SOBEDESCE já está aberto neste computador.')
      err.code = 'ALREADY_RUNNING'
      err.url = info.url || null
      throw err
    }
    // Trava de um motor que morreu (queda, computador desligado): pode sobrescrever.
    await fsp.rm(file, { force: true })
  }
  throw new Error('Não consegui criar a trava do motor (engine.lock). Tente de novo.')
}

async function updateLock(file, token, data) {
  const info = await readLock(file)
  if (info?.token !== token) return
  await fsp.writeFile(file, JSON.stringify({ ...info, ...data }), { mode: 0o600 }).catch(() => {})
}

async function releaseLock(file, token) {
  const info = await readLock(file)
  if (info?.token === token) await fsp.rm(file, { force: true }).catch(() => {})
}

// ─────────── navegador ───────────

/** Abre a URL no navegador padrão (melhor esforço). */
export function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => console.log(`  Não consegui abrir o navegador sozinho. Abra este endereço: ${url}\n`))
    child.unref()
  } catch {
    console.log(`  Não consegui abrir o navegador sozinho. Abra este endereço: ${url}\n`)
  }
}

function banner(url, root) {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const where = home && root.startsWith(home) ? `~${root.slice(home.length)}` : root
  console.log('')
  console.log(`  ${APP_NAME} ${APP_VERSION} está pronto.`)
  console.log('')
  console.log(`  Abra no navegador:   ${url}`)
  console.log(`  Seus dados ficam em: ${where}`)
  console.log('')
  console.log('  Para fechar, aperte Ctrl+C. As transferências pausam e continuam quando você abrir de novo.')
  console.log('')
}

// ─────────── app ───────────

/**
 * Sobe tudo: ajustes, contas, MD5, fila e servidor. Usado pelo `npm start`, pelo demo, pelos testes e pelo desktop.
 * @param {{ home?: string, port?: number, open?: boolean, desktop?: boolean, quiet?: boolean,
 *   managerOptions?: object, serverOptions?: object, mobileOptions?: object, cloudOptions?: object, versionOptions?: object,
 *   updaterOptions?: object, referenciasOptions?: object, acompanharOptions?: object, pedidosProxyOptions?: object, pedidosFramesOptions?: object, pedidosFormatoOptions?: object }} [opts]
 *   `managerOptions`/`serverOptions`/`mobileOptions`/`cloudOptions`/`versionOptions` (opcionais) vão para o
 *   TransferManager/startServer/MobileReceiver/CloudAuth/VersionChecker (os testes trocam peças, ex.: mobileOptions { port: 0, host: '127.0.0.1' }).
 *   `updaterOptions` vai para o Updater (src/updater.js), que só existe com `handoff` (o app de desktop empacotado
 *   passa: é o processo principal do Electron quem roda a troca e fecha o app).
 *   `segredos`: guarda do sistema para tokens e sessão (src/util/segredos.js); o app de desktop passa a do safeStorage
 *   do Electron (desktop/engine.js). Sem ela, JSON 0600 como sempre.
 * @returns {Promise<{ url: string, port: number, manager: TransferManager, auth: AuthManager, settings: Settings,
 *   hasher: Hasher, paths: object, server: object, mobile: MobileReceiver, versao: VersionChecker, shutdown(): Promise<void> }>}
 */
export async function startApp({ home, port, open = true, desktop = false, quiet = false, segredos = null, managerOptions = {}, serverOptions = {}, mobileOptions = {}, cloudOptions = {}, versionOptions = {}, updaterOptions = {}, referenciasOptions = {}, acompanharOptions = {}, usoOptions = {}, pedidosProxyOptions = {}, pedidosFramesOptions = {}, pedidosFormatoOptions = {} } = {}) {
  const root = home ? path.resolve(home) : dataDir()
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const paths = dataPaths(root)
  const lockFile = path.join(root, LOCK_NAME)
  const token = await acquireLock(lockFile)

  let settings, auth, hasher, manager, server, mobile, versao, referencias, acompanhar, uso, pedidosProxy, pedidosFrames, pedidosFormato
  try {
    settings = new Settings(paths.settings)
    await settings.load()
    // Conta SOBEDESCE (fluxo de dispositivo): os Drives dela aparecem junto das contas conectadas neste computador.
    // `segredos`: guarda do sistema (no app de desktop, o safeStorage do Electron pelo processo principal; src/util/segredos.js).
    auth = new AuthManager({ paths, segredos, cloud: new CloudAuth({ paths, segredos, ...cloudOptions }) })
    await auth.init()
    hasher = new Hasher({ cacheFile: paths.hashCache, workers: 2 })
    manager = new TransferManager({ settings, auth, hasher, paths, ...managerOptions })
    await manager.init()
    // Referências (vídeos e fotos salvos nas coleções do Drive; src/referencias/service.js). Só funciona com a conta SOBEDESCE.
    referencias = new ReferenciasService({ paths, settings, auth, manager, ...referenciasOptions })
    await referencias.init()
    // Acompanhar pelo celular: o andamento das transferências vai para a conta SOBEDESCE (ajuste acompanharCelular).
    acompanhar = new AcompanharCelular({ manager, cloud: auth.cloud, settings, ...acompanharOptions })
    acompanhar.start()
    // Uso por dia (só números) para o admin da conta SOBEDESCE (src/engine/uso.js).
    uso = new UsoDiario({ manager, cloud: auth.cloud, file: paths.uso, ...usoOptions })
    await uso.init()
    uso.start()
    // "Gerar proxy" pedido pelo celular: este computador pega da conta SOBEDESCE e gera (src/engine/pedidos-proxy.js).
    pedidosProxy = new PedidosProxy({ cloud: auth.cloud, manager, ...pedidosProxyOptions })
    pedidosProxy.start()
    // Verificação do conversor da prévia leve (ffmpeg do app, do sistema ou avconvert): em segundo plano, vai para o log.
    if (!quiet || desktop) manager.previas?.init?.().catch(() => {})
    // Recepção do celular pelo Wi-Fi: liga/desliga sozinha conforme o ajuste mobileReceive.
    mobile = new MobileReceiver({ settings, auth, manager, hasher, paths, ...mobileOptions })
    // Aviso de versão nova: pergunta ao mesmo site da conta SOBEDESCE (só nos builds do GitHub Actions; ver src/version.js).
    // "Atualizar" pelo próprio app: só no app de desktop empacotado (desktop/engine.js passa o handoff).
    const updater = updaterOptions.handoff ? new Updater({ stateDir: root, log: (...a) => console.warn('[sobedesce]', ...a), ...updaterOptions }) : null
    versao = new VersionChecker({ settings, baseUrl: auth.cloud?.baseUrl, log: (...a) => console.warn('[sobedesce]', ...a), updater, ...versionOptions })
    const wanted = port ?? (Number(process.env.SOBEDESCE_PORT) || DEFAULT_PORT)
    server = await startServer({ port: wanted, settings, auth, manager, hasher, paths, desktop, mobile, versao, referencias, ...serverOptions })
    // Frames pedido pelo celular: o serviço do Frames vem com o servidor (src/server/frames.js; src/engine/pedidos-frames.js).
    pedidosFrames = new PedidosFrames({ cloud: auth.cloud, frames: () => server?.ctx?.frames ?? null, ...pedidosFramesOptions })
    pedidosFrames.start()
    // "Baixar como…" pedido pelo celular (MP3 320, WAV…): este computador converte e sobe ao lado do original.
    pedidosFormato = new PedidosFormato({ cloud: auth.cloud, referencias: () => referencias, ...pedidosFormatoOptions })
    pedidosFormato.start()
    // Falhar aqui (porta ocupada, pasta sem permissão) não impede o app de abrir: o erro aparece em Ajustes → Celular.
    await mobile.init().catch(err => console.warn('[sobedesce] recepção do celular não iniciou:', err?.message))
  } catch (err) {
    versao?.stop()
    await acompanhar?.close()
    await uso?.close()
    await pedidosProxy?.close()
    await pedidosFrames?.close()
    await pedidosFormato?.close()
    await referencias?.close()
    await mobile?.close().catch(() => {})
    await server?.close().catch(() => {})
    await manager?.shutdown().catch(() => {})
    await hasher?.close().catch(() => {})
    auth?.close()
    await releaseLock(lockFile, token)
    throw err
  }
  await updateLock(lockFile, token, { url: server.url, port: server.port })
  versao.start()
  if (!quiet) banner(server.url, root)
  if (open && !desktop && process.env.SOBEDESCE_NO_OPEN !== '1') openBrowser(server.url)

  let stopping = null
  const shutdown = () => {
    stopping ??= (async () => {
      versao.stop()
      // Última notícia para o celular ("o app foi fechado"), com tempo curto; depois para de mandar.
      await acompanhar.close({ final: true }).catch(() => {})
      await uso.close({ final: true }).catch(() => {})
      await pedidosProxy.close()
      await pedidosFrames?.close()
      await pedidosFormato?.close()
      await referencias.close()
      // Primeiro fecha a porta da rede local (o que já chegou do celular fica gravado para continuar depois).
      await mobile.close().catch(err => console.warn('[sobedesce] erro ao fechar a recepção do celular:', err?.message))
      try {
        await manager.shutdown()
      } catch (err) {
        console.warn('[sobedesce] erro ao pausar as transferências:', err?.message)
      }
      await server.close().catch(() => {})
      await hasher.close().catch(() => {})
      auth.close()
      await releaseLock(lockFile, token)
    })()
    return stopping
  }
  return { url: server.url, port: server.port, manager, auth, settings, hasher, paths, server, mobile, versao, referencias, acompanhar, uso, pedidosProxy, pedidosFrames, pedidosFormato, shutdown }
}

async function main() {
  const open = process.env.SOBEDESCE_NO_OPEN !== '1'
  let app
  try {
    app = await startApp({ open, desktop: process.env.SOBEDESCE_DESKTOP === '1' })
  } catch (err) {
    if (err.code === 'ALREADY_RUNNING') {
      console.log(`\n  O SOBEDESCE já está aberto${err.url ? ` em ${err.url}` : ''}.\n`)
      if (err.url && open) openBrowser(err.url)
    } else {
      console.error(`\n  Não deu para iniciar o SOBEDESCE: ${err.message}\n`)
      process.exitCode = 1
    }
    await closeHttp().catch(() => {})
    return
  }

  let stopping = false
  const stop = async (code = 0) => {
    if (stopping) {
      console.log('  Saindo agora.')
      process.exit(code)
    }
    stopping = true
    console.log('\n  Pausando as transferências e guardando a fila…')
    const deadline = setTimeout(() => {
      console.log('  Demorou demais; saindo assim mesmo (o progresso já gravado continua valendo).')
      process.exit(code)
    }, EXIT_DEADLINE_MS)
    deadline.unref()
    await app.shutdown().catch(() => {})
    await closeHttp().catch(() => {})
    console.log('  Pronto. Até a próxima!\n')
    process.exit(code)
  }
  process.on('SIGINT', () => stop(0))
  process.on('SIGTERM', () => stop(0))
  process.on('unhandledRejection', err => console.error('[sobedesce] erro não tratado:', err?.stack || err))
  process.on('uncaughtException', err => {
    console.error('[sobedesce] erro inesperado:', err?.stack || err)
    stop(1)
  })
}

function isMain() {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (isMain()) main()
