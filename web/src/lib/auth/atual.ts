import "server-only";
/**
 * Sessão de quem está vendo a página ou chamando a Server Action (next/headers).
 * Nas rotas da API use `usuarioDaRequisicao(req)` (./requisicao.ts), que não depende do Next.
 */
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { depoisDaResposta } from "@/lib/depois";
import { ipDe, lugarDe, origemConfere, origemDoPedido } from "@/lib/http";
import { cookieSeguro, origensDoSite } from "@/lib/site";
import { COOKIE_APARELHO, conferirAparelho, opcoesCookieAparelho } from "./aparelho";
import { autenticar, COOKIE_SESSAO, opcoesCookieSessao, type Autenticado } from "./sessao";
import { voltaSegura } from "./volta";

/** `{ usuario, sessao } | null`. Lê o Bearer de dispositivo ou o cookie `sd_sessao`. */
export const usuarioAtual = cache(async (): Promise<Autenticado | null> => {
  const [h, c] = await Promise.all([headers(), cookies()]);
  return autenticar({ cookie: c.get(COOKIE_SESSAO)?.value, authorization: h.get("authorization") });
});

/** Usuário logado, ou redireciona para /entrar?volta=<caminho>. */
export async function exigirUsuario(volta = "/conta"): Promise<Autenticado> {
  const atual = await usuarioAtual();
  if (!atual) redirect(`/entrar?volta=${encodeURIComponent(voltaSegura(volta))}`);
  return atual;
}

/**
 * Server Actions: o Next já compara Origin e Host; esta é a segunda tranca, igual à das rotas.
 * Devolve false se a origem não for a do próprio site.
 */
export async function origemDaAcaoConfere(): Promise<boolean> {
  const h = await headers();
  return origemConfere(h, undefined, origensDoSite());
}

/** Grava o cookie da sessão (só em Server Action ou rota). */
export async function gravarCookieSessao(token: string): Promise<void> {
  const [h, c] = await Promise.all([headers(), cookies()]);
  c.set(COOKIE_SESSAO, token, opcoesCookieSessao(cookieSeguro(origemDoPedido(h))));
}

export async function apagarCookieSessao(): Promise<void> {
  const c = await cookies();
  c.delete(COOKIE_SESSAO);
}

export async function ipAtual(): Promise<string> {
  return ipDe(await headers());
}

/**
 * Depois de um login que deu certo (Server Action): confere o aparelho, grava o cookie `sd_aparelho` e, num
 * aparelho que a conta ainda não usou, manda o aviso de entrada nova depois da resposta (lib/auth/aparelho.ts).
 * `avisar` false: criar conta e senha refeita (só aprende o aparelho).
 */
export async function marcarAparelho(usuarioId: string, o: { via: "senha" | "google"; avisar: boolean }): Promise<void> {
  const [h, c] = await Promise.all([headers(), cookies()]);
  const valor = await conferirAparelho({
    usuarioId,
    cookie: c.get(COOKIE_APARELHO)?.value,
    via: o.via,
    entrada: { userAgent: h.get("user-agent"), lugar: lugarDe(h) },
    avisar: o.avisar,
    depois: depoisDaResposta,
  });
  if (valor) c.set(COOKIE_APARELHO, valor, opcoesCookieAparelho(cookieSeguro(origemDoPedido(h))));
}
