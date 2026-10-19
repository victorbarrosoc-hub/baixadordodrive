import { cn } from "@/lib/cn";
import { Reveal } from "./motion";

type Tone = "down" | "up" | "ok" | "ink" | "light";

const EYEBROW: Record<Tone, string> = {
  down: "text-down-text",
  up: "text-up-text",
  ok: "text-ok-text",
  ink: "text-ink-2",
  light: "text-down-soft",
};

/** Título de seção: sobretítulo colorido, título grande e um parágrafo curto. */
export function SectionHeading({
  eyebrow,
  title,
  children,
  tone = "ink",
  align = "center",
  id,
  dark = false,
}: {
  eyebrow: string;
  title: React.ReactNode;
  children?: React.ReactNode;
  tone?: Tone;
  align?: "center" | "left";
  id?: string;
  dark?: boolean;
}) {
  return (
    <Reveal className={cn("grid gap-5", align === "center" ? "mx-auto max-w-3xl text-center 2xl:max-w-5xl" : "max-w-xl 2xl:max-w-3xl")}>
      <p className={cn("text-[15px] font-semibold sm:text-[17px]", EYEBROW[tone])}>{eyebrow}</p>
      <h2
        id={id}
        className={cn(
          "font-display text-[34px] leading-[1.06] font-semibold tracking-[-0.03em] text-balance sm:text-[48px] lg:text-[clamp(56px,3.6vw,96px)]",
          dark ? "text-white" : "text-ink",
        )}
      >
        {title}
      </h2>
      {children ? (
        <div
          className={cn(
            "grid gap-4 text-[17px] leading-[1.55] text-pretty sm:text-[19px] 2xl:text-[21px]",
            dark ? "text-white/65" : "text-ink-2",
            align === "center" && "mx-auto max-w-2xl",
          )}
        >
          {children}
        </div>
      ) : null}
    </Reveal>
  );
}

export function Container({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("largura", className)}>{children}</div>;
}
