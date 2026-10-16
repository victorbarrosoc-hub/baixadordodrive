/**
 * Release de teste do GitHub ("versao-de-teste"): os instaladores do app de desktop e o versao.json,
 * que o GitHub Actions sobe por último, depois dos dois instaladores (scripts/build-info.mjs na raiz do repositório).
 *
 * Usado por /baixar/[plataforma] (redireciona para o instalador) e /baixar/versao (o aviso de versão nova do app).
 * Repositório privado: com GITHUB_TOKEN (só leitura de conteúdo), o GitHub devolve um endereço assinado e temporário
 * do arquivo. Repositório público: funciona sem token, pelo link normal do arquivo.
 */

const REPO = "victorbarrosoc-hub/baixadordodrive";
const TAG = "versao-de-teste";
const CACHE_MS = 5 * 60_000;

export type Asset = { id: number; name: string; url: string; browser_download_url: string };
export type Versao = { build: number; commit: string; data: string };

export const PLATAFORMAS = {
  mac: (n: string) => n.endsWith(".dmg"),
  windows: (n: string) => n.endsWith("-windows-setup.exe"),
} as const satisfies Record<string, (nome: string) => boolean>;
export type Plataforma = keyof typeof PLATAFORMAS;

export function ehPlataforma(v: string): v is Plataforma {
  return Object.hasOwn(PLATAFORMAS, v);
}

/**
 * API do GitHub. SOBEDESCE_GITHUB_API troca por um GitHub falso, só em teste local
 * (nunca na Vercel nem em produção, porque o GITHUB_TOKEN iria para essa base) e só em 127.0.0.1/localhost.
 */
function apiBase(): string {
  const base = process.env.SOBEDESCE_GITHUB_API;
  if (base && !process.env.VERCEL && process.env.NODE_ENV !== "production") {
    try {
      const u = new URL(base);
      if ((u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return u.origin;
    } catch {
      // inválido: usa o GitHub
    }
  }
  return "https://api.github.com";
}

function token(): string | undefined {
  return process.env.GITHUB_TOKEN || undefined;
}

let cacheAssets: { em: number; base: string; assets: Asset[] } | null = null;
let cacheVersao: { em: number; base: string; versao: Versao } | null = null;

/** Esquece o que estava guardado (testes; e depois de uma falha, para a próxima tentativa ir ao GitHub). */
export function esquecerCache() {
  cacheAssets = null;
  cacheVersao = null;
}

/** Arquivos do Release de teste (guardados por 5 min). */
export async function assetsDoRelease(): Promise<Asset[]> {
  const base = apiBase();
  if (cacheAssets && cacheAssets.base === base && Date.now() - cacheAssets.em < CACHE_MS) return cacheAssets.assets;
  const t = token();
  const res = await fetch(`${base}/repos/${REPO}/releases/tags/${TAG}`, {
    headers: { accept: "application/vnd.github+json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`release ${res.status}`);
  const j = (await res.json()) as { assets?: Asset[] };
  cacheAssets = { em: Date.now(), base, assets: Array.isArray(j.assets) ? j.assets : [] };
  return cacheAssets.assets;
}

/**
 * Endereço para baixar o arquivo: o link normal (sem token) ou o endereço assinado que o GitHub devolve com token.
 * null = o GitHub não deu um endereço.
 */
export async function enderecoDoArquivo(asset: Asset): Promise<string | null> {
  const t = token();
  if (!t) return asset.browser_download_url;
  // Com token: o GitHub responde 302 para um endereço assinado de poucos minutos.
  const res = await fetch(asset.url, {
    headers: { accept: "application/octet-stream", authorization: `Bearer ${t}` },
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const destino = res.headers.get("location");
  await res.body?.cancel().catch(() => {});
  return destino;
}

/** O instalador mais recente da plataforma (null = ainda não tem). */
export async function instalador(plataforma: Plataforma): Promise<Asset | null> {
  return (await assetsDoRelease()).find((a) => PLATAFORMAS[plataforma](a.name)) ?? null;
}

/** Confere o versao.json: build inteiro positivo, commit em hexadecimal, data ISO. */
export function lerVersao(bruto: unknown): Versao | null {
  if (!bruto || typeof bruto !== "object") return null;
  const v = bruto as Record<string, unknown>;
  const build = v.build;
  if (typeof build !== "number" || !Number.isSafeInteger(build) || build <= 0) return null;
  const commit = typeof v.commit === "string" && /^[0-9a-f]{7,40}$/i.test(v.commit) ? v.commit.slice(0, 12).toLowerCase() : null;
  const ms = typeof v.data === "string" ? Date.parse(v.data) : NaN;
  if (!commit || !Number.isFinite(ms)) return null;
  return { build, commit, data: new Date(ms).toISOString() };
}

/** O build mais novo publicado (versao.json do Release de teste, guardado por 5 min). Lança se não der. */
export async function versaoPublicada(): Promise<Versao> {
  const base = apiBase();
  if (cacheVersao && cacheVersao.base === base && Date.now() - cacheVersao.em < CACHE_MS) return cacheVersao.versao;
  try {
    const asset = (await assetsDoRelease()).find((a) => a.name === "versao.json");
    if (!asset) throw new Error("sem versao.json no release");
    const url = await enderecoDoArquivo(asset);
    if (!url) throw new Error("sem endereço do versao.json");
    const res = await fetch(url, { headers: { accept: "application/json, application/octet-stream" }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`versao.json ${res.status}`);
    const texto = await res.text();
    if (texto.length > 4096) throw new Error("versao.json grande demais");
    const versao = lerVersao(JSON.parse(texto));
    if (!versao) throw new Error("versao.json inválido");
    cacheVersao = { em: Date.now(), base, versao };
    return versao;
  } catch (e) {
    // O versao.json é trocado a cada build (id novo): a lista guardada pode apontar para o arquivo antigo.
    cacheAssets = null;
    throw e;
  }
}
