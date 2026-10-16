/**
 * Ambiente dos testes das contas: PGlite em memória (cada arquivo de teste roda num processo),
 * Google falso, variáveis de teste e as migrações do repositório. Nada toca em data/pglite
 * nem no Google de verdade.
 *
 * Use `prepararAmbiente()` ANTES de importar qualquer módulo de src/ (o banco lê o ambiente no import).
 */
import { randomBytes } from "node:crypto";
import { iniciarGoogleFalso, type ContaFalsa } from "./google-falso.mjs";
import { iniciarResendFalso } from "./resend-falso.mjs";

export const SITE = "http://localhost:3000";
export const CHAVE_RESEND = "re_teste_123";
export const CLIENTE = { clientId: "sobedesce-teste.apps.googleusercontent.com", clientSecret: "GOCSPX-sobedesce-teste" };

export const CONTA_ANA: ContaFalsa = { sub: "111", email: "ana@exemplo.com", name: "Ana Montadora", picture: "https://lh3.googleusercontent.com/a/ana" };
export const CONTA_BETO: ContaFalsa = { sub: "222", email: "beto@exemplo.com", name: "Beto Cor" };

export async function prepararAmbiente() {
  const google = await iniciarGoogleFalso(CLIENTE);
  const resend = await iniciarResendFalso(CHAVE_RESEND);
  for (const k of ["DATABASE_URL", "POSTGRES_URL", "VERCEL", "SOBEDESCE_LOCAL_DB_URL"]) delete process.env[k];
  Object.assign(process.env, {
    SOBEDESCE_PGLITE_DIR: "memory://",
    NEXT_PUBLIC_SITE_URL: SITE,
    GOOGLE_CLIENT_ID: CLIENTE.clientId,
    GOOGLE_CLIENT_SECRET: CLIENTE.clientSecret,
    SOBEDESCE_GOOGLE_BASE: google.url,
    SOBEDESCE_KEY: randomBytes(32).toString("base64"),
    RESEND_API_KEY: CHAVE_RESEND,
    SOBEDESCE_RESEND_BASE: resend.url,
    EMAIL_REMETENTE: "SOBEDESCE <nao-responda@exemplo.com>",
  });
  const banco = await import("../src/lib/db/client");
  await banco.runMigrations();
  return {
    google,
    resend,
    banco,
    async fechar() {
      await google.fechar();
      await resend.fechar();
      await banco.closeDatabase();
    },
  };
}

/** Cookies de uma resposta (Set-Cookie) como mapa nome → valor (vazio = apagado). */
export function cookiesDe(res: Response): Map<string, string> {
  const m = new Map<string, string>();
  for (const linha of res.headers.getSetCookie()) {
    const [par] = linha.split(";");
    const i = par.indexOf("=");
    m.set(par.slice(0, i).trim(), decodeURIComponent(par.slice(i + 1).trim()));
  }
  return m;
}

export type Pedido = {
  method?: string;
  corpo?: unknown;
  cookies?: Record<string, string | undefined>;
  bearer?: string;
  origin?: string | null;
  ip?: string;
};

/** Request para chamar uma rota direto (sem servidor). Origin do próprio site por padrão nos POST. */
export function pedido(caminho: string, p: Pedido = {}): Request {
  const method = p.method ?? (p.corpo !== undefined ? "POST" : "GET");
  const headers = new Headers({ host: "localhost:3000" });
  const cookies = Object.entries(p.cookies ?? {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`);
  if (cookies.length) headers.set("cookie", cookies.join("; "));
  if (p.bearer) headers.set("authorization", `Bearer ${p.bearer}`);
  const origin = p.origin === undefined ? (method === "GET" ? null : SITE) : p.origin;
  if (origin) headers.set("origin", origin);
  if (p.ip) headers.set("x-real-ip", p.ip);
  let body: string | undefined;
  if (p.corpo !== undefined) {
    headers.set("content-type", "application/json");
    body = typeof p.corpo === "string" ? p.corpo : JSON.stringify(p.corpo);
  }
  return new Request(new URL(caminho, SITE), { method, headers, body });
}
