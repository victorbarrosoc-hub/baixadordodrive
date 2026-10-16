import { cn } from "@/lib/cn";
import { Cabecalho } from "./cabecalho";

/**
 * Página das telas de conta: cabeçalho, título grande e muito respiro.
 * `estreita`: formulários de entrar e criar conta. Larga: a conta.
 */
export function Moldura({
  titulo,
  subtitulo,
  acao,
  estreita = false,
  children,
}: {
  titulo: React.ReactNode;
  subtitulo?: React.ReactNode;
  acao?: React.ReactNode;
  estreita?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col pb-[env(safe-area-inset-bottom)]">
      <Cabecalho acao={acao} />
      <main className={cn("mx-auto w-full flex-1 px-5 pt-8 pb-20 sm:px-8 sm:pt-16", estreita ? "max-w-[420px]" : "max-w-[680px]")}>
        <div className={cn("grid gap-3", estreita ? "mb-9 text-center sm:mb-10" : "mb-10 sm:mb-12")}>
          <h1 className="font-display text-[34px] leading-[1.08] font-semibold tracking-[-0.025em] text-balance sm:text-[44px]">{titulo}</h1>
          {subtitulo ? <p className="text-[17px] leading-relaxed text-pretty text-ink-2">{subtitulo}</p> : null}
        </div>
        {children}
      </main>
    </div>
  );
}

/** Bloco com título discreto acima do cartão (como os Ajustes do iPhone). */
export function Secao({ titulo, descricao, children, id }: { titulo: string; descricao?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section className="mt-12 first:mt-0" aria-labelledby={id}>
      <div className="mb-3 grid gap-1 px-1">
        <h2 id={id} className="text-[20px] font-semibold tracking-[-0.01em]">
          {titulo}
        </h2>
        {descricao ? <p className="text-[15px] text-pretty text-ink-2">{descricao}</p> : null}
      </div>
      {children}
    </section>
  );
}
