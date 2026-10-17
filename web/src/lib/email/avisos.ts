/**
 * Avisos de segurança por e-mail: entrada nova, senha mudou, Google de entrar trocado ou removido, computador
 * liberado e muitas senhas erradas. Regras de todos:
 * - nunca lançam: um erro (banco, Resend, chave) vira uma linha de log e o fluxo que pediu o aviso segue igual;
 * - sem RESEND_API_KEY em produção não mandam nada (enviar.ts); em desenvolvimento vão para o console;
 * - levam só o que a pessoa precisa para reconhecer o que aconteceu: nada de IP, token, link com segredo ou senha.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Plataforma } from "@/lib/db/schema";
import { dentroDoLimite, REGRAS, registrarTentativa } from "@/lib/auth/limite";
import { enviarEmail, type ResultadoEnvio } from "./enviar";
import {
  emailComputadorConectado,
  emailEntradaNova,
  emailGoogleDeEntrar,
  emailMuitasTentativas,
  emailSenhaMudou,
  type ComoMudouSenha,
} from "./modelos";
import type { Email } from "./enviar";

type Dono = { id: string; email: string; nome: string };

async function seguro(nome: string, fn: () => Promise<ResultadoEnvio | null>): Promise<ResultadoEnvio | null> {
  try {
    return await fn();
  } catch {
    // Só o nome do aviso: a mensagem do erro pode trazer o e-mail da pessoa.
    console.warn(`[email] o aviso "${nome}" não saiu.`);
    return null;
  }
}

async function dono(usuarioId: string): Promise<Dono | null> {
  const u = await db.query.usuarios.findFirst({ where: eq(schema.usuarios.id, usuarioId), columns: { id: true, email: true, nome: true } });
  return u ?? null;
}

/** Busca o dono e manda o e-mail que `montar` fizer. Conta que sumiu: nada. */
function avisarDono(nome: string, usuarioId: string, montar: (u: Dono) => Email): Promise<ResultadoEnvio | null> {
  return seguro(nome, async () => {
    const u = await dono(usuarioId);
    return u ? enviarEmail(montar(u)) : null;
  });
}

/** Um computador foi liberado para a conta. `onde`: cidade e país aproximados do pedido, se a Vercel disse. */
export function avisarComputadorConectado(
  usuarioId: string,
  c: { nome: string; plataforma: Plataforma | null; quando?: Date; onde?: string | null },
): Promise<ResultadoEnvio | null> {
  return avisarDono("computador conectado", usuarioId, (u) =>
    emailComputadorConectado(u.email, u.nome, { computador: c.nome, plataforma: c.plataforma, quando: c.quando ?? new Date(), onde: c.onde ?? null }),
  );
}

/** A conta entrou num aparelho ou navegador que ainda não tinha usado (lib/auth/aparelho.ts decide). */
export function avisarEntradaNova(
  usuarioId: string,
  e: { quando: Date; navegador: string | null; onde: string | null; via: "senha" | "google" },
): Promise<ResultadoEnvio | null> {
  return avisarDono("entrada nova", usuarioId, (u) => emailEntradaNova(u.email, u.nome, e));
}

export function avisarSenhaMudou(usuarioId: string, como: ComoMudouSenha, quando = new Date()): Promise<ResultadoEnvio | null> {
  return avisarDono("senha mudou", usuarioId, (u) => emailSenhaMudou(u.email, u.nome, { quando, como }));
}

/** `novo`: e-mail do Google que passou a entrar (null = nenhum). `anterior`: o que deixou de entrar. */
export function avisarGoogleDeEntrar(usuarioId: string, g: { novo: string | null; anterior: string | null; quando?: Date }): Promise<ResultadoEnvio | null> {
  return avisarDono("google de entrar", usuarioId, (u) => emailGoogleDeEntrar(u.email, u.nome, { quando: g.quando ?? new Date(), novo: g.novo, anterior: g.anterior }));
}

/**
 * O limite de senhas erradas da conta (REGRAS.loginConta) foi atingido. Recebe o e-mail digitado: sem conta, nada
 * (e como roda depois da resposta, o tempo não conta se a conta existe). No máximo um por conta a cada 24 horas.
 */
export function avisarMuitasTentativas(email: string, quando = new Date()): Promise<ResultadoEnvio | null> {
  return seguro("muitas tentativas", async () => {
    const u = await db.query.usuarios.findFirst({ where: eq(schema.usuarios.email, email), columns: { id: true, email: true, nome: true } });
    if (!u) return null;
    const chave = `aviso-tentativas:${u.id}`;
    if (!(await dentroDoLimite(chave, REGRAS.avisoTentativas))) return null;
    await registrarTentativa(chave);
    return enviarEmail(emailMuitasTentativas(u.email, u.nome, { quando, janelaMin: Math.round(REGRAS.loginConta.janelaMs / 60_000) }));
  });
}
