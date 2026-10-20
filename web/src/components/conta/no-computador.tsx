import { Download, Laptop } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { Comando } from "@/components/comando";
import { DOWNLOAD_MAC, DOWNLOAD_WINDOWS, INSTALAR_MAC, INSTALAR_WINDOWS } from "@/lib/site";

/** "No computador": baixar para Mac ou Windows, ou instalar pelo Terminal/PowerShell sem o aviso de app não verificado. */
export function NoComputador() {
  return (
    <div className="grid content-start gap-4 p-6">
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
      <div className="grid gap-3 border-t border-line pt-4">
        <p className="text-[13px] leading-relaxed text-ink-2">
          <b className="font-semibold text-ink">Sem o aviso de app não verificado.</b> Cole no Terminal do Mac ou no PowerShell do Windows: ele
          baixa, confere e instala.
        </p>
        <div className="grid gap-1.5">
          <span className="text-[12px] font-medium text-ink-3">Mac · Terminal</span>
          <Comando comando={INSTALAR_MAC} rotulo="Comando para instalar no Mac pelo Terminal" />
        </div>
        <div className="grid gap-1.5">
          <span className="text-[12px] font-medium text-ink-3">Windows · PowerShell</span>
          <Comando comando={INSTALAR_WINDOWS} rotulo="Comando para instalar no Windows pelo PowerShell" />
        </div>
      </div>
    </div>
  );
}
