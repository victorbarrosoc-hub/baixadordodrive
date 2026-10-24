import type { StatusFila } from "@/lib/db/schema";
import { lerJson } from "@/lib/http";
import { exigirReferencias, falha, MSG, ok } from "@/lib/referencias/api";
import { acharColecao } from "@/lib/referencias/colecoes";
import { adicionarNaFila, listarFila, STATUS } from "@/lib/referencias/fila";
import { lerFormatos } from "@/lib/referencias/formatos";
import { limparUrl } from "@/lib/referencias/texto";

/**
 * Fila do computador: `?status=pendente` (ou vários, separados por vírgula; `todos`) e `?colecao=<id>`.
 * Sem status: pendente, baixando e erro.
 */
export async function GET(req: Request) {
  const atual = await exigirReferencias(req, { mutacao: false });
  if (atual instanceof Response) return atual;
  const q = new URL(req.url).searchParams;
  const pedido = (q.get("status") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let status: StatusFila[] | undefined = ["pendente", "baixando", "erro"];
  if (pedido.includes("todos")) status = undefined;
  else if (pedido.length) {
    if (!pedido.every((s) => (STATUS as string[]).includes(s))) return falha(400, "entrada", MSG.entrada);
    status = pedido as StatusFila[];
  }
  const colecaoId = q.get("colecao") ?? undefined;
  return ok({ itens: await listarFila(atual.usuario.id, { status, colecaoId }) });
}

/**
 * Guarda um link para o computador baixar: `{ url, colecaoId, nota?, formatos? }` (`formatos`: "Também salvar como",
 * ex.: ["mp3-320"]). Mesmo link já esperando → devolve o que existe.
 */
export async function POST(req: Request) {
  const atual = await exigirReferencias(req, { mutacao: true });
  if (atual instanceof Response) return atual;
  const corpo = await lerJson(req);
  if (!corpo) return falha(400, "entrada", MSG.entrada);
  const url = limparUrl(corpo.url);
  if (!url) return falha(400, "url", "Cole um link que comece com https://");
  if (typeof corpo.colecaoId !== "string") return falha(400, "entrada", MSG.entrada);
  const nota = typeof corpo.nota === "string" && corpo.nota.trim() ? corpo.nota.trim().slice(0, 2000) : null;
  const formatos = lerFormatos(corpo.formatos);
  if (!formatos) return falha(400, "entrada", "Formato desconhecido.");
  const colecao = await acharColecao(atual.usuario.id, corpo.colecaoId);
  if (!colecao) return falha(404, "nao_encontrada", MSG.colecao);
  const r = await adicionarNaFila(atual.usuario.id, colecao.id, url, nota, formatos);
  return ok({ item: r.item, novo: r.novo }, r.novo ? 201 : 200);
}
