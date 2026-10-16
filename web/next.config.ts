import type { NextConfig } from "next";

/** Cabeçalhos de segurança de todas as respostas. */
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
];

// ── /app/: o envio pelo celular (PWA estática em public/app, sem build). ──
// Fala só com o próprio site (conta e token do Drive) e com www.googleapis.com (API e upload do Drive).
// Em desenvolvimento, ?dev_api= aponta o Drive para um Drive falso em 127.0.0.1/localhost.
const appConnect = ["'self'", "https://www.googleapis.com"];
if (process.env.NODE_ENV !== "production") appConnect.push("http://127.0.0.1:*", "http://localhost:*");
const appCsp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  `connect-src ${appConnect.join(" ")}`,
  "img-src 'self' data: https://*.googleusercontent.com",
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
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
];
const noCache = [{ key: "Cache-Control", value: "no-cache" }];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // O app do celular mora em /app/ (com barra: os arquivos dele são relativos e o service worker vale para /app/).
  // O redirecionamento automático de barra do Next levaria /app/ para /app; ele fica desligado e é refeito
  // abaixo, igual ao padrão, para todo o resto do site.
  skipTrailingSlashRedirect: true,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/app/:path*", headers: appHeaders },
      { source: "/app/", headers: noCache },
      { source: "/app/index.html", headers: noCache },
      { source: "/app/sw.js", headers: noCache },
      { source: "/app/icons/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      { source: "/app/manifest.webmanifest", headers: [{ key: "Content-Type", value: "application/manifest+json; charset=utf-8" }] },
    ];
  },
  async redirects() {
    return [
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
