import { NextResponse, type NextRequest } from "next/server";

/**
 * Sessão deslizante do site: quem abre a conta, o /dispositivo ou o app do celular com o cookie
 * `sd_sessao` ganha mais 30 dias de cookie. Não confere o banco (quem confere é usuarioAtual());
 * só evita que o cookie vença antes da sessão, que também desliza no servidor.
 */
export function proxy(request: NextRequest) {
  const token = request.cookies.get("sd_sessao")?.value;
  const res = NextResponse.next();
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return res;
  if (request.headers.get("next-router-prefetch") || request.headers.get("purpose") === "prefetch") return res;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(request.nextUrl.hostname);
  res.cookies.set("sd_sessao", token, { httpOnly: true, secure: !local, sameSite: "lax", path: "/", maxAge: 30 * 24 * 60 * 60 });
  return res;
}

export const config = {
  matcher: ["/conta", "/dispositivo", "/app/:path*"],
};
