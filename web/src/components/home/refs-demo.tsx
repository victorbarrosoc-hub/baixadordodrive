"use client";

import { Folder, Link2, Sparkles } from "lucide-react";
import { useRef } from "react";
import { cn } from "@/lib/cn";
import { usePhases } from "./demo-kit";
import { usePrefersReducedMotion } from "./motion";

const LINKS = [
  { url: "instagram.com/reel/…", tag: "IG", bg: "linear-gradient(160deg,#3b2a4f,#c45a7a 60%,#f2b06a)" },
  { url: "youtube.com/watch?v=…", tag: "YT", bg: "linear-gradient(170deg,#1c2b3a,#3f6b8f 55%,#c9d6df)" },
  { url: "tiktok.com/@estudio/…", tag: "TT", bg: "linear-gradient(165deg,#101012,#2b4a45 50%,#7fc4b0)" },
] as const;

const BASE = [
  "linear-gradient(170deg,#2a2622,#8a6a4e 60%,#e5c9a0)",
  "linear-gradient(160deg,#121820,#44566a 55%,#a9b8c6)",
  "linear-gradient(175deg,#2c1f1a,#b0643f 55%,#f0c38f)",
];

/** Por link: digitar → salvar → cair na coleção. No fim, o "Link pra IA" acende. */
const DURATIONS = [1300, 450, 1050, 1300, 450, 1050, 1300, 450, 1050, 1900, 450] as const;
const IA = 9;
const RESET = 10;

/** Referências: cola um link, salva, e o vídeo cai na coleção do seu Drive. */
export function RefsDemo() {
  const rootRef = useRef<HTMLDivElement>(null);
  const reduce = usePrefersReducedMotion();
  const phase = usePhases(rootRef, DURATIONS, reduce, IA);
  const k = Math.min(2, Math.floor(phase / 3));
  const sub = phase < IA ? phase % 3 : 3;
  const dropped = phase >= IA ? 3 : k + (sub === 2 ? 1 : 0);
  const typing = phase < IA && sub < 2;
  const link = LINKS[k];

  return (
    <div ref={rootRef} className="grid gap-4" aria-hidden="true">
      <div className="flex h-10 items-center gap-2 rounded-full bg-surface-2 pr-1 pl-3 ring-1 ring-line">
        <Link2 className="size-4 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 overflow-hidden font-mono text-[12px] whitespace-nowrap">
          {typing ? (
            <span
              key={k}
              className="inline-block overflow-hidden border-r border-ink align-bottom text-ink"
              style={reduce ? undefined : { animation: `sd-type 0.9s steps(${link.url.length}) both`, ["--n" as string]: `${link.url.length}ch` }}
            >
              {link.url}
            </span>
          ) : (
            <span className="text-ink-3">Cole um link</span>
          )}
        </span>
        <span
          className={cn(
            "inline-flex h-8 shrink-0 items-center rounded-full px-3.5 text-[12px] font-medium transition-[transform,background-color,color] duration-200",
            sub === 1 ? "scale-95 bg-up text-white" : "bg-primary text-primary-fg",
          )}
        >
          Salvar
        </span>
      </div>

      <div className="grid gap-3 rounded-2xl p-3 ring-1 ring-line">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-ink">
            <Folder className="size-4 shrink-0 text-ink-3" />
            <span className="truncate">Luz de janela</span>
            <span className="text-ink-3 tabular-nums">· {BASE.length + dropped}</span>
          </span>
          <span
            className={cn(
              "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium transition-[background-color,color,box-shadow] duration-500",
              phase === IA ? "bg-up text-white shadow-[0_0_0_4px_rgba(124,92,255,0.18)]" : "bg-surface-2 text-ink-2",
            )}
          >
            <Sparkles className="size-3" />
            Link pra IA
          </span>
        </div>
        <div className={cn("grid grid-cols-6 gap-1.5 transition-opacity duration-300", phase === RESET && "opacity-0")}>
          {BASE.map((bg, i) => (
            <span key={i} className="aspect-[9/14] rounded-md" style={{ background: bg }} />
          ))}
          {LINKS.map((l, i) =>
            i < dropped ? (
              <span
                key={l.tag}
                className="relative aspect-[9/14] rounded-md"
                style={{ background: l.bg, animation: reduce ? undefined : "sd-drop 0.7s var(--ease-spring) both" }}
              >
                <span className="absolute bottom-1 left-1 rounded bg-black/45 px-1 text-[8px] leading-[12px] font-semibold text-white">{l.tag}</span>
              </span>
            ) : (
              <span key={l.tag} className="aspect-[9/14] rounded-md border border-dashed border-line-strong" />
            ),
          )}
        </div>
      </div>
    </div>
  );
}
