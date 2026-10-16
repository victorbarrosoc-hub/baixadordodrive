/**
 * Coleções de referências (docs/REFERENCIAS.md §2–3). Cada coleção é uma pasta em
 * "SOBEDESCE Referências/<nome>" num Drive da pessoa; o banco guarda o nome, a pasta e o token do link pra IA.
 */
import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { novoId } from "@/lib/auth/tokens";
import { db, schema } from "@/lib/db";
import { ErroConta } from "@/lib/google/contas";
import { aspas, atualizarArquivo, criarPasta, ErroDrive, lerArquivo, listarTudo, PASTA_MIME } from "@/lib/google/drive";
import { chaveNome } from "./texto";

const { colecoes, contasGoogle, referenciasFila } = schema;
type Linha = typeof colecoes.$inferSelect;

export const NOME_RAIZ = "SOBEDESCE Referências";
export const MARCA_RAIZ = "referencias";
export const MARCA_COLECAO = "colecao";

export type ColecaoPublica = {
  id: string;
  nome: string;
  contaGoogleId: string;
  driveFolderId: string;
  /** Endereço do link pra IA, ou null se desligado. */
  link: string | null;
  /** Links na fila (pendente, baixando ou com erro). */
  naFila: number;
  criadoEm: string;
  atualizadoEm: string;
};

export function linkPublico(origem: string, token: string | null): string | null {
  return token ? `${origem}/r/${token}` : null;
}

export function novoTokenPublico(): string {
  return randomBytes(32).toString("base64url");
}

export function publica(l: Linha, origem: string, naFila = 0): ColecaoPublica {
  return {
    id: l.id,
    nome: l.nome,
    contaGoogleId: l.contaGoogleId,
    driveFolderId: l.driveFolderId,
    link: linkPublico(origem, l.publicaToken),
    naFila,
    criadoEm: l.criadoEm.toISOString(),
    atualizadoEm: l.atualizadoEm.toISOString(),
  };
}

/** Coleções da pessoa (mais recentes primeiro), com a contagem da fila e as pastas raiz conhecidas. */
export async function listarColecoes(usuarioId: string) {
  const [linhas, contas, fila] = await Promise.all([
    db.select().from(colecoes).where(eq(colecoes.usuarioId, usuarioId)),
    db
      .select({ id: contasGoogle.id, pasta: contasGoogle.referenciasPastaId, estado: contasGoogle.estado, criadoEm: contasGoogle.criadoEm })
      .from(contasGoogle)
      .where(eq(contasGoogle.usuarioId, usuarioId))
      .orderBy(asc(contasGoogle.criadoEm)),
    db
      .select({ colecaoId: referenciasFila.colecaoId, n: sql<number>`count(*)::int` })
      .from(referenciasFila)
      .where(and(eq(referenciasFila.usuarioId, usuarioId), inArray(referenciasFila.status, ["pendente", "baixando", "erro"])))
      .groupBy(referenciasFila.colecaoId),
  ]);
  const porColecao = new Map(fila.map((f) => [f.colecaoId, Number(f.n)]));
  linhas.sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime());
  const raizes = contas.filter((c) => c.pasta).map((c) => ({ contaGoogleId: c.id, driveFolderId: c.pasta! }));
  const padrao = contas.find((c) => c.estado === "ok") ?? contas[0];
  const raiz = raizes.find((r) => r.contaGoogleId === padrao?.id) ?? raizes[0] ?? null;
  return { linhas, porColecao, raiz, raizes };
}

export async function acharColecao(usuarioId: string, id: string): Promise<Linha | null> {
  if (!id || id.length > 64) return null;
  const [l] = await db.select().from(colecoes).where(and(eq(colecoes.id, id), eq(colecoes.usuarioId, usuarioId))).limit(1);
  return l ?? null;
}

