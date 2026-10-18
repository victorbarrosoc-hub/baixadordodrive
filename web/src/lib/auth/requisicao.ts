/**
 * Autenticação nas rotas da API (Request da Web API, sem next/headers).
 * Cookie `sd_sessao` (site, confere Origin nas mutações) ou `Authorization: Bearer sdd_...` (computador).
 */
import { erro, lerCookie, origemConfere } from "@/lib/http";
import { origensDoSite } from "@/lib/site";
import { autenticar, COOKIE_SESSAO, type Autenticado } from "./sessao";

export function usuarioDaRequisicao(req: Request): Promise<Autenticado | null> {
  const build = Number(req.headers.get("x-sobedesce-build"));
  return autenticar({
    cookie: lerCookie(req, COOKIE_SESSAO),
    authorization: req.headers.get("authorization"),
    celular: req.headers.get("x-sobedesce-app") === "celular",
    build: req.headers.has("x-sobedesce-build") && Number.isSafeInteger(build) ? build : null,
  });
}

export const SEM_SESSAO = () => erro(401, "sem_sessao", "Entre na sua conta para continuar.");

/**
 * Para rotas que mudam algo: sessão + Origin quando a sessão veio do cookie.
 * Devolve o usuário ou a resposta de erro pronta.
 */
export async function exigirNaApi(req: Request, opcoes: { mutacao: boolean }): Promise<Autenticado | Response> {
  const atual = await usuarioDaRequisicao(req);
  if (!atual) return SEM_SESSAO();
  if (opcoes.mutacao && atual.via === "cookie" && !origemConfere(req.headers, req.url, origensDoSite())) {
    return erro(403, "origem", "Pedido de outra origem recusado.");
  }
  return atual;
}
