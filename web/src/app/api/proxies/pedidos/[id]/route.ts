import type { StatusPedidoProxy } from "@/lib/db/schema";
import { lerJson } from "@/lib/http";
import { exigirProxies, falha, ID_DRIVE, MSG, ok } from "@/lib/proxies/api";
import { mudarPedido, removerPedido, STATUS } from "@/lib/proxies/pedidos";

/**
 * `{ status, erro?, resultado?, proxyFileId? }`. O computador que pegou muda tudo ('gerando' = sinal de vida);
 * o dono pelo celular só devolve para 'pendente' (tentar de novo).
 */
export async function PATCH(req: Request, ctx: RouteContext<"/api/proxies/pedidos/[id]">) {
  const atual = await exigirProxies(req, { mutacao: true });
  if (atual instanceof Response) return atual;
  const { id } = await ctx.params;
  const corpo = await lerJson(req);
  const status = corpo?.status as StatusPedidoProxy | undefined;
  if (!corpo || !status || !STATUS.includes(status)) return falha(400, "entrada", MSG.entrada);
  const proxyFileId = typeof corpo.proxyFileId === "string" && ID_DRIVE.test(corpo.proxyFileId) ? corpo.proxyFileId : null;
  if (corpo.proxyFileId != null && !proxyFileId) return falha(400, "entrada", MSG.entrada);
  const erro = typeof corpo.erro === "string" ? corpo.erro : null;
  const resultado = typeof corpo.resultado === "string" ? corpo.resultado : null;
  const r = await mudarPedido(atual.usuario.id, id, { via: atual.via, sessaoId: atual.sessao.id }, { status, erro, resultado, proxyFileId });
  if (!r.ok) return falha(r.status, r.erro, r.mensagem);
  return ok({ pedido: r.pedido });
}

/** Cancela o pedido. */
export async function DELETE(req: Request, ctx: RouteContext<"/api/proxies/pedidos/[id]">) {
  const atual = await exigirProxies(req, { mutacao: true });
  if (atual instanceof Response) return atual;
  const { id } = await ctx.params;
  if (!(await removerPedido(atual.usuario.id, id))) return falha(404, "nao_encontrado", MSG.pedido);
  return ok();
}
