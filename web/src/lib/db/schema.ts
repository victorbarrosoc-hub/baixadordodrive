/**
 * Banco da SOBEDESCE (Neon na produção, PGlite no computador).
 * Tabelas definidas em docs/CONTAS.md §3. Depois de mudar: npm run db:generate.
 * Colunas em camelCase aqui, snake_case no banco (casing do Drizzle).
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { StatusComputador } from "../acompanhar/formato";

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
    /** Build do app de computador (cabeçalho x-sobedesce-build), gravado junto com o ultimoUsoEm. 0 = desenvolvimento. */
    appBuild: integer(),
  },
  (t) => [index("sessoes_usuario_idx").on(t.usuarioId)],
);

export type EstadoContaGoogle = "ok" | "reconectar";

/**
 * Contas Google vinculadas. Uma conta Google pertence a uma só conta SOBEDESCE (googleSub único).
 * "Entrar com Google" só vale pela que tem `loginPermitido` (no máximo uma por conta, índice parcial abaixo):
 * a que criou a conta, ou a que a pessoa escolheu em /conta. Conectar outro Drive não abre a conta (revisão A3).
 */
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
    /** Este Google serve para entrar na conta ("Entrar com Google"). */
    loginPermitido: boolean().notNull().default(false),
    /** O Google confirmou o e-mail (email_verified do userinfo) na última vez que conectou ou entrou. */
    emailVerificado: boolean().notNull().default(false),
    /** Pasta "SOBEDESCE Referências" deste Drive (achada ou criada na primeira coleção). */
    referenciasPastaId: text(),
    criadoEm: agora(),
    atualizadoEm: agora(),
  },
  (t) => [
    index("contas_google_usuario_idx").on(t.usuarioId),
    uniqueIndex("contas_google_login_idx")
      .on(t.usuarioId)
      .where(sql`${t.loginPermitido}`),
  ],
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
  /** De onde veio o pedido (revisão A6): IP e, na Vercel, cidade e país aproximados. Some com o código. */
  pedidoIp: text(),
  pedidoCidade: text(),
  pedidoPais: text(),
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

/**
 * Aparelhos (navegadores) que já entraram em cada conta, para o aviso de entrada nova (lib/auth/aparelho.ts).
 * O cookie `sd_aparelho` leva só um id aleatório assinado; aqui fica só o sha256 dele, sem nome, sistema nem lugar.
 * Sai depois de 400 dias sem uso (a vida do cookie) e junto com a conta.
 */
