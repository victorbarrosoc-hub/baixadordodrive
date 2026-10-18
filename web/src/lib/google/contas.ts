/**
 * Contas Google vinculadas a uma conta SOBEDESCE (tabela contas_google).
 * Refresh e access token ficam cifrados no banco e nunca saem do servidor; o access token sai
 * só por /api/drive/token, para o dono da conta.
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { EstadoContaGoogle } from "@/lib/db/schema";
import { dentroDoLimite, esquecerTentativas, MENSAGEM_LIMITE, REGRAS, registrarTentativa } from "@/lib/auth/limite";
import { conferirSenha } from "@/lib/auth/senha";
import { novoId } from "@/lib/auth/tokens";
import { emSegundoPlano, type Depois } from "@/lib/depois";
import { avisarGoogleDeEntrar } from "@/lib/email/avisos";
import { avisarAdminContaNova } from "@/lib/email/admin";
import { abrir, ChaveErrada, selar } from "./cripto";
import { GoogleError } from "./erros";
import { renovarAcesso, revogar, type PerfilGoogle, type Tokens } from "./oauth";

const { contasGoogle, usuarios } = schema;
type Linha = typeof contasGoogle.$inferSelect;

/** Formato público (docs/CONTAS.md §5). Nunca leva token. */
export type Conta = { id: string; email: string; nome: string | null; fotoUrl: string | null; estado: EstadoContaGoogle };

const ctxRefresh = (id: string) => `contas_google.refresh:${id}`;
const ctxAcesso = (id: string) => `contas_google.acesso:${id}`;

/** Folga: abaixo disso o access token guardado não é mais entregue. */
export const FOLGA_MS = 5 * 60_000;

export function contaPublica(l: Pick<Linha, "id" | "email" | "nome" | "fotoUrl" | "estado">): Conta {
  return { id: l.id, email: l.email, nome: l.nome, fotoUrl: l.fotoUrl, estado: l.estado };
}

export async function listarContas(usuarioId: string): Promise<Conta[]> {
  const linhas = await db
    .select({ id: contasGoogle.id, email: contasGoogle.email, nome: contasGoogle.nome, fotoUrl: contasGoogle.fotoUrl, estado: contasGoogle.estado, criadoEm: contasGoogle.criadoEm })
    .from(contasGoogle)
    .where(eq(contasGoogle.usuarioId, usuarioId));
  return linhas.sort((a, b) => a.criadoEm.getTime() - b.criadoEm.getTime()).map(contaPublica);
}

function camposDosTokens(id: string, tokens: Tokens, refresh: string) {
  return {
    refreshTokenEnc: selar(refresh, ctxRefresh(id)),
    accessTokenEnc: selar(tokens.acesso, ctxAcesso(id)),
    accessExpiraEm: new Date(tokens.expiraEm),
    escopos: tokens.escopo,
    estado: "ok" as const,
    atualizadoEm: new Date(),
  };
}

export type ResultadoVinculo = { ok: true; conta: Conta; nova: boolean } | { ok: false; erro: "google_outra_conta" };

/**
 * Grava a conta Google do consentimento na conta SOBEDESCE `usuarioId`.
 * Já é desta conta: atualiza tokens e perfil (é o "Reconectar"). É de outra: recusa sem gravar nada.
 * O `email_verified` do Google é gravado a cada vez (admin exige e-mail confirmado).
 * Um Drive novo nunca vira porta de entrada sozinho: `login` só no "Continuar com Google" que cria a conta.
 */
