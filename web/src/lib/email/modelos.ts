/**
 * Os e-mails da SOBEDESCE: HTML simples (preto e branco, uma pílula) + versão texto.
 * Tabelas e estilos em linha: é o que os programas de e-mail entendem.
 */
import { CONTATO_EMAIL, siteUrl } from "@/lib/site";
import type { Email } from "./enviar";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const FONTE = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Helvetica,Arial,sans-serif";

type Bloco = { titulo: string; paragrafos: string[]; botao?: { texto: string; url: string }; rodape?: string; previa: string };

/** Monta o HTML. Os textos chegam crus e são escapados aqui. */
export function moldura(b: Bloco): string {
  const ps = b.paragrafos
    .map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:#3a3a3c;">${esc(p)}</p>`)
    .join("");
  const botao = b.botao
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 8px;"><tr><td style="border-radius:999px;background:#0b0b0c;">
<a href="${esc(b.botao.url)}" style="display:inline-block;padding:14px 26px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px;">${esc(b.botao.texto)}</a>
</td></tr></table>
<p style="margin:16px 0 0;font-size:13px;line-height:1.5;color:#8e8e93;word-break:break-all;">Se o botão não abrir, copie este endereço:<br>${esc(b.botao.url)}</p>`
    : "";
  const rodape = b.rodape ? `<p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#8e8e93;">${esc(b.rodape)}</p>` : "";
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(b.titulo)}</title></head>
<body style="margin:0;padding:0;background:#fbfbfd;font-family:${FONTE};color:#1d1d1f;">
<div style="display:none;max-height:0;overflow:hidden;">${esc(b.previa)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbfbfd;"><tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
<tr><td style="padding:0 8px 28px;font-size:13px;font-weight:600;letter-spacing:0.18em;color:#1d1d1f;">SOBEDESCE</td></tr>
<tr><td style="background:#ffffff;border:1px solid rgba(60,60,67,0.12);border-radius:20px;padding:36px 32px;">
<h1 style="margin:0 0 20px;font-size:26px;line-height:1.2;font-weight:600;letter-spacing:-0.02em;color:#1d1d1f;">${esc(b.titulo)}</h1>
${ps}${botao}${rodape}
</td></tr>
<tr><td style="padding:24px 8px 0;font-size:12px;line-height:1.5;color:#8e8e93;">Você recebeu este e-mail porque tem uma conta na SOBEDESCE. Não responda: ninguém lê esta caixa.</td></tr>
</table></td></tr></table></body></html>`;
}

function texto(b: Bloco): string {
  const linhas = ["SOBEDESCE", "", b.titulo, "", ...b.paragrafos.flatMap((p) => [p, ""])];
  if (b.botao) linhas.push(`${b.botao.texto}: ${b.botao.url}`, "");
  if (b.rodape) linhas.push(b.rodape, "");
  linhas.push("Você recebeu este e-mail porque tem uma conta na SOBEDESCE. Não responda: ninguém lê esta caixa.");
  return linhas.join("\n");
}

function montar(para: string, assunto: string, b: Bloco): Email {
  return { para, assunto, html: moldura(b), texto: texto(b) };
}

const primeiroNome = (nome: string) => nome.trim().split(/\s+/)[0] || "olá";

export function emailEsqueciSenha(para: string, nome: string, token: string): Email {
  const url = `${siteUrl()}/nova-senha?token=${encodeURIComponent(token)}`;
  return montar(para, "Criar uma senha nova", {
    previa: "O link vale por 1 hora e funciona uma vez.",
    titulo: "Senha nova",
    paragrafos: [`Oi, ${primeiroNome(nome)}. Alguém pediu para trocar a senha da sua conta SOBEDESCE.`, "O link abaixo vale por 1 hora e funciona uma vez."],
    botao: { texto: "Criar senha nova", url },
    rodape: "Se não foi você, ignore este e-mail. A sua senha continua a mesma.",
  });
}

/** Primeira senha de uma conta criada pelo Google (revisão A5): só pelo e-mail, nunca só com a sessão aberta. */
export function emailPrimeiraSenha(para: string, nome: string, token: string): Email {
  const url = `${siteUrl()}/nova-senha?token=${encodeURIComponent(token)}`;
  return montar(para, "Criar a senha da sua conta", {
    previa: "O link vale por 1 hora e funciona uma vez.",
    titulo: "Criar senha",
    paragrafos: [
      `Oi, ${primeiroNome(nome)}. Você pediu para criar uma senha na sua conta SOBEDESCE, para entrar também com o e-mail.`,
      "O link abaixo vale por 1 hora e funciona uma vez. Ao salvar, os outros aparelhos e os computadores saem da conta.",
    ],
    botao: { texto: "Criar senha", url },
    rodape: "Se não foi você, ignore este e-mail e entre com o Google para conferir a sua conta.",
  });
}

export function emailContaApagada(para: string, nome: string): Email {
  return montar(para, "Sua conta foi apagada", {
    previa: "A conta, os Drives conectados e os computadores saíram da SOBEDESCE.",
    titulo: "Conta apagada",
    paragrafos: [
      `Oi, ${primeiroNome(nome)}. A sua conta SOBEDESCE foi apagada agora.`,
      "Desconectamos os seus Drives, tiramos os computadores da conta e apagamos os seus dados. Os arquivos no Google Drive continuam lá.",
    ],
    rodape: `Se não foi você, escreva para ${CONTATO_EMAIL} o quanto antes.`,
  });
}

const NOME_PLATAFORMA: Record<string, string> = { mac: "Mac", windows: "Windows", linux: "Linux" };

export function emailComputadorConectado(para: string, nome: string, c: { computador: string; plataforma: string | null; quando: Date }): Email {
  const quando = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(c.quando);
  const qual = c.plataforma && NOME_PLATAFORMA[c.plataforma] ? `${c.computador} (${NOME_PLATAFORMA[c.plataforma]})` : c.computador;
  return montar(para, "Um computador entrou na sua conta", {
    previa: `${qual}, ${quando}.`,
    titulo: "Computador conectado",
    paragrafos: [`Oi, ${primeiroNome(nome)}. ${qual} entrou na sua conta SOBEDESCE em ${quando} (horário de Brasília).`, "Ele pode usar os Drives conectados à conta."],
    botao: { texto: "Ver minha conta", url: `${siteUrl()}/conta` },
    rodape: "Se não foi você, desconecte o computador em Sua conta e troque a senha.",
  });
}
