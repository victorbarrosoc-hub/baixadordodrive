import { aplicarFiltro, buildPublicado, ehAdmin, ehFiltro, ehOrdem, filtrarPessoas, painelAdmin, paraCsv } from "@/lib/admin";
import { usuarioDaRequisicao } from "@/lib/auth/requisicao";
import { ehPlano } from "@/lib/recursos";

/** /admin/csv: a lista do admin (com a mesma busca e os mesmos filtros) em planilha. Quem não é admin vê 404. */
export async function GET(req: Request) {
  const atual = await usuarioDaRequisicao(req);
  if (!atual || atual.via !== "cookie" || !(await ehAdmin(atual.usuario))) return new Response("Não encontrado", { status: 404 });
  const q = new URL(req.url).searchParams;
  const f = q.get("f");
  const o = q.get("o");
  const plano = q.get("plano") ?? "";
  const agora = new Date();
  const buildAtual = await buildPublicado();
  const { pessoas } = await painelAdmin(agora, buildAtual);
  const lista = aplicarFiltro(
    filtrarPessoas(pessoas, (q.get("q") ?? "").slice(0, 100)),
    { filtro: ehFiltro(f) ? f : "todos", ordem: ehOrdem(o) ? o : "novas", plano: ehPlano(plano) ? plano : null, buildAtual },
    agora,
  );
  const dia = agora.toISOString().slice(0, 10);
  // BOM: o Excel abre os acentos certos.
  return new Response("﻿" + paraCsv(lista, buildAtual), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="sobedesce-contas-${dia}.csv"`,
      "cache-control": "no-store",
    },
  });
}
