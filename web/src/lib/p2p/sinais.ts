/**
 * Celular ↔ computador ↔ celular pelo Wi-Fi (docs/CELULAR-WIFI.md): a sinalização do WebRTC. O site só repassa a
 * oferta e a resposta entre dois aparelhos; os arquivos vão direto pela rede local, cifrados pelo próprio WebRTC.
 *  - Mesma conta: o celular vê os computadores e os outros celulares da conta; o computador vê os celulares.
 *  - Outras pessoas ("por perto"): só quem ligou "Aceitar de outras pessoas por perto" aparece, e só para quem está na
 *    mesma rede (mesmo HMAC do IP público). Quem recebe sempre aceita na tela; a conta e o primeiro nome vão junto.
 *  - Presença: cada aparelho com o app aberto fica numa espera longa (`esperar`), que marca "visto agora" e a rede
 *    (HMAC do IP público, como em lib/lan/presenca.ts). Online = visto há menos de ONLINE_MS.
 *  - Sinais valem VALIDADE_MS: depois disso não são entregues e somem.
 *  - Uma oferta só vai para um aparelho online que este pode ver (acima); resposta, recusa e cancela só sobre uma
 *    oferta entre os dois.
 */
import "server-only";
import { and, asc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import type { ResumoP2p, TipoAparelhoP2p, TipoSinalP2p } from "@/lib/db/schema";
import { novoId } from "@/lib/auth/tokens";
import { redeDe } from "@/lib/lan/presenca";
import { sistemaDoAparelho } from "@/lib/navegador";
import type { Autenticado } from "@/lib/auth/sessao";

const { p2pAparelhos, p2pSinais, sessoes, usuarios } = schema;

export const ONLINE_MS = 70_000;
export const VALIDADE_MS = 2 * 60_000;
/** Quanto a espera longa segura a resposta sem sinal novo (o cliente pede de novo logo depois). */
export const ESPERA_MS = 25_000;
const OLHAR_MS = 1_000;
export const OFERTAS_POR_MINUTO = 20;

export class SinalError extends Error {
  constructor(
    readonly status: number,
    readonly codigo: string,
    message: string,
  ) {
    super(message);
    this.name = "SinalError";
  }
}

export type Conta = "minha" | "outra";
export type Aparelho = { id: string; nome: string; tipo: TipoAparelhoP2p; mesmaRede: boolean; conta: Conta; dono?: string };
export type SinalEntregue = {
  id: string;
  tipo: TipoSinalP2p;
  de: { id: string; nome: string; tipo: TipoAparelhoP2p; conta: Conta; dono?: string };
  oferta?: string;
  sdp?: string;
  resumo?: ResumoP2p;
  motivo?: string;
  criadoEm: number;
};

const tipoDe = (a: Autenticado): TipoAparelhoP2p => (a.sessao.tipo === "dispositivo" ? "computador" : "celular");

/** Nome que os outros aparelhos veem: o do computador, ou "iPhone de Victor" (o celular pode mandar o seu). */
export function nomeDoAparelho(a: Autenticado, pedido: string | null, ua: string | null): string {
  if (tipoDe(a) === "computador") return a.sessao.nome?.trim() || "Computador";
  const limpo = (pedido ?? "").replace(/[\p{C}<>]/gu, "").trim().slice(0, 60);
  if (limpo) return limpo;
  const primeiro = a.usuario.nome.trim().split(/\s+/)[0] || "";
  const sistema = sistemaDoAparelho(ua);
  const base = sistema && !["Mac", "Windows", "Linux", "Chromebook"].includes(sistema) ? sistema : "Celular";
  return primeiro ? `${base} de ${primeiro}` : base;
}

const primeiroNome = (nome: string | null | undefined) => (nome || "").trim().split(/\s+/)[0] || "Alguém";

/** Marca o aparelho como online (em qual rede, e se aceita pedidos de outras pessoas por perto). */
export async function marcarVisto(a: Autenticado, nome: string, ip: string | null, aceitaOutros = false): Promise<void> {
  const valores = { usuarioId: a.usuario.id, tipo: tipoDe(a), nome, rede: redeDe(ip), aceitaOutros, vistoEm: new Date() };
  await db
    .insert(p2pAparelhos)
    .values({ sessaoId: a.sessao.id, ...valores })
    .onConflictDoUpdate({ target: p2pAparelhos.sessaoId, set: valores });
}

/** Quem este aparelho pode ver: o celular vê computadores e celulares; o computador, celulares (computador com
 * computador é "Entre computadores", docs/LAN.md). */
const tiposVisiveis = (a: Autenticado): TipoAparelhoP2p[] => (tipoDe(a) === "celular" ? ["computador", "celular"] : ["celular"]);

type Linha = { id: string; nome: string; tipo: TipoAparelhoP2p; usuarioId: string; dono: string | null; rede: string | null; aceitaOutros: boolean };

/** Aparelhos online que `a` pode ver: os da conta (tipos acima) e os de outras contas na mesma rede que aceitam. */
async function visiveis(a: Autenticado, ip: string | null, so?: string): Promise<Linha[]> {
  const agora = Date.now();
  const minhaRede = redeDe(ip);
  const tipos = tiposVisiveis(a);
  const daConta = and(eq(p2pAparelhos.usuarioId, a.usuario.id), eq(sessoes.usuarioId, a.usuario.id));
  const porPerto = minhaRede
    ? and(ne(p2pAparelhos.usuarioId, a.usuario.id), eq(sessoes.usuarioId, p2pAparelhos.usuarioId), eq(p2pAparelhos.rede, minhaRede), eq(p2pAparelhos.aceitaOutros, true))
    : undefined;
  const linhas = await db
    .select({
      id: p2pAparelhos.sessaoId,
      nome: p2pAparelhos.nome,
      tipo: p2pAparelhos.tipo,
      usuarioId: p2pAparelhos.usuarioId,
      dono: sql<string | null>`${usuarios.nome}`.as("dono_nome"),
      rede: p2pAparelhos.rede,
      aceitaOutros: p2pAparelhos.aceitaOutros,
      revogadaEm: sessoes.revogadaEm,
      expiraEm: sessoes.expiraEm,
    })
    .from(p2pAparelhos)
    .innerJoin(sessoes, eq(sessoes.id, p2pAparelhos.sessaoId))
    .innerJoin(usuarios, eq(usuarios.id, p2pAparelhos.usuarioId))
    .where(
      and(
        porPerto ? or(daConta, porPerto) : daConta,
        inArray(p2pAparelhos.tipo, tipos),
        ne(p2pAparelhos.sessaoId, a.sessao.id),
        gt(p2pAparelhos.vistoEm, new Date(agora - ONLINE_MS)),
        so ? eq(p2pAparelhos.sessaoId, so) : undefined,
      ),
    )
    .limit(60);
  return linhas.filter((l) => !l.revogadaEm && l.expiraEm.getTime() > agora);
}

/** Os aparelhos que este vê agora: os da conta primeiro, na mesma rede antes; depois as pessoas por perto. */
export async function aparelhosOnline(a: Autenticado, ip: string | null): Promise<Aparelho[]> {
  const minhaRede = redeDe(ip);
  return (await visiveis(a, ip))
    .map((l): Aparelho => {
      const conta: Conta = l.usuarioId === a.usuario.id ? "minha" : "outra";
      return { id: l.id, nome: l.nome, tipo: l.tipo, mesmaRede: !!minhaRede && l.rede === minhaRede, conta, ...(conta === "outra" ? { dono: primeiroNome(l.dono) } : {}) };
    })
    .sort((x, y) => Number(x.conta === "outra") - Number(y.conta === "outra") || Number(y.mesmaRede) - Number(x.mesmaRede) || x.nome.localeCompare(y.nome, "pt-BR"))
    .slice(0, 30);
}

const sdpSchema = z.string().min(10).max(20_000).startsWith("v=0");
export const sinalSchema = z.discriminatedUnion("tipo", [
  z
    .object({
      tipo: z.literal("oferta"),
      para: z.string().min(1).max(100),
      sdp: sdpSchema,
      resumo: z
        .object({
          arquivos: z.number().int().min(1).max(10_000),
          bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          nomes: z.array(z.string().max(255)).max(5),
        })
        .strict(),
    })
    .strict(),
  z.object({ tipo: z.literal("resposta"), para: z.string().min(1).max(100), oferta: z.string().min(1).max(100), sdp: sdpSchema }).strict(),
  z.object({ tipo: z.literal("recusa"), para: z.string().min(1).max(100), oferta: z.string().min(1).max(100), motivo: z.string().max(200).optional() }).strict(),
  z.object({ tipo: z.literal("cancela"), para: z.string().min(1).max(100), oferta: z.string().min(1).max(100), motivo: z.string().max(200).optional() }).strict(),
]);
export type NovoSinal = z.infer<typeof sinalSchema>;

/** Grava um sinal para outro aparelho da conta. Devolve o id (o da oferta é o que as respostas citam). */
export async function mandarSinal(a: Autenticado, s: NovoSinal, ip: string | null = null): Promise<string> {
  const usuarioId = a.usuario.id;
  if (s.para === a.sessao.id) throw new SinalError(400, "mesmo_aparelho", "Escolha outro aparelho.");
  const desde = new Date(Date.now() - VALIDADE_MS);
  let paraUsuario: string;
  if (s.tipo === "oferta") {
    // Só para quem este aparelho vê agora: da conta, ou alguém por perto que aceita (mesma rede).
    const [alvo] = await visiveis(a, ip, s.para);
    if (!alvo) throw new SinalError(404, "offline", "Esse aparelho não está com o SOBEDESCE aberto por perto agora.");
    paraUsuario = alvo.usuarioId;
    const recentes = await db
      .select({ id: p2pSinais.id })
      .from(p2pSinais)
      .where(and(eq(p2pSinais.deSessao, a.sessao.id), eq(p2pSinais.tipo, "oferta"), gt(p2pSinais.criadoEm, new Date(Date.now() - 60_000))))
      .limit(OFERTAS_POR_MINUTO);
    if (recentes.length >= OFERTAS_POR_MINUTO) throw new SinalError(429, "limite", "Muitas tentativas seguidas. Espere um minuto.");
  } else {
    // A oferta precisa existir, valer ainda e ser entre os dois (em qualquer sentido: quem ofereceu também cancela).
    const [o] = await db
      .select({ de: p2pSinais.deSessao, para: p2pSinais.paraSessao, deUsuario: p2pSinais.usuarioId, paraUsuario: p2pSinais.paraUsuario })
      .from(p2pSinais)
      .where(and(eq(p2pSinais.id, s.oferta), eq(p2pSinais.tipo, "oferta"), gt(p2pSinais.criadoEm, desde)))
      .limit(1);
    const euMandei = o && o.de === a.sessao.id && o.deUsuario === usuarioId && o.para === s.para;
    const euRecebi = o && o.para === a.sessao.id && o.paraUsuario === usuarioId && o.de === s.para;
    if (!euMandei && !euRecebi) throw new SinalError(404, "sem_oferta", "Esse pedido já venceu. Tente de novo.");
    if (s.tipo !== "cancela" && !euRecebi) throw new SinalError(400, "nao_e_seu", "Só quem recebeu o pedido responde.");
    paraUsuario = euMandei ? o.paraUsuario : o.deUsuario;
  }
  const id = novoId();
  await db.insert(p2pSinais).values({
    id,
    usuarioId,
    paraUsuario,
    deSessao: a.sessao.id,
    paraSessao: s.para,
    tipo: s.tipo,
    oferta: s.tipo === "oferta" ? null : s.oferta,
    sdp: "sdp" in s ? s.sdp : null,
    resumo: s.tipo === "oferta" ? { arquivos: s.resumo.arquivos, bytes: s.resumo.bytes, nomes: s.resumo.nomes.map((n) => n.slice(0, 120)) } : null,
    motivo: "motivo" in s ? (s.motivo ?? null) : null,
  });
  return id;
}

async function pegarSinais(a: Autenticado): Promise<SinalEntregue[]> {
  const desde = new Date(Date.now() - VALIDADE_MS);
  const linhas = await db
    .select({
      id: p2pSinais.id,
      tipo: p2pSinais.tipo,
      de: p2pSinais.deSessao,
      oferta: p2pSinais.oferta,
      sdp: p2pSinais.sdp,
      resumo: p2pSinais.resumo,
      motivo: p2pSinais.motivo,
      criadoEm: p2pSinais.criadoEm,
      deUsuario: p2pSinais.usuarioId,
      deNome: p2pAparelhos.nome,
      deTipo: p2pAparelhos.tipo,
      dono: sql<string | null>`${usuarios.nome}`.as("dono_nome"),
    })
    .from(p2pSinais)
    .leftJoin(p2pAparelhos, eq(p2pAparelhos.sessaoId, p2pSinais.deSessao))
    .leftJoin(usuarios, eq(usuarios.id, p2pSinais.usuarioId))
    .where(and(eq(p2pSinais.paraSessao, a.sessao.id), eq(p2pSinais.paraUsuario, a.usuario.id), isNull(p2pSinais.entregueEm), gt(p2pSinais.criadoEm, desde)))
    .orderBy(asc(p2pSinais.criadoEm))
    .limit(20);
  if (!linhas.length) return [];
  // Marca como entregue só os que esta espera pegou (duas esperas ao mesmo tempo não recebem o mesmo sinal).
  const marcados = await db
    .update(p2pSinais)
    .set({ entregueEm: new Date() })
    .where(and(inArray(p2pSinais.id, linhas.map((l) => l.id)), isNull(p2pSinais.entregueEm)))
    .returning({ id: p2pSinais.id });
  const meus = new Set(marcados.map((m) => m.id));
  return linhas
    .filter((l) => meus.has(l.id))
    .map((l) => ({
      id: l.id,
      tipo: l.tipo,
      de:
        l.deUsuario === a.usuario.id
          ? { id: l.de, nome: l.deNome ?? "Aparelho", tipo: l.deTipo ?? "celular", conta: "minha" as const }
          : { id: l.de, nome: l.deNome ?? "Aparelho", tipo: l.deTipo ?? "celular", conta: "outra" as const, dono: primeiroNome(l.dono) },
      ...(l.oferta ? { oferta: l.oferta } : {}),
      ...(l.sdp ? { sdp: l.sdp } : {}),
      ...(l.resumo ? { resumo: l.resumo } : {}),
      ...(l.motivo ? { motivo: l.motivo } : {}),
      criadoEm: l.criadoEm.getTime(),
    }));
}

/**
 * A espera longa: marca o aparelho como online e devolve os sinais para ele assim que houver, ou [] depois de `ms`.
 * Olha o banco a cada segundo. `sinal` (do pedido) encerra antes quando o cliente desiste.
 */
export async function esperar(a: Autenticado, o: { nome: string; ip: string | null; outros?: boolean; ms?: number; sinal?: AbortSignal }): Promise<SinalEntregue[]> {
  await marcarVisto(a, o.nome, o.ip, !!o.outros);
  const ate = Date.now() + Math.max(0, o.ms ?? ESPERA_MS);
  for (;;) {
    if (o.sinal?.aborted) return [];
    const sinais = await pegarSinais(a);
    if (sinais.length && o.sinal?.aborted) {
      // O pedido caiu enquanto pegava: devolve os sinais para a próxima espera (senão se perdem numa conexão morta).
      await db.update(p2pSinais).set({ entregueEm: null }).where(inArray(p2pSinais.id, sinais.map((x) => x.id)));
      return [];
    }
    if (sinais.length || Date.now() >= ate) return sinais;
    await new Promise((ok) => setTimeout(ok, Math.min(OLHAR_MS, Math.max(0, ate - Date.now()))));
  }
}

/** Limpeza: sinais vencidos e aparelhos sem notícia há um dia. Barata; roda de vez em quando junto da espera. */
export async function limpar(agora = Date.now()): Promise<void> {
  await db.delete(p2pSinais).where(lt(p2pSinais.criadoEm, new Date(agora - VALIDADE_MS * 2)));
  await db.delete(p2pAparelhos).where(lt(p2pAparelhos.vistoEm, new Date(agora - 24 * 60 * 60_000)));
}
