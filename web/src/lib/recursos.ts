import "server-only";
/**
 * Quem pode usar cada recurso (docs/REFERENCIAS.md §1).
 * Beta aberto (SOBEDESCE_BETA_ABERTO, ligado por padrão): toda conta logada usa tudo. Fechado: vale o plano
 * da conta (Referências = plano Produtora) ou ser admin. O plano já fica guardado para quando o beta fechar.
 */
import { eq } from "drizzle-orm";
import { ehAdmin } from "@/lib/admin";
import { db, schema } from "@/lib/db";
import type { Plano } from "@/lib/db/schema";

export type Recurso = "referencias";

export const PLANOS: Plano[] = ["gratis", "pro", "produtora"];
export const NOME_PLANO: Record<Plano, string> = { gratis: "Grátis", pro: "Pro", produtora: "Produtora" };

/** Plano mínimo de cada recurso quando o beta fechar. */
const PLANO_DO_RECURSO: Record<Recurso, Plano[]> = { referencias: ["produtora"] };

export function ehPlano(v: unknown): v is Plano {
  return typeof v === "string" && (PLANOS as string[]).includes(v);
}

/** Beta aberto? Só "0", "false", "off", "nao"/"não" fecham. */
export function betaAberto(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.SOBEDESCE_BETA_ABERTO ?? "1").trim().toLowerCase();
  return !["0", "false", "off", "nao", "não", "fechado"].includes(v);
}

export async function planoDe(usuarioId: string): Promise<Plano> {
  const [l] = await db.select({ plano: schema.usuarios.plano }).from(schema.usuarios).where(eq(schema.usuarios.id, usuarioId)).limit(1);
  return l?.plano ?? "gratis";
}

export async function podeUsar(usuario: { id: string; email: string }, recurso: Recurso): Promise<boolean> {
  if (betaAberto()) return true;
  if (PLANO_DO_RECURSO[recurso].includes(await planoDe(usuario.id))) return true;
  return ehAdmin(usuario);
}

/** Todos os recursos da conta, para /api/eu. */
export async function recursosDe(usuario: { id: string; email: string }): Promise<Record<Recurso, boolean>> {
  return { referencias: await podeUsar(usuario, "referencias") };
}

export async function trocarPlano(usuarioId: string, plano: Plano): Promise<boolean> {
  const r = await db.update(schema.usuarios).set({ plano, atualizadoEm: new Date() }).where(eq(schema.usuarios.id, usuarioId)).returning({ id: schema.usuarios.id });
  return r.length > 0;
}
