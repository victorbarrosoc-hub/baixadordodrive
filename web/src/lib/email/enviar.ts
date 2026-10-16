/**
 * E-mail transacional pelo Resend (POST https://api.resend.com/emails, sem SDK).
 * Variáveis: RESEND_API_KEY, EMAIL_REMETENTE (padrão "SOBEDESCE <nao-responda@dissesim.com.br>").
 * Sem chave: fora de produção o e-mail vai para o console e o fluxo segue; em produção não envia
 * (e nada do conteúdo vai para o log, porque pode levar link com token).
 * SOBEDESCE_RESEND_BASE troca a base só em teste local (mesma regra do Google falso).
 */

export const REMETENTE_PADRAO = "SOBEDESCE <nao-responda@dissesim.com.br>";

export type Email = { para: string; assunto: string; html: string; texto: string };
export type ResultadoEnvio = { ok: true; via: "resend" | "console" } | { ok: false; motivo: "sem_config" | "falhou" };

function producao(): boolean {
  return process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
}

/** Base do Resend falso: só fora de produção e só em 127.0.0.1/localhost. */
export function baseResendDeTeste(): string | null {
  const base = process.env.SOBEDESCE_RESEND_BASE;
  if (!base || producao()) return null;
  try {
    const u = new URL(base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Dá para mandar e-mail agora? (com chave, ou fora de produção, onde vai para o console) */
export function emailDisponivel(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim()) || !producao();
}

export async function enviarEmail(e: Email): Promise<ResultadoEnvio> {
  const chave = process.env.RESEND_API_KEY?.trim();
  if (!chave) {
    if (producao()) {
      console.warn("[email] RESEND_API_KEY ausente: e-mail não enviado.");
      return { ok: false, motivo: "sem_config" };
    }
    console.info(`\n[email de desenvolvimento] para ${e.para}\nAssunto: ${e.assunto}\n\n${e.texto}\n`);
    return { ok: true, via: "console" };
  }
  const base = baseResendDeTeste() ?? "https://api.resend.com";
  try {
    const res = await fetch(`${base}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${chave}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.EMAIL_REMETENTE?.trim() || REMETENTE_PADRAO,
        to: [e.para],
        subject: e.assunto,
        html: e.html,
        text: e.texto,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Só o status: o corpo pode repetir o conteúdo do e-mail.
      console.warn(`[email] Resend respondeu ${res.status}.`);
      return { ok: false, motivo: "falhou" };
    }
    return { ok: true, via: "resend" };
  } catch {
    console.warn("[email] Resend não respondeu.");
    return { ok: false, motivo: "falhou" };
  }
}
