/** Endereço público do site (links do e-mail, URL do dispositivo, retorno do Google). */
export const SITE_OFICIAL = "https://sobedesce.vercel.app";

export function siteUrl(): string {
  const v = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (v) {
    try {
      return new URL(v).origin;
    } catch {
      // valor inválido: cai no oficial
    }
  }
  return SITE_OFICIAL;
}

/**
 * Cookies com Secure fora do localhost (Safari não guarda cookie Secure em http://localhost).
 * `origem`: a origem do pedido (http.ts → origemDoPedido); sem ela, vale o endereço do site.
 */
export function cookieSeguro(origem?: string | null): boolean {
  try {
    const host = new URL(origem || siteUrl()).hostname;
    return !["localhost", "127.0.0.1", "[::1]"].includes(host);
  } catch {
    return true;
  }
}
