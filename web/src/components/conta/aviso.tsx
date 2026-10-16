import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { cn } from "@/lib/cn";

type Tom = "info" | "ok" | "erro";

const TONS: Record<Tom, { classe: string; Icone: typeof Info }> = {
  info: { classe: "bg-surface-2 text-ink", Icone: Info },
  ok: { classe: "bg-ok/10 text-ink", Icone: CircleCheck },
  erro: { classe: "bg-err/10 text-ink", Icone: CircleAlert },
};

const COR_ICONE: Record<Tom, string> = { info: "text-ink-2", ok: "text-ok-text", erro: "text-err-text" };

/** Recado calmo: ícone pequeno, texto curto, sem gritar. */
export function Aviso({ tom = "info", children, className }: { tom?: Tom; children: React.ReactNode; className?: string }) {
  const { classe, Icone } = TONS[tom];
  return (
    <div role={tom === "erro" ? "alert" : "status"} className={cn("flex gap-3 rounded-2xl px-4 py-3.5 text-[15px] leading-relaxed", classe, className)}>
      <Icone aria-hidden className={cn("mt-[3px] size-[18px] shrink-0", COR_ICONE[tom])} />
      <div className="grid gap-1 text-pretty">{children}</div>
    </div>
  );
}
