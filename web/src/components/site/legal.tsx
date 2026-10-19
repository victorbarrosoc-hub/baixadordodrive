import { cn } from "@/lib/cn";
import { LEGAL_ATUALIZADO_EM } from "@/lib/site";
import { SiteFooter } from "./footer";
import { SiteHeader } from "./header";

/** Moldura das páginas legais: cabeçalho, título, data de atualização, texto e rodapé. */
export function LegalPage({ title, intro, children }: { title: string; intro: React.ReactNode; children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main className="px-5 pt-16 pb-24 sm:px-8 sm:pt-24 sm:pb-32 2xl:pt-32">
        <article className="mx-auto max-w-[680px] 2xl:max-w-[800px]">
          <header className="border-b border-line pb-10">
            <p className="text-[14px] text-ink-3">Atualizada em {LEGAL_ATUALIZADO_EM}</p>
            <h1 className="mt-3 font-display text-[40px] leading-[1.05] font-semibold tracking-[-0.03em] text-ink sm:text-[56px] 2xl:text-[68px]">{title}</h1>
            <div className="mt-6 text-[18px] leading-relaxed text-pretty text-ink-2 sm:text-[19px] 2xl:text-[21px]">{intro}</div>
          </header>
          <div className="grid gap-12 pt-10">{children}</div>
        </article>
      </main>
      <SiteFooter />
    </>
  );
}

export function LegalSection({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="grid scroll-mt-20 gap-4">
      <h2 className="text-[22px] font-semibold tracking-tight text-ink sm:text-[24px] 2xl:text-[28px]">{title}</h2>
      <div className="grid gap-4 text-[16px] leading-[1.65] text-pretty text-ink-2 2xl:text-[18px] [&_a]:font-medium [&_a]:text-down-text [&_a]:underline-offset-2 hover:[&_a]:underline [&_strong]:font-semibold [&_strong]:text-ink">
        {children}
      </div>
    </section>
  );
}

export function LegalList({ children, className }: { children: React.ReactNode; className?: string }) {
  return <ul className={cn("grid list-disc gap-2.5 pl-5 marker:text-ink-3", className)}>{children}</ul>;
}
