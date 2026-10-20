import type { Metadata } from "next";
import { Calculadora } from "@/components/calculadora/calculadora";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";

export const metadata: Metadata = {
  title: "Calculadora de mídia: quantos cartões e HDs levar",
  description:
    "Quantos GB a câmera grava por hora, quanto cabe em cada cartão, quantos cartões e HDs de backup levar e quanto tempo leva a cópia. Com a conta aberta, linha por linha.",
  alternates: { canonical: "/calculadora" },
};

export default function CalculadoraPage() {
  return (
    <>
      <SiteHeader />
      <main className="px-5 pt-14 pb-24 sm:px-8 sm:pt-20 sm:pb-32">
        <div className="mx-auto max-w-[1080px]">
          <header className="max-w-[720px]">
            <h1 className="font-display text-[38px] leading-[1.05] font-semibold tracking-[-0.03em] text-ink sm:text-[52px]">Quanta mídia levar</h1>
            <p className="mt-5 text-[17px] leading-relaxed text-pretty text-ink-2 sm:text-[19px]">
              Escolha a câmera, o modo e as horas de gravação. A conta mostra quantos cartões levar, o tamanho dos HDs de backup e quanto tempo leva para copiar no fim
              da diária. Grátis, sem conta e sem nada sair do seu navegador.
            </p>
          </header>
          <Calculadora />
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
