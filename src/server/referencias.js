// Rotas das Referências na API local (tabela em docs/ARCHITECTURE.md, "Referências").
// Tudo valida a entrada aqui; o serviço (src/referencias/service.js) fala com o site e com o Drive.
import { HttpProblem } from './routes.js'
import { detectar, limparUrl } from '../referencias/plataformas.js'

const ID = /^[\w-]{1,128}$/
const NOTA_MAX = 2000
const NOME_MAX = 80

/** Erro do serviço/site → HttpProblem com a mensagem dele (o código vai junto para a interface decidir a tela). */
function problema(err) {
  if (err instanceof HttpProblem) return err
  if (err?.name === 'ReferenciasApiError') {
    const status = { sem_sessao: 401, plano: 403, nao_encontrada: 404, ocupado: 409, sem_drive: 409, reconectar: 409, entrada: 400, rede: 503, servidor: 502 }[err.codigo] || 502
    const p = new HttpProblem(status, err.message)
    p.codigo = err.codigo
    return p
  }
  return err
}

const id = (v, msg = 'Pedido inválido.') => {
  if (typeof v !== 'string' || !ID.test(v)) throw new HttpProblem(400, msg)
  return v
}

function nota(v) {
  if (v == null || v === '') return ''
  if (typeof v !== 'string') throw new HttpProblem(400, 'Nota inválida.')
  return v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, NOTA_MAX)
}

function nomeColecao(v) {
  if (typeof v !== 'string') throw new HttpProblem(400, 'Dê um nome para a coleção.')
  const n = v.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (!n) throw new HttpProblem(400, 'Dê um nome para a coleção.')
  if ([...n].length > NOME_MAX) throw new HttpProblem(400, 'Use até 80 caracteres.')
  if (n.includes('/') || /[\u0000-\u001f\u007f]/.test(n)) throw new HttpProblem(400, 'O nome não pode ter “/”.')
  return n
}

/**
 * Registra as rotas /api/referencias/*. `route(method, pattern, handler)` é o mesmo de routes.js.
 * @param {Function} route
 * @param {object} ctx { referencias: ReferenciasService, media, hub }
 */
