/**
 * Chave do Atalho do iPhone (docs/REFERENCIAS.md §5): `Authorization: Atalho sda_<43>`. Só serve para pôr links
 * na fila (POST /api/referencias/atalho); não abre a conta, não lê nada, não vale como Bearer. Uma chave ativa por
 * conta: gerar outra derruba a anterior. No banco, só o sha256.
 */
import { and, eq, isNull } from "drizzle-orm";
import { hashToken, novoId, novoToken } from "@/lib/auth/tokens";
import { db, schema } from "@/lib/db";

const { atalhos, usuarios } = schema;

export const PREFIXO_ATALHO = "sda_";
export const FORMATO_ATALHO = /^sda_[A-Za-z0-9_-]{43}$/;

/** Gera a chave nova (derruba as anteriores). O valor só sai daqui uma vez. */
export async function gerarAtalho(usuarioId: string): Promise<{ token: string; criadoEm: Date }> {
  const token = PREFIXO_ATALHO + novoToken();
  const criadoEm = new Date();
  await db.transaction(async (t) => {
    await t.update(atalhos).set({ revogadoEm: criadoEm }).where(and(eq(atalhos.usuarioId, usuarioId), isNull(atalhos.revogadoEm)));
    await t.insert(atalhos).values({ id: novoId(), usuarioId, tokenHash: hashToken(token), criadoEm });
  });
  return { token, criadoEm };
}

export async function revogarAtalhos(usuarioId: string): Promise<number> {
  const r = await db
    .update(atalhos)
    .set({ revogadoEm: new Date() })
    .where(and(eq(atalhos.usuarioId, usuarioId), isNull(atalhos.revogadoEm)))
    .returning({ id: atalhos.id });
  return r.length;
}

export async function estadoAtalho(usuarioId: string): Promise<{ ativo: boolean; criadoEm: string | null; ultimoUsoEm: string | null }> {
  const [l] = await db
    .select({ criadoEm: atalhos.criadoEm, ultimoUsoEm: atalhos.ultimoUsoEm })
    .from(atalhos)
    .where(and(eq(atalhos.usuarioId, usuarioId), isNull(atalhos.revogadoEm)))
    .limit(1);
  return { ativo: Boolean(l), criadoEm: l?.criadoEm.toISOString() ?? null, ultimoUsoEm: l?.ultimoUsoEm?.toISOString() ?? null };
}

/** "Atalho sda_..." → dono da chave (e marca o uso), ou null. */
export async function donoDoAtalho(authorization: string | null): Promise<{ atalhoId: string; usuario: { id: string; email: string; nome: string } } | null> {
  const m = /^Atalho\s+(\S+)\s*$/i.exec(authorization ?? "");
  if (!m || !FORMATO_ATALHO.test(m[1])) return null;
  const [l] = await db
    .select({ atalhoId: atalhos.id, usuario: { id: usuarios.id, email: usuarios.email, nome: usuarios.nome } })
    .from(atalhos)
    .innerJoin(usuarios, eq(usuarios.id, atalhos.usuarioId))
    .where(and(eq(atalhos.tokenHash, hashToken(m[1])), isNull(atalhos.revogadoEm)))
    .limit(1);
  if (!l) return null;
  await db.update(atalhos).set({ ultimoUsoEm: new Date() }).where(eq(atalhos.id, l.atalhoId));
  return l;
}
