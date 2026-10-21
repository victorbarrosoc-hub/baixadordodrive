import { ArrowDown, ArrowUp, Cloud, HardDrive, Wifi } from "lucide-react";
import { cn } from "@/lib/cn";
import { Reveal } from "./motion";

/**
 * Para onde o recurso leva o arquivo: sobe para o Drive, desce do Drive, os dois, usa direto do Drive, vai direto de um
 * aparelho para o outro pela rede, ou de um disco para outro.
 */
export type Dir = "sobe" | "desce" | "ambos" | "nuvem" | "rede" | "disco";

const DIR: Record<Dir, { label: string; cls: string }> = {
  sobe: { label: "Sobe pro Drive", cls: "bg-up/10 text-up-text" },
  desce: { label: "Desce do Drive", cls: "bg-down/10 text-down-text" },
  ambos: { label: "Sobe e desce", cls: "bg-ink/5 text-ink" },
  nuvem: { label: "Direto do Drive", cls: "bg-ink/5 text-ink" },
  rede: { label: "Direto pela rede", cls: "bg-ok/10 text-ok-text" },
  disco: { label: "Disco para disco", cls: "bg-ink/5 text-ink" },
};

/** Pílula de direção: a ideia do nome (sobe, desce ou já está na nuvem) em cada recurso. */
export function DirTag({ dir, label }: { dir: Dir; label?: string }) {
  const d = DIR[dir];
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium whitespace-nowrap", d.cls)}>
      {dir === "sobe" || dir === "ambos" ? <ArrowUp className={cn("size-3", dir === "ambos" && "text-up-text")} aria-hidden="true" /> : null}
      {dir === "desce" || dir === "ambos" ? <ArrowDown className={cn("size-3", dir === "ambos" && "-ml-1 text-down-text")} aria-hidden="true" /> : null}
      {dir === "nuvem" ? <Cloud className="size-3" aria-hidden="true" /> : null}
      {dir === "rede" ? <Wifi className="size-3" aria-hidden="true" /> : null}
      {dir === "disco" ? <HardDrive className="size-3" aria-hidden="true" /> : null}
      {label ?? d.label}
    </span>
  );
}

export function Card({ className, children, delay = 0 }: { className?: string; children: React.ReactNode; delay?: number }) {
  return (
    <Reveal delay={delay} className={cn("min-w-0 rounded-[24px] bg-surface p-6 ring-1 ring-line sm:p-8", className)}>
      {children}
    </Reveal>
  );
}

/** Sobretítulo (com a direção à direita), título curto e no máximo uma linha. */
export function CardTitle({
  eyebrow,
  title,
  text,
  tone,
  dir,
  dirLabel,
}: {
  eyebrow: string;
  title: string;
  text?: string;
  tone: string;
  dir?: Dir;
  dirLabel?: string;
}) {
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className={cn("text-[13px] font-semibold", tone)}>{eyebrow}</p>
        {dir ? <DirTag dir={dir} label={dirLabel} /> : null}
      </div>
      <h3 className="font-display text-[24px] leading-tight font-semibold tracking-[-0.02em] text-balance text-ink sm:text-[28px]">{title}</h3>
      {text ? <p className="max-w-md text-[15px] leading-relaxed text-ink-2">{text}</p> : null}
    </div>
  );
}
