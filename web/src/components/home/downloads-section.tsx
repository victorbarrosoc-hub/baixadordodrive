import Link from "next/link";
import { Download, Laptop, Monitor, Smartphone } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { DOWNLOAD_MAC, DOWNLOAD_WINDOWS, ROTAS } from "@/lib/site";
import { Reveal } from "./motion";
import { Container, SectionHeading } from "./section";

/**
 * Os dois instaladores. O do sistema do visitante ganha destaque (data-plat no contêiner da
 * página). As classes ficam escritas por inteiro para o Tailwind encontrar.
 */
const OS = {
  mac: {
    href: DOWNLOAD_MAC,
    icon: Laptop,
    title: "Mac",
    button: "Baixar para Mac",
    file: "Instalador .dmg. Funciona em Mac com Apple Silicon e com Intel.",
    first: "Na primeira vez, clique com o botão direito no app → Abrir. Se não aparecer a opção, vá em Ajustes do Sistema → Privacidade e Segurança → Abrir Mesmo Assim.",
    card: "group-data-[plat=mac]/plat:ring-2 group-data-[plat=mac]/plat:ring-ink",
    badge: "group-data-[plat=mac]/plat:visible",
    btnOn: "group-data-[plat=mac]/plat:bg-primary group-data-[plat=mac]/plat:text-primary-fg group-data-[plat=mac]/plat:ring-0",
  },
  windows: {
    href: DOWNLOAD_WINDOWS,
    icon: Monitor,
    title: "Windows",
    button: "Baixar para Windows",
    file: "Instalador .exe. Instala só para o seu usuário, sem senha de administrador.",
    first: "Se aparecer “O Windows protegeu o computador”, clique em Mais informações → Executar assim mesmo.",
    card: "group-data-[plat=windows]/plat:ring-2 group-data-[plat=windows]/plat:ring-ink",
    badge: "group-data-[plat=windows]/plat:visible",
    btnOn: "group-data-[plat=windows]/plat:bg-primary group-data-[plat=windows]/plat:text-primary-fg group-data-[plat=windows]/plat:ring-0",
  },
} as const;

export function DownloadsSection() {
  return (
    <section id="baixar" aria-labelledby="baixar-titulo" className="scroll-mt-14 bg-surface-2 py-24 sm:py-36">
      <Container>
        <SectionHeading id="baixar-titulo" eyebrow="Baixar" title="SOBEDESCE para Mac e Windows.">
          <p>O app de computador é onde as transferências grandes acontecem. Entre com a sua conta e os seus Drives já aparecem lá.</p>
        </SectionHeading>

        <div className="mx-auto mt-14 grid max-w-4xl gap-4 sm:mt-20 sm:gap-5 md:grid-cols-2">
          {(Object.keys(OS) as Array<keyof typeof OS>).map((key, i) => {
            const os = OS[key];
            return (
              <Reveal key={key} delay={i * 0.08} className={cn("relative grid content-start gap-5 rounded-[28px] bg-surface p-6 ring-1 ring-line transition-shadow sm:p-8", os.card)}>
                <div className="flex items-start justify-between gap-3">
                  <span className="grid size-12 place-items-center rounded-2xl bg-surface-2">
                    <os.icon className="size-6 text-ink" aria-hidden="true" />
                  </span>
                  <span className={cn("invisible inline-flex h-6 items-center rounded-full bg-ink px-2.5 text-[11px] font-medium text-white", os.badge)}>
                    Para este computador
                  </span>
                </div>
                <div className="grid gap-2">
                  <h3 className="font-display text-[28px] leading-tight font-semibold tracking-[-0.02em] text-ink">{os.title}</h3>
                  <p className="text-[15px] leading-relaxed text-ink-2">{os.file}</p>
                </div>
                <a href={os.href} className={buttonClasses({ variant: "secondary", size: "lg", className: cn("w-full", os.btnOn) })}>
                  <Download aria-hidden="true" />
                  {os.button}
                </a>
                <p className="text-[13px] leading-relaxed text-ink-3">{os.first}</p>
              </Reveal>
            );
          })}
        </div>

        <Reveal className="mx-auto mt-8 grid max-w-4xl gap-4 sm:mt-10">
          <p className="rounded-2xl bg-warn/10 px-5 py-4 text-[14px] leading-relaxed text-ink-2 ring-1 ring-warn/25">
            <strong className="font-semibold text-ink">Versão de teste.</strong> O app ainda não tem assinatura da Apple nem da Microsoft, por isso o sistema
            pede uma confirmação na primeira vez que você abre. Depois abre direto.
          </p>
          <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-[14px] text-ink-2">
            <Smartphone className="size-4" aria-hidden="true" />
            No celular não precisa instalar.
            <Link href={ROTAS.celular} className="font-medium text-up-text hover:underline">
              Usar no celular
            </Link>
          </p>
        </Reveal>
      </Container>
    </section>
  );
}
