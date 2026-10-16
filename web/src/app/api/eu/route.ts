import { usuarioDaRequisicao, SEM_SESSAO } from "@/lib/auth/requisicao";
import { listarContas } from "@/lib/google/contas";
import { json } from "@/lib/http";
import { recursosDe } from "@/lib/recursos";

/** Quem sou eu, quais Drives tenho e quais recursos a conta usa (cookie do site ou Bearer do computador). */
export async function GET(req: Request) {
  const atual = await usuarioDaRequisicao(req);
  if (!atual) return SEM_SESSAO();
  const [contas, recursos] = await Promise.all([listarContas(atual.usuario.id), recursosDe(atual.usuario)]);
  return json({ usuario: atual.usuario, contas, recursos });
}
