#!/usr/bin/env node
// Servidor estático de desenvolvimento para o SOBEDESCE Celular (sem dependências).
//
//   node mobile/dev-server.mjs            → http://127.0.0.1:4320
//   PORT=5000 node mobile/dev-server.mjs  → outra porta
//
// Aplica os mesmos headers do vercel.json (inclusive a CSP), para pegar cedo qualquer coisa que a produção
// bloquearia. Única diferença: a CSP aqui também libera conexões para 127.0.0.1/localhost, onde roda o Drive
// falso dos testes (test/mock-drive.js com { cors: true }) usado pelo modo ?dev_api=…&dev_token=….
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || process.argv.find((a) => a.startsWith('--port='))?.slice(7) || 4320)
const HIDDEN = new Set(['dev-server.mjs', 'README.md', 'vercel.json', '.vercelignore'])

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

/** "source" do vercel.json (subconjunto de path-to-regexp: literais + grupos "(…)") → RegExp. */
function sourceToRegex(source) {
  let out = ''
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch === '(') {
      const j = source.indexOf(')', i)
      out += `(${source.slice(i + 1, j)})`
      i = j
      continue
    }
    out += ch.replace(/[.*+?^${}|[\]\\/]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

function loadRules() {
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'))
    return (conf.headers || []).map((r) => ({ re: sourceToRegex(r.source), headers: r.headers }))
  } catch (err) {
    console.error('vercel.json ilegível:', err.message)
    return []
  }
}

function headersFor(pathname) {
  const out = {}
  for (const rule of loadRules()) {
    if (!rule.re.test(pathname)) continue
    for (const { key, value } of rule.headers) out[key.toLowerCase()] = value
  }
  const csp = out['content-security-policy']
  if (csp) out['content-security-policy'] = csp.replace('connect-src ', 'connect-src http://127.0.0.1:* http://localhost:* ')
  delete out['strict-transport-security'] // HSTS não faz sentido em http local
  return out
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end()
      return
    }
    const url = new URL(req.url, `http://${req.headers.host || HOST}`)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = path.normalize(path.join(ROOT, pathname))
    const rel = path.relative(ROOT, file)
    if (rel.startsWith('..') || path.isAbsolute(rel) || HIDDEN.has(rel) || rel.split(path.sep).some((p) => p.startsWith('.'))) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Não encontrado')
      return
    }
    const stat = await fsp.stat(file).catch(() => null)
    if (!stat?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Não encontrado')
      return
    }
    const headers = {
      ...headersFor(url.pathname),
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'content-length': stat.size,
    }
    res.writeHead(200, headers)
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(file).pipe(res)
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('Erro')
  }
})

server.listen(PORT, HOST, () => {
  console.log(`SOBEDESCE Celular em http://${HOST}:${PORT}`)
})