export async function vincularConta(
  usuarioId: string,
  p: PerfilGoogle,
  tokens: Tokens & { refresh: string },
  opcoes: { login?: boolean } = {},
): Promise<ResultadoVinculo> {
  const existente = await db.query.contasGoogle.findFirst({ where: eq(contasGoogle.googleSub, p.sub) });
  if (existente && existente.usuarioId !== usuarioId) return { ok: false, erro: "google_outra_conta" };
  if (existente) {
    await db
      .update(contasGoogle)
      .set({ ...camposDosTokens(existente.id, tokens, tokens.refresh), email: p.email, nome: p.nome, fotoUrl: p.fotoUrl, emailVerificado: p.emailVerificado })
      .where(eq(contasGoogle.id, existente.id));
    return { ok: true, nova: false, conta: contaPublica({ ...existente, email: p.email, nome: p.nome, fotoUrl: p.fotoUrl, estado: "ok" }) };
  }
  const id = novoId();
  const inserida = await db
    .insert(contasGoogle)
    .values({
      id,
      usuarioId,
      googleSub: p.sub,
      email: p.email,
      nome: p.nome,
      fotoUrl: p.fotoUrl,
      emailVerificado: p.emailVerificado,
      loginPermitido: opcoes.login === true,
      ...camposDosTokens(id, tokens, tokens.refresh),
    })
    .onConflictDoNothing({ target: contasGoogle.googleSub })
    .returning({ id: contasGoogle.id });
  if (inserida.length === 0) {
    // Duas abas vincularam a mesma conta ao mesmo tempo: decide quem gravou primeiro.
    const agora = await db.query.contasGoogle.findFirst({ where: eq(contasGoogle.googleSub, p.sub) });
    if (agora?.usuarioId !== usuarioId) return { ok: false, erro: "google_outra_conta" };
    return { ok: true, nova: false, conta: contaPublica(agora) };
  }
  return { ok: true, nova: true, conta: { id, email: p.email, nome: p.nome, fotoUrl: p.fotoUrl, estado: "ok" } };
}

export type ResultadoEntrada = { tipo: "ok"; usuarioId: string } | { tipo: "nao_vinculada" } | { tipo: "nao_e_login" };

/**
 * "Entrar com Google" (revisão A3): só entra pelo Google marcado para entrar (`loginPermitido`): o que criou a conta
 * ou o escolhido em /conta. Um Drive conectado a mais (de um cliente, de uma equipe) não abre a conta: "nao_e_login",
 * sem mexer em nada. Pelo Google de entrar, aproveita o consentimento para renovar os tokens (tira o "reconectar").
 */
export async function donoDaContaGoogle(p: PerfilGoogle, tokens: Tokens): Promise<ResultadoEntrada> {
  const existente = await db.query.contasGoogle.findFirst({ where: eq(contasGoogle.googleSub, p.sub) });
  if (!existente) return { tipo: "nao_vinculada" };
  if (!existente.loginPermitido) return { tipo: "nao_e_login" };
  const extras = { email: p.email, nome: p.nome, fotoUrl: p.fotoUrl, emailVerificado: p.emailVerificado, atualizadoEm: new Date() };
  await db
    .update(contasGoogle)
    .set(tokens.refresh ? { ...camposDosTokens(existente.id, tokens, tokens.refresh), ...extras } : extras)
    .where(eq(contasGoogle.id, existente.id));
  await db.update(usuarios).set({ ultimoLoginEm: new Date() }).where(eq(usuarios.id, existente.usuarioId));
  return { tipo: "ok", usuarioId: existente.usuarioId };
}

/** Id do Google que entra na conta (null = nenhum: só e-mail e senha). */
export async function googleDeEntrar(usuarioId: string): Promise<string | null> {
  const l = await db.query.contasGoogle.findFirst({
    where: and(eq(contasGoogle.usuarioId, usuarioId), eq(contasGoogle.loginPermitido, true)),
    columns: { id: true },
  });
  return l?.id ?? null;
}

export type FalhaEntrada = { ok: false; erro: "sem_senha" | "credenciais" | "nao_encontrada" | "devagar"; mensagem: string; campo?: "senhaAtual" | "conta" };

/**
 * Troca o Google de entrar (ou desliga, com `contaId` null). Pede a senha atual: com uma sessão roubada, ninguém
 * põe o próprio Google como porta de entrada. Conta sem senha (criada pelo Google) cria uma senha antes, pelo link
 * por e-mail; assim ela nunca fica sem jeito de entrar.
 */
