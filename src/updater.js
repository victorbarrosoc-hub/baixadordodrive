// "Atualizar" pelo próprio app (Mac e Windows, só no app empacotado). Sem assinatura da Apple/Microsoft, o que
// trava a instalação é a marca de "veio da internet" que o navegador põe no arquivo (a quarentena do macOS e a
// Mark-of-the-Web do Windows). Arquivo baixado pelo próprio app não ganha essa marca. Então o motor:
//
//   1. baixa o instalador de <site>/baixar/<plataforma>?build=N (segue o redirecionamento para o GitHub), com
//      progresso. Isso já acontece sozinho em segundo plano quando sai uma versão nova (src/version.js);
//   2. confere o SHA-256 com o que o versao.json publicou (sem hash ou hash diferente = não instala);
//   3. prepara a troca:
//        Mac: monta o .dmg (hdiutil), copia o app novo para o lado do atual (ditto), desmonta e tira atributos (xattr -cr);
//        Windows: o próprio instalador NSIS, que roda em silêncio (/S);
//      Pronto: fica esperando o "Atualizar agora" (fase 'pronto');
//   4. grava um script pequeno e entrega ao processo principal do Electron (handoff), que o roda solto e fecha o app.
//      O script espera o app fechar, troca o app (Mac: renomeia o antigo, põe o novo no lugar) ou roda o instalador
//      (Windows) e abre o app de novo. Se a troca falhar, o app antigo volta e o script deixa uma marca
//      (atualizacao-falhou.json na pasta de dados): na próxima abertura o Atualizar some e fica o Baixar de sempre.
//
// Tudo que toca o sistema (baixar, rodar comandos, conferir permissão, entregar o script) é injetável: os testes
// trocam por funções falsas.
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { fetch as undiciFetch } from 'undici'
import { dispatcherFor } from './net/http.js'

const MARK_FILE = 'atualizacao-falhou.json'
const MAX_BYTES = 2 * 1024 ** 3
const STALL_MS = 60_000
const PROGRESS_MS = 250
const SHA256 = /^[0-9a-f]{64}$/

const PLATAFORMAS = { darwin: 'mac', win32: 'windows' }

/** Erro que desliga o Atualizar desta versão (a interface volta para o Baixar). */
function definitivo(message) {
  return Object.assign(new Error(message), { definitivo: true })
}

/** Texto entre aspas simples para sh: 'a'\''b'. */
export function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** Texto entre aspas simples para PowerShell: 'a''b'. */
export function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

/** /Applications/SOBEDESCE.app/Contents/MacOS/SOBEDESCE → /Applications/SOBEDESCE.app (null se não for um .app). */
export function macBundle(appExe) {
  if (!appExe) return null
  let p = path.posix.normalize(String(appExe))
  for (let i = 0; i < 4 && p !== '/'; i++) {
    if (p.endsWith('.app')) return p
    p = path.posix.dirname(p)
  }
  return null
}

/**
 * Comando que o processo principal roda para entregar a troca (desktop/main.js). Fica aqui para ser testado.
 * @returns {{ cmd: string, args: string[] } | null}
 */
export function handoffCommand(platform, script) {
  if (platform === 'darwin') return { cmd: '/bin/sh', args: [script] }
  if (platform === 'win32') return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script] }
  return null
}

/** O script veio do motor e está na pasta temporária do sistema, numa pasta de atualização? (o processo principal confere) */
export function isHandoffScript(script, tmpRoot = os.tmpdir()) {
  if (typeof script !== 'string' || !path.isAbsolute(script) || script.includes('\0')) return false
  const name = path.basename(script)
  if (name !== 'trocar.sh' && name !== 'trocar.ps1') return false
  let real, root
  try {
    real = fs.realpathSync(script)
    root = fs.realpathSync(tmpRoot)
  } catch {
    return false
  }
  const rel = path.relative(root, real)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && /^sobedesce-atualizacao-/.test(rel.split(path.sep)[0])
}

