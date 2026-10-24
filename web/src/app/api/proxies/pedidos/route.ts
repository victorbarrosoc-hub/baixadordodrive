import type { AjustesFormato, AjustesFrames, AjustesPedido, StatusPedidoProxy, TipoPedido } from "@/lib/db/schema";
import { lerJson } from "@/lib/http";
import { exigirProxies, falha, ID_DRIVE, MSG, ok } from "@/lib/proxies/api";
import { contaDaPessoa, type ItemNovo, listarPedidos, MAX_POR_PEDIDO, pedirProxies, STATUS, TIPOS } from "@/lib/proxies/pedidos";
import { ehFormato } from "@/lib/referencias/formatos";

/** Frames e formatos: no máximo isto de uma vez (cada um é um trabalho pesado no computador). */
const MAX_FRAMES = 20;

/** Ajustes de "Baixar como…": só um formato que o computador sabe fazer (o original já está no Drive). */
function lerAjustesFormato(v: unknown): AjustesFormato | null {
  const f = (v as Record<string, unknown> | null)?.formato;
  return ehFormato(f) ? { formato: f } : null;
}

/** Ajustes de Frames vindos do celular: só o que o computador sabe fazer, dentro dos limites dele. */
function lerAjustes(v: unknown): AjustesFrames | null {
  const o = (v ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const f = o.frames ?? {};
  const inteiro = (x: unknown, min: number, max: number) => (typeof x === "number" && Number.isInteger(x) && x >= min && x <= max ? x : null);
  const q = inteiro(f.quantidade, 1, 300);
  if (q == null || !["jpg", "png", "tiff"].includes(f.formato)) return null;
  let takes: AjustesFrames["takes"] = null;
  if (o.takes != null) {
    const t = o.takes;
    const tq = inteiro(t.quantidade, 1, 60);
    const dur = typeof t.duracao === "number" && t.duracao >= 1 && t.duracao <= 15 ? t.duracao : null;
    if (tq == null || dur == null || !["original", "9:16", "4:5", "1:1"].includes(t.formato) || !["h264", "prores"].includes(t.codec)) return null;
    takes = { quantidade: tq, duracao: dur, formato: t.formato, codec: t.codec, audio: t.audio !== false };
  }
  return { frames: { quantidade: q, formato: f.formato }, takes };
}

/**
 * Pedidos ao computador: `?status=pendente` (ou vários, separados por vírgula; `todos`), `?fileIds=a,b` e
 * `?tipo=proxy|frames|formato|todos` (sem tipo: proxy, que é o que os apps antigos do computador sabem fazer).
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
  const t = q.get("tipo") ?? "proxy";
  if (t !== "todos" && !(TIPOS as string[]).includes(t)) return falha(400, "entrada", MSG.entrada);
  return ok({ pedidos: await listarPedidos(atual.usuario.id, { status, fileIds, tipo: t === "todos" ? null : (t as TipoPedido) }) });
}

/**
 * `{ contaGoogleId, itens: [{ fileId, nome, tamanho? }], tipo?, ajustes? }`. O mesmo arquivo já esperando (do mesmo
 * tipo; nos de formato, do mesmo formato) não entra de novo. Frames precisa de `ajustes`; formato, de
 * `ajustes: { formato: "mp3-320" | "wav" | "m4a" | "mp4" | "mp4-1080" | "mp4-720" | "jpg" }`.
 */
export async function POST(req: Request) {
  const atual = await exigirProxies(req, { mutacao: true });
  if (atual instanceof Response) return atual;
  const corpo = await lerJson(req);
  if (!corpo || typeof corpo.contaGoogleId !== "string" || !Array.isArray(corpo.itens) || !corpo.itens.length) {
    return falha(400, "entrada", MSG.entrada);
  }
  const tipo: TipoPedido = corpo.tipo == null ? "proxy" : (corpo.tipo as TipoPedido);
  if (!TIPOS.includes(tipo)) return falha(400, "entrada", MSG.entrada);
  const max = tipo === "proxy" ? MAX_POR_PEDIDO : MAX_FRAMES;
  if (corpo.itens.length > max) return falha(400, "muitos", `Até ${max} vídeos por vez.`);
  const ajustes: AjustesPedido | null = tipo === "frames" ? lerAjustes(corpo.ajustes) : tipo === "formato" ? lerAjustesFormato(corpo.ajustes) : null;
  if (tipo !== "proxy" && !ajustes) return falha(400, "entrada", MSG.entrada);
  const itens: ItemNovo[] = [];
  for (const i of corpo.itens as unknown[]) {
    const o = (i ?? {}) as Record<string, unknown>;
    if (typeof o.fileId !== "string" || !ID_DRIVE.test(o.fileId)) return falha(400, "entrada", MSG.entrada);
    const nome = typeof o.nome === "string" && o.nome.trim() ? o.nome.trim().slice(0, 300) : o.fileId;
    const tamanho = typeof o.tamanho === "number" && Number.isFinite(o.tamanho) && o.tamanho >= 0 ? Math.floor(o.tamanho) : null;
    itens.push({ fileId: o.fileId, nome, tamanho });
  }
  if (!(await contaDaPessoa(atual.usuario.id, corpo.contaGoogleId))) return falha(404, "conta", MSG.conta);
  const r = await pedirProxies(atual.usuario.id, corpo.contaGoogleId, itens, { tipo, ajustes });
  return ok(r, r.novos ? 201 : 200);
}
