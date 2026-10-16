/**
 * Andamento das transferências dos computadores (docs/CONTAS.md §9): o computador manda, o celular lê.
 * Guarda só o último retrato de cada computador, por até 7 dias sem notícia. Quando um lote termina (ou para
 * com erro), avisa uma vez no celular por Web Push.
 */
import "server-only";
import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { avisarUsuario } from "./push";
import { textoDoAviso, type Computador, type StatusComputador } from "./formato";

const { dispositivoStatus, sessoes } = schema;

/** Computador com notícia nos últimos 2 min = ligado. */
export const ONLINE_MS = 2 * 60_000;
/** Depois disso sem notícia, o retrato é apagado (nomes de arquivos não ficam guardados à toa). */
export const GUARDA_MS = 7 * 24 * 60 * 60_000;
const LIMPEZA_GERAL_MS = 10 * 60_000;
let ultimaLimpezaGeral = 0;

async function limparVelhos(agora: number, usuarioId?: string) {
  const corte = new Date(agora - GUARDA_MS);
  await db
    .delete(dispositivoStatus)
    .where(usuarioId ? and(eq(dispositivoStatus.usuarioId, usuarioId), lt(dispositivoStatus.atualizadoEm, corte)) : lt(dispositivoStatus.atualizadoEm, corte));
}

/**
 * Grava o retrato do computador (sessão de dispositivo). Se ele acabou de virar "concluído" ou "erro" numa rodada
 * ainda não avisada, manda o aviso (uma vez por rodada e estado, mesmo com dois pedidos ao mesmo tempo).
 * Devolve quantos aparelhos receberam o aviso (0 = nenhum aviso).
 */
export async function gravarStatus(sessao: { id: string; nome: string | null }, usuarioId: string, snapshot: StatusComputador): Promise<{ avisados: number }> {
  const agora = Date.now();
  if (agora - ultimaLimpezaGeral > LIMPEZA_GERAL_MS) {
    ultimaLimpezaGeral = agora;
    await limparVelhos(agora).catch(() => {});
  }
  await db
    .insert(dispositivoStatus)
    .values({ sessaoId: sessao.id, usuarioId, snapshot, atualizadoEm: new Date(agora) })
    .onConflictDoUpdate({ target: dispositivoStatus.sessaoId, set: { snapshot, usuarioId, atualizadoEm: new Date(agora) } });

  const terminal = snapshot.estado === "concluido" || snapshot.estado === "erro";
  if (!terminal || !snapshot.rodada || snapshot.geral.total <= 0) return { avisados: 0 };
  const chave = `${snapshot.rodada}:${snapshot.estado}`.slice(0, 120);
  // Só quem consegue trocar o "avisado" manda o aviso: dois pedidos iguais juntos viram um aviso só.
  const marcado = await db
    .update(dispositivoStatus)
    .set({ avisado: chave })
    .where(and(eq(dispositivoStatus.sessaoId, sessao.id), isNullOrDifferent(chave)))
    .returning({ sessaoId: dispositivoStatus.sessaoId });
  if (!marcado.length) return { avisados: 0 };
  const nome = sessao.nome?.trim() || "computador";
  const texto = textoDoAviso(snapshot, nome);
  if (!texto) return { avisados: 0 };
  const avisados = await avisarUsuario(usuarioId, { ...texto, url: "/app/#computador", tag: `sd-${sessao.id}` });
  return { avisados };
}

/** avisado IS DISTINCT FROM chave (null conta como diferente). */
function isNullOrDifferent(chave: string) {
  return sql`${dispositivoStatus.avisado} is distinct from ${chave}`;
}

/** O computador pediu para parar de mostrar (ajuste desligado). */
export async function apagarStatus(sessaoId: string) {
  await db.delete(dispositivoStatus).where(eq(dispositivoStatus.sessaoId, sessaoId));
}

/** Sessões revogadas: o retrato delas some junto. */
export async function apagarStatusDeSessoes(ids: string[]) {
  if (ids.length) await db.delete(dispositivoStatus).where(inArray(dispositivoStatus.sessaoId, ids));
}

/** Computadores da conta com notícia nos últimos 7 dias (sessão ainda válida), os ligados primeiro. */
export async function listarComputadores(usuarioId: string, agora = Date.now()): Promise<Computador[]> {
  await limparVelhos(agora, usuarioId);
  const linhas = await db
    .select({
      id: dispositivoStatus.sessaoId,
      nome: sessoes.nome,
      plataforma: sessoes.plataforma,
      snapshot: dispositivoStatus.snapshot,
      atualizadoEm: dispositivoStatus.atualizadoEm,
    })
    .from(dispositivoStatus)
    .innerJoin(sessoes, eq(sessoes.id, dispositivoStatus.sessaoId))
    .where(
      and(
        eq(dispositivoStatus.usuarioId, usuarioId),
        eq(sessoes.usuarioId, usuarioId),
        eq(sessoes.tipo, "dispositivo"),
        isNull(sessoes.revogadaEm),
        gt(sessoes.expiraEm, new Date(agora)),
        gt(dispositivoStatus.atualizadoEm, new Date(agora - GUARDA_MS)),
      ),
    )
    .orderBy(desc(dispositivoStatus.atualizadoEm));
  const lista = linhas.map((l) => {
    const t = l.atualizadoEm.getTime();
    return { id: l.id, nome: l.nome?.trim() || "Computador", plataforma: l.plataforma, online: agora - t < ONLINE_MS && !l.snapshot.fechado, atualizadoEm: t, snapshot: l.snapshot };
  });
  return lista.sort((a, b) => Number(b.online) - Number(a.online) || b.atualizadoEm - a.atualizadoEm);
}
