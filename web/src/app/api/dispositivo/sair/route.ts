import { revogarSessao } from "@/lib/auth/sessao";
import { usuarioDaRequisicao, SEM_SESSAO } from "@/lib/auth/requisicao";
import { semConteudo } from "@/lib/http";

/** O computador sai da conta: revoga a própria sessão (só Bearer). */
export async function POST(req: Request) {
  if (!req.headers.get("authorization")) return SEM_SESSAO();
  const atual = await usuarioDaRequisicao(req);
  if (!atual || atual.via !== "bearer") return SEM_SESSAO();
  await revogarSessao(atual.sessao.id);
  return semConteudo();
}
