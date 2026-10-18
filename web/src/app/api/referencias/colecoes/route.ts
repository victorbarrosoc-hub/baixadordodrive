import { origemDoPedido } from "@/lib/http";
import { erroGoogle, exigirReferencias, falha, MSG, ok } from "@/lib/referencias/api";
import { criarColecao, ErroColecao, listarColecoes, publica } from "@/lib/referencias/colecoes";
import { validarNome } from "@/lib/referencias/texto";
import { lerJson } from "@/lib/http";
import { origemPublica } from "@/lib/site";

/** Coleções da conta (docs/REFERENCIAS.md §3). Cookie do site ou Bearer do computador. */
export async function GET(req: Request) {
  const atual = await exigirReferencias(req, { mutacao: false });
  if (atual instanceof Response) return atual;
  const origem = origemPublica(origemDoPedido(req.headers, req.url));
  const { linhas, porColecao, raiz, raizes } = await listarColecoes(atual.usuario.id);
  return ok({ raiz, raizes, colecoes: linhas.map((l) => publica(l, origem, porColecao.get(l.id) ?? 0)) });
}

/** Nova coleção: `{ nome, contaGoogleId? }` → pasta no Drive + linha no banco. */
export async function POST(req: Request) {
  const atual = await exigirReferencias(req, { mutacao: true });
  if (atual instanceof Response) return atual;
  const corpo = await lerJson(req);
  if (!corpo) return falha(400, "entrada", MSG.entrada);
  const v = validarNome(corpo.nome);
  if (!v.ok) return falha(400, "nome", v.mensagem);
  const conta = corpo.contaGoogleId;
  if (conta !== undefined && conta !== null && (typeof conta !== "string" || conta.length > 64)) return falha(400, "entrada", MSG.entrada);
  try {
    const l = await criarColecao(atual.usuario.id, v.nome, conta || undefined);
    return ok({ colecao: publica(l, origemPublica(origemDoPedido(req.headers, req.url))) }, 201);
  } catch (e) {
    if (e instanceof ErroColecao) return falha(e.status, e.codigo, e.message);
    return erroGoogle(e);
  }
}
