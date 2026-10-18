/** Peças da tela de admin (/admin): números, gráfico de 30 dias, funil, tira de dias e formatos. Sem JavaScript no navegador. */
import { Globe, Laptop, Smartphone } from "lucide-react";
import { cn } from "@/lib/cn";
import type { NumerosUso, PessoaUso } from "@/lib/admin";
import { tempoRelativo } from "@/lib/tempo";

export const dataHora = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "America/Fortaleza" });

const UNIDADES = ["B", "KB", "MB", "GB", "TB"];
export function bytesLegivel(b: number): string {
  if (!b) return "0 B";
  let i = 0;
  let v = b;
  while (v >= 1000 && i < UNIDADES.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1).replace(".", ",")} ${UNIDADES[i]}`;
}
export const velocidadeLegivel = (bps: number) => (bps > 0 ? `${bytesLegivel(bps)}/s` : "—");
export const nArquivos = (n: number) => `${n.toLocaleString("pt-BR")} ${n === 1 ? "arquivo" : "arquivos"}`;
export const totalBytes = (u: NumerosUso) => u.enviadosBytes + u.baixadosBytes;

export function Numero({ valor, rotulo, detalhe, alerta = false }: { valor: React.ReactNode; rotulo: string; detalhe?: string; alerta?: boolean }) {
  return (
    <div className="grid content-start gap-0.5 bg-surface px-5 py-4">
      <p className="font-display text-[26px] leading-none font-semibold tracking-[-0.02em] tabular-nums sm:text-[30px]">{valor}</p>
      <p className="text-[13px] text-ink-2">{rotulo}</p>
      {detalhe ? <p className={cn("text-[12px]", alerta ? "text-warn-text" : "text-ink-3")}>{detalhe}</p> : null}
    </div>
  );
}

const diaCurto = (dia: string) => `${Number(dia.slice(8, 10))}/${Number(dia.slice(5, 7))}`;

/** Barras dos últimos 30 dias: pessoas ativas (altura) e volume transferido (no título de cada barra). */
export function Grafico30({ serie }: { serie: { dia: string; pessoas: number; bytes: number }[] }) {
  const max = Math.max(1, ...serie.map((s) => s.pessoas));
  return (
    <figure className="px-5 pt-4 pb-3">
      <figcaption className="mb-3 flex items-baseline justify-between text-[13px] text-ink-2">
        <span>Pessoas ativas por dia</span>
        <span className="text-ink-3">últimos 30 dias</span>
      </figcaption>
      <div className="flex h-28 items-end gap-[3px]" role="img" aria-label={`Pico de ${max} pessoas ativas num dia nos últimos 30 dias`}>
        {serie.map((s) => (
          <div
            key={s.dia}
            title={`${diaCurto(s.dia)}: ${s.pessoas} ${s.pessoas === 1 ? "pessoa" : "pessoas"} · ${bytesLegivel(s.bytes)} pelo computador`}
            className={cn("min-h-[3px] flex-1 rounded-t-[3px]", s.pessoas ? "bg-up" : "bg-line")}
            style={{ height: `${(s.pessoas / max) * 100}%` }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-ink-3 tabular-nums">
        <span>{diaCurto(serie[0]?.dia ?? "")}</span>
        <span>hoje</span>
      </div>
    </figure>
  );
}

export function Funil({ etapas }: { etapas: { rotulo: string; n: number }[] }) {
  const topo = Math.max(1, etapas[0]?.n ?? 1);
  return (
    <ol className="grid gap-2.5 px-5 py-4">
      {etapas.map((e, i) => {
        const pct = Math.round((e.n / topo) * 100);
        return (
          <li key={e.rotulo} className="grid gap-1">
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="text-ink-2">
                {i + 1}. {e.rotulo}
              </span>
              <span className="font-medium tabular-nums">
                {e.n} <span className="font-normal text-ink-3">({pct}%)</span>
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-up" style={{ width: `${pct}%` }} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** 30 quadradinhos: dias com uso (do mais antigo a hoje). */
export function Tira({ dias, className }: { dias: boolean[]; className?: string }) {
  const n = dias.filter(Boolean).length;
  return (
    <span className={cn("inline-flex gap-[2px]", className)} role="img" aria-label={`${n} de 30 dias com uso`} title={`${n} de 30 dias com uso`}>
      {dias.map((d, i) => (
        <span key={i} className={cn("h-2.5 w-[5px] rounded-[1.5px]", d ? "bg-up" : "bg-line")} />
      ))}
    </span>
  );
}

export function Selo({ children, tom = "neutro" }: { children: React.ReactNode; tom?: "neutro" | "ok" | "alerta" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium ring-1",
        tom === "ok" && "bg-ok/12 text-ok-text ring-ok/30",
        tom === "alerta" && "bg-warn/12 text-warn-text ring-warn/30",
        tom === "neutro" && "bg-surface-2 text-ink-2 ring-line",
      )}
    >
      {children}
    </span>
  );
}

const ICONE_ORIGEM = { site: Globe, celular: Smartphone, computador: Laptop } as const;
const NOME_ORIGEM = { site: "no site", celular: "no celular", computador: "no computador" } as const;

export function UltimoUso({ p, agora }: { p: PessoaUso; agora: Date }) {
  if (!p.ultimoUsoEm) return <span className="text-ink-3">nunca usou</span>;
  const Icone = p.ultimaOrigem ? ICONE_ORIGEM[p.ultimaOrigem] : null;
  return (
    <span className="inline-flex items-center gap-1.5" title={dataHora.format(p.ultimoUsoEm)}>
      {p.online ? <span aria-hidden className="size-1.5 rounded-full bg-ok" /> : null}
      {Icone ? <Icone className="size-3.5 text-ink-3" aria-label={NOME_ORIGEM[p.ultimaOrigem!]} /> : null}
      {p.online ? "online agora" : `${tempoRelativo(p.ultimoUsoEm, agora)}, ${dataHora.format(p.ultimoUsoEm)}`}
    </span>
  );
}

