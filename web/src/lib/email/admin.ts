/**
 * Avisos por e-mail para os admins (SOBEDESCE_ADMINS, src/lib/admin.ts): conta nova e muitas transferências com erro
 * no mesmo dia. Cada aviso tem uma chave em avisos_admin e sai uma vez só, mesmo com dois pedidos ao mesmo tempo.
 * Nunca lançam (mesma regra de avisos.ts): uma falha vira linha de log e quem pediu segue.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { emailsAdmin } from "@/lib/admin";
import { enviarEmail, type Email } from "./enviar";
import { emailAdminContaNova, emailAdminErros } from "./modelos";

/** A partir de quantos erros no dia (somando os computadores da pessoa) o admin recebe o aviso. */
export const ERROS_PARA_AVISAR = 10;

/** Reserva a chave; true só para quem reservou primeiro. */
async function primeiraVez(chave: string): Promise<boolean> {
  const r = await db.insert(schema.avisosAdmin).values({ chave }).onConflictDoNothing().returning({ chave: schema.avisosAdmin.chave });
  return r.length > 0;
}

async function paraTodos(nome: string, chave: string, montar: (para: string) => Email): Promise<void> {
  try {
    const admins = emailsAdmin();
    if (!admins.length || !(await primeiraVez(chave))) return;
    await Promise.all(admins.map((a) => enviarEmail(montar(a))));
  } catch {
    console.warn(`[email] o aviso de admin "${nome}" não saiu.`);
  }
}

export function avisarAdminContaNova(u: { id: string; nome: string; email: string }, comGoogle: boolean): Promise<void> {
  return paraTodos("conta nova", `conta:${u.id}`, (para) => emailAdminContaNova(para, { nome: u.nome, email: u.email, quando: new Date(), comGoogle }));
}

/** Depois de gravar o uso do dia: soma os erros da pessoa naquele dia e avisa uma vez se passou do limite. */
export async function conferirErrosDoDia(usuarioId: string, dia: string): Promise<void> {
  try {
    const [soma] = await db
      .select({
        erros: sql<number>`coalesce(sum(${schema.usoDiario.erros}), 0)::int`,
        feitos: sql<number>`coalesce(sum(${schema.usoDiario.enviados} + ${schema.usoDiario.baixados}), 0)::int`,
      })
      .from(schema.usoDiario)
      .where(and(eq(schema.usoDiario.usuarioId, usuarioId), eq(schema.usoDiario.dia, dia)));
    if (!soma || soma.erros < ERROS_PARA_AVISAR) return;
    const u = await db.query.usuarios.findFirst({ where: eq(schema.usuarios.id, usuarioId), columns: { id: true, nome: true, email: true } });
    if (!u) return;
    await paraTodos("erros", `erros:${usuarioId}:${dia}`, (para) =>
      emailAdminErros(para, { nome: u.nome, email: u.email, dia, erros: soma.erros, feitos: soma.feitos, usuarioId }),
    );
  } catch {
    console.warn('[email] o aviso de admin "erros" não saiu.');
  }
}