export async function trocarGoogleDeEntrar(entrada: {
  usuarioId: string;
  contaId: string | null;
  senhaAtual: unknown;
  /** Para o e-mail de Google de entrar trocado ou removido (padrão: em segundo plano). */
  depois?: Depois;
}): Promise<{ ok: true; conta: Conta | null } | FalhaEntrada> {
  const usuario = await db.query.usuarios.findFirst({ where: eq(usuarios.id, entrada.usuarioId), columns: { id: true, senhaHash: true } });
  if (!usuario) return { ok: false, erro: "nao_encontrada", mensagem: "Entre na sua conta para continuar." };
  if (!usuario.senhaHash.startsWith("scrypt$")) {
    return { ok: false, erro: "sem_senha", mensagem: "Crie uma senha antes de trocar o Google de entrar." };
  }
  const chave = `senha:${usuario.id}`;
  if (!(await dentroDoLimite(chave, REGRAS.loginEmail))) return { ok: false, erro: "devagar", mensagem: MENSAGEM_LIMITE };
  const senha = typeof entrada.senhaAtual === "string" ? entrada.senhaAtual : "";
  if (!senha || !(await conferirSenha(senha, usuario.senhaHash))) {
    await registrarTentativa(chave);
    return { ok: false, erro: "credenciais", campo: "senhaAtual", mensagem: "A senha atual não confere." };
  }
  await esquecerTentativas(chave);

  const r = await db.transaction(async (t) => {
    const [anterior] = await t
      .select({ id: contasGoogle.id, email: contasGoogle.email })
      .from(contasGoogle)
      .where(and(eq(contasGoogle.usuarioId, usuario.id), eq(contasGoogle.loginPermitido, true)));
    let escolhida: Linha | undefined;
    if (entrada.contaId) {
      [escolhida] = await t
        .select()
        .from(contasGoogle)
        .where(and(eq(contasGoogle.id, entrada.contaId), eq(contasGoogle.usuarioId, usuario.id)));
      if (!escolhida) return { ok: false as const, erro: "nao_encontrada" as const, campo: "conta" as const, mensagem: "Este Drive não está mais na sua conta." };
    }
    // Primeiro desliga todos (o índice único aceita no máximo um ligado por conta), depois liga o escolhido.
    await t.update(contasGoogle).set({ loginPermitido: false }).where(and(eq(contasGoogle.usuarioId, usuario.id), eq(contasGoogle.loginPermitido, true)));
    if (escolhida) await t.update(contasGoogle).set({ loginPermitido: true }).where(eq(contasGoogle.id, escolhida.id));
    return { ok: true as const, conta: escolhida ? contaPublica(escolhida) : null, anterior: anterior ?? null };
  });
  if (!r.ok) return r;
  const { anterior, conta } = r;
  // Só avisa quando mudou mesmo (escolher o mesmo de novo não manda nada).
  if ((anterior?.id ?? null) !== (conta?.id ?? null)) {
    const usuarioId = usuario.id;
    (entrada.depois ?? emSegundoPlano)(() => avisarGoogleDeEntrar(usuarioId, { novo: conta?.email ?? null, anterior: anterior?.email ?? null }));
  }
  return { ok: true, conta };
}

/** Marca de conta criada pelo Google: não é um hash, então nenhuma senha confere até a pessoa criar uma (Esqueci a senha). */
export const SEM_SENHA = "google";

export type ResultadoCriacao = { ok: true; usuarioId: string } | { ok: false; erro: "google_email_em_uso" | "google_email_nao_verificado" | "google_devagar" };

/**
 * "Continuar com Google" de quem ainda não tem conta: cria a conta SOBEDESCE com o nome e o e-mail
 * do Google e já vincula esse Drive. E-mail que já tem conta (criada com senha) não é tomado: a pessoa
 * entra com a senha e conecta o Drive em Sua conta.
 */
