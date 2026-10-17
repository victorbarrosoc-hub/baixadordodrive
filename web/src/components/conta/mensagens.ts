/** Textos dos `?erro=` que voltam do Google e do login. Frases curtas, sem alarme. */
export const ERROS_GOOGLE: Record<string, string> = {
  google_recusado: "Tudo bem, nada foi conectado.",
  google_email_em_uso: "Este e-mail já tem uma conta SOBEDESCE. Entre com a senha e conecte o Drive em Sua conta.",
  google_email_nao_verificado: "O Google não confirmou este e-mail. Use outra conta do Google ou crie a conta com e-mail e senha.",
  google_devagar: "Muitas contas criadas daqui agora há pouco. Espere alguns minutos e tente de novo.",
  google_outra_conta: "Esta conta do Google já está ligada a outra conta SOBEDESCE. Entre naquela conta e remova o Drive de lá primeiro.",
  google_nao_e_login:
    "Este Google está conectado como Drive numa conta SOBEDESCE, mas não é o Google de entrar dela. Entre com o e-mail e a senha, ou com o Google escolhido para entrar.",
  google_sem_drive: "Faltou permitir o acesso ao Google Drive na tela do Google. Tente de novo e deixe essa opção marcada.",
  google_expirou: "A conexão com o Google demorou demais. Tente de novo.",
  google_erro: "O Google não completou a conexão. Tente de novo em instantes.",
  google_config: "O Google ainda não foi configurado neste servidor.",
};

export function mensagemDeErro(codigo: string | undefined): string | null {
  if (!codigo) return null;
  return ERROS_GOOGLE[codigo] ?? null;
}
