/**
 * Macs com o Atualizar travado. Até o build 299, o app do Mac não apagava a sobra de uma troca que não aconteceu
 * (/Applications/.SOBEDESCE-atualizacao.app: o fs do Electron vê o app.asar como pasta e para em ENOTEMPTY), e toda
 * atualização seguinte falhava. O build 300 corrigiu, mas quem está travado só sai baixando o instalador uma vez.
 * Aqui: quem tem Mac antes da correção (aviso em /conta) e o e-mail para essas pessoas, mandado pelo admin uma vez.
 */
import { and, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { enviarEmail } from "@/lib/email/enviar";
import { emailAtualizarMac } from "@/lib/email/modelos";

/** Primeiro build com a correção (PR #85). */
export const CORRECAO_ATUALIZAR_MAC = 300;

const CHAVE = (usuarioId: string) => `mac-travado:${usuarioId}`;

const { sessoes, usuarios, avisosAdmin } = schema;

/** Mac ativo da conta num build antes da correção. Sem build gravado = app antigo. 0 = desenvolvimento, fica fora. */
function antesDaCorrecao() {
  return and(
    eq(sessoes.tipo, "dispositivo"),
    eq(sessoes.plataforma, "mac"),
    isNull(sessoes.revogadaEm),
    gt(sessoes.expiraEm, new Date()),
    or(isNull(sessoes.appBuild), and(gt(sessoes.appBuild, 0), lt(sessoes.appBuild, CORRECAO_ATUALIZAR_MAC))),
  );
}

/** Nomes dos Macs da conta que precisam do instalador. */
export async function macsParaAtualizar(usuarioId: string): Promise<string[]> {
  const linhas = await db
    .select({ nome: sessoes.nome })
    .from(sessoes)
    .where(and(eq(sessoes.usuarioId, usuarioId), antesDaCorrecao()));
  return linhas.map((l) => l.nome || "Mac");
}

export type ContaComMac = { id: string; nome: string; email: string; macs: string[]; avisada: boolean };

/** Para o admin: cada conta com Mac antes da correção e se o e-mail já saiu para ela. */
export async function contasComMacTravado(): Promise<ContaComMac[]> {
  const linhas = await db
    .select({ id: usuarios.id, nome: usuarios.nome, email: usuarios.email, mac: sessoes.nome })
    .from(sessoes)
    .innerJoin(usuarios, eq(usuarios.id, sessoes.usuarioId))
    .where(antesDaCorrecao());
  const porConta = new Map<string, ContaComMac>();
  for (const l of linhas) {
    const c = porConta.get(l.id) ?? { id: l.id, nome: l.nome, email: l.email, macs: [], avisada: false };
    c.macs.push(l.mac || "Mac");
    porConta.set(l.id, c);
  }
  const contas = [...porConta.values()];
  if (contas.length) {
    const feitas = await db
      .select({ chave: avisosAdmin.chave })
      .from(avisosAdmin)
      .where(inArray(avisosAdmin.chave, contas.map((c) => CHAVE(c.id))));
    const avisadas = new Set(feitas.map((f) => f.chave));
    for (const c of contas) c.avisada = avisadas.has(CHAVE(c.id));
  }
  return contas.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

/**
 * Manda o e-mail para quem ainda não recebeu. Cada conta tem a chave `mac-travado:<id>` em avisos_admin: dois cliques
 * ao mesmo tempo não mandam duas vezes. Se o envio falha, a chave sai e a conta entra no próximo clique.
 */
export async function avisarMacsTravados(): Promise<{ enviados: number; falharam: number }> {
  let enviados = 0;
  let falharam = 0;
  for (const c of await contasComMacTravado()) {
    if (c.avisada) continue;
    const reservou = await db.insert(avisosAdmin).values({ chave: CHAVE(c.id) }).onConflictDoNothing().returning({ chave: avisosAdmin.chave });
    if (!reservou.length) continue;
    let ok = false;
    try {
      ok = (await enviarEmail(emailAtualizarMac(c.email, c.nome, c.macs))).ok;
    } catch {
      ok = false;
    }
    if (ok) enviados++;
    else {
      falharam++;
      await db.delete(avisosAdmin).where(eq(avisosAdmin.chave, CHAVE(c.id)));
    }
  }
  return { enviados, falharam };
}
