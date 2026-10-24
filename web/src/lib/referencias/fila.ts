/**
 * Fila das Referências (docs/REFERENCIAS.md §3): o celular (ou o Atalho do iPhone) guarda o link e o app do
 * computador pega, baixa e sobe para a pasta da coleção.
 */
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { novoId } from "@/lib/auth/tokens";
import { db, schema } from "@/lib/db";
import type { FormatoReferencia, StatusFila } from "@/lib/db/schema";
import { plataformaDe } from "./texto";

const { referenciasFila: fila, colecoes } = schema;

export const STATUS: StatusFila[] = ["pendente", "baixando", "pronto", "erro"];
/** Item "baixando" sem notícia do computador há mais que isso volta a ficar livre para outro pegar. */
export const PRAZO_BAIXANDO_MS = 30 * 60_000;
/** Itens prontos somem da fila depois disso (o arquivo continua no Drive). */
const GUARDAR_PRONTOS_MS = 30 * 24 * 60 * 60_000;

export type ItemFila = {
  id: string;
  url: string;
  plataforma: string;
  nota: string | null;
  status: StatusFila;
  erro: string | null;
  driveFileId: string | null;
  dispositivoId: string | null;
  /** "Também salvar como": formatos que o computador salva ao lado do original. */
  formatos: FormatoReferencia[];
  colecao: { id: string; nome: string; driveFolderId: string; contaGoogleId: string };
  criadoEm: string;
  atualizadoEm: string;
};

const CAMPOS = {
  item: fila,
  colecao: { id: colecoes.id, nome: colecoes.nome, driveFolderId: colecoes.driveFolderId, contaGoogleId: colecoes.contaGoogleId },
};

type LinhaComColecao = { item: typeof fila.$inferSelect; colecao: ItemFila["colecao"] };

function publico({ item, colecao }: LinhaComColecao): ItemFila {
  return {
    id: item.id,
    url: item.url,
    plataforma: plataformaDe(item.url),
    nota: item.nota,
    status: item.status,
    erro: item.erro,
    driveFileId: item.driveFileId,
    dispositivoId: item.dispositivoId,
    formatos: item.formatos ?? [],
    colecao,
    criadoEm: item.criadoEm.toISOString(),
    atualizadoEm: item.atualizadoEm.toISOString(),
  };
}

async function umItem(usuarioId: string, id: string): Promise<ItemFila | null> {
  const [l] = await db
    .select(CAMPOS)
    .from(fila)
    .innerJoin(colecoes, eq(colecoes.id, fila.colecaoId))
    .where(and(eq(fila.id, id), eq(fila.usuarioId, usuarioId)))
    .limit(1);
  return l ? publico(l) : null;
}

/** Devolve para a fila o que um computador pegou e largou (sem notícia há 30 min). */
async function liberarParados(usuarioId: string) {
  await db
    .update(fila)
    .set({ status: "pendente", dispositivoId: null, atualizadoEm: new Date() })
    .where(and(eq(fila.usuarioId, usuarioId), eq(fila.status, "baixando"), lt(fila.atualizadoEm, new Date(Date.now() - PRAZO_BAIXANDO_MS))));
}

export async function listarFila(usuarioId: string, filtro: { status?: StatusFila[]; colecaoId?: string } = {}): Promise<ItemFila[]> {
  await liberarParados(usuarioId);
  if (Math.random() < 0.05) {
    await db.delete(fila).where(and(eq(fila.usuarioId, usuarioId), eq(fila.status, "pronto"), lt(fila.atualizadoEm, new Date(Date.now() - GUARDAR_PRONTOS_MS))));
  }
  const conds = [eq(fila.usuarioId, usuarioId)];
  if (filtro.status?.length) conds.push(inArray(fila.status, filtro.status));
  if (filtro.colecaoId) conds.push(eq(fila.colecaoId, filtro.colecaoId));
  const linhas = await db
    .select(CAMPOS)
    .from(fila)
    .innerJoin(colecoes, eq(colecoes.id, fila.colecaoId))
    .where(and(...conds))
    .orderBy(desc(fila.criadoEm))
    .limit(500);
  return linhas.map(publico);
}

/**
 * Guarda o link. Já está na fila (mesmo link, mesma coleção, ainda não baixado)? Devolve o que existe (com os
 * formatos novos somados, se o computador ainda não pegou).
 */
export async function adicionarNaFila(
  usuarioId: string,
  colecaoId: string,
  url: string,
  nota: string | null,
  formatos: FormatoReferencia[] = [],
): Promise<{ item: ItemFila; novo: boolean }> {
  const [existente] = await db
    .select({ id: fila.id, status: fila.status, formatos: fila.formatos })
    .from(fila)
    .where(and(eq(fila.usuarioId, usuarioId), eq(fila.colecaoId, colecaoId), eq(fila.url, url), inArray(fila.status, ["pendente", "baixando"])))
    .limit(1);
  if (existente) {
    const juntos = [...new Set([...(existente.formatos ?? []), ...formatos])];
    if (existente.status === "pendente" && juntos.length !== (existente.formatos ?? []).length) {
      await db
        .update(fila)
        .set({ formatos: juntos, atualizadoEm: new Date() })
        .where(and(eq(fila.id, existente.id), eq(fila.status, "pendente")));
    }
    return { item: (await umItem(usuarioId, existente.id))!, novo: false };
  }
  const id = novoId();
  await db.insert(fila).values({ id, usuarioId, colecaoId, url, nota, formatos: formatos.length ? formatos : null });
  return { item: (await umItem(usuarioId, id))!, novo: true };
}

