/**
 * Web Push (VAPID) para "Avisar no celular quando terminar" (docs/CONTAS.md §9).
 * A chave pública fica no código (o celular precisa dela para se inscrever); a privada só no ambiente
 * (`VAPID_PRIVATE_KEY`). Sem a privada, os avisos ficam desligados e o resto funciona.
 */
import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import webpush from "web-push";
import { db, schema } from "@/lib/db";
import { novoId } from "@/lib/auth/tokens";
import { siteUrl } from "@/lib/site";

const { pushInscricoes } = schema;

/** Chave pública VAPID (par da VAPID_PRIVATE_KEY da Vercel). `VAPID_PUBLIC_KEY` troca, se um dia a chave mudar. */
export const CHAVE_PUBLICA_PADRAO = "BOIGN5MrFr3aYLXsBOt1CogskiIHwkc5ylFqEcADC5g7SZxbsnOmT5kLQuy7OqoJuNHi5BlorabHVpuydq-tTps";

export const MAX_INSCRICOES = 20;
const MAX_FALHAS = 10;

export function chavePublica(): string {
  return process.env.VAPID_PUBLIC_KEY?.trim() || CHAVE_PUBLICA_PADRAO;
}

export function pushAtivo(): boolean {
  return Boolean(process.env.VAPID_PRIVATE_KEY?.trim()) || enviadorDeTeste != null;
}

/**
 * Só serviços de push conhecidos: o servidor faz um POST para esse endereço, então nada de endereço qualquer
 * (rede interna, outro site).
 */
const HOSTS_PUSH = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];

export function endpointValido(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 1024) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && HOSTS_PUSH.some((r) => r.test(u.hostname));
  } catch {
    return false;
  }
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
export function chavesValidas(v: unknown): v is { p256dh: string; auth: string } {
  if (!v || typeof v !== "object") return false;
  const k = v as Record<string, unknown>;
  return typeof k.p256dh === "string" && typeof k.auth === "string" && k.p256dh.length >= 40 && k.p256dh.length <= 200 && k.auth.length >= 8 && k.auth.length <= 64 && B64URL.test(k.p256dh) && B64URL.test(k.auth);
}

/** Guarda (ou move para esta conta) a inscrição do aparelho. Guarda no máximo MAX_INSCRICOES por conta. */
export async function inscrever(usuarioId: string, endpoint: string, keys: { p256dh: string; auth: string }) {
  await db
    .insert(pushInscricoes)
    .values({ id: novoId(), usuarioId, endpoint, keys })
    .onConflictDoUpdate({ target: pushInscricoes.endpoint, set: { usuarioId, keys, falhas: 0, criadoEm: new Date() } });
  const todas = await db
    .select({ id: pushInscricoes.id })
    .from(pushInscricoes)
    .where(eq(pushInscricoes.usuarioId, usuarioId))
    .orderBy(asc(pushInscricoes.criadoEm));
  const sobra = todas.slice(0, Math.max(0, todas.length - MAX_INSCRICOES)).map((r) => r.id);
  if (sobra.length) await db.delete(pushInscricoes).where(inArray(pushInscricoes.id, sobra));
}

export async function desinscrever(usuarioId: string, endpoint: string): Promise<boolean> {
  const r = await db
    .delete(pushInscricoes)
    .where(and(eq(pushInscricoes.usuarioId, usuarioId), eq(pushInscricoes.endpoint, endpoint)))
    .returning({ id: pushInscricoes.id });
  return r.length > 0;
}

export type Aviso = { titulo: string; corpo: string; url: string; tag: string };
export type ResultadoEnvio = { status: number };
export type Enviador = (inscricao: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<ResultadoEnvio>;

let enviadorDeTeste: Enviador | null = null;

/** Só testes: troca o envio de verdade por uma função (sem rede e sem VAPID). null volta ao normal. */
export function definirEnviador(fn: Enviador | null) {
  enviadorDeTeste = fn;
}

const enviadorPadrao: Enviador = async (inscricao, payload) => {
  const privada = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!privada) return { status: 0 };
  try {
    const r = await webpush.sendNotification(inscricao, payload, {
      TTL: 12 * 60 * 60,
      urgency: "high",
      timeout: 8000,
      vapidDetails: { subject: process.env.VAPID_SUBJECT?.trim() || siteUrl(), publicKey: chavePublica(), privateKey: privada },
    });
    return { status: r.statusCode };
  } catch (e) {
    const status = (e as { statusCode?: unknown })?.statusCode;
    return { status: typeof status === "number" ? status : 0 };
  }
};

/**
 * Manda o aviso para todos os aparelhos inscritos da conta. 404/410 (inscrição que não existe mais) → apaga.
 * Outras falhas contam; muitas seguidas também apagam. Devolve quantos aparelhos aceitaram.
 */
export async function avisarUsuario(usuarioId: string, aviso: Aviso): Promise<number> {
  if (!pushAtivo()) return 0;
  const enviar = enviadorDeTeste ?? enviadorPadrao;
  const lista = await db.select().from(pushInscricoes).where(eq(pushInscricoes.usuarioId, usuarioId));
  const payload = JSON.stringify(aviso);
  let ok = 0;
  await Promise.all(
    lista.map(async (i) => {
      const r = await enviar({ endpoint: i.endpoint, keys: i.keys }, payload).catch(() => ({ status: 0 }));
      if (r.status >= 200 && r.status < 300) {
        ok++;
        await db.update(pushInscricoes).set({ ultimoEnvioEm: new Date(), falhas: 0 }).where(eq(pushInscricoes.id, i.id));
      } else if (r.status === 404 || r.status === 410) {
        await db.delete(pushInscricoes).where(eq(pushInscricoes.id, i.id));
      } else {
        const [n] = await db
          .update(pushInscricoes)
          .set({ falhas: sql`${pushInscricoes.falhas} + 1` })
          .where(eq(pushInscricoes.id, i.id))
          .returning({ falhas: pushInscricoes.falhas });
        if (n && n.falhas >= MAX_FALHAS) await db.delete(pushInscricoes).where(eq(pushInscricoes.id, i.id));
      }
    }),
  );
  return ok;
}
