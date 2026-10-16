import "server-only";
/**
 * Tela de admin (/admin): quem entrou na plataforma. Só para os e-mails de SOBEDESCE_ADMINS (separados por
 * vírgula; padrão: o do Victor). Vale o e-mail da conta SOBEDESCE ou o de um Google Drive conectado nela.
 */
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Plano } from "@/lib/db/schema";

const PADRAO = ["contato@dissesim.com.br"];

export function emailsAdmin(env: Record<string, string | undefined> = process.env): string[] {
  const lista = (env.SOBEDESCE_ADMINS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return lista.length ? lista : PADRAO;
}

/** true se a conta (pelo próprio e-mail ou por um Drive conectado) está na lista de admins. */
export async function ehAdmin(usuario: { id: string; email: string }, admins = emailsAdmin()): Promise<boolean> {
  if (admins.includes(usuario.email.toLowerCase())) return true;
  const drive = await db
    .select({ id: schema.contasGoogle.id })
    .from(schema.contasGoogle)
    .where(and(eq(schema.contasGoogle.usuarioId, usuario.id), inArray(sql`lower(${schema.contasGoogle.email})`, admins)))
    .limit(1);
  return drive.length > 0;
}

export type DriveAdmin = { email: string; nome: string | null; fotoUrl: string | null; estado: "ok" | "reconectar"; criadoEm: Date };
export type PessoaAdmin = {
  id: string;
  plano: Plano;
  nome: string;
  email: string;
  criadoEm: Date;
  ultimoLoginEm: Date | null;
  /** Último uso de qualquer sessão (site ou computador). */
  ultimoUsoEm: Date | null;
  comSenha: boolean;
  drives: DriveAdmin[];
  computadores: number;
};

export type ResumoAdmin = { contas: number; drivesOk: number; drivesReconectar: number; ativos7d: number; novas7d: number; computadores: number };

const DIA = 86_400_000;

/** Todas as contas, das mais novas para as mais antigas, com Drives e computadores. */
export async function listarPessoas(agora = new Date()): Promise<{ pessoas: PessoaAdmin[]; resumo: ResumoAdmin }> {
  const [usuarios, drives, sessoes] = await Promise.all([
    db
      .select({
        id: schema.usuarios.id,
        nome: schema.usuarios.nome,
        email: schema.usuarios.email,
        plano: schema.usuarios.plano,
        senhaHash: schema.usuarios.senhaHash,
        criadoEm: schema.usuarios.criadoEm,
        ultimoLoginEm: schema.usuarios.ultimoLoginEm,
      })
      .from(schema.usuarios)
      .orderBy(desc(schema.usuarios.criadoEm)),
    db
      .select({
        usuarioId: schema.contasGoogle.usuarioId,
        email: schema.contasGoogle.email,
        nome: schema.contasGoogle.nome,
        fotoUrl: schema.contasGoogle.fotoUrl,
        estado: schema.contasGoogle.estado,
        criadoEm: schema.contasGoogle.criadoEm,
      })
      .from(schema.contasGoogle)
      .orderBy(schema.contasGoogle.criadoEm),
    db
      .select({ usuarioId: schema.sessoes.usuarioId, tipo: schema.sessoes.tipo, ultimoUsoEm: schema.sessoes.ultimoUsoEm })
      .from(schema.sessoes)
      .where(and(isNull(schema.sessoes.revogadaEm), gt(schema.sessoes.expiraEm, agora))),
  ]);

  const porUsuario = new Map<string, PessoaAdmin>();
  for (const u of usuarios) {
    porUsuario.set(u.id, {
      id: u.id,
      plano: u.plano,
      nome: u.nome,
      email: u.email,
      criadoEm: u.criadoEm,
      ultimoLoginEm: u.ultimoLoginEm,
      ultimoUsoEm: u.ultimoLoginEm,
      // Conta criada pelo "Continuar com Google" não tem senha (src/lib/google/contas.ts, SEM_SENHA).
      comSenha: u.senhaHash.startsWith("scrypt$"),
      drives: [],
      computadores: 0,
    });
  }
  for (const d of drives) porUsuario.get(d.usuarioId)?.drives.push({ email: d.email, nome: d.nome, fotoUrl: d.fotoUrl, estado: d.estado, criadoEm: d.criadoEm });
  for (const s of sessoes) {
    const p = porUsuario.get(s.usuarioId);
    if (!p) continue;
    if (s.tipo === "dispositivo") p.computadores++;
    if (!p.ultimoUsoEm || s.ultimoUsoEm > p.ultimoUsoEm) p.ultimoUsoEm = s.ultimoUsoEm;
  }

  const pessoas = [...porUsuario.values()];
  const limite = agora.getTime() - 7 * DIA;
  const resumo: ResumoAdmin = {
    contas: pessoas.length,
    drivesOk: drives.filter((d) => d.estado === "ok").length,
    drivesReconectar: drives.filter((d) => d.estado !== "ok").length,
    ativos7d: pessoas.filter((p) => p.ultimoUsoEm && p.ultimoUsoEm.getTime() >= limite).length,
    novas7d: pessoas.filter((p) => p.criadoEm.getTime() >= limite).length,
    computadores: pessoas.reduce((n, p) => n + p.computadores, 0),
  };
  return { pessoas, resumo };
}

/** Filtro da busca: nome, e-mail da conta ou e-mail de um Drive (sem acento, sem maiúscula). */
export function filtrarPessoas(pessoas: PessoaAdmin[], busca: string): PessoaAdmin[] {
  const limpa = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = limpa(busca.trim());
  if (!q) return pessoas;
  return pessoas.filter((p) => [p.nome, p.email, ...p.drives.map((d) => d.email), ...p.drives.map((d) => d.nome ?? "")].some((t) => limpa(t).includes(q)));
}
