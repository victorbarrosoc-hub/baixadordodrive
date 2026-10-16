#!/usr/bin/env node
// Identidade do build, gravada pelo GitHub Actions antes de empacotar o app (e no versao.json do Release de teste).
//
//   node scripts/build-info.mjs                → grava src/build-info.json (vai dentro do app)
//   node scripts/build-info.mjs versao.json    → grava no caminho dado (o aviso de versão nova lê este no site)
//
// { build: GITHUB_RUN_NUMBER, commit: 7 primeiros caracteres de GITHUB_SHA, data: hora do commit (ISO) }.
// A data vem do commit, não do relógio: os jobs do Mac, do Windows e do versao.json gravam exatamente o mesmo.
// Sem GITHUB_RUN_NUMBER (na sua máquina) o build fica 0: versão de desenvolvimento, que nunca mostra o aviso.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const out = path.resolve(process.argv[2] || path.join(ROOT, 'src', 'build-info.json'))

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
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, JSON.stringify(info, null, 1) + '\n')
console.log(`build-info → ${path.relative(process.cwd(), out) || out}: ${JSON.stringify(info)}`)
