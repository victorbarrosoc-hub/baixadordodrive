#!/usr/bin/env node
// Baixa o yt-dlp que vai dentro do app de desktop (Referências, src/referencias/) para build/yt-dlp/<pasta>/.
// O electron-builder copia de lá para <Resources>/yt-dlp/ (extraResources, fora do app/). O app também se atualiza
// sozinho depois de instalado (src/referencias/ytdlp-update.js): este é só o ponto de partida.
//
//   node scripts/ytdlp-baixar.mjs            → o do sistema atual (Mac: o universal; Windows: x64 e arm64)
//   node scripts/ytdlp-baixar.mjs mac win    → os dois
//   node scripts/ytdlp-baixar.mjs --saida <pasta>
//
// Versão fixa, conferida pelo SHA-256 publicado no SHA2-256SUMS do Release (troque VERSAO + hashes juntos).
// Licença: o yt-dlp é Unlicense (domínio público); os executáveis levam Python e bibliotecas com licenças permissivas.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const VERSAO = '2026.08.19'
const BASE = `https://github.com/yt-dlp/yt-dlp/releases/download/${VERSAO}`

/**
 * Pasta de destino (= `ytdlpBundleDir` de src/referencias/binarios.js) → arquivo do Release e SHA-256.
 * Mac: um binário universal só (o electron-builder copia o mesmo nas duas arquiteturas; `x64ArchFiles` no
 * electron-builder.yml deixa o @electron/universal aceitar o arquivo igual nos dois lados).
 */
export const FONTES = {
  mac: { asset: 'yt-dlp_macos', sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202', exe: 'yt-dlp', magia: 'macho' },
  'win-x64': { asset: 'yt-dlp.exe', sha256: '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a', exe: 'yt-dlp.exe', magia: 'pe' },
  'win-arm64': { asset: 'yt-dlp_arm64.exe', sha256: '05b438997bafc3affdfda9d041353c9d73e04dc842207254b655b0887c4445b0', exe: 'yt-dlp.exe', magia: 'pe' },
  'linux-x64': { asset: 'yt-dlp_linux', sha256: '58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a', exe: 'yt-dlp', magia: 'elf' },
}

const PLATAFORMAS = { mac: ['mac'], win: ['win-x64', 'win-arm64'], linux: ['linux-x64'] }

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

/** Baixa, confere o hash e grava em <saida>/<alvo>/<exe> + versao.txt. Já existe com o mesmo hash: pula. */
export async function prepararAlvo(alvo, { saida = path.join(ROOT, 'build', 'yt-dlp'), log = console.log } = {}) {
  const f = FONTES[alvo]
  if (!f) throw new Error(`alvo desconhecido: ${alvo}`)
  const dir = path.join(saida, alvo)
  const exe = path.join(dir, f.exe)
  const marca = path.join(saida, `.${alvo}.sha256`)
  const ja = await fs.readFile(marca, 'utf8').catch(() => '')
  if (ja.trim() === f.sha256 && (await fs.stat(exe).catch(() => null))?.isFile()) {
    log(`yt-dlp ${alvo}: já estava em ${path.relative(ROOT, exe)}`)
    return exe
  }
  const url = `${BASE}/${f.asset}`
  log(`yt-dlp ${alvo}: baixando ${url}`)
  const bin = await baixar(url)
  const hash = crypto.createHash('sha256').update(bin).digest('hex')
  if (hash !== f.sha256) throw new Error(`yt-dlp ${alvo}: SHA-256 diferente (${hash}). Confira o SHA2-256SUMS do Release ${VERSAO}.`)
  if (!confereMagia(bin, f.magia)) throw new Error(`yt-dlp ${alvo}: o executável não é do tipo esperado`)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(exe, bin, { mode: 0o755 })
  await fs.writeFile(path.join(dir, 'versao.txt'), `${VERSAO}\n`)
  await fs.writeFile(marca, f.sha256)
  log(`yt-dlp ${alvo}: ${(bin.length / 1e6).toFixed(1)} MB em ${path.relative(ROOT, exe) || exe}`)
  return exe
}

/** Roda o yt-dlp desta máquina (--version): o build para aqui se ele não abrir. */
function autoteste(exe) {
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 120_000 })
  const v = (r.stdout || '').trim()
  if (r.status !== 0 || v !== VERSAO) throw new Error(`o yt-dlp baixado não rodou (${r.error?.message || r.stderr || r.status})`)
  console.log(`autoteste: yt-dlp ${v}`)
}

const hostAlvo = () => (process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? `win-${process.arch}` : `linux-${process.arch}`)

async function main(argv) {
  let saida
  const plats = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--saida') saida = path.resolve(argv[++i])
    else plats.push(argv[i])
  }
  if (!plats.length) plats.push(process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux')
  const alvos = plats.flatMap(p => PLATAFORMAS[p] || (FONTES[p] ? [p] : []))
  if (!alvos.length) throw new Error('uso: node scripts/ytdlp-baixar.mjs [mac] [win] [linux] [--saida pasta]')
  for (const alvo of alvos) {
    const exe = await prepararAlvo(alvo, { saida })
    if (alvo === hostAlvo()) autoteste(exe)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(err => {
    console.error(`ytdlp-baixar: ${err.message}`)
    process.exit(1)
  })
}