/** Script do Mac: espera o app fechar, troca o .app (o antigo volta se algo falhar) e abre de novo. */
export function macScript({ pid, app, novo, velho, marca, tmp, build }) {
  const falha = motivo => `printf '%s' ${shQuote(JSON.stringify({ build, motivo }))} > "$MARCA"`
  return `#!/bin/sh
# SOBEDESCE: troca o app pela versão nova depois que ele fechar (gerado por src/updater.js).
PID=${Number(pid)}
APP=${shQuote(app)}
NOVO=${shQuote(novo)}
VELHO=${shQuote(velho)}
MARCA=${shQuote(marca)}
TMP=${shQuote(tmp)}
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -gt 240 ] && break
  sleep 0.5
done
if kill -0 "$PID" 2>/dev/null; then
  ${falha('O app não fechou a tempo para trocar.')}
  rm -rf "$NOVO" "$TMP"
  exit 1
fi
rm -rf "$VELHO"
if mv "$APP" "$VELHO"; then
  if mv "$NOVO" "$APP"; then
    xattr -cr "$APP" 2>/dev/null
    rm -rf "$VELHO"
  else
    mv "$VELHO" "$APP"
    rm -rf "$NOVO"
    ${falha('O macOS não deixou pôr o app novo no lugar.')}
  fi
else
  rm -rf "$NOVO"
  ${falha('O macOS não deixou trocar o app.')}
fi
open "$APP"
rm -rf "$TMP"
`
}

/** Script do Windows: espera o app fechar, roda o instalador em silêncio e abre o app (se o instalador não abriu). */
export function winScript({ pid, setup, exe, marca, tmp, build }) {
  const falha = motivo => `Set-Content -LiteralPath $marca -Value ${psQuote(JSON.stringify({ build, motivo }))} -Encoding UTF8`
  return `# SOBEDESCE: instala a versão nova depois que o app fechar (gerado por src/updater.js).
$ErrorActionPreference = 'Continue'
$appPid = ${Number(pid)}
$setup = ${psQuote(setup)}
$exe = ${psQuote(exe)}
$marca = ${psQuote(marca)}
$tmp = ${psQuote(tmp)}
try { Wait-Process -Id $appPid -Timeout 120 -ErrorAction Stop } catch {}
if (Get-Process -Id $appPid -ErrorAction SilentlyContinue) {
  ${falha('O app não fechou a tempo para atualizar.')}
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}
Unblock-File -LiteralPath $setup -ErrorAction SilentlyContinue
$ok = $false
try {
  # Espera só o instalador (Start-Process -Wait esperaria também o app que ele abre com --force-run).
  $p = Start-Process -FilePath $setup -ArgumentList '/S', '--updated', '--force-run' -PassThru -ErrorAction Stop
  $null = $p.Handle
  $p.WaitForExit()
  $ok = ($p.ExitCode -eq 0)
} catch {}
if (-not $ok) { ${falha('O instalador do Windows não terminou.')} }
Start-Sleep -Seconds 3
if (-not (Get-Process -Name 'SOBEDESCE' -ErrorAction SilentlyContinue)) {
  if (Test-Path -LiteralPath $exe) { Start-Process -FilePath $exe }
}
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
`
}

function canWriteSync(p) {
  try {
    fs.accessSync(p, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function execFileP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10 * 60_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: String(stderr || '').trim() }))
      resolve(String(stdout || ''))
    })
  })
}

/**
 * Baixa `url` para `file`, calculando o SHA-256 no caminho. Segue redirecionamentos (o site manda para o GitHub).
 * @returns {Promise<string>} o SHA-256 em hexadecimal
 */
