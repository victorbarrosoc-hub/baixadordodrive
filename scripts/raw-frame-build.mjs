#!/usr/bin/env node
// Gera o decodificador de Blackmagic RAW que vai dentro do app (native/raw-frame/, usado pelo proxy e pela miniatura de
// BRAW: src/media/braw.js e src/media/raw-thumb.js) em build/raw-frame/<mac|win-x64|win-arm64>/:
//   sobedesce-raw-frame[.exe] + BlackmagicRawAPI/ (a biblioteca da Blackmagic, que a licença deixa ir junto do app).
//
// O SDK não fica no repositório (a licença não deixa redistribuir os headers): o CI baixa da Blackmagic a cada build,
// com o cadastro da ZRO no segredo BRAW_SDK_CADASTRO (JSON: firstname, lastname, email, phone, country, state, city,
// street, company). Sem o segredo (fork, build local), não faz nada: o app sai sem o decodificador e o .braw fica sem
// proxy, como antes.
//
//   node scripts/raw-frame-build.mjs                 → o sistema atual (Mac: universal; Windows: x64 e arm64)
//   node scripts/raw-frame-build.mjs --sdk <pasta>   → usa um SDK já baixado (pasta com Linux/, Mac/, Win/ …)
//
// Passos: (1) pacote Linux do SDK (tem os headers de Mac, Windows e Linux e um sample.braw); (2) pacote do sistema para
// a biblioteca (Mac: .dmg → .pkg; Windows: .msi de cada arquitetura); (3) compila; (4) roda --check e --info no
// sample.braw (só onde a arquitetura roda aqui).
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'native', 'raw-frame')
const OUT = path.join(ROOT, 'build', 'raw-frame')

/** Versão do SDK (troque os ids juntos: https://www.blackmagicdesign.com/api/support/us/downloads.json, "braw-sdk"). */
export const SDK = {
  versao: 'Blackmagic RAW 6.0',
  linux: 'e18bcd1a00e049958c162782128f50ff',
  mac: '09d9af99bb4a46be8baedc7f7c1405dd',
  win: 'b297789f4c1f4dee9368b547f769a759',
}

const log = (...a) => console.log('[raw-frame]', ...a)
// No Windows, o tar do sistema (bsdtar, abre .zip e .rpm); o do Git que às vezes vem antes no PATH não abre.
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'

function run(cmd, args, { cwd, env, shell = false, quiet = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, shell, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} saiu com ${r.status}${r.error ? ` (${r.error.message})` : ''}\n${(r.stdout || '').slice(-4000)}\n${(r.stderr || '').slice(-4000)}`)
  }
  if (!quiet && r.stdout?.trim()) console.log(r.stdout.trim())
  return r.stdout || ''
}

/** Cadastro → link de download (o mesmo pedido do formulário do site da Blackmagic, com o aceite dos termos). */
async function linkDoSdk(downloadId, cadastro) {
  const res = await fetch(`https://www.blackmagicdesign.com/api/register/br/download/${downloadId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'User-Agent': 'Mozilla/5.0 (SOBEDESCE CI)' },
    body: JSON.stringify({ ...cadastro, product: SDK.versao, hasAgreedToTerms: true, origin: 'www.blackmagicdesign.com' }),
    signal: AbortSignal.timeout(60_000),
  })
  const texto = (await res.text()).trim()
  if (!res.ok || !/^https:\/\/sw\.blackmagicdesign\.com\//.test(texto)) throw new Error(`a Blackmagic não liberou o download (${res.status}): ${texto.slice(0, 200)}`)
  return texto
}

async function baixar(url, destino) {
  for (let tentativa = 1; ; tentativa++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await fs.writeFile(destino, Buffer.from(await res.arrayBuffer()))
      log(`baixado ${path.basename(destino)} (${((await fs.stat(destino)).size / 1e6).toFixed(0)} MB)`)
      return
    } catch (err) {
      if (tentativa >= 3) throw err
      log(`download falhou (${err.message}); de novo em ${tentativa * 5} s`)
      await new Promise(r => setTimeout(r, tentativa * 5000))
    }
  }
}

