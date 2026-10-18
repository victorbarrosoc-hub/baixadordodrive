/**
 * Sessões (docs/CONTAS.md §4). O token vai para o cookie `sd_sessao` (site) ou para o computador
 * (`Bearer sdd_...`); o banco guarda só o sha256. Expiração deslizante: web 30 dias, dispositivo 180.
 * Sem next/headers aqui: as rotas e os testes passam cookie e Authorization direto.
 */
import { and, eq, gt, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Plataforma, TipoSessao } from "@/lib/db/schema";
import { FORMATO_TOKEN_DISPOSITIVO, FORMATO_TOKEN_WEB, hashToken, novoId, novoToken, PREFIXO_DISPOSITIVO } from "./tokens";

const { sessoes, usuarios, dispositivoStatus, redefinicoesSenha, codigosDispositivo, atividadeDiaria, usoDiario } = schema;

/**
 * Limpeza do que a política de privacidade promete apagar: links de "Esqueci a senha" usados ou vencidos (uma hora)
 * e pedidos de computador vencidos há mais de um dia (com o IP e a cidade de quem pediu). redefinir.ts e
 * dispositivo.ts apagam no caminho de quem usa; aqui, de carona nos pedidos com sessão (no máximo a cada 15 minutos
 * por instância, sem esperar), some também o que ninguém usou.
 */
const INTERVALO_LIMPEZA = 15 * 60_000;
let ultimaLimpeza = 0;
function limpezaDeCarona(agora: Date) {
  if (agora.getTime() - ultimaLimpeza < INTERVALO_LIMPEZA) return;
  ultimaLimpeza = agora.getTime();
  void db
    .delete(redefinicoesSenha)
    .where(or(isNotNull(redefinicoesSenha.usadoEm), lt(redefinicoesSenha.expiraEm, agora)))
    .catch(() => {});
  void db
    .delete(codigosDispositivo)
    .where(lt(codigosDispositivo.expiraEm, new Date(agora.getTime() - DIA)))
    .catch(() => {});
  // Uso para o admin (docs/CONTAS.md §10): 400 dias.
  const corte = diaDe(new Date(agora.getTime() - GUARDA_USO_DIAS * DIA));
  void db.delete(atividadeDiaria).where(lt(atividadeDiaria.dia, corte)).catch(() => {});
  void db.delete(usoDiario).where(lt(usoDiario.dia, corte)).catch(() => {});
}

/** Quanto tempo a atividade diária e o uso dos computadores ficam guardados. */
export const GUARDA_USO_DIAS = 400;
const FUSO = "America/Fortaleza";
const formatoDia = new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" });
/** "2026-10-18" no fuso da tela de admin. */
export function diaDe(d: Date): string {
  return formatoDia.format(d);
}

/** Por onde a pessoa está usando: o computador (Bearer), o app do celular instalado (cabeçalho do /app) ou o site. */
export type Origem = "site" | "celular" | "computador";

/** Marca o dia de uso da pessoa (uma linha por pessoa e dia; o "por onde" só acumula). */
async function marcarDia(usuarioId: string, origem: Origem, agora: Date) {
  const marca = { site: origem === "site", celular: origem === "celular", computador: origem === "computador" };
  await db
    .insert(atividadeDiaria)
    .values({ usuarioId, dia: diaDe(agora), ...marca, ultimaEm: agora, ultimaOrigem: origem })
    .onConflictDoUpdate({
      target: [atividadeDiaria.usuarioId, atividadeDiaria.dia],
      set: { [origem]: true, ultimaEm: agora, ultimaOrigem: origem },
    });
}

/** O andamento das transferências (docs/CONTAS.md §9) some junto com a sessão do computador. */
async function apagarAndamento(linhas: { id: string }[]) {
  if (linhas.length) await db.delete(dispositivoStatus).where(inArray(dispositivoStatus.sessaoId, linhas.map((l) => l.id)));
}

