"use client";

import { Check, HardDrive } from "lucide-react";
import { useRef } from "react";
import { span, useClock } from "./demo-kit";
import { usePrefersReducedMotion } from "./motion";

/**
 * Entre discos (docs/DISCOS.md): o cartão é lido uma vez e gravado nos três destinos ao mesmo tempo (as barras andam
 * juntas); depois cada destino é conferido (xxHash64) e ganha o check. O gráfico desenha a velocidade.
 */
const T = 8;
const COPIA_A = 0.4;
const COPIA_B = 4.6;
const CONFERE = [4.9, 5.3, 5.7] as const;
const DESTINOS = ["SSD do projeto", "HD backup 1", "HD backup 2"] as const;
const STILL = 3.2;
/** Formato do gráfico de velocidade (só a forma, sem número): sobe rápido e fica alto, com respiros. */
const GRAFICO = "M0,34 C6,30 8,10 16,9 S28,7 34,8 S46,12 52,9 S64,6 70,8 S82,10 88,7 S96,8 100,8";

export function DiscosDemo() {
  const rootRef = useRef<HTMLDivElement>(null);
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const okRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const revelaRef = useRef<SVGRectElement>(null);
  const reduce = usePrefersReducedMotion();

  const paint = (t: number) => {
    const some = 1 - span(t, T - 0.5, T);
    const p = span(t, COPIA_A, COPIA_B) * some;
    barRefs.current.forEach((el) => {
      if (el) el.style.transform = `scaleX(${p.toFixed(4)})`;
    });
    okRefs.current.forEach((el, i) => {
      if (el) el.style.opacity = t >= CONFERE[i] ? String(some) : "0";
    });
    if (revelaRef.current) revelaRef.current.setAttribute("width", (p * 100).toFixed(2));
    const root = rootRef.current;
    const lendo = t >= COPIA_A && t < COPIA_B ? "1" : "";
    if (root && root.dataset.lendo !== lendo) root.dataset.lendo = lendo;
  };

  useClock(rootRef, T, paint, reduce, STILL);

  return (
    <div ref={rootRef} data-lendo="" className="group/d grid gap-4 select-none" aria-hidden="true">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-4">
        {/* O cartão: lido uma vez só. */}
        <span className="relative grid h-[92px] w-[74px] place-items-end overflow-hidden bg-surface-2 p-2 [clip-path:polygon(0_0,72%_0,100%_18%,100%_100%,0_100%)]">
          <span className="absolute top-2 left-2.5 flex gap-[3px]">
            {Array.from({ length: 5 }, (_, i) => (
              <span key={i} className="h-2.5 w-1 rounded-[1px] bg-ink/15" />
            ))}
          </span>
          <span className="absolute inset-0 bg-[linear-gradient(180deg,transparent,var(--color-down))] opacity-0 transition-opacity duration-500 group-data-[lendo=1]/d:opacity-25" />
          <span className="relative text-[11px] font-semibold text-ink">Cartão</span>
        </span>

        <ul className="grid gap-2.5">
          {DESTINOS.map((d, i) => (
            <li key={d} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1">
              <HardDrive className="size-4 text-ink-3" />
              <span className="truncate text-[12px] font-medium text-ink">{d}</span>
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
              <span className="relative col-span-3 h-1 overflow-hidden rounded-full bg-ink/8">
                <span
                  ref={(el) => {
                    barRefs.current[i] = el;
                  }}
                  className="absolute inset-0 origin-left rounded-full bg-[linear-gradient(90deg,var(--color-down),var(--color-up))] will-change-transform"
                  style={{ transform: "scaleX(0)" }}
                />
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid gap-1.5">
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-12 w-full">
          <defs>
            <clipPath id="discos-revela">
              <rect ref={revelaRef} x="0" y="0" width="0" height="40" />
            </clipPath>
          </defs>
          <path d="M0,39.5 H100" vectorEffect="non-scaling-stroke" className="stroke-line" strokeWidth={1} />
          <g clipPath="url(#discos-revela)">
            <path d={`${GRAFICO} L100,40 L0,40 Z`} className="fill-down/10" />
            <path d={GRAFICO} vectorEffect="non-scaling-stroke" className="fill-none stroke-down" strokeWidth={2} strokeLinecap="round" />
          </g>
        </svg>
        <p className="flex items-center justify-between text-[11.5px] text-ink-3">
          <span>Velocidade</span>
          <span>1 leitura · 3 cópias</span>
        </p>
      </div>
    </div>
  );
}
