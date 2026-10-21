import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { ROTAS } from "@/lib/site";
import { Logo } from "./logo";

const LINKS = [
  { href: "/#recursos", label: "Recursos" },
  { href: "/#entre-aparelhos", label: "Entre aparelhos" },
  { href: "/#novidades", label: "Para criar" },
  { href: "/#baixar", label: "Plataformas" },
  { href: "/privacidade", label: "Privacidade" },
];

/** Cabeçalho fixo e translúcido do site público. */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-bg/75 backdrop-blur-xl backdrop-saturate-150 supports-[not(backdrop-filter:blur(1px))]:bg-bg">
      {/* De ponta a ponta: marca na esquerda, seções no meio, botões na direita (o meio fica centrado na tela). */}
      <div className="largura-cheia flex h-14 items-center justify-between gap-3 md:grid md:grid-cols-[1fr_auto_1fr] 2xl:h-16">
        <Link href="/" aria-label="SOBEDESCE, início" className="flex shrink-0 items-center justify-self-start rounded-lg">
          <Logo />
        </Link>
        <nav aria-label="Seções" className="hidden items-center gap-7 md:flex 2xl:gap-10">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="text-[13px] text-ink-2 transition-colors hover:text-ink 2xl:text-[15px]">
              {l.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2 justify-self-end">
          <Link href={ROTAS.entrar} className={buttonClasses({ variant: "ghost", size: "sm", className: "h-8 px-3.5 text-[13px] ring-1 ring-line-strong 2xl:h-10 2xl:px-5 2xl:text-[15px]" })}>
            Entrar
          </Link>
          <Link href={ROTAS.criarConta} className={buttonClasses({ variant: "primary", size: "sm", className: "h-8 px-3.5 text-[13px] 2xl:h-10 2xl:px-5 2xl:text-[15px]" })}>
            Criar conta
          </Link>
        </div>
      </div>
    </header>
  );
}
