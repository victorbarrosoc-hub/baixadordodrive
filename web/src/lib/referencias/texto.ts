/**
 * Peças de texto das Referências (docs/REFERENCIAS.md): links, plataformas, nomes de coleção e a descrição que o
 * app do computador grava em cada arquivo. Sem banco e sem Next: os testes chamam direto.
 * A PWA tem uma cópia em JavaScript de plataformaDe/extrairUrl (web/public/app/lib/referencias.js).
 */

const PLATAFORMAS: { nome: string; hosts: RegExp }[] = [
  { nome: "Instagram", hosts: /(^|\.)(instagram\.com|instagr\.am)$/ },
  { nome: "YouTube", hosts: /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/ },
  { nome: "TikTok", hosts: /(^|\.)tiktok\.com$/ },
  { nome: "Vimeo", hosts: /(^|\.)vimeo\.com$/ },
  { nome: "Pinterest", hosts: /(^|\.)(pinterest\.[a-z.]+|pin\.it)$/ },
  { nome: "X", hosts: /(^|\.)(x\.com|twitter\.com)$/ },
  { nome: "Facebook", hosts: /(^|\.)(facebook\.com|fb\.watch|fb\.com)$/ },
];

/** "Instagram", "YouTube", "TikTok", "Vimeo", "Pinterest", "X", "Facebook" ou o domínio (sem www). */
export function plataformaDe(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\.|^m\./, "");
    return PLATAFORMAS.find((p) => p.hosts.test(host))?.nome ?? host;
  } catch {
    return "";
  }
}

/** Nome da plataforma como o computador escreveu ("instagram", "YOUTUBE"...) → o nome bonito. */
export function nomeDaPlataforma(valor: string | undefined | null): string {
  const v = (valor ?? "").trim();
  if (!v) return "";
  const conhecida = PLATAFORMAS.find((p) => p.nome.toLowerCase() === v.toLowerCase() || (v.toLowerCase() === "twitter" && p.nome === "X"));
  return conhecida?.nome ?? v;
}

// Parâmetros de rastreio que só atrapalham (o mesmo vídeo compartilhado duas vezes vira dois links).
const RASTREIO = /^(utm_[a-z]+|igsh|igshid|fbclid|gclid|si|feature|share_id|_r|_t|ref_src|ref_url|mibextid|is_from_webapp|sender_device)$/i;

/** Primeiro link http(s) de um texto ("Olha isso https://..."). null se não houver. */
export function extrairUrl(texto: unknown): string | null {
  if (typeof texto !== "string") return null;
  const m = /https?:\/\/[^\s<>"'`]+/i.exec(texto);
  if (!m) return null;
  return m[0].replace(/[).,;!?\]}»”]+$/, "");
}

/**
 * Link pronto para a fila: https, sem espaços, sem parâmetros de rastreio, até 2048 caracteres.
 * Aceita texto com o link no meio. null = inválido.
 */
export function limparUrl(entrada: unknown): string | null {
  const bruto = extrairUrl(entrada);
  if (!bruto) return null;
  let u: URL;
  try {
    u = new URL(bruto);
  } catch {
    return null;
  }
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.protocol !== "https:" || !u.hostname.includes(".") || u.username || u.password) return null;
  for (const k of [...u.searchParams.keys()]) if (RASTREIO.test(k)) u.searchParams.delete(k);
  u.hash = "";
  const final = u.toString();
  return final.length <= 2048 ? final : null;
}

/** Nome de coleção: sem espaços nas pontas, NFC, 1 a 80 caracteres, sem "/" nem caracteres de controle. */
export function validarNome(entrada: unknown): { ok: true; nome: string } | { ok: false; mensagem: string } {
  if (typeof entrada !== "string") return { ok: false, mensagem: "Dê um nome para a coleção." };
  const nome = entrada.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!nome) return { ok: false, mensagem: "Dê um nome para a coleção." };
  if ([...nome].length > 80) return { ok: false, mensagem: "Use até 80 caracteres." };
  if (nome.includes("/") || /[\u0000-\u001f\u007f]/.test(nome)) return { ok: false, mensagem: "O nome não pode ter “/”." };
  if (nome === "." || nome === "..") return { ok: false, mensagem: "Escolha outro nome." };
  return { ok: true, nome };
}

/** Chave de comparação do nome (sem maiúsculas nem acentos): "Clipes" e "clipés" são a mesma coleção. */
export function chaveNome(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export type Descricao = { url: string | null; titulo: string | null; autor: string | null; plataforma: string | null; salvoEm: string | null; legenda: string };

const CAMPOS: Record<string, keyof Omit<Descricao, "url" | "legenda">> = {
  titulo: "titulo",
  title: "titulo",
  autor: "autor",
  author: "autor",
  plataforma: "plataforma",
  platform: "plataforma",
  "salvo em": "salvoEm",
  salvo: "salvoEm",
  "saved at": "salvoEm",
};

/**
 * Lê a descrição gravada pelo computador (docs/REFERENCIAS.md §4), com cuidado: qualquer parte pode faltar.
 *   https://link-original
 *   Título: …
 *   Autor: …
 *   Plataforma: …
 *   Salvo em: 2026-10-16T14:03:00Z
 *   (linha em branco)
 *   legenda e notas, várias linhas
 */
export function lerDescricao(texto: string | null | undefined): Descricao {
  const out: Descricao = { url: null, titulo: null, autor: null, plataforma: null, salvoEm: null, legenda: "" };
  const linhas = String(texto ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  let i = 0;
  while (i < linhas.length && !linhas[i].trim()) i++;
  const primeira = linhas[i]?.trim() ?? "";
  if (/^https?:\/\/\S+$/i.test(primeira)) {
    out.url = primeira;
    i++;
  }
  // Cabeçalho "Chave: valor" até a primeira linha em branco (ou a primeira que não é cabeçalho).
  for (; i < linhas.length; i++) {
    const l = linhas[i];
    if (!l.trim()) {
      i++;
      break;
    }
    const m = /^\s*([^:]{2,20}):\s*(.*)$/.exec(l);
    const chave = m ? CAMPOS[chaveNome(m[1])] : undefined;
    if (!m || !chave) break;
    const valor = m[2].trim();
    if (valor) out[chave] = valor;
  }
  out.legenda = linhas.slice(i).join("\n").trim();
  return out;
}
