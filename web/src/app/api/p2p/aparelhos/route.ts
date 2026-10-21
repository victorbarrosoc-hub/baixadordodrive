import { exigirNaApi } from "@/lib/auth/requisicao";
import { ipDe, json } from "@/lib/http";
import { aparelhosOnline } from "@/lib/p2p/sinais";

/** Os aparelhos do outro tipo (o celular vê computadores; o computador, celulares) da conta, online agora. */
export async function GET(req: Request) {
  const atual = await exigirNaApi(req, { mutacao: false });
  if (atual instanceof Response) return atual;
  const aparelhos = await aparelhosOnline(atual, ipDe(req.headers));
  return json({ aparelhos }, 200, { "cache-control": "no-store" });
}
