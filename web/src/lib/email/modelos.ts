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

/** Linha de detalhe ("Quando", "Navegador"): rótulo pequeno em cima, valor embaixo. */
type Detalhe = { rotulo: string; valor: string };

type Bloco = {
  titulo: string;
  paragrafos: string[];
  detalhes?: Detalhe[];
  /** Parágrafos depois dos detalhes. */
  depois?: string[];
  botao?: { texto: string; url: string };
  rodape?: string;
  previa: string;
};

/** Monta o HTML. Os textos chegam crus e são escapados aqui. */
export function moldura(b: Bloco): string {
  const paragrafo = (p: string) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:#3a3a3c;">${esc(p)}</p>`;
  const ps = b.paragrafos.map(paragrafo).join("");
  const detalhes = b.detalhes?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;border-top:1px solid rgba(60,60,67,0.12);">${b.detalhes
        .map(
          (d) => `<tr><td style="padding:12px 0;border-bottom:1px solid rgba(60,60,67,0.12);">
<p style="margin:0 0 2px;font-size:12px;line-height:1.4;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#8e8e93;">${esc(d.rotulo)}</p>
<p style="margin:0;font-size:16px;line-height:1.45;color:#1d1d1f;">${esc(d.valor)}</p>
</td></tr>`,
        )
        .join("")}</table>`
    : "";
  const ps2 = (b.depois ?? []).map(paragrafo).join("");
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
${ps}${detalhes}${ps2}${botao}${rodape}
</td></tr>
<tr><td style="padding:24px 8px 0;font-size:12px;line-height:1.5;color:#8e8e93;">Você recebeu este e-mail porque tem uma conta na SOBEDESCE. Não responda: ninguém lê esta caixa.</td></tr>
</table></td></tr></table></body></html>`;
}

