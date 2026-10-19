import Link from "next/link";
import { ArrowRight, Download, Smartphone } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { DOWNLOAD_MAC, DOWNLOAD_WINDOWS, ROTAS } from "@/lib/site";
import { HeroStage } from "./hero-stage";

/**
 * Topo da home. O botão principal muda conforme o sistema do visitante (data-plat no
 * contêiner da página, marcado antes da primeira pintura): só CSS, sem pular layout.
 * Celular e tablet: texto em cima, palco embaixo. Desktop (lg+): duas colunas que ocupam a altura da tela, título e palco
 * crescendo com a largura (clamp), para usar a tela toda de 1280 a 2560+.
 */
export function Hero() {
  const primary = buttonClasses({ variant: "primary", size: "lg", className: "h-12 px-6 text-[16px] sm:h-13 sm:px-7 sm:text-[17px]" });
  const secondary = buttonClasses({ variant: "secondary", size: "lg", className: "h-12 px-6 text-[16px] sm:h-13 sm:px-7 sm:text-[17px]" });

  return (
    <section aria-labelledby="hero-titulo" className="relative pt-14 pb-10 sm:pt-20 sm:pb-16 lg:py-0">
      {/* Brilho suave atrás do título. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -top-14 -z-10 h-[740px] bg-[radial-gradient(60%_50%_at_30%_0%,rgba(10,132,255,0.10),transparent_70%),radial-gradient(55%_45%_at_75%_5%,rgba(124,92,255,0.12),transparent_70%)]"
      />
      <div className="lg:largura lg:grid lg:min-h-[calc(100svh-3.5rem)] lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-center lg:gap-[clamp(40px,4vw,96px)] lg:py-[clamp(40px,5svh,80px)] 2xl:min-h-[calc(100svh-4rem)]">
        <div className="mx-auto max-w-5xl px-5 text-center sm:px-8 lg:mx-0 lg:max-w-none lg:px-0 lg:text-left">
          <p className="mx-auto max-w-[22rem] animate-rise text-[15px] font-semibold text-balance text-ink-2 sm:max-w-none sm:text-[17px] lg:mx-0 2xl:text-[20px]">
            <span className="bg-gradient-to-r from-down-text to-up-text bg-clip-text text-transparent">Brutos de câmera, cartões inteiros, projetos de edição</span>
          </p>
          <h1
            id="hero-titulo"
            className="mx-auto mt-4 max-w-[15ch] animate-rise font-display text-[42px] leading-[1.03] font-semibold tracking-[-0.035em] text-balance [animation-delay:80ms] sm:text-[68px] lg:mx-0 lg:max-w-[16ch] lg:text-[clamp(56px,4.6vw,124px)] lg:leading-[1]"
          >
            O Drive na velocidade que a sua internet aguenta.
          </h1>
          <p className="mx-auto mt-6 max-w-[34rem] animate-rise text-[17px] leading-[1.5] text-pretty text-ink-2 [animation-delay:160ms] sm:text-[20px] lg:mx-0 lg:mt-8 lg:text-[clamp(20px,1.3vw,28px)] 2xl:max-w-[40rem]">
            Sobe e baixa arquivos gigantes do Google Drive com várias conexões ao mesmo tempo.
          </p>

          <div className="mt-9 flex animate-rise flex-wrap items-center justify-center gap-3 [animation-delay:240ms] lg:mt-12 lg:justify-start">
            <span className="hidden group-data-[plat=mac]/plat:contents">
              <a href={DOWNLOAD_MAC} className={primary}>
                <Download aria-hidden="true" />
                Baixar para Mac
              </a>
            </span>
            <span className="hidden group-data-[plat=windows]/plat:contents">
              <a href={DOWNLOAD_WINDOWS} className={primary}>
                <Download aria-hidden="true" />
                Baixar para Windows
              </a>
            </span>
            <span className="hidden group-data-[plat=ios]/plat:contents group-data-[plat=android]/plat:contents">
              <Link href={ROTAS.celular} className={primary}>
                <Smartphone aria-hidden="true" />
                Usar no celular
              </Link>
            </span>
            <span className="hidden group-data-[plat=outro]/plat:contents">
              <a href="#baixar" className={primary}>
                <Download aria-hidden="true" />
                Baixar o app
              </a>
            </span>
            <Link href={ROTAS.criarConta} className={secondary}>
              Criar conta
              <ArrowRight aria-hidden="true" />
            </Link>
          </div>
        </div>

        <div className="mx-auto mt-14 max-w-6xl animate-fade px-4 [animation-delay:300ms] sm:mt-20 sm:px-8 lg:mx-0 lg:mt-0 lg:max-w-none lg:px-0">
          <figure className="relative h-[440px] overflow-hidden rounded-[28px] bg-stage shadow-[0_40px_120px_-40px_rgba(30,20,90,0.55)] ring-1 ring-black/5 sm:h-[540px] sm:rounded-[36px] lg:h-[clamp(560px,calc(100svh-9rem),1100px)] 2xl:rounded-[44px]">
            <div
              aria-hidden="true"
              className="absolute inset-0 bg-[radial-gradient(45%_55%_at_22%_85%,rgba(10,132,255,0.20),transparent_70%),radial-gradient(45%_55%_at_78%_85%,rgba(124,92,255,0.22),transparent_70%),radial-gradient(70%_40%_at_50%_0%,rgba(255,255,255,0.06),transparent_70%)]"
            />
            <HeroStage />
            <div className="pointer-events-none absolute inset-x-0 top-[17%] -translate-y-[calc(100%+12px)] text-center">
              <span className="text-[11px] font-medium tracking-[0.16em] text-white/55 uppercase sm:text-[12px]">Google Drive</span>
            </div>
            <figcaption className="absolute inset-x-0 bottom-0 grid grid-cols-2 gap-4 px-[18px] pb-5 sm:px-[max(40px,5%)] sm:pb-8">
              <span className="grid content-start gap-1 text-left">
                <span className="flex items-center gap-2 text-[14px] font-semibold text-white sm:text-[16px]">
                  <span className="size-2 rounded-full bg-down shadow-[0_0_12px_2px_rgba(10,132,255,0.7)]" aria-hidden="true" />
                  Desce
                </span>
                <span className="text-[12px] leading-snug text-white/55 sm:text-[14px]">Um arquivo, 8 conexões ao mesmo tempo</span>
              </span>
              <span className="grid content-start gap-1 text-left sm:pl-10">
                <span className="flex items-center gap-2 text-[14px] font-semibold text-white sm:text-[16px]">
                  <span className="size-2 rounded-full bg-up shadow-[0_0_12px_2px_rgba(124,92,255,0.75)]" aria-hidden="true" />
                  Sobe
                </span>
                <span className="text-[12px] leading-snug text-white/55 sm:text-[14px]">4 arquivos ao mesmo tempo, cada um sem pausa</span>
              </span>
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}
