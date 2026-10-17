/**
 * Fluxo de dispositivo (app de computador, docs/CONTAS.md §5 e §7):
 * o computador pede um código → a pessoa libera em /dispositivo → o computador busca o token (uma vez).
 * O banco guarda só o sha256 do segredo; o código curto só serve para a tela de liberar.
 */
import { randomInt } from "node:crypto";
import { and, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Plataforma } from "@/lib/db/schema";
import { criarSessao, type UsuarioPublico } from "@/lib/auth/sessao";
import { hashToken, novoId, novoToken } from "@/lib/auth/tokens";
import type { Lugar } from "@/lib/http";
import { siteUrl } from "@/lib/site";

const { codigosDispositivo, usuarios } = schema;

export const VALIDADE_CODIGO_MS = 10 * 60_000;
export const INTERVALO_S = 3;
/** Consultas mais rápidas que isso recebem 429 (o computador deve esperar `intervalo`). */
const RITMO_MINIMO_MS = 2_000;

/** Sem vogais (não forma palavras) e sem letras parecidas com números. */
const ALFABETO = "BCDFGHJKLMNPQRSTVWXZ";
export const FORMATO_CODIGO = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

export function novoCodigo(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALFABETO[randomInt(ALFABETO.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Aceita "abcd efgh", "ABCDEFGH" etc. Devolve null se não tiver cara de código. */
export function normalizarCodigo(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpo = valor.toUpperCase().replace(/[^A-Z]/g, "");
  if (limpo.length !== 8) return null;
  const c = `${limpo.slice(0, 4)}-${limpo.slice(4)}`;
  return FORMATO_CODIGO.test(c) ? c : null;
}

const PLATAFORMAS: Plataforma[] = ["mac", "windows", "linux"];

export function plataformaValida(valor: unknown): Plataforma | null {
  return typeof valor === "string" && (PLATAFORMAS as string[]).includes(valor) ? (valor as Plataforma) : null;
}

export function nomeDoComputador(valor: unknown): string {
  const nome = typeof valor === "string" ? valor.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) : "";
  return nome || "Computador";
}

export async function iniciar(entrada: { nome: unknown; plataforma: unknown; lugar?: Lugar }) {
  const segredo = novoToken();
  const expiraEm = new Date(Date.now() + VALIDADE_CODIGO_MS);
  const nome = nomeDoComputador(entrada.nome);
  const plataforma = plataformaValida(entrada.plataforma);
  // Colisão de código é rara (20^8); tenta de novo algumas vezes.
  for (let i = 0; i < 5; i++) {
    const codigo = novoCodigo();
    const r = await db
      .insert(codigosDispositivo)
      .values({
        id: novoId(),
        codigo,
        segredoHash: hashToken(segredo),
        nome,
        plataforma,
        expiraEm,
        pedidoIp: entrada.lugar?.ip ?? null,
        pedidoCidade: entrada.lugar?.cidade ?? null,
        pedidoPais: entrada.lugar?.pais ?? null,
      })
      .onConflictDoNothing({ target: codigosDispositivo.codigo })
      .returning({ id: codigosDispositivo.id });
    if (r.length) {
      await limparVencidos();
      return { codigo, segredo, url: `${siteUrl()}/dispositivo?codigo=${codigo}`, intervalo: INTERVALO_S, expiraEm: expiraEm.getTime() };
    }
  }
  throw new Error("Não deu para gerar um código livre.");
}

async function limparVencidos() {
  await db.delete(codigosDispositivo).where(lt(codigosDispositivo.expiraEm, new Date(Date.now() - 24 * 60 * 60_000)));
}

export type ResultadoAguardar =
  | { estado: "pendente" }
  | { estado: "pronto"; token: string; usuario: UsuarioPublico }
  | { estado: "expirado" }
  | { estado: "devagar" };

/**
 * Consulta do computador. O token sai uma vez só: quem marca `usadoEm` primeiro leva.
 * Código usado, cancelado, vencido ou segredo desconhecido: "expirado".
 */
export async function aguardar(segredo: unknown): Promise<ResultadoAguardar> {
  if (typeof segredo !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(segredo)) return { estado: "expirado" };
  const agora = new Date();
  const hash = hashToken(segredo);
  // Marca a consulta só se a anterior tem mais de 2 s (atômico: duas consultas juntas, uma leva 429).
  const consultado = await db
    .update(codigosDispositivo)
    .set({ consultadoEm: agora })
    .where(
      and(
        eq(codigosDispositivo.segredoHash, hash),
        or(isNull(codigosDispositivo.consultadoEm), lt(codigosDispositivo.consultadoEm, new Date(agora.getTime() - RITMO_MINIMO_MS))),
      ),
    )
    .returning({ id: codigosDispositivo.id, usadoEm: codigosDispositivo.usadoEm, expiraEm: codigosDispositivo.expiraEm, usuarioId: codigosDispositivo.usuarioId });
  if (consultado.length === 0) {
    const existe = await db.query.codigosDispositivo.findFirst({ where: eq(codigosDispositivo.segredoHash, hash), columns: { id: true, usadoEm: true, expiraEm: true } });
    if (!existe || existe.usadoEm || existe.expiraEm <= agora) return { estado: "expirado" };
    return { estado: "devagar" };
  }
  const c = consultado[0];
  if (c.usadoEm || c.expiraEm <= agora) return { estado: "expirado" };
  if (!c.usuarioId) return { estado: "pendente" };

  const levado = await db
    .update(codigosDispositivo)
    // De onde veio o pedido só servia para a tela de liberar: sai junto.
    .set({ usadoEm: agora, pedidoIp: null, pedidoCidade: null, pedidoPais: null })
    .where(and(eq(codigosDispositivo.id, c.id), isNull(codigosDispositivo.usadoEm), isNotNull(codigosDispositivo.usuarioId), gt(codigosDispositivo.expiraEm, agora)))
    .returning({ usuarioId: codigosDispositivo.usuarioId, nome: codigosDispositivo.nome, plataforma: codigosDispositivo.plataforma });
  if (levado.length === 0 || !levado[0].usuarioId) return { estado: "expirado" };
  const { usuarioId, nome, plataforma } = levado[0];
  const usuario = await db.query.usuarios.findFirst({ where: eq(usuarios.id, usuarioId), columns: { id: true, email: true, nome: true } });
  if (!usuario) return { estado: "expirado" };
  const sessao = await criarSessao(usuario.id, "dispositivo", { nome, plataforma });
  return { estado: "pronto", token: sessao.token, usuario };
}

export type PedidoDispositivo = {
  codigo: string;
  nome: string;
  plataforma: Plataforma | null;
  expiraEm: Date;
  aprovado: boolean;
  /** Quando e de onde o computador pediu (revisão A6: quem libera vê se o pedido é dele mesmo). */
  criadoEm: Date;
  lugar: Lugar;
};

/** Pedido ainda aberto (não usado, não vencido), para a tela de liberar. */
export async function buscarPedido(codigo: string): Promise<PedidoDispositivo | null> {
  const c = await db.query.codigosDispositivo.findFirst({ where: eq(codigosDispositivo.codigo, codigo) });
  if (!c || c.usadoEm || c.expiraEm <= new Date()) return null;
  return {
    codigo: c.codigo,
    nome: c.nome,
    plataforma: c.plataforma,
    expiraEm: c.expiraEm,
    aprovado: Boolean(c.usuarioId),
    criadoEm: c.criadoEm,
    lugar: { ip: c.pedidoIp, cidade: c.pedidoCidade, pais: c.pedidoPais },
  };
}

const NOMES_PAIS = (() => {
  try {
    return new Intl.DisplayNames(["pt-BR"], { type: "region" });
  } catch {
    return null;
  }
})();

/** "Natal, Brasil", "Brasil", ou null quando não se sabe. */
export function lugarLegivel(l: Pick<Lugar, "cidade" | "pais">): string | null {
  let pais: string | null = null;
  if (l.pais) {
    try {
      pais = NOMES_PAIS?.of(l.pais) ?? l.pais;
    } catch {
      pais = l.pais;
    }
  }
  const partes = [l.cidade, pais].filter(Boolean);
  return partes.length ? partes.join(", ") : null;
}

/** IPs iguais (o mesmo endereço de rede de quem está liberando)? */
export function mesmaRede(a: string | null, b: string | null): boolean {
  return Boolean(a && b && a === b);
}

/** Libera o computador para a conta. Só pedido aberto e ainda não liberado. */
export async function aprovar(codigo: string, usuarioId: string): Promise<boolean> {
  const agora = new Date();
  const r = await db
    .update(codigosDispositivo)
    .set({ usuarioId, aprovadoEm: agora })
    .where(and(eq(codigosDispositivo.codigo, codigo), isNull(codigosDispositivo.usuarioId), isNull(codigosDispositivo.usadoEm), gt(codigosDispositivo.expiraEm, agora)))
    .returning({ id: codigosDispositivo.id });
  return r.length > 0;
}

/** "Não fui eu": o código vence agora. */
export async function cancelar(codigo: string): Promise<void> {
  await db
    .update(codigosDispositivo)
    .set({ expiraEm: sql`now()`, pedidoIp: null, pedidoCidade: null, pedidoPais: null })
    .where(and(eq(codigosDispositivo.codigo, codigo), isNull(codigosDispositivo.usadoEm), isNull(codigosDispositivo.usuarioId)));
}
