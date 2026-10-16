/**
 * OAuth 2.0 do Google, fluxo de servidor web com code + PKCE (S256) e state.
 * access_type=offline e prompt=consent: o Google sempre devolve refresh token.
 */
import { createHash, randomBytes } from "node:crypto";
import { credenciais, DRIVE_SCOPE, endpoints, ESCOPOS, redirectUri } from "./config";
import { deResposta, GoogleError } from "./erros";

export function pkce(): { verificador: string; desafio: string } {
  const verificador = randomBytes(32).toString("base64url");
  const desafio = createHash("sha256").update(verificador).digest("base64url");
  return { verificador, desafio };
}

export function urlDeConsentimento({ state, desafio, origem }: { state: string; desafio: string; origem?: string | null }): string {
  const { clientId } = credenciais();
  const u = new URL(endpoints().auth);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri(origem));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", ESCOPOS);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("code_challenge", desafio);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  return u.toString();
}

type RespostaToken = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };

async function postToken(campos: Record<string, string>): Promise<RespostaToken> {
  let res: Response;
  try {
    res = await fetch(endpoints().token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(campos).toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GoogleError("rede", 0, "token");
  }
  const json = (await res.json().catch(() => null)) as RespostaToken | null;
  if (!res.ok || !json?.access_token) throw deResposta(res.status, json);
  return json;
}

export type Tokens = { refresh: string | null; acesso: string; expiraEm: number; escopo: string };

/** Troca o código do consentimento. `refresh` null = o Google não mandou. */
export async function trocarCodigo(code: string, verificador: string, origem?: string | null): Promise<Tokens> {
  const { clientId, clientSecret } = credenciais();
  const j = await postToken({
    grant_type: "authorization_code",
    code,
    code_verifier: verificador,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri(origem),
  });
  return { refresh: j.refresh_token ?? null, acesso: j.access_token!, expiraEm: Date.now() + (j.expires_in ?? 3600) * 1000, escopo: j.scope ?? "" };
}

/** Novo access token. invalid_grant (revogado, 7 dias do modo Teste…) → GoogleError("reconectar"). */
export async function renovarAcesso(refresh: string): Promise<Tokens> {
  const { clientId, clientSecret } = credenciais();
  const j = await postToken({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId, client_secret: clientSecret });
  return { refresh: j.refresh_token ?? null, acesso: j.access_token!, expiraEm: Date.now() + (j.expires_in ?? 3600) * 1000, escopo: j.scope ?? "" };
}

/** Revoga a concessão (refresh e acessos). Nunca lança: remover continua. */
export async function revogar(token: string): Promise<void> {
  try {
    await fetch(endpoints().revoke, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // sem rede: a linha sai do banco do mesmo jeito
  }
}

export type PerfilGoogle = { sub: string; email: string; nome: string | null; fotoUrl: string | null; emailVerificado: boolean };

/** Quem é a conta (OpenID userinfo). */
export async function perfil(acesso: string): Promise<PerfilGoogle> {
  let res: Response;
  try {
    res = await fetch(endpoints().userinfo, { headers: { Authorization: `Bearer ${acesso}` }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new GoogleError("rede", 0, "userinfo");
  }
  const j = (await res.json().catch(() => null)) as { sub?: unknown; email?: unknown; email_verified?: unknown; name?: unknown; picture?: unknown } | null;
  if (!res.ok || !j || typeof j.sub !== "string" || !j.sub || typeof j.email !== "string") throw new GoogleError("google", res.status, "userinfo");
  const foto = typeof j.picture === "string" && /^https:\/\//.test(j.picture) ? j.picture : null;
  return { sub: j.sub, email: j.email.toLowerCase(), nome: typeof j.name === "string" ? j.name : null, fotoUrl: foto, emailVerificado: j.email_verified === true };
}

/** O escopo devolvido tem o Drive completo? (igualdade exata, nunca substring) */
export function escopoTemDrive(escopo: string): boolean {
  return escopo.split(/\s+/).includes(DRIVE_SCOPE);
}