export async function criarContaComGoogle(
  p: PerfilGoogle,
  tokens: Tokens & { refresh: string },
  ip: string,
  depois: Depois = emSegundoPlano,
): Promise<ResultadoCriacao> {
  if (!p.emailVerificado) return { ok: false, erro: "google_email_nao_verificado" };
  const chave = `criar:${ip}`;
  if (!(await dentroDoLimite(chave, REGRAS.criarConta))) return { ok: false, erro: "google_devagar" };
  await registrarTentativa(chave);

  const usuarioId = novoId();
  const nome = (p.nome?.trim() || p.email.split("@")[0]).slice(0, 80);
  const criado = await db
    .insert(usuarios)
    .values({ id: usuarioId, email: p.email, nome, senhaHash: SEM_SENHA, ultimoLoginEm: new Date() })
    .onConflictDoNothing({ target: usuarios.email })
    .returning({ id: usuarios.id });
  if (criado.length === 0) return { ok: false, erro: "google_email_em_uso" };
  // O Google que cria a conta é o de entrar.
  const v = await vincularConta(usuarioId, p, tokens, { login: true });
  if (!v.ok) {
    // Corrida rara: outra aba vinculou esta conta Google a outro usuário no meio do caminho.
    await db.delete(usuarios).where(eq(usuarios.id, usuarioId));
    return { ok: false, erro: "google_email_em_uso" };
  }
  depois(() => avisarAdminContaNova({ id: usuarioId, nome, email: p.email }, true));
  return { ok: true, usuarioId };
}

export type ResultadoRemocao = { ok: true } | { ok: false; erro: "nao_encontrada" | "google_de_entrar" };

/**
 * Remove a conta: revoga no Google (melhor esforço) e apaga a linha.
 * O Google de entrar de uma conta sem senha não sai: seria a única porta de entrada dela.
 */
export async function removerConta(usuarioId: string, contaId: string, depois: Depois = emSegundoPlano): Promise<ResultadoRemocao> {
  const l = await db.query.contasGoogle.findFirst({ where: and(eq(contasGoogle.id, contaId), eq(contasGoogle.usuarioId, usuarioId)) });
  if (!l) return { ok: false, erro: "nao_encontrada" };
  if (l.loginPermitido) {
    const u = await db.query.usuarios.findFirst({ where: eq(usuarios.id, usuarioId), columns: { senhaHash: true } });
    if (!u?.senhaHash.startsWith("scrypt$")) return { ok: false, erro: "google_de_entrar" };
  }
  try {
    await revogar(abrir(l.refreshTokenEnc, ctxRefresh(l.id)));
  } catch {
    // chave trocada: a linha sai do mesmo jeito
  }
  const apagada = await db
    .delete(contasGoogle)
    .where(and(eq(contasGoogle.id, contaId), eq(contasGoogle.usuarioId, usuarioId)))
    .returning({ id: contasGoogle.id });
  // Era o Google de entrar: a conta passa a abrir só com e-mail e senha, e o dono fica sabendo.
  if (apagada.length && l.loginPermitido) depois(() => avisarGoogleDeEntrar(usuarioId, { novo: null, anterior: l.email }));
  return { ok: true };
}

export class ErroConta extends Error {
  constructor(public codigo: "nao_encontrada" | "reconectar" | "google" | "sem_config") {
    super(codigo);
    this.name = "ErroConta";
  }
}

export type TokenEntregue = { accessToken: string; expiraEm: number; email: string };

type ResultadoRenovacao = { tipo: "ok"; token: TokenEntregue } | { tipo: "erro"; codigo: ErroConta["codigo"] };

/** Renovações em curso nesta instância (uma por conta). Entre instâncias vale o FOR UPDATE. */
const emCurso = new Map<string, Promise<ResultadoRenovacao>>();

