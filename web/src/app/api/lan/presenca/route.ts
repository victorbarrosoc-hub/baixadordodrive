import { apagarPresenca, gravarPresenca, presencaSchema } from "@/lib/lan/presenca";
import { SEM_SESSAO, usuarioDaRequisicao } from "@/lib/auth/requisicao";
import { erro, ipDe, json, lerJson, semConteudo } from "@/lib/http";

/**
 * "Entre computadores" (docs/LAN.md): o app de computador com a recepção ligada avisa onde está na rede local.
 * Só a sessão de dispositivo (Bearer sdd_).
 */
async function computador(req: Request) {
  const atual = await usuarioDaRequisicao(req);
  if (!atual) return SEM_SESSAO();
  if (atual.via !== "bearer" || atual.sessao.tipo !== "dispositivo") return erro(403, "so_computador", "Só o app de computador recebe arquivos pela rede.");
  return atual;
}

export async function POST(req: Request) {
  const atual = await computador(req);
  if (atual instanceof Response) return atual;
  const corpo = await lerJson(req, 4 * 1024);
  const lido = presencaSchema.safeParse(corpo);
  if (!lido.success) return erro(400, "entrada", "Endereço da rede em formato desconhecido.");
  await gravarPresenca(atual.sessao.id, atual.usuario.id, lido.data, ipDe(req.headers));
  return json({ ok: true });
}

/** Recepção desligada: este computador some da lista dos outros. */
export async function DELETE(req: Request) {
  const atual = await computador(req);
  if (atual instanceof Response) return atual;
  await apagarPresenca(atual.sessao.id);
  return semConteudo();
}