function texto(b: Bloco): string {
  const linhas = ["SOBEDESCE", "", b.titulo, "", ...b.paragrafos.flatMap((p) => [p, ""])];
  if (b.detalhes?.length) linhas.push(...b.detalhes.map((d) => `${d.rotulo}: ${d.valor}`), "");
  linhas.push(...(b.depois ?? []).flatMap((p) => [p, ""]));
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

/** "17 de outubro de 2026 às 14:32" no horário de Brasília. */
export function quandoLegivel(d: Date): string {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(d);
}

/** Endereço de "Não fui eu" quando a pessoa ainda entra na conta: /conta com a orientação no alto. */
export const urlNaoFuiEu = () => `${siteUrl()}/conta?aviso=nao-fui-eu`;

export function emailComputadorConectado(
  para: string,
  nome: string,
  c: { computador: string; plataforma: string | null; quando: Date; onde?: string | null },
): Email {
  const quando = quandoLegivel(c.quando);
  const qual = c.plataforma && NOME_PLATAFORMA[c.plataforma] ? `${c.computador} (${NOME_PLATAFORMA[c.plataforma]})` : c.computador;
  return montar(para, "Um computador entrou na sua conta", {
    previa: `${qual}, ${quando}.`,
    titulo: "Computador conectado",
    paragrafos: [
      `Oi, ${primeiroNome(nome)}. ${qual} entrou na sua conta SOBEDESCE em ${quando} (horário de Brasília).`,
      c.onde ? `O pedido veio de perto de ${c.onde} (lugar aproximado, pela rede). Ele pode usar os Drives conectados à conta.` : "Ele pode usar os Drives conectados à conta.",
    ],
    botao: { texto: "Ver minha conta", url: `${siteUrl()}/conta` },
    rodape: "Se não foi você, desconecte o computador em Sua conta e troque a senha.",
  });
}

/** Mac com o Atualizar travado (lib/atualizar-mac.ts): instalar a versão nova uma vez, à mão. Sai pelo admin. */
export function emailAtualizarMac(para: string, nome: string, macs: string[]): Email {
  const qual = macs.length === 1 ? `no ${macs[0]}` : "nos seus Macs";
  return montar(para, "Atualize o SOBEDESCE no Mac (uma vez só)", {
    previa: "O botão Atualizar pode estar dando erro. Instalando a versão nova uma vez, ele volta a funcionar.",
    titulo: "Atualize o app no Mac",
    paragrafos: [
      `Oi, ${primeiroNome(nome)}. O botão Atualizar do SOBEDESCE ${qual} pode estar dando erro, com uma mensagem que começa com "ENOTEMPTY".`,
      "O erro é nosso e já foi corrigido. Para a correção chegar, instale a versão nova uma vez: baixe, abra o arquivo e arraste o SOBEDESCE para Aplicativos, escolhendo Substituir.",
    ],
    detalhes: macs.length > 1 ? [{ rotulo: "Computadores", valor: macs.join(", ") }] : undefined,
    depois: ["A conta, os ajustes e a fila continuam como estão. Depois disso, as próximas versões chegam sozinhas de novo."],
    botao: { texto: "Baixar para Mac", url: `${siteUrl()}/baixar/mac` },
    rodape: "Se o app já atualizou sem erro, pode ignorar este e-mail.",
  });
}

/** Entrou na conta num aparelho ou navegador que a conta ainda não tinha usado. */
export function emailEntradaNova(
  para: string,
  nome: string,
  e: { quando: Date; navegador: string | null; onde: string | null; via: "senha" | "google" },
): Email {
  const quando = quandoLegivel(e.quando);
  const detalhes = [
    { rotulo: "Quando", valor: `${quando} (horário de Brasília)` },
    { rotulo: "Navegador", valor: e.navegador ?? "Não deu para saber" },
    { rotulo: "Onde, mais ou menos", valor: e.onde ? `Perto de ${e.onde}` : "Não deu para saber" },
    { rotulo: "Como", valor: e.via === "google" ? "Com o Google de entrar" : "Com e-mail e senha" },
  ];
  return montar(para, "Entrada nova na sua conta", {
    previa: [e.navegador, e.onde, quando].filter(Boolean).join(" · "),
    titulo: "Entrada nova",
    paragrafos: [`Oi, ${primeiroNome(nome)}. A sua conta SOBEDESCE foi aberta num aparelho ou navegador que ela ainda não tinha usado.`],
    detalhes,
    depois: ["Se foi você, não precisa fazer nada. O lugar vem da rede e pode errar a cidade."],
    botao: { texto: "Não fui eu", url: urlNaoFuiEu() },
    rodape: "Não fui eu abre Sua conta com o passo a passo: trocar a senha tira da conta todos os outros aparelhos e os computadores. Se não conseguir entrar, use Esqueci a senha.",
  });
}

export type ComoMudouSenha = "trocada" | "redefinida" | "criada";

/** A senha mudou: trocada em Sua conta, redefinida pelo link ou criada pela primeira vez. */
export function emailSenhaMudou(para: string, nome: string, s: { quando: Date; como: ComoMudouSenha }): Email {
  const quando = quandoLegivel(s.quando);
  const oi = `Oi, ${primeiroNome(nome)}.`;
  const frase: Record<ComoMudouSenha, string> = {
    trocada: `${oi} A senha da sua conta SOBEDESCE foi trocada em ${quando} (horário de Brasília), na tela Sua conta.`,
    redefinida: `${oi} A senha da sua conta SOBEDESCE foi refeita em ${quando} (horário de Brasília), pelo link de Esqueci a senha.`,
    criada: `${oi} A sua conta SOBEDESCE ganhou uma senha em ${quando} (horário de Brasília). Agora dá para entrar também com e-mail e senha.`,
  };
  return montar(para, s.como === "criada" ? "Sua conta agora tem senha" : "A senha da sua conta mudou", {
    previa: `${s.como === "criada" ? "Senha criada" : "Senha nova"} em ${quando}.`,
    titulo: s.como === "criada" ? "Senha criada" : "Senha nova",
    paragrafos: [frase[s.como], "Os outros aparelhos e os computadores saíram da conta, e a chave do Atalho e os avisos no celular foram desligados."],
    botao: { texto: "Não fui eu", url: `${siteUrl()}/esqueci-a-senha` },
    rodape: "Se não foi você, use Esqueci a senha agora para criar outra. Depois, em Sua conta, confira o Google de entrar.",
  });
}

/** O Google que abre a conta mudou (`novo`) ou deixou de existir (`novo` null, `anterior` é o que saiu). */
export function emailGoogleDeEntrar(para: string, nome: string, g: { quando: Date; novo: string | null; anterior: string | null }): Email {
  const quando = quandoLegivel(g.quando);
  const oi = `Oi, ${primeiroNome(nome)}.`;
  if (g.novo) {
    return montar(para, "O Google de entrar mudou", {
      previa: `Agora ${g.novo} abre a sua conta.`,
      titulo: "Google de entrar trocado",
      paragrafos: [
        `${oi} Desde ${quando} (horário de Brasília), é o Google ${g.novo} que abre a sua conta SOBEDESCE.`,
        g.anterior ? `${g.anterior} continua conectado como Drive, mas não entra mais na conta.` : "E-mail e senha continuam valendo.",
      ],
      botao: { texto: "Não fui eu", url: urlNaoFuiEu() },
      rodape: "Se não foi você, troque a senha em Sua conta e escolha de novo o Google de entrar.",
    });
  }
  return montar(para, "Nenhum Google entra mais na sua conta", {
    previa: "Agora só e-mail e senha abrem a sua conta.",
    titulo: "Google de entrar removido",
    paragrafos: [
      `${oi} Desde ${quando} (horário de Brasília), ${g.anterior ? `o Google ${g.anterior}` : "o Google de entrar"} não abre mais a sua conta SOBEDESCE.`,
      "Agora só e-mail e senha abrem a conta.",
    ],
    botao: { texto: "Não fui eu", url: urlNaoFuiEu() },
    rodape: "Se não foi você, troque a senha em Sua conta. Se não conseguir entrar, use Esqueci a senha.",
  });
}

/** O limite de senhas erradas da conta (de qualquer rede) foi atingido. No máximo um por dia. */
export function emailMuitasTentativas(para: string, nome: string, t: { quando: Date; janelaMin: number }): Email {
  const quando = quandoLegivel(t.quando);
  const janela = t.janelaMin % 60 === 0 ? (t.janelaMin === 60 ? "uma hora" : `${t.janelaMin / 60} horas`) : `${t.janelaMin} minutos`;
  return montar(para, "Muitas senhas erradas na sua conta", {
    previa: "A entrada com senha ficou pausada por um tempo.",
    titulo: "Muitas senhas erradas",
    paragrafos: [`Oi, ${primeiroNome(nome)}. Alguém errou a senha da sua conta SOBEDESCE muitas vezes em pouco tempo.`],
    detalhes: [
      { rotulo: "Último erro", valor: `${quando} (horário de Brasília)` },
      { rotulo: "O que já fizemos", valor: `Pausamos a entrada com senha nesta conta. Ela volta sozinha em até ${janela}.` },
      { rotulo: "Se foi você", valor: "Espere um pouco ou use Esqueci a senha." },
      {
        rotulo: "Se não foi",
        valor: "Essas tentativas não abriram a conta; se alguém entrar, chega um aviso de entrada nova. Se a sua senha também serve em outro site, troque por uma só da SOBEDESCE.",
      },
    ],
    botao: { texto: "Abrir minha conta", url: `${siteUrl()}/conta` },
    rodape: "Mandamos este aviso no máximo uma vez por dia.",
  });
}

// ───── Para o admin (src/lib/email/admin.ts) ─────

/** Conta nova na plataforma (um aviso por conta). */
export function emailAdminContaNova(para: string, c: { nome: string; email: string; quando: Date; comGoogle: boolean }): Email {
  return montar(para, `Conta nova: ${c.nome}`, {
    previa: `${c.nome} (${c.email}) criou uma conta.`,
    titulo: "Conta nova na SOBEDESCE",
    paragrafos: [`${c.nome} criou uma conta em ${quandoLegivel(c.quando)} (horário de Brasília).`],
    detalhes: [
      { rotulo: "E-mail", valor: c.email },
      { rotulo: "Como entrou", valor: c.comGoogle ? "Continuar com Google" : "E-mail e senha" },
    ],
    botao: { texto: "Abrir o admin", url: `${siteUrl()}/admin` },
    rodape: "Aviso para os admins da SOBEDESCE (SOBEDESCE_ADMINS).",
  });
}

/** Muitas transferências com erro no mesmo dia (um aviso por pessoa e dia). Só números, nunca nome de arquivo. */
export function emailAdminErros(para: string, c: { nome: string; email: string; dia: string; erros: number; feitos: number; usuarioId: string }): Email {
  return montar(para, `${c.erros} erros hoje: ${c.nome}`, {
    previa: `${c.nome} teve ${c.erros} transferências com erro hoje.`,
    titulo: "Transferências com erro",
    paragrafos: [`${c.nome} (${c.email}) teve ${c.erros} transferências com erro no computador hoje, contra ${c.feitos} que terminaram bem.`],
    depois: ["Pode ser internet, disco cheio, Drive sem espaço ou um problema no app. Vale olhar a linha do tempo da pessoa."],
    botao: { texto: "Ver a pessoa no admin", url: `${siteUrl()}/admin/pessoa/${encodeURIComponent(c.usuarioId)}` },
    rodape: "Aviso para os admins da SOBEDESCE (SOBEDESCE_ADMINS). No máximo um por pessoa por dia.",
  });
}
