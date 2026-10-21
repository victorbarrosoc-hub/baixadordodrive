/**
 * Kit das telas do site (docs/UI-KIT.md): as mesmas peças do app do computador (Frames, Cartões, Início), em React +
 * Tailwind com os tokens do site. Nada aqui usa estado: serve em componente de servidor. Escolhas (Opcoes, Pilulas)
 * são rádios de verdade, então funcionam dentro de <form> com ação de servidor e sem JavaScript.
 * A entrada em cascata usa `k-entra` + `--i`; "reduzir movimento" para tudo (globals.css).
 */
import Link from "next/link";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

export type Tom = "down" | "up" | "ok" | "warn" | "err" | "neutro";

const COR: Record<Tom, string> = {
  down: "var(--color-down)",
  up: "var(--color-up)",
  ok: "var(--color-ok)",
  warn: "var(--color-warn)",
  err: "var(--color-err)",
  neutro: "var(--color-ink-3)",
};
const COR_TEXTO: Record<Tom, string> = {
  down: "var(--color-down-text)",
  up: "var(--color-up-text)",
  ok: "var(--color-ok-text)",
  warn: "var(--color-warn-text)",
  err: "var(--color-err-text)",
  neutro: "var(--color-ink-2)",
};

/** Estilo com a cor do tom em --c (fundo) e --ct (texto). */
export function corDe(tom: Tom = "down"): React.CSSProperties {
  return { "--c": COR[tom], "--ct": COR_TEXTO[tom] } as React.CSSProperties;
}

const entra = (i: number) => ({ "--i": i }) as React.CSSProperties;

/** Conteúdo da página: uma coluna, ou duas (principal + `lado`, presa ao rolar no desktop). O título vem da Moldura. */
export function Pagina({ lado, larga = false, className, children }: { lado?: React.ReactNode; larga?: boolean; className?: string; children: React.ReactNode }) {
  if (!lado) return <div className={cn("grid gap-4", className)}>{children}</div>;
  return (
    <div className={cn("grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_var(--lado)]", className)} style={{ "--lado": larga ? "400px" : "360px" } as React.CSSProperties}>
      <div className="grid min-w-0 gap-4">{children}</div>
      <aside className="k-entra grid gap-3.5 xl:sticky xl:top-24" style={entra(2)}>
        {lado}
      </aside>
    </div>
  );
}

