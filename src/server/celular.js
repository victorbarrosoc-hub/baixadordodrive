// Celular ↔ computador pelo Wi-Fi (docs/CELULAR-WIFI.md): rotas locais da interface e da janela oculta do WebRTC
// (public/celular/p2p.js). O motor (src/celular/wifi.js) faz a espera longa no site e grava o que chega.
import fs from 'node:fs'
import { CelularWifi } from '../celular/wifi.js'
import { computerName } from '../google/cloud-auth.js'

const RANGE_RE = /^bytes=(\d+)-(\d*)$/

/**
 * @param {{ route, ctx, HttpProblem, baseHeaders, wifi? }} o
 * @returns {{ view(): object, close(): Promise<void> }}
 */
export function registerCelular({ route, ctx, HttpProblem, baseHeaders, wifi }) {
  let nome = null
  const w =
    wifi ||
    new CelularWifi({
      settings: ctx.settings,
      cloud: () => ctx.auth?.cloud || null,
      nome: async () => (nome ??= await computerName()),
      hub: { send: (ev, data) => ctx.hub?.send(ev, data) },
      log: ctx.log,
    })
  w.start()
  const onSettings = (_next, changed = []) => {
    if (changed.includes('celularOutros')) w.atualizarAparelhos().catch(() => {})
    if (changed.includes('celularReceber') || changed.includes('celularPasta') || changed.includes('celularOutros')) ctx.hub?.send('celular', w.view())
  }
  ctx.settings.on?.('change', onSettings)

  const tratar = (fn) => async (a) => {
    try {
      return await fn(a)
    } catch (err) {
      if (err?.name === 'HttpError') {
        const msg = err.body?.mensagem
        if (err.status >= 400 && err.status < 500 && typeof msg === 'string') throw new HttpProblem(err.status === 429 ? 429 : 409, msg)
        throw new HttpProblem(503, 'O site da conta SOBEDESCE não respondeu agora.')
      }
      if (err?.name === 'SobeDesceError') throw new HttpProblem(err.kind === 'reauth' ? 409 : 503, err.kind === 'reauth' ? 'Entre na sua conta SOBEDESCE de novo.' : 'O site da conta SOBEDESCE não respondeu agora.')
      throw err
    }
  }

  route('GET', '/api/celular', tratar(async () => w.view()))

  route('POST', '/api/celular/aparelhos', tratar(async () => {
    await Promise.all([w.atualizarAparelhos(), w.conferirRede().catch(() => null)])
    return w.view()
  }))

  route('POST', '/api/celular/janela', tratar(async () => w.janela()))

  // A janela oculta conta que a ligação direta com um celular não abriu (aparece em Dispositivos).
  route('POST', '/api/celular/falha', tratar(async ({ body }) => w.falha(typeof body?.erro === 'string' ? body.erro : '')))

  // Pedido de outra pessoa por perto: Aceitar ou Recusar na tela.
  route('POST', '/api/celular/responder', tratar(async ({ body }) => {
    if (typeof body.id !== 'string' || !body.id) throw new HttpProblem(400, 'Pedido inválido.')
    return w.responder(body.id, body.aceitar === true)
  }))

  route('POST', '/api/celular/sinal', tratar(async ({ body }) => w.sinal(body)))

  route('POST', '/api/celular/enviar', tratar(async ({ body }) => w.enviar({ para: body.para, caminhos: body.caminhos })))

  // A janela oculta lê o que manda em blocos (Range).
  route(
    'GET',
    '/api/celular/arquivo/:tid/:i',
    tratar(async ({ req, res, params }) => {
      const a = w.arquivoParaLer(params.tid, params.i)
      let st
      try {
        st = await fs.promises.stat(a.caminho)
      } catch {
        throw new HttpProblem(404, `${a.nome} não está mais no computador.`)
      }
      const tam = st.size
      let ini = 0
      let fim = tam - 1
      let parcial = false
      const r = RANGE_RE.exec(String(req.headers.range || ''))
      if (r) {
        ini = Number(r[1])
        fim = r[2] === '' ? tam - 1 : Math.min(Number(r[2]), tam - 1)
        if (ini > fim || ini >= tam) {
          res.writeHead(416, baseHeaders({ 'content-range': `bytes */${tam}`, 'cache-control': 'no-store' }))
          return res.end()
        }
        parcial = true
      }
      const n = tam === 0 ? 0 : fim - ini + 1
      res.writeHead(
        parcial ? 206 : 200,
        baseHeaders({
          'content-type': 'application/octet-stream',
          'content-length': n,
          'cache-control': 'no-store',
          'accept-ranges': 'bytes',
          ...(parcial ? { 'content-range': `bytes ${ini}-${fim}/${tam}` } : {}),
        }),
      )
      if (!n) return res.end()
      await new Promise((ok, erro) => {
        const s = fs.createReadStream(a.caminho, { start: ini, end: fim })
        s.on('error', erro)
        res.on('close', ok)
        s.pipe(res)
      })
    }),
    { raw: true },
  )

  route('POST', '/api/celular/receber', tratar(async ({ body }) => w.receber({ tid: body.tid, de: body.de, arquivos: body.arquivos, oferta: body.oferta })))

  // Corpo cru (application/octet-stream): src/server/app.js deixa passar só esta rota.
  route(
    'PUT',
    '/api/celular/receber/:tid/:i',
    tratar(async ({ req, params, query }) => {
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      if (ct !== 'application/octet-stream') throw new HttpProblem(415, 'Pedaço com tipo errado.')
      const offset = Number(query.get('offset'))
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpProblem(400, 'Offset inválido.')
      return w.escrever(params.tid, Number(params.i), offset, req)
    }),
    { corpo: false },
  )

  route('POST', '/api/celular/receber/:tid/:i/fim', tratar(async ({ params }) => w.fecharArquivo(params.tid, Number(params.i))))

  route('POST', '/api/celular/estado/:tid', tratar(async ({ params, body }) => w.estado(params.tid, body)))

  route('POST', '/api/celular/cancelar/:tid', tratar(async ({ params }) => w.cancelar(params.tid)))

  route('POST', '/api/celular/limpar', tratar(async () => w.limpar()))

  return {
    view: () => w.view(),
    wifi: w,
    close: async () => {
      ctx.settings.off?.('change', onSettings)
      await w.close()
    },
  }
}
