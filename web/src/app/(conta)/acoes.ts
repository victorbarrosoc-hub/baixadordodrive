"use server";
/**
 * Server Actions das telas de conta. Toda ação que muda algo confere a origem
 * (além da conferência do próprio Next) e a sessão; a lógica fica em src/lib.
 */
import { refresh } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { apagarCookieSessao, gravarCookieSessao, ipAtual, origemDaAcaoConfere, usuarioAtual } from "@/lib/auth/atual";
import { apagarConta } from "@/lib/auth/apagar";
import { criarConta, entrarComSenha, trocarNome, trocarSenha } from "@/lib/auth/contas";
import { dentroDoLimite, MENSAGEM_LIMITE, REGRAS, registrarTentativa } from "@/lib/auth/limite";
import { COOKIE_SESSAO, revogarDispositivo, revogarPorToken } from "@/lib/auth/sessao";
import { pedirRedefinicao, redefinirSenha } from "@/lib/auth/redefinir";
import { voltaSegura } from "@/lib/auth/volta";
import { aprovar, buscarPedido, cancelar, normalizarCodigo } from "@/lib/dispositivo";
import { avisarComputadorConectado } from "@/lib/email/avisos";
import { removerConta } from "@/lib/google/contas";

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
  const r = await entrarComSenha({ email: texto(fd, "email"), senha: texto(fd, "senha"), ip: await ipAtual() });
  if (!r.ok) return { erro: r.mensagem, valores: { email: texto(fd, "email") } };
  await gravarCookieSessao(r.token);
  redirect(voltaSegura(texto(fd, "volta")));
}

export async function acaoCriarConta(_: EstadoForm, fd: FormData): Promise<EstadoForm> {
  if (!(await origemDaAcaoConfere())) return RECUSADO;
  const r = await criarConta({ nome: texto(fd, "nome"), email: texto(fd, "email"), senha: texto(fd, "senha"), ip: await ipAtual() });
  if (!r.ok) return { erro: r.mensagem, campo: r.campo, valores: { nome: texto(fd, "nome"), email: texto(fd, "email") } };
  await gravarCookieSessao(r.token);
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
  });
  if (!r.ok) return { erro: r.mensagem, campo: r.campo };
  refresh();
  return { ok: "Senha trocada. Os outros aparelhos saíram da conta." };
}

export async function acaoRemoverDrive(contaId: string): Promise<EstadoForm> {
  const atual = await sessaoDoSite();
  if (!atual) return RECUSADO;
  await removerConta(atual.usuario.id, String(contaId));
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
  after(() => avisarComputadorConectado(usuarioId, { nome: pedido.nome, plataforma: pedido.plataforma }));
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
  const r = await redefinirSenha({ token: texto(fd, "token"), senha: texto(fd, "senha") });
  if (!r.ok) return { erro: r.mensagem, campo: r.campo };
  await gravarCookieSessao(r.token);
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
