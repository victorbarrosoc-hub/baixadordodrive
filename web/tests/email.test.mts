/**
 * E-mail (Resend falso): esqueci a senha (resposta igual, limite, link de uso único, sessões encerradas),
 * apagar a conta (senha + APAGAR, revoga no Google, some tudo, confirmação) e o aviso de computador conectado.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { CONTA_ANA, CONTA_BETO, pedido, prepararAmbiente } from "./ambiente.mjs";
import type { ContaFalsa } from "./google-falso.mjs";

let amb: Awaited<ReturnType<typeof prepararAmbiente>>;
let contas: typeof import("../src/lib/auth/contas");
let redefinir: typeof import("../src/lib/auth/redefinir");
let apagar: typeof import("../src/lib/auth/apagar");
let sessao: typeof import("../src/lib/auth/sessao");
let enviar: typeof import("../src/lib/email/enviar");
let avisos: typeof import("../src/lib/email/avisos");
let eu: typeof import("../src/app/api/eu/route");

/** Tarefas que a ação deixaria para depois da resposta: aqui esperamos por elas. */
let pendentes: Promise<unknown>[] = [];
const depois = (t: () => Promise<unknown>) => void pendentes.push(t());
async function esperar() {
  await Promise.all(pendentes);
  pendentes = [];
}

before(async () => {
  amb = await prepararAmbiente();
  contas = await import("../src/lib/auth/contas");
  redefinir = await import("../src/lib/auth/redefinir");
  apagar = await import("../src/lib/auth/apagar");
  sessao = await import("../src/lib/auth/sessao");
  enviar = await import("../src/lib/email/enviar");
  avisos = await import("../src/lib/email/avisos");
  eu = await import("../src/app/api/eu/route");
});

after(async () => {
  await amb?.fechar();
});

const SENHA = "senha antiga comprida";

/** Cria a conta e espera o aviso de conta nova aos admins sair (assim ele não cai no meio da contagem de um teste). */
async function criar(email: string, ip: string, nome = "Victor Barroso") {
  const pendentes: Promise<unknown>[] = [];
  const r = await contas.criarConta({ nome, email, senha: SENHA, ip, depois: (t) => void pendentes.push(t()) });
  await Promise.all(pendentes);
  assert.ok(r.ok);
  return r;
}

function tokenDoEmail(texto: string): string {
  const m = /\/nova-senha\?token=([A-Za-z0-9_-]{43})/.exec(texto);
  assert.ok(m, "o e-mail traz o link");
  return m[1];
}

/** Vincula uma conta Google de verdade (no Google falso) direto pela biblioteca. */
async function vincular(usuarioId: string, conta: ContaFalsa) {
  const oauth = await import("../src/lib/google/oauth");
  const { vincularConta } = await import("../src/lib/google/contas");
  amb.google.proximo.conta = conta;
  amb.google.proximo.negar = false;
  const { verificador, desafio } = oauth.pkce();
  const ida = await fetch(oauth.urlDeConsentimento({ state: "s", desafio }), { redirect: "manual" });
  const code = new URL(ida.headers.get("location")!).searchParams.get("code")!;
  const tokens = await oauth.trocarCodigo(code, verificador);
  const quem = await oauth.perfil(tokens.acesso);
  const r = await vincularConta(usuarioId, quem, { ...tokens, refresh: tokens.refresh! });
  assert.ok(r.ok);
}

