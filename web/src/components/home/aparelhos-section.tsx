import { Card, CardTitle } from "./feature-card";
import { DiscosDemo } from "./discos-demo";
import { LanDemo } from "./lan-demo";
import { Container, SectionHeading } from "./section";
import { WifiDemo } from "./wifi-demo";

/** Entre aparelhos: celular e computador pelo Wi-Fi, computador com computador e cartão para vários discos. */
export function AparelhosSection() {
  return (
    <section id="entre-aparelhos" aria-labelledby="aparelhos-titulo" className="scroll-mt-14 pb-20 sm:pb-28 2xl:pb-40">
      <Container>
        <SectionHeading id="aparelhos-titulo" eyebrow="Entre aparelhos" tone="ok" title="De um aparelho pro outro, sem esperar a nuvem." />

        <div className="mt-12 grid gap-4 sm:mt-16 sm:gap-5 md:grid-cols-2 2xl:gap-8">
          <Card className="grid gap-8 md:col-span-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] lg:items-center lg:gap-12">
            <CardTitle
              eyebrow="Celular e computador · pelo Wi-Fi"
              tone="text-ok-text"
              dir="rede"
              title="Do celular pro computador, sem cabo."
              text="iPhone, Android, Mac ou Windows, em qualquer direção. Quem está por perto só manda depois que você aceita."
            />
            <WifiDemo />
          </Card>

          <Card className="grid content-start gap-8" delay={0.06}>
            <CardTitle eyebrow="Entre computadores" tone="text-up-text" dir="rede" title="Direto pro PC do editor." text="Cifrado e conferido. Se quiser, sobe pro Drive junto." />
            <LanDemo />
          </Card>

          <Card className="grid content-start gap-8" delay={0.12}>
            <CardTitle eyebrow="Entre discos" tone="text-down-text" dir="disco" title="Um cartão, vários backups." text="Lê uma vez, grava em até 4 discos e confere cada arquivo." />
            <DiscosDemo />
          </Card>
        </div>
      </Container>
    </section>
  );
}
