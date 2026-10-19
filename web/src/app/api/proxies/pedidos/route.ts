import type { StatusPedidoProxy } from "@/lib/db/schema";
import { lerJson } from "@/lib/http";
import { exigirProxies, falha, ID_DRIVE, MSG, ok } from "@/lib/proxies/api";
import { contaDaPessoa, type ItemNovo, listarPedidos, MAX_POR_PEDIDO, pedirProxies, STATUS } from "@/lib/proxies/pedidos";

/**
 * Pedidos de proxy: `?status=pendente` (ou vários, separados por vírgula; `todos`) e `?fileIds=a,b`.
 * Sem status: todos (o celular quer ver os prontos também).
 */
export async function GET(req: Request) {
  const atual = await exigirProxies(req, { mutacao: false });
  if (atual instanceof Response) return atual;
  const q = new URL(req.url).searchParams;
  const pedido = (q.get("status") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let status: StatusPedidoProxy[] | undefined;
  if (pedido.length && !pedido.includes("todos")) {
    if (!pedido.every((s) => (STATUS as string[]).includes(s))) return falha(400, "entrada", MSG.entrada);
    status = pedido as StatusPedidoProxy[];
  }
  const fileIds = (q.get("fileIds") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (fileIds.length > MAX_POR_PEDIDO || !fileIds.every((f) => ID_DRIVE.test(f))) return falha(400, "entrada", MSG.entrada);
  return ok({ pedidos: await listarPedidos(atual.usuario.id, { status, fileIds }) });
}

/** `{ contaGoogleId, itens: [{ fileId, nome, tamanho? }] }`. O mesmo arquivo já esperando não entra de novo. */
export async function POST(req: Request) {
  const atual = await exigirProxies(req, { mutacao: true });
  if (atual instanceof Response) return atual;
  const corpo = await lerJson(req);
  if (!corpo || typeof corpo.contaGoogleId !== "string" || !Array.isArray(corpo.itens) || !corpo.itens.length) {
    return falha(400, "entrada", MSG.entrada);
  }
  if (corpo.itens.length > MAX_POR_PEDIDO) return falha(400, "muitos", `Até ${MAX_POR_PEDIDO} vídeos por vez.`);
  const itens: ItemNovo[] = [];
  for (const i of corpo.itens as unknown[]) {
    const o = (i ?? {}) as Record<string, unknown>;
    if (typeof o.fileId !== "string" || !ID_DRIVE.test(o.fileId)) return falha(400, "entrada", MSG.entrada);
    const nome = typeof o.nome === "string" && o.nome.trim() ? o.nome.trim().slice(0, 300) : o.fileId;
    const tamanho = typeof o.tamanho === "number" && Number.isFinite(o.tamanho) && o.tamanho >= 0 ? Math.floor(o.tamanho) : null;
    itens.push({ fileId: o.fileId, nome, tamanho });
  }
  if (!(await contaDaPessoa(atual.usuario.id, corpo.contaGoogleId))) return falha(404, "conta", MSG.conta);
  const r = await pedirProxies(atual.usuario.id, corpo.contaGoogleId, itens);
  return ok(r, r.novos ? 201 : 200);
}