describe("esqueci a senha", () => {
  test("com conta: manda um e-mail pelo Resend com link; sem conta: mesma resposta e nenhum e-mail", async () => {
    await criar("victor@exemplo.com", "1.0.0.1");
    const antes = amb.resend.recebidos.length;
    const com = await redefinir.pedirRedefinicao({ email: " Victor@Exemplo.com ", ip: "1.0.0.2", depois });
    await esperar();
    const sem = await redefinir.pedirRedefinicao({ email: "ninguem@exemplo.com", ip: "1.0.0.2", depois });
    await esperar();
    assert.ok(com.ok && sem.ok);
    assert.equal(com.mensagem, sem.mensagem);
    assert.equal(amb.resend.recebidos.length, antes + 1);
    const e = amb.resend.recebidos.at(-1)!;
    assert.deepEqual(e.to, ["victor@exemplo.com"]);
    assert.equal(e.from, "SOBEDESCE <nao-responda@exemplo.com>");
    assert.equal(e.authorization, "Bearer re_teste_123");
    assert.match(e.subject, /senha/i);
    assert.match(e.html, /<a href="http:\/\/localhost:3000\/nova-senha\?token=/);
    assert.ok(!/!/.test(e.text), "sem ponto de exclamação");
    const token = tokenDoEmail(e.text);
    const { db, schema } = amb.banco;
    const linhas = await db.select().from(schema.redefinicoesSenha);
    assert.equal(linhas.length, 1);
    assert.notEqual(linhas[0].tokenHash, token, "só o hash no banco");
    assert.ok(linhas[0].expiraEm.getTime() <= Date.now() + 60 * 60_000 && linhas[0].expiraEm.getTime() > Date.now() + 59 * 60_000);
  });

  test("limite de pedidos por e-mail (a resposta de limite vale igual para quem não tem conta)", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await redefinir.pedirRedefinicao({ email: "limite@exemplo.com", ip: `2.0.0.${i}`, depois });
      assert.ok(r.ok);
    }
    const quarto = await redefinir.pedirRedefinicao({ email: "limite@exemplo.com", ip: "2.0.0.9", depois });
    assert.ok(!quarto.ok);
    assert.equal(quarto.erro, "devagar");
    await esperar();
  });

  test("link: senha nova encerra todas as sessões (site e computador), entra, e não vale de novo", async () => {
    const velha = await contas.entrarComSenha({ email: "victor@exemplo.com", senha: SENHA, ip: "3.0.0.1" });
    assert.ok(velha.ok);
    const computador = await sessao.criarSessao(velha.usuario.id, "dispositivo", { nome: "Mac", plataforma: "mac" });
    await redefinir.pedirRedefinicao({ email: "victor@exemplo.com", ip: "3.0.0.2", depois });
    await esperar();
    const token = tokenDoEmail(amb.resend.recebidos.at(-1)!.text);
    assert.equal(await redefinir.linkValido(token), true);

    const curta = await redefinir.redefinirSenha({ token, senha: "curta" });
    assert.ok(!curta.ok && curta.campo === "senha");
    assert.equal(await redefinir.linkValido(token), true, "senha curta não gasta o link");

    const r = await redefinir.redefinirSenha({ token, senha: "senha nova comprida" });
    assert.ok(r.ok);
    assert.ok(await sessao.autenticar({ cookie: r.token }), "a sessão nova vale");
    assert.equal(await sessao.autenticar({ cookie: velha.token }), null, "a do site caiu");
    assert.equal(await sessao.autenticar({ authorization: `Bearer ${computador.token}` }), null, "a do computador caiu");
    assert.ok(!(await contas.entrarComSenha({ email: "victor@exemplo.com", senha: SENHA, ip: "3.0.0.3" })).ok);
    assert.ok((await contas.entrarComSenha({ email: "victor@exemplo.com", senha: "senha nova comprida", ip: "3.0.0.3" })).ok);

    const deNovo = await redefinir.redefinirSenha({ token, senha: "outra senha comprida" });
    assert.ok(!deNovo.ok);
    assert.equal(deNovo.erro, "link");
    assert.equal(await redefinir.linkValido(token), false);
  });

  test("link vencido ou inventado não serve", async () => {
    await redefinir.pedirRedefinicao({ email: "victor@exemplo.com", ip: "4.0.0.1", depois });
    await esperar();
    const token = tokenDoEmail(amb.resend.recebidos.at(-1)!.text);
    const { db, schema } = amb.banco;
    await db.update(schema.redefinicoesSenha).set({ expiraEm: new Date(Date.now() - 1000) });
    assert.equal(await redefinir.linkValido(token), false);
    assert.ok(!(await redefinir.redefinirSenha({ token, senha: "senha nova comprida" })).ok);
    assert.ok(!(await redefinir.redefinirSenha({ token: "x".repeat(43), senha: "senha nova comprida" })).ok);
    assert.equal(await redefinir.linkValido("../../etc"), false);
  });
});