/** Todos os caminhos (em profundidade) que passam no teste; não segue links. */
async function acharTodos(dir, teste, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name)
    if (teste(e, p)) out.push(p)
    if (e.isDirectory() && !e.isSymbolicLink()) await acharTodos(p, teste, out)
  }
  return out
}

async function sdkDoLinux(tmp, cadastro) {
  const pacote = path.join(tmp, 'linux.tar.gz')
  await baixar(await linkDoSdk(SDK.linux, cadastro), pacote)
  const dir = path.join(tmp, 'linux')
  await fs.mkdir(dir, { recursive: true })
  run(TAR, ['-xzf', pacote, '-C', dir])
  const interno = (await acharTodos(dir, e => e.isFile() && /^BlackmagicRAW.*\.tar\.gz$/.test(e.name)))[0]
  const rpm = (await acharTodos(dir, e => e.isFile() && e.name.endsWith('.rpm')))[0]
  if (!rpm) throw new Error(`sem .rpm no pacote Linux (${interno || 'nada'})`)
  // O tar do Mac e o do Windows (bsdtar) abrem .rpm direto.
  const rpmDir = path.join(tmp, 'rpm')
  await fs.mkdir(rpmDir, { recursive: true })
  run(TAR, ['-xf', rpm, '-C', rpmDir])
  const sdk = (await acharTodos(rpmDir, e => e.isDirectory() && e.name === 'BlackmagicRAWSDK'))[0]
  if (!sdk) throw new Error('sem BlackmagicRAWSDK no .rpm')
  return sdk
}

// ─────────── Mac ───────────

async function bibliotecaMac(tmp, cadastro) {
  const zip = path.join(tmp, 'mac.zip')
  await baixar(await linkDoSdk(SDK.mac, cadastro), zip)
  const dir = path.join(tmp, 'mac')
  await fs.mkdir(dir, { recursive: true })
  run('ditto', ['-x', '-k', zip, dir])
  const dmg = (await acharTodos(dir, e => e.isFile() && e.name.endsWith('.dmg')))[0]
  if (!dmg) throw new Error('sem .dmg no pacote do Mac')
  const mnt = path.join(tmp, 'mnt')
  run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, dmg])
  try {
    const fws = await acharTodos(mnt, e => e.name === 'BlackmagicRawAPI.framework')
    if (fws.length) return copiarFramework(fws, tmp)
    const pkg = (await acharTodos(mnt, e => e.name.endsWith('.pkg')))[0]
    if (!pkg) throw new Error(`nem framework nem .pkg no .dmg: ${(await fs.readdir(mnt)).join(', ')}`)
    const exp = path.join(tmp, 'pkg')
    run('pkgutil', ['--expand-full', pkg, exp], { quiet: true })
    const dentro = await acharTodos(exp, e => e.name === 'BlackmagicRawAPI.framework')
    if (!dentro.length) throw new Error('sem BlackmagicRawAPI.framework no instalador')
    return copiarFramework(dentro, tmp)
  } finally {
    spawnSync('hdiutil', ['detach', mnt, '-force'])
  }
}

/** O framework do SDK (pasta "Libraries"), não o de dentro do Player. Copia preservando os links (ditto). */
async function copiarFramework(lista, tmp) {
  log('frameworks achados:', lista.map(p => p.split(path.sep).slice(-5).join('/')).join(' | '))
  const escolhido = lista.find(p => /Mac[\/]Libraries/.test(p)) || lista[0]
  const dest = path.join(tmp, 'BlackmagicRawAPI.framework')
  run('ditto', [escolhido, dest])
  return dest
}

