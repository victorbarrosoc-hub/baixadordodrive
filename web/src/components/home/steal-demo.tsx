"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SegmentedDownload, type StealEvent } from "./transfer-sim";
import { useLoop, usePrefersReducedMotion } from "./motion";

const MAX_SEGS = 40;
const CONNS = 8;

/**
 * O download em pedaços, de perto: cada marcador é uma conexão. Quando uma termina,
 * ela pula para o maior pedaço que falta e pega a metade dele.
 */
export function StealDemo() {
  const boxRef = useRef<HTMLDivElement>(null);
  const segRefs = useRef<Array<HTMLDivElement | null>>([]);
  const fillRefs = useRef<Array<HTMLDivElement | null>>([]);
  const markRefs = useRef<Array<HTMLDivElement | null>>([]);
  const pctRef = useRef<HTMLSpanElement>(null);
  const markX = useRef<number[]>(Array(CONNS).fill(NaN));
  const hold = useRef(0);
  const [caption, setCaption] = useState("8 conexões, cada uma num pedaço.");
  const [active, setActive] = useState(CONNS);
  const reduce = usePrefersReducedMotion();

  const sim = useMemo(() => {
    const onSteal = (e: StealEvent) =>
      setCaption(`Conexão ${e.thief + 1} acabou e pegou metade do pedaço da ${e.victim + 1}.`);
    return new SegmentedDownload(CONNS, 11, 3, onSteal);
  }, []);

  const paint = (dt: number) => {
    const segs = sim.segments;
    for (let i = 0; i < MAX_SEGS; i++) {
      const el = segRefs.current[i];
      const fill = fillRefs.current[i];
      if (!el || !fill) continue;
      const s = segs[i];
      if (!s) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "block";
      el.style.left = `${s.start * 100}%`;
      el.style.width = `${(s.end - s.start) * 100}%`;
      fill.style.width = `${((s.pos - s.start) / Math.max(1e-9, s.end - s.start)) * 100}%`;
    }
    const k = 1 - Math.exp(-dt * 10);
    for (let c = 0; c < CONNS; c++) {
      const el = markRefs.current[c];
      if (!el) continue;
      const seg = sim.conns[c].seg;
      if (seg) {
        const target = seg.pos * 100;
        markX.current[c] = Number.isNaN(markX.current[c]) || dt === 0 ? target : markX.current[c] + (target - markX.current[c]) * k;
        el.style.left = `${markX.current[c]}%`;
        el.style.opacity = "1";
      } else {
        el.style.opacity = "0";
      }
    }
    if (pctRef.current) pctRef.current.textContent = sim.done ? "100%" : `${Math.floor(sim.progress * 100)}%`;
  };

  useLoop(
    boxRef,
    (dt) => {
      if (sim.done) {
        hold.current += dt;
        if (hold.current > 2.6) {
          hold.current = 0;
          sim.reset();
          markX.current.fill(NaN);
          setCaption("8 conexões, cada uma num pedaço.");
          setActive(CONNS);
        }
      } else {
        sim.step(dt);
        const a = sim.active;
        setActive((prev) => (prev === a ? prev : a));
        if (sim.done) setCaption("Pronto. Todas trabalharam até o último byte.");
      }
      paint(dt);
    },
    !reduce,
  );

  // Quadro estático (menos movimento): um momento depois de alguns "roubos".
  useEffect(() => {
    if (!reduce) return;
    sim.reset();
    for (let i = 0; i < 420; i++) sim.step(1 / 60);
    markX.current.fill(NaN);
    paint(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduce]);

  useEffect(() => {
    paint(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={boxRef} className="grid gap-6">
      <div className="flex items-baseline justify-between gap-4 font-mono text-[12px] text-ink-2 sm:text-[13px]">
        <span className="truncate">A001_C003_0915.mov</span>
        <span className="shrink-0">
          <span className="text-ink-3">{active} {active === 1 ? "conexão ativa" : "conexões ativas"} · </span>
          <span ref={pctRef} className="text-ink tabular-nums">
            0%
          </span>
        </span>
      </div>
      <div className="relative">
        <div className="relative h-11 overflow-hidden rounded-2xl bg-surface-2 ring-1 ring-line sm:h-14">
          {Array.from({ length: MAX_SEGS }, (_, i) => (
            <div
              key={i}
              ref={(el) => {
                segRefs.current[i] = el;
              }}
              className="absolute inset-y-0 border-l-2 border-surface first:border-l-0"
              style={{ display: i < CONNS ? "block" : "none", left: `${(i / CONNS) * 100}%`, width: `${100 / CONNS}%` }}
            >
              <div
                ref={(el) => {
                  fillRefs.current[i] = el;
                }}
                className="h-full bg-gradient-to-r from-down to-down-soft"
                style={{ width: "0%" }}
              />
            </div>
          ))}
        </div>
        <div className="relative mt-2 h-7" aria-hidden="true">
          {Array.from({ length: CONNS }, (_, c) => (
            <div
              key={c}
              ref={(el) => {
                markRefs.current[c] = el;
              }}
              className="absolute top-0 flex -translate-x-1/2 flex-col items-center transition-opacity duration-500"
              style={{ left: `${((c + 0.0) / CONNS) * 100}%` }}
            >
              <span className="h-2 w-px bg-down" />
              <span className="grid size-5 place-items-center rounded-full bg-down text-[10px] font-semibold text-white tabular-nums">{c + 1}</span>
            </div>
          ))}
        </div>
      </div>
      <p className="min-h-[3em] text-[15px] leading-normal text-ink-2 sm:min-h-[1.5em]" aria-live="off">
        {caption}
      </p>
    </div>
  );
}
