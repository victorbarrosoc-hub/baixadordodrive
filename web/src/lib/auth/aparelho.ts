/**
 * Aparelho conhecido (aviso de entrada nova). Cada navegador ganha o cookie `sd_aparelho`: "v1.<id>.<assinatura>",
 * um id aleatório de 128 bits assinado com a SOBEDESCE_KEY. Ele só identifica o navegador: não leva conta, nome,
 * sistema nem lugar, e dura 400 dias (o máximo que os navegadores aceitam). No banco (`aparelhos`) fica só o sha256
 * do id, por conta.
 *
 * - Entrar (senha ou Google) num navegador que a conta ainda não usou: grava e manda o aviso, depois da resposta.
 * - Criar a conta e refazer a senha pelo link: grava sem avisar (o e-mail da senha já conta o que houve).
 * - Sessão já aberta no navegador (/api/eu, que o app do celular chama ao abrir): grava sem avisar. Assim quem já
 *   estava dentro antes deste aviso existir não recebe um "entrada nova" pelo próprio celular.
 * Nada aqui lança: sem chave, ou com o banco fora, o login segue igual e só o aviso fica de fora.
 */
import { randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Depois } from "@/lib/depois";
import { lugarLegivel } from "@/lib/dispositivo";
import { avisarEntradaNova } from "@/lib/email/avisos";
import { assinar, assinaturaConfere } from "@/lib/google/cripto";
import type { Lugar } from "@/lib/http";
import { resumirNavegador } from "@/lib/navegador";
import { hashToken, novoId } from "./tokens";

const { aparelhos } = schema;

export const COOKIE_APARELHO = "sd_aparelho";
const DIA = 24 * 60 * 60_000;
export const DURACAO_APARELHO_MS = 400 * DIA;
const USO = "aparelho";
const FORMATO = /^v1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/;
/** Só regrava `vistoEm` uma vez por dia. */
const INTERVALO_VISTO = DIA;

export function novoCookieAparelho(): string {
  const id = randomBytes(16).toString("base64url");
  return `v1.${id}.${assinar(`v1.${id}`, USO)}`;
}

/** O id de um cookie válido (assinatura confere), ou null. */
export function idDoAparelho(valor: string | null | undefined): string | null {
  const m = FORMATO.exec(valor ?? "");
  if (!m) return null;
  return assinaturaConfere(`v1.${m[1]}`, m[2], USO) ? m[1] : null;
}

export function opcoesCookieAparelho(seguro: boolean) {
  return { httpOnly: true, secure: seguro, sameSite: "lax" as const, path: "/", maxAge: DURACAO_APARELHO_MS / 1000 };
}

/** Grava o aparelho na conta. true = a conta ainda não tinha usado este aparelho. */
async function registrar(usuarioId: string, id: string, agora = new Date()): Promise<boolean> {
  const aparelhoHash = hashToken(id);
  const novo = await db
    .insert(aparelhos)
    .values({ id: novoId(), usuarioId, aparelhoHash, criadoEm: agora, vistoEm: agora })
    .onConflictDoNothing({ target: [aparelhos.usuarioId, aparelhos.aparelhoHash] })
    .returning({ id: aparelhos.id });
  if (novo.length) {
    // De carona: os que a conta não usa há mais de 400 dias (o cookie deles já venceu).
    await db.delete(aparelhos).where(and(eq(aparelhos.usuarioId, usuarioId), lt(aparelhos.vistoEm, new Date(agora.getTime() - DURACAO_APARELHO_MS))));
    return true;
  }
  await db
    .update(aparelhos)
    .set({ vistoEm: agora })
    .where(and(eq(aparelhos.usuarioId, usuarioId), eq(aparelhos.aparelhoHash, aparelhoHash), lt(aparelhos.vistoEm, new Date(agora.getTime() - INTERVALO_VISTO))));
  return false;
}

/** O valor do cookie (o que veio, se vale; senão um novo). null = sem chave para assinar: o recurso fica de fora. */
function cookieValido(cookie: string | null | undefined): { valor: string; id: string; veio: boolean } | null {
  try {
    const id = idDoAparelho(cookie);
    if (id) return { valor: cookie!, id, veio: true };
    const valor = novoCookieAparelho();
    return { valor, id: idDoAparelho(valor)!, veio: false };
  } catch {
    console.warn("[aparelho] sem chave para assinar o cookie de aparelho.");
    return null;
  }
}

export type DadosDaEntrada = { userAgent: string | null; lugar: Pick<Lugar, "cidade" | "pais">; quando?: Date };

/**
 * Login que deu certo. Devolve o valor do cookie `sd_aparelho` para gravar na resposta (sempre, para renovar os
 * 400 dias), ou null quando não dá para assinar. `avisar` false: aprende o aparelho sem mandar e-mail.
 */
export async function conferirAparelho(o: {
  usuarioId: string;
  cookie: string | null | undefined;
  via: "senha" | "google";
  entrada: DadosDaEntrada;
  avisar: boolean;
  depois: Depois;
}): Promise<string | null> {
  const c = cookieValido(o.cookie);
  if (!c) return null;
  try {
    const quando = o.entrada.quando ?? new Date();
    const novo = await registrar(o.usuarioId, c.id, quando);
    if (novo && o.avisar) {
      const dados = { quando, navegador: resumirNavegador(o.entrada.userAgent), onde: lugarLegivel(o.entrada.lugar), via: o.via };
      o.depois(() => avisarEntradaNova(o.usuarioId, dados));
    }
  } catch {
    console.warn("[aparelho] não deu para conferir o aparelho.");
  }
  return c.valor;
}

/**
 * Sessão já aberta neste navegador: aprende o aparelho sem avisar. Devolve o cookie para gravar quando ele faltava
 * ou não valia; null quando não precisa gravar nada.
 */
export async function aprenderAparelho(usuarioId: string, cookie: string | null | undefined): Promise<string | null> {
  const c = cookieValido(cookie);
  if (!c) return null;
  try {
    await registrar(usuarioId, c.id);
  } catch {
    console.warn("[aparelho] não deu para gravar o aparelho.");
    return null;
  }
  return c.veio ? null : c.valor;
}
