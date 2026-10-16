"use client";

import { Check } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { useLoop, usePrefersReducedMotion } from "./motion";

const HASH = "9b2f4c7e01d85a3fe6c0b17d42a9e358";
const HEX = "0123456789abcdef";

/** Duas impressões digitais (MD5) que se revelam e batem. */
export function Md5Demo() {
  const boxRef = useRef<HTMLDivElement>(null);
  const localRef = useRef<HTMLSpanElement>(null);
  const driveRef = useRef<HTMLSpanElement>(null);
  const t = useRef(3); // começa já conferido
  const acc = useRef(0);
  const [match, setMatch] = useState(true);
  const reduce = usePrefersReducedMotion();

  const scramble = (lockedUntil: number) => {
    let s = "";
    for (let i = 0; i < HASH.length; i++) s += i < lockedUntil ? HASH[i] : HEX[(Math.random() * 16) | 0];
    return s;
  };

  useLoop(
    boxRef,
    (dt) => {
      t.current = (t.current + dt) % 6;
      acc.current += dt;
      if (acc.current < 1 / 24) return;
      acc.current = 0;
      const time = t.current;
      // 0–0.6 s embaralha; até 2.4 s trava da esquerda para a direita; depois mostra que bate.
      const local = Math.max(0, Math.min(32, Math.floor(((time - 0.4) / 1.6) * 32)));
      const drive = Math.max(0, Math.min(32, Math.floor(((time - 0.9) / 1.6) * 32)));
      if (localRef.current) localRef.current.textContent = scramble(local);
      if (driveRef.current) driveRef.current.textContent = scramble(drive);
      const ok = drive >= 32 && time < 5.6;
      setMatch((prev) => (prev === ok ? prev : ok));
    },
    !reduce,
  );

  const ok = match || reduce;

  return (
    <div ref={boxRef} className="grid gap-4 font-mono">
      <div className="grid gap-1.5">
        <span className="font-sans text-[12px] text-ink-3">No computador</span>
        <span ref={localRef} className="block overflow-hidden text-[13px] tracking-[0.02em] break-all text-ink sm:text-[14px]">
          {HASH}
        </span>
      </div>
      <div className="grid gap-1.5">
        <span className="font-sans text-[12px] text-ink-3">No Google Drive</span>
        <span ref={driveRef} className="block overflow-hidden text-[13px] tracking-[0.02em] break-all text-ink sm:text-[14px]">
          {HASH}
        </span>
      </div>
      <div
        className={cn(
          "mt-1 inline-flex w-fit items-center gap-1.5 rounded-full px-3 py-1 font-sans text-[13px] font-medium transition-all duration-500",
          ok ? "bg-ok/15 text-ok-text" : "bg-surface-2 text-ink-3",
        )}
      >
        <Check className={cn("size-3.5 transition-opacity", ok ? "opacity-100" : "opacity-0")} aria-hidden="true" />
        {ok ? "Idêntico ao original" : "Calculando"}
      </div>
    </div>
  );
}
