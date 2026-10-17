import { aprenderAparelho, COOKIE_APARELHO, opcoesCookieAparelho } from "@/lib/auth/aparelho";
import { usuarioDaRequisicao, SEM_SESSAO } from "@/lib/auth/requisicao";
import { listarContas } from "@/lib/google/contas";
import { json, lerCookie, origemDoPedido, serializarCookie } from "@/lib/http";
import { recursosDe } from "@/lib/recursos";
import { cookieSeguro } from "@/lib/site";

/** Quem sou eu, quais Drives tenho e quais recursos a conta usa (cookie do site ou Bearer do computador). */
export async function GET(req: Request) {
  const atual = await usuarioDaRequisicao(req);
  if (!atual) return SEM_SESSAO();
  const [contas, recursos, aparelho] = await Promise.all([
    listarContas(atual.usuario.id),
    recursosDe(atual.usuario),
    // Navegador com a sessão já aberta (o app do celular chama aqui ao abrir): a conta aprende o aparelho sem
    // aviso, para um login futuro dele não virar "entrada nova" (lib/auth/aparelho.ts).
    atual.via === "cookie" ? aprenderAparelho(atual.usuario.id, lerCookie(req, COOKIE_APARELHO)) : null,
  ]);
  let extras: HeadersInit | undefined;
  if (aparelho) {
    const o = opcoesCookieAparelho(cookieSeguro(origemDoPedido(req.headers, req.url)));
    extras = { "Set-Cookie": serializarCookie(COOKIE_APARELHO, aparelho, { maxAge: o.maxAge, path: o.path, secure: o.secure }) };
  }
  return json({ usuario: atual.usuario, contas, recursos }, 200, extras);
}
