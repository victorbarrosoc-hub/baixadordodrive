import { cn } from "@/lib/cn";
import { Cabecalho } from "./cabecalho";

/**
 * Página das telas de conta: cabeçalho de ponta a ponta, título grande e muito respiro.
 * `estreita`: formulários de entrar e criar conta (centrados, como deve ser um formulário). Padrão: uma coluna de leitura.
 * `larga`: a conta e o admin, que se espalham pela tela no desktop (até 2240 px, em colunas nas próprias páginas).
 * Padrão do kit (components/kit): título e conteúdo entram em cascata; nas estreitas, o ícone em gradiente em cima e o
 * formulário num cartão (`icone` troca o desenho; sem ele, as barras da marca).
 */
export function Moldura({
  titulo,
  subtitulo,
  acao,
  estreita = false,
  larga = false,
  icone,
  children,
}: {
  titulo: React.ReactNode;
  subtitulo?: React.ReactNode;
  acao?: React.ReactNode;
  estreita?: boolean;
  larga?: boolean;
  icone?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col pb-[env(safe-area-inset-bottom)]">
      <Cabecalho acao={acao} />
      <main
        className={cn(
          "mx-auto w-full flex-1 pt-8 pb-20 sm:pt-16",
          larga ? "largura sm:px-8 lg:px-[clamp(32px,4vw,80px)]" : "px-5 sm:px-8",
          estreita ? "max-w-[420px]" : larga ? null : "max-w-[680px]",
        )}
      >
        <div className={cn("k-entra grid gap-3", estreita ? "mb-8 justify-items-center text-center" : "mb-10 sm:mb-12", larga && "xl:mb-14")}>
          {estreita ? (
            <span aria-hidden className="k-grad mb-2 grid size-14 place-items-center rounded-[18px] text-white shadow-[0_12px_28px_-12px_var(--color-up)] [&_svg]:size-6">
              {icone ?? (
                <span className="flex h-6 items-end gap-1.5">
                  <span className="block h-full w-2 origin-bottom animate-[sd-ini-barra_3.2s_ease-in-out_infinite] rounded-full bg-white" />
                  <span className="block h-[70%] w-2 origin-bottom animate-[sd-ini-barra_3.2s_ease-in-out_-1.6s_infinite] rounded-full bg-white/80" />
                </span>
              )}
            </span>
          ) : null}
          <h1
            className={cn(
              "font-display text-[34px] leading-[1.08] font-semibold tracking-[-0.025em] text-balance sm:text-[44px]",
              larga && "xl:text-[clamp(44px,3vw,64px)]",
            )}
          >
            {titulo}
          </h1>
          {subtitulo ? <p className={cn("text-[17px] leading-relaxed text-pretty text-ink-2", larga && "max-w-[65ch] xl:text-[19px]")}>{subtitulo}</p> : null}
        </div>
        {estreita ? (
          <div className="k-entra rounded-[24px] bg-surface p-5 shadow-[0_12px_32px_-18px_rgba(0,0,0,0.25)] ring-1 ring-line sm:p-7" style={{ "--i": 1 } as React.CSSProperties}>
            {children}
          </div>
        ) : (
          children
        )}
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
