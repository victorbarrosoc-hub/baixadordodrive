import Link from "next/link";

/** Cabeçalho das telas de conta: só a marca (volta para a página inicial) e uma ação à direita, nas pontas da tela. */
export function Cabecalho({ acao }: { acao?: React.ReactNode }) {
  return (
    // De ponta a ponta no desktop (margem fluida), como o cabeçalho do site.
    <header className="largura-cheia flex h-16 items-center justify-between sm:h-20 sm:px-8 lg:px-[clamp(32px,3vw,56px)]">
      <Link
        href="/"
        className="toque rounded-full text-[15px] font-semibold tracking-[0.16em] text-ink transition-opacity hover:opacity-70"
        aria-label="SOBEDESCE, página inicial"
      >
        SOBEDESCE
      </Link>
      {acao ? <div className="flex items-center gap-2">{acao}</div> : null}
    </header>
  );
}
