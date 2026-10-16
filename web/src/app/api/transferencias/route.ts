import { chavePublica, pushAtivo } from "@/lib/acompanhar/push";
import { listarComputadores, ONLINE_MS } from "@/lib/acompanhar/status";
import { exigirNaApi } from "@/lib/auth/requisicao";
import { json } from "@/lib/http";

/**
 * O andamento das transferências dos computadores da conta (docs/CONTAS.md §9). Cookie (celular, site) ou Bearer.
 * `agora` é o relógio do servidor: o celular calcula "há 12 min" sem depender do relógio dele.
 */
export async function GET(req: Request) {
  const atual = await exigirNaApi(req, { mutacao: false });
  if (atual instanceof Response) return atual;
  const agora = Date.now();
  const computadores = await listarComputadores(atual.usuario.id, agora);
  return json({ ok: true, agora, onlineMs: ONLINE_MS, computadores, push: { ativo: pushAtivo(), chavePublica: chavePublica() } });
}
