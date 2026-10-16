"use client";

import { animate, motion, MotionConfig, useInView } from "motion/react";
import { useEffect, useRef, useSyncExternalStore } from "react";

const EASE = [0.2, 0.8, 0.2, 1] as const;

/** Com "reduzir movimento", as revelações viram só um esmaecer (sem deslocamento). */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

/** Revela o conteúdo com um leve subir ao entrar na tela (uma vez só). */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 28,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  y?: number;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -10% 0px" }}
      transition={{ duration: 0.9, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

/** true quando o usuário pediu menos movimento (só no navegador; no servidor, false). */
const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduce(cb: () => void) {
  const q = window.matchMedia(REDUCE_QUERY);
  q.addEventListener("change", cb);
  return () => q.removeEventListener("change", cb);
}

export function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribeReduce,
    () => window.matchMedia(REDUCE_QUERY).matches,
    () => false,
  );
}

/** Número que conta do zero ao valor quando aparece. Sem JavaScript, mostra o valor final. */
export function Counter({ to, duration = 1.6 }: { to: number; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -15% 0px" });
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || started.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!inView) {
      el.textContent = "0";
      return;
    }
    started.current = true;
    const controls = animate(0, to, {
      duration,
      ease: EASE,
      onUpdate: (v) => {
        el.textContent = String(Math.round(v));
      },
    });
    return () => controls.stop();
  }, [inView, to, duration]);

  return (
    <span ref={ref} className="tabular-nums">
      {to}
    </span>
  );
}

/** Roda um laço de animação só enquanto o elemento está na tela. */
export function useLoop(ref: React.RefObject<Element | null>, tick: (dt: number) => void, enabled = true) {
  const inView = useInView(ref, { margin: "60px" });
  const tickRef = useRef(tick);
  useEffect(() => {
    tickRef.current = tick;
  });
  useEffect(() => {
    if (!inView || !enabled) return;
    let raf = 0;
    let last = 0;
    const frame = (now: number) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      tickRef.current(dt);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [inView, enabled]);
  return inView;
}
