import { NextResponse, type NextRequest } from "next/server";
import { ehPlataforma, enderecoDoArquivo, esquecerCache, instalador } from "@/lib/release";

/**
 * /baixar/mac e /baixar/windows: o instalador mais recente do Release de teste do GitHub (src/lib/release.ts).
 * O visitante baixa direto do GitHub (nada passa pela Vercel).
 * `?build=N` (o app no "Atualizar" e os instaladores de uma linha): o instalador exatamente daquele build, o mesmo do
 * SHA-256 que eles conferem. Build que já saiu do Release → 404 (eles perguntam a versão de novo).
 */
export async function GET(req: NextRequest, ctx: RouteContext<"/baixar/[plataforma]">) {
  const { plataforma } = await ctx.params;
  const voltar = new URL("/?baixar=indisponivel#baixar", req.url);
  if (!ehPlataforma(plataforma)) return NextResponse.redirect(new URL("/#baixar", req.url));
  try {
    const pedido = new URL(req.url).searchParams.get("build");
    const build = pedido && /^\d{1,9}$/.test(pedido) ? Number(pedido) : null;
    // O app e os instaladores de uma linha (?build=N) conferem o SHA-256: nunca recebem a página do site no lugar do
    // arquivo. Recebem 404 e perguntam a versão de novo.
    const sumiu = () => (build != null ? new NextResponse("Instalador deste build não está mais no ar.", { status: 404, headers: { "cache-control": "no-store" } }) : NextResponse.redirect(voltar));
    let asset = await instalador(plataforma, build);
    if (!asset) return sumiu();
    let destino = await enderecoDoArquivo(asset);
    if (!destino) {
      // A lista guardada pode ter o id de um arquivo que o Release já trocou: relê uma vez.
      esquecerCache();
      asset = await instalador(plataforma, build);
      destino = asset ? await enderecoDoArquivo(asset) : null;
    }
    if (!destino) return sumiu();
    const r = NextResponse.redirect(destino);
    r.headers.set("cache-control", "no-store");
    return r;
  } catch (e) {
    console.error("[baixar]", plataforma, e instanceof Error ? e.message : "erro");
    return NextResponse.redirect(voltar);
  }
}
