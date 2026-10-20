"use client";

import { Folder, Star, Users } from "lucide-react";
import { useRef } from "react";
import { cn } from "@/lib/cn";
import { usePhases } from "./demo-kit";
import { usePrefersReducedMotion } from "./motion";

/** Meu Drive → a estrela acende → Favoritas → Compartilhadas comigo. */
const DURATIONS = [1500, 1300, 2400, 2400] as const;
const TABS = ["Meu Drive", "Favoritas", "Compartilhadas"] as const;

type Row = { nome: string; star?: boolean; de?: string };
const LISTS: Row[][] = [
  [{ nome: "Arquivo 2025" }, { nome: "Verão 26 — Brutos", star: true }, { nome: "Trilhas" }],
  [{ nome: "Verão 26 — Brutos", star: true }, { nome: "Entregas", star: true }, { nome: "Logos e fontes", star: true }],
  [
    { nome: "Color — Episódio 2", de: "M" },
    { nome: "Som direto, dia 3", de: "R" },
    { nome: "Fotos de cena", de: "A" },
  ],
];

/** Destino: favoritar a pasta que mais usa e achar as compartilhadas com você. */
export function FavDemo() {
  const rootRef = useRef<HTMLDivElement>(null);
  const reduce = usePrefersReducedMotion();
  const phase = usePhases(rootRef, DURATIONS, reduce, 2);
  const tab = phase <= 1 ? 0 : phase - 1;
  const lit = phase >= 1;

  return (
    <div ref={rootRef} className="grid gap-3" aria-hidden="true">
      <span className="inline-flex w-fit max-w-full rounded-full bg-surface-2 p-1 ring-1 ring-line">
        {TABS.map((x, i) => (
          <span
            key={x}
            className={cn(
              "inline-flex h-7 items-center rounded-full px-3 text-[12px] font-medium whitespace-nowrap transition-[background-color,color,box-shadow] duration-300",
              i === tab ? "bg-surface text-ink shadow-[0_1px_3px_rgba(0,0,0,0.12)]" : "text-ink-3",
            )}
          >
            {x}
          </span>
        ))}
      </span>
      <ul key={tab} className="grid divide-y divide-line overflow-hidden rounded-2xl ring-1 ring-line" style={reduce ? undefined : { animation: "sd-fade 0.45s var(--ease-out-soft) both" }}>
        {LISTS[tab].map((r) => {
          const on = r.star && (tab > 0 || lit);
          return (
            <li key={r.nome} className="flex h-11 min-w-0 items-center gap-2.5 px-3.5 text-[13px] text-ink">
              {r.de ? (
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-down/12 text-[11px] font-semibold text-down-text">{r.de}</span>
              ) : (
                <Folder className="size-4 shrink-0 text-ink-3" />
              )}
              <span className="truncate">{r.nome}</span>
              <span className="ml-auto shrink-0">
                {r.de ? (
                  <Users className="size-4 text-ink-3" />
                ) : (
                  <Star
                    className={cn(
                      "size-4 transition-[color,fill,transform] duration-500 ease-spring",
                      on ? "scale-110 fill-warn text-warn" : "fill-transparent text-ink-3/60",
                      on && tab === 0 && "scale-125",
                    )}
                  />
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
