import Link from "next/link";
import { ArrowRight, Cloud, KeyRound, MonitorSmartphone } from "lucide-react";
import { ROTAS } from "@/lib/site";
import { Reveal } from "./motion";
import { Container, SectionHeading } from "./section";

const DOTS = [0, 0.45, 0.9, 1.35, 1.8, 2.25];

/** Dois caminhos: os arquivos vão direto ao Google; para a SOBEDESCE, só a conta. */
function Diagram() {
  return (
    <div className="mx-auto grid max-w-3xl grid-cols-[72px_minmax(0,1fr)_104px] grid-rows-2 items-center gap-y-8 sm:grid-cols-[112px_minmax(0,1fr)_150px] sm:gap-y-12">
      <div className="row-span-2 grid justify-items-center gap-2 text-center">
        <span className="grid size-14 place-items-center rounded-2xl bg-white/[0.06] ring-1 ring-white/15 sm:size-20">
          <MonitorSmartphone className="size-6 text-white sm:size-8" aria-hidden="true" />
        </span>
        <span className="text-[12px] leading-tight font-medium text-white/80 sm:text-[14px]">Seu aparelho</span>
      </div>

      {/* Arquivos: caminho direto ao Google. */}
      <div className="relative mx-2 sm:mx-4">
        <span className="absolute -top-7 left-0 text-[11px] font-medium text-white/60 sm:text-[13px]">Seus arquivos</span>
        <div className="relative h-[3px] rounded-full bg-gradient-to-r from-up/50 via-white/40 to-down/60">
          {DOTS.map((d) => (
            <span
              key={d}
              aria-hidden="true"
              className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_14px_3px_rgba(169,149,255,0.7)]"
              style={{ animation: `sd-travel 2.7s linear ${-d}s infinite`, left: `${(d / 2.7) * 100}%` }}
            />
          ))}
        </div>
      </div>
      <div className="grid justify-items-center gap-2 text-center">
        <span className="grid size-12 place-items-center rounded-2xl bg-white/[0.06] ring-1 ring-white/15 sm:size-16">
          <Cloud className="size-6 text-white sm:size-7" aria-hidden="true" />
        </span>
        <span className="text-[12px] leading-tight font-medium text-white/80 sm:text-[14px]">Google Drive</span>
      </div>

      {/* Conta: só login e o acesso ao Drive. */}
      <div className="relative mx-2 sm:mx-4">
        <span className="absolute -top-7 left-0 text-[11px] font-medium text-white/40 sm:text-[13px]">Só a conta</span>
        <div
          aria-hidden="true"
          className="h-px bg-[linear-gradient(to_right,rgba(255,255,255,0.35)_50%,transparent_50%)] bg-[length:12px_1px] [animation:sd-dash-x_1.6s_linear_infinite]"
        />
      </div>
      <div className="grid justify-items-center gap-2 text-center">
        <span className="grid size-12 place-items-center rounded-2xl bg-white/[0.03] ring-1 ring-white/10 sm:size-16">
          <KeyRound className="size-5 text-white/70 sm:size-6" aria-hidden="true" />
        </span>
        <span className="text-[12px] leading-tight font-medium text-white/55 sm:text-[14px]">SOBEDESCE</span>
      </div>
    </div>
  );
}

const POINTS = [
  {
    title: "O conteúdo não passa por nós",
    text: "Os bytes vão do seu computador ou do seu celular direto para os servidores do Google.",
  },
  {
    title: "Guardamos só o que a conta precisa",
    text: "Nome, e-mail, senha com hash, as chaves de acesso ao Google cifradas e a lista de aparelhos conectados.",
  },
  {
    title: "O acesso ao Drive é seu",
    text: "Usado só para as transferências que você pede. Não vendemos nem compartilhamos seus dados. Dá para desconectar a qualquer momento.",
  },
];

export function PrivacySection() {
  return (
    <section aria-labelledby="privacidade-titulo" className="relative overflow-hidden bg-stage py-24 text-white sm:py-36">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_60%_at_20%_40%,rgba(124,92,255,0.16),transparent_70%),radial-gradient(45%_55%_at_85%_50%,rgba(10,132,255,0.14),transparent_70%)]"
      />
      <Container className="relative">
        <SectionHeading id="privacidade-titulo" eyebrow="Privacidade" tone="light" dark title="Seus arquivos não passam por nós.">
          <p>A SOBEDESCE cuida da sua conta e do acesso aos seus Drives. O arquivo em si vai do aparelho para o Google.</p>
        </SectionHeading>

        <Reveal className="mt-20 sm:mt-24" delay={0.05}>
          <Diagram />
        </Reveal>

        <div className="mt-20 grid gap-8 border-t border-white/10 pt-12 sm:mt-24 md:grid-cols-3 md:gap-10">
          {POINTS.map((p, i) => (
            <Reveal key={p.title} delay={i * 0.06} className="grid content-start gap-2">
              <h3 className="text-[17px] font-semibold tracking-tight text-white">{p.title}</h3>
              <p className="text-[15px] leading-relaxed text-white/60">{p.text}</p>
            </Reveal>
          ))}
        </div>
        <Reveal className="mt-12">
          <Link href={ROTAS.privacidade} className="inline-flex items-center gap-1.5 text-[15px] font-medium text-down-soft hover:text-white">
            Ler a política de privacidade
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </Reveal>
      </Container>
    </section>
  );
}