export async function downloadTo(url, file, { fetch = (u, o) => undiciFetch(u, { ...o, dispatcher: dispatcherFor(u) }), onProgress = () => {}, stallMs = STALL_MS, maxBytes = MAX_BYTES } = {}) {
  const ac = new AbortController()
  let stall = setTimeout(() => ac.abort(new Error('o download parou de andar')), stallMs)
  const poke = () => {
    clearTimeout(stall)
    stall = setTimeout(() => ac.abort(new Error('o download parou de andar')), stallMs)
  }
  const out = fs.createWriteStream(file, { mode: 0o600 })
  const closed = new Promise((resolve, reject) => {
    out.on('close', resolve)
    out.on('error', reject)
  })
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ac.signal, headers: { accept: 'application/octet-stream' } })
    if (!res.ok || !res.body) throw new Error(`o site respondeu ${res.status}`)
    const total = Number(res.headers.get('content-length')) || 0
    if (total > maxBytes) throw new Error('o instalador é grande demais')
    const hash = crypto.createHash('sha256')
    let got = 0
    onProgress(0, total)
    for await (const chunk of res.body) {
      poke()
      got += chunk.length
      if (got > maxBytes) throw new Error('o instalador é grande demais')
      hash.update(chunk)
      if (!out.write(chunk)) await new Promise((r, j) => { out.once('drain', r); out.once('error', j) })
      onProgress(got, total)
    }
    if (total && got !== total) throw new Error('o download veio incompleto')
    out.end()
    await closed
    return hash.digest('hex')
  } catch (err) {
    out.destroy()
    await closed.catch(() => {})
    throw ac.signal.aborted && ac.signal.reason instanceof Error ? ac.signal.reason : err
  } finally {
    clearTimeout(stall)
  }
}

/**
 * @fires Updater#change a cada mudança de fase e no progresso (no máximo a cada 250 ms)
 *
 * status() = { disponivel, motivo (por que não dá, em PT-BR), fase: null|'baixando'|'conferindo'|'preparando'|
 *   'pronto'|'reiniciando'|'erro', build, recebido, total, erro, bloqueado (build em que o Atualizar ficou desligado),
 *   aplicar (a pessoa já pediu "Atualizar agora": a troca segue sozinha assim que ficar pronto) }
 */
export class Updater extends EventEmitter {
  /**
   * @param {{ platform?: string, appExe?: string, appPid?: number, stateDir?: string,
   *   handoff: (job: { script: string }) => void | Promise<void>,
   *   download?: (url: string, file: string, onProgress: Function) => Promise<string>,
   *   run?: (cmd: string, args: string[]) => Promise<string>, canWrite?: (p: string) => boolean,
   *   tmpRoot?: string, log?: Function, progressMs?: number }} opts
   */
  constructor({ platform = process.platform, appExe, appPid, stateDir, handoff, download, run, canWrite, tmpRoot, log = () => {}, progressMs = PROGRESS_MS } = {}) {
    super()
    this.platform = platform
    this.plataforma = PLATAFORMAS[platform] || null
    this.appExe = appExe ? String(appExe) : ''
    this.appPid = Number(appPid) || 0
    this.stateDir = stateDir || null
    this.handoff = handoff || null
    this.download = download || ((url, file, onProgress) => downloadTo(url, file, { onProgress }))
    this.run = run || execFileP
    this.canWrite = canWrite || canWriteSync
    this.tmpRoot = tmpRoot || os.tmpdir()
    this.log = log
    this.progressMs = progressMs
    this.fase = null
    this.build = null
    this.recebido = 0
    this.total = 0
    this.erro = null
    this.bloqueado = 0
    this.lastProgress = 0
    this.job = null
    this.pronto = null // { build, script, tmp }: baixado, conferido e preparado, esperando o "Atualizar agora"
    this.aplicar = false
    this.deNovo = false // o último erro passa sozinho (rede, versão ainda subindo): o aviso tenta de novo mais tarde
    this.motivo = this.#check()
    this.#readMark()
  }

  get disponivel() {
    return !this.motivo
  }

