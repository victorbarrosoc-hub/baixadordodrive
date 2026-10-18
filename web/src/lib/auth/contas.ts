/**
 * Contas da SOBEDESCE: criar, entrar com senha, trocar senha e nome.
 * Funções puras de servidor (sem cookies): as Server Actions chamam e cuidam do cookie.
 * Erros de login são genéricos: nunca dizem se o e-mail existe.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { emSegundoPlano, type Depois } from "@/lib/depois";
import { avisarMuitasTentativas, avisarSenhaMudou } from "@/lib/email/avisos";
import { avisarAdminContaNova } from "@/lib/email/admin";
import { dentroDoLimite, esquecerTentativas, MENSAGEM_LIMITE, REGRAS, registrarTentativa } from "./limite";
import { conferirSenha, hashDeEnfeite, hashSenha, SENHA_MAXIMA, SENHA_MINIMA } from "./senha";
import { encerrarAcessos, type Encerrado } from "./encerrar";
import { criarSessao, type UsuarioPublico } from "./sessao";
import { novoId } from "./tokens";

const { usuarios } = schema;

export type Falha = { ok: false; erro: string; mensagem: string; campo?: "nome" | "email" | "senha" | "senhaAtual" | "senhaNova" | "palavra" };
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

export async function criarConta(entrada: { nome: unknown; email: unknown; senha: unknown; ip: string; depois?: Depois }): Promise<Entrou | Falha> {
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
  (entrada.depois ?? emSegundoPlano)(() => avisarAdminContaNova({ id, nome, email }, false));
  return { ok: true, usuario: { id, email, nome }, token: sessao.token, expiraEm: sessao.expiraEm };
}

/**
 * Entrar com e-mail e senha. `depois` (padrão: em segundo plano) recebe o aviso de muitas senhas erradas: ele roda
 * depois da resposta, então nem o tempo nem a resposta contam se a conta existe.
 */
export async function entrarComSenha(entrada: { email: unknown; senha: unknown; ip: string; depois?: Depois }): Promise<Entrou | Falha> {
  const email = normalizarEmail(entrada.email);
  const senha = typeof entrada.senha === "string" ? entrada.senha : "";
  if (!email || !senha) return { ok: false, erro: "entrada", mensagem: "Preencha e-mail e senha." };

  const chaveEmail = `login:${email.slice(0, 254)}:${entrada.ip}`;
  const chaveConta = `login-conta:${email.slice(0, 254)}`;
  const chaveIp = `login-ip:${entrada.ip}`;
  const [porEmail, porConta, porIp] = await Promise.all([
    dentroDoLimite(chaveEmail, REGRAS.loginEmail),
    dentroDoLimite(chaveConta, REGRAS.loginConta),
    dentroDoLimite(chaveIp, REGRAS.loginIp),
  ]);
  const depois = entrada.depois ?? emSegundoPlano;
  // A conta bateu no limite de senhas erradas (de qualquer rede): o dono fica sabendo (um e-mail por dia, no máximo).
  const avisarSeNoLimite = () =>
    depois(async () => {
      if (!(await dentroDoLimite(chaveConta, REGRAS.loginConta))) await avisarMuitasTentativas(email.slice(0, 254));
    });
  if (!porConta) avisarSeNoLimite();
  if (!porEmail || !porConta || !porIp) return { ok: false, erro: "devagar", mensagem: MENSAGEM_LIMITE };

  const usuario = await db.query.usuarios.findFirst({ where: eq(usuarios.email, email) });
  // Sem conta, confere contra um hash qualquer: a resposta demora o mesmo.
  const certo = senha.length <= SENHA_MAXIMA && (await conferirSenha(senha, usuario?.senhaHash ?? (await hashDeEnfeite())));
  if (!usuario || !certo) {
    await registrarTentativa(chaveEmail, chaveConta, chaveIp);
    avisarSeNoLimite();
    return { ok: false, erro: "credenciais", mensagem: MENSAGEM_LOGIN };
  }
  // O contador da conta não zera com um acerto: quem está testando senhas de outros IPs continua contado.
  await esquecerTentativas(chaveEmail);
  await db.update(usuarios).set({ ultimoLoginEm: new Date() }).where(eq(usuarios.id, usuario.id));
  const sessao = await criarSessao(usuario.id, "web");
  return { ok: true, usuario: { id: usuario.id, email: usuario.email, nome: usuario.nome }, token: sessao.token, expiraEm: sessao.expiraEm };
}

