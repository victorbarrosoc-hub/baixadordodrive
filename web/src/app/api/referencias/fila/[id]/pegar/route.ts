import { exigirReferencias, falha, MSG, ok } from "@/lib/referencias/api";
import { pegarItem } from "@/lib/referencias/fila";

/** O computador (só Bearer de dispositivo) pega o item para baixar. Outro já pegou → 409. */
export async function POST(req: Request, ctx: RouteContext<"/api/referencias/fila/[id]/pegar">) {
  const atual = await exigirReferencias(req, { mutacao: true });
  if (atual instanceof Response) return atual;
  if (atual.via !== "bearer") return falha(403, "so_computador", "Só o app do computador pega links para baixar.");
  const { id } = await ctx.params;
  const r = await pegarItem(atual.usuario.id, id, atual.sessao.id);
  if (!r.ok) return r.motivo === "ocupado" ? falha(409, "ocupado", "Outro computador já pegou este link.") : falha(404, "nao_encontrado", MSG.item);
  return ok({ item: r.item });
}
