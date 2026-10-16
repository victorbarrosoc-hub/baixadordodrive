/** Dados do site público (home e páginas legais). */

export const SITE_NOME = "SOBEDESCE";

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://sobedesce.vercel.app";

// A confirmar com o Victor
export const CONTATO_EMAIL = "contato@dissesim.com.br";

/** Data da última revisão da Política de Privacidade e dos Termos. */
export const LEGAL_ATUALIZADO_EM = "16 de outubro de 2026";

/** Instaladores do app de computador (as rotas redirecionam para o arquivo da versão atual). */
export const DOWNLOAD_MAC = "/baixar/mac";
export const DOWNLOAD_WINDOWS = "/baixar/windows";

export const ROTAS = {
  entrar: "/entrar",
  criarConta: "/criar-conta",
  celular: "/app",
  privacidade: "/privacidade",
  termos: "/termos",
} as const;

export const SITE_DESCRICAO =
  "Transferências rápidas e retomáveis para o Google Drive, feitas para arquivos gigantes de audiovisual. Várias conexões em paralelo, pausa sem perder nada e cada arquivo conferido.";
