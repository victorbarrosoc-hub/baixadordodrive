import { chavesValidas, desinscrever, endpointValido, inscrever } from "@/lib/acompanhar/push";
import { exigirNaApi } from "@/lib/auth/requisicao";
import { erro, json, lerJson } from "@/lib/http";

/**
 * "Avisar no celular quando terminar" (docs/CONTAS.md §9): a inscrição de Web Push do aparelho
 * (`PushSubscription.toJSON()`: `{ endpoint, keys: { p256dh, auth } }`).
 */
export async function POST(req: Request) {
  const atual = await exigirNaApi(req, { mutacao: true });
  if (atual instanceof Response) return atual;
  const corpo = await lerJson(req, 4096);
  if (!corpo || !endpointValido(corpo.endpoint) || !chavesValidas(corpo.keys)) return erro(400, "entrada", "Inscrição inválida.");
  await inscrever(atual.usuario.id, corpo.endpoint, { p256dh: corpo.keys.p256dh, auth: corpo.keys.auth });
  return json({ ok: true }, 201);
}

export async function DELETE(req: Request) {
  const atual = await exigirNaApi(req, { mutacao: true });
  if (atual instanceof Response) return atual;
  const corpo = await lerJson(req, 4096);
  if (!corpo || typeof corpo.endpoint !== "string") return erro(400, "entrada", "Inscrição inválida.");
  const apagou = await desinscrever(atual.usuario.id, corpo.endpoint);
  return json({ ok: true, apagou });
}
