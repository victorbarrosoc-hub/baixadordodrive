import { NextResponse, type NextRequest } from "next/server";
import { ehPlataforma, enderecoDoArquivo, instalador } from "@/lib/release";

/**
 * /baixar/mac e /baixar/windows: o instalador mais recente do Release de teste do GitHub (src/lib/release.ts).
 * O visitante baixa direto do GitHub (nada passa pela Vercel).
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/baixar/[plataforma]">) {
  const { plataforma } = await ctx.params;
  const voltar = new URL("/?baixar=indisponivel#baixar", req.url);
  if (!ehPlataforma(plataforma)) return NextResponse.redirect(new URL("/#baixar", req.url));
  try {
    const asset = await instalador(plataforma);
    if (!asset) return NextResponse.redirect(voltar);
    const destino = await enderecoDoArquivo(asset);
    if (!destino) return NextResponse.redirect(voltar);
    const r = NextResponse.redirect(destino);
    r.headers.set("cache-control", "no-store");
    return r;
  } catch (e) {
    console.error("[baixar]", plataforma, e instanceof Error ? e.message : "erro");
    return NextResponse.redirect(voltar);
  }
}
