import type { StatusFila } from "@/lib/db/schema";
import { lerJson } from "@/lib/http";
import { exigirReferencias, falha, MSG, ok } from "@/lib/referencias/api";
import { mudarItem, removerItem } from "@/lib/referencias/fila";

const PODE: StatusFila[] = ["pronto", "erro", "pendente", "baixando"];

/**
 * `{ status: 'pronto'|'erro'|'pendente'|'baixando', driveFileId?, erro? }`.
 * O computador que pegou o item muda tudo ('baixando' = sinal de vida); o dono pelo site só devolve para 'pendente'.
 */
export async function PATCH(req: Request, ctx: RouteContext<"/api/referencias/fila/[id]">) {
  const atual = await exigirReferencias(req, { mutacao: true });
  if (atual instanceof Response) return atual;
  const { id } = await ctx.params;
  const corpo = await lerJson(req);
  const status = corpo?.status as StatusFila | undefined;
  if (!corpo || !status || !PODE.includes(status)) return falha(400, "entrada", MSG.entrada);
  const driveFileId = typeof corpo.driveFileId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(corpo.driveFileId) ? corpo.driveFileId : null;
  if (corpo.driveFileId !== undefined && !driveFileId) return falha(400, "entrada", MSG.entrada);
  const erro = typeof corpo.erro === "string" ? corpo.erro : null;
  const r = await mudarItem(atual.usuario.id, id, { via: atual.via, sessaoId: atual.sessao.id }, { status, driveFileId, erro });
  if (!r.ok) return falha(r.status, r.erro, r.mensagem);
  return ok({ item: r.item });
}

/** Cancela (tira da fila). */
export async function DELETE(req: Request, ctx: RouteContext<"/api/referencias/fila/[id]">) {
  const atual = await exigirReferencias(req, { mutacao: true });
  if (atual instanceof Response) return atual;
  const { id } = await ctx.params;
  if (!(await removerItem(atual.usuario.id, id))) return falha(404, "nao_encontrado", MSG.item);
  return ok();
}
