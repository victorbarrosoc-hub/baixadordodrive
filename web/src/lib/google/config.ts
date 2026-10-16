/**
 * Cliente OAuth "Aplicativo da Web" da SOBEDESCE (docs/CONTAS.md §2).
 * Nada aqui lança no import: sem as variáveis, a tela de conta avisa e o resto abre normal.
 */
import { origemDoSite } from "@/lib/site";
import { GoogleError } from "./erros";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
export const ESCOPOS = ["openid", "email", "profile", DRIVE_SCOPE].join(" ");

/**
 * Endereço de retorno cadastrado no Google Cloud. Um por endereço do site (sobedesce.com e o antigo .vercel.app):
 * o Google volta para o mesmo endereço onde o login começou, onde está o cookie do state.
 */
export function redirectUri(origem?: string | null): string {
  return `${origemDoSite(origem)}/api/google/callback`;
}

/** Id e segredo do cliente. Sem eles: GoogleError("sem_config"). */
export function credenciais(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new GoogleError("sem_config", 0, "Faltam GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET.");
  return { clientId, clientSecret };
}

export function googleConfigurado(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim());
}

/**
 * Google falso (SOBEDESCE_GOOGLE_BASE), só em teste local: nunca na Vercel nem em produção,
 * porque o segredo do cliente e os tokens iriam para essa base. E só em 127.0.0.1/localhost.
 */
export function baseDeTeste(): string | null {
  const base = process.env.SOBEDESCE_GOOGLE_BASE;
  if (!base || process.env.VERCEL || process.env.NODE_ENV === "production") return null;
  try {
    const u = new URL(base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Endpoints (função, não constante: os testes trocam o ambiente). */
export function endpoints() {
  const base = baseDeTeste();
  if (base) {
    return {
      auth: `${base}/o/oauth2/v2/auth`,
      token: `${base}/token`,
      revoke: `${base}/revoke`,
      userinfo: `${base}/v1/userinfo`,
      drive: `${base}/drive/v3`,
    };
  }
  return {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    revoke: "https://oauth2.googleapis.com/revoke",
    userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
    drive: "https://www.googleapis.com/drive/v3",
  };
}
