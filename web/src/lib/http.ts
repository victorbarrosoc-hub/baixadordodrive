/**
 * Peças das rotas da API (docs/CONTAS.md §5): JSON sem cache, erro no formato do contrato,
 * cookies, IP e conferência de Origin. Só Web API (Request/Response): os testes chamam as rotas direto.
 */

const SEM_CACHE = { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" };

export function json(dados: unknown, status = 200, extras?: HeadersInit): Response {
  const headers = new Headers(SEM_CACHE);
  if (extras) new Headers(extras).forEach((v, k) => headers.append(k, v));
  return new Response(JSON.stringify(dados), { status, headers });
}

/** `{ erro, mensagem }` com o status HTTP. */
export function erro(status: number, codigo: string, mensagem: string, extras?: HeadersInit): Response {
  return json({ erro: codigo, mensagem }, status, extras);
}

export function semConteudo(extras?: HeadersInit): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (extras) new Headers(extras).forEach((v, k) => headers.append(k, v));
  return new Response(null, { status: 204, headers });
}

/** Redirecionamento sem cache, com cookies opcionais (Set-Cookie já serializado). */
export function redirecionar(destino: string | URL, status = 303, cookies: string[] = []): Response {
  const headers = new Headers({ Location: String(destino), "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status, headers });
}

/** Corpo JSON como objeto, ou null (corpo vazio, inválido ou grande demais). */
export async function lerJson(req: Request, limite = 16 * 1024): Promise<Record<string, unknown> | null> {
  try {
    const texto = await req.text();
    if (!texto || texto.length > limite) return null;
    const valor: unknown = JSON.parse(texto);
    return valor && typeof valor === "object" && !Array.isArray(valor) ? (valor as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function lerCookie(req: Request, nome: string): string | undefined {
  const bruto = req.headers.get("cookie");
  if (!bruto) return undefined;
  for (const parte of bruto.split(";")) {
    const i = parte.indexOf("=");
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === nome) {
      try {
        return decodeURIComponent(parte.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export type OpcoesCookie = {
  maxAge: number;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
};

export function serializarCookie(nome: string, valor: string, o: OpcoesCookie): string {
  const partes = [`${nome}=${encodeURIComponent(valor)}`, `Path=${o.path ?? "/"}`, `Max-Age=${Math.max(0, Math.floor(o.maxAge))}`];
  if (o.maxAge <= 0) partes.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (o.httpOnly !== false) partes.push("HttpOnly");
  if (o.secure) partes.push("Secure");
  partes.push(`SameSite=${o.sameSite ?? "Lax"}`);
  return partes.join("; ");
}

/** IP de quem pediu (Vercel: x-real-ip / x-forwarded-for). Só para o limite de tentativas. */
export function ipDe(headers: Headers): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  const encaminhado = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (encaminhado || "local").slice(0, 64);
}

export type Lugar = { ip: string | null; cidade: string | null; pais: string | null };

/**
 * De onde veio o pedido, aproximado: IP e, na Vercel, cidade e país pelos cabeçalhos que ela põe
 * (x-vercel-ip-city vem codificado como URL; x-vercel-ip-country é o código ISO de 2 letras). Fora da Vercel esses
 * cabeçalhos podem ter vindo de quem pediu, então só o IP vale. Só para mostrar na tela de liberar computador.
 */
export function lugarDe(headers: Headers, env: Record<string, string | undefined> = process.env): Lugar {
  const ip = ipDe(headers);
  const lugar: Lugar = { ip: ip === "local" ? null : ip, cidade: null, pais: null };
  if (!env.VERCEL) return lugar;
  const limpar = (v: string | null, max: number) => {
    if (!v) return null;
    let t = v;
    try {
      t = decodeURIComponent(v);
    } catch {
      // fica como veio
    }
    t = t.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
    return t || null;
  };
  lugar.cidade = limpar(headers.get("x-vercel-ip-city"), 80);
  const pais = limpar(headers.get("x-vercel-ip-country"), 2)?.toUpperCase() ?? null;
  lugar.pais = pais && /^[A-Z]{2}$/.test(pais) ? pais : null;
  return lugar;
}

/** Origem do próprio site nesta requisição (Host ou X-Forwarded-Host). */
export function origemDoPedido(headers: Headers, urlDoPedido?: string): string | null {
  const host = headers.get("x-forwarded-host")?.split(",")[0]?.trim() || headers.get("host")?.trim();
  if (host) {
    const proto =
      headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      (urlDoPedido ? new URL(urlDoPedido).protocol.replace(":", "") : /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
    return `${proto}://${host}`;
  }
  if (urlDoPedido) {
    try {
      return new URL(urlDoPedido).origin;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * CSRF das mutações com cookie: o navegador sempre manda Origin num POST.
 * Sem Origin, com "null" ou de outro site: recusa. Vale a origem do próprio pedido ou a do site oficial.
 */
export function origemConfere(headers: Headers, urlDoPedido: string | undefined, siteUrl: string | string[]): boolean {
  const origem = headers.get("origin");
  if (!origem || origem === "null") return false;
  const aceitas = new Set<string>();
  const doPedido = origemDoPedido(headers, urlDoPedido);
  if (doPedido) aceitas.add(doPedido);
  for (const s of Array.isArray(siteUrl) ? siteUrl : [siteUrl]) {
    try {
      aceitas.add(new URL(s).origin);
    } catch {
      // SITE_URL inválida: só a do pedido vale
    }
  }
  return aceitas.has(origem);
}
