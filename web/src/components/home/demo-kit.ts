"use client";

import { useInView } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useLoop } from "./motion";

/**
 * Laço por etapas (como o comparador): avança de uma etapa para a próxima depois de `durations[i]` ms e volta ao começo.
 * Só anda com o elemento na tela; com "reduzir movimento", fica parado na etapa `still`.
 * `durations` precisa ser uma constante do módulo (mesma referência a cada render).
 */
export function usePhases(ref: React.RefObject<Element | null>, durations: readonly number[], reduce: boolean, still: number) {
  const inView = useInView(ref, { margin: "0px 0px -10% 0px" });
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (reduce || !inView) return;
    const id = window.setTimeout(() => setPhase((p) => (p + 1) % durations.length), durations[phase]);
    return () => window.clearTimeout(id);
  }, [phase, inView, reduce, durations]);
  return reduce ? still : phase;
}

/**
 * Relógio contínuo de `period` segundos, desenhado direto no DOM (sem render do React a cada quadro).
 * `paint(t)` recebe o tempo dentro do laço. Com "reduzir movimento", pinta uma vez o quadro `still`.
 */
export function useClock(ref: React.RefObject<Element | null>, period: number, paint: (t: number) => void, reduce: boolean, still: number) {
  const t = useRef(0);
  const paintRef = useRef(paint);
  useEffect(() => {
    paintRef.current = paint;
  });
  useLoop(
    ref,
    (dt) => {
      t.current = (t.current + dt) % period;
      paintRef.current(t.current);
    },
    !reduce,
  );
  useEffect(() => {
    paintRef.current(reduce ? still : t.current);
  }, [reduce, still]);
}

/** 0 → 1 entre a e b (fora disso, preso nas pontas). */
export function span(t: number, a: number, b: number) {
  return Math.min(1, Math.max(0, (t - a) / (b - a)));
}

/** Suave na entrada e na saída. */
export function ease(x: number) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}
