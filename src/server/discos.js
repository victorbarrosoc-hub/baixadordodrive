// Rotas de "Copiar entre discos" (docs/DISCOS.md). Andamento pelo SSE 'discos'.
import { DiscosService } from '../discos/servico.js'

/**
 * @param {{ route, ctx, HttpProblem, servico?: DiscosService }} o
 * @returns {{ view(): object, close(): Promise<void> }}
 */
export function registerDiscos({ route, ctx, HttpProblem, servico }) {
  const svc = servico || new DiscosService({ onChange: (v) => ctx.hub?.send('discos', v), log: ctx.log })
  ctx.discos = svc
  const tratar = (fn) => async (a) => {
    try {
      return await fn(a)
    } catch (err) {
      if (err?.name === 'DiscosError') throw new HttpProblem(err.status === 499 ? 409 : err.status, err.message)
      throw err
    }
  }
  const texto = (v) => (typeof v === 'string' && v.length <= 4096 ? v : null)

  route('GET', '/api/discos', tratar(async () => svc.view()))

  route('POST', '/api/discos/planejar', tratar(async ({ body }) => {
    const origem = texto(body.origem)
    const destinos = Array.isArray(body.destinos) ? body.destinos.map(texto) : []
    if (!origem) throw new HttpProblem(400, 'Escolha a origem.')
    if (!destinos.length || destinos.some((d) => !d)) throw new HttpProblem(400, 'Escolha pelo menos um destino.')
    // Procura em qualquer pasta do destino o que não estiver no caminho esperado (desliga com procurarTudo: false).
    return svc.planejar({ origem, destinos, nome: texto(body.nome), procurarTudo: body.procurarTudo !== false })
  }))

  route('GET', '/api/discos/itens', tratar(async ({ query }) => {
    const estado = ['novo', 'igual', 'diferente', 'outro'].includes(query.get('estado')) ? query.get('estado') : null
    return svc.itens({ estado, destino: Math.max(0, Math.min(3, Number(query.get('destino')) || 0)), de: Math.max(0, Number(query.get('de')) || 0), limite: 300 })
  }))

  route('POST', '/api/discos/iniciar', tratar(async ({ body }) =>
    svc.iniciar({
      substituir: body.substituir === true,
      conferir: body.conferir !== false,
      conferirIguais: body.conferirIguais === true,
      relatorio: body.relatorio !== false,
      algoritmo: body.algoritmo == null ? 'xxh64' : String(body.algoritmo),
      juntar: body.juntar !== false,
    })))

  route('POST', '/api/discos/cancelar', tratar(async () => svc.cancelar()))

  route('POST', '/api/discos/limpar', tratar(async () => svc.limpar()))

  return { view: () => svc.view(), close: () => svc.close() }
}
