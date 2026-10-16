import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { ROTAS } from "@/lib/site";
import { LogoMark } from "@/components/site/logo";
import { Reveal } from "./motion";
import { Container } from "./section";

export function FinalCta() {
  return (
    <section aria-labelledby="fim-titulo" className="py-24 sm:py-36">
      <Container>
        <Reveal className="mx-auto grid max-w-2xl justify-items-center gap-6 text-center">
          <LogoMark className="size-14 sm:size-16" />
          <h2 id="fim-titulo" className="font-display text-[34px] leading-[1.06] font-semibold tracking-[-0.03em] text-balance text-ink sm:text-[52px]">
            Comece pelo maior arquivo que você tem.
          </h2>
          <p className="text-[17px] leading-relaxed text-ink-2 sm:text-[19px]">Crie a conta, conecte o Drive e use no computador e no celular.</p>
          <div className="mt-2 flex flex-wrap justify-center gap-3">
            <Link href={ROTAS.criarConta} className={buttonClasses({ variant: "primary", size: "lg" })}>
              Criar conta
            </Link>
            <Link href={ROTAS.entrar} className={buttonClasses({ variant: "secondary", size: "lg" })}>
              Entrar
            </Link>
            <Link href={ROTAS.celular} className={buttonClasses({ variant: "ghost", size: "lg" })}>
              Usar no celular
            </Link>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
