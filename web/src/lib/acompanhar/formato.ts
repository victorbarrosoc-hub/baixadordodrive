/**
 * Formato do andamento que o app de computador manda (docs/CONTAS.md §9): o que está passando, o total e o que já
 * passou. Validado aqui antes de ir para o banco: só campos conhecidos, textos curtos, listas com teto.
 * Sem "server-only": o schema do banco importa os tipos.
 */
import { z } from "zod";

export const ESTADOS = ["enviando", "baixando", "pausado", "parado", "concluido", "erro"] as const;
export type EstadoComputador = (typeof ESTADOS)[number];

export const ESTADOS_ITEM = ["enviando", "baixando", "conferindo", "na_fila", "esperando", "pausado"] as const;

/** Tamanho máximo do corpo do POST (bytes de texto JSON). */
export const LIMITE_BYTES = 64 * 1024;
export const MAX_ITENS = 60;
export const MAX_TERMINADOS = 40;
export const MAX_LOTES = 20;

const bytes = z.number().nonnegative().max(1e16);
const contagem = z.number().int().nonnegative().max(1e8);
const velocidade = z.number().nonnegative().max(1e12);
const texto = (max: number) => z.string().max(max);
const direcao = z.enum(["sobe", "desce"]);

const item = z.object({
  id: texto(120),
  nome: texto(300),
  direcao,
  feito: bytes,
  total: bytes.nullable(),
  velocidade,
  estado: z.enum(ESTADOS_ITEM),
  destino: texto(300).nullable().optional(),
  erro: texto(300).nullable().optional(),
  /** Lote (pedido) do app de computador. */
  lote: texto(120).optional(),
});

const terminado = z.object({
  nome: texto(300),
  direcao,
  total: bytes.nullable(),
  terminouEm: z.number().int().nonnegative(),
  ok: z.boolean(),
  erro: texto(300).nullable().optional(),
  lote: texto(120).optional(),
});

/** Um pedido (lote), como a tela Transferências do computador: "Pasta "ZRO" · 8 arquivos · 18,2 GB". */
const lote = z.object({
  id: texto(120),
  titulo: texto(300),
  direcao: z.enum(["sobe", "desce", "misto"]),
  destino: texto(300).nullable().optional(),
  arquivos: contagem,
  bytes,
  feitoBytes: bytes,
  andando: contagem,
  esperando: contagem,
  naFila: contagem,
  pausados: contagem,
  concluidos: contagem,
  cancelados: contagem,
  erros: contagem,
  conferidos: contagem,
  divergentes: contagem,
  velocidade,
  eta: z.number().nonnegative().max(1e9).nullable(),
  criadoEm: z.number().int().nonnegative(),
  terminouEm: z.number().int().nonnegative().nullable(),
});

const direcaoGeral = z.object({ arquivos: contagem, velocidade });

export const statusSchema = z.object({
  v: z.literal(1),
  estado: z.enum(ESTADOS),
  /** Rodada de trabalho (começa quando algo anda depois de tudo parado): um aviso por rodada e estado. */
  rodada: texto(80).nullable(),
  geral: z.object({
    feitoBytes: bytes,
    totalBytes: bytes,
    feitos: contagem,
    total: contagem,
    erros: contagem,
    velocidade,
    eta: z.number().nonnegative().max(1e9).nullable(),
    sobe: direcaoGeral,
    desce: direcaoGeral,
    /** Itens em andamento que não couberam na lista. */
    fora: contagem.optional(),
  }),
  itens: z.array(item).max(MAX_ITENS),
  terminados: z.array(terminado).max(MAX_TERMINADOS),
  /** Os pedidos (app de computador novo; o antigo não manda). */
  lotes: z.array(lote).max(MAX_LOTES).optional(),
  /** O app foi fechado (última notícia antes de sair). */
  fechado: z.boolean().optional(),
});

export type StatusComputador = z.infer<typeof statusSchema>;

export type Computador = {
  id: string;
  nome: string;
  plataforma: "mac" | "windows" | "linux" | null;
  online: boolean;
  atualizadoEm: number;
  snapshot: StatusComputador;
};

// ───── textos do aviso ─────

const NF0 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const NF01 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const UNIDADES = ["B", "KB", "MB", "GB", "TB", "PB"];

/** "412 GB", "1,5 GB" (decimal, como o app). */
export function tamanho(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return `${NF0.format(Math.max(0, n || 0))} B`;
  let i = 0;
  let v = n;
  while (v >= 999.95 && i < UNIDADES.length - 1) {
    v /= 1000;
    i++;
  }
  return `${(v >= 100 ? NF0 : NF01).format(v)} ${UNIDADES[i]}`;
}

function arquivos(n: number): string {
  return `${NF0.format(n)} ${n === 1 ? "arquivo" : "arquivos"}`;
}

/** Título e corpo da notificação de um fim de rodada (concluído ou parou com erro). */
export function textoDoAviso(s: StatusComputador, computador: string): { titulo: string; corpo: string } | null {
  const g = s.geral;
  if (s.estado === "concluido") {
    const n = g.feitos;
    const sobe = g.sobe.arquivos > 0;
    const desce = g.desce.arquivos > 0;
    const um = n === 1;
    const verbo = sobe && !desce ? (um ? "enviado do" : "enviados do") : desce && !sobe ? (um ? "baixado no" : "baixados no") : um ? "transferido no" : "transferidos no";
    return { titulo: "Pronto", corpo: `${arquivos(n)} ${verbo} ${computador} · ${tamanho(g.feitoBytes)}` };
  }
  if (s.estado === "erro") {
    const prontos = g.feitos > 0 ? ` ${NF0.format(g.feitos)} de ${NF0.format(g.total)} prontos.` : "";
    const verbo = g.erros === 1 ? "não passou" : "não passaram";
    return { titulo: "Parou com erro", corpo: `${arquivos(g.erros)} ${verbo} no ${computador}.${prontos}` };
  }
  return null;
}
