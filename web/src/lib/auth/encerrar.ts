/**
 * "Encerrar tudo" (revisão de segurança, A4): trocar ou redefinir a senha tira da conta tudo o que alguém pode ter
 * deixado ligado nela, não só as sessões do site.
 *
 * - sessões dos outros aparelhos no site e dos computadores (o andamento deles sai junto);
 * - códigos de computador ainda não usados (um pedido já liberado não vira sessão depois da troca);
 * - a chave do Atalho do iPhone;
 * - as inscrições de push ("Avisar no celular"): quem continua com sessão inscreve de novo sozinho ao abrir o app;
 * - os links pra IA (/r/…) só quando a pessoa pede (eles servem para ler as coleções, e quem compartilhou
 *   de propósito não quer perder o endereço).
 */
import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";

const { atalhos, codigosDispositivo, colecoes, dispositivoStatus, pushInscricoes, sessoes } = schema;

export type Encerrado = { sessoes: number; computadores: number; atalhos: number; avisos: number; links: number };

export async function encerrarAcessos(usuarioId: string, opcoes: { manterSessao?: string; links?: boolean } = {}): Promise<Encerrado> {
  const agora = new Date();
  return db.transaction(async (t) => {
    const daConta = [eq(sessoes.usuarioId, usuarioId), isNull(sessoes.revogadaEm)];
    if (opcoes.manterSessao) daConta.push(ne(sessoes.id, opcoes.manterSessao));
    const caiu = await t
      .update(sessoes)
      .set({ revogadaEm: agora })
      .where(and(...daConta))
      .returning({ id: sessoes.id, tipo: sessoes.tipo });
    // O andamento dos computadores (docs/CONTAS.md §9) é por sessão: sai com elas.
    for (const s of caiu) await t.delete(dispositivoStatus).where(eq(dispositivoStatus.sessaoId, s.id));

    // Pedido de computador liberado (ou aberto) para esta conta e ainda não levado: vence agora.
    await t
      .update(codigosDispositivo)
      .set({ expiraEm: sql`now()` })
      .where(and(eq(codigosDispositivo.usuarioId, usuarioId), isNull(codigosDispositivo.usadoEm)));

    const chaves = await t
      .update(atalhos)
      .set({ revogadoEm: agora })
      .where(and(eq(atalhos.usuarioId, usuarioId), isNull(atalhos.revogadoEm)))
      .returning({ id: atalhos.id });

    const avisos = await t.delete(pushInscricoes).where(eq(pushInscricoes.usuarioId, usuarioId)).returning({ id: pushInscricoes.id });

    const links = opcoes.links
      ? await t
          .update(colecoes)
          .set({ publicaToken: null, atualizadoEm: agora })
          .where(and(eq(colecoes.usuarioId, usuarioId), isNotNull(colecoes.publicaToken)))
          .returning({ id: colecoes.id })
      : [];

    return {
      sessoes: caiu.filter((s) => s.tipo === "web").length,
      computadores: caiu.filter((s) => s.tipo === "dispositivo").length,
      atalhos: chaves.length,
      avisos: avisos.length,
      links: links.length,
    };
  });
}

/** Quantos links pra IA estão ligados (a tela de senha só oferece desligar quando há algum). */
export async function linksLigados(usuarioId: string): Promise<number> {
  const [l] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(colecoes)
    .where(and(eq(colecoes.usuarioId, usuarioId), isNotNull(colecoes.publicaToken)));
  return Number(l?.n ?? 0);
}

/** "Senha trocada. …": o que saiu, numa frase curta. */
export function frase(e: Encerrado, inicio: string): string {
  const partes: string[] = [];
  if (e.sessoes || e.computadores) partes.push(e.computadores ? "os outros aparelhos e os computadores saíram da conta" : "os outros aparelhos saíram da conta");
  if (e.atalhos) partes.push("a chave do Atalho foi desligada");
  if (e.avisos) partes.push("os avisos no celular voltam quando você abrir o app logado");
  if (e.links) partes.push(e.links === 1 ? "o link pra IA foi desligado" : `os ${e.links} links pra IA foram desligados`);
  if (!partes.length) return `${inicio}.`;
  const ultima = partes.pop();
  return `${inicio}: ${partes.length ? `${partes.join(", ")} e ${ultima}` : ultima}.`;
}
