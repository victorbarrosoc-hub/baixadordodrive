#!/usr/bin/env node
// Identidade do build, gravada pelo GitHub Actions antes de empacotar o app (e no versao.json do Release de teste).
//
//   node scripts/build-info.mjs                → grava src/build-info.json (vai dentro do app)
//   node scripts/build-info.mjs versao.json    → grava no caminho dado (o aviso de versão nova lê este no site)
//   node scripts/build-info.mjs versao.json --sha256 sha256
//                                              → e junta o SHA-256 dos instaladores (sha256/mac.sha256 e
//                                                sha256/windows.sha256, de scripts/sha256.mjs); falta um = falha.
//                                                Junta também o nome de cada instalador (arquivoMac/arquivoWindows):
//                                                o site entrega exatamente esse arquivo (web/src/lib/release.ts)
//
// { build: GITHUB_RUN_NUMBER, commit: 7 primeiros caracteres de GITHUB_SHA, data: hora do commit (ISO) },
// mais { sha256Mac, sha256Windows } com --sha256 (o app e os instaladores de uma linha do site conferem o download).
// A data vem do commit, não do relógio: os jobs do Mac, do Windows e do versao.json gravam exatamente o mesmo.
// Sem GITHUB_RUN_NUMBER (na sua máquina) o build fica 0: versão de desenvolvimento, que nunca mostra o aviso.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
const hashAt = args.indexOf('--sha256')
const hashDir = hashAt >= 0 ? args.splice(hashAt, 2)[1] : null
const out = path.resolve(args[0] || path.join(ROOT, 'src', 'build-info.json'))

const build = Number.parseInt(process.env.GITHUB_RUN_NUMBER || '', 10)
let sha = String(process.env.GITHUB_SHA || '')
let data = ''
try {
  sha ||= execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  data = new Date(execFileSync('git', ['show', '-s', '--format=%cI', sha || 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()).toISOString()
} catch {
  data = new Date().toISOString()
}

const info = {
  build: Number.isInteger(build) && build > 0 ? build : 0,
  commit: /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7).toLowerCase() : '',
  data,
}
if (hashAt >= 0) {
  for (const [plataforma, campo, campoArquivo] of [['mac', 'sha256Mac', 'arquivoMac'], ['windows', 'sha256Windows', 'arquivoWindows']]) {
    let linha = ''
    try {
      linha = fs.readFileSync(path.join(hashDir || '', `${plataforma}.sha256`), 'utf8')
    } catch (err) {
      console.error(`build-info: sem o SHA-256 do instalador de ${plataforma} (${err.code || err.message})`)
      process.exit(1)
    }
    const [hex, nome] = linha.trim().split(/\s+/)
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      console.error(`build-info: SHA-256 inválido para ${plataforma}: ${linha.trim().slice(0, 80)}`)
      process.exit(1)
    }
    info[campo] = hex
    if (nome && /^[\w.+-]{1,200}$/.test(nome)) info[campoArquivo] = nome
  }
}
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(info, null, 1) + '\n')
console.log(`build-info → ${path.relative(process.cwd(), out) || out}: ${JSON.stringify(info)}`)
