import "server-only";
/**
 * Tela de admin (/admin): quem entrou na plataforma. Só para os e-mails de SOBEDESCE_ADMINS (separados por
 * vírgula; padrão: o do Victor). Vale SÓ o e-mail de um Google Drive conectado na conta (contas_google) E que o
 * Google disse estar confirmado (email_verified, gravado ao conectar ou entrar). O e-mail da conta SOBEDESCE não
 * vale: criar conta não confirma o e-mail, e o padrão é público (rodapé, política), então qualquer um criaria uma
 * conta com ele e abriria /admin. Uma conta Google com e-mail não confirmado também não vale (dá para criar uma
 * conta Google com um e-mail de outra pessoa sem confirmar). Conta criada pelo "Continuar com Google" já nasce com
 * o Drive conectado e confirmado, então continua admin por ele.
 */
import { and, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { Plataforma, Plano } from "@/lib/db/schema";
import { versaoPublicada } from "@/lib/release";

const PADRAO = ["contato@dissesim.com.br"];

export function emailsAdmin(env: Record<string, string | undefined> = process.env): string[] {
  const lista = (env.SOBEDESCE_ADMINS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return lista.length ? lista : PADRAO;
}

/** true se algum Drive conectado na conta, com e-mail confirmado pelo Google, está na lista de admins. O e-mail da conta é ignorado. */
export async function ehAdmin(usuario: { id: string; email?: string }, admins = emailsAdmin()): Promise<boolean> {
  if (!admins.length) return false;
  const drive = await db
    .select({ id: schema.contasGoogle.id })
    .from(schema.contasGoogle)
    .where(
      and(
        eq(schema.contasGoogle.usuarioId, usuario.id),
        eq(schema.contasGoogle.emailVerificado, true),
        inArray(sql`lower(${schema.contasGoogle.email})`, admins),
      ),
    )
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
export function filtrarPessoas<T extends PessoaAdmin>(pessoas: T[], busca: string): T[] {
  const limpa = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = limpa(busca.trim());
  if (!q) return pessoas;
  return pessoas.filter((p) => [p.nome, p.email, ...p.drives.map((d) => d.email), ...p.drives.map((d) => d.nome ?? "")].some((t) => limpa(t).includes(q)));
}

// ───── Uso da plataforma (docs/CONTAS.md §10) ─────

export type Origem = "site" | "celular" | "computador";
export type NumerosUso = { enviadosBytes: number; baixadosBytes: number; enviados: number; baixados: number; erros: number; maiorArquivo: number; msAtivo: number };
export type ComputadorAdmin = {
  id: string;
  nome: string | null;
  plataforma: Plataforma | null;
  appBuild: number | null;
  criadoEm: Date;
  ultimoUsoEm: Date;
  /** O app mandou notícia nos últimos 2 minutos (Acompanhar pelo celular ligado). */
  abertoAgora: boolean;
};
export type PessoaUso = PessoaAdmin & {
  ultimaOrigem: Origem | null;
  online: boolean;
  diasAtivos30: number;
  /** Dias com uso nos últimos 30, do mais antigo ao de hoje (true = usou). */
  tira30: boolean[];
  usou: { site: boolean; celular: boolean; computador: boolean };
  uso30: NumerosUso;
  usoTotal: NumerosUso;
  listaComputadores: ComputadorAdmin[];
  avisosCelular: number;
  colecoes: number;
  referencias: number;
  referenciasComErro: number;
  /** Já teve algum computador conectado (mesmo que desconectado depois). */
  jaTeveComputador: boolean;
};
export type PainelAdmin = {
  pessoas: PessoaUso[];
  resumo: ResumoAdmin & {
    onlineAgora: number;
    ativosHoje: number;
    ativos30d: number;
    parados: number;
    /** Pessoas ativas por dia, últimos 30 dias (mais antigo primeiro). */
    serie: { dia: string; pessoas: number; bytes: number }[];
    uso7: NumerosUso;
    usoTotal: NumerosUso;
    funil: { contas: number; comDrive: number; comComputador: number; transferiu: number };
    buildAtual: number | null;
    desatualizados: number;
    colecoes: number;
    referencias: number;
    avisosCelular: number;
  };
};

const ZERO: NumerosUso = { enviadosBytes: 0, baixadosBytes: 0, enviados: 0, baixados: 0, erros: 0, maiorArquivo: 0, msAtivo: 0 };
export const PARADO_DIAS = 14;
const ONLINE_MS = 15 * 60_000;
const ABERTO_MS = 2 * 60_000;
const FUSO = "America/Fortaleza";
const formatoDia = new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" });
export const diaAdmin = (d: Date) => formatoDia.format(d);

/** Os últimos `n` dias (fuso de Fortaleza), do mais antigo a hoje. */
export function ultimosDias(n: number, agora = new Date()): string[] {
  const hoje = diaAdmin(agora);
  const base = Date.parse(`${hoje}T12:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(base - (n - 1 - i) * DIA).toISOString().slice(0, 10));
}

function somar(a: NumerosUso, b: Partial<NumerosUso>): NumerosUso {
  return {
    enviadosBytes: a.enviadosBytes + Number(b.enviadosBytes ?? 0),
    baixadosBytes: a.baixadosBytes + Number(b.baixadosBytes ?? 0),
    enviados: a.enviados + Number(b.enviados ?? 0),
    baixados: a.baixados + Number(b.baixados ?? 0),
    erros: a.erros + Number(b.erros ?? 0),
    maiorArquivo: Math.max(a.maiorArquivo, Number(b.maiorArquivo ?? 0)),
    msAtivo: a.msAtivo + Number(b.msAtivo ?? 0),
  };
}

/** Velocidade média em bytes/s (o que passou dividido pelo tempo com algo andando). */
export function velocidadeMedia(u: NumerosUso): number {
  return u.msAtivo > 0 ? ((u.enviadosBytes + u.baixadosBytes) * 1000) / u.msAtivo : 0;
}

/** Computador com app mais velho que o publicado (sem build conhecido = versão anterior ao aviso de build). */
export function desatualizado(c: Pick<ComputadorAdmin, "appBuild">, buildAtual: number | null): boolean {
  if (!buildAtual) return false;
  if (c.appBuild == null) return true;
  return c.appBuild > 0 && c.appBuild < buildAtual;
}

/** Tudo da tela de admin. Só números e datas: nada do que as pessoas transferem (nome de arquivo, pasta). */
export async function painelAdmin(agora = new Date(), buildAtual: number | null = null): Promise<PainelAdmin> {
  const { pessoas: base, resumo: resumoBase } = await listarPessoas(agora);
  const dias = ultimosDias(30, agora);
  const desde30 = dias[0];
  const desde7 = dias[23];
  const hoje = dias[29];
  const s = schema;

  const [atividade, usoPorPessoa, usoPorDia, sessoes, status, push, cols, refs, jaComputador] = await Promise.all([
    db
      .select({
        usuarioId: s.atividadeDiaria.usuarioId,
        dia: s.atividadeDiaria.dia,
        site: s.atividadeDiaria.site,
        celular: s.atividadeDiaria.celular,
        computador: s.atividadeDiaria.computador,
        ultimaEm: s.atividadeDiaria.ultimaEm,
        ultimaOrigem: s.atividadeDiaria.ultimaOrigem,
      })
      .from(s.atividadeDiaria)
      .where(gte(s.atividadeDiaria.dia, desde30)),
    db
      .select({
        usuarioId: s.usoDiario.usuarioId,
        recente: sql<boolean>`${s.usoDiario.dia} >= ${desde30}`,
        semana: sql<boolean>`${s.usoDiario.dia} >= ${desde7}`,
        enviadosBytes: sql<number>`sum(${s.usoDiario.enviadosBytes})::float8`,
        baixadosBytes: sql<number>`sum(${s.usoDiario.baixadosBytes})::float8`,
        enviados: sql<number>`sum(${s.usoDiario.enviados})::int`,
        baixados: sql<number>`sum(${s.usoDiario.baixados})::int`,
        erros: sql<number>`sum(${s.usoDiario.erros})::int`,
        maiorArquivo: sql<number>`max(${s.usoDiario.maiorArquivo})::float8`,
        msAtivo: sql<number>`sum(${s.usoDiario.msAtivo})::float8`,
      })
      .from(s.usoDiario)
      .groupBy(s.usoDiario.usuarioId, sql`2`, sql`3`),
    db
      .select({ dia: s.usoDiario.dia, bytes: sql<number>`sum(${s.usoDiario.enviadosBytes} + ${s.usoDiario.baixadosBytes})::float8` })
      .from(s.usoDiario)
      .where(gte(s.usoDiario.dia, desde30))
      .groupBy(s.usoDiario.dia),
    db
      .select({
        id: s.sessoes.id,
        usuarioId: s.sessoes.usuarioId,
        nome: s.sessoes.nome,
        plataforma: s.sessoes.plataforma,
        appBuild: s.sessoes.appBuild,
        criadoEm: s.sessoes.criadoEm,
        ultimoUsoEm: s.sessoes.ultimoUsoEm,
      })
      .from(s.sessoes)
      .where(and(eq(s.sessoes.tipo, "dispositivo"), isNull(s.sessoes.revogadaEm), gt(s.sessoes.expiraEm, agora))),
    db.select({ sessaoId: s.dispositivoStatus.sessaoId, atualizadoEm: s.dispositivoStatus.atualizadoEm }).from(s.dispositivoStatus),
    db.select({ usuarioId: s.pushInscricoes.usuarioId, n: sql<number>`count(*)::int` }).from(s.pushInscricoes).groupBy(s.pushInscricoes.usuarioId),
    db.select({ usuarioId: s.colecoes.usuarioId, n: sql<number>`count(*)::int` }).from(s.colecoes).groupBy(s.colecoes.usuarioId),
    db
      .select({ usuarioId: s.referenciasFila.usuarioId, n: sql<number>`count(*)::int`, erro: sql<number>`count(*) filter (where ${s.referenciasFila.status} = 'erro')::int` })
      .from(s.referenciasFila)
      .groupBy(s.referenciasFila.usuarioId),
    db.selectDistinct({ usuarioId: s.sessoes.usuarioId }).from(s.sessoes).where(eq(s.sessoes.tipo, "dispositivo")),
  ]);

  const abertos = new Map(status.map((st) => [st.sessaoId, st.atualizadoEm]));
  const porId = new Map<string, PessoaUso>();
  for (const p of base) {
    porId.set(p.id, {
      ...p,
      ultimaOrigem: null,
      online: false,
      diasAtivos30: 0,
      tira30: dias.map(() => false),
      usou: { site: false, celular: false, computador: false },
      uso30: { ...ZERO },
      usoTotal: { ...ZERO },
      listaComputadores: [],
      avisosCelular: 0,
      colecoes: 0,
      referencias: 0,
      referenciasComErro: 0,
      jaTeveComputador: false,
    });
  }
  const indiceDia = new Map(dias.map((d, i) => [d, i]));
  const ultimaAtividade = new Map<string, Date>();
  const ativosPorDia = new Map<string, Set<string>>();
  for (const a of atividade) {
    const p = porId.get(a.usuarioId);
    if (!p) continue;
    const i = indiceDia.get(a.dia);
    if (i != null && !p.tira30[i]) {
      p.tira30[i] = true;
      p.diasAtivos30++;
    }
    if (!ativosPorDia.has(a.dia)) ativosPorDia.set(a.dia, new Set());
    ativosPorDia.get(a.dia)!.add(a.usuarioId);
    p.usou.site ||= a.site;
    p.usou.celular ||= a.celular;
    p.usou.computador ||= a.computador;
    const antes = ultimaAtividade.get(a.usuarioId);
    if (!antes || a.ultimaEm > antes) {
      ultimaAtividade.set(a.usuarioId, a.ultimaEm);
      p.ultimaOrigem = a.ultimaOrigem ?? (a.computador ? "computador" : a.celular ? "celular" : a.site ? "site" : null);
    }
  }
  let uso7 = { ...ZERO };
  let usoGeral = { ...ZERO };
  for (const u of usoPorPessoa) {
    const p = porId.get(u.usuarioId);
    usoGeral = somar(usoGeral, u);
    if (u.semana) uso7 = somar(uso7, u);
    if (!p) continue;
    p.usoTotal = somar(p.usoTotal, u);
    if (u.recente) p.uso30 = somar(p.uso30, u);
  }
  for (const c of sessoes) {
    const p = porId.get(c.usuarioId);
    if (!p) continue;
    const visto = abertos.get(c.id);
    p.listaComputadores.push({ ...c, abertoAgora: !!visto && agora.getTime() - visto.getTime() < ABERTO_MS });
  }
  for (const r of push) {
    const p = porId.get(r.usuarioId);
    if (p) p.avisosCelular = r.n;
  }
  for (const r of cols) {
    const p = porId.get(r.usuarioId);
    if (p) p.colecoes = r.n;
  }
  for (const r of refs) {
    const p = porId.get(r.usuarioId);
    if (p) {
      p.referencias = r.n;
      p.referenciasComErro = r.erro;
    }
  }
  for (const r of jaComputador) {
    const p = porId.get(r.usuarioId);
    if (p) p.jaTeveComputador = true;
  }

  const pessoas = [...porId.values()];
  for (const p of pessoas) {
    p.listaComputadores.sort((a, b) => b.ultimoUsoEm.getTime() - a.ultimoUsoEm.getTime());
    p.online = (!!p.ultimoUsoEm && agora.getTime() - p.ultimoUsoEm.getTime() < ONLINE_MS) || p.listaComputadores.some((c) => c.abertoAgora);
  }
  const bytesPorDia = new Map(usoPorDia.map((u) => [u.dia, Number(u.bytes) || 0]));
  const limite30 = agora.getTime() - 30 * DIA;
  const limiteParado = agora.getTime() - PARADO_DIAS * DIA;
  return {
    pessoas,
    resumo: {
      ...resumoBase,
      onlineAgora: pessoas.filter((p) => p.online).length,
      ativosHoje: ativosPorDia.get(hoje)?.size ?? 0,
      ativos30d: pessoas.filter((p) => p.ultimoUsoEm && p.ultimoUsoEm.getTime() >= limite30).length,
      parados: pessoas.filter((p) => !p.ultimoUsoEm || p.ultimoUsoEm.getTime() < limiteParado).length,
      serie: dias.map((dia) => ({ dia, pessoas: ativosPorDia.get(dia)?.size ?? 0, bytes: bytesPorDia.get(dia) ?? 0 })),
      uso7,
      usoTotal: usoGeral,
      funil: {
        contas: pessoas.length,
        comDrive: pessoas.filter((p) => p.drives.length > 0).length,
        comComputador: pessoas.filter((p) => p.jaTeveComputador).length,
        transferiu: pessoas.filter((p) => p.usoTotal.enviados + p.usoTotal.baixados > 0).length,
      },
      buildAtual,
      desatualizados: pessoas.reduce((n, p) => n + p.listaComputadores.filter((c) => desatualizado(c, buildAtual)).length, 0),
      colecoes: pessoas.reduce((n, p) => n + p.colecoes, 0),
      referencias: pessoas.reduce((n, p) => n + p.referencias, 0),
      avisosCelular: pessoas.filter((p) => p.avisosCelular > 0).length,
    },
  };
}

export const FILTROS = {
  todos: "Todos",
  online: "Online agora",
  ativos: "Ativos em 7 dias",
  parados: `Parados há ${PARADO_DIAS}+ dias`,
  reconectar: "Drive para reconectar",
  "sem-drive": "Sem Drive",
  "sem-computador": "Sem computador",
  desatualizado: "App desatualizado",
  erros: "Com erros (30 dias)",
} as const;
export type Filtro = keyof typeof FILTROS;
export const ORDENS = { novas: "Mais novas", uso: "Último uso", volume: "Mais volume (30 dias)" } as const;
export type Ordem = keyof typeof ORDENS;

export function ehFiltro(v: unknown): v is Filtro {
  return typeof v === "string" && Object.hasOwn(FILTROS, v);
}
export function ehOrdem(v: unknown): v is Ordem {
  return typeof v === "string" && Object.hasOwn(ORDENS, v);
}

/** Filtro, plano e ordem da lista. */
export function aplicarFiltro(
  pessoas: PessoaUso[],
  o: { filtro?: Filtro; plano?: Plano | null; ordem?: Ordem; buildAtual?: number | null },
  agora = new Date(),
): PessoaUso[] {
  const sete = agora.getTime() - 7 * DIA;
  const parado = agora.getTime() - PARADO_DIAS * DIA;
  const regra: Record<Filtro, (p: PessoaUso) => boolean> = {
    todos: () => true,
    online: (p) => p.online,
    ativos: (p) => !!p.ultimoUsoEm && p.ultimoUsoEm.getTime() >= sete,
    parados: (p) => !p.ultimoUsoEm || p.ultimoUsoEm.getTime() < parado,
    reconectar: (p) => p.drives.some((d) => d.estado !== "ok"),
    "sem-drive": (p) => p.drives.length === 0,
    "sem-computador": (p) => p.listaComputadores.length === 0,
    desatualizado: (p) => p.listaComputadores.some((c) => desatualizado(c, o.buildAtual ?? null)),
    erros: (p) => p.uso30.erros > 0,
  };
  const lista = pessoas.filter((p) => regra[o.filtro ?? "todos"](p) && (!o.plano || p.plano === o.plano));
  const t = (d: Date | null) => d?.getTime() ?? 0;
  if (o.ordem === "uso") lista.sort((a, b) => t(b.ultimoUsoEm) - t(a.ultimoUsoEm));
  else if (o.ordem === "volume") lista.sort((a, b) => b.uso30.enviadosBytes + b.uso30.baixadosBytes - (a.uso30.enviadosBytes + a.uso30.baixadosBytes));
  return lista;
}

const csvCampo = (v: unknown) => {
  const t = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  // Evita fórmula no Excel/Sheets (=, +, -, @ no começo).
  const seguro = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
  return /[",\n;]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
};

/** Planilha da lista (uma linha por conta). Só o que a tela já mostra. */
export function paraCsv(pessoas: PessoaUso[], buildAtual: number | null): string {
  const cab = [
    "nome",
    "email",
    "plano",
    "conta_criada",
    "ultimo_uso",
    "por_onde",
    "dias_ativos_30",
    "drives",
    "drives_reconectar",
    "computadores",
    "computadores_desatualizados",
    "avisos_no_celular",
    "gb_enviados_30d",
    "gb_baixados_30d",
    "arquivos_30d",
    "erros_30d",
    "gb_total",
    "colecoes",
    "referencias",
  ];
  const gb = (b: number) => (b / 1e9).toFixed(2);
  const linhas = pessoas.map((p) =>
    [
      p.nome,
      p.email,
      p.plano,
      p.criadoEm,
      p.ultimoUsoEm,
      p.ultimaOrigem ?? "",
      p.diasAtivos30,
      p.drives.length,
      p.drives.filter((d) => d.estado !== "ok").length,
      p.listaComputadores.length,
      p.listaComputadores.filter((c) => desatualizado(c, buildAtual)).length,
      p.avisosCelular,
      gb(p.uso30.enviadosBytes),
      gb(p.uso30.baixadosBytes),
      p.uso30.enviados + p.uso30.baixados,
      p.uso30.erros,
      gb(p.usoTotal.enviadosBytes + p.usoTotal.baixadosBytes),
      p.colecoes,
      p.referencias,
    ]
      .map(csvCampo)
      .join(","),
  );
  return [cab.join(","), ...linhas].join("\n") + "\n";
}

export type DiaLinha = { dia: string; site: boolean; celular: boolean; computador: boolean; ultimaEm: Date | null; uso: NumerosUso };
export type SessaoAdmin = { id: string; tipo: "web" | "dispositivo"; nome: string | null; plataforma: Plataforma | null; appBuild: number | null; criadoEm: Date; ultimoUsoEm: Date };
export type Evento = { quando: Date; texto: string };

/** Linha do tempo de uma pessoa: dias com uso (últimos 60), sessões ativas e marcos da conta. */
export async function linhaDoTempo(usuarioId: string, pessoa: PessoaUso, agora = new Date()): Promise<{ dias: DiaLinha[]; sessoes: SessaoAdmin[]; eventos: Evento[] }> {
  const s = schema;
  const desde = ultimosDias(60, agora)[0];
  const [atividade, uso, sessoes, todas] = await Promise.all([
    db
      .select()
      .from(s.atividadeDiaria)
      .where(and(eq(s.atividadeDiaria.usuarioId, usuarioId), gte(s.atividadeDiaria.dia, desde))),
    db
      .select({
        dia: s.usoDiario.dia,
        enviadosBytes: sql<number>`sum(${s.usoDiario.enviadosBytes})::float8`,
        baixadosBytes: sql<number>`sum(${s.usoDiario.baixadosBytes})::float8`,
        enviados: sql<number>`sum(${s.usoDiario.enviados})::int`,
        baixados: sql<number>`sum(${s.usoDiario.baixados})::int`,
        erros: sql<number>`sum(${s.usoDiario.erros})::int`,
        maiorArquivo: sql<number>`max(${s.usoDiario.maiorArquivo})::float8`,
        msAtivo: sql<number>`sum(${s.usoDiario.msAtivo})::float8`,
      })
      .from(s.usoDiario)
      .where(and(eq(s.usoDiario.usuarioId, usuarioId), gte(s.usoDiario.dia, desde)))
      .groupBy(s.usoDiario.dia),
    db
      .select({
        id: s.sessoes.id,
        tipo: s.sessoes.tipo,
        nome: s.sessoes.nome,
        plataforma: s.sessoes.plataforma,
        appBuild: s.sessoes.appBuild,
        criadoEm: s.sessoes.criadoEm,
        ultimoUsoEm: s.sessoes.ultimoUsoEm,
      })
      .from(s.sessoes)
      .where(and(eq(s.sessoes.usuarioId, usuarioId), isNull(s.sessoes.revogadaEm), gt(s.sessoes.expiraEm, agora)))
      .orderBy(desc(s.sessoes.ultimoUsoEm)),
    db
      .select({ tipo: s.sessoes.tipo, nome: s.sessoes.nome, criadoEm: s.sessoes.criadoEm, revogadaEm: s.sessoes.revogadaEm })
      .from(s.sessoes)
      .where(and(eq(s.sessoes.usuarioId, usuarioId), eq(s.sessoes.tipo, "dispositivo"))),
  ]);
  const porDia = new Map<string, DiaLinha>();
  const pegar = (dia: string) => {
    let d = porDia.get(dia);
    if (!d) porDia.set(dia, (d = { dia, site: false, celular: false, computador: false, ultimaEm: null, uso: { ...ZERO } }));
    return d;
  };
  for (const a of atividade) Object.assign(pegar(a.dia), { site: a.site, celular: a.celular, computador: a.computador, ultimaEm: a.ultimaEm });
  for (const u of uso) pegar(u.dia).uso = somar(ZERO, u);
  const dias = [...porDia.values()].sort((a, b) => (a.dia < b.dia ? 1 : -1));

  const eventos: Evento[] = [{ quando: pessoa.criadoEm, texto: pessoa.comSenha ? "Criou a conta com e-mail e senha" : "Criou a conta com o Google" }];
  for (const d of pessoa.drives) eventos.push({ quando: d.criadoEm, texto: `Conectou o Drive ${d.email}` });
  for (const c of todas) {
    eventos.push({ quando: c.criadoEm, texto: `Conectou o computador ${c.nome ?? "sem nome"}` });
    if (c.revogadaEm) eventos.push({ quando: c.revogadaEm, texto: `Desconectou o computador ${c.nome ?? "sem nome"}` });
  }
  if (pessoa.ultimoLoginEm) eventos.push({ quando: pessoa.ultimoLoginEm, texto: "Último login no site" });
  eventos.sort((a, b) => b.quando.getTime() - a.quando.getTime());
  return { dias, sessoes, eventos };
}

/** Build publicado (para marcar app desatualizado). Sem GitHub: null e ninguém aparece como desatualizado. */
export async function buildPublicado(): Promise<number | null> {
  try {
    return (await versaoPublicada()).build || null;
  } catch {
    return null;
  }
}
