import type { MetadataRoute } from "next";

/**
 * Manifesto do site inteiro: "Adicionar à Tela de Início" em qualquer página abre o app (/app/) em tela cheia.
 * O escopo é o site todo, para entrar, criar conta e a página da conta continuarem dentro do app, sem a barra do
 * Safari. Mesmo `id` do manifesto de public/app: é o mesmo app.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/app/",
    name: "SOBEDESCE",
    short_name: "SOBEDESCE",
    description: "Envie vídeos e arquivos do celular direto para o seu Google Drive.",
    lang: "pt-BR",
    dir: "ltr",
    start_url: "/app/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    theme_color: "#f2f2f6",
    background_color: "#f2f2f6",
    categories: ["productivity", "utilities"],
    // Android: "Compartilhar → SOBEDESCE" abre "Salvar link" nas Referências (docs/REFERENCIAS.md §7).
    share_target: { action: "/app/?compartilhar=1", method: "GET", params: { title: "title", text: "text", url: "url" } },
    icons: [
      { src: "/app/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/app/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/app/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/app/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
