/**
 * Google falso para os testes das contas: OAuth "Aplicativo da Web" com code + PKCE (S256),
 * refresh token, revogação e o userinfo do OpenID. Várias contas Google (sub diferentes).
 * Fiel nas partes que importam: código de uso único, client_secret exigido, redirect_uri conferida,
 * invalid_grant para refresh revogado.
 */
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export type ContaFalsa = { sub: string; email: string; name: string; picture?: string };

type Codigo = { desafio: string; redirectUri: string; conta: ContaFalsa; escopo: string; usado: boolean; expira: number };
type Refresh = { conta: ContaFalsa; escopo: string; revogado: boolean };
type Acesso = { conta: ContaFalsa; refresh: string | null; expira: number; revogado: boolean };

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
        const { sub, email, name, picture } = a.conta;
        return enviar(res, 200, { sub, email, email_verified: true, name, picture });
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
    fechar() {
      return new Promise<void>((ok) => servidor.close(() => ok()));
    },
  };
}

export type GoogleFalso = Awaited<ReturnType<typeof iniciarGoogleFalso>>;
