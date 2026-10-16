/**
 * Senhas com scrypt (node:crypto), sal aleatório por senha.
 * Formato guardado: scrypt$N$r$p$sal$hash (sal e hash em base64url).
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

export { SENHA_MAXIMA, SENHA_MINIMA } from "./senha-regras";

const N = 32768;
const R = 8;
const P = 1;
const TAMANHO = 64;

function scrypt(senha: string, sal: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const opcoes: ScryptOptions = { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 };
  return new Promise((ok, falha) => scryptCb(senha.normalize("NFKC"), sal, TAMANHO, opcoes, (e, chave) => (e ? falha(e) : ok(chave))));
}

export async function hashSenha(senha: string): Promise<string> {
  const sal = randomBytes(16);
  const hash = await scrypt(senha, sal, N, R, P);
  return ["scrypt", N, R, P, sal.toString("base64url"), hash.toString("base64url")].join("$");
}

/** Confere em tempo constante. Formato desconhecido: false. */
export async function conferirSenha(senha: string, guardado: string): Promise<boolean> {
  const partes = guardado.split("$");
  if (partes.length !== 6 || partes[0] !== "scrypt") return false;
  const [n, r, p] = partes.slice(1, 4).map(Number);
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0) || n > 1 << 20 || r > 32 || p > 16) return false;
  const sal = Buffer.from(partes[4], "base64url");
  const esperado = Buffer.from(partes[5], "base64url");
  if (esperado.length !== TAMANHO) return false;
  const calculado = await scrypt(senha, sal, n, r, p);
  return timingSafeEqual(calculado, esperado);
}

/** Hash de uma senha que não existe: o login gasta o mesmo tempo com e-mail desconhecido. */
let falso: Promise<string> | null = null;
export function hashDeEnfeite(): Promise<string> {
  falso ??= hashSenha(randomBytes(16).toString("base64url"));
  return falso;
}
