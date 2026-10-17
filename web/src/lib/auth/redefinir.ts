/**
 * "Esqueci a senha": pedir (resposta sempre igual) → e-mail com link de 1 hora e uso único
 * → senha nova, tudo o que estava ligado na conta encerrado (lib/auth/encerrar.ts) e uma sessão nova.
 * O mesmo link cria a primeira senha de uma conta criada pelo Google (pedirPrimeiraSenha, revisão A5).
 * Link usado ou vencido é apagado de verdade (a política de privacidade promete guardar por uma hora).
 */
import { and, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { emSegundoPlano, type Depois } from "@/lib/depois";
import { avisarSenhaMudou } from "@/lib/email/avisos";
import { emailDisponivel, enviarEmail } from "@/lib/email/enviar";
import { emailEsqueciSenha, emailPrimeiraSenha } from "@/lib/email/modelos";
import { emailValido, normalizarEmail, type Entrou, type Falha } from "./contas";
import { encerrarAcessos, type Encerrado } from "./encerrar";
import { dentroDoLimite, MENSAGEM_LIMITE, REGRAS, registrarTentativa } from "./limite";
import { hashSenha, SENHA_MAXIMA, SENHA_MINIMA } from "./senha";
import { criarSessao } from "./sessao";
import { hashToken, novoId, novoToken } from "./tokens";

const { redefinicoesSenha, usuarios } = schema;

export const VALIDADE_LINK_MS = 60 * 60_000;
export const MENSAGEM_PEDIDO = "Se existir uma conta com este e-mail, mandamos um link para criar uma senha nova. Confira a caixa de entrada e o spam.";
export const MENSAGEM_INDISPONIVEL = "O envio de e-mail ainda não está ligado. Fale com o Victor para trocar a senha.";

/** Apaga os links já usados ou vencidos (de todo mundo). Barato: a tabela só tem os links da última hora. */
export async function apagarLinksVencidos(agora = new Date()): Promise<number> {
  const r = await db
    .delete(redefinicoesSenha)
    .where(or(isNotNull(redefinicoesSenha.usadoEm), lt(redefinicoesSenha.expiraEm, agora)))
    .returning({ id: redefinicoesSenha.id });
  return r.length;
}

/** Agenda trabalho depois da resposta (Next: `after`); nos testes roda na hora. */
export type { Depois };
export const naHora: Depois = (t) => void t();

/**
 * Pede o link. A resposta é a mesma com ou sem conta; o e-mail sai depois da resposta
 * (`depois`), para o tempo de resposta também não contar se a conta existe.
 */
export async function pedirRedefinicao(entrada: { email: unknown; ip: string; depois: Depois }): Promise<{ ok: true; mensagem: string } | Falha> {
  if (!emailDisponivel()) return { ok: false, erro: "indisponivel", mensagem: MENSAGEM_INDISPONIVEL };
  const email = normalizarEmail(entrada.email);
  if (!emailValido(email)) return { ok: false, erro: "entrada", campo: "email", mensagem: "Confira o e-mail." };
  const chaveEmail = `esqueci:${email}`;
  const chaveIp = `esqueci-ip:${entrada.ip}`;
  const [porEmail, porIp] = await Promise.all([dentroDoLimite(chaveEmail, REGRAS.esqueciEmail), dentroDoLimite(chaveIp, REGRAS.esqueciIp)]);
  if (!porEmail || !porIp) return { ok: false, erro: "devagar", mensagem: MENSAGEM_LIMITE };
  await registrarTentativa(chaveEmail, chaveIp);

  entrada.depois(async () => {
    await apagarLinksVencidos();
    const usuario = await db.query.usuarios.findFirst({ where: eq(usuarios.email, email), columns: { id: true, nome: true, email: true } });
    if (!usuario) return;
    const token = novoToken();
    await db.insert(redefinicoesSenha).values({ id: novoId(), usuarioId: usuario.id, tokenHash: hashToken(token), expiraEm: new Date(Date.now() + VALIDADE_LINK_MS) });
    await enviarEmail(emailEsqueciSenha(usuario.email, usuario.nome, token));
  });
  return { ok: true, mensagem: MENSAGEM_PEDIDO };
}

/**
 * Primeira senha de quem entrou pelo Google (revisão A5): a sessão aberta não basta (pode ser roubada), então o link
 * vai para o e-mail da conta, que é o e-mail que o Google confirmou ao criar a conta. Mesmo link e mesmo limite do
 * "Esqueci a senha".
 */
export async function pedirPrimeiraSenha(entrada: { usuarioId: string; ip: string; depois: Depois }): Promise<{ ok: true; mensagem: string } | Falha> {
  if (!emailDisponivel()) return { ok: false, erro: "indisponivel", mensagem: MENSAGEM_INDISPONIVEL };
  const usuario = await db.query.usuarios.findFirst({ where: eq(usuarios.id, entrada.usuarioId), columns: { id: true, nome: true, email: true, senhaHash: true } });
  if (!usuario) return { ok: false, erro: "sem_sessao", mensagem: "Entre na sua conta para continuar." };
  if (usuario.senhaHash.startsWith("scrypt$")) return { ok: false, erro: "tem_senha", mensagem: "Esta conta já tem senha. Troque com a senha atual." };
  const chaveEmail = `esqueci:${usuario.email}`;
  const chaveIp = `esqueci-ip:${entrada.ip}`;
  const [porEmail, porIp] = await Promise.all([dentroDoLimite(chaveEmail, REGRAS.esqueciEmail), dentroDoLimite(chaveIp, REGRAS.esqueciIp)]);
  if (!porEmail || !porIp) return { ok: false, erro: "devagar", mensagem: MENSAGEM_LIMITE };
  await registrarTentativa(chaveEmail, chaveIp);

  entrada.depois(async () => {
    await apagarLinksVencidos();
    const token = novoToken();
    await db.insert(redefinicoesSenha).values({ id: novoId(), usuarioId: usuario.id, tokenHash: hashToken(token), expiraEm: new Date(Date.now() + VALIDADE_LINK_MS) });
    await enviarEmail(emailPrimeiraSenha(usuario.email, usuario.nome, token));
  });
  return { ok: true, mensagem: `Mandamos um link para ${usuario.email}. Ele vale por uma hora.` };
}

const FORMATO = /^[A-Za-z0-9_-]{43}$/;

/** O link ainda vale? (para a tela mostrar o formulário ou "link vencido") */
export async function linkValido(token: unknown): Promise<boolean> {
  if (typeof token !== "string" || !FORMATO.test(token)) return false;
  const r = await db.query.redefinicoesSenha.findFirst({
    where: and(eq(redefinicoesSenha.tokenHash, hashToken(token)), isNull(redefinicoesSenha.usadoEm), gt(redefinicoesSenha.expiraEm, new Date())),
    columns: { id: true },
  });
  if (!r) await apagarLinksVencidos();
  return Boolean(r);
}

export const MENSAGEM_LINK_VENCIDO = "Este link venceu ou já foi usado. Peça outro em Esqueci a senha.";

/**
 * Usa o link: grava a senha, encerra tudo (sessões do site e dos computadores, chave do Atalho, avisos no celular;
 * links pra IA só com `links`) e abre uma sessão nova.
 */
export async function redefinirSenha(entrada: {
  token: unknown;
  senha: unknown;
  links?: boolean;
  /** Para o e-mail "a senha mudou" (padrão: em segundo plano). */
  depois?: Depois;
}): Promise<(Entrou & { encerrado: Encerrado }) | Falha> {
  const senha = typeof entrada.senha === "string" ? entrada.senha : "";
  if (senha.length < SENHA_MINIMA) return { ok: false, erro: "entrada", campo: "senha", mensagem: `A senha precisa de pelo menos ${SENHA_MINIMA} caracteres.` };
  if (senha.length > SENHA_MAXIMA) return { ok: false, erro: "entrada", campo: "senha", mensagem: "Senha longa demais." };
  if (typeof entrada.token !== "string" || !FORMATO.test(entrada.token)) return { ok: false, erro: "link", mensagem: MENSAGEM_LINK_VENCIDO };

  const agora = new Date();
  const usado = await db
    .update(redefinicoesSenha)
    .set({ usadoEm: agora })
    .where(and(eq(redefinicoesSenha.tokenHash, hashToken(entrada.token)), isNull(redefinicoesSenha.usadoEm), gt(redefinicoesSenha.expiraEm, agora)))
    .returning({ usuarioId: redefinicoesSenha.usuarioId });
  if (usado.length === 0) return { ok: false, erro: "link", mensagem: MENSAGEM_LINK_VENCIDO };
  const { usuarioId } = usado[0];

  const antes = await db.query.usuarios.findFirst({ where: eq(usuarios.id, usuarioId), columns: { senhaHash: true } });
  const senhaHash = await hashSenha(senha);
  await db.update(usuarios).set({ senhaHash, atualizadoEm: agora, ultimoLoginEm: agora }).where(eq(usuarios.id, usuarioId));
  const encerrado = await encerrarAcessos(usuarioId, { links: entrada.links === true });
  // Este link e os outros pendentes deste usuário deixam de valer e saem do banco (e os vencidos de todo mundo).
  await db.delete(redefinicoesSenha).where(eq(redefinicoesSenha.usuarioId, usuarioId));
  await apagarLinksVencidos(agora);

  const usuario = await db.query.usuarios.findFirst({ where: eq(usuarios.id, usuarioId), columns: { id: true, email: true, nome: true } });
  if (!usuario) return { ok: false, erro: "link", mensagem: MENSAGEM_LINK_VENCIDO };
  const sessao = await criarSessao(usuario.id, "web");
  const como = antes?.senhaHash.startsWith("scrypt$") ? "redefinida" : "criada";
  (entrada.depois ?? emSegundoPlano)(() => avisarSenhaMudou(usuarioId, como, agora));
  return { ok: true, usuario, token: sessao.token, expiraEm: sessao.expiraEm, encerrado };
}
