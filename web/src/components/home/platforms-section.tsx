import Link from "next/link";
import { ArrowRight, Download, Laptop, Monitor, Smartphone } from "lucide-react";
import { Comando } from "@/components/comando";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { DOWNLOAD_MAC, DOWNLOAD_WINDOWS, INSTALAR_MAC, INSTALAR_WINDOWS, ROTAS } from "@/lib/site";
import { Reveal } from "./motion";
import { Container, SectionHeading } from "./section";

/** O cartão do sistema do visitante ganha destaque (data-plat no contêiner da página). Classes por inteiro para o Tailwind. */
const PLATS = [
  {
    key: "mac",
    icon: Laptop,
    title: "Mac",
    sub: "Apple Silicon e Intel",
    href: DOWNLOAD_MAC,
    label: "Baixar .dmg",
    icon2: Download,
    terminal: { titulo: "Ou pelo Terminal, sem o aviso da Apple", comando: INSTALAR_MAC, rotulo: "Comando para instalar no Mac pelo Terminal" },
    on: "group-data-[plat=mac]/plat:ring-2 group-data-[plat=mac]/plat:ring-ink",
  },
  {
    key: "windows",
    icon: Monitor,
    title: "Windows",
    sub: "Windows 10 e 11",
    href: DOWNLOAD_WINDOWS,
    label: "Baixar .exe",
    icon2: Download,
    terminal: { titulo: "Ou pelo PowerShell, sem o aviso do Windows", comando: INSTALAR_WINDOWS, rotulo: "Comando para instalar no Windows pelo PowerShell" },
    on: "group-data-[plat=windows]/plat:ring-2 group-data-[plat=windows]/plat:ring-ink",
  },
  {
    key: "celular",
    icon: Smartphone,
    title: "iPhone e Android",
    sub: "Pelo navegador, sem instalar",
    href: ROTAS.celular,
    label: "Abrir no celular",
    icon2: ArrowRight,
    terminal: null,
    on: "group-data-[plat=ios]/plat:ring-2 group-data-[plat=ios]/plat:ring-ink group-data-[plat=android]/plat:ring-2 group-data-[plat=android]/plat:ring-ink",
  },
] as const;

export function PlatformsSection() {
  return (
    <section id="baixar" aria-labelledby="baixar-titulo" className="scroll-mt-14 bg-surface-2 py-20 sm:py-28 2xl:py-40">
      <Container>
        <SectionHeading id="baixar-titulo" eyebrow="Plataformas" title="Onde você estiver." />

        <div className="mx-auto mt-12 grid max-w-5xl gap-4 sm:mt-16 sm:gap-5 md:grid-cols-3 xl:max-w-none 2xl:gap-8">
          {PLATS.map((p, i) => {
            const interno = p.key === "celular";
            const btn = buttonClasses({ variant: "secondary", size: "md", className: "w-full" });
            return (
              <Reveal key={p.key} delay={i * 0.06} className={cn("grid content-start gap-6 rounded-[24px] bg-surface p-6 ring-1 ring-line sm:p-7", p.on)}>
                <span className="grid size-12 place-items-center rounded-2xl bg-surface-2">
                  <p.icon className="size-6 text-ink" aria-hidden="true" />
                </span>
                <div className="grid gap-1">
                  <h3 className="font-display text-[22px] font-semibold tracking-[-0.02em] text-ink">{p.title}</h3>
                  <p className="text-[14px] text-ink-2">{p.sub}</p>
                </div>
                {interno ? (
                  <Link href={p.href} className={btn}>
                    {p.label}
                    <p.icon2 aria-hidden="true" />
                  </Link>
                ) : (
                  <a href={p.href} className={btn}>
                    <p.icon2 aria-hidden="true" />
                    {p.label}
                  </a>
                )}
                {p.terminal ? (
                  <div className="grid min-w-0 gap-2">
                    <p className="text-[13px] text-ink-2">{p.terminal.titulo}:</p>
                    <Comando comando={p.terminal.comando} rotulo={p.terminal.rotulo} />
                  </div>
                ) : null}
              </Reveal>
            );
          })}
        </div>

        <p className="mx-auto mt-8 max-w-2xl text-center text-[13px] leading-relaxed text-ink-3">
          Versão de teste, ainda sem assinatura da Apple e da Microsoft. Pelo comando, instala sem aviso. Pelo navegador, libere na primeira vez:
          no Mac em Privacidade e Segurança, no Windows em Mais informações → Executar assim mesmo.
        </p>
      </Container>
    </section>
  );
}