export const aparelhos = pgTable(
  "aparelhos",
  {
    id: text().primaryKey(),
    usuarioId: text()
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    aparelhoHash: text().notNull(),
    criadoEm: agora(),
    vistoEm: agora(),
  },
  (t) => [uniqueIndex("aparelhos_usuario_aparelho_idx").on(t.usuarioId, t.aparelhoHash)],
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
/** Formatos de "Baixar como…" (src/referencias/formatos.js no computador; o original não entra, ele sempre vai). */
export type FormatoReferencia = "mp4" | "mp4-1080" | "mp4-720" | "mp3-320" | "wav" | "m4a" | "jpg";

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
    /** "Também salvar como" (MP3 320, WAV…): o computador salva esses formatos ao lado do original. */
    formatos: jsonb().$type<FormatoReferencia[]>(),
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

// ───── Acompanhar pelo celular (docs/CONTAS.md §9) ─────

/**
 * O andamento das transferências de cada computador (o app manda a cada ~10 s enquanto algo anda).
 * Uma linha por sessão de dispositivo: some junto com a sessão (desconectar, trocar a senha, apagar a conta)
 * e quando fica 7 dias sem notícia.
 */
/**
 * "Entre computadores" (docs/LAN.md): cada app de computador com a recepção ligada avisa onde está na rede (endereços
 * e porta) e a chave de recepção dele, cifrada com SOBEDESCE_KEY. Os outros computadores da mesma conta leem para
 * mandar arquivos direto pela rede. Some com a sessão (cascade) ou quando o app desliga a recepção.
 */
export const lanPresenca = pgTable(
  "lan_presenca",
  {
    sessaoId: text()
      .primaryKey()
      .references(() => sessoes.id, { onDelete: "cascade" }),
    usuarioId: text()
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    /** IPs da rede local (privados), em ordem de preferência. */
    enderecos: jsonb().$type<string[]>().notNull(),
    porta: integer().notNull(),
    /** Chave de recepção (32 bytes base64url), selada (AES-256-GCM) com o contexto "lan_presenca.chave:<sessaoId>". */
    chaveEnc: text().notNull(),
    /** Chave pública X25519 (base64url): pessoas de outras contas cifram para ela (só este computador abre). */
    chavePublica: text(),
    /** Aceita envio de outras contas na mesma rede (sempre pedindo para aceitar na tela). */
    aceitaOutros: boolean().notNull().default(false),
    /** A rede de onde avisou: HMAC do IP público (IPv6: o /64). Quem vem da mesma rede vê como "por perto". O IP não fica guardado. */
    rede: text(),
    atualizadoEm: agora(),
  },
  (t) => [index("lan_presenca_usuario_idx").on(t.usuarioId), index("lan_presenca_rede_idx").on(t.rede)],
);

/**
 * Celular ↔ computador pelo Wi-Fi (docs/CELULAR-WIFI.md): quem está com o app aberto agora (a espera longa marca),
 * de que tipo e em qual rede (HMAC do IP público, como em lan_presenca). Online = visto há menos de 70 s.
 */
export type TipoAparelhoP2p = "celular" | "computador";
export const p2pAparelhos = pgTable(
  "p2p_aparelhos",
  {
    sessaoId: text()
      .primaryKey()
      .references(() => sessoes.id, { onDelete: "cascade" }),
    usuarioId: text()
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    tipo: text().$type<TipoAparelhoP2p>().notNull(),
    nome: text().notNull(),
    rede: text(),
    /** Aceita pedidos de outras contas na mesma rede (sempre perguntando antes). */
    aceitaOutros: boolean().notNull().default(false),
    vistoEm: agora(),
  },
  (t) => [index("p2p_aparelhos_usuario_idx").on(t.usuarioId, t.vistoEm), index("p2p_aparelhos_rede_idx").on(t.rede, t.vistoEm)],
);

/** Sinais WebRTC entre dois aparelhos (oferta e resposta inteiras, sem trickle). Valem 2 minutos. */
export type TipoSinalP2p = "oferta" | "resposta" | "recusa" | "cancela";
export type ResumoP2p = { arquivos: number; bytes: number; nomes: string[] };
export const p2pSinais = pgTable(
  "p2p_sinais",
  {
    id: text().primaryKey(),
    /** Conta de quem mandou. */
    usuarioId: text()
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    /** Conta de quem recebe (outra, quando é alguém por perto). */
    paraUsuario: text()
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    deSessao: text()
      .notNull()
      .references(() => sessoes.id, { onDelete: "cascade" }),
    paraSessao: text()
      .notNull()
      .references(() => sessoes.id, { onDelete: "cascade" }),
    tipo: text().$type<TipoSinalP2p>().notNull(),
    /** Nos tipos que respondem a uma oferta: o id dela. */
    oferta: text(),
    sdp: text(),
    resumo: jsonb().$type<ResumoP2p>(),
    motivo: text(),
    criadoEm: agora(),
    entregueEm: quando(),
  },
  (t) => [index("p2p_sinais_para_idx").on(t.paraSessao, t.entregueEm), index("p2p_sinais_criado_idx").on(t.criadoEm)],
);

export const dispositivoStatus = pgTable(
  "dispositivo_status",
  {
    sessaoId: text()
      .primaryKey()
      .references(() => sessoes.id, { onDelete: "cascade" }),
    usuarioId: text()
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    snapshot: jsonb().$type<StatusComputador>().notNull(),
    /** Último aviso no celular: "<rodada>:<estado>". Um fim de lote = um aviso. */
    avisado: text(),
    atualizadoEm: agora(),
  },
  (t) => [index("dispositivo_status_usuario_idx").on(t.usuarioId), index("dispositivo_status_atualizado_idx").on(t.atualizadoEm)],
);

/** Inscrições de Web Push do celular ("Avisar no celular quando terminar"). */
export const pushInscricoes = pgTable(
  "push_inscricoes",
  {
    id: text().primaryKey(),
    usuarioId: text()
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    /** URL do serviço de push do navegador (Apple, Google, Mozilla, Microsoft). */
    endpoint: text().notNull().unique(),
    keys: jsonb().$type<{ p256dh: string; auth: string }>().notNull(),
    criadoEm: agora(),
    ultimoEnvioEm: quando(),
    /** Falhas seguidas (rede, 5xx). 404/410 apagam na hora; muitas falhas seguidas também. */
    falhas: integer().notNull().default(0),
  },
  (t) => [index("push_inscricoes_usuario_idx").on(t.usuarioId)],
);

// ───── Uso da plataforma, para o admin (docs/CONTAS.md §10) ─────

/**
 * Em que dias cada pessoa usou a SOBEDESCE e por onde (site, celular instalado, computador). Uma linha por pessoa e dia,
 * gravada junto com o ultimoUsoEm da sessão (no máximo a cada 10 minutos). Só datas: nada do que a pessoa fez.
 * Some depois de 400 dias e junto com a conta.
 */
export const atividadeDiaria = pgTable(
  "atividade_diaria",
  {
    usuarioId: text()
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    /** Dia no fuso de Fortaleza (o mesmo da tela de admin). */
    dia: date({ mode: "string" }).notNull(),
    site: boolean().notNull().default(false),
    celular: boolean().notNull().default(false),
    computador: boolean().notNull().default(false),
    ultimaEm: agora(),
    /** Por onde foi o último uso do dia. */
    ultimaOrigem: text().$type<"site" | "celular" | "computador">(),
  },
  (t) => [primaryKey({ columns: [t.usuarioId, t.dia] }), index("atividade_diaria_dia_idx").on(t.dia)],
);

/**
 * Números do dia de cada computador (src/engine/uso.js): quanto subiu e desceu, erros, maior arquivo e o tempo com
 * algo andando. Nunca nome de arquivo ou pasta. O app manda o total do dia; aqui fica o maior valor já recebido.
 * Some com a sessão do computador, depois de 400 dias e junto com a conta.
 */
export const usoDiario = pgTable(
  "uso_diario",
  {
    sessaoId: text()
      .notNull()
      .references(() => sessoes.id, { onDelete: "cascade" }),
    usuarioId: text()
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    /** Dia no fuso do computador. */
    dia: date({ mode: "string" }).notNull(),
    enviadosBytes: bigint({ mode: "number" }).notNull().default(0),
    baixadosBytes: bigint({ mode: "number" }).notNull().default(0),
    enviados: integer().notNull().default(0),
    baixados: integer().notNull().default(0),
    erros: integer().notNull().default(0),
    maiorArquivo: bigint({ mode: "number" }).notNull().default(0),
    msAtivo: bigint({ mode: "number" }).notNull().default(0),
    atualizadoEm: agora(),
  },
  (t) => [primaryKey({ columns: [t.sessaoId, t.dia] }), index("uso_diario_usuario_dia_idx").on(t.usuarioId, t.dia)],
);

/** Avisos por e-mail ao admin já mandados ("conta:<id>", "erros:<id>:<dia>"): um aviso por chave, nunca dois. */
export const avisosAdmin = pgTable("avisos_admin", {
  chave: text().primaryKey(),
  criadoEm: agora(),
});

/** Pedido de proxy (docs/CONTAS.md §11): o celular pede, o app do computador gera o proxy e a tira de quadros. */
export type StatusPedidoProxy = "pendente" | "gerando" | "pronto" | "erro";
/**
 * "proxy": a cópia leve e a tira de quadros. "frames": frames, takes e posts do vídeo final (docs/FRAMES.md).
 * "formato": a referência em outro formato, ao lado dela (MP3 320, WAV, MP4 720p…; docs/REFERENCIAS.md §7).
 */
export type TipoPedido = "proxy" | "frames" | "formato";
/** Ajustes de um pedido de Frames (o computador confere de novo antes de usar). */
export type AjustesFrames = {
  frames: { quantidade: number; formato: "jpg" | "png" | "tiff" };
  takes: { quantidade: number; duracao: number; formato: "original" | "9:16" | "4:5" | "1:1"; codec: "h264" | "prores"; audio: boolean } | null;
};
/** Ajustes de um pedido de formato. */
export type AjustesFormato = { formato: FormatoReferencia };
export type AjustesPedido = AjustesFrames | AjustesFormato;

export const pedidosProxy = pgTable(
  "pedidos_proxy",
  {
    id: text().primaryKey(),
    usuarioId: text()
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    contaGoogleId: text()
      .notNull()
      .references(() => contasGoogle.id, { onDelete: "cascade" }),
    /** Arquivo original no Drive. */
    fileId: text().notNull(),
    nome: text().notNull(),
    tamanho: bigint({ mode: "number" }),
    /** O que o computador faz: a cópia leve (padrão, também o que os apps antigos pegam) ou os Frames. */
    tipo: text().$type<TipoPedido>().notNull().default("proxy"),
    ajustes: jsonb().$type<AjustesPedido>(),
    status: text().$type<StatusPedidoProxy>().notNull().default("pendente"),
    erro: text(),
    /** O que o computador fez ("Proxy gerado", "Já tinha proxy: tira de quadros feita", "Já é leve"). */
    resultado: text(),
    proxyFileId: text(),
    /** Sessão (computador) que pegou o pedido. */
    dispositivoId: text(),
    criadoEm: agora(),
    atualizadoEm: agora(),
  },
  (t) => [index("pedidos_proxy_usuario_status_idx").on(t.usuarioId, t.status), index("pedidos_proxy_arquivo_idx").on(t.usuarioId, t.fileId)],
);
