import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CalcDemo } from "./calc-demo";
import { FavDemo } from "./fav-demo";
import { Card, CardTitle } from "./feature-card";
import { FramesDemo } from "./frames-demo";
import { PsdDemo } from "./psd-demo";
import { RefsDemo } from "./refs-demo";
import { ScrubDemo } from "./scrub-demo";
import { Container, SectionHeading } from "./section";

/** Para criar e organizar, cada função com a sua animação: sobe pro Drive, desce do Drive ou já abre direto no Drive. */
export function NovidadesSection() {
  return (
    <section id="novidades" aria-labelledby="novidades-titulo" className="scroll-mt-14 pb-20 sm:pb-28 2xl:pb-40">
      <Container>
        <SectionHeading id="novidades-titulo" eyebrow="Para criar" tone="up" title="Do bruto ao post, direto no Drive." />

        <div className="mt-12 grid gap-4 sm:mt-16 sm:gap-5 md:grid-cols-2 lg:grid-cols-3 2xl:gap-8">
          <Card className="grid content-start gap-8 md:col-span-2">
            <CardTitle
              eyebrow="Frames · no computador"
              tone="text-up-text"
              dir="ambos"
              title="Os melhores frames, por cena."
              text="Do filme pronto aos posts, numa pasta no Drive."
            />
            <FramesDemo />
          </Card>

          <Card className="grid content-start gap-8" delay={0.06}>
            <CardTitle eyebrow="Proxy e scrub" tone="text-up-text" dir="sobe" dirLabel="Sobe junto" title="O take corre no cursor." text="Proxy leve ao lado do BRAW ou ProRes." />
            <ScrubDemo />
          </Card>

          <Card className="grid content-start gap-8">
            <CardTitle eyebrow="PSD" tone="text-down-text" dir="nuvem" title="Photoshop aberto sem Photoshop." text="Pranchetas e camadas, no celular e no computador." />
            <PsdDemo />
          </Card>

          <Card className="grid content-start gap-8" delay={0.06}>
            <CardTitle eyebrow="Referências" tone="text-up-text" dir="sobe" title="Cola o link, salva a referência." text="Instagram, YouTube ou TikTok, direto na coleção." />
            <RefsDemo />
          </Card>

          <Card className="grid content-start gap-8" delay={0.12}>
            <CardTitle eyebrow="Cartões · calculadora grátis" tone="text-down-text" dir="sobe" dirLabel="Antes de subir" title="Quanto cabe no cartão?" text="GB por hora, cartões, HDs e tempo de cópia." />
            <CalcDemo />
            <Link href="/calculadora" className="inline-flex w-fit items-center gap-1.5 text-[15px] font-medium text-down-text hover:underline">
              Abrir a calculadora
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </Card>

          <Card className="grid gap-6 md:col-span-2 lg:col-span-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center lg:gap-12">
            <CardTitle eyebrow="Destino" tone="text-ink-2" dir="ambos" title="Suas pastas a um toque." text="Favoritas com estrela e as compartilhadas com você." />
            <FavDemo />
          </Card>
        </div>
      </Container>
    </section>
  );
}