describe("apagar a conta", () => {
  test("pede a senha e a palavra APAGAR; errado não apaga nada", async () => {
    const r = await criar("apagar@exemplo.com", "5.0.0.1");
    const semPalavra = await apagar.apagarConta({ usuarioId: r.usuario.id, senha: SENHA, palavra: "apagar", depois });
    assert.ok(!semPalavra.ok && semPalavra.campo === "palavra");
    const senhaErrada = await apagar.apagarConta({ usuarioId: r.usuario.id, senha: "nao e a senha", palavra: "APAGAR", depois });
    assert.ok(!senhaErrada.ok && senhaErrada.campo === "senha");
    assert.ok(await sessao.autenticar({ cookie: r.token }), "nada mudou");
  });

  test("apaga tudo: revoga cada Drive no Google, derruba site e computadores, manda a confirmação", async () => {
    const r = await contas.entrarComSenha({ email: "apagar@exemplo.com", senha: SENHA, ip: "5.0.0.2" });
    assert.ok(r.ok);
    const id = r.usuario.id;
    await vincular(id, CONTA_ANA);
    await vincular(id, CONTA_BETO);
    const computador = await sessao.criarSessao(id, "dispositivo", { nome: "PC", plataforma: "windows" });
    const { iniciar, aprovar } = await import("../src/lib/dispositivo");
    const pedidoAberto = await iniciar({ nome: "Outro", plataforma: "mac" });
    await aprovar(pedidoAberto.codigo, id);
    await redefinir.pedirRedefinicao({ email: "apagar@exemplo.com", ip: "5.0.0.3", depois });
    await esperar();

    const vivosAntes = amb.google.refreshVivos();
    const revogacoes = amb.google.contadores.revogacoes;
    const emails = amb.resend.recebidos.length;
    const res = await apagar.apagarConta({ usuarioId: id, senha: SENHA, palavra: " APAGAR ", depois });
    assert.ok(res.ok);
    await esperar();

    assert.equal(amb.google.contadores.revogacoes, revogacoes + 2, "um revoke por Drive");
    assert.equal(amb.google.refreshVivos(), vivosAntes - 2);
    assert.equal((await eu.GET(pedido("/api/eu", { cookies: { sd_sessao: r.token } }))).status, 401);
    assert.equal((await eu.GET(pedido("/api/eu", { bearer: computador.token }))).status, 401);

    const { db, schema } = amb.banco;
    const { eq } = await import("drizzle-orm");
    assert.equal((await db.select().from(schema.usuarios).where(eq(schema.usuarios.id, id))).length, 0);
    assert.equal((await db.select().from(schema.sessoes).where(eq(schema.sessoes.usuarioId, id))).length, 0);
    assert.equal((await db.select().from(schema.contasGoogle).where(eq(schema.contasGoogle.usuarioId, id))).length, 0);
    assert.equal((await db.select().from(schema.codigosDispositivo).where(eq(schema.codigosDispositivo.usuarioId, id))).length, 0);
    assert.equal((await db.select().from(schema.redefinicoesSenha).where(eq(schema.redefinicoesSenha.usuarioId, id))).length, 0);

    assert.equal(amb.resend.recebidos.length, emails + 1);
    const e = amb.resend.recebidos.at(-1)!;
    assert.deepEqual(e.to, ["apagar@exemplo.com"]);
    assert.match(e.subject, /apagada/);

    // O e-mail fica livre para uma conta nova, e a conta Google também.
    await criar("apagar@exemplo.com", "5.0.0.4", "De novo");
  });

  test("conta sem senha (só Google): vale um login recente", async () => {
    const r = await criar("sosenha@exemplo.com", "6.0.0.1");
    const { db, schema } = amb.banco;
    const { eq } = await import("drizzle-orm");
    await db.update(schema.usuarios).set({ senhaHash: "", ultimoLoginEm: new Date(Date.now() - 60 * 60_000) }).where(eq(schema.usuarios.id, r.usuario.id));
    const antiga = await apagar.apagarConta({ usuarioId: r.usuario.id, senha: "", palavra: "APAGAR", depois });
    assert.ok(!antiga.ok && antiga.erro === "login_recente");
    await db.update(schema.usuarios).set({ ultimoLoginEm: new Date() }).where(eq(schema.usuarios.id, r.usuario.id));
    const ok = await apagar.apagarConta({ usuarioId: r.usuario.id, senha: "", palavra: "APAGAR", depois });
    assert.ok(ok.ok);
    await esperar();
  });
});

