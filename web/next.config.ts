import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * HTTPS sempre, em todo o site e nos subdomínios (revisão A12: antes só /app/ mandava). Dois anos, como no /app/.
 * Navegadores ignoram este cabeçalho em http://localhost, então o desenvolvimento local não muda.
 */
const HSTS = { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" };

/** Cabeçalhos de segurança de todas as respostas. */
const securityHeaders = [
  HSTS,
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
];

// ── /app/: o envio pelo celular (PWA estática em public/app, sem build). ──
// Fala só com o próprio site (conta e token do Drive) e com www.googleapis.com (API e upload do Drive).
// Aba Drive: miniaturas vêm de *.googleusercontent.com (direto no <img> ou, se o Google exigir o token, por fetch →
// blob:). Vídeo, áudio e foto em tamanho real passam pelo service worker em /app/stream/ (mesma origem: 'self').
// Em desenvolvimento, ?dev_api= aponta o Drive para um Drive falso em 127.0.0.1/localhost.
const appConnect = ["'self'", "https://www.googleapis.com", "https://*.googleusercontent.com"];
const appImg = ["'self'", "data:", "blob:", "https://*.googleusercontent.com"];
if (process.env.NODE_ENV !== "production") {
  appConnect.push("http://127.0.0.1:*", "http://localhost:*");
  appImg.push("http://127.0.0.1:*", "http://localhost:*");
}
const appCsp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  `connect-src ${appConnect.join(" ")}`,
  `img-src ${appImg.join(" ")}`,
  "media-src 'self'",
  // Vídeo pesado aberto a qualquer pessoa com o link: o player do próprio Drive (components/preview.js, DrivePlayer).
  // Com a conta Google no aparelho, ele passa por accounts.google.com antes de tocar: bloquear o desvio = quadro branco.
  "frame-src https://*.google.com https://*.googleusercontent.com",
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
const appHeaders = [
  { key: "Content-Security-Policy", value: appCsp },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), screen-wake-lock=(self)" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  HSTS,
  { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
];
const noCache = [{ key: "Cache-Control", value: "no-cache" }];

// ── /instalar.sh e /instalar.ps1: instaladores de uma linha (curl … | bash e irm … | iex), em public/. ──
// Texto UTF-8 explícito: sem o charset, o PowerShell 5 lê os acentos errado (e .ps1 viria como binário).
// Cache curto: uma correção no script chega logo.
const scriptHeaders = [
  { key: "Content-Type", value: "text/plain; charset=utf-8" },
  { key: "Cache-Control", value: "public, max-age=300, must-revalidate" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // O app do celular mora em /app/ (com barra: os arquivos dele são relativos e o service worker vale para /app/).
  // O redirecionamento automático de barra do Next levaria /app/ para /app; ele fica desligado e é refeito
  // abaixo, igual ao padrão, para todo o resto do site.
  skipTrailingSlashRedirect: true,
  // O PGlite (banco local) carrega arquivos próprios em tempo de execução: fica fora do bundle.
  serverExternalPackages: ["@electric-sql/pglite"],
  // O repositório tem outro package-lock na raiz (app desktop): a raiz do site é esta pasta.
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/app/:path*", headers: appHeaders },
      { source: "/app/", headers: noCache },
      { source: "/app/index.html", headers: noCache },
      { source: "/app/sw.js", headers: noCache },
      { source: "/app/icons/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      { source: "/app/manifest.webmanifest", headers: [{ key: "Content-Type", value: "application/manifest+json; charset=utf-8" }] },
      { source: "/instalar.sh", headers: scriptHeaders },
      { source: "/instalar.ps1", headers: scriptHeaders },
    ];
  },
  async redirects() {
    // Endereço antigo (sobedesce.vercel.app): só as páginas de apresentação vão para sobedesce.com. O resto continua
    // servido nele: app do celular já instalado (/app/), login e conta das sessões de antes, API dos apps de computador.
    const antigo = [{ type: "host" as const, value: "sobedesce.vercel.app" }];
    return [
      { source: "/", has: antigo, destination: "https://sobedesce.com/", permanent: true },
      { source: "/:pagina(privacidade|termos)", has: antigo, destination: "https://sobedesce.com/:pagina", permanent: true },
      // /instalar (sem .sh/.ps1) não é página: leva para a seção de baixar da página inicial (id="baixar").
      { source: "/instalar", destination: "/#baixar", permanent: false },
      // "/app" sem barra → "/app/". O Next aceita uma barra opcional no fim de toda origem; o (?!/) evita o laço.
      { source: "/:app(app(?!/))", destination: "/app/", permanent: true },
      // O padrão do Next (barra no fim → sem barra), menos em /app/.
      { source: "/:path((?!app/$).+)/", destination: "/:path", permanent: true },
    ];
  },
  async rewrites() {
    return [{ source: "/app/", destination: "/app/index.html" }];
  },
};

export default nextConfig;
