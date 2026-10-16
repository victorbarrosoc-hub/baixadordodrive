import { statusSchema, LIMITE_BYTES } from "@/lib/acompanhar/formato";
import { apagarStatus, gravarStatus } from "@/lib/acompanhar/status";
import { SEM_SESSAO, usuarioDaRequisicao } from "@/lib/auth/requisicao";
import { erro, json, semConteudo } from "@/lib/http";

/**
 * O app de computador conta como andam as transferências (docs/CONTAS.md §9). Só a sessão de dispositivo
 * (Bearer sdd_): o celular e o site só leem, em GET /api/transferencias.
 */
async function computador(req: Request) {
  const atual = await usuarioDaRequisicao(req);
  if (!atual) return SEM_SESSAO();
  if (atual.via !== "bearer" || atual.sessao.tipo !== "dispositivo") return erro(403, "so_computador", "Só o app de computador manda o andamento.");
  return atual;
}

export async function POST(req: Request) {
  const atual = await computador(req);
  if (atual instanceof Response) return atual;
  const tamanho = Number(req.headers.get("content-length"));
  if (Number.isFinite(tamanho) && tamanho > LIMITE_BYTES) return erro(413, "grande_demais", "Andamento grande demais.");
  let texto: string;
  try {
    texto = await req.text();
  } catch {
    return erro(400, "entrada", "Pedido incompleto.");
  }
  if (new TextEncoder().encode(texto).length > LIMITE_BYTES) return erro(413, "grande_demais", "Andamento grande demais.");
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch {
    return erro(400, "entrada", "Pedido incompleto.");
  }
  const lido = statusSchema.safeParse(bruto);
  if (!lido.success) return erro(400, "entrada", "Andamento em formato desconhecido.");
  const r = await gravarStatus({ id: atual.sessao.id, nome: atual.sessao.nome }, atual.usuario.id, lido.data);
  return json({ ok: true, avisados: r.avisados });
}

/** Ajuste "Acompanhar pelo celular" desligado: o andamento deste computador some. */
export async function DELETE(req: Request) {
  const atual = await computador(req);
  if (atual instanceof Response) return atual;
  await apagarStatus(atual.sessao.id);
  return semConteudo();
}
