// Impede o computador de dormir enquanto há transferência ativa (um download de 300 GB não pode parar no meio da noite).
// Cada sistema tem seu jeito; se não der, segue sem (só avisa no log uma vez).
import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const live = new Set() // ajudantes vivos, para matar ao sair
let exitHookInstalled = false

function killHelper(h) {
  try {
    // No Linux o ajudante roda num grupo próprio: matar o grupo leva junto os filhos (senão sobram processos órfãos).
    if (h.group && h.child.pid) process.kill(-h.child.pid, 'SIGTERM')
    else h.child.kill()
  } catch {
    try {
      h.child.kill()
    } catch {}
  }
}

function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const h of live) killHelper(h)
    live.clear()
  })
}

/** Procura um executável no PATH (sem rodar nada). */
function findInPath(name, envPath = process.env.PATH || '') {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue
    const full = path.join(dir, name)
    try {
      fs.accessSync(full, fs.constants.X_OK)
      if (fs.statSync(full).isFile()) return full
    } catch {}
  }
  return null
}

// Windows: SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) renovado a cada 30 s.
// O laço também termina se o SOBEDESCE morrer sem conseguir avisar.
function windowsScript(pid) {
  return [
    "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    'Add-Type -Namespace SobeDesce -Name Power -MemberDefinition $sig',
    'while ($true) {',
    '  [SobeDesce.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null',
    `  if (-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) { exit }`,
    '  Start-Sleep -Seconds 30',
    '}',
  ].join('\n')
}

/**
 * Comando do ajudante para a plataforma, ou null se não houver como.
 * @returns {{ cmd: string, args: string[], group: boolean } | null}
 */
export function helperCommand(platform = process.platform, pid = process.pid, envPath = process.env.PATH) {
  if (platform === 'darwin') {
    // -w: o caffeinate sai sozinho quando o SOBEDESCE terminar, mesmo se ele cair.
    return { cmd: 'caffeinate', args: ['-dimsu', '-w', String(pid)], group: false }
  }
  if (platform === 'win32') {
    // -EncodedCommand evita problemas de aspas na linha de comando do Windows.
    const encoded = Buffer.from(windowsScript(pid), 'utf16le').toString('base64')
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], group: false }
  }
  if (platform === 'linux') {
    if (!findInPath('systemd-inhibit', envPath)) return null
    // Em vez de "sleep infinity", um laço que termina quando o SOBEDESCE some: se o app cair, a trava não fica para sempre.
    const watch = `while kill -0 ${pid} 2>/dev/null; do sleep 10; done`
    return {
      cmd: 'systemd-inhibit',
      args: ['--what=idle:sleep', '--who=SOBEDESCE', '--why=Transferências em andamento', '--mode=block', 'sh', '-c', watch],
      group: true,
    }
  }
  return null
}

export class KeepAwake {
  /**
   * @param {{ platform?: string, spawn?: Function, log?: Function, retryMs?: number }} [opts] (opções só para testes)
   */
  constructor({ platform = process.platform, spawn = nodeSpawn, log = null, retryMs = 30_000 } = {}) {
    this.platform = platform
    this.spawnFn = spawn
    this.log = log || ((...args) => console.warn('[keep-awake]', ...args))
    this.retryMs = retryMs
    this.wanted = false
    this.helper = null // { child, group, startedAt }
    this.unsupported = false
    this.warned = false
    this.quickFailures = 0
    this.retryTimer = null
  }

  /** true enquanto o ajudante está rodando (o computador não vai dormir). */
  get active() {
    return !!this.helper
  }

  #warn(msg) {
    if (this.warned) return
    this.warned = true
    try {
      this.log(msg)
    } catch {}
  }

  /** Liga/desliga. Pode chamar quantas vezes quiser: só existe um ajudante por vez. */
  setActive(active) {
    this.wanted = !!active
    if (this.wanted) this.#start()
    else this.#stopHelper()
  }

  stop() {
    this.setActive(false)
  }

  #start() {
    if (this.helper || this.unsupported || this.retryTimer) return
    const spec = helperCommand(this.platform)
    if (!spec) {
      this.unsupported = true
      this.#warn('não há como impedir o computador de dormir neste sistema; seguindo sem.')
      return
    }
    let child
    try {
      child = this.spawnFn(spec.cmd, spec.args, { stdio: 'ignore', windowsHide: true, detached: spec.group })
    } catch (err) {
      this.unsupported = true
      this.#warn(`não consegui impedir o computador de dormir (${err.message}).`)
      return
    }
    const helper = { child, group: spec.group, startedAt: Date.now() }
    this.helper = helper
    live.add(helper)
    installExitHook()
    child.unref?.()
    child.on?.('error', err => {
      if (err?.code === 'ENOENT') this.unsupported = true
      this.#warn(`não consegui impedir o computador de dormir (${err?.message || err}).`)
      this.#lost(helper)
    })
    child.on?.('exit', (code, signal) => {
      if (this.helper === helper) this.#warn(`o ajudante que impede o computador de dormir parou (${code ?? signal}).`)
      this.#lost(helper)
    })
  }

  /** O ajudante saiu sem a gente pedir: tenta de novo daqui a pouco, mas desiste se ele sempre morre logo. */
  #lost(helper) {
    if (this.helper !== helper) return live.delete(helper)
    this.#forget(helper)
    this.quickFailures = Date.now() - helper.startedAt < 5000 ? this.quickFailures + 1 : 0
    if (this.quickFailures >= 3) this.unsupported = true
    if (!this.wanted || this.unsupported || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.wanted) this.#start()
    }, this.retryMs)
    this.retryTimer.unref?.()
  }

  #forget(helper) {
    live.delete(helper)
    if (this.helper === helper) this.helper = null
  }

  #stopHelper() {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const helper = this.helper
    if (!helper) return
    this.#forget(helper)
    killHelper(helper)
  }
}
