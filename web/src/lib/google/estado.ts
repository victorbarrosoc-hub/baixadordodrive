/**
 * Cookie do "Conectar Google" / "Entrar com Google": state + verificador PKCE + modo + volta,
 * cifrado e autenticado (cripto.ts), só em /api/google, 10 minutos.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { abrirCookie, selarCookie } from "./cripto";

export const COOKIE_OAUTH = "sd_google";
export const DURACAO_OAUTH_S = 600;
const CONTEXTO = "cookie:sd_google";

export type ModoGoogle = "vincular" | "entrar";
export type EstadoOAuth = { state: string; verificador: string; modo: ModoGoogle; usuarioId: string | null; volta: string; expira: number };

export function novoState(): string {
  return randomBytes(32).toString("base64url");
}

export function selarEstado(e: Omit<EstadoOAuth, "expira">): string {
  const dados: EstadoOAuth = { ...e, expira: Date.now() + DURACAO_OAUTH_S * 1000 };
  return selarCookie(JSON.stringify(dados), CONTEXTO);
}

/** Cookie válido e dentro dos 10 minutos, ou null. */
export function abrirEstado(valor: string | undefined): EstadoOAuth | null {
  if (!valor) return null;
  try {
    const e = JSON.parse(abrirCookie(valor, CONTEXTO)) as EstadoOAuth;
    if (typeof e.state !== "string" || typeof e.verificador !== "string" || typeof e.volta !== "string") return null;
    if (e.modo !== "vincular" && e.modo !== "entrar") return null;
    if (typeof e.expira !== "number" || e.expira < Date.now()) return null;
    return e;
  } catch {
    return null;
  }
}

/** Compara o state em tempo constante. */
export function stateConfere(recebido: string | null, esperado: string): boolean {
  const a = Buffer.from(recebido ?? "");
  const b = Buffer.from(esperado);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
