/** Peças comuns das rotas /api/proxies/* (docs/CONTAS.md §11): sessão (cookie ou Bearer do computador) e respostas `{ ok, ... }`. */
import { exigirNaApi } from "@/lib/auth/requisicao";
import type { Autenticado } from "@/lib/auth/sessao";
import { falha } from "@/lib/referencias/api";

export { falha, ok } from "@/lib/referencias/api";

export async function exigirProxies(req: Request, opcoes: { mutacao: boolean }): Promise<Autenticado | Response> {
  const atual = await exigirNaApi(req, opcoes);
  if (!(atual instanceof Response)) return atual;
  const corpo = (await atual.clone().json().catch(() => ({}))) as { erro?: string; mensagem?: string };
  return falha(atual.status, corpo.erro ?? "sem_sessao", corpo.mensagem ?? "Entre na sua conta para continuar.");
}

export const MSG = {
  entrada: "Pedido incompleto.",
  conta: "Esta conta do Google não está ligada a você.",
  pedido: "Este pedido não existe mais.",
} as const;

/** Id de arquivo do Drive. */
export const ID_DRIVE = /^[A-Za-z0-9_-]{1,200}$/;
