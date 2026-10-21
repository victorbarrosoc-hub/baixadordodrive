"use client";

import { Check, Cloud, Lock } from "lucide-react";
import { useRef } from "react";
import { span, useClock } from "./demo-kit";
import { usePrefersReducedMotion } from "./motion";

/**
 * Entre computadores (docs/LAN.md): do Mac para o PC do editor, pela rede, cifrado; cada arquivo conferido nos dois
 * lados. Com "Subir pro Drive ao mesmo tempo", a nuvem acende junto.
 */
const T = 7.5;
const ARQS = [
  { nome: "A001_C012.braw", a: 0.4, b: 2.6 },
  { nome: "Som_Dia01.wav", a: 2.6, b: 3.6 },
  { nome: "Projeto.prproj", a: 3.6, b: 5.6 },
] as const;
const PACOTES = 4;
const STILL = 4.6;

export function LanDemo() {
  const rootRef = useRef<HTMLDivElement>(null);
  const pacRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const okRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const reduce = usePrefersReducedMotion();

  const paint = (t: number) => {
    const andando = t >= 0.3 && t < 5.6;
    pacRefs.current.forEach((el, i) => {
      if (!el) return;
      const ciclo = ((t * 0.8 + i / PACOTES) % 1 + 1) % 1;
      el.style.left = `${22 + ciclo * 56}%`;
      el.style.opacity = andando ? (Math.min(1, ciclo * 6) * Math.min(1, (1 - ciclo) * 6)).toFixed(3) : "0";
    });
    const some = 1 - span(t, T - 0.5, T);
    ARQS.forEach((f, i) => {
      const p = span(t, f.a, f.b) * some;
      const bar = barRefs.current[i];
      if (bar) bar.style.transform = `scaleX(${p.toFixed(4)})`;
      const ok = okRefs.current[i];
      if (ok) ok.style.opacity = t >= f.b + 0.15 ? String(some) : "0";
    });
    const root = rootRef.current;
    const nuvem = andando ? "1" : "";
    if (root && root.dataset.nuvem !== nuvem) root.dataset.nuvem = nuvem;
  };

  useClock(rootRef, T, paint, reduce, STILL);

  const laptop = (nome: string) => (
    <span className="grid justify-items-center gap-1.5">
      <span className="grid justify-items-center">
        <span className="h-[48px] w-[74px] rounded-t-[8px] bg-surface-2 ring-1 ring-line-strong" />
        <span className="h-1.5 w-[90px] rounded-b-[4px] bg-surface-2 ring-1 ring-line-strong" />
      </span>
      <span className="text-[11px] font-medium whitespace-nowrap text-ink-2">{nome}</span>
    </span>
  );

  return (
    <div ref={rootRef} data-nuvem="" className="group/l grid gap-5 select-none" aria-hidden="true">
      <div className="relative flex items-start justify-between">
        {laptop("Seu Mac")}
        <span className="absolute top-[24px] right-[22%] left-[22%] h-px bg-line-strong" />
        {Array.from({ length: PACOTES }, (_, i) => (
          <span
            key={i}
            ref={(el) => {
              pacRefs.current[i] = el;
            }}
            className="absolute top-[24px] grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-md bg-up text-white shadow-md"
            style={{ opacity: 0 }}
          >
            <Lock className="size-2.5" strokeWidth={2.6} />
          </span>
        ))}
        {laptop("PC do editor")}
        <span className="absolute -top-1 right-0 grid size-7 translate-x-1 -translate-y-3 place-items-center rounded-full bg-surface-2 text-ink-3 ring-1 ring-line transition-colors duration-300 group-data-[nuvem=1]/l:bg-down/12 group-data-[nuvem=1]/l:text-down-text">
          <Cloud className="size-3.5" />
        </span>
      </div>

      <ul className="grid gap-2.5">
        {ARQS.map((f, i) => (
          <li key={f.nome} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5">
            <span className="truncate font-mono text-[12px] text-ink">{f.nome}</span>
            <span
              ref={(el) => {
                okRefs.current[i] = el;
              }}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-ok-text transition-opacity duration-300"
              style={{ opacity: 0 }}
            >
              <Check className="size-3" strokeWidth={3} />
              conferido
            </span>
            <span className="relative col-span-2 h-1 overflow-hidden rounded-full bg-ink/8">
              <span
                ref={(el) => {
                  barRefs.current[i] = el;
                }}
                className="absolute inset-0 origin-left rounded-full bg-up will-change-transform"
                style={{ transform: "scaleX(0)" }}
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
