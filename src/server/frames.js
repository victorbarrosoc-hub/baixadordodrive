// Rotas do Frames (docs/FRAMES.md): começar um trabalho (vídeo do computador ou do Drive), acompanhar pelo SSE
// 'frames', abrir o histórico, editar (descartar, outro frame, frame no ponto, nome da cena, take em outro formato),
// salvar os posts montados na tela e subir a pasta para o Drive. Arquivos para <img>/<video> pela chave `k` da mídia.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { expandHome } from '../local/fsbrowse.js'
import { FORMATOS_FRAME, FORMATOS_TAKE, FramesService, POSICOES_LOGO } from '../frames/servico.js'
import { detectarMotor, isVideoName } from '../media/previa.js'

const DRIVE_ID = /^[\w-]{1,200}$/
const ITEM_ID = /^[FT]\d{1,4}$/
const LOGO_EXTS = ['.png', '.jpg', '.jpeg', '.webp']
const POST_MAX = 60 * 1024 * 1024
const TIPOS = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.tif': 'image/tiff', '.mp4': 'video/mp4', '.mov': 'video/quicktime' }

/** Arquivo do disco com Range (o <video> dos takes pula para qualquer ponto). */
async function servir(req, res, file, baseHeaders) {
  const st = await fsp.stat(file).catch(() => null)
  if (!st?.isFile()) {
    res.writeHead(404, baseHeaders({ 'content-length': 0 }))
    return res.end()
  }
  const type = TIPOS[path.extname(file).toLowerCase()] || 'application/octet-stream'
  const head = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, no-cache', 'content-security-policy': "default-src 'none'; sandbox" }
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  let ini = 0
  let fim = st.size - 1
  if (m && (m[1] || m[2])) {
    if (m[1]) {
      ini = Number(m[1])
      if (m[2]) fim = Math.min(fim, Number(m[2]))
    } else ini = Math.max(0, st.size - Number(m[2]))
    if (ini > fim || ini >= st.size) {
      res.writeHead(416, baseHeaders({ 'content-range': `bytes */${st.size}` }))
      return res.end()
    }
    res.writeHead(206, baseHeaders({ ...head, 'content-range': `bytes ${ini}-${fim}/${st.size}`, 'content-length': fim - ini + 1 }))
  } else res.writeHead(200, baseHeaders({ ...head, 'content-length': st.size }))
  if (req.method === 'HEAD') return res.end()
  await new Promise((resolve) => {
    const s = fs.createReadStream(file, { start: ini, end: fim })
    s.on('error', () => res.destroy())
    res.on('close', () => {
      s.destroy()
      resolve()
    })
    s.pipe(res)
  })
}

