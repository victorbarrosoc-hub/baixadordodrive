import { computadoresDaConta, ONLINE_MS } from "@/lib/lan/presenca";
import { SEM_SESSAO, usuarioDaRequisicao } from "@/lib/auth/requisicao";
import { erro, json } from "@/lib/http";

/**
 * "Entre computadores" (docs/LAN.md): os outros computadores da conta com a recepção ligada, com o endereço na rede e
 * a chave de recepção. Só a sessão de dispositivo (Bearer sdd_): a chave não sai para o site nem para o celular.
 */
export async function GET(req: Request) {
  const atual = await usuarioDaRequisicao(req);
  if (!atual) return SEM_SESSAO();
  if (atual.via !== "bearer" || atual.sessao.tipo !== "dispositivo") return erro(403, "so_computador", "Só o app de computador manda arquivos pela rede.");
  const computadores = await computadoresDaConta(atual.usuario.id, atual.sessao.id);
  return json({ onlineMs: ONLINE_MS, computadores }, 200, { "cache-control": "no-store" });
}
