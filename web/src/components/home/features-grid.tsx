import { Check, Cloud, Pause, ShieldCheck, Smartphone } from "lucide-react";
import { cn } from "@/lib/cn";
import { CompareDemo } from "./compare-demo";
import { Reveal } from "./motion";
import { Container, SectionHeading } from "./section";
import { StealDemo } from "./steal-demo";

const VELOCIDADE = ["Até 32 conexões por arquivo", "Conexão lenta é refeita sozinha", "4 arquivos sobem ao mesmo tempo"];

const SMALL = [
  { icon: Pause, title: "Pausa e retoma", text: "Fecha o app, cai a internet: volta de onde parou, sem recomeçar.", tone: "text-up-text bg-up/10" },
  { icon: ShieldCheck, title: "Cada arquivo conferido", text: "MD5 no fim de cada transferência. Chegou igual ou avisa.", tone: "text-ok-text bg-ok/10" },
  { icon: Smartphone, title: "Celular sem instalar", text: "Do iPhone ou Android direto para o Drive, pelo navegador.", tone: "text-down-text bg-down/10" },
  { icon: Cloud, title: "Vários Drives, uma conta", text: "Conecte quantos Drives quiser. Computador e celular usam os mesmos.", tone: "text-ink bg-ink/5" },
];

function Card({ className, children, delay = 0 }: { className?: string; children: React.ReactNode; delay?: number }) {
  return (
    <Reveal delay={delay} className={cn("rounded-[24px] bg-surface p-6 ring-1 ring-line sm:p-8", className)}>
      {children}
    </Reveal>
  );
}

function CardTitle({ eyebrow, title, text, tone }: { eyebrow: string; title: string; text: string; tone: string }) {
  return (
    <div className="grid gap-2">
      <p className={cn("text-[13px] font-semibold", tone)}>{eyebrow}</p>
      <h3 className="font-display text-[24px] leading-tight font-semibold tracking-[-0.02em] text-ink sm:text-[28px]">{title}</h3>
      <p className="max-w-md text-[15px] leading-relaxed text-ink-2">{text}</p>
    </div>
  );
}

/** Os recursos em grade: dois destaques com demonstração e quatro cartões curtos. */
export function FeaturesGrid() {
  return (
    <section id="recursos" aria-labelledby="recursos-titulo" className="scroll-mt-14 py-20 sm:py-28">
      <Container>
        <SectionHeading id="recursos-titulo" eyebrow="Recursos" title="Feito para arquivo grande." />

        <div className="mt-12 grid gap-4 sm:mt-16 sm:gap-5 lg:grid-cols-2">
          <Card className="flex flex-col gap-8">
            <CardTitle
              eyebrow="Velocidade"
              tone="text-down-text"
              title="Toda a banda, num arquivo só."
              text="Várias conexões dividem o mesmo arquivo, cada uma num pedaço."
            />
            <StealDemo />
            <ul className="mt-auto grid gap-3 border-t border-line pt-6">
              {VELOCIDADE.map((v) => (
                <li key={v} className="flex items-center gap-3 text-[15px] text-ink">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-down/10 text-down-text">
                    <Check className="size-3.5" aria-hidden="true" />
                  </span>
                  {v}
                </li>
              ))}
            </ul>
          </Card>
          <Card className="grid content-start gap-8" delay={0.06}>
            <CardTitle
              eyebrow="Comparador"
              tone="text-up-text"
              title="O que subiu e o que falta."
              text="Pasta por pasta, contra o Drive. Um toque sobe só o que falta."
            />
            <CompareDemo />
          </Card>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:mt-5 sm:gap-5 lg:grid-cols-4">
          {SMALL.map((f, i) => (
            <Card key={f.title} delay={i * 0.05} className="grid content-start gap-3 p-5 sm:gap-4 sm:p-7">
              <span className={cn("grid size-10 place-items-center rounded-xl", f.tone)}>
                <f.icon className="size-5" aria-hidden="true" />
              </span>
              <div className="grid gap-1.5">
                <h3 className="text-[17px] font-semibold tracking-tight text-ink">{f.title}</h3>
                <p className="text-[14px] leading-relaxed text-ink-2">{f.text}</p>
              </div>
            </Card>
          ))}
        </div>
      </Container>
    </section>
  );
}
