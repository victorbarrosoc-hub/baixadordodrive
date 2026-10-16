import type { Metadata } from "next";
import { AccountsSection } from "@/components/home/accounts-section";
import { CompareSection } from "@/components/home/compare-section";
import { DownloadsSection } from "@/components/home/downloads-section";
import { FinalCta } from "@/components/home/final-cta";
import { Hero } from "@/components/home/hero";
import { MotionProvider } from "@/components/home/motion";
import { PhoneSection } from "@/components/home/phone-section";
import { PlatformScript } from "@/components/home/platform";
import { PrivacySection } from "@/components/home/privacy-section";
import { ResumeSection } from "@/components/home/resume-section";
import { SpeedSection } from "@/components/home/speed-section";
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
      <SiteHeader />
      <MotionProvider>
        <main>
          <Hero />
          <SpeedSection />
          <ResumeSection />
          <CompareSection />
          <PhoneSection />
          <AccountsSection />
          <PrivacySection />
          <DownloadsSection />
          <FinalCta />
        </main>
      </MotionProvider>
      <SiteFooter />
    </div>
  );
}