export const COOKIE_SESSAO = "sd_sessao";
const DIA = 24 * 60 * 60_000;
export const DURACAO: Record<TipoSessao, number> = { web: 30 * DIA, dispositivo: 180 * DIA };
/** Só regrava ultimoUsoEm/expiraEm se a última gravação tem mais que isso (evita uma escrita por pedido). */
const INTERVALO_DESLIZE = 10 * 60_000;

export type UsuarioPublico = { id: string; email: string; nome: string };
export type SessaoAtual = {
  id: string;
  tipo: TipoSessao;
  nome: string | null;
  plataforma: Plataforma | null;
  expiraEm: Date;
};
export type Autenticado = { usuario: UsuarioPublico; sessao: SessaoAtual; via: "cookie" | "bearer" };

export async function criarSessao(
  usuarioId: string,
  tipo: TipoSessao,
  dispositivo?: { nome: string; plataforma: Plataforma | null },
): Promise<{ token: string; expiraEm: Date; id: string }> {
  const bruto = novoToken();
  const token = tipo === "dispositivo" ? PREFIXO_DISPOSITIVO + bruto : bruto;
  const id = novoId();
  const expiraEm = new Date(Date.now() + DURACAO[tipo]);
  await db.insert(sessoes).values({
    id,
    usuarioId,
    tokenHash: hashToken(token),
    tipo,
    nome: dispositivo?.nome ?? null,
    plataforma: dispositivo?.plataforma ?? null,
    expiraEm,
  });
  return { token, expiraEm, id };
}

/** Token de "Authorization: Bearer ..." (só o de dispositivo vale). */
export function tokenDoBearer(authorization: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  return m ? m[1] : null;
}

/**
 * Quem está pedindo. Com Authorization, só o Bearer de dispositivo conta (o cookie é ignorado);
 * sem Authorization, o cookie do site.
 */
export async function autenticar(credenciais: {
  cookie?: string | null;
  authorization?: string | null;
  /** O app do celular instalado (cabeçalho x-sobedesce-app: celular). */
  celular?: boolean;
  /** Build do app de computador (cabeçalho x-sobedesce-build). */
  build?: number | null;
}): Promise<Autenticado | null> {
  let token: string;
  let tipo: TipoSessao;
  let via: Autenticado["via"];
  if (credenciais.authorization) {
    const t = tokenDoBearer(credenciais.authorization);
    if (!t || !FORMATO_TOKEN_DISPOSITIVO.test(t)) return null;
    token = t;
    tipo = "dispositivo";
    via = "bearer";
  } else {
    const t = credenciais.cookie;
    if (!t || !FORMATO_TOKEN_WEB.test(t)) return null;
    token = t;
    tipo = "web";
    via = "cookie";
  }
  const agora = new Date();
  const [linha] = await db
    .select({
      sessao: {
        id: sessoes.id,
        tipo: sessoes.tipo,
        nome: sessoes.nome,
        plataforma: sessoes.plataforma,
        expiraEm: sessoes.expiraEm,
        ultimoUsoEm: sessoes.ultimoUsoEm,
      },
      usuario: { id: usuarios.id, email: usuarios.email, nome: usuarios.nome },
    })
    .from(sessoes)
    .innerJoin(usuarios, eq(usuarios.id, sessoes.usuarioId))
    .where(and(eq(sessoes.tokenHash, hashToken(token)), eq(sessoes.tipo, tipo), isNull(sessoes.revogadaEm), gt(sessoes.expiraEm, agora)))
    .limit(1);
  if (!linha) return null;
  limpezaDeCarona(agora);

  let expiraEm = linha.sessao.expiraEm;
  // A cada 10 minutos (e na virada do dia, para o dia contar): desliza a sessão e marca o dia de uso.
  if (agora.getTime() - linha.sessao.ultimoUsoEm.getTime() > INTERVALO_DESLIZE || diaDe(agora) !== diaDe(linha.sessao.ultimoUsoEm)) {
    expiraEm = new Date(agora.getTime() + DURACAO[tipo]);
    const build = tipo === "dispositivo" && Number.isSafeInteger(credenciais.build) && credenciais.build! >= 0 ? credenciais.build! : undefined;
    await db
      .update(sessoes)
      .set({ ultimoUsoEm: agora, expiraEm, ...(build !== undefined ? { appBuild: build } : {}) })
      .where(eq(sessoes.id, linha.sessao.id));
    const origem: Origem = tipo === "dispositivo" ? "computador" : credenciais.celular ? "celular" : "site";
    await marcarDia(linha.usuario.id, origem, agora).catch(() => {});
  }
  return {
    usuario: linha.usuario,
    sessao: { id: linha.sessao.id, tipo: linha.sessao.tipo, nome: linha.sessao.nome, plataforma: linha.sessao.plataforma, expiraEm },
    via,
  };
}

