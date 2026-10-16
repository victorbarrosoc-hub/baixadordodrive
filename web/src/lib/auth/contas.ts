/**
 * Contas da SOBEDESCE: criar, entrar com senha, trocar senha e nome.
 * Funções puras de servidor (sem cookies): as Server Actions chamam e cuidam do cookie.
 * Erros de login são genéricos: nunca dizem se o e-mail existe.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { dentroDoLimite, esquecerTentativas, MENSAGEM_LIMITE, REGRAS, registrarTentativa } from "./limite";
import { conferirSenha, hashDeEnfeite, hashSenha, SENHA_MAXIMA, SENHA_MINIMA } from "./senha";
import { criarSessao, revogarOutras, type UsuarioPublico } from "./sessao";
import { novoId } from "./tokens";

const { usuarios } = schema;

export type Falha = { ok: false; erro: string; mensagem: string; campo?: "nome" | "email" | "senha" | "senhaAtual" | "senhaNova" };
export type Entrou = { ok: true; usuario: UsuarioPublico; token: string; expiraEm: Date };

export const MENSAGEM_LOGIN = "E-mail ou senha não conferem.";

export function normalizarEmail(valor: unknown): string {
  return typeof valor === "string" ? valor.trim().toLowerCase() : "";
}

export function emailValido(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function nomeLimpo(valor: unknown): string {
  return typeof valor === "string" ? valor.replace(/\s+/g, " ").trim().slice(0, 80) : "";
}

export async function criarConta(entrada: { nome: unknown; email: unknown; senha: unknown; ip: string }): Promise<Entrou | Falha> {
  const nome = nomeLimpo(entrada.nome);
  const email = normalizarEmail(entrada.email);
  const senha = typeof entrada.senha === "string" ? entrada.senha : "";
  if (!nome) return { ok: false, erro: "entrada", campo: "nome", mensagem: "Diga como podemos te chamar." };
  if (!emailValido(email)) return { ok: false, erro: "entrada", campo: "email", mensagem: "Confira o e-mail." };
  if (senha.length < SENHA_MINIMA) return { ok: false, erro: "entrada", campo: "senha", mensagem: `A senha precisa de pelo menos ${SENHA_MINIMA} caracteres.` };
  if (senha.length > SENHA_MAXIMA) return { ok: false, erro: "entrada", campo: "senha", mensagem: "Senha longa demais." };

  const chave = `criar:${entrada.ip}`;
  if (!(await dentroDoLimite(chave, REGRAS.criarConta))) return { ok: false, erro: "devagar", mensagem: MENSAGEM_LIMITE };
  await registrarTentativa(chave);

  const senhaHash = await hashSenha(senha);
  const id = novoId();
  const criado = await db
    .insert(usuarios)
    .values({ id, email, nome, senhaHash, ultimoLoginEm: new Date() })
    .onConflictDoNothing({ target: usuarios.email })
    .returning({ id: usuarios.id });
  if (criado.length === 0) {
    return { ok: false, erro: "email_em_uso", campo: "email", mensagem: "Este e-mail já tem uma conta. Entre com ele." };
  }
  const sessao = await criarSessao(id, "web");
  return { ok: true, usuario: { id, email, nome }, token: sessao.token, expiraEm: sessao.expiraEm };
}

export async function entrarComSenha(entrada: { email: unknown; senha: unknown; ip: string }): Promise<Entrou | Falha> {
  const email = normalizarEmail(entrada.email);
  const senha = typeof entrada.senha === "string" ? entrada.senha : "";
  if (!email || !senha) return { ok: false, erro: "entrada", mensagem: "Preencha e-mail e senha." };

  const chaveEmail = `login:${email.slice(0, 254)}:${entrada.ip}`;
  const chaveIp = `login-ip:${entrada.ip}`;
  const [porEmail, porIp] = await Promise.all([dentroDoLimite(chaveEmail, REGRAS.loginEmail), dentroDoLimite(chaveIp, REGRAS.loginIp)]);
  if (!porEmail || !porIp) return { ok: false, erro: "devagar", mensagem: MENSAGEM_LIMITE };

  const usuario = await db.query.usuarios.findFirst({ where: eq(usuarios.email, email) });
  // Sem conta, confere contra um hash qualquer: a resposta demora o mesmo.
  const certo = senha.length <= SENHA_MAXIMA && (await conferirSenha(senha, usuario?.senhaHash ?? (await hashDeEnfeite())));
  if (!usuario || !certo) {
    await registrarTentativa(chaveEmail, chaveIp);
    return { ok: false, erro: "credenciais", mensagem: MENSAGEM_LOGIN };
  }
  await esquecerTentativas(chaveEmail);
  await db.update(usuarios).set({ ultimoLoginEm: new Date() }).where(eq(usuarios.id, usuario.id));
  const sessao = await criarSessao(usuario.id, "web");
  return { ok: true, usuario: { id: usuario.id, email: usuario.email, nome: usuario.nome }, token: sessao.token, expiraEm: sessao.expiraEm };
}

/** Troca a senha e encerra as outras sessões (site e computadores). A sessão atual continua. */
export async function trocarSenha(entrada: {
  usuarioId: string;
  sessaoId: string;
  senhaAtual: unknown;
  senhaNova: unknown;
  ip: string;
}): Promise<{ ok: true } | Falha> {
  const atual = typeof entrada.senhaAtual === "string" ? entrada.senhaAtual : "";
  const nova = typeof entrada.senhaNova === "string" ? entrada.senhaNova : "";
  if (nova.length < SENHA_MINIMA) return { ok: false, erro: "entrada", campo: "senhaNova", mensagem: `A senha nova precisa de pelo menos ${SENHA_MINIMA} caracteres.` };
  if (nova.length > SENHA_MAXIMA) return { ok: false, erro: "entrada", campo: "senhaNova", mensagem: "Senha longa demais." };

  const chave = `senha:${entrada.usuarioId}`;
  if (!(await dentroDoLimite(chave, REGRAS.loginEmail))) return { ok: false, erro: "devagar", mensagem: MENSAGEM_LIMITE };
  const usuario = await db.query.usuarios.findFirst({ where: eq(usuarios.id, entrada.usuarioId) });
  if (!usuario || !(await conferirSenha(atual, usuario.senhaHash))) {
    await registrarTentativa(chave);
    return { ok: false, erro: "credenciais", campo: "senhaAtual", mensagem: "A senha atual não confere." };
  }
  await db.update(usuarios).set({ senhaHash: await hashSenha(nova), atualizadoEm: new Date() }).where(eq(usuarios.id, usuario.id));
  await revogarOutras(usuario.id, entrada.sessaoId);
  await esquecerTentativas(chave);
  return { ok: true };
}

export async function trocarNome(usuarioId: string, valor: unknown): Promise<{ ok: true; nome: string } | Falha> {
  const nome = nomeLimpo(valor);
  if (!nome) return { ok: false, erro: "entrada", campo: "nome", mensagem: "O nome não pode ficar vazio." };
  await db.update(usuarios).set({ nome, atualizadoEm: new Date() }).where(eq(usuarios.id, usuarioId));
  return { ok: true, nome };
}