function lerCorpo(req, limite) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let n = 0
    req.on('data', (c) => {
      n += c.length
      if (n > limite) {
        reject(Object.assign(new Error('O post é grande demais.'), { status: 413 }))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

const int = (v, min, max, padrao) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : padrao
}
const num = (v, min, max, padrao) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : padrao
}

/**
 * @param {{ route, ctx, account, HttpProblem, baseHeaders, subir: (o) => Promise<object> }} o
 * @returns {{ view(): object|null, close(): void }}
 */
export function registerFrames({ route, ctx, account, HttpProblem, baseHeaders, subir }) {
  let motorP = null
  const motor = () => {
    if (ctx.manager.previas?.motor) return ctx.manager.previas.motor()
    motorP ??= detectarMotor()
    return motorP
  }
  const svc = new FramesService({
    dataRoot: ctx.paths?.root || path.dirname(ctx.paths?.settings || '.'),
    motor,
    drive: (accountId) => ctx.manager.driveFor(accountId),
    baixar: (drive, item, opts) => {
      if (!ctx.manager.previas?.baixarOriginal) throw new HttpProblem(409, 'Baixar do Drive para os frames não está disponível nesta versão.')
      return ctx.manager.previas.baixarOriginal(drive, item, opts)
    },
    subir,
    pastaPadrao: () => path.join(ctx.settings.get().downloadDir || path.join(process.env.HOME || '.', 'Downloads'), 'Frames'),
    onChange: (v) => ctx.hub?.send('frames', v),
    log: ctx.log,
  })
  ctx.frames = svc

  const problema = (err) => {
    if (err?.name === 'FramesError') return new HttpProblem(err.status, err.message)
    return err
  }
  const tratar = (fn) => async (a) => {
    try {
      return await fn(a)
    } catch (err) {
      throw problema(err)
    }
  }

  const caminhoLocal = async (raw, { arquivo = true } = {}) => {
    if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0') || raw.length > 4096) return null
    const p = expandHome(raw)
    if (!path.isAbsolute(p)) return null
    const st = await fsp.stat(p).catch(() => null)
    if (!st || (arquivo ? !st.isFile() : !st.isDirectory())) return null
    return p
  }

  const alvoDrive = (v) => {
    if (v == null || v === false) return null
    if (v === 'junto') return 'junto'
    if (typeof v !== 'object') throw new HttpProblem(400, 'Pedido inválido.')
    const acc = account(v.accountId)
    if (v.folderId != null && (typeof v.folderId !== 'string' || !DRIVE_ID.test(v.folderId))) throw new HttpProblem(400, 'Pasta do Drive inválida.')
    if (v.driveId != null && v.driveId !== '' && (typeof v.driveId !== 'string' || !DRIVE_ID.test(v.driveId))) throw new HttpProblem(400, 'Pasta do Drive inválida.')
    const name = typeof v.name === 'string' ? v.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) : null
    return { accountId: acc.id, folderId: v.folderId || 'root', driveId: v.driveId || null, name }
  }

  route('GET', '/api/frames', tratar(async () => ({ atual: svc.view(), historico: await svc.historico() })))

  route('POST', '/api/frames', tratar(async ({ body }) => {
    // Origem
    let origem
    const o = body.origem || {}
    if (o.tipo === 'local') {
      const caminho = await caminhoLocal(o.caminho)
      if (!caminho) throw new HttpProblem(400, 'Não achei esse vídeo no computador. O disco está conectado?')
      if (!isVideoName(caminho)) throw new HttpProblem(400, 'Escolha um arquivo de vídeo (MP4, MOV, MXF…).')
      origem = { tipo: 'local', caminho }
    } else if (o.tipo === 'drive') {
      const acc = account(o.accountId)
      if (typeof o.fileId !== 'string' || !DRIVE_ID.test(o.fileId)) throw new HttpProblem(400, 'Escolha um vídeo do Drive.')
      origem = { tipo: 'drive', accountId: acc.id, fileId: o.fileId }
    } else throw new HttpProblem(400, 'Escolha o vídeo.')

    // Ajustes
    const a = body.ajustes || {}
    const f = a.frames || {}
    const frames = { quantidade: int(f.quantidade, 1, 300, 24), formato: FORMATOS_FRAME.includes(f.formato) ? f.formato : 'jpg', logo: f.logo === true }
    let takes = null
    if (a.takes && int(a.takes.quantidade, 0, 60, 0) > 0) {
      const t = a.takes
      takes = {
        quantidade: int(t.quantidade, 1, 60, 6),
        duracao: num(t.duracao, 1, 15, 3),
        formato: FORMATOS_TAKE.includes(t.formato) ? t.formato : 'original',
        foco: num(t.foco, 0, 1, 0.5),
        audio: t.audio !== false,
        fade: t.fade !== false,
        codec: t.codec === 'prores' ? 'prores' : 'h264',
        logo: t.logo === true,
      }
    }
    let logo = null
    if (a.logo?.path) {
      const p = await caminhoLocal(a.logo.path)
      if (!p || !LOGO_EXTS.includes(path.extname(p).toLowerCase())) throw new HttpProblem(400, 'A logomarca precisa ser PNG, JPG ou WebP (PNG com fundo transparente fica melhor).')
      logo = { path: p, posicao: POSICOES_LOGO.includes(a.logo.posicao) ? a.logo.posicao : 'inf-dir', tamanho: num(a.logo.tamanho, 0.04, 0.5, 0.14), opacidade: num(a.logo.opacidade, 0.1, 1, 0.9) }
    }
    let destino = null
    if (a.destino) {
      destino = await caminhoLocal(a.destino, { arquivo: false })
      if (!destino) throw new HttpProblem(400, 'Não achei essa pasta no computador.')
    }
    const subirPara = alvoDrive(a.subir)
    const jobId = svc.iniciar({ origem, ajustes: { frames, takes, logo, destino, subir: subirPara } })
    return { jobId }
  }))

  route('DELETE', '/api/frames/job/:jobId', ({ params }) => {
    if (!svc.cancelar(params.jobId)) throw new HttpProblem(404, 'Esse trabalho não está rodando.')
    return {}
  })

  route('GET', '/api/frames/:id', tratar(async ({ params }) => ({ trabalho: svc.paraTela(await svc.manifesto(params.id)) })))

  route('DELETE', '/api/frames/:id', tratar(async ({ params }) => {
    if (svc.job?.status === 'running' && svc.job.manifestoId === params.id) throw new HttpProblem(409, 'Esse trabalho ainda está rodando.')
    await svc.esquecer(params.id)
    return {}
  }))

  const devolve = (m) => ({ trabalho: svc.paraTela(m) })

  route('POST', '/api/frames/:id/descartar', tratar(async ({ params, body }) => {
    if (typeof body.item !== 'string' || !ITEM_ID.test(body.item)) throw new HttpProblem(400, 'Pedido inválido.')
    return devolve(await svc.descartar(params.id, body.item, body.descartado !== false))
  }))

  route('POST', '/api/frames/:id/mais', tratar(async ({ params, body }) => {
    if (body.trocar != null && (typeof body.trocar !== 'string' || !ITEM_ID.test(body.trocar))) throw new HttpProblem(400, 'Pedido inválido.')
    return devolve(await svc.maisUm(params.id, { cena: int(body.cena, 1, 10_000, 1), trocar: body.trocar || null }))
  }))

  route('POST', '/api/frames/:id/no-ponto', tratar(async ({ params, body }) => {
    const t = Number(body.t)
    if (!Number.isFinite(t)) throw new HttpProblem(400, 'Pedido inválido.')
    return devolve(await svc.frameEm(params.id, t))
  }))

  route('POST', '/api/frames/:id/cena', tratar(async ({ params, body }) => devolve(await svc.nomearCena(params.id, int(body.n, 1, 10_000, 0), typeof body.nome === 'string' ? body.nome : ''))))

  route('POST', '/api/frames/:id/take', tratar(async ({ params, body }) => {
    if (typeof body.take !== 'string' || !ITEM_ID.test(body.take)) throw new HttpProblem(400, 'Pedido inválido.')
    const formato = FORMATOS_TAKE.includes(body.formato) ? body.formato : null
    const codec = body.codec === 'prores' || body.codec === 'h264' ? body.codec : null
    if (!formato && !codec) throw new HttpProblem(400, 'Escolha o formato.')
    return devolve(await svc.outroTake(params.id, body.take, { formato, codec }))
  }))

  // Post montado na tela: o corpo é a imagem (PNG ou JPEG), o resto vai na query.
  route('POST', '/api/frames/:id/post', tratar(async ({ req, params, query }) => {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    const ext = ct === 'image/png' ? 'png' : ct === 'image/jpeg' ? 'jpg' : null
    if (!ext) throw new HttpProblem(415, 'O post precisa ser PNG ou JPEG.')
    if (Number(req.headers['content-length']) > POST_MAX) throw new HttpProblem(413, 'O post é grande demais.')
    const tipo = String(query.get('tipo') || 'Post').replace(/[^\p{L}\p{N} -]/gu, '').slice(0, 30) || 'Post'
    const proporcao = /^\d{1,2}:\d{1,2}$/.test(query.get('proporcao') || '') ? query.get('proporcao') : '4:5'
    let dados
    try {
      dados = await lerCorpo(req, POST_MAX)
    } catch (err) {
      throw new HttpProblem(err.status || 400, err.message)
    }
    const sig = ext === 'png' ? dados.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) : dados[0] === 0xff && dados[1] === 0xd8
    if (!sig) throw new HttpProblem(400, 'Essa imagem veio quebrada.')
    const { m, arquivo } = await svc.salvarPost(params.id, { tipo, proporcao, ext, dados })
    return { arquivo, ...devolve(m) }
  }), { corpo: false })

  route('POST', '/api/frames/:id/post/apagar', tratar(async ({ params, body }) => {
    if (typeof body.arquivo !== 'string') throw new HttpProblem(400, 'Pedido inválido.')
    return devolve(await svc.apagarPost(params.id, body.arquivo))
  }))

  route('POST', '/api/frames/:id/subir', tratar(async ({ params, body }) => {
    const alvo = alvoDrive(body.para ?? 'junto')
    const { m, r } = await svc.subirAgora(params.id, alvo)
    return { count: r?.count ?? 0, bytes: r?.bytes ?? 0, ...devolve(m) }
  }))

  // Mostrar no Finder / Explorer: a pasta do trabalho (ou um arquivo dela).
  route('GET', '/api/frames/:id/pasta', tratar(async ({ params }) => ({ pasta: (await svc.manifesto(params.id)).pasta })))

  // ── arquivos para a tela (chave `k`, como as miniaturas do Drive)
  const chave = (req, query) => {
    if (!ctx.media) throw new HttpProblem(404, 'Indisponível nesta versão.')
    ctx.media.check(req, query)
  }

  const arquivo = tratar(async ({ req, res, params, query }) => {
    chave(req, query)
    const mini = query.get('mini')
    const alta = query.get('alta')
    if (alta && !ITEM_ID.test(alta)) throw new HttpProblem(400, 'Arquivo inválido.')
    const p = await svc.caminho(params.id, mini ? { mini } : alta ? { alta } : { rel: query.get('p') || '' })
    await servir(req, res, p, baseHeaders)
  })
  route('GET', '/api/frames/:id/arquivo', arquivo, { raw: true })
  route('HEAD', '/api/frames/:id/arquivo', arquivo, { raw: true })

  // Prévia da logomarca escolhida (antes de começar): só imagens, até 20 MB.
  route('GET', '/api/frames-logo', tratar(async ({ req, res, query }) => {
    chave(req, query)
    const p = await caminhoLocal(query.get('p'))
    if (!p || !LOGO_EXTS.includes(path.extname(p).toLowerCase())) throw new HttpProblem(400, 'Escolha uma imagem PNG, JPG ou WebP.')
    const st = await fsp.stat(p)
    if (st.size > 20 * 1024 * 1024) throw new HttpProblem(400, 'A logomarca passa de 20 MB.')
    await servir(req, res, p, baseHeaders)
  }), { raw: true })

  return { view: () => svc.view(), close: () => svc.close() }
}
