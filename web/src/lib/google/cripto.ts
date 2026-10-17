/**
 * Tokens do Google no banco: AES-256-GCM com SOBEDESCE_KEY (32 bytes em base64).
 * Formato "v1.<iv>.<cifra>.<tag>" (base64url). O AAD é o contexto ("contas_google.refresh:<id>"):
 * a cifra de uma linha não abre em outra.
 * Sem a chave em produção, só `selar`/`abrir` lançam (nada lança no import).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export class ChaveErrada extends Error {
  constructor() {
    super("Não deu para abrir o segredo (chave trocada ou dado adulterado).");
    this.name = "ChaveErrada";
  }
}

const CHAVE_DEV = "sobedesce-chave-so-para-desenvolvimento";

export function chaveConfigurada(): boolean {
  const v = process.env.SOBEDESCE_KEY;
  if (!v) return process.env.NODE_ENV !== "production";
  return Buffer.from(v, "base64").length === 32;
}

function chave(): Buffer {
  const v = process.env.SOBEDESCE_KEY;
  if (!v) {
    if (process.env.NODE_ENV === "production") throw new Error("Defina SOBEDESCE_KEY (openssl rand -base64 32) nas variáveis da Vercel.");
    return createHash("sha256").update(CHAVE_DEV).digest();
  }
  const k = Buffer.from(v, "base64");
  if (k.length !== 32) throw new Error("SOBEDESCE_KEY precisa ter 32 bytes em base64 (openssl rand -base64 32).");
  return k;
}

/** Chave derivada (HKDF) para outro uso, como o cookie do OAuth: trocar o uso não abre o outro. */
function chavePara(uso: string): Buffer {
  return Buffer.from(hkdfSync("sha256", chave(), Buffer.alloc(0), Buffer.from(`sobedesce:${uso}`, "utf8"), 32));
}

function cifrar(k: Buffer, texto: string, contexto: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  c.setAAD(Buffer.from(contexto, "utf8"));
  const cifra = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), cifra.toString("base64url"), c.getAuthTag().toString("base64url")].join(".");
}

function decifrar(k: Buffer, selado: string, contexto: string): string {
  const partes = String(selado ?? "").split(".");
  if (partes.length !== 4 || partes[0] !== "v1") throw new ChaveErrada();
  try {
    const [, iv, cifra, tag] = partes;
    const d = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64url"));
    d.setAAD(Buffer.from(contexto, "utf8"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(cifra, "base64url")), d.final()]).toString("utf8");
  } catch {
    throw new ChaveErrada();
  }
}

export function selar(texto: string, contexto: string): string {
  return cifrar(chave(), texto, contexto);
}

/** Chave trocada, contexto errado ou dado adulterado: ChaveErrada. */
export function abrir(selado: string, contexto: string): string {
  return decifrar(chave(), selado, contexto);
}

/** Cookie do OAuth (state + PKCE): cifrado e autenticado com a chave derivada "oauth". */
export function selarCookie(texto: string, contexto: string): string {
  return cifrar(chavePara("oauth"), texto, contexto);
}

export function abrirCookie(selado: string, contexto: string): string {
  return decifrar(chavePara("oauth"), selado, contexto);
}

/**
 * Assinatura curta (HMAC-SHA256 com a chave derivada do `uso`, 128 bits em base64url) para valores que só precisam
 * provar que saíram daqui, como o cookie de aparelho. Sem a chave em produção, lança (quem chama decide o que fazer).
 */
export function assinar(texto: string, uso: string): string {
  return createHmac("sha256", chavePara(uso)).update(texto, "utf8").digest().subarray(0, 16).toString("base64url");
}

export function assinaturaConfere(texto: string, assinatura: string, uso: string): boolean {
  const esperada = Buffer.from(assinar(texto, uso));
  const veio = Buffer.from(String(assinatura ?? ""));
  return veio.length === esperada.length && timingSafeEqual(veio, esperada);
}
