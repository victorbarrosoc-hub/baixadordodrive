import { NextResponse, type NextRequest } from "next/server";

/**
 * /baixar/mac e /baixar/windows: o instalador mais recente do Release de teste do GitHub.
 * Repositório privado: com GITHUB_TOKEN (só leitura de conteúdo), o GitHub devolve um endereço
 * assinado e temporário do arquivo, e o visitante baixa direto de lá (nada passa pela Vercel).
 * Repositório público: funciona sem token, pelo link normal do arquivo.
 */

const REPO = "victorbarrosoc-hub/baixadordodrive";
const TAG = "versao-de-teste";
const ARQUIVO: Record<string, (nome: string) => boolean> = {
  mac: (n) => n.endsWith(".dmg"),
  windows: (n) => n.endsWith("-windows-setup.exe"),
};

type Asset = { id: number; name: string; url: string; browser_download_url: string };

let cache: { em: number; assets: Asset[] } | null = null;

async function assets(token: string | undefined): Promise<Asset[]> {
  if (cache && Date.now() - cache.em < 5 * 60_000) return cache.assets;
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, {
    headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`release ${res.status}`);
  const j = (await res.json()) as { assets?: Asset[] };
  cache = { em: Date.now(), assets: j.assets ?? [] };
  return cache.assets;
}

export async function GET(req: NextRequest, ctx: RouteContext<"/baixar/[plataforma]">) {
  const { plataforma } = await ctx.params;
  const casa = ARQUIVO[plataforma];
  const voltar = new URL("/?baixar=indisponivel#baixar", req.url);
  if (!casa) return NextResponse.redirect(new URL("/#baixar", req.url));
  const token = process.env.GITHUB_TOKEN || undefined;
  try {
    const asset = (await assets(token)).find((a) => casa(a.name));
    if (!asset) return NextResponse.redirect(voltar);
    if (!token) return NextResponse.redirect(asset.browser_download_url);
    // Com token: o GitHub responde 302 para um endereço assinado de poucos minutos.
    const res = await fetch(asset.url, {
      headers: { accept: "application/octet-stream", authorization: `Bearer ${token}` },
      redirect: "manual",
      cache: "no-store",
    });
    const destino = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    if (!destino) return NextResponse.redirect(voltar);
    const r = NextResponse.redirect(destino);
    r.headers.set("cache-control", "no-store");
    return r;
  } catch (e) {
    console.error("[baixar]", plataforma, e instanceof Error ? e.message : "erro");
    return NextResponse.redirect(voltar);
  }
}
