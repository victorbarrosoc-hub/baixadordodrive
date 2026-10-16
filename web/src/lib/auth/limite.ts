/**
 * Limite de tentativas (tabela `tentativas`): conta linhas da chave numa janela de tempo.
 * Chaves: "login:<email>:<ip>", "login-ip:<ip>", "criar:<ip>", "disp-iniciar:<ip>", "disp-codigo:<ip>".
 * Limpeza preguiçosa: de vez em quando apaga o que tem mais de um dia.
 */
import { and, count, eq, gte, lt } from "drizzle-orm";
import { db, schema } from "@/lib/db";

const { tentativas } = schema;

export type Regra = { max: number; janelaMs: number };

export const REGRAS = {
  loginEmail: { max: 8, janelaMs: 15 * 60_000 },
  loginIp: { max: 40, janelaMs: 15 * 60_000 },
  criarConta: { max: 10, janelaMs: 60 * 60_000 },
  dispositivoIniciar: { max: 30, janelaMs: 60 * 60_000 },
  dispositivoCodigo: { max: 20, janelaMs: 15 * 60_000 },
} satisfies Record<string, Regra>;

/** true = ainda pode tentar. */
export async function dentroDoLimite(chave: string, regra: Regra): Promise<boolean> {
  const desde = new Date(Date.now() - regra.janelaMs);
  const [linha] = await db
    .select({ n: count() })
    .from(tentativas)
    .where(and(eq(tentativas.chave, chave), gte(tentativas.quando, desde)));
  return (linha?.n ?? 0) < regra.max;
}

export async function registrarTentativa(...chaves: string[]): Promise<void> {
  if (chaves.length === 0) return;
  await db.insert(tentativas).values(chaves.map((chave) => ({ chave })));
  if (Math.random() < 0.02) {
    await db.delete(tentativas).where(lt(tentativas.quando, new Date(Date.now() - 24 * 60 * 60_000)));
  }
}

export async function esquecerTentativas(chave: string): Promise<void> {
  await db.delete(tentativas).where(eq(tentativas.chave, chave));
}

export const MENSAGEM_LIMITE = "Muitas tentativas seguidas. Espere alguns minutos e tente de novo.";
