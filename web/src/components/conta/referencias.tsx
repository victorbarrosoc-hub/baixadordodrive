import Link from "next/link";
import { ArrowRight, Bookmark } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/** Entrada das Referências em Sua conta (só aparece para quem tem o recurso). */
export function EntradaReferencias() {
  return (
    <Card className="mb-12 flex flex-col gap-4 p-6 sm:flex-row sm:items-center">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-ink ring-1 ring-line">
        <Bookmark className="size-5" aria-hidden="true" />
      </span>
      <div className="grid flex-1 gap-1">
        <h2 className="text-[17px] font-semibold tracking-tight">Referências</h2>
        <p className="text-[14px] leading-relaxed text-ink-2">
          Guarde vídeos do Instagram, do YouTube e do TikTok em coleções, numa pasta do seu Drive. O computador baixa.
        </p>
      </div>
      <Link href="/app/#referencias" className={buttonClasses({ variant: "secondary", size: "md", className: "shrink-0" })}>
        Abrir
        <ArrowRight aria-hidden="true" />
      </Link>
    </Card>
  );
}
