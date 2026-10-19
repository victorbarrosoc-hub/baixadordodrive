import Link from "next/link";
import { Lock } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { ROTAS } from "@/lib/site";
import { Reveal } from "./motion";
import { Container } from "./section";

/** Fechamento escuro: privacidade em uma frase e a chamada para criar conta. */
export function ClosingSection() {
  return (
    <section aria-labelledby="fim-titulo" className="bg-stage py-20 text-white sm:py-28 2xl:py-40">
      <Container>
        <Reveal className="mx-auto grid max-w-3xl justify-items-center gap-6 text-center 2xl:max-w-5xl">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/8 px-3.5 py-1.5 text-[13px] text-white/75 ring-1 ring-white/10">
            <Lock className="size-3.5" aria-hidden="true" />
            Do seu aparelho direto para o Google
          </span>
          <h2 id="fim-titulo" className="font-display text-[34px] leading-[1.06] font-semibold tracking-[-0.03em] text-balance sm:text-[56px] lg:text-[clamp(56px,4.4vw,112px)]">
            Seus arquivos não passam pelos nossos servidores.
          </h2>
          <p className="max-w-xl text-[17px] leading-relaxed text-white/65 sm:text-[19px]">Crie a conta, conecte o Drive e comece pelo maior arquivo que você tem.</p>
          <div className="mt-2 flex flex-wrap justify-center gap-3">
            <Link href={ROTAS.criarConta} className={buttonClasses({ variant: "secondary", size: "lg", className: "bg-white text-ink ring-0 hover:bg-white/90" })}>
              Criar conta
            </Link>
            <Link href={ROTAS.entrar} className={buttonClasses({ variant: "ghost", size: "lg", className: "text-white ring-1 ring-white/25 hover:bg-white/10" })}>
              Entrar
            </Link>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
