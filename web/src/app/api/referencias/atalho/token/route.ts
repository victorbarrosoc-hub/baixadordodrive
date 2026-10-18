import { origemDoPedido } from "@/lib/http";
import { exigirReferencias, falha, ok } from "@/lib/referencias/api";
import { estadoAtalho, gerarAtalho, revogarAtalhos } from "@/lib/referencias/atalho";
import { origemPublica } from "@/lib/site";

/** Só pelo site (cookie): o computador não mexe na chave do iPhone. */
async function doSite(req: Request, mutacao: boolean) {
  const atual = await exigirReferencias(req, { mutacao });
  if (atual instanceof Response) return atual;
  if (atual.via !== "cookie") return falha(403, "so_site", "Gere a chave do Atalho pelo celular ou pelo site.");
  return atual;
}

export async function GET(req: Request) {
  const atual = await doSite(req, false);
  if (atual instanceof Response) return atual;
  return ok(await estadoAtalho(atual.usuario.id));
}

/**
 * Gera (ou troca) a chave do Atalho do iPhone. O valor só aparece nesta resposta; a anterior para de valer.
 * `instalar` leva a chave no fragmento (#), que não vai para servidor nenhum.
 */
export async function POST(req: Request) {
  const atual = await doSite(req, true);
  if (atual instanceof Response) return atual;
  const origem = origemPublica(origemDoPedido(req.headers, req.url));
  const { token, criadoEm } = await gerarAtalho(atual.usuario.id);
  return ok({ token, endpoint: `${origem}/api/referencias/atalho`, instalar: `${origem}/atalho#chave=${token}`, criadoEm: criadoEm.toISOString() }, 201);
}

/** Desliga a chave (o Atalho para de funcionar). */
export async function DELETE(req: Request) {
  const atual = await doSite(req, true);
  if (atual instanceof Response) return atual;
  await revogarAtalhos(atual.usuario.id);
  return ok({ ativo: false });
}

