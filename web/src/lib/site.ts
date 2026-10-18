/** Dados do site: endereço, contato, rotas e textos comuns. */

/** Endereço público do site (links do e-mail, URL do dispositivo, retorno do Google). */
export const SITE_OFICIAL = "https://sobedesce.com";

/**
 * Endereço antigo. Continua no ar e completo: apps de computador já instalados, o app do celular na Tela de Início
 * e as sessões de antes usam ele. O login com Google funciona nos dois (cada um tem o seu retorno cadastrado).
 */
export const SITE_ANTIGO = "https://sobedesce.vercel.app";

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

/** Origens que são o próprio site (o principal, o oficial e o antigo). */
export function origensDoSite(): string[] {
  return [...new Set([siteUrl(), SITE_OFICIAL, SITE_ANTIGO])];
}

/** A origem do pedido, se for uma das do site; senão o endereço principal. */
export function origemDoSite(origem?: string | null): string {
  return origem && origensDoSite().includes(origem) ? origem : siteUrl();
}

/**
 * Origem dos links que a pessoa leva para fora (link pra IA, atalho do iPhone): nunca o endereço antigo, mesmo
 * quando o pedido veio dele (app na Tela de Início instalado antes do domínio). Os links antigos continuam abrindo.
 */
export function origemPublica(origem?: string | null): string {
  const o = origemDoSite(origem);
  return o === SITE_ANTIGO ? siteUrl() : o;
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
export const LEGAL_ATUALIZADO_EM = "17 de outubro de 2026";

/** Instaladores do app de computador (as rotas redirecionam para o arquivo da versão atual). */
export const DOWNLOAD_MAC = "/baixar/mac";
export const DOWNLOAD_WINDOWS = "/baixar/windows";

/**
 * Instalar pelo Terminal (Mac) e pelo PowerShell (Windows): public/instalar.sh e public/instalar.ps1.
 * O arquivo baixado assim não ganha a marca de "veio da internet", então não aparece o aviso de app não verificado.
 * Sempre o endereço oficial (os scripts baixam dele), também nas prévias.
 */
export const INSTALAR_MAC = `curl -fsSL ${SITE_OFICIAL}/instalar.sh | bash`;
export const INSTALAR_WINDOWS = `irm ${SITE_OFICIAL}/instalar.ps1 | iex`;

export const ROTAS = {
  entrar: "/entrar",
  criarConta: "/criar-conta",
  celular: "/app/",
  privacidade: "/privacidade",
  termos: "/termos",
} as const;

export const SITE_DESCRICAO =
  "Transferências rápidas e retomáveis para o Google Drive, feitas para arquivos gigantes de audiovisual. Várias conexões em paralelo, pausa sem perder nada e cada arquivo conferido.";
