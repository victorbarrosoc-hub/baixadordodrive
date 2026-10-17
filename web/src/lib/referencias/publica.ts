/**
 * Link pra IA (docs/REFERENCIAS.md §6): /r/<token> em HTML, .json e .md. Lê a pasta da coleção no Drive do dono
 * (arquivos com appProperties.sobedesce=referencia) e monta uma lista que o ChatGPT, o Claude e o Gemini conseguem
 * ler. Nunca mostra o e-mail do dono, só o primeiro nome. Cache em memória de 5 minutos por link.
 */
import { aspas, lerArquivo, listarTudo, type ArquivoDrive } from "@/lib/google/drive";
import { lerDescricao, nomeDaPlataforma, plataformaDe } from "./texto";

export const CACHE_MS = 5 * 60_000;
const CAMPOS =
  "id,name,mimeType,description,appProperties,createdTime,modifiedTime,size,permissionIds,webViewLink,videoMediaMetadata(durationMillis),imageMediaMetadata(width,height)";
/** Ids de permissão do Google para "qualquer pessoa com o link" (e "público na web"). */
const ABERTO = ["anyoneWithLink", "anyone"];

export type ItemPublico = {
  titulo: string;
  plataforma: string;
  autor: string | null;
  /** Link original (Instagram, YouTube...). */
  url: string | null;
  legenda: string;
  tipo: "video" | "foto" | "arquivo";
  duracaoSegundos: number | null;
  /** Link do arquivo no Drive, só se ele estiver aberto para quem tem o link. */
  drive: string | null;
  salvoEm: string | null;
};

export type ColecaoAberta = {
  nome: string;
  dono: string;
  itens: ItemPublico[];
  atualizadoEm: string;
  /** Link da pasta no Drive, só se ela estiver aberta para quem tem o link. */
  pasta: string | null;
};

const cache = new Map<string, { em: number; dados: Omit<ColecaoAberta, "nome" | "dono"> }>();

export function limparCache(token?: string) {
  if (token) cache.delete(token);
  else cache.clear();
}

const aberto = (f: ArquivoDrive) => (f.permissionIds ?? []).some((p) => ABERTO.includes(p));
const httpOk = (u: string | null | undefined) => (u && /^https?:\/\/[^\s]+$/i.test(u) ? u : null);

function semExtensao(nome: string) {
  const i = nome.lastIndexOf(".");
  return i > 0 ? nome.slice(0, i) : nome;
}

export function itemDoArquivo(f: ArquivoDrive): ItemPublico {
  const d = lerDescricao(f.description);
  const ap = f.appProperties ?? {};
  // A appProperty "fonte" pode vir cortada (124 bytes por propriedade no Drive): a da descrição vale mais.
  const url = httpOk(d.url) ?? httpOk(ap.fonte);
  const ms = Number(f.videoMediaMetadata?.durationMillis);
  const tipo = f.mimeType?.startsWith("video/") || Number.isFinite(ms) ? "video" : f.mimeType?.startsWith("image/") ? "foto" : "arquivo";
  return {
    titulo: (d.titulo || ap.titulo || semExtensao(f.name || "")).trim() || "Sem título",
    plataforma: nomeDaPlataforma(d.plataforma || ap.plataforma) || (url ? plataformaDe(url) : ""),
    autor: (d.autor || ap.autor || "").trim() || null,
    url,
    legenda: d.legenda,
    tipo,
    duracaoSegundos: Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : null,
    drive: aberto(f) ? httpOk(f.webViewLink) ?? `https://drive.google.com/file/d/${encodeURIComponent(f.id)}/view` : null,
    salvoEm: d.salvoEm || f.createdTime || null,
  };
}

/** Lê a pasta no Drive (ou o cache). Erros do Google sobem para a rota. */
export async function lerColecaoAberta(
  token: string,
  c: { usuarioId: string; contaGoogleId: string; driveFolderId: string; nome: string; atualizadoEm: Date },
  nomeDono: string,
): Promise<ColecaoAberta> {
  const dono = nomeDono.trim().split(/\s+/)[0] || "alguém";
  const guardado = cache.get(token);
  if (guardado && Date.now() - guardado.em < CACHE_MS) return { nome: c.nome, dono, ...guardado.dados };
  const [arquivos, pasta] = await Promise.all([
    listarTudo(
      c.usuarioId,
      c.contaGoogleId,
      `${aspas(c.driveFolderId)} in parents and trashed = false and appProperties has { key='sobedesce' and value='referencia' }`,
      CAMPOS,
      { orderBy: "createdTime desc" },
    ),
    lerArquivo(c.usuarioId, c.contaGoogleId, c.driveFolderId, "id,permissionIds,webViewLink").catch(() => null),
  ]);
  const itens = arquivos.map(itemDoArquivo);
  const ultimo = arquivos.map((f) => f.modifiedTime || f.createdTime || "").sort().pop();
  const atualizadoEm = [ultimo, c.atualizadoEm.toISOString()].filter(Boolean).sort().pop()!;
  const dados = {
    itens,
    atualizadoEm,
    pasta: pasta && aberto(pasta) ? httpOk(pasta.webViewLink) ?? `https://drive.google.com/drive/folders/${encodeURIComponent(c.driveFolderId)}` : null,
  };
  cache.set(token, { em: Date.now(), dados });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return { nome: c.nome, dono, ...dados };
}

