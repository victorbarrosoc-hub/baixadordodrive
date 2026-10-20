"use client";

import { ArrowUp, Check, Folder } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { ease, span, useClock } from "./demo-kit";
import { usePrefersReducedMotion } from "./motion";

/** As cenas do filme, desenhadas só com gradientes (sem imagem). */
const SCENES = [
  {
    nome: "Cena 01",
    tom: "Quente",
    bg: "radial-gradient(circle at 68% 40%, #ffe6b0 0 8%, transparent 9%), linear-gradient(180deg, #f2a35e 0%, #d9643f 56%, #3a1d22 57%, #24121a 100%)",
  },
  {
    nome: "Cena 02",
    tom: "Frio",
    bg: "radial-gradient(circle at 26% 30%, #eaf2ff 0 5%, transparent 6%), linear-gradient(180deg, #10233d 0%, #2c5d90 60%, #0c1828 61%, #08111d 100%)",
  },
  {
    nome: "Cena 03",
    tom: "Movimento",
    bg: "repeating-linear-gradient(104deg, rgba(255,255,255,0.20) 0 2px, transparent 2px 13px), linear-gradient(180deg, #6f8c78 0%, #35503f 62%, #1b2a22 100%)",
  },
] as const;

type Kind = "ok" | "preto" | "desfocado" | "tremido" | "repetido" | "corte";
const FRAMES: { s: 0 | 1 | 2; kind: Kind }[] = [
  { s: 0, kind: "ok" },
  { s: 0, kind: "desfocado" },
  { s: 0, kind: "ok" },
  { s: 0, kind: "corte" },
  { s: 1, kind: "ok" },
  { s: 1, kind: "repetido" },
  { s: 1, kind: "preto" },
  { s: 1, kind: "ok" },
  { s: 2, kind: "tremido" },
  { s: 2, kind: "ok" },
  { s: 2, kind: "ok" },
  { s: 2, kind: "desfocado" },
  { s: 2, kind: "ok" },
  { s: 0, kind: "ok" },
];
/** Os três escolhidos para a tríade (um de cada cena). */
const TRIADE = [2, 7, 10];

/** Quadro de 68 × 38 no celular e 96 × 54 a partir de sm (lido do DOM quando a tira muda de tamanho). */
const FRAME_CLS = "h-[38px] w-[68px] sm:h-[54px] sm:w-[96px]";
const GAP = 6;
const LINE = 0.7; // posição da linha de análise na largura da tira
const T = 11;
const SCAN_A = 0.4;
const SCAN_B = 6.2;
const STILL = 9.6;

function tc(i: number) {
  const s = 4 + i * 6;
  const f = (i * 7) % 24;
  const dd = (n: number) => String(n).padStart(2, "0");
  return `00-${dd(Math.floor(s / 60))}-${dd(s % 60)}-${dd(f)}`;
}

function Still({ s, kind, i, className }: { s: 0 | 1 | 2; kind: Kind; i: number; className?: string }) {
  const pos = { backgroundSize: "135% 100%", backgroundPosition: `${(i * 23) % 100}% 0` };
  if (kind === "preto") return <span className={cn("block bg-[#060607]", className)} />;
  if (kind === "corte")
    return (
      <span className={cn("flex", className)}>
        <span className="h-full w-1/2" style={{ background: SCENES[0].bg, ...pos }} />
        <span className="h-full w-1/2" style={{ background: SCENES[1].bg, ...pos }} />
      </span>
    );
  return (
    <span className={cn("relative block overflow-hidden", className)}>
      <span
        className={cn("absolute inset-0", kind === "desfocado" && "scale-110 blur-[2px]")}
        style={{ background: SCENES[s].bg, ...pos }}
      />
      {kind === "tremido" ? <span className="absolute inset-0 translate-x-[4px] opacity-50" style={{ background: SCENES[s].bg, ...pos }} /> : null}
    </span>
  );
}

/**
 * Frames: a tira do filme passa pela linha de análise; os quadros ruins (preto, desfocado, tremido, repetido, no corte)
 * ficam apagados, os bons voam para a pasta da cena. Depois, três viram uma tríade e a pasta sobe para o Drive.
 */
