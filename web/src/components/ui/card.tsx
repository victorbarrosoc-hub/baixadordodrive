import { cn } from "@/lib/cn";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-card bg-surface shadow-[0_0.5px_0_rgba(0,0,0,0.04),0_1px_3px_rgba(0,0,0,0.04)] ring-1 ring-line", className)} {...props} />;
}

export function CardHeader({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-6 pt-5">
      <div className="grid gap-1">
        <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
        {description ? <p className="text-[14px] text-ink-2">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
