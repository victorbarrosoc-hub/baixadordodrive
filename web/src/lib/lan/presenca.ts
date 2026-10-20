/**
 * "Entre computadores" (docs/LAN.md): onde cada computador está na rede local, para os outros mandarem arquivos
 * direto (sem passar pela internet). O app avisa a cada minuto enquanto a recepção está ligada; sem notícia por
 * 3 minutos, ele some da lista.
 *  - Mesma conta: a chave de recepção (selada no banco) vai para os outros computadores da conta.
 *  - Outras contas ("por perto"): só quem ligou "aceita de outras contas" aparece, e só para quem avisa da mesma rede
 *    (mesmo IP público; IPv6, o mesmo /64). Vai a chave PÚBLICA (X25519): quem manda cifra para ela, e quem recebe
 *    ainda precisa aceitar na tela. O IP não fica guardado, só um HMAC dele.
 */
import "server-only";
import { and, eq, gt, lt, ne } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { abrir, assinar, selar } from "@/lib/google/cripto";

const { lanPresenca, sessoes, usuarios } = schema;

/** Sem notícia há mais que isso = desligado (o app avisa a cada 60 s). */
export const ONLINE_MS = 3 * 60_000;
/** Linhas sem notícia há mais que isso são apagadas. */
const GUARDA_MS = 24 * 60 * 60_000;

/** IPv4 privado (10/8, 172.16/12, 192.168/16, 169.254/16) ou IPv6 local (fe80::/10, fc00::/7). Nada público. */
export function enderecoLocal(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (m) {
    const [a, b, c, d] = m.slice(1).map(Number);
    if ([a, b, c, d].some((x) => x > 255)) return false;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^(fe[89ab][0-9a-f]|f[cd][0-9a-f]{2}):[0-9a-f:]*$/i.test(ip) && ip.length <= 45;
}

export const presencaSchema = z
  .object({
    v: z.literal(1),
    enderecos: z.array(z.string().max(45).refine(enderecoLocal, "endereço fora da rede local")).min(1).max(8),
    porta: z.number().int().min(1024).max(65535),
    chave: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    chavePublica: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
    outros: z.boolean().optional(),
  })
  .strict();
export type Presenca = z.infer<typeof presencaSchema>;

const contexto = (sessaoId: string) => `lan_presenca.chave:${sessaoId}`;

/**
 * A "rede" de um IP público, sem guardar o IP: HMAC do IPv4 inteiro ou do /64 do IPv6 (cada aparelho tem o seu IPv6,
 * mas a casa ou o escritório dividem o prefixo). Sem IP (desenvolvimento): null, e ninguém fica "por perto".
 */
export function redeDe(ip: string | null | undefined): string | null {
  let v = String(ip ?? "").trim().toLowerCase();
  if (!v || v === "local") return null;
  v = v.replace(/^::ffff:/, "");
  if (v.includes(":")) {
    const [cabeca, cauda = ""] = v.split("::");
    const a = cabeca ? cabeca.split(":") : [];
    const b = cauda ? cauda.split(":") : [];
    const cheio = v.includes("::") ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b] : a;
    v = cheio.slice(0, 4).map((h) => h.replace(/^0+(?=.)/, "")).join(":") + "::/64";
  }
  return assinar(v, "lan-rede");
}

export async function gravarPresenca(sessaoId: string, usuarioId: string, p: Presenca, ip: string | null = null) {
  const agora = new Date();
  const valores = {
    enderecos: p.enderecos,
    porta: p.porta,
    chaveEnc: selar(p.chave, contexto(sessaoId)),
    chavePublica: p.chavePublica ?? null,
    aceitaOutros: !!p.outros && !!p.chavePublica,
    rede: redeDe(ip),
    usuarioId,
    atualizadoEm: agora,
  };
  await db
    .insert(lanPresenca)
    .values({ sessaoId, ...valores })
    .onConflictDoUpdate({ target: lanPresenca.sessaoId, set: valores });
  await db.delete(lanPresenca).where(lt(lanPresenca.atualizadoEm, new Date(agora.getTime() - GUARDA_MS)));
}

