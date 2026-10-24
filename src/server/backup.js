// Rotas do Backup Automático (Cartões → Projetos; docs/BACKUP-AUTOMATICO.md). Estado pelo SSE 'backup'; avisos
// 'backup-pedido' (cartão novo: de quem é?) e 'backup-feito' (descarga terminou).
import path from 'node:path'
import { BackupService } from '../backup/servico.js'

/**
 * @param {{ route, ctx, HttpProblem, servico?: BackupService }} o
 * @returns {{ view(): object, close(): Promise<void> }}
 */
export function registerBackup({ route, ctx, HttpProblem, servico }) {
  const svc =
    servico ||
    new BackupService({
      arquivo: ctx.paths?.root ? path.join(ctx.paths.root, 'backup-automatico.json') : null,
      onChange: (v) => ctx.hub?.send('backup', v),
      avisar: (ev, dados) => ctx.hub?.send(ev, dados),
      log: ctx.log,
    })
  ctx.backup = svc
  const pronto = svc.init().catch((err) => ctx.log?.('backup: iniciar', err?.message || err))
  const tratar = (fn) => async (a) => {
    await pronto
    try {
      return await fn(a)
    } catch (err) {
      if (err?.name === 'BackupError' || err?.name === 'DiscosError') throw new HttpProblem(err.status === 499 ? 409 : err.status, err.message)
      throw err
    }
  }
  const texto = (v, max = 4096) => (typeof v === 'string' && v.length <= max ? v : null)
  const lista = (v) => (Array.isArray(v) ? v.slice(0, 4).map((x) => texto(x)) : null)

  route('GET', '/api/backup', tratar(async () => svc.view()))

  route('POST', '/api/backup/projetos', tratar(async ({ body }) => svc.criarProjeto({ nome: texto(body.nome, 200), destinos: lista(body.destinos), ejetar: body.ejetar === true, ligar: body.ligar !== false })))

  route('POST', '/api/backup/projeto', tratar(async ({ body }) => {
    const id = texto(body.id, 100)
    if (!id) throw new HttpProblem(400, 'Projeto inválido.')
    return svc.editarProjeto(id, {
      nome: body.nome === undefined ? undefined : texto(body.nome, 200),
      destinos: body.destinos === undefined ? undefined : lista(body.destinos),
      ejetar: body.ejetar === undefined ? undefined : body.ejetar === true,
    })
  }))

  route('POST', '/api/backup/abrir', tratar(async ({ body }) => svc.abrir(texto(body.id, 100))))

  route('POST', '/api/backup/apagar', tratar(async ({ body }) => svc.apagarProjeto(texto(body.id, 100))))

  route('POST', '/api/backup/ligar', tratar(async ({ body }) => svc.ligar(body.ligado === true)))

  route('POST', '/api/backup/diaria', tratar(async ({ body }) => (body.n == null ? svc.novaDiaria() : svc.escolherDiaria(Number(body.n)))))

  route('POST', '/api/backup/responder', tratar(async ({ body }) =>
    svc.responder({
      caminho: texto(body.caminho),
      donoId: texto(body.donoId, 100),
      nome: texto(body.nome, 200),
      camera: texto(body.camera, 200),
      pasta: texto(body.pasta, 200),
      ignorar: body.ignorar === true,
    })))

  route('POST', '/api/backup/dono', tratar(async ({ body }) => {
    const id = texto(body.id, 100)
    if (!id) throw new HttpProblem(400, 'Dono inválido.')
    return svc.editarDono(id, {
      nome: body.nome === undefined ? undefined : texto(body.nome, 200),
      camera: body.camera === undefined ? undefined : texto(body.camera, 200),
      pasta: body.pasta === undefined ? undefined : texto(body.pasta, 200),
    })
  }))

  route('POST', '/api/backup/repetir', tratar(async ({ body }) => svc.repetir(texto(body.caminho))))

  route('POST', '/api/backup/usar', tratar(async ({ body }) => svc.usarComoCartao(texto(body.caminho))))

  route('POST', '/api/backup/ejetar', tratar(async ({ body }) => svc.ejetar(texto(body.caminho))))

  route('POST', '/api/backup/cancelar', tratar(async () => svc.cancelar()))

  route('POST', '/api/backup/ignorados/limpar', tratar(async () => svc.esquecerIgnorados()))

  return { view: () => svc.view(), close: () => svc.close() }
}
