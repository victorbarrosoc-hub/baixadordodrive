import { usuarioDaRequisicao, SEM_SESSAO } from "@/lib/auth/requisicao";
import { listarContas } from "@/lib/google/contas";
import { json } from "@/lib/http";

/** Quem sou eu e quais Drives tenho (cookie do site ou Bearer do computador). */
export async function GET(req: Request) {
  const atual = await usuarioDaRequisicao(req);
  if (!atual) return SEM_SESSAO();
  return json({ usuario: atual.usuario, contas: await listarContas(atual.usuario.id) });
}