export const MENSAGEM_SEM_SENHA = "Esta conta ainda não tem senha. Para criar a primeira, use o link que mandamos por e-mail.";

/**
 * Troca a senha e encerra tudo o que estava ligado na conta (lib/auth/encerrar.ts): outras sessões do site,
 * computadores, chave do Atalho e avisos no celular; os links pra IA só com `links`. A sessão atual continua.
 * Conta sem senha (criada pelo Google) não cria a primeira por aqui (revisão A5): só uma sessão não prova quem é,
 * e uma sessão roubada viraria login permanente. A primeira senha sai pelo link por e-mail (redefinir.ts).
 */
export async function trocarSenha(entrada: {
  usuarioId: string;
  sessaoId: string;
  senhaAtual: unknown;
  senhaNova: unknown;
  ip: string;
  links?: boolean;
  /** Para o e-mail "a senha mudou" (padrão: em segundo plano). */
  depois?: Depois;
}): Promise<{ ok: true; encerrado: Encerrado } | Falha> {
  const atual = typeof entrada.senhaAtual === "string" ? entrada.senhaAtual : "";
  const nova = typeof entrada.senhaNova === "string" ? entrada.senhaNova : "";
  if (nova.length < SENHA_MINIMA) return { ok: false, erro: "entrada", campo: "senhaNova", mensagem: `A senha nova precisa de pelo menos ${SENHA_MINIMA} caracteres.` };
  if (nova.length > SENHA_MAXIMA) return { ok: false, erro: "entrada", campo: "senhaNova", mensagem: "Senha longa demais." };

  const chave = `senha:${entrada.usuarioId}`;
  if (!(await dentroDoLimite(chave, REGRAS.loginEmail))) return { ok: false, erro: "devagar", mensagem: MENSAGEM_LIMITE };
  const usuario = await db.query.usuarios.findFirst({ where: eq(usuarios.id, entrada.usuarioId) });
  if (usuario && !usuario.senhaHash.startsWith("scrypt$")) return { ok: false, erro: "sem_senha", mensagem: MENSAGEM_SEM_SENHA };
  if (!usuario || !(await conferirSenha(atual, usuario.senhaHash))) {
    await registrarTentativa(chave);
    return { ok: false, erro: "credenciais", campo: "senhaAtual", mensagem: "A senha atual não confere." };
  }
  await db.update(usuarios).set({ senhaHash: await hashSenha(nova), atualizadoEm: new Date() }).where(eq(usuarios.id, usuario.id));
  const encerrado = await encerrarAcessos(usuario.id, { manterSessao: entrada.sessaoId, links: entrada.links === true });
  await esquecerTentativas(chave);
  const usuarioId = usuario.id;
  (entrada.depois ?? emSegundoPlano)(() => avisarSenhaMudou(usuarioId, "trocada"));
  return { ok: true, encerrado };
}

export async function trocarNome(usuarioId: string, valor: unknown): Promise<{ ok: true; nome: string } | Falha> {
  const nome = nomeLimpo(valor);
  if (!nome) return { ok: false, erro: "entrada", campo: "nome", mensagem: "O nome não pode ficar vazio." };
  await db.update(usuarios).set({ nome, atualizadoEm: new Date() }).where(eq(usuarios.id, usuarioId));
  return { ok: true, nome };
}

/** A conta tem senha? (as criadas pelo Google começam sem.) */
export async function contaComSenha(usuarioId: string): Promise<boolean> {
  const u = await db.query.usuarios.findFirst({ where: eq(usuarios.id, usuarioId), columns: { senhaHash: true } });
  return Boolean(u?.senhaHash.startsWith("scrypt$"));
}