/** Por id ou por nome (sem maiúsculas nem acentos): o Atalho do iPhone manda o nome. */
export async function acharPorIdOuNome(usuarioId: string, valor: string): Promise<Linha | null> {
  const v = valor.trim();
  if (!v) return null;
  const [l] = await db
    .select()
    .from(colecoes)
    .where(and(eq(colecoes.usuarioId, usuarioId), sql`(${colecoes.id} = ${v} or ${colecoes.nomeChave} = ${chaveNome(v)})`))
    .limit(1);
  return l ?? null;
}

export class ErroColecao extends Error {
  constructor(
    public codigo: "duplicada" | "sem_drive" | "nao_encontrada",
    public status: number,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "ErroColecao";
  }
}

/** Conta Google da coleção nova: a pedida (precisa ser da pessoa) ou a primeira em ordem. */
async function contaPara(usuarioId: string, contaGoogleId?: string) {
  const contas = await db
    .select({ id: contasGoogle.id, estado: contasGoogle.estado, pasta: contasGoogle.referenciasPastaId, criadoEm: contasGoogle.criadoEm })
    .from(contasGoogle)
    .where(eq(contasGoogle.usuarioId, usuarioId))
    .orderBy(asc(contasGoogle.criadoEm));
  if (contaGoogleId) {
    const c = contas.find((x) => x.id === contaGoogleId);
    if (!c) throw new ErroColecao("nao_encontrada", 404, "Este Google Drive não está ligado à sua conta.");
    if (c.estado !== "ok") throw new ErroConta("reconectar");
    return c;
  }
  const c = contas.find((x) => x.estado === "ok");
  if (!c) throw new ErroColecao("sem_drive", 409, contas.length ? "Reconecte o Google Drive na sua conta." : "Conecte um Google Drive na sua conta primeiro.");
  return c;
}

/**
 * Pasta "SOBEDESCE Referências" deste Drive: a guardada (se ainda existe e não está na lixeira), a que tem a marca
 * (appProperties sobedesce=referencias, mesmo se a pessoa mudou de lugar) ou uma nova na raiz do Meu Drive.
 */
export async function garantirRaiz(usuarioId: string, conta: { id: string; pasta: string | null }): Promise<string> {
  if (conta.pasta) {
    try {
      const f = await lerArquivo(usuarioId, conta.id, conta.pasta);
      if (!f.trashed) return conta.pasta;
    } catch (e) {
      if (!(e instanceof ErroDrive && e.status === 404)) throw e;
    }
  }
  const achadas = await listarTudo(
    usuarioId,
    conta.id,
    `appProperties has { key='sobedesce' and value='${MARCA_RAIZ}' } and mimeType = '${PASTA_MIME}' and trashed = false`,
    "id,name,createdTime",
    {},
    1,
  );
  achadas.sort((a, b) => String(a.createdTime ?? "").localeCompare(String(b.createdTime ?? "")));
  const id = achadas[0]?.id ?? (await criarPasta(usuarioId, conta.id, NOME_RAIZ, "root", MARCA_RAIZ)).id;
  await db.update(contasGoogle).set({ referenciasPastaId: id }).where(eq(contasGoogle.id, conta.id));
  return id;
}

async function nomeOcupado(usuarioId: string, nome: string, menos?: string): Promise<boolean> {
  const [l] = await db
    .select({ id: colecoes.id })
    .from(colecoes)
    .where(and(eq(colecoes.usuarioId, usuarioId), eq(colecoes.nomeChave, chaveNome(nome))))
    .limit(1);
  return Boolean(l && l.id !== menos);
}

const DUPLICADA = () => new ErroColecao("duplicada", 409, "Você já tem uma coleção com esse nome.");

