import { CompareDemo } from "./compare-demo";
import { Reveal } from "./motion";
import { Container, SectionHeading } from "./section";

export function CompareSection() {
  return (
    <section aria-labelledby="comparar-titulo" className="py-24 sm:py-36">
      <Container className="grid items-center gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
        <SectionHeading id="comparar-titulo" eyebrow="Comparador" tone="ok" align="left" title="O que já subiu. O que falta.">
          <p>
            Escolha a pasta do projeto no computador e a pasta correspondente no Drive. O SOBEDESCE mostra, pasta por pasta, o que já está lá, o que falta e o que está diferente.
          </p>
          <p>Depois sobe só o que falta. E traz para o computador o que só existe no Drive.</p>
        </SectionHeading>
        <Reveal delay={0.08}>
          <div className="rounded-[28px] bg-surface-2 p-4 ring-1 ring-line sm:p-7">
            <CompareDemo />
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
