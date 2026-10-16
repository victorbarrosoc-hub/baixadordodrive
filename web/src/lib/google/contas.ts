/**
 * Contas Google vinculadas a uma conta SOBEDESCE (tabela contas_google).
 * Refresh e access token ficam cifrados no banco e nunca saem do servidor; o access token sai
 * só por /api/drive/token, para o dono da conta.
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { EstadoContaGoogle } from "@/lib/db/schema";
import { dentroDoLimite, REGRAS, registrarTentativa } from "@/lib/auth/limite";
import { novoId } from "@/lib/auth/tokens";
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
 */
export async function vincularConta(usuarioId: string, p: PerfilGoogle, tokens: Tokens & { refresh: string }): Promise<ResultadoVinculo> {
  const existente = await db.query.contasGoogle.findFirst({ where: eq(contasGoogle.googleSub, p.sub) });
  if (existente && existente.usuarioId !== usuarioId) return { ok: false, erro: "google_outra_conta" };
  if (existente) {
    await db
      .update(contasGoogle)
      .set({ ...camposDosTokens(existente.id, tokens, tokens.refresh), email: p.email, nome: p.nome, fotoUrl: p.fotoUrl })
      .where(eq(contasGoogle.id, existente.id));
    return { ok: true, nova: false, conta: contaPublica({ ...existente, email: p.email, nome: p.nome, fotoUrl: p.fotoUrl, estado: "ok" }) };
  }
  const id = novoId();
  const inserida = await db
    .insert(contasGoogle)
    .values({ id, usuarioId, googleSub: p.sub, email: p.email, nome: p.nome, fotoUrl: p.fotoUrl, ...camposDosTokens(id, tokens, tokens.refresh) })
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

/**
 * "Entrar com Google": dono da conta Google, ou null se ela não está vinculada.
 * Aproveita o consentimento para renovar os tokens guardados (tira o "reconectar").
 */
export async function donoDaContaGoogle(p: PerfilGoogle, tokens: Tokens): Promise<string | null> {
  const existente = await db.query.contasGoogle.findFirst({ where: eq(contasGoogle.googleSub, p.sub) });
  if (!existente) return null;
  const extras = { email: p.email, nome: p.nome, fotoUrl: p.fotoUrl, atualizadoEm: new Date() };
  await db
    .update(contasGoogle)
    .set(tokens.refresh ? { ...camposDosTokens(existente.id, tokens, tokens.refresh), ...extras } : extras)
    .where(eq(contasGoogle.id, existente.id));
  await db.update(usuarios).set({ ultimoLoginEm: new Date() }).where(eq(usuarios.id, existente.usuarioId));
  return existente.usuarioId;
}

/** Marca de conta criada pelo Google: não é um hash, então nenhuma senha confere até a pessoa criar uma (Esqueci a senha). */
export const SEM_SENHA = "google";

export type ResultadoCriacao = { ok: true; usuarioId: string } | { ok: false; erro: "google_email_em_uso" | "google_email_nao_verificado" | "google_devagar" };

/**
 * "Continuar com Google" de quem ainda não tem conta: cria a conta SOBEDESCE com o nome e o e-mail
 * do Google e já vincula esse Drive. E-mail que já tem conta (criada com senha) não é tomado: a pessoa
 * entra com a senha e conecta o Drive em Sua conta.
 */
export async function criarContaComGoogle(p: PerfilGoogle, tokens: Tokens & { refresh: string }, ip: string): Promise<ResultadoCriacao> {
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
  const v = await vincularConta(usuarioId, p, tokens);
  if (!v.ok) {
    // Corrida rara: outra aba vinculou esta conta Google a outro usuário no meio do caminho.
    await db.delete(usuarios).where(eq(usuarios.id, usuarioId));
    return { ok: false, erro: "google_email_em_uso" };
  }
  return { ok: true, usuarioId };
}

/** Remove a conta: revoga no Google (melhor esforço) e apaga a linha. */
export async function removerConta(usuarioId: string, contaId: string): Promise<boolean> {
  const l = await db.query.contasGoogle.findFirst({ where: and(eq(contasGoogle.id, contaId), eq(contasGoogle.usuarioId, usuarioId)) });
  if (!l) return false;
  try {
    await revogar(abrir(l.refreshTokenEnc, ctxRefresh(l.id)));
  } catch {
    // chave trocada: a linha sai do mesmo jeito
  }
  await db.delete(contasGoogle).where(and(eq(contasGoogle.id, contaId), eq(contasGoogle.usuarioId, usuarioId)));
  return true;
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
