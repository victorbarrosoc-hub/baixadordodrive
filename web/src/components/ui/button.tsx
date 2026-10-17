import Link from "next/link";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "up" | "down";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-primary text-primary-fg hover:bg-primary/85",
  secondary: "bg-surface text-ink ring-1 ring-line-strong hover:bg-surface-2",
  ghost: "text-ink hover:bg-ink/5",
  danger: "bg-err text-white hover:bg-err/85",
  up: "bg-up text-white hover:bg-up/85",
  down: "bg-down text-white hover:bg-down/85",
};

const SIZES: Record<Size, string> = {
  // Desenho de 36 px; o toque (utilitário em globals.css) chega a 44 px.
  sm: "toque h-9 px-4 text-[14px] gap-1.5",
  md: "h-11 px-5 text-[15px] gap-2",
  lg: "h-13 px-7 text-[17px] gap-2",
};

/** Pílula: o botão da casa. */
export function buttonClasses({ variant = "primary", size = "md", className }: { variant?: Variant; size?: Size; className?: string } = {}) {
  return cn(
    "inline-flex items-center justify-center rounded-full font-medium whitespace-nowrap transition-[background-color,box-shadow,transform,opacity] duration-200 ease-out-soft active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-[1.1em] [&_svg]:shrink-0",
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

export function Button({
  variant,
  size,
  className,
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button type={type} className={buttonClasses({ variant, size, className })} {...props} />;
}

export function ButtonLink({
  variant,
  size,
  className,
  ...props
}: React.ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={buttonClasses({ variant, size, className })} {...props} />;
}
