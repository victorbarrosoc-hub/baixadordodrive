import type { Metadata, Viewport } from "next";
import { telasDeAbertura } from "@/lib/pwa";
import { SITE_DESCRICAO, SITE_NOME, SITE_URL } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_NOME, template: "%s · SOBEDESCE" },
  description: SITE_DESCRICAO,
  applicationName: SITE_NOME,
  openGraph: {
    type: "website",
    locale: "pt_BR",
    siteName: SITE_NOME,
    title: "SOBEDESCE · Arquivos gigantes no Google Drive",
    description: "Do celular e do computador direto para o seu Drive. Rápido, retoma de onde parou e confere cada arquivo.",
    url: "/",
  },
  twitter: { card: "summary_large_image" },
  // Tela de Início do iPhone: abre como app (sem a barra do Safari), com ícone, nome e tela de abertura.
  appleWebApp: { capable: true, title: SITE_NOME, statusBarStyle: "default", startupImage: telasDeAbertura() },
  icons: { apple: [{ url: "/app/icons/apple-touch-icon.png", sizes: "180x180" }] },
  formatDetection: { telephone: false },
  // O Next só escreve mobile-web-app-capable; iPhones com iOS mais antigo ainda leem este.
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  themeColor: "#fbfbfd",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
