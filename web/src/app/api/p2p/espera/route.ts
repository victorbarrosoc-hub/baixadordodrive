import { after } from "next/server";
import { exigirNaApi } from "@/lib/auth/requisicao";
import { ipDe, json } from "@/lib/http";
import { ESPERA_MS, esperar, limpar, nomeDoAparelho } from "@/lib/p2p/sinais";

/** A espera longa: dá tempo de segurar ESPERA_MS e responder. */
export const maxDuration = 40;

/**
 * Celular ↔ computador pelo Wi-Fi (docs/CELULAR-WIFI.md): o aparelho com o app aberto fica aqui esperando sinais
 * (oferta, resposta, recusa, cancela). Também marca que ele está online. Cookie (celular) ou Bearer (computador).
 * `outros=1`: aceita pedidos de outras pessoas na mesma rede (sempre perguntando). `curto=1` responde na hora.
 */
export async function GET(req: Request) {
  const atual = await exigirNaApi(req, { mutacao: false });
  if (atual instanceof Response) return atual;
  const url = new URL(req.url);
  const nome = nomeDoAparelho(atual, url.searchParams.get("nome"), req.headers.get("user-agent"));
  const ms = url.searchParams.get("curto") === "1" ? 0 : ESPERA_MS;
  const outros = url.searchParams.get("outros") === "1";
  const sinais = await esperar(atual, { nome, ip: ipDe(req.headers), outros, ms, sinal: req.signal });
  // De vez em quando, limpa sinais vencidos e aparelhos sumidos (depois da resposta).
  if (Math.random() < 0.05) {
    try {
      after(() => limpar().catch(() => {}));
    } catch {
      void limpar().catch(() => {}); // fora de um pedido de verdade (testes): limpa sem esperar
    }
  }
  return json({ agora: Date.now(), sinais }, 200, { "cache-control": "no-store" });
}