  /** Por que este app não consegue se atualizar sozinho (null = consegue). */
  #check() {
    if (!this.plataforma) return 'Neste sistema o app não se atualiza sozinho.'
    if (!this.handoff || !this.appExe || !this.appPid) return 'Só o app instalado se atualiza sozinho.'
    if (this.plataforma === 'mac') {
      const bundle = macBundle(this.appExe)
      if (!bundle) return 'Não encontrei o app para trocar.'
      if (bundle.includes('/AppTranslocation/')) return 'Mova o SOBEDESCE para Aplicativos e abra de novo para ele se atualizar sozinho.'
      if (bundle.startsWith('/Volumes/')) return 'O SOBEDESCE está aberto direto do disco de instalação. Arraste para Aplicativos e abra de lá.'
      if (!this.canWrite(path.posix.dirname(bundle)) || !this.canWrite(bundle)) return 'Sem permissão para trocar o app nesta pasta. Use Baixar.'
      this.bundle = bundle
    } else if (!this.canWrite(path.win32.dirname(this.appExe))) {
      return 'Sem permissão para trocar o app nesta pasta. Use Baixar.'
    }
    return null
  }

  /** A troca anterior falhou (o script deixou a marca): desliga o Atualizar daquela versão e mostra o motivo. */
  #readMark() {
    if (!this.stateDir) return
    const file = path.join(this.stateDir, MARK_FILE)
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      return
    }
    try {
      fs.rmSync(file, { force: true })
    } catch {}
    try {
      const m = JSON.parse(raw.replace(/^﻿/, ''))
      const build = Number(m?.build)
      this.bloqueado = Number.isSafeInteger(build) && build > 0 ? build : 0
      this.fase = 'erro'
      this.build = this.bloqueado || null
      this.erro = `A atualização anterior não terminou: ${typeof m?.motivo === 'string' ? m.motivo.slice(0, 200) : 'algo deu errado.'} Use Baixar.`
    } catch {}
  }

  /** Esta versão pode ser instalada pelo app? */
  podeInstalar(build) {
    return this.disponivel && !(this.bloqueado && build <= this.bloqueado)
  }

  get ocupado() {
    return !!this.job
  }

  status() {
    return {
      disponivel: this.disponivel,
      motivo: this.motivo,
      fase: this.fase,
      build: this.build,
      recebido: this.recebido,
      total: this.total,
      erro: this.erro,
      bloqueado: this.bloqueado,
      aplicar: this.aplicar,
      deNovo: this.fase === 'erro' && !!this.deNovo,
    }
  }

  #set(patch, { progress = false } = {}) {
    Object.assign(this, patch)
    if (progress) {
      const now = Date.now()
      if (now - this.lastProgress < this.progressMs) return
      this.lastProgress = now
    }
    this.emit('change', this.status())
  }

  /** Já está baixado e preparado este build (ou um mais novo)? */
  prontoPara(build) {
    return !!this.pronto && this.pronto.build >= build
  }

  /**
   * Baixa, confere e prepara a troca, sem fechar o app: termina na fase 'pronto' (ou já troca, se `aplicar`).
   * Volta logo (o trabalho segue em segundo plano; acompanhe pelo 'change'). Lança Error com `status` se não fizer
   * sentido começar. `recheck` (opcional) pergunta ao site de novo, se o arquivo não bater.
   * @param {{ build: number, url: string, sha256: string, recheck?: () => Promise<{ build: number, sha256: string } | null>, aplicar?: boolean }} release
   */
  preparar({ build, url, sha256, recheck, aplicar = false } = {}) {
    if (aplicar && !this.aplicar) {
      this.aplicar = true
      if (this.job) this.emit('change', this.status()) // a interface troca para "Atualizando"
    }
    if (this.job) return this.job
    if (this.prontoPara(build)) return this.aplicar ? this.trocar() : Promise.resolve(this.status())
    if (!this.disponivel) throw Object.assign(new Error(this.motivo), { status: 409 })
    if (!this.podeInstalar(build)) throw Object.assign(new Error('Esta versão não dá para instalar pelo app. Use Baixar.'), { status: 409 })
    const hash = String(sha256 || '').toLowerCase()
    if (!SHA256.test(hash)) {
      this.bloqueado = Math.max(this.bloqueado, build)
      this.#set({ fase: 'erro', build, erro: 'O site não publicou a conferência (SHA-256) desta versão. Use Baixar.' })
      throw Object.assign(new Error(this.erro), { status: 409 })
    }
    this.#set({ fase: 'baixando', build, recebido: 0, total: 0, erro: null })
    this.job = this.#preparar({ build, url, sha256: hash, recheck }).finally(() => {
      this.job = null
    })
    return this.job.then(st => (st.fase === 'pronto' && this.aplicar ? this.trocar() : st))
  }

  /** Baixa, confere, prepara e já troca (o "Atualizar" de antes, numa chamada só). */
  install(release = {}) {
    return this.preparar({ ...release, aplicar: true })
  }

  /** "Atualizar agora": entrega a troca preparada ao processo principal, que fecha o app e abre a versão nova. */
  async trocar() {
    const p = this.pronto
    if (this.fase === 'reiniciando') return this.status()
    if (!p) throw Object.assign(new Error('A versão nova ainda não está pronta.'), { status: 409 })
    if (!fs.existsSync(p.script)) {
      this.pronto = null
      this.#set({ fase: 'erro', aplicar: false, erro: 'A versão baixada sumiu da pasta temporária. Tente de novo.' })
      return this.status()
    }
    this.#set({ fase: 'reiniciando' })
    try {
      await this.handoff({ script: p.script })
      return this.status()
    } catch (err) {
      this.log('não consegui entregar a troca:', err?.message || err)
      this.#set({ fase: 'erro', aplicar: false, erro: 'Não consegui reiniciar o app para atualizar. Use Baixar.' })
      return this.status()
    }
  }

  /** Esquece a versão preparada (saiu uma mais nova): apaga os arquivos dela. */
  async descartar() {
    const p = this.pronto
    this.pronto = null
    if (p?.tmp) await fsp.rm(p.tmp, { recursive: true, force: true }).catch(() => {})
    if (p?.novo) await this.#apagarApp(p.novo).catch(() => {})
  }

  /**
   * Apaga um .app com o rm do sistema. O fs do Electron (o motor roda num utilityProcess) enxerga o app.asar como
   * pasta, e o fs.rm recursivo para em ENOTEMPTY dentro de Contents/Resources: um .SOBEDESCE-atualizacao.app que
   * sobrou de uma troca que não aconteceu travava toda atualização seguinte.
   */
  async #apagarApp(p) {
    await this.run('/bin/rm', ['-rf', p])
  }

  async #preparar({ build, url, sha256, recheck }) {
    await this.descartar()
    await this.#limparSobras()
    const tmp = await fsp.mkdtemp(path.join(this.tmpRoot, 'sobedesce-atualizacao-'))
    let guardado = false
    try {
      const file = path.join(tmp, this.plataforma === 'mac' ? 'SOBEDESCE.dmg' : 'SOBEDESCE-setup.exe')
      let got
      try {
        got = await this.download(url, file, (recebido, total) => this.#set({ recebido, total }, { progress: true }))
      } catch (err) {
        this.log('não consegui baixar a versão nova:', err?.message || err)
        throw Object.assign(new Error('Não consegui baixar a versão nova. Confira a internet: tento de novo daqui a pouco.'), { deNovo: true })
      }
      this.#set({ fase: 'conferindo', recebido: this.total || this.recebido })
      got = String(got).toLowerCase()
      if (got !== sha256) {
        // O mais comum: saiu um build mais novo depois da última conferida. Se a conferência nova bate com o arquivo,
        // é ele que vai ser instalado. Senão, erro sem travar o Atualizar: nada que não bate é instalado, e tentar de
        // novo daqui a pouco resolve quando o site ainda está publicando (os instaladores sobem antes do versao.json).
        const novo = recheck ? await recheck().catch(() => null) : null
        if (!(novo && novo.build >= build && String(novo.sha256 || '').toLowerCase() === got && this.podeInstalar(novo.build))) {
          throw Object.assign(new Error('A versão nova ainda está sendo publicada. Tento de novo em alguns minutos.'), { deNovo: true })
        }
        this.log(`saiu o build ${novo.build} durante a atualização: instalando ele`)
        build = novo.build
        this.#set({ build })
      }
      this.#set({ fase: 'preparando' })
      const script = this.plataforma === 'mac' ? await this.#prepareMac({ file, tmp, build }) : await this.#prepareWin({ file, tmp, build })
      this.pronto = { build, script, tmp, novo: this.plataforma === 'mac' ? this.novoApp : null }
      guardado = true
      this.#set({ fase: 'pronto', build })
      return this.status()
    } catch (err) {
      if (err?.definitivo) this.bloqueado = Math.max(this.bloqueado, build)
      this.deNovo = !!err?.deNovo
      this.#set({ fase: 'erro', aplicar: false, erro: err?.message || 'Algo deu errado ao atualizar. Use Baixar.' })
      return this.status()
    } finally {
      if (!guardado) await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }

  /** Pastas de atualizações antigas que ficaram para trás (o app fechou com uma versão pronta e não trocou). */
  async #limparSobras() {
    let nomes = []
    try {
      nomes = await fsp.readdir(this.tmpRoot)
    } catch {
      return
    }
    const limite = Date.now() - 60 * 60_000
    for (const n of nomes) {
      if (!n.startsWith('sobedesce-atualizacao-')) continue
      const p = path.join(this.tmpRoot, n)
      try {
        if ((await fsp.stat(p)).mtimeMs < limite) await fsp.rm(p, { recursive: true, force: true })
      } catch {}
    }
  }

  async #prepareMac({ file, tmp, build }) {
    const bundle = this.bundle
    const parent = path.posix.dirname(bundle)
    const base = path.posix.basename(bundle, '.app')
    const novo = path.posix.join(parent, `.${base}-atualizacao.app`)
    this.novoApp = novo
    const velho = path.posix.join(parent, `.${base}-antigo.app`)
    const mount = path.join(tmp, 'montagem')
    await fsp.mkdir(mount)
    try {
      await this.run('hdiutil', ['attach', file, '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mount, '-quiet'])
    } catch (err) {
      this.log('hdiutil attach falhou:', err?.stderr || err?.message)
      throw definitivo('Não consegui abrir o instalador baixado. Use Baixar.')
    }
    try {
      const apps = (await fsp.readdir(mount)).filter(n => n.endsWith('.app'))
      const src = apps.includes(`${base}.app`) ? `${base}.app` : apps.find(n => /^SOBEDESCE.*\.app$/.test(n))
      if (!src) throw definitivo('O instalador baixado não tem o app dentro. Use Baixar.')
      try {
        await this.#apagarApp(novo)
      } catch (err) {
        this.log('não consegui apagar a atualização que sobrou:', err?.stderr || err?.message)
        throw definitivo('Uma atualização antiga ficou presa na pasta de Aplicativos. Use Baixar.')
      }
      try {
        await this.run('ditto', [path.join(mount, src), novo])
      } catch (err) {
        this.log('ditto falhou:', err?.stderr || err?.message)
        await this.#apagarApp(novo).catch(() => {})
        throw definitivo('Não consegui copiar o app novo para a pasta de Aplicativos. Use Baixar.')
      }
    } finally {
      await this.run('hdiutil', ['detach', mount, '-quiet']).catch(() => this.run('hdiutil', ['detach', mount, '-force', '-quiet']).catch(err => this.log('hdiutil detach falhou:', err?.message)))
    }
    await this.run('xattr', ['-cr', novo]).catch(err => this.log('xattr falhou (segue):', err?.stderr || err?.message))
    const script = path.join(tmp, 'trocar.sh')
    const marca = path.join(this.stateDir || tmp, MARK_FILE)
    await fsp.writeFile(script, macScript({ pid: this.appPid, app: bundle, novo, velho, marca, tmp, build }), { mode: 0o700 })
    return script
  }

  async #prepareWin({ file, tmp, build }) {
    const script = path.join(tmp, 'trocar.ps1')
    const marca = path.join(this.stateDir || tmp, MARK_FILE)
    // BOM: o PowerShell 5 lê o script como UTF-8 (acentos nos caminhos e nas mensagens).
    await fsp.writeFile(script, '﻿' + winScript({ pid: this.appPid, setup: file, exe: this.appExe, marca, tmp, build }), { mode: 0o700 })
    return script
  }
}
