import Link from "next/link";
import { ArrowRight, MonitorUp } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { tamanho, type Computador } from "@/lib/acompanhar/formato";

const ANDANDO = new Set(["enviando", "baixando", "pausado"]);

/** Uma linha por computador com algo andando: "MacBook de Victor · 62% · 5 de 8 arquivos". */
function linha(c: Computador): string {
  const g = c.snapshot.geral;
  const pct = g.totalBytes ? Math.floor((g.feitoBytes / g.totalBytes) * 100) : 0;
  const partes = [c.nome, `${pct}%`, `${g.feitos} de ${g.total} ${g.total === 1 ? "arquivo" : "arquivos"}`];
  if (c.snapshot.estado === "pausado") partes.push("pausado");
  else if (!c.online) partes.push("sem notícia");
  return partes.join(" · ");
}

/**
 * "Transferências agora" em Sua conta (docs/CONTAS.md §9): o que os computadores estão passando, com o link para a
 * tela "No computador" do app do celular. Só aparece para quem tem computador conectado.
 */
export function TransferenciasAgora({ computadores }: { computadores: Computador[] }) {
  const andando = computadores.filter((c) => ANDANDO.has(c.snapshot.estado));
  const pronto = computadores.find((c) => c.snapshot.estado === "concluido");
  let texto = "Veja no celular quanto falta do que ficou passando no computador, e receba um aviso quando terminar.";
  if (andando.length) texto = andando.map(linha).join("\n");
  else if (pronto) texto = `${pronto.nome}: pronto, ${pronto.snapshot.geral.feitos} ${pronto.snapshot.geral.feitos === 1 ? "arquivo" : "arquivos"} · ${tamanho(pronto.snapshot.geral.feitoBytes)}.`;
  return (
    <Card className="mb-12 flex flex-col gap-4 p-6 sm:flex-row sm:items-center">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink ring-1 ring-line">
        <MonitorUp className="size-5" aria-hidden="true" />
      </span>
      <div className="grid flex-1 gap-1">
        <h2 className="text-[17px] font-semibold tracking-tight">Transferências agora</h2>
        <p className="text-[14px] leading-relaxed whitespace-pre-line text-ink-2">{texto}</p>
      </div>
      <Link href="/app/#computador" className={buttonClasses({ variant: "secondary", size: "md", className: "shrink-0" })}>
        Acompanhar
        <ArrowRight aria-hidden="true" />
      </Link>
    </Card>
  );
}
