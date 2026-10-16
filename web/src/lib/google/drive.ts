/**
 * Drive v3 pelo servidor, com o token guardado da conta Google da pessoa (src/lib/google/contas.ts).
 * Usado pelas Referências: criar, renomear e pôr na lixeira as pastas das coleções e listar o que o computador
 * salvou nelas (página pública do "link pra IA"). Nada de bytes de arquivo passa por aqui, só metadados.
 */
import { endpoints } from "./config";
import { tokenDeAcesso } from "./contas";

export const PASTA_MIME = "application/vnd.google-apps.folder";

/** Erro da API do Drive. `status` 0 = sem resposta. O texto nunca leva token. */
export class ErroDrive extends Error {
  constructor(
    public status: number,
    public motivo: string | null = null,
  ) {
    super(`drive ${status}${motivo ? ` ${motivo}` : ""}`);
    this.name = "ErroDrive";
  }
}

type Opcoes = { method?: string; query?: Record<string, string | number | boolean | undefined>; body?: unknown };

/** Escapa um texto para dentro de aspas simples na linguagem de busca do Drive. */
export function aspas(s: string): string {
  return `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Uma chamada ao Drive como a conta `contaId` do usuário. 401 do Google → renova o token e tenta uma vez de novo.
 * Erros da conta (reconectar, sem_config...) saem como ErroConta; os do Drive como ErroDrive.
 */
export async function chamarDrive<T = Record<string, unknown>>(usuarioId: string, contaId: string, caminho: string, o: Opcoes = {}): Promise<T> {
  const url = new URL(endpoints().drive + caminho);
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  url.searchParams.set("supportsAllDrives", "true");
  for (let tentativa = 0; ; tentativa++) {
    const { accessToken } = await tokenDeAcesso(usuarioId, contaId, { renovar: tentativa > 0 });
    let res: Response;
    try {
      res = await fetch(url, {
        method: o.method ?? "GET",
        headers: { Authorization: `Bearer ${accessToken}`, ...(o.body !== undefined ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ErroDrive(0, "rede");
    }
    if (res.status === 401 && tentativa === 0) continue;
    if (res.status === 204) return null as T;
    const texto = await res.text();
    let json: unknown = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch {
      // HTML de erro
    }
    if (!res.ok) {
      const e = (json as { error?: { errors?: { reason?: string }[]; status?: string } } | null)?.error;
      throw new ErroDrive(res.status, e?.errors?.[0]?.reason ?? e?.status ?? null);
    }
    return json as T;
  }
}

export type ArquivoDrive = {
  id: string;
  name: string;
  mimeType: string;
  description?: string;
  appProperties?: Record<string, string>;
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  trashed?: boolean;
  permissionIds?: string[];
  webViewLink?: string;
  videoMediaMetadata?: { durationMillis?: string };
  imageMediaMetadata?: { width?: number; height?: number };
};

/** Lista tudo de uma consulta (até `maxPaginas` páginas de 1000). */
export async function listarTudo(usuarioId: string, contaId: string, q: string, campos: string, extra: Record<string, string> = {}, maxPaginas = 5): Promise<ArquivoDrive[]> {
  const out: ArquivoDrive[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < maxPaginas; i++) {
    const r = await chamarDrive<{ files?: ArquivoDrive[]; nextPageToken?: string }>(usuarioId, contaId, "/files", {
      query: { q, fields: `nextPageToken,files(${campos})`, pageSize: 1000, includeItemsFromAllDrives: true, pageToken, ...extra },
    });
    out.push(...(r.files ?? []));
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

export function criarPasta(usuarioId: string, contaId: string, nome: string, pai: string, marca: string): Promise<ArquivoDrive> {
  return chamarDrive<ArquivoDrive>(usuarioId, contaId, "/files", {
    method: "POST",
    query: { fields: "id,name" },
    body: { name: nome, mimeType: PASTA_MIME, parents: [pai], appProperties: { sobedesce: marca } },
  });
}

export function atualizarArquivo(usuarioId: string, contaId: string, id: string, mudancas: { name?: string; trashed?: boolean }): Promise<ArquivoDrive> {
  return chamarDrive<ArquivoDrive>(usuarioId, contaId, `/files/${encodeURIComponent(id)}`, { method: "PATCH", query: { fields: "id,name,trashed" }, body: mudancas });
}

export function lerArquivo(usuarioId: string, contaId: string, id: string, campos = "id,name,trashed"): Promise<ArquivoDrive> {
  return chamarDrive<ArquivoDrive>(usuarioId, contaId, `/files/${encodeURIComponent(id)}`, { query: { fields: campos } });
}