/** Cria a coleção: pasta no Drive (ou aproveita uma pasta com o mesmo nome dentro da raiz) e a linha no banco. */
export async function criarColecao(usuarioId: string, nome: string, contaGoogleId?: string): Promise<Linha> {
  if (await nomeOcupado(usuarioId, nome)) throw DUPLICADA();
  const conta = await contaPara(usuarioId, contaGoogleId);
  const raiz = await garantirRaiz(usuarioId, conta);
  const existentes = await listarTudo(usuarioId, conta.id, `${aspas(raiz)} in parents and name = ${aspas(nome)} and mimeType = '${PASTA_MIME}' and trashed = false`, "id,name", {}, 1);
  const existente = existentes.find((f) => f.name === nome);
  const pasta = existente ?? (await criarPasta(usuarioId, conta.id, nome, raiz, MARCA_COLECAO));
  const agora = new Date();
  const inserida = await db
    .insert(colecoes)
    .values({ id: novoId(), usuarioId, contaGoogleId: conta.id, driveFolderId: pasta.id, nome, nomeChave: chaveNome(nome), criadoEm: agora, atualizadoEm: agora })
    .onConflictDoNothing()
    .returning();
  if (!inserida.length) {
    // Duas criações com o mesmo nome ao mesmo tempo: a segunda desfaz a pasta que acabou de criar.
    if (!existente) await atualizarArquivo(usuarioId, conta.id, pasta.id, { trashed: true }).catch(() => {});
    throw DUPLICADA();
  }
  return inserida[0];
}

/** Novo nome (no banco e na pasta do Drive). Pasta apagada no Drive não impede. */
export async function renomearColecao(usuarioId: string, l: Linha, nome: string): Promise<Linha> {
  if (nome === l.nome) return l;
  if (await nomeOcupado(usuarioId, nome, l.id)) throw DUPLICADA();
  try {
    await atualizarArquivo(usuarioId, l.contaGoogleId, l.driveFolderId, { name: nome });
  } catch (e) {
    if (!(e instanceof ErroDrive && e.status === 404)) throw e;
  }
  const [nova] = await db
    .update(colecoes)
    .set({ nome, nomeChave: chaveNome(nome), atualizadoEm: new Date() })
    .where(and(eq(colecoes.id, l.id), eq(colecoes.usuarioId, usuarioId)))
    .returning();
  if (!nova) throw DUPLICADA();
  return nova;
}

/** Link pra IA: ligar (mantém o que já existe), trocar (endereço novo, o velho para de abrir) ou desligar. */
export async function mudarLink(usuarioId: string, l: Linha, acao: "ligar" | "desligar" | "trocar"): Promise<Linha> {
  const token = acao === "desligar" ? null : acao === "ligar" && l.publicaToken ? l.publicaToken : novoTokenPublico();
  const [nova] = await db
    .update(colecoes)
    .set({ publicaToken: token, atualizadoEm: new Date() })
    .where(and(eq(colecoes.id, l.id), eq(colecoes.usuarioId, usuarioId)))
    .returning();
  return nova ?? l;
}

/** Tira a coleção da plataforma. Com `noDrive`, põe a pasta na lixeira do Drive antes (pasta que já sumiu não impede). */
export async function apagarColecao(usuarioId: string, l: Linha, noDrive: boolean): Promise<void> {
  if (noDrive) {
    try {
      await atualizarArquivo(usuarioId, l.contaGoogleId, l.driveFolderId, { trashed: true });
    } catch (e) {
      if (!(e instanceof ErroDrive && e.status === 404)) throw e;
    }
  }
  await db.delete(colecoes).where(and(eq(colecoes.id, l.id), eq(colecoes.usuarioId, usuarioId)));
}

/** Coleção do link pra IA (só se o link estiver ligado), com o primeiro nome do dono. */
export async function colecaoPublica(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [l] = await db
    .select({ colecao: colecoes, nomeDono: schema.usuarios.nome })
    .from(colecoes)
    .innerJoin(schema.usuarios, eq(schema.usuarios.id, colecoes.usuarioId))
    .where(and(isNotNull(colecoes.publicaToken), eq(colecoes.publicaToken, token)))
    .limit(1);
  return l ?? null;
}
