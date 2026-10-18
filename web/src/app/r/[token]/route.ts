import { ErroConta } from "@/lib/google/contas";
import { ErroDrive } from "@/lib/google/drive";
import { origemDoPedido } from "@/lib/http";
import { colecaoPublica } from "@/lib/referencias/colecoes";
import { emHtml, emJson, emMarkdown, lerColecaoAberta } from "@/lib/referencias/publica";
import { origemPublica } from "@/lib/site";

/**
 * Link pra IA de uma coleção (docs/REFERENCIAS.md §6): /r/<token> (HTML), /r/<token>.json e /r/<token>.md.
 * Sem login. Fora dos buscadores (noindex). Link desligado, trocado ou desconhecido → 404.
 */
const BASE = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

type Formato = "html" | "json" | "md";

function resposta(formato: Formato, status: number, corpo: string) {
  const tipo = { html: "text/html; charset=utf-8", json: "application/json; charset=utf-8", md: "text/markdown; charset=utf-8" }[formato];
  return new Response(corpo, { status, headers: { ...BASE, "Content-Type": tipo, ...(formato === "html" ? { "Content-Security-Policy": CSP } : {}) } });
}

function aviso(formato: Formato, status: number, titulo: string, texto: string) {
  if (formato === "json") return resposta(formato, status, JSON.stringify({ ok: false, erro: status === 404 ? "nao_encontrada" : "indisponivel", mensagem: texto }));
  if (formato === "md") return resposta(formato, status, `# ${titulo}\n\n${texto}\n`);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return resposta(
    formato,
    status,
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${esc(titulo)}</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fbfbfd;color:#1d1d1f;font:16px/1.5 -apple-system,BlinkMacSystemFont,Inter,system-ui,sans-serif;padding:24px;text-align:center}h1{font-size:26px;margin:0 0 8px;letter-spacing:-.02em}p{margin:0;color:#6e6e73}@media (prefers-color-scheme:dark){body{background:#000;color:#f5f5f7}p{color:#aeaeb2}}</style></head><body><main><h1>${esc(titulo)}</h1><p>${esc(texto)}</p></main></body></html>`,
  );
}

export async function GET(req: Request, ctx: RouteContext<"/r/[token]">) {
  const { token: bruto } = await ctx.params;
  const m = /^(.+?)(?:\.(json|md))?$/.exec(bruto);
  const token = m?.[1] ?? "";
  const formato: Formato = (m?.[2] as Formato | undefined) ?? "html";
  const achada = await colecaoPublica(token);
  if (!achada) return aviso(formato, 404, "Link desligado", "Este link de referências não existe ou foi desligado por quem criou.");
  const { colecao: c, nomeDono } = achada;
  let dados;
  try {
    dados = await lerColecaoAberta(token, c, nomeDono);
  } catch (e) {
    if (e instanceof ErroConta || e instanceof ErroDrive) {
      return aviso(formato, 503, c.nome, "A lista não abriu agora: o Google Drive de quem criou não respondeu. Tente de novo mais tarde.");
    }
    throw e;
  }
  if (formato === "json") return resposta("json", 200, JSON.stringify(emJson(dados)));
  if (formato === "md") return resposta("md", 200, emMarkdown(dados));
  const base = `${origemPublica(origemDoPedido(req.headers, req.url))}/r/${token}`;
  return resposta("html", 200, emHtml(dados, base));
}
