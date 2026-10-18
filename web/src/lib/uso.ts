/**
 * Uso por dia dos computadores (docs/CONTAS.md §10), para o admin: o app manda os totais dos últimos dias
 * (src/engine/uso.js) e aqui fica o maior valor recebido de cada dia, então mandar de novo não soma duas vezes.
 * Só números. Sem "server-only": os testes usam direto.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";

export const MAX_DIAS_USO = 14;
const bytes = z.number().int().nonnegative().max(1e16);
const contagem = z.number().int().nonnegative().max(1e8);

const diaUso = z.object({
  dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  enviadosBytes: bytes,
  baixadosBytes: bytes,
  enviados: contagem,
  baixados: contagem,
  erros: contagem,
  maiorArquivo: bytes,
  msAtivo: z.number().int().nonnegative().max(86_400_000 * 2),
});

export const usoSchema = z.object({ dias: z.array(diaUso).max(MAX_DIAS_USO) });
export type UsoRecebido = z.infer<typeof usoSchema>;
type Numero = Exclude<keyof z.infer<typeof diaUso>, "dia">;

/** Dia válido e perto de hoje (o relógio do computador pode estar um dia adiantado pelo fuso). */
function diaAceito(dia: string, agora: Date): boolean {
  const t = Date.parse(`${dia}T12:00:00Z`);
  if (!Number.isFinite(t)) return false;
  return t <= agora.getTime() + 2 * 86_400_000 && t >= agora.getTime() - (MAX_DIAS_USO + 2) * 86_400_000;
}

/** Grava os dias recebidos. Devolve os dias gravados (para conferir os erros do dia). */
export async function gravarUso(sessaoId: string, usuarioId: string, uso: UsoRecebido, agora = new Date()): Promise<string[]> {
  const u = schema.usoDiario;
  const dias = uso.dias.filter((d) => diaAceito(d.dia, agora));
  if (!dias.length) return [];
  // O maior entre o que já estava e o que chegou (colunas em snake_case no banco).
  const maior = (c: Numero) => {
    const col = c.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
    return sql.raw(`greatest("uso_diario"."${col}", excluded."${col}")`);
  };
  await db
    .insert(u)
    .values(dias.map((d) => ({ sessaoId, usuarioId, ...d, atualizadoEm: agora })))
    .onConflictDoUpdate({
      target: [u.sessaoId, u.dia],
      set: {
        enviadosBytes: maior("enviadosBytes"),
        baixadosBytes: maior("baixadosBytes"),
        enviados: maior("enviados"),
        baixados: maior("baixados"),
        erros: maior("erros"),
        maiorArquivo: maior("maiorArquivo"),
        msAtivo: maior("msAtivo"),
        atualizadoEm: agora,
      },
    });
  return dias.map((d) => d.dia);
}