async function compilarMac(sdk, framework) {
  const inc = path.join(sdk, 'Mac', 'Include')
  const dest = path.join(OUT, 'mac')
  await fs.rm(dest, { recursive: true, force: true })
  await fs.mkdir(path.join(dest, 'BlackmagicRawAPI'), { recursive: true })
  const exe = path.join(dest, 'sobedesce-raw-frame')
  run('clang++', ['-std=c++17', '-O2', '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=11.0', '-Wall', `-I${inc}`, `-I${SRC}`,
    path.join(SRC, 'raw-frame.cpp'), path.join(inc, 'BlackmagicRawAPIDispatch.cpp'), '-framework', 'CoreFoundation', '-o', exe])
  run('ditto', [framework, path.join(dest, 'BlackmagicRawAPI', 'BlackmagicRawAPI.framework')])
  run('lipo', ['-info', exe])
  return [exe]
}

// ─────────── Windows ───────────

async function bibliotecaWin(tmp, cadastro) {
  const zip = path.join(tmp, 'win.zip')
  await baixar(await linkDoSdk(SDK.win, cadastro), zip)
  const dir = path.join(tmp, 'win')
  await fs.mkdir(dir, { recursive: true })
  run(TAR, ['-xf', zip, '-C', dir])
  const msis = await acharTodos(dir, e => e.isFile() && e.name.toLowerCase().endsWith('.msi'))
  log('instaladores:', msis.map(p => path.basename(p)).join(' | '))
  const porArch = {}
  for (const [arch, re] of [['x64', /x86|x64/i], ['arm64', /arm/i]]) {
    const msi = msis.find(p => re.test(path.basename(p)) && !(arch === 'x64' && /arm/i.test(path.basename(p))))
    if (!msi) continue
    const alvo = path.join(tmp, `msi-${arch}`)
    // Instalação "administrativa": só extrai os arquivos, sem instalar nada na máquina.
    run('msiexec', ['/a', msi, '/qn', `TARGETDIR=${alvo}`])
    const dlls = await acharTodos(alvo, e => e.isFile() && e.name.toLowerCase() === 'blackmagicrawapi.dll')
    log(`${arch}: BlackmagicRawAPI.dll em`, dlls.map(p => path.relative(alvo, p)).join(' | ') || 'nenhum lugar')
    // O SDK traz Libraries\BlackmagicRawAPI.dll (x64), Libraries\ARM64\ e Libraries\ARM64EC\: cada arquitetura a sua.
    const alvoRe = arch === 'arm64' ? /Libraries[\\/]ARM64[\\/]BlackmagicRawAPI\.dll$/i : /Libraries[\\/]BlackmagicRawAPI\.dll$/i
    const escolhido = dlls.find(p => alvoRe.test(p))
    if (escolhido) porArch[arch] = path.dirname(escolhido)
  }
  if (!porArch.x64) throw new Error('sem BlackmagicRawAPI.dll para x64')
  return porArch
}

