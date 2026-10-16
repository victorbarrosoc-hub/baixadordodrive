import Link from "next/link";
import { CONTATO_EMAIL, ROTAS } from "@/lib/site";
import { Logo } from "./logo";

/** Rodapé do site público. */
export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-surface-2">
      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-12 sm:px-8 md:grid-cols-[1fr_auto] md:items-end">
        <div className="grid gap-3">
          <Logo />
          <p className="max-w-md text-[13px] leading-relaxed text-ink-2">
            Transferências rápidas e retomáveis para o Google Drive, feitas para arquivos gigantes de audiovisual. Feito em Natal, RN.
          </p>
        </div>
        <nav aria-label="Rodapé" className="flex flex-wrap gap-x-6 gap-y-3 text-[13px] text-ink-2">
          <Link href={ROTAS.privacidade} className="hover:text-ink">
            Privacidade
          </Link>
          <Link href={ROTAS.termos} className="hover:text-ink">
            Termos
          </Link>
          <a href={`mailto:${CONTATO_EMAIL}`} className="hover:text-ink">
            Contato
          </a>
        </nav>
      </div>
      <div className="mx-auto max-w-6xl px-5 pb-10 text-[12px] text-ink-3 sm:px-8">
        Google Drive é uma marca do Google LLC. A SOBEDESCE não é afiliada ao Google.
      </div>
    </footer>
  );
}
