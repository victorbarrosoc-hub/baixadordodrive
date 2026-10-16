/** Avisos de segurança por e-mail. */
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Plataforma } from "@/lib/db/schema";
import { enviarEmail, type ResultadoEnvio } from "./enviar";
import { emailComputadorConectado } from "./modelos";

/** Um computador foi liberado para a conta. */
export async function avisarComputadorConectado(usuarioId: string, c: { nome: string; plataforma: Plataforma | null; quando?: Date }): Promise<ResultadoEnvio | null> {
  const u = await db.query.usuarios.findFirst({ where: eq(schema.usuarios.id, usuarioId), columns: { email: true, nome: true } });
  if (!u) return null;
  return enviarEmail(emailComputadorConectado(u.email, u.nome, { computador: c.nome, plataforma: c.plataforma, quando: c.quando ?? new Date() }));
}
