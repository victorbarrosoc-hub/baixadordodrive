"use client";

import { Folder, LoaderCircle } from "lucide-react";
import { useInView } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { usePrefersReducedMotion } from "./motion";

type Row = { path: string; ja: number; falta: number; dif: number; so: number };

const ROWS: Row[] = [
  { path: "Dia 01 / Câmera A", ja: 48, falta: 0, dif: 0, so: 0 },
  { path: "Dia 01 / Câmera B", ja: 31, falta: 12, dif: 0, so: 0 },
  { path: "Dia 01 / Som", ja: 22, falta: 0, dif: 1, so: 0 },
  { path: "Dia 02 / Câmera A", ja: 0, falta: 60, dif: 0, so: 0 },
  { path: "Projeto de edição", ja: 6, falta: 2, dif: 0, so: 3 },
];

const KINDS = [
  { key: "ja", label: "Já no Drive", bar: "bg-ok", chip: "bg-ok/12 text-ok-text" },
  { key: "falta", label: "Falta subir", bar: "bg-up", chip: "bg-up/12 text-up-text" },
  { key: "dif", label: "Diferentes", bar: "bg-warn", chip: "bg-warn/15 text-warn-text" },
  { key: "so", label: "Só no Drive", bar: "bg-down", chip: "bg-down/12 text-down-text" },
] as const;

type Phase = "comparando" | "resultado" | "subindo" | "pronto";
type Mode = "rapido" | "completo";

const MODES: Record<Mode, { label: string; text: string; scan: string; ms: number }> = {
  rapido: { label: "Rápido", text: "Nome e tamanho. Segundos, mesmo em pasta enorme.", scan: "Comparando nomes e tamanhos", ms: 1600 },
  completo: {
    label: "Completo",
    text: "Confere o MD5 de cada arquivo. Lento só na primeira vez.",
    scan: "Lendo o MD5 de cada arquivo",
    ms: 2600,
  },
};

function chipLabel(key: (typeof KINDS)[number]["key"], n: number) {
  if (key === "ja") return "já no Drive";
  if (key === "falta") return "falta subir";
  if (key === "dif") return n === 1 ? "diferente" : "diferentes";
  return "só no Drive";
}

function rowAfter(r: Row, phase: Phase): Row {
  return phase === "subindo" || phase === "pronto" ? { ...r, ja: r.ja + r.falta, falta: 0 } : r;
}

/** O comparador: pasta por pasta, o que já subiu e o que falta. Depois, "Subir o que falta". */
export function CompareDemo() {
  const boxRef = useRef<HTMLDivElement>(null);
  const inView = useInView(boxRef, { margin: "0px 0px -15% 0px" });
  const reduce = usePrefersReducedMotion();
  const [mode, setMode] = useState<Mode>("rapido");
  const [phase, setPhase] = useState<Phase>("resultado");
  const [cycle, setCycle] = useState(0);
  const scanNext = useRef(false);

  useEffect(() => {
    if (reduce) return;
    if (!inView) {
      scanNext.current = false;
      return;
    }
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
    const scan = MODES[mode].ms;
    // Laço: (comparar) → resultado → subir o que falta → pronto → de novo.
    // Ao entrar na tela, começa pelo resultado; ao trocar de modo, começa comparando.
    const first = scanNext.current ? scan : 0;
    if (scanNext.current) at(0, () => setPhase("comparando"));
    scanNext.current = true;
    at(first, () => setPhase("resultado"));
    at(first + 3400, () => setPhase("subindo"));
    at(first + 5800, () => setPhase("pronto"));
    at(first + 8400, () => setCycle((c) => c + 1));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [inView, mode, cycle, reduce]);

  const scanning = phase === "comparando";
  const rows = ROWS.map((r) => rowAfter(r, phase));
  const totals = KINDS.map((k) => ({ ...k, n: rows.reduce((a, r) => a + r[k.key], 0) }));

  return (
    <div ref={boxRef} className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Modo de comparação" className="inline-flex rounded-full bg-surface-2 p-1 ring-1 ring-line">
          {(Object.keys(MODES) as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => {
                scanNext.current = true;
                setMode(m);
                setCycle((c) => c + 1);
              }}
              className={cn(
                "h-8 rounded-full px-4 text-[13px] font-medium transition-[background-color,color,box-shadow] duration-300",
                mode === m ? "bg-surface text-ink shadow-[0_1px_3px_rgba(0,0,0,0.12)]" : "text-ink-2 hover:text-ink",
              )}
            >
              {MODES[m].label}
            </button>
          ))}
        </div>
        <span
          aria-hidden="true"
          className={cn(
            "ml-auto inline-flex h-8 items-center rounded-full px-4 text-[13px] font-medium transition-all duration-500",
            phase === "subindo"
              ? "scale-[0.97] bg-up text-white"
              : phase === "pronto"
                ? "bg-ok/15 text-ok-text"
                : "bg-primary text-primary-fg",
            scanning && "opacity-40",
          )}
        >
          {phase === "subindo" ? "Subindo o que falta" : phase === "pronto" ? "Tudo no Drive" : "Subir o que falta"}
        </span>
      </div>
      <p className="min-h-[3em] text-[14px] leading-normal text-ink-2">{MODES[mode].text}</p>

      <ul className="grid divide-y divide-line overflow-hidden rounded-2xl bg-surface ring-1 ring-line">
        {rows.map((r, i) => {
          const total = r.ja + r.falta + r.dif + r.so;
          return (
            <li key={r.path} className="grid gap-2.5 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] sm:items-center sm:gap-6 sm:px-5">
              <span className="flex min-w-0 items-center gap-2.5 text-[14px] text-ink">
                <Folder className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
                <span className="truncate">{r.path}</span>
              </span>
              <span className="grid gap-2">
                <span className="flex h-1.5 overflow-hidden rounded-full bg-surface-2">
                  {KINDS.map((k) => (
                    <span
                      key={k.key}
                      className={cn("h-full transition-[width,opacity] duration-700 ease-out-soft", k.bar, scanning ? "opacity-0" : "opacity-100")}
                      style={{ width: `${(r[k.key] / total) * 100}%`, transitionDelay: scanning ? "0ms" : `${i * 90}ms` }}
                    />
                  ))}
                </span>
                <span className="flex min-h-6 flex-wrap gap-1.5">
                  {scanning ? (
                    <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-3">
                      <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
                      {MODES[mode].scan}
                    </span>
                  ) : (
                    KINDS.filter((k) => r[k.key] > 0).map((k) => (
                      <span key={k.key} className={cn("inline-flex h-6 items-center rounded-full px-2.5 text-[12px] font-medium tabular-nums", k.chip)}>
                        {r[k.key]} {chipLabel(k.key, r[k.key])}
                      </span>
                    ))
                  )}
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      <ul className="flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-ink-2" aria-label="Legenda">
        {totals.map((k) => (
          <li key={k.key} className="inline-flex items-center gap-2">
            <span className={cn("size-2 rounded-full", k.bar)} aria-hidden="true" />
            {k.label}
            <span className="text-ink tabular-nums">{scanning ? "–" : k.n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
