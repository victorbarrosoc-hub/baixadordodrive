import { SEM_SESSAO, usuarioDaRequisicao } from "@/lib/auth/requisicao";
import { depoisDaResposta } from "@/lib/depois";
import { conferirErrosDoDia } from "@/lib/email/admin";
import { erro, json } from "@/lib/http";
import { gravarUso, usoSchema } from "@/lib/uso";

const LIMITE_BYTES = 8 * 1024;

/**
 * O app de computador conta os números do dia (docs/CONTAS.md §10): quanto subiu e desceu, erros, maior arquivo.
 * Só a sessão de dispositivo (Bearer sdd_). Nada de nome de arquivo: o formato nem tem onde pôr.
 */
export async function POST(req: Request) {
  const atual = await usuarioDaRequisicao(req);
  if (!atual) return SEM_SESSAO();
  if (atual.via !== "bearer" || atual.sessao.tipo !== "dispositivo") return erro(403, "so_computador", "Só o app de computador manda o uso.");
  let texto: string;
  try {
    texto = await req.text();
  } catch {
    return erro(400, "entrada", "Pedido incompleto.");
  }
  if (new TextEncoder().encode(texto).length > LIMITE_BYTES) return erro(413, "grande_demais", "Uso grande demais.");
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch {
    return erro(400, "entrada", "Pedido incompleto.");
  }
  const lido = usoSchema.safeParse(bruto);
  if (!lido.success) return erro(400, "entrada", "Uso em formato desconhecido.");
  const dias = await gravarUso(atual.sessao.id, atual.usuario.id, lido.data);
  const usuarioId = atual.usuario.id;
  for (const dia of dias.slice(-2)) depoisDaResposta(() => conferirErrosDoDia(usuarioId, dia));
  return json({ ok: true, dias: dias.length });
}
