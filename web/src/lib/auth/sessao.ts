/**
 * Sessões (docs/CONTAS.md §4). O token vai para o cookie `sd_sessao` (site) ou para o computador
 * (`Bearer sdd_...`); o banco guarda só o sha256. Expiração deslizante: web 30 dias, dispositivo 180.
 * Sem next/headers aqui: as rotas e os testes passam cookie e Authorization direto.
 */
import { and, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Plataforma, TipoSessao } from "@/lib/db/schema";
import { FORMATO_TOKEN_DISPOSITIVO, FORMATO_TOKEN_WEB, hashToken, novoId, novoToken, PREFIXO_DISPOSITIVO } from "./tokens";

const { sessoes, usuarios, dispositivoStatus } = schema;

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
export async function autenticar(credenciais: { cookie?: string | null; authorization?: string | null }): Promise<Autenticado | null> {
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

  let expiraEm = linha.sessao.expiraEm;
  if (agora.getTime() - linha.sessao.ultimoUsoEm.getTime() > INTERVALO_DESLIZE) {
    expiraEm = new Date(agora.getTime() + DURACAO[tipo]);
    await db.update(sessoes).set({ ultimoUsoEm: agora, expiraEm }).where(eq(sessoes.id, linha.sessao.id));
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
