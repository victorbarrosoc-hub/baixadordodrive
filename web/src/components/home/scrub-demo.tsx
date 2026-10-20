"use client";

import { ArrowRight, ArrowUp, Check, FileVideo, MousePointer2 } from "lucide-react";
import { useRef } from "react";
import { ease, span, useClock } from "./demo-kit";
import { usePrefersReducedMotion } from "./motion";

const T = 9;
const GEN_B = 2.2;
const SCRUB_A = 2.5;
const SCRUB_B = 8.5;
const STILL = 4.1;
const FPS = 24;
const DUR_S = 42;

function timecode(s: number) {
  const f = Math.round(s * DUR_S * FPS);
  const ff = f % FPS;
  const ss = Math.floor(f / FPS) % 60;
  const mm = Math.floor(f / FPS / 60);
  return `00:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}:${String(ff).padStart(2, "0")}`;
}

/**
 * Proxy e scrub: o proxy leve é gerado e sobe ao lado do original; depois o cursor passa na miniatura e o take corre
 * (sol, morros e timecode mudam com a posição). Quem visita pode passar o próprio cursor ou arrastar o dedo.
 */
export function ScrubDemo() {
  const rootRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const sunRef = useRef<HTMLSpanElement>(null);
  const farRef = useRef<HTMLSpanElement>(null);
  const nearRef = useRef<HTMLSpanElement>(null);
  const cursorRef = useRef<HTMLSpanElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const tcRef = useRef<HTMLSpanElement>(null);
  const genRef = useRef<HTMLSpanElement>(null);
  const genBarRef = useRef<HTMLSpanElement>(null);
  const stateRef = useRef<HTMLDivElement>(null);
  const hover = useRef<number | null>(null);
  const reduce = usePrefersReducedMotion();

  const scene = (s: number) => {
    if (sunRef.current) sunRef.current.style.transform = `translate3d(${(s * 400).toFixed(1)}%, ${(Math.pow(s - 0.55, 2) * 260).toFixed(1)}%, 0)`;
    if (farRef.current) farRef.current.style.transform = `translate3d(${(-s * 10).toFixed(2)}%,0,0)`;
    if (nearRef.current) nearRef.current.style.transform = `translate3d(${(-s * 24).toFixed(2)}%,0,0)`;
    if (fillRef.current) fillRef.current.style.transform = `scaleX(${s.toFixed(4)})`;
    if (tcRef.current) tcRef.current.textContent = timecode(s);
  };

  const paint = (t: number) => {
    const gen = t < GEN_B;
    const g = ease(span(t, 0.2, GEN_B - 0.2));
    if (genBarRef.current) genBarRef.current.style.transform = `scaleX(${g.toFixed(3)})`;
    if (genRef.current) genRef.current.style.opacity = gen && hover.current === null ? "1" : "0";
    if (stateRef.current) {
      const st = gen ? "gen" : "ok";
      if (stateRef.current.dataset.st !== st) stateRef.current.dataset.st = st;
    }
    if (hover.current !== null) {
      if (cursorRef.current) cursorRef.current.style.opacity = "0";
      scene(hover.current);
      return;
    }
    const u = span(t, SCRUB_A, SCRUB_B);
    const s = 0.5 - 0.5 * Math.cos(u * Math.PI * 2);
    const vis = Math.min(span(t, SCRUB_A - 0.2, SCRUB_A + 0.2), 1 - span(t, SCRUB_B - 0.2, SCRUB_B + 0.2));
    if (cursorRef.current) {
      cursorRef.current.style.left = `${(4 + s * 92).toFixed(2)}%`;
      cursorRef.current.style.opacity = vis.toFixed(2);
    }
    scene(s);
  };

  useClock(rootRef, T, paint, reduce, STILL);

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    hover.current = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (reduce) paint(STILL);
  };
  const onLeave = () => {
    hover.current = null;
    if (reduce) paint(STILL);
  };

  return (
    <div ref={rootRef} className="grid gap-4">
      <div
        ref={thumbRef}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        onPointerCancel={onLeave}
        className="relative aspect-video cursor-ew-resize touch-pan-y overflow-hidden rounded-2xl bg-stage ring-1 ring-line select-none"
        aria-label="Miniatura de um take: passe o cursor ou arraste o dedo para correr o vídeo"
        role="img"
      >
        <span className="absolute inset-0 bg-[linear-gradient(180deg,#1b2340_0%,#6d4a6e_45%,#e48a5a_78%,#f6c27a_100%)]" />
        <span ref={sunRef} className="absolute top-[22%] left-[6%] size-[16%] rounded-full bg-[radial-gradient(circle,#fff4d6_0_45%,rgba(255,220,150,0.35)_46%,transparent_70%)] will-change-transform" />
        <span
          ref={farRef}
          className="absolute bottom-[18%] left-0 h-[42%] w-[115%] bg-[#4a3550] will-change-transform [clip-path:polygon(0_100%,0_55%,10%_35%,22%_58%,34%_20%,47%_52%,58%_30%,70%_60%,82%_25%,94%_50%,100%_40%,100%_100%)]"
        />
        <span
          ref={nearRef}
          className="absolute bottom-0 left-0 h-[38%] w-[135%] bg-[#1d1726] will-change-transform [clip-path:polygon(0_100%,0_50%,8%_40%,18%_62%,30%_30%,44%_55%,52%_44%,64%_70%,76%_35%,88%_58%,100%_42%,100%_100%)]"
        />
        <span className="absolute top-2.5 left-2.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur-sm">Proxy</span>
        <span className="absolute top-2.5 right-2.5 rounded-full bg-black/45 px-2 py-0.5 font-mono text-[10px] text-white/85">720p</span>
        <span ref={tcRef} className="absolute bottom-3.5 left-2.5 rounded bg-black/50 px-1.5 py-0.5 font-mono text-[10px] text-white/90 tabular-nums sm:text-[11px]">
          00:00:00:00
        </span>
        <span className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
          <span ref={fillRef} className="block h-full origin-left bg-white" style={{ transform: "scaleX(0)" }} />
        </span>
        <span ref={cursorRef} className="pointer-events-none absolute top-[48%] opacity-0 drop-shadow-[0_2px_4px_rgba(0,0,0,0.6)]">
          <MousePointer2 className="size-5 fill-white text-ink" aria-hidden="true" />
        </span>
        <span ref={genRef} className="absolute inset-0 grid place-items-center bg-black/55 text-[12px] font-medium text-white transition-opacity duration-300">
          Gerando proxy…
        </span>
      </div>

      <div ref={stateRef} data-st="gen" className="group/px flex min-w-0 items-center gap-2 font-mono text-[11px] text-ink-2 sm:text-[12px]" aria-hidden="true">
        <span className="flex min-w-0 items-center gap-1.5">
          <FileVideo className="size-3.5 shrink-0 text-ink-3" />
          <span className="truncate">A001_C007.braw</span>
        </span>
        <ArrowRight className="size-3.5 shrink-0 text-ink-3" />
        <span className="relative flex min-w-0 items-center gap-1.5 overflow-hidden rounded-full bg-surface-2 px-2 py-1 ring-1 ring-line">
          <span ref={genBarRef} className="absolute inset-0 origin-left bg-up/12 group-data-[st=ok]/px:bg-ok/10" style={{ transform: "scaleX(0)" }} />
          <ArrowUp className="relative size-3 shrink-0 text-up-text group-data-[st=ok]/px:hidden" />
          <Check className="relative hidden size-3 shrink-0 text-ok-text group-data-[st=ok]/px:block" />
          <span className="relative truncate text-ink">Proxy/A001_C007.mp4</span>
        </span>
      </div>
    </div>
  );
}
