import { MENSAGENS } from "@/lib/api/mensagens";
import { aguardar } from "@/lib/dispositivo";
import { erro, json, lerJson } from "@/lib/http";

/**
 * O computador pergunta se já foi liberado: `{ segredo }`.
 * 202 pendente · 200 pronto (o token sai uma vez só) · 410 expirado · 429 devagar.
 */
export async function POST(req: Request) {
  const corpo = await lerJson(req);
  const r = await aguardar(corpo?.segredo);
  switch (r.estado) {
    case "pendente":
      return json({ estado: "pendente" }, 202);
    case "pronto":
      return json({ estado: "pronto", token: r.token, usuario: r.usuario });
    case "devagar":
      return erro(429, "devagar", MENSAGENS.devagar, { "Retry-After": "3" });
    default:
      return erro(410, "expirado", MENSAGENS.expirado);
  }
}
