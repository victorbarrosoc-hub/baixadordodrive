import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/** Cabeçalhos de segurança de todas as respostas. */
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // O PGlite (banco local) carrega arquivos próprios em tempo de execução: fica fora do bundle.
  serverExternalPackages: ["@electric-sql/pglite"],
  // O repositório tem outro package-lock na raiz (app desktop): a raiz do site é esta pasta.
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
