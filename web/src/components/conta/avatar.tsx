"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

/** Foto da conta Google; sem foto (ou se não carregar), a inicial num círculo. */
export function Avatar({ src, nome, className }: { src: string | null; nome: string; className?: string }) {
  const [falhou, setFalhou] = useState(false);
  const inicial = (nome.trim()[0] ?? "?").toUpperCase();
  return (
    <span className={cn("relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-full bg-surface-2 text-[15px] font-semibold text-ink-2 ring-1 ring-line", className)}>
      {src && !falhou ? (
        // eslint-disable-next-line @next/next/no-img-element -- foto externa do Google, sem otimização
        <img src={src} alt="" referrerPolicy="no-referrer" className="size-full object-cover" onError={() => setFalhou(true)} />
      ) : (
        <span aria-hidden>{inicial}</span>
      )}
    </span>
  );
}