/** O bloco de cada assunto: numerado (passos de um fluxo) ou com ícone e cor (seções sem ordem). */
export function Passo({
  n,
  icone,
  tom = "down",
  titulo,
  sub,
  frase,
  acao,
  i = 1,
  id,
  className,
  children,
}: {
  n?: number;
  icone?: React.ReactNode;
  tom?: Tom;
  titulo: React.ReactNode;
  sub?: React.ReactNode;
  frase?: React.ReactNode;
  acao?: React.ReactNode;
  i?: number;
  id?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const tituloId = id ? `${id}-titulo` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={tituloId}
      className={cn("k-entra grid scroll-mt-24 gap-4 rounded-[20px] bg-surface p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] ring-1 ring-line sm:px-7 sm:pt-6 sm:pb-7", className)}
      style={entra(i)}
    >
      <div className="flex items-start gap-3.5">
        {icone ? (
          <span className="grid size-[30px] shrink-0 place-items-center rounded-[10px] bg-[color-mix(in_srgb,var(--c)_16%,transparent)] text-[var(--ct)] [&_svg]:size-4" style={corDe(tom)} aria-hidden>
            {icone}
          </span>
        ) : n != null ? (
          <span className="k-grad grid size-[30px] shrink-0 place-items-center rounded-[10px] text-[13px] font-bold text-white tabular-nums shadow-[0_6px_16px_-6px_color-mix(in_srgb,var(--color-down)_70%,transparent)]" aria-hidden>
            {n}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 id={tituloId} className="mt-[3px] text-[18px] font-semibold tracking-[-0.015em]">
            {titulo}
            {sub ? <small className="ml-1.5 text-[12px] font-medium text-ink-3">{sub}</small> : null}
          </h2>
          {frase ? <p className="mt-1 text-[14px] leading-relaxed text-pretty text-ink-2">{frase}</p> : null}
        </div>
        {acao ? <div className="shrink-0">{acao}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Rótulo pequeno em caixa alta (acima de um grupo de opções). */
export function Rotulo({ children, nota }: { children: React.ReactNode; nota?: React.ReactNode }) {
  return (
    <p className="text-[12px] font-semibold tracking-[0.04em] text-ink-3 uppercase">
      {children}
      {nota ? <small className="ml-1.5 font-normal tracking-normal normal-case">{nota}</small> : null}
    </p>
  );
}

export type OpcaoItem = { value: string; titulo: React.ReactNode; sub?: React.ReactNode; icone?: React.ReactNode; tom?: Tom; disabled?: boolean };

/** Opções em cartões, com o check. Rádios de verdade (`name`): funcionam em formulário. */
export function Opcoes({ name, valor, itens, colunas, label }: { name: string; valor?: string; itens: OpcaoItem[]; colunas?: number; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(var(--n),minmax(0,1fr))]" style={{ "--n": colunas || Math.min(itens.length, 4) } as React.CSSProperties}>
      {itens.map((o) => (
        <label
          key={o.value}
          style={corDe(o.tom ?? "down")}
          className={cn(
            "group relative grid min-h-[74px] cursor-pointer content-start gap-1 rounded-[14px] bg-surface-2 px-4 py-3.5 ring-1 ring-line ring-inset transition-[box-shadow,background-color,transform] duration-200 hover:-translate-y-px hover:ring-line-strong",
            "has-[:checked]:bg-[color-mix(in_srgb,var(--c)_10%,var(--color-surface))] has-[:checked]:shadow-[0_8px_22px_-12px_var(--c)] has-[:checked]:ring-[1.5px] has-[:checked]:ring-[var(--c)]",
            "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-down",
            o.disabled && "pointer-events-none opacity-50",
          )}
        >
          <input type="radio" name={name} value={o.value} defaultChecked={o.value === valor} disabled={o.disabled} className="sr-only" />
          {o.icone ? (
            <span className="mb-1.5 grid size-8 place-items-center rounded-[10px] bg-[color-mix(in_srgb,var(--c)_14%,transparent)] text-[var(--ct)] transition-colors group-has-[:checked]:bg-[var(--c)] group-has-[:checked]:text-white [&_svg]:size-[17px]">
              {o.icone}
            </span>
          ) : null}
          <b className="truncate text-[14.5px] font-semibold">{o.titulo}</b>
          {o.sub ? <span className="text-[12.5px] text-ink-2">{o.sub}</span> : null}
          <span aria-hidden className="absolute top-2.5 right-2.5 grid size-5 scale-[0.4] place-items-center rounded-full bg-[var(--c)] text-white opacity-0 transition-[opacity,transform] duration-200 group-has-[:checked]:scale-100 group-has-[:checked]:opacity-100">
            <Check className="size-3" strokeWidth={2.6} />
          </span>
        </label>
      ))}
    </div>
  );
}

/** Pílulas: rádios (com `name`) ou links (com `href`, para filtros por endereço). */
export function Pilulas({
  name,
  valor,
  itens,
  label,
}: {
  name?: string;
  valor?: string;
  itens: { value: string; label: React.ReactNode; conta?: React.ReactNode; href?: string }[];
  label: string;
}) {
  const base = "inline-flex h-[30px] min-w-[46px] items-center justify-center gap-1.5 rounded-full px-3 text-[13px] font-semibold tabular-nums transition-[background-color,color,transform] duration-150";
  const on = "bg-down text-white scale-[1.04]";
  const off = "bg-ink/[0.06] text-ink-2 hover:text-ink";
  return (
    <div role={name ? "radiogroup" : "navigation"} aria-label={label} className="flex flex-wrap gap-1.5">
      {itens.map((o) =>
        o.href ? (
          <Link key={o.value} href={o.href} aria-current={o.value === valor ? "page" : undefined} className={cn(base, "toque", o.value === valor ? on : off)}>
            {o.label}
            {o.conta != null ? <span className="text-[11.5px] opacity-75">{o.conta}</span> : null}
          </Link>
        ) : (
          <label key={o.value} className={cn(base, "cursor-pointer has-[:checked]:scale-[1.04] has-[:checked]:bg-down has-[:checked]:text-white has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-down", off)}>
            <input type="radio" name={name} value={o.value} defaultChecked={o.value === valor} className="sr-only" />
            {o.label}
            {o.conta != null ? <span className="text-[11.5px] opacity-75">{o.conta}</span> : null}
          </label>
        ),
      )}
    </div>
  );
}

/** Barra de progresso (0–1; null = sem fim definido, corre). */
export function Barra({ p, tom, vivo = false, label, className }: { p: number | null; tom?: "ok" | "err"; vivo?: boolean; label?: string; className?: string }) {
  const pct = p == null ? 100 : Math.max(0, Math.min(1, p)) * 100;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={p == null ? undefined : Math.round(pct)}
      className={cn("relative h-1.5 overflow-hidden rounded-full bg-ink/[0.08]", className)}
    >
      <i
        className={cn(
          "absolute inset-y-0 left-0 overflow-hidden rounded-full transition-[width] duration-500 ease-out-soft",
          tom === "ok" ? "bg-ok" : tom === "err" ? "bg-err" : "k-grad",
          (vivo || p == null) && "k-barra-viva",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** O cartão colorido com o número grande. `vivo` = brilho passando enquanto algo anda. */
export function Destaque({
  titulo,
  numero,
  unidade,
  linha,
  progresso,
  tom = "grad",
  vivo = false,
  className,
  children,
}: {
  titulo?: React.ReactNode;
  numero?: React.ReactNode;
  unidade?: React.ReactNode;
  linha?: React.ReactNode;
  progresso?: number | null;
  tom?: "grad" | "ok" | "err";
  vivo?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const fundo =
    tom === "ok"
      ? "bg-[radial-gradient(120%_90%_at_100%_0%,rgba(255,255,255,0.18),transparent_55%),linear-gradient(135deg,color-mix(in_srgb,var(--color-ok)_80%,#000),var(--color-ok))]"
      : tom === "err"
        ? "bg-[radial-gradient(120%_90%_at_100%_0%,rgba(255,255,255,0.16),transparent_55%),linear-gradient(135deg,color-mix(in_srgb,var(--color-err)_80%,#000),var(--color-err))]"
        : "bg-[radial-gradient(120%_90%_at_100%_0%,rgba(255,255,255,0.18),transparent_55%),linear-gradient(135deg,var(--color-down),var(--color-up))]";
  return (
    <div className={cn("relative isolate grid gap-3 overflow-hidden rounded-[20px] p-5 text-white shadow-[0_16px_34px_-18px_var(--color-up)] sm:p-6", fundo, vivo && "k-vivo", className)}>
      {titulo ? <span className="text-[12px] font-semibold tracking-[0.1em] uppercase opacity-85">{titulo}</span> : null}
      {numero != null ? (
        <div className="flex flex-wrap items-baseline gap-2.5">
          <b className="font-display text-[48px] leading-[0.95] font-bold tracking-[-0.05em] tabular-nums sm:text-[56px]">{numero}</b>
          {unidade ? <span className="text-[15px] font-medium opacity-90">{unidade}</span> : null}
        </div>
      ) : null}
      {progresso !== undefined ? (
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progresso == null ? undefined : Math.round(progresso * 100)} className="relative h-1.5 overflow-hidden rounded-full bg-white/25">
          <i className={cn("absolute inset-y-0 left-0 overflow-hidden rounded-full bg-white", (vivo || progresso == null) && "k-barra-viva")} style={{ width: `${progresso == null ? 100 : Math.max(0, Math.min(1, progresso)) * 100}%` }} />
        </div>
      ) : null}
      {linha ? <span className="text-[14px] leading-relaxed opacity-90">{linha}</span> : null}
      {children}
    </div>
  );
}

/** Painel lateral com título pequeno em caixa alta (o "O que vai sair" do Frames). */
export function Resumo({ titulo, className, children }: { titulo?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "grid gap-3.5 rounded-[22px] bg-surface p-5 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.18)] ring-1 ring-line sm:p-[22px]",
        "bg-[radial-gradient(120%_70%_at_0%_0%,color-mix(in_srgb,var(--color-down)_14%,transparent),transparent_60%),radial-gradient(120%_70%_at_100%_100%,color-mix(in_srgb,var(--color-up)_16%,transparent),transparent_60%)]",
        className,
      )}
    >
      {titulo ? <p className="text-[12px] font-semibold tracking-[0.08em] text-ink-2 uppercase">{titulo}</p> : null}
      {children}
    </div>
  );
}

/** Caixa dentro do Resumo. */
export function Caixa({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("grid gap-2.5 rounded-2xl bg-surface/70 p-3.5 ring-1 ring-line ring-inset", className)}>{children}</div>;
}

export type StatItem = { icone?: React.ReactNode; valor: React.ReactNode; rotulo: React.ReactNode; detalhe?: React.ReactNode; tom?: Tom };

/** 2–8 números com ícone colorido. */
export function Stats({ itens, colunas, className }: { itens: StatItem[]; colunas?: number; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(var(--n),minmax(0,1fr))]", className)} style={{ "--n": colunas || itens.length } as React.CSSProperties}>
      {itens.map((s, k) => (
        <div
          key={k}
          style={{ ...corDe(s.tom ?? "down"), ...entra(k + 1) }}
          className="k-entra grid content-start gap-1 rounded-2xl bg-[color-mix(in_srgb,var(--c)_7%,var(--color-surface))] p-3.5 ring-1 ring-[color-mix(in_srgb,var(--c)_18%,var(--color-line))] ring-inset"
        >
          {s.icone ? (
            <span aria-hidden className="mb-2 grid size-[30px] place-items-center rounded-[9px] bg-[var(--c)] text-white [&_svg]:size-[15px]">
              {s.icone}
            </span>
          ) : null}
          <b className="font-display text-[24px] leading-[1.1] font-bold tracking-[-0.02em] tabular-nums">{s.valor}</b>
          <span className="text-[12.5px] text-ink-2">{s.rotulo}</span>
          {s.detalhe ? <span className="text-[12px] font-medium text-[var(--ct)]">{s.detalhe}</span> : null}
        </div>
      ))}
    </div>
  );
}

/** Linhas de ajuste: texto à esquerda, controle à direita. */
export function Linhas({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("grid overflow-hidden rounded-2xl ring-1 ring-line ring-inset [&>*+*]:border-t [&>*+*]:border-line", className)}>{children}</div>;
}
export function Linha({ titulo, sub, children, className }: { titulo: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2 bg-surface-2 px-4 py-3", className)}>
      <div className="grid min-w-0 gap-0.5">
        <b className="text-[15px] font-semibold">{titulo}</b>
        {sub ? <span className="text-[13px] leading-relaxed text-pretty text-ink-2">{sub}</span> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}

/** Linha de lista (aparelho, Drive, pessoa). Com `href` vira link. */
export function Item({
  icone,
  tom = "down",
  titulo,
  sub,
  fim,
  href,
  on = false,
  className,
  children,
}: {
  icone?: React.ReactNode;
  tom?: Tom;
  titulo: React.ReactNode;
  sub?: React.ReactNode;
  fim?: React.ReactNode;
  href?: string;
  on?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const classes = cn(
    "flex items-center gap-3.5 rounded-2xl bg-surface-2 px-3.5 py-3 text-left ring-1 ring-line ring-inset transition-[box-shadow,transform,background-color] duration-200",
    href && "hover:-translate-y-px hover:ring-line-strong",
    on && "bg-[color-mix(in_srgb,var(--c)_10%,var(--color-surface))] ring-[1.5px] ring-[var(--c)]",
    className,
  );
  const conteudo = (
    <>
      {icone ? (
        <span aria-hidden className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl bg-[color-mix(in_srgb,var(--c)_14%,transparent)] text-[var(--ct)] [&_svg]:size-[19px]">
          {icone}
        </span>
      ) : null}
      <span className="grid min-w-0 flex-1 gap-0.5">
        <b className="truncate text-[15px] font-semibold">{titulo}</b>
        {sub ? <span className="text-[13px] text-ink-2">{sub}</span> : null}
        {children}
      </span>
      {fim ? <span className="flex shrink-0 items-center gap-2">{fim}</span> : null}
    </>
  );
  return href ? (
    <Link href={href} className={classes} style={corDe(tom)}>
      {conteudo}
    </Link>
  ) : (
    <div className={classes} style={corDe(tom)}>
      {conteudo}
    </div>
  );
}

/** Ponto de estado (verde que pulsa = online). */
export function Ponto({ ok = false }: { ok?: boolean }) {
  return <span aria-hidden className={cn("inline-block size-2 rounded-full", ok ? "animate-[sd-k-pulsa_2s_ease-out_infinite] bg-ok shadow-[0_0_0_0_color-mix(in_srgb,var(--color-ok)_60%,transparent)]" : "bg-ink-3")} />;
}

const classesBotao =
  "k-grad inline-flex h-13 items-center justify-center gap-2.5 rounded-2xl px-6 text-[16px] font-semibold text-white shadow-[0_12px_28px_-12px_var(--color-up),inset_0_1px_0_rgba(255,255,255,0.25)] transition-[transform,box-shadow,opacity] duration-200 hover:-translate-y-px hover:shadow-[0_16px_34px_-12px_var(--color-up),inset_0_1px_0_rgba(255,255,255,0.3)] active:translate-y-0 active:scale-[0.99] disabled:pointer-events-none disabled:opacity-40 disabled:shadow-none [&_svg]:size-[18px]";

/** A ação principal da tela (gradiente). Botão (de formulário, por padrão submit) ou link (`href`). */
export function BotaoGrande({
  href,
  cheio = true,
  dica,
  className,
  children,
  ...rest
}: { href?: string; cheio?: boolean; dica?: React.ReactNode; className?: string; children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = cn(classesBotao, cheio && "w-full", className);
  return (
    <>
      {href ? (
        <Link href={href} className={classes}>
          {children}
        </Link>
      ) : (
        <button type="submit" className={classes} {...rest}>
          {children}
        </button>
      )}
      {dica ? <p className="-mt-1 text-center text-[13px] text-ink-2">{dica}</p> : null}
    </>
  );
}

/** As classes do botão grande (para componentes de cliente que já têm o próprio botão). */
export const botaoGrandeClasses = (cheio = true, className?: string) => cn(classesBotao, cheio && "w-full", className);

/** Estado vazio com o desenho que respira. */
export function Vazio({ icone, titulo, children, acoes, className }: { icone: React.ReactNode; titulo: React.ReactNode; children?: React.ReactNode; acoes?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("k-entra grid justify-items-center gap-2.5 px-6 py-11 text-center", className)} style={entra(1)}>
      <div className="k-onda relative mb-2 grid size-24 place-items-center" aria-hidden>
        <span className="k-grad relative grid size-14 place-items-center rounded-[18px] text-white shadow-[0_12px_28px_-12px_var(--color-up)] [&_svg]:size-6">{icone}</span>
      </div>
      <h3 className="text-[18px] font-semibold">{titulo}</h3>
      {children ? <p className="max-w-[46ch] text-[14px] leading-relaxed text-pretty text-ink-2">{children}</p> : null}
      {acoes ? <div className="mt-2 flex flex-wrap justify-center gap-2">{acoes}</div> : null}
    </div>
  );
}

/** Número grande em gradiente (dentro de uma faixa clara), como a quantidade do Frames. */
export function Numero({ valor, rotulo, className }: { valor: React.ReactNode; rotulo?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid justify-items-start", className)}>
      <b className="k-grad bg-clip-text font-display text-[46px] leading-none font-bold tracking-[-0.04em] text-transparent tabular-nums">{valor}</b>
      {rotulo ? <span className="text-[12.5px] text-ink-2">{rotulo}</span> : null}
    </div>
  );
}
