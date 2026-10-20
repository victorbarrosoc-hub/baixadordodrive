// Rotas da busca por cena (docs/CENAS.md): analisar uma pasta do Drive, procurar por texto nos vídeos analisados,
// miniatura de cada trecho (chave `k` da mídia, como as do Drive) e salvar um trecho do original. Andamento pelo SSE
// 'cenas'.
import fs from 'node:fs'
import path from 'node:path'
import { CenasService } from '../cenas/servico.js'
import { procurarProxy } from '../media/previa-fila.js'
import { detectarMotor } from '../media/previa.js'

const DRIVE_ID = /^[\w-]{1,200}$/

/**
 * @param {{ route, ctx, account, HttpProblem, baseHeaders }} o
 * @returns {{ view(): object, close(): Promise<void> }}
 */
export function registerCenas({ route, ctx, account, HttpProblem, baseHeaders, servico }) {
  let motorP = null
  const motor = () => {
    if (ctx.manager.previas?.motor) return ctx.manager.previas.motor()
    motorP ??= detectarMotor()
    return motorP
  }
  const svc =
    servico ||
    new CenasService({
      dataRoot: ctx.paths?.root || path.dirname(ctx.paths?.settings || '.'),
      drive: (accountId) => ctx.manager.driveFor(accountId),
      motor,
      procurarProxy,
      pastaTrechos: () => path.join(ctx.settings.get().downloadDir || path.join(process.env.HOME || '.', 'Downloads'), 'Cenas'),
      onChange: (v) => ctx.hub?.send('cenas', v),
      log: ctx.log,
    })
  ctx.cenas = svc
  svc.init().catch(() => {})

  const tratar = (fn) => async (a) => {
    try {
      return await fn(a)
    } catch (err) {
      if (err?.name === 'CenasError') throw new HttpProblem(err.status, err.message)
      throw err
    }
  }
  const id = (v, msg) => {
    if (typeof v !== 'string' || !DRIVE_ID.test(v)) throw new HttpProblem(400, msg)
    return v
  }

  route('GET', '/api/cenas', tratar(async () => svc.view()))

  route('POST', '/api/cenas/modelo', tratar(async () => svc.baixarModelo()))

  route('POST', '/api/cenas/analisar', tratar(async ({ body }) => {
    const acc = account(body.accountId)
    const folderId = body.folderId === 'root' || body.folderId == null ? 'root' : id(body.folderId, 'Pasta inválida.')
    const perfil = body.perfil == null ? 'auto' : String(body.perfil)
    return svc.analisarPasta({ accountId: acc.id, folderId, perfil })
  }))

  route('POST', '/api/cenas/parar', tratar(async () => {
    svc.parar()
    return svc.view()
  }))

  route('GET', '/api/cenas/pasta', tratar(async ({ query }) => {
    const acc = account(query.get('accountId'))
    const f = query.get('folderId')
    return svc.pasta({ accountId: acc.id, folderId: f && f !== 'root' ? id(f, 'Pasta inválida.') : null })
  }))

  route('POST', '/api/cenas/procurar', tratar(async ({ body }) => {
    const acc = account(body.accountId)
    if (typeof body.texto !== 'string' || !body.texto.trim()) throw new HttpProblem(400, 'Diga o que procurar.')
    const fileIds = Array.isArray(body.fileIds) ? body.fileIds.slice(0, 2000).map((x) => id(x, 'Arquivo inválido.')) : null
    return svc.procurar({ accountId: acc.id, texto: body.texto, fileIds, limite: Math.max(1, Math.min(200, Number(body.limite) || 60)) })
  }))

  route('POST', '/api/cenas/esquecer', tratar(async ({ body }) => {
    const acc = account(body.accountId)
    return svc.esquecer({ accountId: acc.id, fileId: body.fileId == null ? null : id(body.fileId, 'Arquivo inválido.') })
  }))

  route('POST', '/api/cenas/trecho', tratar(async ({ body, signal }) => {
    const acc = account(body.accountId)
    return svc.salvarTrecho({ accountId: acc.id, fileId: id(body.fileId, 'Arquivo inválido.'), ini: Number(body.ini), fim: Number(body.fim), signal })
  }))

  // Perfil de cor de um vídeo (LOG → Rec.709 na prévia): metadados do arquivo e, sem eles, a imagem.
  route('GET', '/api/cor/perfil', tratar(async ({ query, signal }) => {
    const acc = account(query.get('accountId'))
    const ffmpeg = (await Promise.resolve(motor()).catch(() => null))?.ffmpeg?.path || null
    return svc.perfilDe({ accountId: acc.id, fileId: id(query.get('fileId'), 'Arquivo inválido.'), ffmpeg, signal })
  }))

  // Miniatura de um trecho (para <img>): a chave `k` da mídia, como as miniaturas do Drive.
  const mini = tratar(async ({ req, res, query }) => {
    if (!ctx.media) throw new HttpProblem(404, 'Indisponível nesta versão.')
    ctx.media.check(req, query)
    const acc = account(query.get('accountId'))
    const p = await svc.miniatura({ accountId: acc.id, fileId: id(query.get('fileId'), 'Arquivo inválido.'), i: query.get('i') })
    const st = await fs.promises.stat(p)
    res.writeHead(200, baseHeaders({ 'content-type': 'image/jpeg', 'content-length': st.size, 'cache-control': 'private, max-age=3600', 'content-security-policy': "default-src 'none'; sandbox" }))
    if (req.method === 'HEAD') return res.end()
    await new Promise((resolve) => {
      const s = fs.createReadStream(p)
      s.on('error', () => res.destroy())
      res.on('close', resolve)
      s.pipe(res)
    })
  })
  route('GET', '/api/cenas/mini', mini, { raw: true })
  route('HEAD', '/api/cenas/mini', mini, { raw: true })

  return { view: () => svc.view(), close: () => svc.close() }
}
