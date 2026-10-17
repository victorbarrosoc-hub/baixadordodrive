/**
 * Google falso para os testes das contas: OAuth "Aplicativo da Web" com code + PKCE (S256),
 * refresh token, revogação e o userinfo do OpenID. Várias contas Google (sub diferentes).
 * Fiel nas partes que importam: código de uso único, client_secret exigido, redirect_uri conferida,
 * invalid_grant para refresh revogado.
 * Também um Drive v3 mínimo (Referências): files.list com `q` ('X' in parents, trashed, mimeType, name,
 * appProperties has {...}), files.create, files.get e files.update (nome, lixeira), por conta Google.
 */
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/** `verificado: false`: o Google não confirmou o e-mail (email_verified false no userinfo). */
export type ContaFalsa = { sub: string; email: string; name: string; picture?: string; verificado?: boolean };

type Codigo = { desafio: string; redirectUri: string; conta: ContaFalsa; escopo: string; usado: boolean; expira: number };
type Refresh = { conta: ContaFalsa; escopo: string; revogado: boolean };
type Acesso = { conta: ContaFalsa; refresh: string | null; expira: number; revogado: boolean };

export type ArquivoFalso = {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  appProperties?: Record<string, string>;
  description?: string;
  createdTime: string;
  modifiedTime: string;
  permissionIds?: string[];
  videoMediaMetadata?: { durationMillis: string };
  webViewLink?: string;
};

