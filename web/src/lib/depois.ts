/**
 * Trabalho para depois da resposta (e-mails de aviso): quem pede não espera, e um erro ali nunca volta para o fluxo.
 * Nas Server Actions e rotas, `depoisDaResposta` usa o `after` do Next (na Vercel a função espera a tarefa acabar).
 * Fora de um pedido (testes, scripts) o `after` lança: aí a tarefa roda já, sem ninguém esperar.
 */
import { after } from "next/server";

export type Depois = (tarefa: () => Promise<unknown>) => void;

/** Roda já, sem esperar e sem deixar erro escapar. */
export const emSegundoPlano: Depois = (tarefa) => {
  void tarefa().catch(() => console.warn("[depois] uma tarefa em segundo plano falhou."));
};

export const depoisDaResposta: Depois = (tarefa) => {
  try {
    after(() => tarefa().catch(() => console.warn("[depois] uma tarefa depois da resposta falhou.")));
  } catch {
    emSegundoPlano(tarefa);
  }
};