export async function apagarPresenca(sessaoId: string) {
  await db.delete(lanPresenca).where(eq(lanPresenca.sessaoId, sessaoId));
}

export type ComputadorLan = {
  id: string;
  nome: string;
  plataforma: string | null;
  enderecos: string[];
  porta: number;
  chave: string;
  vistoEm: string;
};

/** Os outros computadores da conta com a recepção ligada (notícia nos últimos 3 min). Sessão revogada ou vencida fica de fora. */
export async function computadoresDaConta(usuarioId: string, sessaoAtual: string): Promise<ComputadorLan[]> {
  const agora = Date.now();
  const linhas = await db
    .select({
      id: lanPresenca.sessaoId,
      nome: sessoes.nome,
      plataforma: sessoes.plataforma,
      enderecos: lanPresenca.enderecos,
      porta: lanPresenca.porta,
      chaveEnc: lanPresenca.chaveEnc,
      atualizadoEm: lanPresenca.atualizadoEm,
      revogadaEm: sessoes.revogadaEm,
      expiraEm: sessoes.expiraEm,
    })
    .from(lanPresenca)
    .innerJoin(sessoes, eq(sessoes.id, lanPresenca.sessaoId))
    .where(and(eq(lanPresenca.usuarioId, usuarioId), eq(sessoes.usuarioId, usuarioId), ne(lanPresenca.sessaoId, sessaoAtual), gt(lanPresenca.atualizadoEm, new Date(agora - ONLINE_MS))));
  const out: ComputadorLan[] = [];
  for (const l of linhas) {
    if (l.revogadaEm || l.expiraEm.getTime() <= agora) continue;
    let chave: string;
    try {
      chave = abrir(l.chaveEnc, contexto(l.id));
    } catch {
      continue;
    }
    out.push({ id: l.id, nome: l.nome?.trim() || "Computador", plataforma: l.plataforma ?? null, enderecos: l.enderecos, porta: l.porta, chave, vistoEm: l.atualizadoEm.toISOString() });
  }
  return out.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

export type ComputadorPorPerto = {
  id: string;
  nome: string;
  plataforma: string | null;
  /** Primeiro nome de quem é o computador (para a pessoa saber para quem está mandando). */
  dono: string;
  enderecos: string[];
  porta: number;
  chavePublica: string;
  vistoEm: string;
};

/** Computadores de OUTRAS contas, na mesma rede, que aceitam receber de outras contas (notícia nos últimos 3 min). */
export async function computadoresPorPerto(usuarioId: string, ip: string | null): Promise<ComputadorPorPerto[]> {
  const rede = redeDe(ip);
  if (!rede) return [];
  const agora = Date.now();
  const linhas = await db
    .select({
      id: lanPresenca.sessaoId,
      nome: sessoes.nome,
      plataforma: sessoes.plataforma,
      dono: usuarios.nome,
      enderecos: lanPresenca.enderecos,
      porta: lanPresenca.porta,
      chavePublica: lanPresenca.chavePublica,
      atualizadoEm: lanPresenca.atualizadoEm,
      revogadaEm: sessoes.revogadaEm,
      expiraEm: sessoes.expiraEm,
    })
    .from(lanPresenca)
    .innerJoin(sessoes, eq(sessoes.id, lanPresenca.sessaoId))
    .innerJoin(usuarios, eq(usuarios.id, lanPresenca.usuarioId))
    .where(and(eq(lanPresenca.rede, rede), eq(lanPresenca.aceitaOutros, true), ne(lanPresenca.usuarioId, usuarioId), gt(lanPresenca.atualizadoEm, new Date(agora - ONLINE_MS))));
  const out: ComputadorPorPerto[] = [];
  for (const l of linhas) {
    if (l.revogadaEm || l.expiraEm.getTime() <= agora || !l.chavePublica) continue;
    out.push({
      id: l.id,
      nome: l.nome?.trim() || "Computador",
      plataforma: l.plataforma ?? null,
      dono: (l.dono || "").trim().split(/\s+/)[0] || "Alguém",
      enderecos: l.enderecos,
      porta: l.porta,
      chavePublica: l.chavePublica,
      vistoEm: l.atualizadoEm.toISOString(),
    });
  }
  return out.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")).slice(0, 30);
}
