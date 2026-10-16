import type { Metadata } from "next";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { siteUrl } from "@/lib/site";
import { Instrucoes } from "./instrucoes";

export const metadata: Metadata = {
  title: "Atalho do iPhone",
  description: "Salve links do Instagram, do YouTube e do TikTok nas suas Referências direto da Folha de Compartilhamento do iPhone.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * Passo a passo do Atalho do iPhone (docs/REFERENCIAS.md §5). A chave chega no fragmento (#chave=sda_…), que o
 * navegador não manda para servidor nenhum: quem lê é o componente do navegador.
 */
export default function AtalhoPage() {
  return (
    <>
      <SiteHeader />
      <main className="px-5 pt-14 pb-24 sm:px-8 sm:pt-20">
        <article className="mx-auto grid max-w-[640px] gap-10">
          <header className="grid gap-4">
            <p className="text-[14px] font-medium text-ink-3">Referências · iPhone</p>
            <h1 className="font-display text-[36px] leading-[1.06] font-semibold tracking-[-0.03em] text-balance sm:text-[48px]">Salvar direto do Instagram</h1>
            <p className="text-[17px] leading-relaxed text-pretty text-ink-2">
              Um atalho do app Atalhos manda o link que você compartilhar para a fila das suas Referências. O computador baixa depois. Leva uns dois
              minutos para montar, uma vez só.
            </p>
          </header>
          <Instrucoes endpoint={`${siteUrl()}/api/referencias/atalho`} />
        </article>
      </main>
      <SiteFooter />
    </>
  );
}
