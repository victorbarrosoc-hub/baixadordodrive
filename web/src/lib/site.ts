/** Dados do site: endereço, contato, rotas e textos comuns. */

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

export const SITE_NOME = "SOBEDESCE";

export const SITE_URL = siteUrl();

export const CONTATO_EMAIL = "contato@dissesim.com.br";

/** Data da última revisão da Política de Privacidade e dos Termos. */
export const LEGAL_ATUALIZADO_EM = "16 de outubro de 2026";

/** Instaladores do app de computador (as rotas redirecionam para o arquivo da versão atual). */
export const DOWNLOAD_MAC = "/baixar/mac";
export const DOWNLOAD_WINDOWS = "/baixar/windows";

export const ROTAS = {
  entrar: "/entrar",
  criarConta: "/criar-conta",
  celular: "/app/",
  privacidade: "/privacidade",
  termos: "/termos",
} as const;

export const SITE_DESCRICAO =
  "Transferências rápidas e retomáveis para o Google Drive, feitas para arquivos gigantes de audiovisual. Várias conexões em paralelo, pausa sem perder nada e cada arquivo conferido.";
