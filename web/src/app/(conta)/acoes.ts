"use server";
/**
 * Server Actions das telas de conta. Toda ação que muda algo confere a origem
 * (além da conferência do próprio Next) e a sessão; a lógica fica em src/lib.
 */
import { refresh } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { apagarCookieSessao, gravarCookieSessao, ipAtual, marcarAparelho, origemDaAcaoConfere, usuarioAtual } from "@/lib/auth/atual";
import { apagarConta } from "@/lib/auth/apagar";
import { frase as fraseEncerrado } from "@/lib/auth/encerrar";
import { criarConta, entrarComSenha, trocarNome, trocarSenha } from "@/lib/auth/contas";
import { dentroDoLimite, MENSAGEM_LIMITE, REGRAS, registrarTentativa } from "@/lib/auth/limite";
import { COOKIE_SESSAO, revogarDispositivo, revogarPorToken, revogarSessaoDe } from "@/lib/auth/sessao";
import { pedirPrimeiraSenha, pedirRedefinicao, redefinirSenha } from "@/lib/auth/redefinir";
import { voltaSegura } from "@/lib/auth/volta";
import { depoisDaResposta } from "@/lib/depois";
import { aprovar, buscarPedido, cancelar, lugarLegivel, normalizarCodigo } from "@/lib/dispositivo";
import { avisarComputadorConectado } from "@/lib/email/avisos";
import { removerConta, trocarGoogleDeEntrar } from "@/lib/google/contas";
import { ehAdmin } from "@/lib/admin";
import { avisarMacsTravados } from "@/lib/atualizar-mac";
import { ehPlano, trocarPlano } from "@/lib/recursos";

export type EstadoForm = {
  erro?: string;
  campo?: string;
  ok?: string;
  /** Devolve o que a pessoa digitou (menos senha) para o formulário não esvaziar. */
  valores?: Record<string, string>;
} | null;

const RECUSADO: EstadoForm = { erro: "Pedido recusado. Recarregue a página e tente de novo." };
const texto = (fd: FormData, campo: string) => {
  const v = fd.get(campo);
  return typeof v === "string" ? v : "";
};

export async function acaoEntrar(_: EstadoForm, fd: FormData): Promise<EstadoForm> {
  if (!(await origemDaAcaoConfere())) return RECUSADO;
  const r = await entrarComSenha({ email: texto(fd, "email"), senha: texto(fd, "senha"), ip: await ipAtual(), depois: depoisDaResposta });
  if (!r.ok) return { erro: r.mensagem, valores: { email: texto(fd, "email") } };
  await gravarCookieSessao(r.token);
  await marcarAparelho(r.usuario.id, { via: "senha", avisar: true });
  redirect(voltaSegura(texto(fd, "volta")));
}

export async function acaoCriarConta(_: EstadoForm, fd: FormData): Promise<EstadoForm> {
  if (!(await origemDaAcaoConfere())) return RECUSADO;
  const r = await criarConta({ nome: texto(fd, "nome"), email: texto(fd, "email"), senha: texto(fd, "senha"), ip: await ipAtual(), depois: depoisDaResposta });
  if (!r.ok) return { erro: r.mensagem, campo: r.campo, valores: { nome: texto(fd, "nome"), email: texto(fd, "email") } };
  await gravarCookieSessao(r.token);
  await marcarAparelho(r.usuario.id, { via: "senha", avisar: false });
  redirect(voltaSegura(texto(fd, "volta")));
}

export async function acaoSair(): Promise<void> {
  if (await origemDaAcaoConfere()) {
    const token = (await cookies()).get(COOKIE_SESSAO)?.value;
    if (token) await revogarPorToken(token);
    await apagarCookieSessao();
  }
  redirect("/entrar");
}

/** Sessão do site para as ações da conta (o Bearer de computador não mexe na conta pelo site). */
async function sessaoDoSite() {
  if (!(await origemDaAcaoConfere())) return null;
  const atual = await usuarioAtual();
  return atual?.via === "cookie" ? atual : null;
}