/** Quebra a consulta do Drive nos "and" de fora (fora de aspas e chaves). */
function partesDoQ(q: string): string[] {
  const out: string[] = [];
  let atual = "";
  let aspas = false;
  let chaves = 0;
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (aspas && c === "\\") {
      atual += c + (q[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "'") aspas = !aspas;
    if (!aspas && c === "{") chaves++;
    if (!aspas && c === "}") chaves--;
    if (!aspas && chaves === 0 && /^\s+and\s+/i.test(q.slice(i)) && /\s/.test(c)) {
      out.push(atual.trim());
      atual = "";
      i += /^\s+and\s+/i.exec(q.slice(i))![0].length - 1;
      continue;
    }
    atual += c;
  }
  if (atual.trim()) out.push(atual.trim());
  return out;
}

const STR = "'((?:[^'\\\\]|\\\\.)*)'";
const tirarEscape = (s: string) => s.replace(/\\(.)/g, "$1");

/** Uma condição → filtro. Desconhecida: lança (o Drive responde 400). */
function condicao(parte: string): (f: ArquivoFalso) => boolean {
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^${STR}\\s+in\\s+parents$`).exec(parte))) {
    const pai = tirarEscape(m[1]);
    return (f) => f.parents.includes(pai);
  }
  if ((m = /^trashed\s*=\s*(true|false)$/.exec(parte))) {
    const v = m[1] === "true";
    return (f) => f.trashed === v;
  }
  if ((m = new RegExp(`^(mimeType|name)\\s*(=|!=)\\s*${STR}$`).exec(parte))) {
    const [, campo, op, bruto] = m;
    const v = tirarEscape(bruto);
    // O "name =" do Drive não diferencia maiúsculas.
    const igual = (f: ArquivoFalso) => (campo === "name" ? f.name.toLowerCase() === v.toLowerCase() : f.mimeType === v);
    return op === "=" ? igual : (f) => !igual(f);
  }
  if ((m = new RegExp(`^appProperties\\s+has\\s+\\{\\s*key\\s*=\\s*${STR}\\s+and\\s+value\\s*=\\s*${STR}\\s*\\}$`).exec(parte))) {
    const k = tirarEscape(m[1]);
    const v = tirarEscape(m[2]);
    return (f) => f.appProperties?.[k] === v;
  }
  throw new Error(`consulta: ${parte}`);
}

const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");
const aleatorio = (prefixo: string) => prefixo + randomBytes(24).toString("base64url");

export async function iniciarGoogleFalso(cliente: { clientId: string; clientSecret: string }, porta = 0) {
  const codigos = new Map<string, Codigo>();
  const refreshes = new Map<string, Refresh>();
  const acessos = new Map<string, Acesso>();
  const contadores = { trocas: 0, renovacoes: 0, revogacoes: 0 };
  /** O que a próxima tela de consentimento faz. */
  const proximo: { conta: ContaFalsa | null; negar: boolean; escopo: string | null } = { conta: null, negar: false, escopo: null };
  let ttlAcessoS = 3600;
  /** Drive de cada conta Google (por sub). */
  const drives = new Map<string, Map<string, ArquivoFalso>>();
  const contadoresDrive = { list: 0, create: 0, update: 0, get: 0 };
  const driveDe = (sub: string) => {
    if (!drives.has(sub)) drives.set(sub, new Map());
    return drives.get(sub)!;
  };
  let seqArquivo = 0;
  function novoArquivo(sub: string, a: Partial<ArquivoFalso> & { name: string; mimeType: string; parents: string[] }): ArquivoFalso {
    const agora = new Date(Date.now() + seqArquivo).toISOString();
    const f: ArquivoFalso = { id: `arq${++seqArquivo}${randomBytes(4).toString("hex")}`, trashed: false, createdTime: agora, modifiedTime: agora, permissionIds: [], ...a };
    driveDe(sub).set(f.id, f);
    return f;
  }

  function acesso(conta: ContaFalsa, refresh: string | null) {
    const token = aleatorio("ya29.falso-");
    acessos.set(token, { conta, refresh, expira: Date.now() + ttlAcessoS * 1000, revogado: false });
    return token;
  }

  async function corpo(req: http.IncomingMessage): Promise<URLSearchParams> {
    const partes: Buffer[] = [];
    for await (const p of req) partes.push(p as Buffer);
    return new URLSearchParams(Buffer.concat(partes).toString("utf8"));
  }

  function enviar(res: http.ServerResponse, status: number, dados: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(dados));
  }

  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (url.pathname === "/o/oauth2/v2/auth" && req.method === "GET") {
        const q = url.searchParams;
        if (q.get("client_id") !== cliente.clientId) return enviar(res, 401, { error: "invalid_client" });
        const redirectUri = q.get("redirect_uri") ?? "";
        if (!/^https?:\/\/[^/]+\/api\/google\/callback$/.test(redirectUri)) return enviar(res, 400, { error: "redirect_uri_mismatch" });
        if (q.get("response_type") !== "code") return enviar(res, 400, { error: "unsupported_response_type" });
        if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return enviar(res, 400, { error: "invalid_request" });
        if (q.get("access_type") !== "offline" || q.get("prompt") !== "consent") return enviar(res, 400, { error: "esperava_offline_consent" });
        const escopoPedido = q.get("scope") ?? "";
        const volta = new URL(redirectUri);
        volta.searchParams.set("state", q.get("state") ?? "");
        if (proximo.negar || !proximo.conta) {
          volta.searchParams.set("error", "access_denied");
        } else {
          const code = aleatorio("4/falso-");
          const escopo = proximo.escopo ?? escopoPedido;
          codigos.set(code, { desafio: q.get("code_challenge")!, redirectUri, conta: proximo.conta, escopo, usado: false, expira: Date.now() + 600_000 });
          volta.searchParams.set("code", code);
          volta.searchParams.set("scope", escopo);
        }
        res.writeHead(302, { Location: volta.toString() });
        return res.end();
      }

      if (url.pathname === "/token" && req.method === "POST") {
        const p = await corpo(req);
        if (p.get("client_id") !== cliente.clientId || p.get("client_secret") !== cliente.clientSecret) return enviar(res, 401, { error: "invalid_client" });
        if (p.get("grant_type") === "authorization_code") {
          const c = codigos.get(p.get("code") ?? "");
          if (!c || c.usado || c.expira < Date.now()) return enviar(res, 400, { error: "invalid_grant" });
          if (p.get("redirect_uri") !== c.redirectUri) return enviar(res, 400, { error: "redirect_uri_mismatch" });
          if (s256(p.get("code_verifier") ?? "") !== c.desafio) return enviar(res, 400, { error: "invalid_grant", error_description: "Invalid code verifier." });
          c.usado = true;
          contadores.trocas++;
          const refresh = aleatorio("1//falso-");
          refreshes.set(refresh, { conta: c.conta, escopo: c.escopo, revogado: false });
          return enviar(res, 200, { access_token: acesso(c.conta, refresh), expires_in: ttlAcessoS, refresh_token: refresh, scope: c.escopo, token_type: "Bearer" });
        }
        if (p.get("grant_type") === "refresh_token") {
          const token = p.get("refresh_token") ?? "";
          const r = refreshes.get(token);
          if (!r || r.revogado) return enviar(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
          contadores.renovacoes++;
          return enviar(res, 200, { access_token: acesso(r.conta, token), expires_in: ttlAcessoS, scope: r.escopo, token_type: "Bearer" });
        }
        return enviar(res, 400, { error: "unsupported_grant_type" });
      }

      if (url.pathname === "/revoke" && req.method === "POST") {
        const p = await corpo(req);
        const token = p.get("token") ?? "";
        contadores.revogacoes++;
        const r = refreshes.get(token);
        if (r) {
          r.revogado = true;
          for (const a of acessos.values()) if (a.refresh === token) a.revogado = true;
          return enviar(res, 200, {});
        }
        const a = acessos.get(token);
        if (a) {
          a.revogado = true;
          return enviar(res, 200, {});
        }
        return enviar(res, 400, { error: "invalid_token" });
      }

      if (url.pathname === "/v1/userinfo" && req.method === "GET") {
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
        const a = acessos.get(token);
        if (!a || a.revogado || a.expira < Date.now()) return enviar(res, 401, { error: "invalid_token" });
        const { sub, email, name, picture, verificado } = a.conta;
        return enviar(res, 200, { sub, email, email_verified: verificado !== false, name, picture });
      }

      if (url.pathname.startsWith("/drive/v3/files")) {
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
        const a = acessos.get(token);
        if (!a || a.revogado || a.expira < Date.now()) return enviar(res, 401, { error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } });
        const drive = driveDe(a.conta.sub);
        const id = decodeURIComponent(url.pathname.slice("/drive/v3/files".length).replace(/^\//, ""));
        const naoAchou = () => enviar(res, 404, { error: { code: 404, message: "File not found", errors: [{ reason: "notFound" }] } });
        const lerCorpo = async () => {
          const partes: Buffer[] = [];
          for await (const p of req) partes.push(p as Buffer);
          return JSON.parse(Buffer.concat(partes).toString("utf8") || "{}");
        };
        if (!id && req.method === "GET") {
          contadoresDrive.list++;
          let filtros: ((f: ArquivoFalso) => boolean)[];
          try {
            filtros = partesDoQ(url.searchParams.get("q") ?? "").map(condicao);
          } catch {
            return enviar(res, 400, { error: { code: 400, message: "Invalid Value", errors: [{ reason: "invalid" }] } });
          }
          let lista = [...drive.values()].filter((f) => filtros.every((fn) => fn(f)));
          if (/createdTime desc/.test(url.searchParams.get("orderBy") ?? "")) lista = lista.sort((x, y) => y.createdTime.localeCompare(x.createdTime));
          return enviar(res, 200, { files: lista });
        }
        if (!id && req.method === "POST") {
          contadoresDrive.create++;
          const b = await lerCorpo();
          if (!b.name || !Array.isArray(b.parents)) return enviar(res, 400, { error: { code: 400, message: "Bad Request" } });
          const pai = b.parents[0];
          if (pai !== "root" && !drive.has(pai)) return naoAchou();
          return enviar(res, 200, novoArquivo(a.conta.sub, { name: b.name, mimeType: b.mimeType ?? "application/octet-stream", parents: b.parents, appProperties: b.appProperties, description: b.description }));
        }
        const f = drive.get(id);
        if (!f) return naoAchou();
        if (req.method === "GET") {
          contadoresDrive.get++;
          return enviar(res, 200, f);
        }
        if (req.method === "PATCH") {
          contadoresDrive.update++;
          const b = await lerCorpo();
          if (typeof b.name === "string") f.name = b.name;
          if (typeof b.trashed === "boolean") f.trashed = b.trashed;
          if (typeof b.description === "string") f.description = b.description;
          f.modifiedTime = new Date().toISOString();
          return enviar(res, 200, f);
        }
        return enviar(res, 405, { error: { code: 405, message: "Method not allowed" } });
      }

      // Controle (scripts de screenshot): troca a conta do próximo consentimento.
      if (url.pathname === "/__proximo" && req.method === "POST") {
        const p = await corpo(req);
        proximo.conta = p.get("sub") ? { sub: p.get("sub")!, email: p.get("email") ?? "", name: p.get("name") ?? "", picture: p.get("picture") ?? undefined } : null;
        proximo.negar = p.get("negar") === "1";
        return enviar(res, 200, { ok: true });
      }

      enviar(res, 404, { error: "not_found" });
    } catch {
      enviar(res, 500, { error: "internal" });
    }
  });

  await new Promise<void>((ok) => servidor.listen(porta, "127.0.0.1", ok));
  const portaUsada = (servidor.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${portaUsada}`,
    proximo,
    contadores,
    /** Todo refresh token passa a dar invalid_grant (os 7 dias do modo Teste). */
    revogarTodos() {
      for (const r of refreshes.values()) r.revogado = true;
    },
    refreshVivos() {
      return [...refreshes.values()].filter((r) => !r.revogado).length;
    },
    acessoValido(token: string) {
      const a = acessos.get(token);
      return Boolean(a && !a.revogado && a.expira > Date.now());
    },
    definirTtlAcesso(s: number) {
      ttlAcessoS = s;
    },
    /** Um refresh token válido para a conta (sem passar pelo consentimento), para testes que só precisam do Drive. */
    emitirRefresh(conta: ContaFalsa, escopo = "openid email profile https://www.googleapis.com/auth/drive") {
      const refresh = aleatorio("1//falso-");
      refreshes.set(refresh, { conta, escopo, revogado: false });
      return refresh;
    },
    /** Todos os access tokens já emitidos vencem (o próximo pedido ao Drive dá 401). */
    vencerAcessos() {
      for (const a of acessos.values()) a.expira = 0;
    },
    contadoresDrive,
    driveDe,
    /** Põe um arquivo no Drive falso (como o computador faria ao salvar uma referência). */
    adicionarArquivo(sub: string, a: Partial<ArquivoFalso> & { name: string; mimeType: string; parents: string[] }) {
      return novoArquivo(sub, a);
    },
    fechar() {
      return new Promise<void>((ok) => servidor.close(() => ok()));
    },
  };
}

export type GoogleFalso = Awaited<ReturnType<typeof iniciarGoogleFalso>>;
