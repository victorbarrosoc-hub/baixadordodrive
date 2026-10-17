import { MENSAGEM_LIMITE, REGRAS, dentroDoLimite, registrarTentativa } from "@/lib/auth/limite";
import { iniciar } from "@/lib/dispositivo";
import { erro, ipDe, json, lerJson, lugarDe } from "@/lib/http";

/** O computador pede um código: `{ nome, plataforma }` (sem sessão). */
export async function POST(req: Request) {
  const chave = `disp-iniciar:${ipDe(req.headers)}`;
  if (!(await dentroDoLimite(chave, REGRAS.dispositivoIniciar))) return erro(429, "devagar", MENSAGEM_LIMITE);
  await registrarTentativa(chave);
  const corpo = (await lerJson(req)) ?? {};
  // De onde veio o pedido aparece na tela de liberar (revisão A6: phishing com o link de liberar).
  return json(await iniciar({ nome: corpo.nome, plataforma: corpo.plataforma, lugar: lugarDe(req.headers) }));
}
