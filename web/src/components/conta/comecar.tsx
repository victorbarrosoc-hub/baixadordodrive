import Link from "next/link";
import { ArrowRight, Download, Laptop, Smartphone } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DOWNLOAD_MAC, DOWNLOAD_WINDOWS } from "@/lib/site";

/** "Comece por aqui": os dois jeitos de usar, logo depois de conectar o Drive. */
export function Comecar() {
  return (
    <Card className="mb-12 grid overflow-hidden sm:grid-cols-2">
      <div className="grid content-start gap-4 p-6">
        <span className="grid size-10 place-items-center rounded-xl bg-up/10 text-up-text">
          <Smartphone className="size-5" aria-hidden="true" />
        </span>
        <div className="grid gap-1">
          <h2 className="text-[17px] font-semibold tracking-tight">Enviar agora</h2>
          <p className="text-[14px] leading-relaxed text-ink-2">Do celular ou deste navegador, direto para o seu Drive.</p>
        </div>
        <Link href="/app/" className={buttonClasses({ variant: "primary", size: "md", className: "w-full" })}>
          Enviar arquivos
          <ArrowRight aria-hidden="true" />
        </Link>
      </div>
      <div className="grid content-start gap-4 border-t border-line p-6 sm:border-t-0 sm:border-l">
        <span className="grid size-10 place-items-center rounded-xl bg-down/10 text-down-text">
          <Laptop className="size-5" aria-hidden="true" />
        </span>
        <div className="grid gap-1">
          <h2 className="text-[17px] font-semibold tracking-tight">No computador</h2>
          <p className="text-[14px] leading-relaxed text-ink-2">Para os arquivos gigantes. Instale e toque em Entrar com a conta SOBEDESCE.</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <a href={DOWNLOAD_MAC} className={buttonClasses({ variant: "secondary", size: "md" })}>
            <Download aria-hidden="true" />
            Mac
          </a>
          <a href={DOWNLOAD_WINDOWS} className={buttonClasses({ variant: "secondary", size: "md" })}>
            <Download aria-hidden="true" />
            Windows
          </a>
        </div>
      </div>
    </Card>
  );
}
