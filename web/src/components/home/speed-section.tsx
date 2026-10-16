import { Layers, RotateCw, Split } from "lucide-react";
import { Counter, Reveal } from "./motion";
import { Container, SectionHeading } from "./section";
import { StealDemo } from "./steal-demo";

/** Números tirados dos ajustes do app (src/config.js): padrão e máximo. */
const STATS = [
  { value: 8, label: "conexões por arquivo baixado, no padrão" },
  { value: 32, label: "conexões por arquivo, no máximo, nos ajustes" },
  { value: 4, label: "arquivos subindo juntos, no padrão" },
];

const POINTS = [
  {
    icon: Split,
    title: "Pedaços em paralelo",
    text: "Cada conexão baixa um pedaço do mesmo arquivo. Juntas, enchem o link que uma conexão sozinha não enche.",
  },
  {
    icon: RotateCw,
    title: "Conexão lenta é refeita",
    text: "Às vezes o Google segura uma conexão. O SOBEDESCE percebe que ela ficou para trás e reabre.",
  },
  {
    icon: Layers,
    title: "Vários arquivos subindo",
    text: "No envio, o Google recebe cada arquivo em sequência. Por isso o SOBEDESCE sobe vários ao mesmo tempo.",
  },
];

export function SpeedSection() {
  return (
    <section id="recursos" aria-labelledby="velocidade-titulo" className="scroll-mt-14 py-24 sm:py-36">
      <Container>
        <SectionHeading id="velocidade-titulo" eyebrow="Velocidade" tone="down" title="Uma conexão é pouco para um arquivo desse tamanho.">
          <p>
            O navegador baixa um arquivo por uma conexão só. O SOBEDESCE abre várias com o Google para o mesmo arquivo e divide o trabalho entre elas.
          </p>
        </SectionHeading>

        <Reveal className="mt-14 sm:mt-20" delay={0.05}>
          <div className="rounded-[28px] bg-surface p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_24px_60px_-30px_rgba(0,40,120,0.25)] ring-1 ring-line sm:p-10">
            <StealDemo />
          </div>
        </Reveal>

        <div className="mt-14 grid grid-cols-3 gap-4 sm:mt-20 sm:gap-6">
          {STATS.map((s, i) => (
            <Reveal key={s.label} delay={i * 0.08} className="grid content-start gap-2 border-t border-line pt-5 sm:pt-6">
              <span className="font-display text-[48px] leading-none font-semibold tracking-[-0.04em] text-ink sm:text-[80px]">
                <Counter to={s.value} />
              </span>
              <span className="text-[13px] leading-snug text-ink-2 sm:text-[15px]">{s.label}</span>
            </Reveal>
          ))}
        </div>

        <div className="mt-16 grid gap-8 sm:mt-24 md:grid-cols-3 md:gap-10">
          {POINTS.map((p, i) => (
            <Reveal key={p.title} delay={i * 0.08} className="grid content-start gap-3">
              <span className="grid size-10 place-items-center rounded-full bg-down/10 text-down-text">
                <p.icon className="size-5" aria-hidden="true" />
              </span>
              <h3 className="text-[19px] font-semibold tracking-tight text-ink">{p.title}</h3>
              <p className="text-[15px] leading-relaxed text-ink-2">{p.text}</p>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  );
}
