/**
 * Banco da SOBEDESCE (Neon na produção, PGlite no computador).
 * Tabelas definidas em docs/CONTAS.md §3. Depois de mudar: npm run db:generate.
 * Colunas em camelCase aqui, snake_case no banco (casing do Drizzle).
 */
import { bigint, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** Data e hora com fuso. `agora()`: obrigatória, padrão now(). */
const quando = () => timestamp({ withTimezone: true, mode: "date" });
const agora = () => quando().notNull().defaultNow();

/** Planos (docs/REFERENCIAS.md §1). Enquanto o beta está aberto, todo mundo usa tudo. */
export type Plano = "gratis" | "pro" | "produtora";

/** Contas da SOBEDESCE (e-mail e senha). */
export const usuarios = pgTable("usuarios", {
  id: text().primaryKey(),
  /** Sempre minúsculo e sem espaços nas pontas. */
  email: text().notNull().unique(),
  nome: text().notNull(),
  /** scrypt$N$r$p$sal$hash (base64url). */
  senhaHash: text().notNull(),
  criadoEm: agora(),
  atualizadoEm: agora(),
  ultimoLoginEm: quando(),
  plano: text().$type<Plano>().notNull().default("gratis"),
});

export type TipoSessao = "web" | "dispositivo";
export type Plataforma = "mac" | "windows" | "linux";

/** Sessões do site (cookie sd_sessao) e dos computadores (Bearer sdd_). Só o sha256 do token. */
export const sessoes = pgTable(
  "sessoes",
  {
    id: text().primaryKey(),
    usuarioId: text()
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    tokenHash: text().notNull().unique(),
    tipo: text().$type<TipoSessao>().notNull(),
    /** Dispositivo: "MacBook Pro de Victor". */
    nome: text(),
    plataforma: text().$type<Plataforma>(),
    criadoEm: agora(),
    ultimoUsoEm: agora(),
    expiraEm: quando().notNull(),
    revogadaEm: quando(),
  },
  (t) => [index("sessoes_usuario_idx").on(t.usuarioId)],
);

export type EstadoContaGoogle = "ok" | "reconectar";

/** Contas Google vinculadas. Uma conta Google pertence a uma só conta SOBEDESCE (googleSub único). */
export const contasGoogle = pgTable(
  "contas_google",
  {
    id: text().primaryKey(),
    usuarioId: text()
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    googleSub: text().notNull().unique(),
    email: text().notNull(),
    nome: text(),
    fotoUrl: text(),
    /** AES-256-GCM com SOBEDESCE_KEY (src/lib/google/cripto.ts). Nunca sai do servidor. */
    refreshTokenEnc: text().notNull(),
    accessTokenEnc: text(),
    accessExpiraEm: quando(),
    escopos: text().notNull().default(""),
    estado: text().$type<EstadoContaGoogle>().notNull().default("ok"),
    /** Pasta "SOBEDESCE Referências" deste Drive (achada ou criada na primeira coleção). */
    referenciasPastaId: text(),
    criadoEm: agora(),
    atualizadoEm: agora(),
  },
  (t) => [index("contas_google_usuario_idx").on(t.usuarioId)],
);

/** Fluxo de dispositivo: o computador pede um código, a pessoa libera em /dispositivo. */
export const codigosDispositivo = pgTable("codigos_dispositivo", {
  id: text().primaryKey(),
  /** ABCD-EFGH, sem letras ambíguas. */
  codigo: text().notNull().unique(),
  /** sha256 do segredo que só o computador conhece. */
  segredoHash: text().notNull().unique(),
  nome: text().notNull(),
  plataforma: text().$type<Plataforma>(),
  usuarioId: text().references(() => usuarios.id, { onDelete: "cascade" }),
  aprovadoEm: quando(),
  usadoEm: quando(),
  /** Última consulta do computador (limite de ritmo do /aguardar). */
  consultadoEm: quando(),
  expiraEm: quando().notNull(),
  criadoEm: agora(),
});

/** Limite de tentativas (login, criação de conta, código de dispositivo). Limpeza preguiçosa. */
export const tentativas = pgTable(
  "tentativas",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    chave: text().notNull(),
    quando: agora(),
  },
  (t) => [index("tentativas_chave_quando_idx").on(t.chave, t.quando)],
);

/** "Esqueci a senha": link de uso único, 1 hora. Só o sha256 do token. */
export const redefinicoesSenha = pgTable(
  "redefinicoes_senha",
  {
    id: text().primaryKey(),
    usuarioId: text()
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    tokenHash: text().notNull().unique(),
    expiraEm: quando().notNull(),
    usadoEm: quando(),
    criadoEm: agora(),
  },
  (t) => [index("redefinicoes_senha_usuario_idx").on(t.usuarioId)],
);

// ───── Referências (docs/REFERENCIAS.md) ─────

/** Coleções de referências: uma pasta em "SOBEDESCE Referências/<nome>" no Drive da pessoa. */
export const colecoes = pgTable(
  "colecoes",
  {
    id: text().primaryKey(),
    usuarioId: text()
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    contaGoogleId: text()
      .notNull()
      .references(() => contasGoogle.id, { onDelete: "cascade" }),
    driveFolderId: text().notNull(),
    nome: text().notNull(),
    /** Nome sem maiúsculas nem acentos: não deixa duas coleções com o "mesmo" nome. */
    nomeChave: text().notNull(),
    /** Link pra IA (/r/<token>): 32 bytes base64url. null = desligado. */
    publicaToken: text().unique(),
    criadoEm: agora(),
    atualizadoEm: agora(),
  },
  (t) => [index("colecoes_usuario_idx").on(t.usuarioId), uniqueIndex("colecoes_usuario_nome_idx").on(t.usuarioId, t.nomeChave)],
);

export type StatusFila = "pendente" | "baixando" | "pronto" | "erro";

/** Links que o celular (ou o Atalho do iPhone) guardou para o computador baixar. */
export const referenciasFila = pgTable(
  "referencias_fila",
  {
    id: text().primaryKey(),
    usuarioId: text()
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    colecaoId: text()
      .notNull()
      .references(() => colecoes.id, { onDelete: "cascade" }),
    url: text().notNull(),
    nota: text(),
    status: text().$type<StatusFila>().notNull().default("pendente"),
    erro: text(),
    driveFileId: text(),
    /** Sessão (computador) que pegou o item. */
    dispositivoId: text(),
    criadoEm: agora(),
    atualizadoEm: agora(),
  },
  (t) => [index("referencias_fila_usuario_status_idx").on(t.usuarioId, t.status), index("referencias_fila_colecao_idx").on(t.colecaoId)],
);

/** Chave do Atalho do iPhone: só serve para pôr links na fila. Só o sha256. */
export const atalhos = pgTable(
  "atalhos",
  {
    id: text().primaryKey(),
    usuarioId: text()
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    tokenHash: text().notNull().unique(),
    criadoEm: agora(),
    ultimoUsoEm: quando(),
    revogadoEm: quando(),
  },
  (t) => [index("atalhos_usuario_idx").on(t.usuarioId)],
);
