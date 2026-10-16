/**
 * Onde está o banco.
 * - Produção: Postgres no Neon (São Paulo), ligado pela integração Neon da Vercel,
 *   que cria DATABASE_URL (com pooler) e POSTGRES_URL. Serve qualquer Postgres
 *   com pooler (Supabase: "Transaction pooler", porta 6543).
 * - Computador: PGlite (Postgres num arquivo) em ./data/pglite. Com `npm run dev`
 *   ele roda como servidor local (scripts/dev.mjs) e o site conecta por SOBEDESCE_LOCAL_DB_URL;
 *   os scripts de banco (migrate, seed) abrem o arquivo direto, com o site parado.
 * - Testes: SOBEDESCE_PGLITE_DIR=memory:// (ou um diretório temporário) troca o arquivo.
 * Sem "server-only" para os scripts e o drizzle.config poderem usar.
 */
export const LOCAL_DATABASE_DIR = process.env.SOBEDESCE_PGLITE_DIR || "./data/pglite";

/** "memory://" (testes): banco em memória, nada no disco. */
export const LOCAL_DATABASE_IN_MEMORY = LOCAL_DATABASE_DIR.startsWith("memory://");

const isPostgresUrl = (value: string | undefined) => !!value && /^postgres(ql)?:\/\//.test(value);

export function databaseConfig() {
  const env = process.env;
  const url = [env.DATABASE_URL, env.POSTGRES_URL].find(isPostgresUrl);
  if (url) return { url, local: false as const, server: true as const };
  const localServer = env.SOBEDESCE_LOCAL_DB_URL;
  if (localServer) return { url: localServer, local: true as const, server: true as const };
  return { url: `pglite:${LOCAL_DATABASE_DIR}`, local: true as const, server: false as const };
}

/**
 * Todos os bancos Postgres diferentes que o ambiente oferece, com os nomes das
 * variáveis (nunca as senhas). Mais de um = dois bancos ligados ao projeto,
 * e o site poderia ler um e gravar no outro de um deploy para o seguinte.
 * O mesmo banco por endereços diferentes (pooler e conexão direta) conta uma vez.
 */
export function databaseCandidates(env: NodeJS.ProcessEnv = process.env) {
  const byDatabase = new Map<string, string[]>();
  for (const key of ["DATABASE_URL", "POSTGRES_URL"]) {
    const value = env[key];
    if (!isPostgresUrl(value)) continue;
    const label = databaseLabel(value!);
    byDatabase.set(label, [...(byDatabase.get(label) ?? []), key]);
  }
  return [...byDatabase.entries()].map(([label, keys]) => ({ label, keys }));
}

/** Nome curto e seguro do banco, para mostrar na tela e no log (sem senha). */
export function databaseLabel(url: string) {
  if (url.startsWith("pglite:") || url.includes("@127.0.0.1:")) return "arquivo local (data/pglite)";
  try {
    const u = new URL(url);
    // Supabase: "db.<ref>.supabase.co" (direto) ou usuário "postgres.<ref>" no pooler.
    const ref = u.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1] ?? decodeURIComponent(u.username).match(/^postgres\.([a-z0-9]+)$/)?.[1];
    if (ref) return `${ref} (Supabase)`;
    // Neon: o mesmo banco aparece com e sem "-pooler" no endereço.
    const neon = u.hostname.match(/^(ep-[a-z0-9-]+?)(-pooler)?\.([a-z0-9-]+)\.aws\.neon\.tech$/);
    if (neon) return `${neon[1]} (Neon, ${neon[3]})`;
    return `${u.hostname}${u.pathname !== "/" ? u.pathname : ""}`;
  } catch {
    return "endereço inválido";
  }
}
