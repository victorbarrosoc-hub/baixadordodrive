/**
 * Apagar a própria conta: senha atual + a palavra APAGAR (o servidor confere as duas).
 * Revoga no Google cada Drive (melhor esforço), encerra todas as sessões e apaga tudo da pessoa.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { enviarEmail } from "@/lib/email/enviar";
import { emailContaApagada } from "@/lib/email/modelos";
import { abrir } from "@/lib/google/cripto";
import { revogar } from "@/lib/google/oauth";
import type { Falha } from "./contas";
import { dentroDoLimite, MENSAGEM_LIMITE, REGRAS, registrarTentativa } from "./limite";
import type { Depois } from "./redefinir";
import { conferirSenha } from "./senha";

const { usuarios, sessoes, contasGoogle, codigosDispositivo, redefinicoesSenha } = schema;

export const PALAVRA_APAGAR = "APAGAR";
/** Conta sem senha (só Google, se um dia existir): vale um login feito há pouco. */
const LOGIN_RECENTE_MS = 15 * 60_000;

export function contaTemSenha(senhaHash: string | null | undefined): boolean {
  return Boolean(senhaHash && senhaHash.startsWith("scrypt$"));
}

export async function apagarConta(entrada: { usuarioId: string; senha: unknown; palavra: unknown; depois: Depois }): Promise<{ ok: true } | Falha> {
  const palavra = typeof entrada.palavra === "string" ? entrada.palavra.trim() : "";
  if (palavra !== PALAVRA_APAGAR) return { ok: false, erro: "entrada", campo: "palavra", mensagem: `Digite ${PALAVRA_APAGAR} para confirmar.` };

  const chave = `apagar:${entrada.usuarioId}`;
  if (!(await dentroDoLimite(chave, REGRAS.loginEmail))) return { ok: false, erro: "devagar", mensagem: MENSAGEM_LIMITE };
  const usuario = await db.query.usuarios.findFirst({ where: eq(usuarios.id, entrada.usuarioId) });
  if (!usuario) return { ok: false, erro: "sem_sessao", mensagem: "Entre na sua conta para continuar." };

  if (contaTemSenha(usuario.senhaHash)) {
    const senha = typeof entrada.senha === "string" ? entrada.senha : "";
    if (!senha || !(await conferirSenha(senha, usuario.senhaHash))) {
      await registrarTentativa(chave);
      return { ok: false, erro: "credenciais", campo: "senha", mensagem: "A senha não confere." };
    }
  } else if (!usuario.ultimoLoginEm || Date.now() - usuario.ultimoLoginEm.getTime() > LOGIN_RECENTE_MS) {
    return { ok: false, erro: "login_recente", mensagem: "Por segurança, saia e entre de novo com o Google antes de apagar a conta." };
  }

  // 1. Tira o acesso no Google (sem esperar mais que o necessário: em paralelo, cada um com o seu limite).
  const drives = await db.select({ id: contasGoogle.id, refreshTokenEnc: contasGoogle.refreshTokenEnc }).from(contasGoogle).where(eq(contasGoogle.usuarioId, usuario.id));
  await Promise.all(
    drives.map(async (d) => {
      try {
        await revogar(abrir(d.refreshTokenEnc, `contas_google.refresh:${d.id}`));
      } catch {
        // chave trocada: a linha sai do mesmo jeito
      }
    }),
  );

  // 2. Encerra as sessões e apaga tudo (as chaves estrangeiras também apagam em cascata).
  const agora = new Date();
  await db.transaction(async (t) => {
    await t.update(sessoes).set({ revogadaEm: agora }).where(and(eq(sessoes.usuarioId, usuario.id), isNull(sessoes.revogadaEm)));
    await t.delete(contasGoogle).where(eq(contasGoogle.usuarioId, usuario.id));
    await t.delete(codigosDispositivo).where(eq(codigosDispositivo.usuarioId, usuario.id));
    await t.delete(redefinicoesSenha).where(eq(redefinicoesSenha.usuarioId, usuario.id));
    await t.delete(sessoes).where(eq(sessoes.usuarioId, usuario.id));
    await t.delete(usuarios).where(eq(usuarios.id, usuario.id));
  });

  // 3. Confirmação por e-mail, depois da resposta.
  const { email, nome } = usuario;
  entrada.depois(() => enviarEmail(emailContaApagada(email, nome)));
  return { ok: true };
}
