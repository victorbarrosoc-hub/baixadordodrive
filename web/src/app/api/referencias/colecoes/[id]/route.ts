import { lerJson, origemDoPedido } from "@/lib/http";
import { erroGoogle, exigirReferencias, falha, MSG, ok } from "@/lib/referencias/api";
import { acharColecao, apagarColecao, ErroColecao, mudarLink, publica, renomearColecao } from "@/lib/referencias/colecoes";
import { limparCache } from "@/lib/referencias/publica";
import { validarNome } from "@/lib/referencias/texto";
import { origemPublica } from "@/lib/site";

const LINK = ["ligar", "desligar", "trocar"] as const;

/** Renomear (também a pasta no Drive) e ligar, trocar ou desligar o link pra IA: `{ nome?, link? }`. */
export async function PATCH(req: Request, ctx: RouteContext<"/api/referencias/colecoes/[id]">) {
  const atual = await exigirReferencias(req, { mutacao: true });
  if (atual instanceof Response) return atual;
  const { id } = await ctx.params;
  const corpo = await lerJson(req);
  if (!corpo || (corpo.nome === undefined && corpo.link === undefined)) return falha(400, "entrada", MSG.entrada);
  const link = corpo.link as (typeof LINK)[number] | undefined;
  if (link !== undefined && !LINK.includes(link)) return falha(400, "entrada", MSG.entrada);
  const v = corpo.nome !== undefined ? validarNome(corpo.nome) : null;
  if (v && !v.ok) return falha(400, "nome", v.mensagem);
  let l = await acharColecao(atual.usuario.id, id);
  if (!l) return falha(404, "nao_encontrada", MSG.colecao);
  try {
    if (v?.ok) l = await renomearColecao(atual.usuario.id, l, v.nome);
    if (link) {
      if (l.publicaToken && link !== "ligar") limparCache(l.publicaToken);
      l = await mudarLink(atual.usuario.id, l, link);
    }
  } catch (e) {
    if (e instanceof ErroColecao) return falha(e.status, e.codigo, e.message);
    return erroGoogle(e);
  }
  if (l.publicaToken) limparCache(l.publicaToken);
  return ok({ colecao: publica(l, origemPublica(origemDoPedido(req.headers, req.url))) });
}

/** Tira da plataforma. `?apagarNoDrive=1` também põe a pasta na lixeira do Drive. */
export async function DELETE(req: Request, ctx: RouteContext<"/api/referencias/colecoes/[id]">) {
  const atual = await exigirReferencias(req, { mutacao: true });
  if (atual instanceof Response) return atual;
  const { id } = await ctx.params;
  const l = await acharColecao(atual.usuario.id, id);
  if (!l) return falha(404, "nao_encontrada", MSG.colecao);
  const noDrive = ["1", "true", "sim"].includes(new URL(req.url).searchParams.get("apagarNoDrive") ?? "");
  try {
    await apagarColecao(atual.usuario.id, l, noDrive);
  } catch (e) {
    return erroGoogle(e);
  }
  if (l.publicaToken) limparCache(l.publicaToken);
  return ok({ apagadaNoDrive: noDrive });
}
