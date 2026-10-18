#!/usr/bin/env node
// Põe o número do build no nome do instalador antes de subir para o Release de teste:
//   SOBEDESCE-0.1.0-mac-universal.dmg  → SOBEDESCE-0.1.0-b160-mac-universal.dmg
//   SOBEDESCE-0.1.0-windows-setup.exe  → SOBEDESCE-0.1.0-b160-windows-setup.exe
//
//   node scripts/nome-instalador.mjs mac dist       (build = GITHUB_RUN_NUMBER)
//
// Cada build tem o seu arquivo: o build seguinte não troca o instalador que o versao.json ainda aponta, então o
// SHA-256 conferido pelo app sempre bate com o arquivo entregue (web/src/lib/release.ts escolhe pelo nome).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { INSTALADORES } from './sha256.mjs'

/** Nome com o build. Já tem build? Fica como está. */
export function nomeComBuild(nome, build) {
  if (/-b\d+-/.test(nome)) return nome
  if (nome.endsWith('-windows-setup.exe')) return nome.replace(/-windows-setup\.exe$/, `-b${build}-windows-setup.exe`)
  if (/-mac[-.]/.test(nome)) return nome.replace(/-mac([-.])/, `-b${build}-mac$1`)
  return nome.replace(/(\.[^.]+)$/, `-b${build}$1`)
}

export function renomear(plataforma, distDir, build) {
  const match = INSTALADORES[plataforma]
  if (!match) throw new Error(`plataforma desconhecida: ${plataforma} (use mac ou windows)`)
  if (!Number.isSafeInteger(build) || build <= 0) throw new Error('sem número de build (GITHUB_RUN_NUMBER)')
  const achados = fs.readdirSync(distDir).filter(match)
  if (achados.length !== 1) throw new Error(`esperava 1 instalador de ${plataforma} em ${distDir}, achei ${achados.length}`)
  const novo = nomeComBuild(achados[0], build)
  if (novo !== achados[0]) fs.renameSync(path.join(distDir, achados[0]), path.join(distDir, novo))
  return novo
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [plataforma, distDir = 'dist'] = process.argv.slice(2)
  try {
    console.log(`instalador → ${renomear(plataforma, distDir, Number.parseInt(process.env.GITHUB_RUN_NUMBER || '', 10))}`)
  } catch (err) {
    console.error(`nome-instalador: ${err.message}`)
    process.exit(1)
  }
}
