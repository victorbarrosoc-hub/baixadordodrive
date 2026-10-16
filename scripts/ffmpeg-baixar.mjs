#!/usr/bin/env node
// Baixa o ffmpeg que vai dentro do app de desktop (prévia leve, src/media/previa.js) para build/ffmpeg/<os>-<arch>/.
// O electron-builder copia de lá para <Resources>/ffmpeg/ (extraResources com ${os}-${arch}); no Mac universal, cada
// arquitetura leva o seu e o @electron/universal junta os dois num binário só (lipo).
//
//   node scripts/ffmpeg-baixar.mjs            → o do sistema atual (Mac: arm64 e x64; Windows: x64)
//   node scripts/ffmpeg-baixar.mjs mac win    → os dois
//   node scripts/ffmpeg-baixar.mjs --saida <pasta>
//
// Versões fixas, conferidas por SHA-256 (troque URL + hash juntos). Sem dependências: zip lido aqui mesmo.
// Licença: os dois builds são GPL v3 (com libx264); o texto e as fontes estão em build/ffmpeg-licencas/ (vão junto).
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** O que baixar. `formato`: 'zip' (pega `entrada`) ou 'gz' (o arquivo inteiro). */
export const FONTES = {
  // FFmpeg 9.0.2 de https://ffmpeg.martin-riedl.de (GPL v3, assinado pelo autor; versões de release ficam no ar).
  'mac-arm64': {
    url: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip',
    sha256: 'c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924',
    formato: 'zip',
    entrada: 'ffmpeg',
    exe: 'ffmpeg',
    magia: 'macho',
  },
  'mac-x64': {
    url: 'https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip',
    sha256: '7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4',
    formato: 'zip',
    entrada: 'ffmpeg',
    exe: 'ffmpeg',
    magia: 'macho',
  },
  // FFmpeg 6.1.1 "essentials" do gyan.dev (GPL v3; NVENC, Quick Sync, AMF e Media Foundation), como o pacote
  // ffmpeg-static publica nos Releases do GitHub (endereço permanente).
  'win-x64': {
    url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz',
    sha256: '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
    formato: 'gz',
    exe: 'ffmpeg.exe',
    magia: 'pe',
  },
}

const PLATAFORMAS = { mac: ['mac-arm64', 'mac-x64'], win: ['win-x64'] }

/** Lê um arquivo de dentro de um .zip (sem zip64; métodos 0 e 8). */
export function unzipEntry(buf, name) {
  // Fim do diretório central: procura de trás para frente (o comentário pode ter até 64 KB).
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip sem diretório central')
  const entries = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip com diretório central inválido')
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28)
    const xlen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const entry = buf.toString('utf8', p + 46, p + 46 + nlen)
    p += 46 + nlen + xlen + clen
    if (entry !== name && !entry.endsWith(`/${name}`)) continue
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('zip com cabeçalho local inválido')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(start, start + csize)
    const out = method === 0 ? Buffer.from(data) : method === 8 ? zlib.inflateRawSync(data) : null
    if (!out) throw new Error(`zip: método ${method} não suportado`)
    if (out.length !== usize) throw new Error('zip: tamanho diferente do esperado')
    return out
  }
  throw new Error(`"${name}" não está no zip`)
}

function confereMagia(buf, magia) {
  if (magia === 'macho') {
    const m = buf.readUInt32BE(0)
    return m === 0xcffaedfe || m === 0xfeedfacf || m === 0xcafebabe
  }
  if (magia === 'pe') return buf[0] === 0x4d && buf[1] === 0x5a
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

/** Baixa, confere o hash, extrai e grava em <saida>/<alvo>/<exe>. Já existe com o mesmo hash de origem: pula. */
export async function prepararAlvo(alvo, { saida = path.join(ROOT, 'build', 'ffmpeg'), log = console.log } = {}) {
  const f = FONTES[alvo]
  if (!f) throw new Error(`alvo desconhecido: ${alvo}`)
  const dir = path.join(saida, alvo)
  const exe = path.join(dir, f.exe)
  const marca = path.join(saida, `.${alvo}.sha256`)
  const ja = await fs.readFile(marca, 'utf8').catch(() => '')
  if (ja.trim() === f.sha256 && (await fs.stat(exe).catch(() => null))?.isFile()) {
    log(`ffmpeg ${alvo}: já estava em ${path.relative(ROOT, exe)}`)
    return exe
  }
  log(`ffmpeg ${alvo}: baixando ${f.url}`)
  const pacote = await baixar(f.url)
  const hash = crypto.createHash('sha256').update(pacote).digest('hex')
  if (hash !== f.sha256) throw new Error(`ffmpeg ${alvo}: SHA-256 diferente (${hash}). O arquivo mudou no servidor: confira e atualize scripts/ffmpeg-baixar.mjs.`)
  const bin = f.formato === 'zip' ? unzipEntry(pacote, f.entrada) : zlib.gunzipSync(pacote)
  if (!confereMagia(bin, f.magia)) throw new Error(`ffmpeg ${alvo}: o executável não é do tipo esperado`)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(exe, bin, { mode: 0o755 })
  await fs.writeFile(marca, f.sha256)
  log(`ffmpeg ${alvo}: ${(bin.length / 1e6).toFixed(1)} MB em ${path.relative(ROOT, exe) || exe}`)
  return exe
}

/** Roda o ffmpeg da arquitetura desta máquina (-version): o build para aqui se ele não abrir. */
function autoteste(exe) {
  const r = spawnSync(exe, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 30_000 })
  const linha = (r.stdout || '').split('\n')[0]
  if (r.status !== 0 || !/^ffmpeg version/.test(linha)) throw new Error(`o ffmpeg baixado não rodou (${r.error?.message || r.stderr || r.status})`)
  console.log(`autoteste: ${linha}`)
}

async function main(argv) {
  let saida
  const plats = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--saida') saida = path.resolve(argv[++i])
    else plats.push(argv[i])
  }
  if (!plats.length) plats.push(process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'mac')
  const alvos = plats.flatMap(p => PLATAFORMAS[p] || (FONTES[p] ? [p] : []))
  if (!alvos.length) throw new Error(`uso: node scripts/ffmpeg-baixar.mjs [mac] [win] [--saida pasta]`)
  for (const alvo of alvos) {
    const exe = await prepararAlvo(alvo, { saida })
    const host = `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`
    if (alvo === host) autoteste(exe)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(err => {
    console.error(`ffmpeg-baixar: ${err.message}`)
    process.exit(1)
  })
}