export async function acaoTrocarNome(_: EstadoForm, fd: FormData): Promise<EstadoForm> {
  const atual = await sessaoDoSite();
  if (!atual) return RECUSADO;
  const r = await trocarNome(atual.usuario.id, texto(fd, "nome"));
  if (!r.ok) return { erro: r.mensagem, campo: r.campo };
  refresh();
  return { ok: "Nome salvo." };
}

export async function acaoTrocarSenha(_: EstadoForm, fd: FormData): Promise<EstadoForm> {
  const atual = await sessaoDoSite();
  if (!atual) return RECUSADO;
  const r = await trocarSenha({
    usuarioId: atual.usuario.id,
    sessaoId: atual.sessao.id,
    senhaAtual: texto(fd, "senhaAtual"),
    senhaNova: texto(fd, "senhaNova"),
    ip: await ipAtual(),
    links: texto(fd, "links") === "1",
    depois: depoisDaResposta,
  });
  if (!r.ok) return { erro: r.mensagem, campo: r.campo };
  refresh();
  return { ok: fraseEncerrado(r.encerrado, "Senha trocada") };
}

/** Conta criada pelo Google, ainda sem senha: a primeira senha sai por um link no e-mail (revisão A5). */
export async function acaoPedirPrimeiraSenha(): Promise<EstadoForm> {
  const atual = await sessaoDoSite();
  if (!atual) return RECUSADO;
  const r = await pedirPrimeiraSenha({ usuarioId: atual.usuario.id, ip: await ipAtual(), depois: (t) => after(t) });
  if (!r.ok) return { erro: r.mensagem };
  return { ok: r.mensagem };
}

/** O Google que entra na conta (revisão A3). Pede a senha atual. `conta` vazio = nenhum (só e-mail e senha). */
export async function acaoTrocarGoogleDeEntrar(_: EstadoForm, fd: FormData): Promise<EstadoForm> {
  const atual = await sessaoDoSite();
  if (!atual) return RECUSADO;
  const conta = texto(fd, "conta");
  const r = await trocarGoogleDeEntrar({ usuarioId: atual.usuario.id, contaId: conta || null, senhaAtual: texto(fd, "senhaAtual"), depois: depoisDaResposta });
  if (!r.ok) return { erro: r.mensagem, campo: r.campo };
  refresh();
  return { ok: r.conta ? `Pronto. Agora ${r.conta.email} entra na conta.` : "Pronto. Nenhum Google entra na conta: só e-mail e senha." };
}

export async function acaoRemoverDrive(contaId: string): Promise<EstadoForm> {
  const atual = await sessaoDoSite();
  if (!atual) return RECUSADO;
  const r = await removerConta(atual.usuario.id, String(contaId), depoisDaResposta);
  if (!r.ok && r.erro === "google_de_entrar") {
    return { erro: "É com este Google que você entra na conta. Crie uma senha antes de removê-lo." };
  }
  refresh();
  return { ok: "Drive removido." };
}

export async function acaoDesconectarComputador(sessaoId: string): Promise<EstadoForm> {
  const atual = await sessaoDoSite();
  if (!atual) return RECUSADO;
  await revogarDispositivo(atual.usuario.id, String(sessaoId));
  refresh();
  return { ok: "Computador desconectado." };
}

export async function acaoLiberarComputador(_: EstadoForm, fd: FormData): Promise<EstadoForm> {
  const atual = await sessaoDoSite();
  if (!atual) return RECUSADO;
  const codigo = normalizarCodigo(texto(fd, "codigo"));
  const chave = `disp-codigo:${await ipAtual()}`;
  if (!(await dentroDoLimite(chave, REGRAS.dispositivoCodigo))) return { erro: MENSAGEM_LIMITE };
  const pedido = codigo ? await buscarPedido(codigo) : null;
  if (!codigo || !pedido) {
    await registrarTentativa(chave);
    return { erro: "Este código venceu ou já foi usado. No computador, peça um novo." };
  }
  if (!(await aprovar(codigo, atual.usuario.id))) return { erro: "Este computador já foi liberado ou o código venceu." };
  const usuarioId = atual.usuario.id;
  const onde = lugarLegivel(pedido.lugar);
  depoisDaResposta(() => avisarComputadorConectado(usuarioId, { nome: pedido.nome, plataforma: pedido.plataforma, onde }));
  return { ok: "liberado" };
}

