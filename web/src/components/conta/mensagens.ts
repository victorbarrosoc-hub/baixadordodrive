/** Textos dos `?erro=` que voltam do Google e do login. Frases curtas, sem alarme. */
export const ERROS_GOOGLE: Record<string, string> = {
  google_recusado:
    "Tudo bem, nada foi conectado. Se o Google disse que o acesso está bloqueado, seu e-mail ainda não foi liberado no teste: fale com o Victor.",
  google_outra_conta: "Esta conta do Google já está ligada a outra conta SOBEDESCE. Entre por ela, ou remova o Drive de lá primeiro.",
  google_sem_drive: "Faltou permitir o acesso ao Google Drive na tela do Google. Tente de novo e deixe essa opção marcada.",
  google_expirou: "A conexão com o Google demorou demais. Tente de novo.",
  google_erro: "O Google não completou a conexão. Tente de novo em instantes.",
  google_config: "O Google ainda não foi configurado neste servidor.",
};

export function mensagemDeErro(codigo: string | undefined): string | null {
  if (!codigo) return null;
  return ERROS_GOOGLE[codigo] ?? null;
}
