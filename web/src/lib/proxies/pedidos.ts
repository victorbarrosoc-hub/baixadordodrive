/**
 * Pedidos de proxy (docs/CONTAS.md §11): o celular marca vídeos e pede; o app do computador pega um por vez, gera o
 * proxy 720p e a tira de quadros (o hover scrub) e conta como foi. Mesmo esquema da fila das Referências: pegar de
 * uma vez só (dois computadores, só um leva), sinal de vida e "gerando" sem notícia por 30 min volta para a fila.
 */
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { novoId } from "@/lib/auth/tokens";
import { db, schema } from "@/lib/db";
import type { StatusPedidoProxy } from "@/lib/db/schema";

const { pedidosProxy: pedidos, contasGoogle } = schema;

export const STATUS: StatusPedidoProxy[] = ["pendente", "gerando", "pronto", "erro"];
/** Pedido "gerando" sem notícia do computador há mais que isso volta a ficar livre. */
export const PRAZO_GERANDO_MS = 30 * 60_000;
/** Pedidos terminados somem depois disso (o proxy continua no Drive). */
const GUARDAR_FEITOS_MS = 14 * 24 * 60 * 60_000;
/** Por pedido do celular. */
export const MAX_POR_PEDIDO = 200;

export type PedidoProxy = {
  id: string;
  contaGoogleId: string;
  fileId: string;
  nome: string;
  tamanho: number | null;
  status: StatusPedidoProxy;
  erro: string | null;
  resultado: string | null;
  proxyFileId: string | null;
  dispositivoId: string | null;
  criadoEm: string;
  atualizadoEm: string;
};

type Linha = typeof pedidos.$inferSelect;

function publico(l: Linha): PedidoProxy {
  return {
    id: l.id,
    contaGoogleId: l.contaGoogleId,
    fileId: l.fileId,
    nome: l.nome,
    tamanho: l.tamanho,
    status: l.status,
    erro: l.erro,
    resultado: l.resultado,
    proxyFileId: l.proxyFileId,
    dispositivoId: l.dispositivoId,
    criadoEm: l.criadoEm.toISOString(),
    atualizadoEm: l.atualizadoEm.toISOString(),
  };
}

async function umPedido(usuarioId: string, id: string): Promise<PedidoProxy | null> {
  const [l] = await db.select().from(pedidos).where(and(eq(pedidos.id, id), eq(pedidos.usuarioId, usuarioId))).limit(1);
  return l ? publico(l) : null;
}

/** A conta Google é desta pessoa? */
export async function contaDaPessoa(usuarioId: string, contaGoogleId: string): Promise<boolean> {
  const [c] = await db
    .select({ id: contasGoogle.id })
    .from(contasGoogle)
    .where(and(eq(contasGoogle.id, contaGoogleId), eq(contasGoogle.usuarioId, usuarioId)))
    .limit(1);
  return Boolean(c);
}

async function arrumar(usuarioId: string) {
  await db
    .update(pedidos)
    .set({ status: "pendente", dispositivoId: null, atualizadoEm: new Date() })
    .where(and(eq(pedidos.usuarioId, usuarioId), eq(pedidos.status, "gerando"), lt(pedidos.atualizadoEm, new Date(Date.now() - PRAZO_GERANDO_MS))));
  if (Math.random() < 0.05) {
    await db
      .delete(pedidos)
      .where(and(eq(pedidos.usuarioId, usuarioId), inArray(pedidos.status, ["pronto", "erro"]), lt(pedidos.atualizadoEm, new Date(Date.now() - GUARDAR_FEITOS_MS))));
  }
}

export async function listarPedidos(usuarioId: string, filtro: { status?: StatusPedidoProxy[]; fileIds?: string[] } = {}): Promise<PedidoProxy[]> {
  await arrumar(usuarioId);
  const conds = [eq(pedidos.usuarioId, usuarioId)];
  if (filtro.status?.length) conds.push(inArray(pedidos.status, filtro.status));
  if (filtro.fileIds?.length) conds.push(inArray(pedidos.fileId, filtro.fileIds));
  const linhas = await db
    .select()
    .from(pedidos)
    .where(and(...conds))
    .orderBy(desc(pedidos.criadoEm))
    .limit(500);
  return linhas.map(publico);
}

export type ItemNovo = { fileId: string; nome: string; tamanho: number | null };

/**
 * Guarda os pedidos. O mesmo arquivo já esperando (pendente ou gerando) não entra de novo: volta o que existe.
 * Devolve todos (novos e os que já estavam) na ordem pedida.
 */
