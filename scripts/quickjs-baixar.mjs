#!/usr/bin/env node
// Baixa o QuickJS-ng que vai dentro do app de desktop para build/quickjs/<os>-<arch>/. É o interpretador de JavaScript
// que o yt-dlp usa nos desafios do YouTube (Referências, src/referencias/binarios.js → jsRuntimePadrao). Antes o app
// emprestava o próprio Electron (ELECTRON_RUN_AS_NODE=1), mas o fusível RunAsNode agora fica desligado.
// O electron-builder copia de lá para <Resources>/quickjs/ (extraResources com ${os}-${arch}); no Mac universal, cada
// arquitetura leva o seu e o @electron/universal junta os dois num binário só (lipo), como o ffmpeg.
//
//   node scripts/quickjs-baixar.mjs            → o do sistema atual (Mac: arm64 e x64; Windows: x64 e arm64)
//   node scripts/quickjs-baixar.mjs mac win    → os dois
//   node scripts/quickjs-baixar.mjs --saida <pasta>
//
// Versão fixa, conferida por SHA-256 (troque VERSAO + hashes juntos). O Windows ARM usa o executável x64 (o Windows 11
// ARM roda x64 emulado; o QuickJS-ng não publica um ARM64). Licença: MIT (vai junto em build/quickjs-licenca/).
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const VERSAO = '0.17.0'
const BASE = `https://github.com/quickjs-ng/quickjs/releases/download/v${VERSAO}`
const LICENCA = { url: `https://raw.githubusercontent.com/quickjs-ng/quickjs/v${VERSAO}/LICENSE`, sha256: '96f73f9d2a16c21a36b418f06073be26e7d6d5e7c1bc99756b21a4f2c74ef171' }

/** Pasta de destino (`build/quickjs/<os>-<arch>`, o ${os}-${arch} do electron-builder) → arquivo do Release e SHA-256. */
export const FONTES = {
  'mac-arm64': { asset: 'qjs-darwin-arm64', sha256: '8be3ddfe3397d2e692e4e1e8972ee9d032a0a580505d2f8b4ea528cf1b651c11', exe: 'qjs', magia: 'macho' },
  'mac-x64': { asset: 'qjs-darwin-x86_64', sha256: '9e5e101b4fd13cda3204222ca9f8be35412c41dcdef3745829633b7a67245412', exe: 'qjs', magia: 'macho' },
  'win-x64': { asset: 'qjs-windows-x86_64.exe', sha256: '2aeabf0092c3262d6b2609824418f7dd7ed1f1df939f73b2b15645230cac0d77', exe: 'qjs.exe', magia: 'pe' },
  'win-arm64': { asset: 'qjs-windows-x86_64.exe', sha256: '2aeabf0092c3262d6b2609824418f7dd7ed1f1df939f73b2b15645230cac0d77', exe: 'qjs.exe', magia: 'pe' },
  'linux-x64': { asset: 'qjs-linux-x86_64', sha256: '0bfc02511a9f549c28b53880d988fc7cd5d361e90c5e8afdfcd7dc6774ceace5', exe: 'qjs', magia: 'elf' },
}

const PLATAFORMAS = { mac: ['mac-arm64', 'mac-x64'], win: ['win-x64', 'win-arm64'], linux: ['linux-x64'] }

function confereMagia(buf, magia) {
  if (magia === 'macho') {
    const m = buf.readUInt32BE(0)
    return m === 0xcafebabe || m === 0xcffaedfe || m === 0xfeedfacf
  }
  if (magia === 'pe') return buf[0] === 0x4d && buf[1] === 0x5a
  if (magia === 'elf') return buf.readUInt32BE(0) === 0x7f454c46
  return true
}

async function baixar(url) {
  let last
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      last = err
      await new Promise(r => setTimeout(r, 2000 * (i + 1)))
    }
  }
  throw new Error(`não consegui baixar ${url}: ${last?.message || last}`)
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')

/** Baixa, confere o hash e grava em <saida>/<alvo>/<exe> (só o executável: o universal do Mac exige). */
export async function prepararAlvo(alvo, { saida = path.join(ROOT, 'build', 'quickjs'), log = console.log } = {}) {
  const f = FONTES[alvo]
  if (!f) throw new Error(`alvo desconhecido: ${alvo}`)
  const dir = path.join(saida, alvo)
  const exe = path.join(dir, f.exe)
  const marca = path.join(saida, `.${alvo}.sha256`)
  const ja = await fs.readFile(marca, 'utf8').catch(() => '')
  if (ja.trim() === f.sha256 && (await fs.stat(exe).catch(() => null))?.isFile()) {
    log(`quickjs ${alvo}: já estava em ${path.relative(ROOT, exe)}`)
    return exe
  }
  const url = `${BASE}/${f.asset}`
  log(`quickjs ${alvo}: baixando ${url}`)
  const bin = await baixar(url)
  const hash = sha256(bin)
  if (hash !== f.sha256) throw new Error(`quickjs ${alvo}: SHA-256 diferente (${hash}). Confira o Release v${VERSAO}.`)
  if (!confereMagia(bin, f.magia)) throw new Error(`quickjs ${alvo}: o executável não é do tipo esperado`)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(exe, bin, { mode: 0o755 })
  await fs.writeFile(marca, f.sha256)
  log(`quickjs ${alvo}: ${(bin.length / 1e6).toFixed(1)} MB em ${path.relative(ROOT, exe) || exe}`)
  return exe
}

async function prepararLicenca({ saida = path.join(ROOT, 'build', 'quickjs-licenca') } = {}) {
  const bin = await baixar(LICENCA.url)
  if (sha256(bin) !== LICENCA.sha256) throw new Error('quickjs: a licença baixada não é a esperada')
  await fs.mkdir(saida, { recursive: true })
  await fs.writeFile(path.join(saida, 'LICENSE.txt'), bin)
  await fs.writeFile(
    path.join(saida, 'LEIAME.txt'),
    `QuickJS-ng ${VERSAO} (https://github.com/quickjs-ng/quickjs), licença MIT (LICENSE.txt).\n` +
      'O SOBEDESCE usa este interpretador de JavaScript só para o yt-dlp resolver os desafios do YouTube nas Referências.\n',
  )
}

/** Roda o QuickJS desta máquina (--help): o build para aqui se ele não abrir. */
function autoteste(exe) {
  const r = spawnSync(exe, ['--help'], { encoding: 'utf8', timeout: 60_000 })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  if (!out.includes(`QuickJS-ng version ${VERSAO}`)) throw new Error(`o QuickJS baixado não rodou (${r.error?.message || out.slice(0, 200) || r.status})`)
  console.log(`autoteste: QuickJS-ng ${VERSAO}`)
}

const hostAlvo = () => `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`

async function main(argv) {
  let saida
  const plats = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--saida') saida = path.resolve(argv[++i])
    else plats.push(argv[i])
  }
  if (!plats.length) plats.push(process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux')
  const alvos = plats.flatMap(p => PLATAFORMAS[p] || (FONTES[p] ? [p] : []))
  if (!alvos.length) throw new Error('uso: node scripts/quickjs-baixar.mjs [mac] [win] [linux] [--saida pasta]')
  for (const alvo of alvos) {
    const exe = await prepararAlvo(alvo, { saida })
    if (alvo === hostAlvo()) autoteste(exe)
  }
  await prepararLicenca(saida ? { saida: path.join(path.dirname(saida), 'quickjs-licenca') } : {})
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(err => {
    console.error(`quickjs-baixar: ${err.message}`)
    process.exit(1)
  })
}
