"use client";

import { Check, CloudUpload, LoaderCircle, RotateCw, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { useLoop, usePrefersReducedMotion } from "./motion";

/**
 * Uma transferência que perde a internet no meio e continua de onde parou.
 * Fases em segundos; o progresso só anda nas fases de envio.
 */
type Phase = "subindo" | "caiu" | "voltou" | "conferindo" | "pronto";

const STOP = 0.58;
const PLAN: Array<{ phase: Phase; dur: number; from: number; to: number }> = [
  { phase: "subindo", dur: 4.2, from: 0, to: STOP },
  { phase: "caiu", dur: 2.6, from: STOP, to: STOP },
  { phase: "voltou", dur: 3.2, from: STOP, to: 1 },
  { phase: "conferindo", dur: 1.4, from: 1, to: 1 },
  { phase: "pronto", dur: 2.4, from: 1, to: 1 },
];
const TOTAL = PLAN.reduce((a, p) => a + p.dur, 0);

const LOG: Record<Phase, string[]> = {
  subindo: ["Subindo para Drive da produtora / Brutos"],
  caiu: ["Subindo para Drive da produtora / Brutos", "A internet caiu. Progresso salvo em 58%."],
  voltou: ["Subindo para Drive da produtora / Brutos", "A internet caiu. Progresso salvo em 58%.", "Voltou. Continua de 58%, sem recomeçar."],
  conferindo: [
    "Subindo para Drive da produtora / Brutos",
    "A internet caiu. Progresso salvo em 58%.",
    "Voltou. Continua de 58%, sem recomeçar.",
    "Conferindo o MD5 com o do Google.",
  ],
  pronto: [
    "Subindo para Drive da produtora / Brutos",
    "A internet caiu. Progresso salvo em 58%.",
    "Voltou. Continua de 58%, sem recomeçar.",
    "Conferido. Idêntico ao original.",
  ],
};

function ease(x: number) {
  return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
}

export function PauseDemo() {
  const boxRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const pctRef = useRef<HTMLSpanElement>(null);
  const time = useRef(2.9); // começa no meio, já com progresso na tela
  const [livePhase, setPhase] = useState<Phase>("subindo");
  const reduce = usePrefersReducedMotion();

  const paint = (p: number) => {
    if (barRef.current) barRef.current.style.width = `${p * 100}%`;
    if (pctRef.current) pctRef.current.textContent = `${Math.floor(p * 100)}%`;
  };

  useLoop(
    boxRef,
    (dt) => {
      time.current = (time.current + dt) % TOTAL;
      let t = time.current;
      for (const step of PLAN) {
        if (t <= step.dur) {
          const p = step.from + (step.to - step.from) * ease(t / step.dur);
          paint(p);
          setPhase((prev) => (prev === step.phase ? prev : step.phase));
          return;
        }
        t -= step.dur;
      }
    },
    !reduce,
  );

  // Menos movimento: um quadro parado, já depois de a internet voltar.
  useEffect(() => {
    if (reduce) paint(0.82);
  }, [reduce]);
  const phase: Phase = reduce ? "voltou" : livePhase;

  const offline = phase === "caiu";
  const done = phase === "pronto";

  return (
    <div ref={boxRef} className="grid gap-6">
      <div className="flex items-center gap-4">
        <span
          className={cn(
            "grid size-12 shrink-0 place-items-center rounded-2xl transition-colors duration-500",
            offline ? "bg-warn/15 text-warn-text" : done ? "bg-ok/15 text-ok-text" : "bg-up/12 text-up-text",
          )}
        >
          {offline ? <WifiOff className="size-6" aria-hidden="true" /> : done ? <Check className="size-6" aria-hidden="true" /> : <CloudUpload className="size-6" aria-hidden="true" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate font-mono text-[13px] text-ink sm:text-[14px]">A002_C011_1021.braw</span>
            <span ref={pctRef} className="font-mono text-[13px] text-ink tabular-nums sm:text-[14px]">
              0%
            </span>
          </div>
          <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-surface-2 ring-1 ring-line">
            <div
              ref={barRef}
              className={cn(
                "h-full rounded-full transition-colors duration-500",
                offline ? "bg-warn" : done ? "bg-ok" : "bg-gradient-to-r from-up-text to-up-soft",
              )}
              style={{ width: "0%" }}
            />
          </div>
          <p className="mt-2 flex items-center gap-1.5 text-[13px] text-ink-2">
            {phase === "subindo" || phase === "voltou" ? (
              <>Subindo</>
            ) : offline ? (
              <>
                <RotateCw className="size-3.5" aria-hidden="true" /> Sem conexão. Tenta de novo sozinho.
              </>
            ) : phase === "conferindo" ? (
              <>
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> Conferindo
              </>
            ) : (
              <span className="text-ok-text">Conferido</span>
            )}
          </p>
        </div>
      </div>

      <ol className="grid gap-2 border-t border-line pt-5 font-mono text-[12px] leading-relaxed sm:text-[13px]">
        {[0, 1, 2, 3].map((i) => {
          const line = LOG[phase][i];
          return (
            <li
              key={i}
              className={cn(
                "flex min-h-[1.6em] items-start gap-2 transition-opacity duration-500",
                line ? "opacity-100" : "opacity-0",
                i === LOG[phase].length - 1 ? "text-ink" : "text-ink-3",
              )}
            >
              <span className="text-ink-3" aria-hidden="true">
                ›
              </span>
              <span>{line ?? " "}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