export function referenciasRoutes(route, ctx) {
  const svc = () => {
    if (!ctx.referencias) throw new HttpProblem(404, 'As Referências não estão disponíveis nesta versão.')
    return ctx.referencias
  }
  const wrap = fn => async args => {
    try {
      return await fn(args)
    } catch (err) {
      throw problema(err)
    }
  }
  const r = (method, pattern, fn, opts) => route(method, pattern, wrap(fn), opts)

  r('GET', '/api/referencias', () => ({ referencias: svc().status() }))

  // De que site é o link e se dá para salvar (campo "Colar link").
  r('GET', '/api/referencias/detectar', ({ query }) => {
    const url = limparUrl(query.get('url') || '')
    return { url, ...(url ? detectar(url) : { plataforma: '', nome: '', salvavel: false, host: '' }) }
  })

  r('GET', '/api/referencias/colecoes', async ({ query }) => {
    const { raiz, colecoes } = await svc().listarColecoes({ forcar: query.get('forcar') === '1' })
    return { raiz, colecoes }
  })

  r('POST', '/api/referencias/colecoes', async ({ body }) => {
    const nome = nomeColecao(body.nome)
    const contaId = body.contaId == null || body.contaId === '' ? null : String(body.contaId)
    if (contaId && !/^nuvem:[\w-]{1,128}$/.test(contaId)) throw new HttpProblem(400, 'Escolha um Drive da conta SOBEDESCE.')
    return { colecao: await svc().criarColecao({ nome, contaId }) }
  })

  r('PATCH', '/api/referencias/colecoes/:id', async ({ params, body }) => {
    const patch = {}
    if (body.nome !== undefined) patch.nome = nomeColecao(body.nome)
    if (body.link !== undefined) {
      if (![true, false, 'ligar', 'desligar', 'trocar'].includes(body.link)) throw new HttpProblem(400, 'Pedido inválido.')
      patch.link = body.link
    }
    if (!Object.keys(patch).length) throw new HttpProblem(400, 'Nada para mudar.')
    return { colecao: await svc().editarColecao(id(params.id), patch) }
  })

  r('DELETE', '/api/referencias/colecoes/:id', async ({ params, body }) => {
    if (body.apagarNoDrive != null && typeof body.apagarNoDrive !== 'boolean') throw new HttpProblem(400, 'Pedido inválido.')
    await svc().apagarColecao(id(params.id), { apagarNoDrive: body.apagarNoDrive === true })
    return {}
  })

  // Arquivos da coleção (com a origem de cada um) + links do celular que ainda não viraram arquivo.
  r('GET', '/api/referencias/colecoes/:id/itens', async ({ params, query, signal }) => {
    const s = svc()
    const cid = id(params.id)
    const [res, pendentes] = await Promise.all([s.itens(cid, { forcar: query.get('forcar') === '1', signal }), query.get('fila') === '0' ? [] : s.pendentesDaColecao(cid)])
    ctx.media?.remember(res.accountId, res.itens)
    return { colecao: res.colecao, accountId: res.accountId, itens: res.itens, pendentes }
  })

  r('POST', '/api/referencias/salvar', async ({ body }) => {
    if (typeof body.url !== 'string' || body.url.length > 4096) throw new HttpProblem(400, 'Cole o link do vídeo.')
    const url = limparUrl(body.url)
    if (!url) throw new HttpProblem(400, 'Esse link não parece um endereço da web.')
    const origem = body.origem === 'navegador' ? 'navegador' : 'colar'
    return { trabalho: await svc().salvar({ url, colecaoId: id(body.colecaoId, 'Escolha uma coleção.'), nota: nota(body.nota), origem }) }
  })

  r('POST', '/api/referencias/salvar-imagem', async ({ body }) => {
    const img = body.imagemUrl
    if (typeof img !== 'string' || !img || img.length > 6 * 1024 * 1024) throw new HttpProblem(400, 'Imagem inválida.')
    if (!/^https?:\/\//i.test(img) && !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(img)) throw new HttpProblem(400, 'Imagem inválida.')
    const paginaUrl = typeof body.paginaUrl === 'string' ? body.paginaUrl.slice(0, 4096) : ''
    const titulo = typeof body.titulo === 'string' ? body.titulo.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) : ''
    return { trabalho: await svc().salvarImagem({ imagemUrl: img, paginaUrl, titulo, colecaoId: id(body.colecaoId, 'Escolha uma coleção.'), nota: nota(body.nota) }) }
  })

  r('POST', '/api/referencias/trabalhos/:id/cancelar', async ({ params }) => {
    if (!(await svc().cancelar(id(params.id)))) throw new HttpProblem(404, 'Esse download não existe mais.')
    return {}
  })

  r('POST', '/api/referencias/trabalhos/:id/tentar', async ({ params }) => {
    const s = svc()
    const tid = id(params.id)
    if (!s.jobs.has(tid)) throw new HttpProblem(404, 'Esse download não existe mais.')
    return { trabalho: await s.tentarDeNovo(tid) }
  })

  r('DELETE', '/api/referencias/trabalhos/:id', ({ params }) => {
    if (!svc().remover(id(params.id))) throw new HttpProblem(409, 'Esse download ainda está andando.')
    return {}
  })

  // Fila do celular: "olhar agora" (app voltou ao foco, botão da tela) e "tentar de novo" num item com erro.
  r('POST', '/api/referencias/fila/consultar', async () => {
    const s = svc()
    s.consultarFila().catch(() => {})
    return {}
  })

  r('DELETE', '/api/referencias/fila/:id', async ({ params }) => {
    await svc().cancelarItemDaFila(id(params.id))
    return {}
  })

  r('POST', '/api/referencias/fila/:id/tentar', async ({ params }) => {
    await svc().tentarItemDaFila(id(params.id))
    return {}
  })

  // yt-dlp: versão em uso e "procurar atualização agora" (Ajustes).
  r('POST', '/api/referencias/ytdlp/verificar', async () => {
    const u = svc().updater
    if (!u) throw new HttpProblem(404, 'Atualização do yt-dlp indisponível.')
    return { ytdlp: await u.verificar({ forcar: true }) }
  })
}