function guardadoValido(l: Linha): TokenEntregue | null {
  if (!l.accessTokenEnc || !l.accessExpiraEm || l.accessExpiraEm.getTime() - Date.now() <= FOLGA_MS) return null;
  try {
    return { accessToken: abrir(l.accessTokenEnc, ctxAcesso(l.id)), expiraEm: l.accessExpiraEm.getTime(), email: l.email };
  } catch {
    return null;
  }
}

/**
 * Access token da conta `contaId` do usuário. Devolve o guardado se faltar mais de 5 minutos;
 * senão (ou com `renovar`) renova no Google, uma renovação por vez por conta.
 * invalid_grant → estado "reconectar" e ErroConta("reconectar").
 */
export async function tokenDeAcesso(usuarioId: string, contaId: string, opcoes: { renovar?: boolean } = {}): Promise<TokenEntregue> {
  const l = await db.query.contasGoogle.findFirst({ where: and(eq(contasGoogle.id, contaId), eq(contasGoogle.usuarioId, usuarioId)) });
  if (!l) throw new ErroConta("nao_encontrada");
  if (l.estado === "reconectar") throw new ErroConta("reconectar");
  if (!opcoes.renovar) {
    const guardado = guardadoValido(l);
    if (guardado) return guardado;
  }
  const pedidoEm = new Date();
  let p = emCurso.get(contaId);
  if (!p) {
    p = renovarComTrava(contaId, opcoes.renovar ? pedidoEm : null).finally(() => emCurso.delete(contaId));
    emCurso.set(contaId, p);
  }
  const r = await p;
  if (r.tipo === "erro") throw new ErroConta(r.codigo);
  return r.token;
}

/**
 * Dentro de uma transação com a linha travada (FOR UPDATE): quem chegar depois espera e
 * reaproveita o token novo. `depoisDe`: com `renovar`, só serve token gravado depois do pedido.
 */
async function renovarComTrava(contaId: string, depoisDe: Date | null): Promise<ResultadoRenovacao> {
  return db.transaction(async (t): Promise<ResultadoRenovacao> => {
    const [l] = await t.select().from(contasGoogle).where(eq(contasGoogle.id, contaId)).for("update");
    if (!l) return { tipo: "erro", codigo: "nao_encontrada" };
    if (l.estado === "reconectar") return { tipo: "erro", codigo: "reconectar" };
    if (!depoisDe || l.atualizadoEm.getTime() >= depoisDe.getTime()) {
      const guardado = guardadoValido(l);
      if (guardado) return { tipo: "ok", token: guardado };
    }
    const marcarReconectar = () => t.update(contasGoogle).set({ estado: "reconectar", accessTokenEnc: null, accessExpiraEm: null, atualizadoEm: new Date() }).where(eq(contasGoogle.id, contaId));
    let refresh: string;
    try {
      refresh = abrir(l.refreshTokenEnc, ctxRefresh(l.id));
    } catch (e) {
      if (!(e instanceof ChaveErrada)) throw e;
      await marcarReconectar();
      return { tipo: "erro", codigo: "reconectar" };
    }
    try {
      const novo = await renovarAcesso(refresh);
      const atualizadoEm = new Date();
      await t
        .update(contasGoogle)
        .set({
          accessTokenEnc: selar(novo.acesso, ctxAcesso(l.id)),
          accessExpiraEm: new Date(novo.expiraEm),
          ...(novo.refresh ? { refreshTokenEnc: selar(novo.refresh, ctxRefresh(l.id)) } : {}),
          ...(novo.escopo ? { escopos: novo.escopo } : {}),
          atualizadoEm,
        })
        .where(eq(contasGoogle.id, contaId));
      return { tipo: "ok", token: { accessToken: novo.acesso, expiraEm: novo.expiraEm, email: l.email } };
    } catch (e) {
      if (e instanceof GoogleError && e.motivo === "reconectar") {
        await marcarReconectar();
        return { tipo: "erro", codigo: "reconectar" };
      }
      if (e instanceof GoogleError && e.motivo === "sem_config") return { tipo: "erro", codigo: "sem_config" };
      return { tipo: "erro", codigo: "google" };
    }
  });
}
