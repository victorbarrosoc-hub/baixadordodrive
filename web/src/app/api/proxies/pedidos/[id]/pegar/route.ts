import { exigirProxies, falha, MSG, ok } from "@/lib/proxies/api";
import { pegarPedido } from "@/lib/proxies/pedidos";

/** O computador (só Bearer de dispositivo) pega o pedido para gerar. Outro já pegou → 409. */
export async function POST(req: Request, ctx: RouteContext<"/api/proxies/pedidos/[id]/pegar">) {
  const atual = await exigirProxies(req, { mutacao: true });
  if (atual instanceof Response) return atual;
  if (atual.via !== "bearer") return falha(403, "so_computador", "Só o app do computador gera proxies.");
  const { id } = await ctx.params;
  const r = await pegarPedido(atual.usuario.id, id, atual.sessao.id);
  if (!r.ok) return r.motivo === "ocupado" ? falha(409, "ocupado", "Outro computador já pegou este pedido.") : falha(404, "nao_encontrado", MSG.pedido);
  return ok({ pedido: r.pedido });
}
