import Link from "next/link";

/** Cabeçalho das telas de conta: só a marca (volta para a página inicial) e uma ação à direita. */
export function Cabecalho({ acao }: { acao?: React.ReactNode }) {
  return (
    <header className="mx-auto flex h-16 w-full max-w-[1080px] items-center justify-between px-5 sm:h-20 sm:px-8">
      <Link
        href="/"
        className="rounded-full text-[15px] font-semibold tracking-[0.16em] text-ink transition-opacity hover:opacity-70"
        aria-label="SOBEDESCE, página inicial"
      >
        SOBEDESCE
      </Link>
      {acao ? <div className="flex items-center gap-2">{acao}</div> : null}
    </header>
  );
}
