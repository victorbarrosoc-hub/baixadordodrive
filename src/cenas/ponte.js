// Busca por cena: o ffmpeg lê o vídeo do Drive por uma "ponte" em 127.0.0.1, sem receber o token do Google. Os
// argumentos de um processo ficam visíveis para os outros programas do computador; então o ffmpeg só recebe um
// endereço aleatório que serve UM arquivo e some quando a análise (ou o corte) termina. A ponte põe o token e repassa
// o Range ao Drive.
import http from 'node:http'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { fetch as undiciFetch } from 'undici'
import { dispatcherFor } from '../net/http.js'

const PASSA = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']

/**
 * @param {{ mediaUrl(id: string): string, authHeader(): Promise<object> }} drive
 * @param {string} fileId
 * @param {{ fetch?: Function }} [o] trocável nos testes
 * @returns {Promise<{ url: string, fechar(): Promise<void> }>}
 */
export async function abrirPonte(drive, fileId, { fetch = (u, o) => undiciFetch(u, { ...o, dispatcher: dispatcherFor(u) }) } = {}) {
  const segredo = crypto.randomBytes(24).toString('base64url')
  const alvo = drive.mediaUrl(fileId)
  const vivos = new Set()
  const srv = http.createServer(async (req, res) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.url !== `/${segredo}`) {
      res.writeHead(404)
      return res.end()
    }
    const ac = new AbortController()
    vivos.add(ac)
    res.on('close', () => {
      ac.abort()
      vivos.delete(ac)
    })
    try {
      const headers = { ...(await drive.authHeader()) }
      if (req.headers.range) headers.range = req.headers.range
      let up = await fetch(alvo, { method: req.method, headers, signal: ac.signal, redirect: 'follow' })
      if (up.status === 401) {
        // Token venceu no meio de uma análise longa: pede outro uma vez.
        await up.body?.cancel?.().catch?.(() => {})
        up = await fetch(alvo, { method: req.method, headers: { ...headers, ...(await drive.authHeader({ forceRefresh: true })) }, signal: ac.signal, redirect: 'follow' })
      }
      const h = {}
      for (const k of PASSA) if (up.headers.get(k)) h[k] = up.headers.get(k)
      res.writeHead(up.status, h)
      if (!up.body || req.method === 'HEAD') return res.end()
      Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res)
    } catch {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    }
  })
  await new Promise((ok, falha) => {
    srv.once('error', falha)
    srv.listen(0, '127.0.0.1', ok)
  })
  srv.unref()
  return {
    url: `http://127.0.0.1:${srv.address().port}/${segredo}`,
    fechar: () =>
      new Promise((ok) => {
        for (const ac of vivos) ac.abort()
        srv.close(() => ok())
        srv.closeAllConnections?.()
      }),
  }
}
