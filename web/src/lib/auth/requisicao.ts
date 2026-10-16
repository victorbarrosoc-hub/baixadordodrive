/**
 * Autenticação nas rotas da API (Request da Web API, sem next/headers).
 * Cookie `sd_sessao` (site, confere Origin nas mutações) ou `Authorization: Bearer sdd_...` (computador).
 */
import { erro, lerCookie, origemConfere } from "@/lib/http";
import { siteUrl } from "@/lib/site";
import { autenticar, COOKIE_SESSAO, type Autenticado } from "./sessao";

export function usuarioDaRequisicao(req: Request): Promise<Autenticado | null> {
  return autenticar({ cookie: lerCookie(req, COOKIE_SESSAO), authorization: req.headers.get("authorization") });
}

export const SEM_SESSAO = () => erro(401, "sem_sessao", "Entre na sua conta para continuar.");

/**
 * Para rotas que mudam algo: sessão + Origin quando a sessão veio do cookie.
 * Devolve o usuário ou a resposta de erro pronta.
 */
export async function exigirNaApi(req: Request, opcoes: { mutacao: boolean }): Promise<Autenticado | Response> {
  const atual = await usuarioDaRequisicao(req);
  if (!atual) return SEM_SESSAO();
  if (opcoes.mutacao && atual.via === "cookie" && !origemConfere(req.headers, req.url, siteUrl())) {
    return erro(403, "origem", "Pedido de outra origem recusado.");
  }
  return atual;
}
