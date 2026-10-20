import { computadoresPorPerto, ONLINE_MS } from "@/lib/lan/presenca";
import { SEM_SESSAO, usuarioDaRequisicao } from "@/lib/auth/requisicao";
import { erro, ipDe, json } from "@/lib/http";

/**
 * "Entre computadores" (docs/LAN.md): computadores de OUTRAS contas na mesma rede que aceitam receber (pedindo para
 * aceitar na tela). Vai só a chave pública. Só a sessão de dispositivo (Bearer sdd_).
 */
export async function GET(req: Request) {
  const atual = await usuarioDaRequisicao(req);
  if (!atual) return SEM_SESSAO();
  if (atual.via !== "bearer" || atual.sessao.tipo !== "dispositivo") return erro(403, "so_computador", "Só o app de computador manda arquivos pela rede.");
  const computadores = await computadoresPorPerto(atual.usuario.id, ipDe(req.headers));
  return json({ onlineMs: ONLINE_MS, computadores }, 200, { "cache-control": "no-store" });
}
