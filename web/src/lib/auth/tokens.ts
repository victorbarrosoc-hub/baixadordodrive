/** Identificadores e tokens aleatórios. O banco guarda só o sha256 dos tokens. */
import { createHash, randomBytes } from "node:crypto";

/** Id de linha: 16 caracteres base64url (96 bits). */
export function novoId(): string {
  return randomBytes(12).toString("base64url");
}

/** Token de sessão: 32 bytes em base64url (43 caracteres). */
export function novoToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export const PREFIXO_DISPOSITIVO = "sdd_";

/** sdd_ + 43 caracteres base64url. */
export const FORMATO_TOKEN_DISPOSITIVO = /^sdd_[A-Za-z0-9_-]{43}$/;
export const FORMATO_TOKEN_WEB = /^[A-Za-z0-9_-]{43}$/;
