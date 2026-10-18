import { esquecerCache, versaoPublicada } from "@/lib/release";

/**
 * /baixar/versao: o build mais novo do app de desktop, para o aviso "Nova versão do SOBEDESCE" (src/version.js na raiz).
 * Lê o versao.json do Release de teste, que o GitHub Actions só sobe depois dos dois instaladores.
 * Segmento fixo: vence /baixar/[plataforma]. Qualquer falha → 503 { ok: false } (o app fica quieto e tenta depois).
 *
 * `mac`/`windows` continuam textos (os links de download), como os apps antigos esperam. O SHA-256 de cada instalador
 * vem em `sha256Mac`/`sha256Windows` (null se o versao.json ainda não tiver): o "Atualizar" do app e os instaladores
 * de uma linha (/instalar.sh e /instalar.ps1) só instalam se o download bater com ele.
 */

// Responde a cada pedido (o versao.json muda a cada build); quem segura é o cache de 5 min de src/lib/release.ts e o da CDN.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const v = await versaoPublicada();
    return Response.json(
      {
        ok: true,
        build: v.build,
        commit: v.commit,
        data: v.data,
        mac: "/baixar/mac",
        windows: "/baixar/windows",
        sha256Mac: v.sha256Mac,
        sha256Windows: v.sha256Windows,
        // Nome do instalador deste build (para conferir; o download continua por /baixar/<plataforma>?build=N).
        arquivoMac: v.arquivoMac,
        arquivoWindows: v.arquivoWindows,
      },
      { headers: { "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=60" } },
    );
  } catch (e) {
    esquecerCache();
    console.error("[baixar/versao]", e instanceof Error ? e.message : "erro");
    return Response.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
