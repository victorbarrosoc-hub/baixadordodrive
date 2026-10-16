/**
 * Erros do Google num formato só. Nada aqui guarda corpo de resposta nem token:
 * `redigir` apaga o que for segredo antes de qualquer texto sair daqui.
 */

export type MotivoGoogle =
  | "sem_config" // faltam GOOGLE_CLIENT_ID/SECRET
  | "reconectar" // invalid_grant (refresh vencido ou revogado) ou chave trocada
  | "rede" // sem resposta
  | "google"; // o resto

export class GoogleError extends Error {
  status: number;
  motivo: MotivoGoogle;
  constructor(motivo: MotivoGoogle, status = 0, detalhe?: string) {
    super(detalhe ? `${motivo}: ${redigir(detalhe)}` : motivo);
    this.name = "GoogleError";
    this.motivo = motivo;
    this.status = status;
  }
}

/** Resposta de erro do OAuth ({ error, error_description }) → GoogleError. */
export function deResposta(status: number, json: unknown): GoogleError {
  const corpo = (json ?? {}) as { error?: unknown };
  const codigo = typeof corpo.error === "string" ? corpo.error : `HTTP ${status}`;
  if (codigo === "invalid_grant") return new GoogleError("reconectar", status, codigo);
  return new GoogleError("google", status, codigo);
}

/** Apaga segredo de qualquer texto: Bearer, code, tokens. */
export function redigir(texto: string): string {
  return String(texto ?? "")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer …")
    .replace(/([?&]code=)[^&\s"']+/gi, "$1…")
    .replace(/(refresh_token|access_token|id_token|client_secret|code_verifier)(["']?\s*[:=]\s*["']?)[^&\s"',}]+/gi, "$1$2…")
    .replace(/ya29\.[A-Za-z0-9._-]+/g, "ya29.…")
    .replace(/1\/\/[A-Za-z0-9._-]+/g, "1//…")
    .slice(0, 300);
}