export async function revogarSessao(id: string): Promise<void> {
  const r = await db.update(sessoes).set({ revogadaEm: new Date() }).where(and(eq(sessoes.id, id), isNull(sessoes.revogadaEm))).returning({ id: sessoes.id });
  await apagarAndamento(r);
}

/** Uma sessão de um usuário, de qualquer tipo (admin desconectando um aparelho). Devolve se achou. */
export async function revogarSessaoDe(usuarioId: string, sessaoId: string): Promise<boolean> {
  const r = await db
    .update(sessoes)
    .set({ revogadaEm: new Date() })
    .where(and(eq(sessoes.id, sessaoId), eq(sessoes.usuarioId, usuarioId), isNull(sessoes.revogadaEm)))
    .returning({ id: sessoes.id });
  await apagarAndamento(r);
  return r.length > 0;
}

/** Revoga pelo token (sair do site com o cookie). */
export async function revogarPorToken(token: string): Promise<void> {
  const r = await db
    .update(sessoes)
    .set({ revogadaEm: new Date() })
    .where(and(eq(sessoes.tokenHash, hashToken(token)), isNull(sessoes.revogadaEm)))
    .returning({ id: sessoes.id });
  await apagarAndamento(r);
}

/** Computador de um usuário (a pessoa desconecta em /conta). Devolve se achou. */
export async function revogarDispositivo(usuarioId: string, sessaoId: string): Promise<boolean> {
  const r = await db
    .update(sessoes)
    .set({ revogadaEm: new Date() })
    .where(and(eq(sessoes.id, sessaoId), eq(sessoes.usuarioId, usuarioId), eq(sessoes.tipo, "dispositivo"), isNull(sessoes.revogadaEm)))
    .returning({ id: sessoes.id });
  await apagarAndamento(r);
  return r.length > 0;
}

/** Todas as sessões do usuário menos a atual (troca de senha). */
export async function revogarOutras(usuarioId: string, manter: string): Promise<void> {
  const r = await db
    .update(sessoes)
    .set({ revogadaEm: new Date() })
    .where(and(eq(sessoes.usuarioId, usuarioId), ne(sessoes.id, manter), isNull(sessoes.revogadaEm)))
    .returning({ id: sessoes.id });
  await apagarAndamento(r);
}

/** Computadores ativos, do uso mais recente para o mais antigo. */
export async function listarDispositivos(usuarioId: string) {
  const linhas = await db
    .select({
      id: sessoes.id,
      nome: sessoes.nome,
      plataforma: sessoes.plataforma,
      criadoEm: sessoes.criadoEm,
      ultimoUsoEm: sessoes.ultimoUsoEm,
    })
    .from(sessoes)
    .where(and(eq(sessoes.usuarioId, usuarioId), eq(sessoes.tipo, "dispositivo"), isNull(sessoes.revogadaEm), gt(sessoes.expiraEm, new Date())));
  return linhas.sort((a, b) => b.ultimoUsoEm.getTime() - a.ultimoUsoEm.getTime());
}

/** Opções do cookie do site (30 dias). */
export function opcoesCookieSessao(seguro: boolean) {
  return { httpOnly: true, secure: seguro, sameSite: "lax" as const, path: "/", maxAge: DURACAO.web / 1000 };
}
