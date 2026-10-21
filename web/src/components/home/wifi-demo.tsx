"use client";

import { Check, Wifi } from "lucide-react";
import { useRef } from "react";
import { ease, span, useClock } from "./demo-kit";
import { usePrefersReducedMotion } from "./motion";

/**
 * Pelo Wi-Fi (docs/CELULAR-WIFI.md), em três idas: iPhone → Mac (a mesma conta, chega sozinho), Mac → Android da Ana
 * (outra pessoa por perto: só depois de Aceitar) e Android → iPhone (celular com celular, por cima do Mac).
 */
const T = 10;
const X = { ip: 14, mac: 50, and: 86 } as const;
const PERNAS = [
  { de: X.ip, para: X.mac, a: 0.4, b: 2.6, n: 3, arco: 0 },
  { de: X.mac, para: X.and, a: 4.6, b: 6.4, n: 2, arco: 0 },
  { de: X.and, para: X.ip, a: 7.8, b: 9.4, n: 1, arco: 54 },
] as const;
const GAP = 0.22;
const STILL = 5.5;
const CHIPS = [
  "linear-gradient(160deg,#3b2a4f,#c45a7a 60%,#f2b06a)",
  "linear-gradient(170deg,#1c2b3a,#3f6b8f 55%,#c9d6df)",
  "linear-gradient(165deg,#101012,#2b4a45 50%,#7fc4b0)",
];
/** O check na tela de quem acabou de receber (classes inteiras: o Tailwind só enxerga texto literal). */
const OK_CLS = {
  ip: "group-data-[ok=ip]/w:opacity-100",
  mac: "group-data-[ok=mac]/w:opacity-100",
  and: "group-data-[ok=and]/w:opacity-100",
} as const;
/** Altura (px) do meio dos aparelhos, onde os arquivos passam. */
const Y = 112;

function legenda(t: number) {
  if (t < 3.4) return "iPhone → Mac · da sua conta, chega sozinho";
  if (t < 6.8) return "Mac → Android da Ana · ela tocou em Aceitar";
  return "Android → iPhone · celular com celular";
}

