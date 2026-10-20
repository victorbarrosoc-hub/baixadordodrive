"use client";

import { Eye } from "lucide-react";
import { useRef } from "react";
import { cn } from "@/lib/cn";
import { usePhases } from "./demo-kit";
import { usePrefersReducedMotion } from "./motion";

/** Etapas: camadas separadas → imagem montada, na prancheta 1 e depois na 2. */
const DURATIONS = [1900, 2700, 1900, 2700] as const;

const ARTS = [
  { label: "Feed 4:5", w: 128, h: 160 },
  { label: "Story 9:16", w: 96, h: 170 },
] as const;

/** De cima para baixo, como no painel do Photoshop. */
const LAYERS = ["Título", "Produto", "Forma", "Fundo"] as const;

function Layer({ name, art }: { name: (typeof LAYERS)[number]; art: number }) {
  const story = art === 1;
  if (name === "Fundo") return <span className="absolute inset-0 bg-[linear-gradient(160deg,#f3e9dc,#dcc6ab)]" />;
  if (name === "Forma")
    return <span className={cn("absolute aspect-square rounded-full bg-[#ff8a5c]", story ? "top-[30%] left-[12%] w-[76%]" : "top-[22%] left-[30%] w-[62%]")} />;
  if (name === "Produto")
    return (
      <span
        className={cn(
          "absolute rounded-[6px] bg-[linear-gradient(90deg,#1d1d1f,#3a3a3e_45%,#1d1d1f)] shadow-[0_6px_10px_-4px_rgba(0,0,0,0.5)]",
          story ? "top-[42%] left-[36%] h-[40%] w-[28%]" : "top-[36%] left-[46%] h-[48%] w-[26%]",
        )}
      />
    );
  return (
    <span className={cn("absolute grid gap-[5px]", story ? "inset-x-[14%] top-[10%]" : "top-[12%] left-[10%] w-[52%]")}>
      <span className="h-[8px] w-full rounded-full bg-[#1d1d1f]" />
      <span className="h-[5px] w-2/3 rounded-full bg-[#1d1d1f]/45" />
    </span>
  );
}

/** PSD: o arquivo do Drive abre com pranchetas e camadas. As camadas se separam em 3D e voltam a montar a imagem. */
export function PsdDemo() {
  const rootRef = useRef<HTMLDivElement>(null);
  const reduce = usePrefersReducedMotion();
  const phase = usePhases(rootRef, DURATIONS, reduce, 0);
  const art = phase >= 2 ? 1 : 0;
  const open = phase % 2 === 0;
  const a = ARTS[art];

  return (
    <div ref={rootRef} className="grid gap-4" aria-hidden="true">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex rounded-full bg-surface-2 p-1 ring-1 ring-line">
          {ARTS.map((x, i) => (
            <span
              key={x.label}
              className={cn(
                "inline-flex h-7 items-center rounded-full px-3 text-[12px] font-medium whitespace-nowrap transition-[background-color,color,box-shadow] duration-300",
                i === art ? "bg-surface text-ink shadow-[0_1px_3px_rgba(0,0,0,0.12)]" : "text-ink-3",
              )}
            >
              {x.label}
            </span>
          ))}
        </span>
        <span className="truncate font-mono text-[11px] text-ink-3 sm:text-[12px]">verao.psd</span>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,128px)] items-center gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,144px)]">
        <div className="grid h-[210px] place-items-center overflow-hidden rounded-2xl bg-surface-2 [perspective:900px]">
          <div
            className="relative transition-[transform,width,height] duration-700 ease-out-soft [transform-style:preserve-3d]"
            style={{ width: a.w, height: a.h, transform: open ? "rotateX(56deg) rotateZ(-36deg) scale(0.86)" : "none" }}
          >
            {[...LAYERS].reverse().map((name, i) => (
              <span
                key={name}
                className={cn(
                  "absolute inset-0 overflow-hidden rounded-[6px] transition-[transform,box-shadow,background-color] duration-700 ease-out-soft",
                  open && name !== "Fundo" && "bg-white/25 shadow-[0_0_0_1px_rgba(29,29,31,0.18)]",
                  open && name === "Fundo" && "shadow-[0_10px_24px_-8px_rgba(0,0,0,0.35)]",
                  !open && name === "Fundo" && "shadow-[0_10px_24px_-12px_rgba(0,0,0,0.35)]",
                )}
                style={{ transform: open ? `translateZ(${i * 26}px)` : "translateZ(0)", transitionDelay: open ? `${i * 70}ms` : `${(3 - i) * 50}ms` }}
              >
                <Layer name={name} art={art} />
              </span>
            ))}
          </div>
        </div>

        <ul className="grid gap-1 rounded-xl bg-surface-2 p-1.5 ring-1 ring-line">
          {LAYERS.map((name) => (
            <li key={name} className="flex min-w-0 items-center gap-2 rounded-lg bg-surface px-2 py-1.5 text-[12px] text-ink">
              <Eye className="size-3.5 shrink-0 text-ink-3" />
              <span className="relative size-5 shrink-0 overflow-hidden rounded-[4px] bg-surface-2 ring-1 ring-line">
                <span className="absolute inset-0 origin-top-left scale-[0.16]" style={{ width: 128, height: 160 }}>
                  <Layer name={name} art={0} />
                </span>
              </span>
              <span className="truncate">{name}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
