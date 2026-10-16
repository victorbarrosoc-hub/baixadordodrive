import { cn } from "@/lib/cn";

/** O símbolo: duas barras, uma que sobe (violeta) e outra que desce (azul). */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-6", className)} aria-hidden="true">
      <rect x="0.5" y="0.5" width="23" height="23" rx="7" fill="#111113" />
      <path d="M9 6.5v8" stroke="#9B85FF" strokeWidth="3.6" strokeLinecap="round" />
      <path d="M15 9.5v8" stroke="#3D9CFF" strokeWidth="3.6" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark />
      <span className="font-display text-[15px] font-semibold tracking-[0.04em] text-ink">SOBEDESCE</span>
    </span>
  );
}