export function FramesDemo() {
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const frameRefs = useRef<Array<HTMLDivElement | null>>([]);
  const folderRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const countRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const ghostRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const slotRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const fileRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const width = useRef(0);
  const fw = useRef(68);
  const fh = useRef(38);
  const judged = useRef<boolean[]>(FRAMES.map(() => false));
  const lastT = useRef(0);
  const ghostN = useRef(0);
  const reduce = usePrefersReducedMotion();

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const measure = () => {
      width.current = view.clientWidth;
      const f = frameRefs.current[0];
      if (f) {
        fw.current = f.offsetWidth || 68;
        fh.current = f.offsetHeight || 38;
      }
    };
    const ro = new ResizeObserver(measure);
    ro.observe(view);
    measure();
    return () => ro.disconnect();
  }, []);

  const fly = (i: number) => {
    const root = rootRef.current;
    const view = viewRef.current;
    const folder = folderRefs.current[FRAMES[i].s];
    const ghost = ghostRefs.current[ghostN.current++ % ghostRefs.current.length];
    if (!root || !view || !folder || !ghost || typeof ghost.animate !== "function") return;
    // Uma leitura de posição por quadro bom (umas 8 por volta): nada de leitura a cada quadro.
    const r = root.getBoundingClientRect();
    const v = view.getBoundingClientRect();
    const f = folder.getBoundingClientRect();
    const W = fw.current;
    const H = fh.current;
    const sx = v.left - r.left + v.width * LINE - W / 2;
    const sy = v.top - r.top + (v.height - H) / 2;
    const ex = f.left - r.left + f.width / 2 - W / 2;
    const ey = f.top - r.top + f.height / 2 - H / 2;
    ghost.style.background = SCENES[FRAMES[i].s].bg;
    ghost.style.backgroundSize = "135% 100%";
    ghost.animate(
      [
        { transform: `translate(${sx}px, ${sy}px) scale(1)`, opacity: 1 },
        { transform: `translate(${ex}px, ${ey}px) scale(0.3)`, opacity: 0.2 },
      ],
      { duration: 700, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "none" },
    );
    folder.animate([{ transform: "scale(1)" }, { transform: "scale(1.04)" }, { transform: "scale(1)" }], { duration: 360, delay: 520 });
  };

  const paint = (t: number) => {
    const w = width.current || 300;
    const FW = fw.current;
    const PITCH = FW + GAP;
    const line = w * LINE;
    const p = span(t, SCAN_A, SCAN_B);
    const x0 = line + 10;
    const x1 = line - 14 - (FRAMES.length - 1) * PITCH - FW / 2;
    const x = x0 + (x1 - x0) * p;
    const strip = stripRef.current;
    if (strip) {
      strip.style.transform = `translate3d(${x.toFixed(1)}px,0,0)`;
      strip.style.opacity = String(Math.min(span(t, 0, 0.4), 1 - span(t, T - 0.5, T)));
    }
    const forward = t >= lastT.current && t - lastT.current < 0.5;
    lastT.current = t;
    const counts = [0, 0, 0];
    let lastOk = -1;
    FRAMES.forEach((fr, i) => {
      const center = x + i * PITCH + FW / 2;
      const on = center < line;
      if (on && fr.kind === "ok") {
        counts[fr.s]++;
        lastOk = i;
      }
      if (on !== judged.current[i]) {
        judged.current[i] = on;
        const el = frameRefs.current[i];
        if (el) el.dataset.state = on ? (fr.kind === "ok" ? "ok" : "bad") : "";
        if (on && fr.kind === "ok" && forward && !reduce) fly(i);
      }
    });
    counts.forEach((n, s) => {
      const el = countRefs.current[s];
      if (el && el.textContent !== String(n)) el.textContent = String(n);
    });
    if (fileRef.current) {
      const fr = lastOk >= 0 ? FRAMES[lastOk] : null;
      const txt = fr ? `${SCENES[fr.s].nome} — ${SCENES[fr.s].tom}/…_C0${fr.s + 1}_F${String(lastOk + 1).padStart(3, "0")}_${tc(lastOk)}.jpg` : "Analisando o filme…";
      if (fileRef.current.textContent !== txt) fileRef.current.textContent = txt;
    }
    slotRefs.current.forEach((el, k) => {
      if (!el) return;
      const on = t >= SCAN_B + 0.2 + k * 0.35 && t < T - 0.4;
      el.dataset.on = on ? "1" : "";
    });
    const up = ease(span(t, 7.6, 9.0));
    if (barRef.current) barRef.current.style.transform = `scaleX(${up.toFixed(3)})`;
    if (statusRef.current) {
      const st = t < 7.6 ? "" : t < 9.0 ? "up" : t < T - 0.4 ? "ok" : "";
      if (statusRef.current.dataset.st !== st) statusRef.current.dataset.st = st;
    }
  };

  useClock(rootRef, T, paint, reduce, STILL);

  return (
    <div ref={rootRef} className="relative grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-stretch lg:gap-8" aria-hidden="true">
      <div className="grid min-w-0 content-start gap-3 lg:content-center">
        <div ref={viewRef} className="relative h-[66px] overflow-hidden rounded-xl bg-stage ring-1 ring-line sm:h-[84px]">
          <div ref={stripRef} className="absolute top-0 left-0 flex h-full items-center gap-[6px] will-change-transform">
            {/* Perfuração da película, em cima e embaixo. */}
            <span className="absolute inset-x-0 top-[4px] h-[5px] bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.28)_0_6px,transparent_6px_12px)]" />
            <span className="absolute inset-x-0 bottom-[4px] h-[5px] bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.28)_0_6px,transparent_6px_12px)]" />
            {FRAMES.map((fr, i) => (
              <div
                key={i}
                ref={(el) => {
                  frameRefs.current[i] = el;
                }}
                data-state=""
                className={cn("group relative shrink-0 rounded-[3px] transition-shadow duration-300 data-[state=ok]:shadow-[0_0_0_2px_var(--color-ok)]", FRAME_CLS)}
              >
                <Still
                  s={fr.s}
                  kind={fr.kind === "repetido" ? "ok" : fr.kind}
                  i={fr.kind === "repetido" ? i - 1 : i}
                  className="size-full rounded-[3px] transition-[opacity,filter] duration-300 group-data-[state=bad]:opacity-30 group-data-[state=bad]:grayscale"
                />
                {fr.kind !== "ok" ? (
                  <span className="absolute inset-x-0 bottom-0 rounded-b-[3px] bg-black/75 py-px text-center text-[9px] leading-tight text-white opacity-0 transition-opacity duration-300 group-data-[state=bad]:opacity-100">
                    {fr.kind}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
          {/* A linha de análise. */}
          <span className="absolute inset-y-1.5 w-px bg-white shadow-[0_0_10px_2px_rgba(255,255,255,0.55)]" style={{ left: `${LINE * 100}%` }} />
        </div>

        <div className="grid grid-cols-3 gap-2">
          {SCENES.map((sc, s) => (
            <span
              key={sc.nome}
              ref={(el) => {
                folderRefs.current[s] = el;
              }}
              className="flex min-w-0 items-center gap-2 rounded-xl bg-surface-2 px-2.5 py-2 ring-1 ring-line"
            >
              <span className="hidden size-7 shrink-0 place-items-center rounded-lg bg-surface text-ink-2 ring-1 ring-line sm:grid">
                <Folder className="size-3.5" />
              </span>
              <span className="grid min-w-0 leading-tight">
                <span className="truncate text-[12px] font-semibold text-ink">{sc.nome}</span>
                <span className="truncate text-[11px] text-ink-3">{sc.tom}</span>
              </span>
              <span
                ref={(el) => {
                  countRefs.current[s] = el;
                }}
                className="ml-auto text-[13px] font-semibold text-ink tabular-nums"
              >
                0
              </span>
            </span>
          ))}
        </div>
        <span ref={fileRef} className="truncate font-mono text-[11px] text-ink-3 sm:text-[12px]">
          Analisando o filme…
        </span>
      </div>

      <div className="flex items-center gap-4 lg:flex-col lg:items-stretch lg:justify-between lg:gap-3">
        <div className="grid w-[92px] shrink-0 gap-1.5 lg:w-[124px]">
          <span className="grid aspect-[4/5] grid-rows-3 gap-[3px] rounded-lg bg-surface p-[5px] shadow-[0_8px_24px_-12px_rgba(0,0,0,0.35)] ring-1 ring-line">
            {TRIADE.map((i, k) => (
              <span
                key={i}
                ref={(el) => {
                  slotRefs.current[k] = el;
                }}
                data-on=""
                className="overflow-hidden rounded-[3px] bg-surface-2 transition-[opacity,transform] duration-500 ease-out-soft not-data-[on=1]:translate-y-1.5 not-data-[on=1]:opacity-0"
              >
                <Still s={FRAMES[i].s} kind="ok" i={i} className="size-full" />
              </span>
            ))}
          </span>
          <span className="text-center text-[11px] font-medium text-ink-2">Tríade · 4:5</span>
        </div>
        <div ref={statusRef} data-st="" className="group/st grid min-w-0 flex-1 gap-2 lg:flex-none">
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink-3 group-data-[st=ok]/st:text-ok-text group-data-[st=up]/st:text-up-text">
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-2 group-data-[st=ok]/st:bg-ok/15 group-data-[st=up]/st:bg-up/12">
              <ArrowUp className="size-3 group-data-[st=ok]/st:hidden" />
              <Check className="hidden size-3 group-data-[st=ok]/st:block" />
            </span>
            <span className="group-data-[st=ok]/st:hidden">Pasta pro Drive</span>
            <span className="hidden group-data-[st=ok]/st:inline">No Drive</span>
          </span>
          <span className="block h-1 overflow-hidden rounded-full bg-surface-2">
            <span ref={barRef} className="block h-full origin-left rounded-full bg-up group-data-[st=ok]/st:bg-ok" style={{ transform: "scaleX(0)" }} />
          </span>
        </div>
      </div>

      {/* Cópias que voam da linha para a pasta da cena. */}
      {Array.from({ length: 4 }, (_, k) => (
        <span
          key={k}
          ref={(el) => {
            ghostRefs.current[k] = el;
          }}
          className={cn("pointer-events-none absolute top-0 left-0 rounded-[3px] opacity-0 shadow-lg", FRAME_CLS)}
        />
      ))}
    </div>
  );
}
