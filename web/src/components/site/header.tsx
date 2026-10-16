import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { ROTAS } from "@/lib/site";
import { Logo } from "./logo";

const LINKS = [
  { href: "/#recursos", label: "Recursos" },
  { href: "/#celular", label: "Celular" },
  { href: "/#baixar", label: "Baixar" },
];

/** Cabeçalho fixo e translúcido do site público. */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-bg/75 backdrop-blur-xl backdrop-saturate-150 supports-[not(backdrop-filter:blur(1px))]:bg-bg">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-8">
        <Link href="/" aria-label="SOBEDESCE, início" className="flex shrink-0 items-center rounded-lg">
          <Logo />
        </Link>
        <nav aria-label="Seções" className="hidden items-center gap-7 md:flex">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="text-[13px] text-ink-2 transition-colors hover:text-ink">
              {l.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link href={ROTAS.entrar} className={buttonClasses({ variant: "ghost", size: "sm", className: "h-8 px-3.5 text-[13px] ring-1 ring-line-strong" })}>
            Entrar
          </Link>
          <Link href={ROTAS.criarConta} className={buttonClasses({ variant: "primary", size: "sm", className: "h-8 px-3.5 text-[13px]" })}>
            Criar conta
          </Link>
        </div>
      </div>
    </header>
  );
}