// ───── formatos ─────

const dataHora = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
const dataCurta = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Sao_Paulo" });

function quando(iso: string | null, curta = false): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : (curta ? dataCurta : dataHora).format(d);
}

export function duracao(s: number | null): string {
  if (s == null) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const contagem = (n: number) => (n === 1 ? "1 item" : `${n} itens`);
export const notaDoDono = (dono: string) => `Referências salvas por ${dono} na SOBEDESCE.`;

export function emJson(c: ColecaoAberta) {
  return {
    ok: true,
    colecao: c.nome,
    nota: notaDoDono(c.dono),
    total: c.itens.length,
    atualizadoEm: c.atualizadoEm,
    pastaNoDrive: c.pasta,
    itens: c.itens,
  };
}

/** Uma linha de Markdown sem quebrar a lista. */
const linha = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

export function emMarkdown(c: ColecaoAberta): string {
  const out: string[] = [
    `# ${linha(c.nome)}`,
    "",
    notaDoDono(c.dono),
    `${contagem(c.itens.length)} · atualizado em ${quando(c.atualizadoEm)} (horário de Brasília)`,
  ];
  if (c.pasta) out.push(`Pasta no Google Drive: ${c.pasta}`);
  if (!c.itens.length) out.push("", "Esta coleção ainda está vazia.");
  c.itens.forEach((it, i) => {
    out.push("", `## ${i + 1}. ${linha(it.titulo)}`, "");
    if (it.plataforma) out.push(`- Plataforma: ${it.plataforma}`);
    if (it.autor) out.push(`- Autor: ${linha(it.autor)}`);
    if (it.url) out.push(`- Link original: ${it.url}`);
    out.push(`- Tipo: ${it.tipo === "video" ? "vídeo" : it.tipo}`);
    if (it.duracaoSegundos != null) out.push(`- Duração: ${duracao(it.duracaoSegundos)}`);
    if (it.drive) out.push(`- Vídeo no Google Drive: ${it.drive}`);
    if (it.salvoEm) out.push(`- Salvo em: ${quando(it.salvoEm, true)}`);
    if (it.legenda) out.push("", "Legenda e notas:", "", ...it.legenda.split("\n").map((l) => `> ${l}`));
  });
  return out.join("\n") + "\n";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function emHtml(c: ColecaoAberta, base: string): string {
  const itens = c.itens
    .map((it, i) => {
      const meta = [it.plataforma, it.autor, it.duracaoSegundos != null ? duracao(it.duracaoSegundos) : "", it.salvoEm ? `salvo em ${quando(it.salvoEm, true)}` : ""]
        .filter((x): x is string => Boolean(x))
        .map(esc)
        .join('<span class="sep">·</span>');
      const links = [
        it.url ? `<a href="${esc(it.url)}" rel="noopener noreferrer nofollow">Abrir original${it.plataforma ? ` no ${esc(it.plataforma)}` : ""}</a>` : "",
        it.drive ? `<a href="${esc(it.drive)}" rel="noopener noreferrer nofollow">Vídeo no Drive</a>` : "",
      ]
        .filter(Boolean)
        .join("");
      return `<li class="item">
  <span class="n">${i + 1}</span>
  <div class="corpo">
    <h2>${esc(it.titulo)}</h2>
    ${meta ? `<p class="meta">${meta}</p>` : ""}
    ${it.legenda ? `<p class="legenda">${esc(it.legenda)}</p>` : ""}
    ${it.url ? `<p class="url">${esc(it.url)}</p>` : ""}
    ${links ? `<p class="links">${links}</p>` : ""}
  </div>
</li>`;
    })
    .join("\n");
  const md = `${base}.md`;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(c.nome)} · Referências</title>
<meta name="description" content="${esc(`${notaDoDono(c.dono)} ${contagem(c.itens.length)}.`)}">
<link rel="alternate" type="text/markdown" href="${esc(md)}">
<link rel="alternate" type="application/json" href="${esc(base)}.json">
<style>
:root{color-scheme:light dark;--bg:#fbfbfd;--card:#fff;--ink:#1d1d1f;--ink2:#6e6e73;--ink3:#8e8e93;--line:rgba(60,60,67,.12);--up:#5b3df0;--down:#0068d6;--n:#f5f5f7;--n2:#ececf0}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--ink:#f5f5f7;--ink2:#aeaeb2;--ink3:#8e8e93;--line:rgba(235,235,245,.14);--up:#b4a3ff;--down:#64b0ff;--n:#2c2c2e;--n2:#3a3a3c}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,system-ui,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:760px;margin:0 auto;padding:56px 20px 80px}
.marca{display:inline-flex;align-items:center;gap:8px;font-weight:600;font-size:13px;letter-spacing:.08em;color:var(--ink)}
.marca i{display:inline-block;width:18px;height:18px;border-radius:6px;background:#111113;position:relative}
.marca i:before,.marca i:after{content:"";position:absolute;width:3px;border-radius:2px;top:4px;height:8px}
.marca i:before{left:5px;background:#a18cff}.marca i:after{left:10px;top:6px;background:#3d9cff}
h1{font-size:clamp(34px,6vw,48px);line-height:1.06;letter-spacing:-.025em;margin:28px 0 12px;font-weight:650;overflow-wrap:anywhere}
.sub{margin:0;color:var(--ink2);font-size:17px}
.ia{margin:28px 0 0;padding:16px 18px;border-radius:18px;background:var(--card);box-shadow:0 0 0 1px var(--line);font-size:15px;color:var(--ink2)}
.ia b{color:var(--ink);font-weight:600}
.ia a{color:var(--down);text-decoration:none;font-weight:500}
.ia a:hover{text-decoration:underline}
ol{list-style:none;margin:40px 0 0;padding:0;border-radius:18px;background:var(--card);box-shadow:0 0 0 1px var(--line);overflow:hidden}
.item{display:flex;gap:16px;padding:22px 22px 22px 18px;border-top:1px solid var(--line)}
.item:first-child{border-top:0}
.n{flex:none;width:28px;height:28px;border-radius:999px;background:var(--n);color:var(--ink2);font-size:13px;font-weight:600;display:grid;place-items:center;font-variant-numeric:tabular-nums}
.corpo{min-width:0;flex:1}
h2{margin:2px 0 4px;font-size:18px;line-height:1.3;letter-spacing:-.01em;font-weight:600;overflow-wrap:anywhere}
.meta{margin:0;color:var(--ink2);font-size:14px}
.sep{margin:0 7px;color:var(--ink3)}
.legenda{margin:12px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px}
.url{margin:10px 0 0;font:12px/1.4 "SF Mono",ui-monospace,Menlo,monospace;color:var(--ink3);overflow-wrap:anywhere}
.links{margin:12px 0 0;display:flex;flex-wrap:wrap;gap:8px}
.links a{display:inline-flex;align-items:center;height:34px;padding:0 14px;border-radius:999px;background:var(--n);color:var(--ink);text-decoration:none;font-size:14px;font-weight:500}
.links a:hover{background:var(--n2)}
.vazio{padding:40px 22px;text-align:center;color:var(--ink2)}
footer{margin-top:28px;color:var(--ink3);font-size:13px;text-align:center}
footer a{color:inherit}
@media (max-width:520px){main{padding:36px 16px 64px}.item{padding:18px 16px 18px 12px;gap:12px}.n{width:24px;height:24px;font-size:12px}}
</style>
</head>
<body>
<main>
<span class="marca"><i aria-hidden="true"></i>SOBEDESCE</span>
<h1>${esc(c.nome)}</h1>
<p class="sub">${esc(notaDoDono(c.dono))} ${esc(contagem(c.itens.length))} · atualizado em ${esc(quando(c.atualizadoEm))}</p>
<p class="ia"><b>Para usar com uma IA:</b> cole este endereço no ChatGPT, no Claude ou no Gemini. Também tem em <a href="${esc(md)}">texto (.md)</a> e <a href="${esc(base)}.json">JSON</a>.${
    c.pasta ? ` <a href="${esc(c.pasta)}" rel="noopener noreferrer nofollow">Pasta no Drive</a>.` : ""
  }</p>
<ol>
${itens || '<li class="vazio">Esta coleção ainda está vazia.</li>'}
</ol>
<footer>Salvo para referência. Os vídeos são de quem os criou.</footer>
</main>
</body>
</html>`;
}