/** Os arquivos passando entre celulares e computador, direto pela rede, nos dois sentidos. */
export function WifiDemo() {
  const rootRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const barRefs = useRef<Record<string, HTMLSpanElement | null>>({});
  const capRef = useRef<HTMLParagraphElement>(null);
  const reduce = usePrefersReducedMotion();

  const paint = (t: number) => {
    const root = rootRef.current;
    if (!root) return;
    // Os arquivos da perna atual.
    const perna = PERNAS.find((p) => t >= p.a - 0.2 && t <= p.b + 0.2) ?? null;
    chipRefs.current.forEach((el, i) => {
      if (!el) return;
      if (!perna || i >= perna.n) {
        el.style.opacity = "0";
        return;
      }
      const ini = perna.a + i * GAP;
      const fim = perna.b - (perna.n - 1 - i) * GAP;
      const p = ease(span(t, ini, fim));
      const x = perna.de + (perna.para - perna.de) * p;
      const y = Y - Math.sin(Math.PI * p) * perna.arco;
      const vis = t >= ini && t <= fim ? Math.min(1, span(t, ini, ini + 0.15) * 1) * (1 - span(t, fim - 0.12, fim)) : 0;
      el.style.left = `${x}%`;
      el.style.top = `${y}px`;
      el.style.opacity = vis.toFixed(3);
    });
    // As barras nas telas de quem recebe.
    const barras: [string, number][] = [
      ["mac", span(t, 0.6, 2.8) * (t < 4.6 ? 1 : 0)],
      ["and", span(t, 4.8, 6.5) * (t < 7.8 ? 1 : 0)],
      ["ip", span(t, 8, 9.5)],
    ];
    for (const [k, v] of barras) {
      const el = barRefs.current[k];
      if (el) el.style.transform = `scaleX(${v.toFixed(4)})`;
    }
    const ok = t >= 2.8 && t < 4.6 ? "mac" : t >= 6.5 && t < 7.8 ? "and" : t >= 9.5 ? "ip" : "";
    const bub = t >= 3.4 && t < 4.6 ? "b" : t >= 6.8 && t < 7.8 ? "c" : "";
    const press = (t >= 4.2 && t < 4.6) || (t >= 7.4 && t < 7.8) ? "1" : "";
    if (root.dataset.ok !== ok) root.dataset.ok = ok;
    if (root.dataset.bub !== bub) root.dataset.bub = bub;
    if (root.dataset.press !== press) root.dataset.press = press;
    const cap = legenda(t);
    if (capRef.current && capRef.current.textContent !== cap) capRef.current.textContent = cap;
  };

  useClock(rootRef, T, paint, reduce, STILL);

  const bar = (k: string) => (
    <span className="absolute inset-x-2 bottom-2 h-1 overflow-hidden rounded-full bg-ink/10">
      <span
        ref={(el) => {
          barRefs.current[k] = el;
        }}
        className="absolute inset-0 origin-left rounded-full bg-[linear-gradient(90deg,var(--color-down),var(--color-up))] will-change-transform"
        style={{ transform: "scaleX(0)" }}
      />
    </span>
  );
  const ok = (k: keyof typeof OK_CLS) => (
    <span className={`absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-300 ${OK_CLS[k]}`}>
      <span className="grid size-6 place-items-center rounded-full bg-ok text-white">
        <Check className="size-3.5" strokeWidth={3} />
      </span>
    </span>
  );

  return (
    <div ref={rootRef} data-ok="" data-bub="" data-press="" className="group/w relative h-[248px] select-none" aria-hidden="true">
      {/* A rede: tracejado que anda entre os três. */}
      <span
        className="absolute inset-x-[14%] h-px animate-[sd-dash-x_1.2s_linear_infinite] bg-[linear-gradient(90deg,var(--color-line-strong)_50%,transparent_0)] bg-[length:12px_1px]"
        style={{ top: Y }}
      />
      <span className="absolute top-0 left-1/2 inline-flex h-6 -translate-x-1/2 items-center gap-1 rounded-full bg-ok/10 px-2.5 text-[11px] font-medium whitespace-nowrap text-ok-text">
        <Wifi className="size-3" />
        mesma rede
      </span>

      {/* Pedido no Android da Ana. */}
      <span className="absolute top-0 right-0 z-10 grid w-[148px] translate-y-1 gap-1.5 rounded-xl bg-surface p-2.5 text-[11px] leading-snug text-ink opacity-0 shadow-lg ring-1 ring-line transition-[opacity,transform] duration-300 group-data-[bub=b]/w:translate-y-0 group-data-[bub=b]/w:opacity-100">
        <span>
          <b className="font-semibold">MacBook</b> quer mandar 2 arquivos
        </span>
        <span className="justify-self-start rounded-full bg-surface-2 px-2.5 py-1 font-semibold transition-colors group-data-[press=1]/w:bg-ok group-data-[press=1]/w:text-white">Aceitar</span>
      </span>
      {/* Pedido no iPhone. */}
      <span className="absolute top-0 left-0 z-10 grid w-[148px] translate-y-1 gap-1.5 rounded-xl bg-surface p-2.5 text-[11px] leading-snug text-ink opacity-0 shadow-lg ring-1 ring-line transition-[opacity,transform] duration-300 group-data-[bub=c]/w:translate-y-0 group-data-[bub=c]/w:opacity-100">
        <span>
          <b className="font-semibold">Ana</b> quer mandar 1 vídeo
        </span>
        <span className="justify-self-start rounded-full bg-surface-2 px-2.5 py-1 font-semibold transition-colors group-data-[press=1]/w:bg-ok group-data-[press=1]/w:text-white">Aceitar</span>
      </span>

      {/* iPhone */}
      <div className="absolute grid -translate-x-1/2 justify-items-center gap-2" style={{ left: `${X.ip}%`, top: Y - 50 }}>
        <span className="relative h-[100px] w-[52px] rounded-[14px] bg-surface-2 ring-1 ring-line-strong">
          <span className="absolute inset-[3px] overflow-hidden rounded-[11px] bg-surface">
            <span className="absolute top-1 left-1/2 h-1.5 w-4 -translate-x-1/2 rounded-full bg-ink/15" />
            {ok("ip")}
            {bar("ip")}
          </span>
        </span>
        <span className="text-[11px] font-medium text-ink-2">iPhone</span>
      </div>

      {/* MacBook */}
      <div className="absolute grid -translate-x-1/2 justify-items-center gap-2" style={{ left: `${X.mac}%`, top: Y - 34 }}>
        <span className="relative grid justify-items-center">
          <span className="relative h-[76px] w-[118px] overflow-hidden rounded-t-[10px] bg-surface ring-1 ring-line-strong">
            <span className="absolute inset-x-2 top-2 flex gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-ink/15" />
              <span className="h-1.5 w-1.5 rounded-full bg-ink/15" />
              <span className="h-1.5 w-1.5 rounded-full bg-ink/15" />
            </span>
            {ok("mac")}
            {bar("mac")}
          </span>
          <span className="h-2 w-[142px] rounded-b-[6px] bg-surface-2 ring-1 ring-line-strong" />
        </span>
        <span className="text-[11px] font-medium text-ink-2">MacBook</span>
      </div>

      {/* Android da Ana */}
      <div className="absolute grid -translate-x-1/2 justify-items-center gap-2" style={{ left: `${X.and}%`, top: Y - 50 }}>
        <span className="relative h-[100px] w-[52px] rounded-[12px] bg-surface-2 ring-1 ring-line-strong">
          <span className="absolute inset-[3px] overflow-hidden rounded-[9px] bg-surface">
            <span className="absolute top-1.5 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-ink/15" />
            {ok("and")}
            {bar("and")}
          </span>
        </span>
        <span className="text-[11px] font-medium whitespace-nowrap text-ink-2">Android · Ana</span>
      </div>

      {/* Os arquivos em viagem. */}
      {CHIPS.map((bg, i) => (
        <span
          key={i}
          ref={(el) => {
            chipRefs.current[i] = el;
          }}
          className="absolute z-[5] size-[18px] -translate-x-1/2 -translate-y-1/2 rounded-[5px] shadow-md ring-2 ring-surface"
          style={{ background: bg, opacity: 0 }}
        />
      ))}

      <p ref={capRef} className="absolute inset-x-0 bottom-0 text-center text-[12.5px] font-medium text-ink-2">
        {legenda(STILL)}
      </p>
    </div>
  );
}
