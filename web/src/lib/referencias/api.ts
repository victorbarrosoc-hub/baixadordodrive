/**
 * Peças comuns das rotas /api/referencias/* (docs/REFERENCIAS.md §3): sessão + recurso liberado, respostas
 * `{ ok, ... }` sem cache e a tradução dos erros do Google.
 */
import { MENSAGENS } from "@/lib/api/mensagens";
import { exigirNaApi } from "@/lib/auth/requisicao";
import type { Autenticado } from "@/lib/auth/sessao";
import { ErroConta } from "@/lib/google/contas";
import { ErroDrive } from "@/lib/google/drive";
import { json } from "@/lib/http";
import { podeUsar } from "@/lib/recursos";

export function ok(dados: Record<string, unknown> = {}, status = 200): Response {
  return json({ ok: true, ...dados }, status);
}

/** Erro no formato das Referências: `{ ok: false, erro, mensagem }` (+ campos extras, como `motivo`). */
export function falha(status: number, erro: string, mensagem: string, extras: Record<string, unknown> = {}): Response {
  return json({ ok: false, erro, mensagem, ...extras }, status);
}

/** Sessão (cookie com Origin nas mutações, ou Bearer do computador) e o recurso liberado para a conta. */
export async function exigirReferencias(req: Request, opcoes: { mutacao: boolean }): Promise<Autenticado | Response> {
  const atual = await exigirNaApi(req, opcoes);
  if (atual instanceof Response) {
    // Mesmo formato das outras respostas daqui, com o código de sempre.
    const corpo = (await atual.clone().json().catch(() => ({}))) as { erro?: string; mensagem?: string };
    return falha(atual.status, corpo.erro ?? "sem_sessao", corpo.mensagem ?? "Entre na sua conta para continuar.");
  }
  if (!(await podeUsar(atual.usuario, "referencias"))) {
    return falha(403, "plano", "As Referências fazem parte do plano Produtora.", { motivo: "plano" });
  }
  return atual;
}

const STATUS_CONTA: Record<ErroConta["codigo"], number> = { nao_encontrada: 404, reconectar: 409, google: 502, sem_config: 503 };

/** Erro do Google (conta ou Drive) → resposta. Outros erros sobem. */
export function erroGoogle(e: unknown): Response {
  if (e instanceof ErroConta) return falha(STATUS_CONTA[e.codigo], e.codigo, MENSAGENS[e.codigo]);
  if (e instanceof ErroDrive) {
    if (e.status === 403 && /insufficient|forbidden/i.test(e.motivo ?? "")) return falha(409, "reconectar", MENSAGENS.reconectar);
    return falha(502, "google", e.status === 0 ? "O Google não respondeu agora. Tente de novo em instantes." : MENSAGENS.google);
  }
  throw e;
}

export const MSG = {
  entrada: "Pedido incompleto.",
  colecao: "Esta coleção não existe mais.",
  item: "Este link não está mais na fila.",
} as const;
