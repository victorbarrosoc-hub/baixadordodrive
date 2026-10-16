import { MENSAGENS } from "@/lib/api/mensagens";
import { exigirNaApi } from "@/lib/auth/requisicao";
import { ErroConta, tokenDeAcesso } from "@/lib/google/contas";
import { erro, json, lerJson } from "@/lib/http";

const STATUS: Record<ErroConta["codigo"], number> = { nao_encontrada: 404, reconectar: 409, google: 502, sem_config: 503 };

/**
 * Access token de uma conta Google da pessoa: `{ conta, renovar? }` → `{ accessToken, expiraEm, email }`.
 * Nunca devolve o refresh token.
 */
export async function POST(req: Request) {
  const atual = await exigirNaApi(req, { mutacao: true });
  if (atual instanceof Response) return atual;
  const corpo = await lerJson(req);
  const conta = corpo?.conta;
  if (typeof conta !== "string" || !conta || conta.length > 64) return erro(400, "entrada", MENSAGENS.entrada);
  try {
    const t = await tokenDeAcesso(atual.usuario.id, conta, { renovar: corpo?.renovar === true });
    return json({ accessToken: t.accessToken, expiraEm: t.expiraEm, email: t.email });
  } catch (e) {
    if (e instanceof ErroConta) return erro(STATUS[e.codigo], e.codigo, MENSAGENS[e.codigo]);
    throw e;
  }
}
