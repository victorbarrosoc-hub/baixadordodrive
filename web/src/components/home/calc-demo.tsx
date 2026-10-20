"use client";

import { useRef } from "react";
import { span, useClock } from "./demo-kit";
import { usePrefersReducedMotion } from "./motion";

/**
 * Conta exata, sem número inventado: 400 Mb/s × 3600 s ÷ 8 = 180 GB por hora; um cartão de 128 GB enche em
 * 128 × 8 ÷ 0,4 = 2560 s ≈ 42:40 de gravação; e 128 × 10⁹ bytes ÷ 2³⁰ ≈ 119 "GB" (GiB) no Windows.
 */
const MBPS = 400;
const CARD_GB = 128;
const FULL_S = (CARD_GB * 8 * 1000) / MBPS;
const WIN_GB = Math.floor((CARD_GB * 1e9) / 2 ** 30);
const T = 8;
const FILL_A = 0.3;
const FILL_B = 4.3;
const STILL = 6;

function mmss(s: number) {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/** Calculadora de mídia: o cartão enche enquanto o REC conta; cheio, mostra quanto o Windows chama de 128 GB. */
export function CalcDemo() {
  const rootRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const recRef = useRef<HTMLSpanElement>(null);
  const gbRef = useRef<HTMLSpanElement>(null);
  const stRef = useRef<HTMLDivElement>(null);
  const reduce = usePrefersReducedMotion();

  const paint = (t: number) => {
    const p = span(t, FILL_A, FILL_B) * (1 - span(t, T - 0.5, T));
    if (fillRef.current) fillRef.current.style.transform = `scaleY(${p.toFixed(4)})`;
    const rec = mmss(p * FULL_S);
    if (recRef.current && recRef.current.textContent !== rec) recRef.current.textContent = rec;
    const gb = String(Math.round(p * CARD_GB));
    if (gbRef.current && gbRef.current.textContent !== gb) gbRef.current.textContent = gb;
    const st = t >= FILL_B + 0.3 && t < T - 0.5 ? "cheio" : "";
    if (stRef.current && stRef.current.dataset.st !== st) stRef.current.dataset.st = st;
  };

  useClock(rootRef, T, paint, reduce, STILL);

  return (
    <div ref={rootRef} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-5" aria-hidden="true">
      <div ref={stRef} data-st="" className="group/c relative h-[132px] w-[104px]">
        {/* O cartão: canto cortado, enche de baixo para cima. */}
        <span className="absolute inset-0 overflow-hidden bg-surface-2 [clip-path:polygon(0_0,72%_0,100%_18%,100%_100%,0_100%)]">
          <span ref={fillRef} className="absolute inset-0 origin-bottom bg-[linear-gradient(180deg,var(--color-down-soft),var(--color-down))] will-change-transform" style={{ transform: "scaleY(0)" }} />
          <span className="absolute top-2.5 left-3 flex gap-[3px]">
            {Array.from({ length: 5 }, (_, i) => (
              <span key={i} className="h-3 w-[5px] rounded-[1px] bg-ink/15" />
            ))}
          </span>
        </span>
        <span className="absolute inset-x-0 bottom-3 grid justify-items-center leading-none">
          <span className="font-display text-[26px] font-semibold tracking-[-0.03em] text-ink tabular-nums transition-opacity duration-300 group-data-[st=cheio]/c:opacity-0">
            {CARD_GB} GB
          </span>
          <span className="absolute bottom-0 font-display text-[26px] font-semibold tracking-[-0.03em] text-white tabular-nums opacity-0 transition-opacity duration-300 group-data-[st=cheio]/c:opacity-100">
            {WIN_GB} GB
          </span>
        </span>
        <span className="absolute -bottom-6 inset-x-0 text-center text-[11px] font-medium text-warn-text opacity-0 transition-opacity duration-300 group-data-[st=cheio]/c:opacity-100">
          no Windows
        </span>
      </div>

      <dl className="grid gap-2.5 text-[13px]">
        <div className="flex items-baseline justify-between gap-3 border-b border-line pb-2.5">
          <dt className="text-ink-2">Bitrate</dt>
          <dd className="font-semibold text-ink tabular-nums">{MBPS} Mb/s</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 border-b border-line pb-2.5">
          <dt className="text-ink-2">Por hora</dt>
          <dd className="font-semibold text-ink tabular-nums">{(MBPS * 3600) / 8 / 1000} GB</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 border-b border-line pb-2.5">
          <dt className="text-ink-2">Gravado</dt>
          <dd className="font-semibold text-ink tabular-nums">
            <span ref={gbRef}>0</span> GB
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="flex items-center gap-1.5 text-ink-2">
            <span className="size-2 animate-[sd-pulse_1.2s_ease-in-out_infinite] rounded-full bg-err" />
            REC
          </dt>
          <dd className="font-mono font-semibold text-ink tabular-nums">
            <span ref={recRef}>00:00</span>
          </dd>
        </div>
      </dl>
    </div>
  );
}