describe("avisos e envio", () => {
  test("conta nova: os admins recebem um aviso, uma vez só", async () => {
    const admin = await import("../src/lib/email/admin");
    const antes = amb.resend.recebidos.length;
    const r = await criar("nova-admin@exemplo.com", "7.0.0.9", "Pessoa <Nova>");
    const e = amb.resend.recebidos.at(-1)!;
    assert.equal(amb.resend.recebidos.length, antes + 1);
    assert.deepEqual(e.to, ["contato@dissesim.com.br"]);
    assert.match(e.subject, /Conta nova: Pessoa <Nova>/);
    assert.match(e.text, /nova-admin@exemplo\.com/);
    assert.match(e.html, /Pessoa &lt;Nova&gt;/, "HTML escapado");
    // Repetir (dois pedidos, retry) não manda de novo.
    await admin.avisarAdminContaNova({ id: r.usuario.id, nome: "Pessoa <Nova>", email: "nova-admin@exemplo.com" }, false);
    assert.equal(amb.resend.recebidos.length, antes + 1);
  });

  test("computador conectado: e-mail com nome, plataforma, quando e o caminho para desconectar", async () => {
    const r = await criar("aviso@exemplo.com", "7.0.0.1");
    const res = await avisos.avisarComputadorConectado(r.usuario.id, { nome: "MacBook <Pro> de Victor", plataforma: "mac", quando: new Date("2026-10-16T15:30:00Z") });
    assert.deepEqual(res, { ok: true, via: "resend" });
    const e = amb.resend.recebidos.at(-1)!;
    assert.deepEqual(e.to, ["aviso@exemplo.com"]);
    assert.match(e.text, /MacBook <Pro> de Victor \(Mac\)/);
    assert.match(e.text, /16 de outubro de 2026.*12:30/);
    assert.match(e.text, /Se não foi você, desconecte/);
    assert.match(e.html, /MacBook &lt;Pro&gt; de Victor/, "HTML escapado");
    assert.ok(!e.html.includes("<Pro>"));
  });

  test("Resend fora do ar: falha sem lançar", async () => {
    amb.resend.falhar(true);
    try {
      const r = await enviar.enviarEmail({ para: "x@exemplo.com", assunto: "a", html: "<p>a</p>", texto: "a" });
      assert.deepEqual(r, { ok: false, motivo: "falhou" });
    } finally {
      amb.resend.falhar(false);
    }
  });

  test("sem chave: em desenvolvimento vai para o console; em produção não envia e o esqueci fica indisponível", async () => {
    const chave = process.env.RESEND_API_KEY;
    const log = console.info;
    const aviso = console.warn;
    const ditos: string[] = [];
    console.info = (...a: unknown[]) => void ditos.push(a.join(" "));
    console.warn = (...a: unknown[]) => void ditos.push(a.join(" "));
    delete process.env.RESEND_API_KEY;
    try {
      const dev = await enviar.enviarEmail({ para: "x@exemplo.com", assunto: "Assunto", html: "", texto: "link secreto" });
      assert.deepEqual(dev, { ok: true, via: "console" });
      assert.match(ditos.join("\n"), /link secreto/);
      ditos.length = 0;
      process.env.VERCEL = "1";
      const prod = await enviar.enviarEmail({ para: "x@exemplo.com", assunto: "Assunto", html: "", texto: "link secreto" });
      assert.deepEqual(prod, { ok: false, motivo: "sem_config" });
      assert.ok(!ditos.join("\n").includes("link secreto"), "nada do conteúdo no log de produção");
      assert.equal(enviar.emailDisponivel(), false);
      const r = await redefinir.pedirRedefinicao({ email: "victor@exemplo.com", ip: "8.0.0.1", depois });
      assert.ok(!r.ok && r.erro === "indisponivel");
      assert.equal(enviar.baseResendDeTeste(), null, "a base falsa não vale em produção");
    } finally {
      process.env.RESEND_API_KEY = chave;
      delete process.env.VERCEL;
      console.info = log;
      console.warn = aviso;
    }
  });
});
