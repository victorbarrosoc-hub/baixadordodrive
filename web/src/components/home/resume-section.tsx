import { HardDrive, MoonStar, RefreshCw } from "lucide-react";
import { Md5Demo } from "./md5-demo";
import { Reveal } from "./motion";
import { PauseDemo } from "./pause-demo";
import { Container, SectionHeading } from "./section";

const TILES = [
  {
    icon: RefreshCw,
    title: "Volta sozinho",
    text: "Sem internet, ele tenta de novo sozinho e continua de onde parou. Não precisa ficar olhando.",
  },
  {
    icon: MoonStar,
    title: "O computador não dorme no meio",
    text: "Enquanto houver transferência, o SOBEDESCE não deixa o computador dormir. A tela pode apagar.",
  },
  {
    icon: HardDrive,
    title: "Disco cheio não apaga nada",
    text: "Libere espaço ou reconecte o disco externo e clique em Retomar. O que já veio continua lá.",
  },
];

const card = "rounded-[28px] bg-surface p-6 ring-1 ring-line shadow-[0_1px_2px_rgba(0,0,0,0.04)] sm:p-9";

export function ResumeSection() {
  return (
    <section aria-labelledby="retoma-titulo" className="bg-surface-2 py-24 sm:py-36">
      <Container>
        <SectionHeading id="retoma-titulo" eyebrow="Pausa e retoma" tone="up" title="Pode fechar o app. Pode cair a internet.">
          <p>
            O progresso vai para o disco a cada 2 segundos. Quando você abre o app de novo, ou quando a conexão volta, a transferência continua do último ponto confirmado. Nada recomeça do zero.
          </p>
        </SectionHeading>

        <div className="mt-14 grid gap-4 sm:mt-20 sm:gap-5 lg:grid-cols-5">
          <Reveal className={`${card} lg:col-span-3`}>
            <h3 className="mb-7 text-[19px] font-semibold tracking-tight text-ink sm:text-[21px]">Caiu no meio. Continuou do meio.</h3>
            <PauseDemo />
          </Reveal>
          <Reveal className={`${card} lg:col-span-2`} delay={0.08}>
            <h3 className="text-[19px] font-semibold tracking-tight text-ink sm:text-[21px]">Cada arquivo conferido.</h3>
            <p className="mt-2 mb-7 text-[15px] leading-relaxed text-ink-2">
              No fim, o SOBEDESCE compara o MD5 do arquivo com o que o Google calculou. Se não bater, você fica sabendo.
            </p>
            <Md5Demo />
          </Reveal>
        </div>

        <div className="mt-4 grid gap-4 sm:mt-5 sm:gap-5 md:grid-cols-3">
          {TILES.map((tile, i) => (
            <Reveal key={tile.title} delay={i * 0.06} className={`${card} grid content-start gap-3`}>
              <tile.icon className="size-6 text-up-text" aria-hidden="true" />
              <h3 className="text-[17px] font-semibold tracking-tight text-ink">{tile.title}</h3>
              <p className="text-[15px] leading-relaxed text-ink-2">{tile.text}</p>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  );
}