function vcvarsall() {
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const vswhere = path.join(pf86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  const inst = run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { quiet: true }).trim()
  const bat = path.join(inst, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat')
  if (!existsSync(bat)) throw new Error(`vcvarsall.bat não encontrado (${bat})`)
  return bat
}

async function compilarWin(sdk, libs, tmp) {
  const inc = path.join(sdk, 'Win', 'Include')
  const bat = vcvarsall()
  const feitos = []
  for (const [arch, vc, midlEnv] of [['x64', 'x64', 'x64'], ['arm64', 'x64_arm64', 'arm64']]) {
    if (!libs[arch]) {
      log(`${arch}: sem biblioteca, pulei`)
      continue
    }
    const gen = path.join(tmp, `gen-${arch}`)
    const obj = path.join(tmp, `obj-${arch}`)
    await fs.mkdir(gen, { recursive: true })
    await fs.mkdir(obj, { recursive: true })
    const dest = path.join(OUT, `win-${arch}`)
    await fs.rm(dest, { recursive: true, force: true })
    await fs.mkdir(path.join(dest, 'BlackmagicRawAPI'), { recursive: true })
    const exe = path.join(dest, 'sobedesce-raw-frame.exe')
    const q = s => `"${s}"`
    const cmd = [
      `call ${q(bat)} ${vc} >nul`,
      `midl /nologo /env ${midlEnv} /h BlackmagicRawAPI.h /iid BlackmagicRawAPI_i.c /out ${q(gen)} ${q(path.join(inc, 'BlackmagicRawAPI.idl'))}`,
      // Os .obj saem na pasta atual (obj-<arch>): "/Fo pasta\" entre aspas quebra a linha do cl (a \ escapa a aspa).
      `cd /d ${q(obj)}`,
      `cl /nologo /std:c++17 /O2 /EHsc /MT /W3 /utf-8 /I${q(gen)} /I${q(inc)} /I${q(SRC)} ${q(path.join(SRC, 'raw-frame.cpp'))} ${q(path.join(inc, 'BlackmagicRawAPIDispatch.cpp'))} ${q(path.join(gen, 'BlackmagicRawAPI_i.c'))} /Fe${q(exe)} /link ole32.lib oleaut32.lib`,
    ].join(' && ')
    const script = path.join(tmp, `build-${arch}.cmd`)
    await fs.writeFile(script, `@echo off\r\n${cmd}\r\n`)
    run('cmd.exe', ['/d', '/c', script])
    for (const f of await fs.readdir(libs[arch])) {
      if (f.toLowerCase().endsWith('.dll')) await fs.copyFile(path.join(libs[arch], f), path.join(dest, 'BlackmagicRawAPI', f))
    }
    log(`${arch}: ${(await fs.readdir(path.join(dest, 'BlackmagicRawAPI'))).join(', ')}`)
    feitos.push({ arch, exe })
  }
  return feitos.filter(f => f.arch === process.arch).map(f => f.exe)
}

// ─────────── conferir ───────────

function conferir(exe, sample) {
  run(exe, ['--check'])
  const info = JSON.parse(run(exe, ['--info', '--input', sample, '--max-side', '1280'], { quiet: true }).trim().split(/\r?\n/).pop())
  log('sample.braw:', JSON.stringify(info))
  if (!(info.frames > 0 && info.outWidth > 0)) throw new Error('o --info não leu o sample.braw')
  // Um frame de verdade: a miniatura passa por abrir, decodificar e gravar o JPEG.
  const jpg = path.join(os.tmpdir(), `raw-frame-${process.pid}.jpg`)
  run(exe, ['--input', sample, '--output', jpg, '--width', '640', '--max-bytes', '1500000'])
  return fs.stat(jpg).then(st => {
    log(`miniatura do sample.braw: ${st.size} bytes`)
    return fs.rm(jpg, { force: true })
  })
}

async function main() {
  const args = process.argv.slice(2)
  const sdkArg = args.includes('--sdk') ? args[args.indexOf('--sdk') + 1] : null
  const raw = process.env.BRAW_SDK_CADASTRO?.trim()
  if (!raw && !sdkArg) {
    log('sem BRAW_SDK_CADASTRO: o app sai sem o decodificador de Blackmagic RAW')
    return
  }
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    log('só Mac e Windows (o app de Linux não leva o decodificador)')
    return
  }
  let cadastro = null
  if (raw) {
    try {
      cadastro = JSON.parse(raw)
    } catch {
      throw new Error('BRAW_SDK_CADASTRO não é um JSON válido')
    }
    for (const k of ['firstname', 'lastname', 'email', 'country']) if (!cadastro?.[k]) throw new Error(`BRAW_SDK_CADASTRO sem "${k}"`)
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-frame-'))
  try {
    const sdk = sdkArg ? path.resolve(sdkArg) : await sdkDoLinux(tmp, cadastro)
    const sample = path.join(sdk, 'Media', 'sample.braw')
    let exes
    if (process.platform === 'darwin') exes = await compilarMac(sdk, await bibliotecaMac(tmp, cadastro))
    else exes = await compilarWin(sdk, await bibliotecaWin(tmp, cadastro), tmp)
    for (const exe of exes) await conferir(exe, sample)
    log('pronto em', path.relative(ROOT, OUT))
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch(err => {
  console.error('[raw-frame]', err?.message || err)
  process.exit(1)
})
