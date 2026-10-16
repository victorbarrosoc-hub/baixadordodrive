import "server-only";
/**
 * Sessão de quem está vendo a página ou chamando a Server Action (next/headers).
 * Nas rotas da API use `usuarioDaRequisicao(req)` (./requisicao.ts), que não depende do Next.
 */
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { ipDe, origemConfere, origemDoPedido } from "@/lib/http";
import { cookieSeguro, origensDoSite } from "@/lib/site";
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
