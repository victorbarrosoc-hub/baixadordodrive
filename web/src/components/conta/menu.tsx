import Link from "next/link";
import { LogOut, Upload } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";

/** Ações da área logada, à direita do cabeçalho: enviar (o uso principal), baixar o app e sair. */
export function MenuConta() {
  return (
    <nav aria-label="Plataforma" className="flex items-center gap-1.5 sm:gap-2">
      <Link href="/app/" className={buttonClasses({ variant: "primary", size: "sm" })}>
        <Upload aria-hidden="true" />
        Enviar
      </Link>
      <span className="hidden sm:contents">
        <Link href="/#baixar" className={buttonClasses({ variant: "ghost", size: "sm" })}>
          Baixar app
        </Link>
      </span>
      <Link href="/sair" className={buttonClasses({ variant: "ghost", size: "sm", className: "px-3" })} aria-label="Sair">
        <LogOut aria-hidden="true" />
        <span className="hidden sm:inline">Sair</span>
      </Link>
    </nav>
  );
}
