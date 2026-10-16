#!/usr/bin/env node
// SHA-256 do instalador de uma plataforma, para o versao.json (o app e os instaladores de uma linha conferem com ele).
//
//   node scripts/sha256.mjs mac dist sha256        → grava sha256/mac.sha256     ("<hex>  <nome do .dmg>")
//   node scripts/sha256.mjs windows dist sha256    → grava sha256/windows.sha256 ("<hex>  <nome do -windows-setup.exe>")
//
// Mesmas regras de nome de web/src/lib/release.ts (PLATAFORMAS). Sem exatamente um instalador na pasta, falha.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

export const INSTALADORES = {
  mac: n => n.endsWith('.dmg'),
  windows: n => n.endsWith('-windows-setup.exe'),
}

export async function sha256File(file) {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest('hex')
}

/** Calcula e grava <outDir>/<plataforma>.sha256. Devolve { nome, sha256 }. */
export async function hashInstalador(plataforma, distDir, outDir) {
  const match = INSTALADORES[plataforma]
  if (!match) throw new Error(`plataforma desconhecida: ${plataforma} (use mac ou windows)`)
  const achados = fs.readdirSync(distDir).filter(match)
  if (achados.length !== 1) throw new Error(`esperava 1 instalador de ${plataforma} em ${distDir}, achei ${achados.length}: ${achados.join(', ') || 'nenhum'}`)
  const nome = achados[0]
  const sha256 = await sha256File(path.join(distDir, nome))
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, `${plataforma}.sha256`), `${sha256}  ${nome}\n`)
  return { nome, sha256 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [plataforma, distDir = 'dist', outDir = 'sha256'] = process.argv.slice(2)
  try {
    const { nome, sha256 } = await hashInstalador(plataforma, distDir, outDir)
    console.log(`sha256 → ${path.join(outDir, `${plataforma}.sha256`)}: ${sha256}  ${nome}`)
  } catch (err) {
    console.error(`sha256: ${err.message}`)
    process.exit(1)
  }
}