export async function acaoRecusarComputador(_: EstadoForm, fd: FormData): Promise<EstadoForm> {
  const atual = await sessaoDoSite();
  if (!atual) return RECUSADO;
  const codigo = normalizarCodigo(texto(fd, "codigo"));
  if (codigo) await cancelar(codigo);
  return { ok: "recusado" };
}

export async function acaoEsqueciSenha(_: EstadoForm, fd: FormData): Promise<EstadoForm> {
  if (!(await origemDaAcaoConfere())) return RECUSADO;
  const r = await pedirRedefinicao({ email: texto(fd, "email"), ip: await ipAtual(), depois: (t) => after(t) });
  if (!r.ok) return { erro: r.mensagem, campo: r.campo, valores: { email: texto(fd, "email") } };
  return { ok: r.mensagem };
}

export async function acaoNovaSenha(_: EstadoForm, fd: FormData): Promise<EstadoForm> {
  if (!(await origemDaAcaoConfere())) return RECUSADO;
  const r = await redefinirSenha({ token: texto(fd, "token"), senha: texto(fd, "senha"), depois: depoisDaResposta });
  if (!r.ok) return { erro: r.mensagem, campo: r.campo };
  await gravarCookieSessao(r.token);
  await marcarAparelho(r.usuario.id, { via: "senha", avisar: false });
  redirect("/conta?senha=nova");
}

export async function acaoApagarConta(_: EstadoForm, fd: FormData): Promise<EstadoForm> {
  const atual = await sessaoDoSite();
  if (!atual) return RECUSADO;
  const r = await apagarConta({ usuarioId: atual.usuario.id, senha: texto(fd, "senha"), palavra: texto(fd, "palavra"), depois: (t) => after(t) });
  if (!r.ok) return { erro: r.mensagem, campo: r.campo };
  await apagarCookieSessao();
  redirect("/?conta=apagada");
}

/** /admin: troca o plano de uma conta (só admin, pelo site, com a origem conferida). */
export async function acaoTrocarPlano(fd: FormData): Promise<void> {
  const atual = await sessaoDoSite();
  if (!atual || !(await ehAdmin(atual.usuario))) return;
  const usuarioId = texto(fd, "usuarioId");
  const plano = texto(fd, "plano");
  if (!usuarioId || !ehPlano(plano)) return;
  await trocarPlano(usuarioId, plano);
  refresh();
}

/** /admin/aviso-mac: manda o e-mail do Atualizar travado para quem tem Mac antes da correção e ainda não recebeu. */
export async function acaoAvisarMacs(): Promise<void> {
  const atual = await sessaoDoSite();
  if (!atual || !(await ehAdmin(atual.usuario))) return;
  const r = await avisarMacsTravados();
  redirect(`/admin/aviso-mac?enviados=${r.enviados}&falharam=${r.falharam}`);
}

/** Admin: desconecta um aparelho (computador ou navegador) de uma conta. A pessoa precisa entrar de novo nele. */
export async function acaoAdminDesconectar(fd: FormData): Promise<void> {
  const atual = await sessaoDoSite();
  if (!atual || !(await ehAdmin(atual.usuario))) return;
  const usuarioId = texto(fd, "usuarioId");
  const sessaoId = texto(fd, "sessaoId");
  if (!usuarioId || !sessaoId || sessaoId === atual.sessao.id) return;
  await revogarSessaoDe(usuarioId, sessaoId);
  refresh();
}
