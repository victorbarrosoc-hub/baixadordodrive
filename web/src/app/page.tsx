import type { Metadata } from "next";
import { AvisoContaApagada } from "@/components/conta/aviso-conta-apagada";
import { ClosingSection } from "@/components/home/closing-section";
import { FeaturesGrid } from "@/components/home/features-grid";
import { Hero } from "@/components/home/hero";
import { MotionProvider } from "@/components/home/motion";
import { PlatformScript } from "@/components/home/platform";
import { PlatformsSection } from "@/components/home/platforms-section";
import { StatsStrip } from "@/components/home/stats-strip";
import { SiteFooter } from "@/components/site/footer";
import { SiteHeader } from "@/components/site/header";
import { SITE_DESCRICAO } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: "SOBEDESCE · Arquivos gigantes no Google Drive" },
  description: SITE_DESCRICAO,
  alternates: { canonical: "/" },
};

export default function Home() {
  return (
    // data-plat é marcado pelo PlatformScript antes da primeira pintura (por isso o suppressHydrationWarning).
    <div data-plat="outro" className="group/plat" suppressHydrationWarning>
      <PlatformScript />
      <AvisoContaApagada />
      <SiteHeader />
      <MotionProvider>
        <main>
          <Hero />
          <StatsStrip />
          <FeaturesGrid />
          <PlatformsSection />
          <ClosingSection />
        </main>
      </MotionProvider>
      <SiteFooter />
    </div>
  );
}