export async function pedirProxies(usuarioId: string, contaGoogleId: string, itens: ItemNovo[]): Promise<{ pedidos: PedidoProxy[]; novos: number }> {
  const ids = [...new Set(itens.map((i) => i.fileId))];
  const existentes = await db
    .select()
    .from(pedidos)
    .where(and(eq(pedidos.usuarioId, usuarioId), eq(pedidos.contaGoogleId, contaGoogleId), inArray(pedidos.fileId, ids), inArray(pedidos.status, ["pendente", "gerando"])));
  const porArquivo = new Map(existentes.map((l) => [l.fileId, l]));
  const novas: (typeof pedidos.$inferInsert)[] = [];
  const vistos = new Set<string>();
  for (const i of itens) {
    if (porArquivo.has(i.fileId) || vistos.has(i.fileId)) continue;
    vistos.add(i.fileId);
    novas.push({ id: novoId(), usuarioId, contaGoogleId, fileId: i.fileId, nome: i.nome, tamanho: i.tamanho });
  }
  if (novas.length) {
    const criadas = await db.insert(pedidos).values(novas).returning();
    for (const l of criadas) porArquivo.set(l.fileId, l);
  }
  return { pedidos: ids.map((id) => porArquivo.get(id)).filter((l): l is Linha => Boolean(l)).map(publico), novos: novas.length };
}

/** O computador pega o pedido (pendente → gerando) de uma vez só. O mesmo computador pedindo de novo recebe outra vez. */
export async function pegarPedido(
  usuarioId: string,
  id: string,
  dispositivoId: string,
): Promise<{ ok: true; pedido: PedidoProxy } | { ok: false; motivo: "nao_encontrado" | "ocupado" }> {
  const limite = new Date(Date.now() - PRAZO_GERANDO_MS);
  const r = await db
    .update(pedidos)
    .set({ status: "gerando", dispositivoId, erro: null, atualizadoEm: new Date() })
    .where(
      and(
        eq(pedidos.id, id),
        eq(pedidos.usuarioId, usuarioId),
        or(eq(pedidos.status, "pendente"), and(eq(pedidos.status, "gerando"), or(eq(pedidos.dispositivoId, dispositivoId), lt(pedidos.atualizadoEm, limite)))),
      ),
    )
    .returning({ id: pedidos.id });
  if (r.length) return { ok: true, pedido: (await umPedido(usuarioId, id))! };
  return { ok: false, motivo: (await umPedido(usuarioId, id)) ? "ocupado" : "nao_encontrado" };
}

export type Mudanca = { status: StatusPedidoProxy; erro?: string | null; resultado?: string | null; proxyFileId?: string | null };

/**
 * Muda o estado. O computador que pegou: pronto, erro, pendente (devolver) ou gerando (sinal de vida). O dono pelo
 * celular/site: só pendente (tentar de novo um erro, soltar um preso).
 */
export async function mudarPedido(
  usuarioId: string,
  id: string,
  quem: { via: "cookie" | "bearer"; sessaoId: string },
  m: Mudanca,
): Promise<{ ok: true; pedido: PedidoProxy } | { ok: false; status: number; erro: string; mensagem: string }> {
  const atual = await umPedido(usuarioId, id);
  if (!atual) return { ok: false, status: 404, erro: "nao_encontrado", mensagem: "Este pedido não existe mais." };
  const doComputador = quem.via === "bearer" && atual.status === "gerando" && atual.dispositivoId === quem.sessaoId;
  if (!doComputador) {
    if (m.status !== "pendente") {
      return quem.via === "bearer"
        ? { ok: false, status: 409, erro: "ocupado", mensagem: "Outro computador pegou este pedido." }
        : { ok: false, status: 403, erro: "so_computador", mensagem: "Só o computador que está gerando muda este estado." };
    }
    if (atual.status === "pronto") return { ok: false, status: 409, erro: "pronto", mensagem: "Este proxy já foi gerado." };
    if (quem.via === "bearer" && atual.status === "gerando") return { ok: false, status: 409, erro: "ocupado", mensagem: "Outro computador pegou este pedido." };
  }
  const set: Partial<typeof pedidos.$inferInsert> = { status: m.status, atualizadoEm: new Date() };
  if (m.status === "pronto") Object.assign(set, { erro: null, resultado: (m.resultado ?? "").slice(0, 200) || null, proxyFileId: m.proxyFileId ?? null });
  if (m.status === "erro") set.erro = (m.erro ?? "").slice(0, 500) || "Não deu para gerar o proxy.";
  if (m.status === "pendente") Object.assign(set, { dispositivoId: null, erro: null });
  const conds = [eq(pedidos.id, id), eq(pedidos.usuarioId, usuarioId), eq(pedidos.status, atual.status)];
  if (doComputador) conds.push(eq(pedidos.dispositivoId, quem.sessaoId));
  const r = await db.update(pedidos).set(set).where(and(...conds)).returning({ id: pedidos.id });
  if (!r.length) return { ok: false, status: 409, erro: "mudou", mensagem: "O estado deste pedido mudou. Atualize a lista." };
  return { ok: true, pedido: (await umPedido(usuarioId, id))! };
}

export async function removerPedido(usuarioId: string, id: string): Promise<boolean> {
  const r = await db.delete(pedidos).where(and(eq(pedidos.id, id), eq(pedidos.usuarioId, usuarioId))).returning({ id: pedidos.id });
  return r.length > 0;
}