/**
 * O computador pega o item (pendente → baixando) de uma vez só: dois computadores pedindo ao mesmo tempo, só um
 * leva. O mesmo computador pedindo de novo recebe o item outra vez (pedido repetido depois de uma queda de rede).
 */
export async function pegarItem(usuarioId: string, id: string, dispositivoId: string): Promise<{ ok: true; item: ItemFila } | { ok: false; motivo: "nao_encontrado" | "ocupado" }> {
  const limite = new Date(Date.now() - PRAZO_BAIXANDO_MS);
  const r = await db
    .update(fila)
    .set({ status: "baixando", dispositivoId, erro: null, atualizadoEm: new Date() })
    .where(
      and(
        eq(fila.id, id),
        eq(fila.usuarioId, usuarioId),
        or(eq(fila.status, "pendente"), and(eq(fila.status, "baixando"), or(eq(fila.dispositivoId, dispositivoId), lt(fila.atualizadoEm, limite)))),
      ),
    )
    .returning({ id: fila.id });
  if (r.length) return { ok: true, item: (await umItem(usuarioId, id))! };
  const atual = await umItem(usuarioId, id);
  return { ok: false, motivo: atual ? "ocupado" : "nao_encontrado" };
}

export type Mudanca = { status: StatusFila; driveFileId?: string | null; erro?: string | null };

/**
 * Muda o estado. Quem pode:
 * - o computador que pegou o item: pronto (com driveFileId), erro, pendente (devolver) ou baixando (sinal de vida);
 * - o dono pelo site/celular: só pendente (tentar de novo um erro, ou soltar um item preso).
 */
export async function mudarItem(
  usuarioId: string,
  id: string,
  quem: { via: "cookie" | "bearer"; sessaoId: string },
  m: Mudanca,
): Promise<{ ok: true; item: ItemFila } | { ok: false; status: number; erro: string; mensagem: string }> {
  const atual = await umItem(usuarioId, id);
  if (!atual) return { ok: false, status: 404, erro: "nao_encontrado", mensagem: "Este link não está mais na fila." };
  const doComputador = quem.via === "bearer" && atual.status === "baixando" && atual.dispositivoId === quem.sessaoId;
  if (!doComputador) {
    // Dono (ou outro computador da conta) só devolve para a fila. "pendente" num pendente não muda nada.
    if (m.status !== "pendente") {
      return quem.via === "bearer"
        ? { ok: false, status: 409, erro: "ocupado", mensagem: "Outro computador pegou este link." }
        : { ok: false, status: 403, erro: "so_computador", mensagem: "Só o computador que está baixando muda este estado." };
    }
    if (atual.status === "pronto") return { ok: false, status: 409, erro: "pronto", mensagem: "Este link já foi baixado." };
    // Outro computador da conta não solta o que um computador está baixando.
    if (quem.via === "bearer" && atual.status === "baixando") return { ok: false, status: 409, erro: "ocupado", mensagem: "Outro computador pegou este link." };
  }
  if (m.status === "pronto" && !m.driveFileId) return { ok: false, status: 400, erro: "entrada", mensagem: "Falta o driveFileId." };
  const set: Partial<typeof fila.$inferInsert> = { status: m.status, atualizadoEm: new Date() };
  if (m.status === "pronto") Object.assign(set, { driveFileId: m.driveFileId, erro: null });
  if (m.status === "erro") set.erro = (m.erro ?? "").slice(0, 500) || "Não deu para baixar.";
  if (m.status === "pendente") Object.assign(set, { dispositivoId: null, erro: null });
  // A condição repete o que foi conferido: se o estado mudou no meio (outro pedido), nada é gravado.
  const conds = [eq(fila.id, id), eq(fila.usuarioId, usuarioId), eq(fila.status, atual.status)];
  if (doComputador) conds.push(eq(fila.dispositivoId, quem.sessaoId));
  const r = await db.update(fila).set(set).where(and(...conds)).returning({ id: fila.id });
  if (!r.length) return { ok: false, status: 409, erro: "mudou", mensagem: "O estado deste link mudou. Atualize a lista." };
  return { ok: true, item: (await umItem(usuarioId, id))! };
}

export async function removerItem(usuarioId: string, id: string): Promise<boolean> {
  const r = await db.delete(fila).where(and(eq(fila.id, id), eq(fila.usuarioId, usuarioId))).returning({ id: fila.id });
  return r.length > 0;
}

/** Quantos links a pessoa tem esperando (para o resumo). */
export async function contarPendentes(usuarioId: string): Promise<number> {
  const [l] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(fila)
    .where(and(eq(fila.usuarioId, usuarioId), inArray(fila.status, ["pendente", "baixando"])));
  return Number(l?.n ?? 0);
}
