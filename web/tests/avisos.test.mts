/**
 * Avisos de segurança por e-mail (Resend falso): entrada nova (aparelho conhecido pelo cookie assinado, por senha e
 * pelo Google), senha trocada/refeita/criada, Google de entrar trocado ou removido, computador conectado com o lugar,
 * muitas senhas erradas (um por dia) e as regras de todos: o fluxo nunca quebra por causa do e-mail, sem chave não
 * manda, nada de IP, token ou "!" no texto.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { CONTA_ANA, CONTA_BETO, cookiesDe, pedido, prepararAmbiente, SITE } from "./ambiente.mjs";
import type { ContaFalsa } from "./google-falso.mjs";
import type { EmailRecebido } from "./resend-falso.mjs";

let amb: Awaited<ReturnType<typeof prepararAmbiente>>;
let contas: typeof import("../src/lib/auth/contas");
let redefinir: typeof import("../src/lib/auth/redefinir");
let aparelho: typeof import("../src/lib/auth/aparelho");
let avisos: typeof import("../src/lib/email/avisos");
let googleContas: typeof import("../src/lib/google/contas");
let rotas: typeof import("../src/lib/google/rotas");
let conectar: typeof import("../src/app/api/google/conectar/route");
let eu: typeof import("../src/app/api/eu/route");
let navegador: typeof import("../src/lib/navegador");
let drizzle: typeof import("drizzle-orm");

/** Tarefas que iriam para depois da resposta: aqui esperamos por elas. */
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
  aparelho = await import("../src/lib/auth/aparelho");
  avisos = await import("../src/lib/email/avisos");
  googleContas = await import("../src/lib/google/contas");
  rotas = await import("../src/lib/google/rotas");
  conectar = await import("../src/app/api/google/conectar/route");
  eu = await import("../src/app/api/eu/route");
  navegador = await import("../src/lib/navegador");
  drizzle = await import("drizzle-orm");
});

after(async () => {
  await amb?.fechar();
});

const SENHA = "senha antiga comprida";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const WINDOWS_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const NATAL = { ip: "200.17.0.9", cidade: "Natal", pais: "BR" };

let n = 0;
async function criar(nome = "Victor Barroso") {
  const email = `aviso${++n}@exemplo.com`;
  const r = await contas.criarConta({ nome, email, senha: SENHA, ip: `10.0.${n}.1` });
  assert.ok(r.ok);
  return { id: r.usuario.id, email, token: r.token };
}

const emailsPara = (email: string) => amb.resend.recebidos.filter((e) => e.to[0] === email);

/** O que vale para todos os avisos: texto sem "!", sem IP, sem token e sem segredo; HTML com a moldura. */
function conferirRegras(e: EmailRecebido) {
  assert.ok(!/!/.test(e.text) && !/!/.test(e.subject), "sem ponto de exclamação");
  assert.ok(!e.text.includes(NATAL.ip) && !e.html.includes(NATAL.ip), "nada de IP");
  assert.ok(!/token=|sdd_|ya29|v1\.[A-Za-z0-9_-]{22}\./.test(e.text + e.html), "nada de token nem do cookie");
  assert.match(e.html, /^<!doctype html>/);
  assert.match(e.text, /^SOBEDESCE\n/);
  for (const cliche of ["revolucion", "incrível", "mergulh", "crucial"]) assert.ok(!e.text.toLowerCase().includes(cliche), `sem "${cliche}"`);
}

/** Login com senha + conferência do aparelho, como a Server Action faz. */
async function entrar(email: string, cookie: string | undefined, entrada: Partial<import("../src/lib/auth/aparelho").DadosDaEntrada> = {}) {
  const r = await contas.entrarComSenha({ email, senha: SENHA, ip: "10.9.9.9", depois });
  assert.ok(r.ok);
  const valor = await aparelho.conferirAparelho({
    usuarioId: r.usuario.id,
    cookie,
    via: "senha",
    entrada: { userAgent: IPHONE, lugar: NATAL, ...entrada },
    avisar: true,
    depois,
  });
  await esperar();
  return valor;
}

describe("entrada nova", () => {
  test("criar a conta aprende o aparelho sem avisar; entrar de novo nele também não avisa", async () => {
    const v = await criar();
    const cookie = await aparelho.conferirAparelho({ usuarioId: v.id, cookie: undefined, via: "senha", entrada: { userAgent: IPHONE, lugar: NATAL }, avisar: false, depois });
    await esperar();
    assert.ok(cookie);
    assert.match(cookie, /^v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/, "só um id aleatório assinado");
    assert.equal(emailsPara(v.email).length, 0);
    const deNovo = await entrar(v.email, cookie);
    assert.equal(deNovo, cookie, "o mesmo cookie volta (renova os 400 dias)");
    assert.equal(emailsPara(v.email).length, 0, "aparelho conhecido não avisa");
    const { db, schema } = amb.banco;
    const linhas = await db.select().from(schema.aparelhos).where(drizzle.eq(schema.aparelhos.usuarioId, v.id));
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].aparelhoHash.length, 64, "no banco, só o sha256");
    assert.ok(!cookie.includes(linhas[0].aparelhoHash));
  });

  test("navegador novo: avisa com quando, navegador, sistema e lugar, e o link Não fui eu", async () => {
    const v = await criar("Victor Barroso");
    await aparelho.conferirAparelho({ usuarioId: v.id, cookie: undefined, via: "senha", entrada: { userAgent: IPHONE, lugar: NATAL }, avisar: false, depois });
    const novo = await entrar(v.email, undefined, { userAgent: WINDOWS_CHROME, quando: new Date("2026-10-17T14:32:00Z") });
    assert.ok(novo);
    const [e] = emailsPara(v.email);
    assert.ok(e, "um aviso");
    assert.equal(emailsPara(v.email).length, 1);
    assert.equal(e.subject, "Entrada nova na sua conta");
    assert.match(e.text, /Oi, Victor\./);
    assert.match(e.text, /Quando: 17 de outubro de 2026.*11:32 \(horário de Brasília\)/);
    assert.match(e.text, /Navegador: Chrome no Windows/);
    assert.match(e.text, /Onde, mais ou menos: Perto de Natal, Brasil/);
    assert.match(e.text, /Como: Com e-mail e senha/);
    assert.match(e.text, /Se foi você, não precisa fazer nada/);
    assert.match(e.html, /<a href="http:\/\/localhost:3000\/conta\?aviso=nao-fui-eu"[^>]*>Não fui eu<\/a>/);
    assert.match(e.text, /troque|trocar a senha/i);
    conferirRegras(e);

    // O mesmo navegador de novo: conhecido agora.
    await entrar(v.email, novo, { userAgent: WINDOWS_CHROME });
    assert.equal(emailsPara(v.email).length, 1);
  });

  test("cookie adulterado, de outro formato ou de um aparelho que só outra conta usou: aparelho novo", async () => {
    const a = await criar();
    const b = await criar();
    const doA = await aparelho.conferirAparelho({ usuarioId: a.id, cookie: undefined, via: "senha", entrada: { userAgent: IPHONE, lugar: NATAL }, avisar: false, depois });
    await aparelho.conferirAparelho({ usuarioId: b.id, cookie: undefined, via: "senha", entrada: { userAgent: IPHONE, lugar: NATAL }, avisar: false, depois });
    assert.ok(doA);
    const [v, id, assinatura] = doA.split(".");
    const trocado = `${v}.${id}.${assinatura.slice(0, -1)}${assinatura.endsWith("A") ? "B" : "A"}`;
    assert.equal(aparelho.idDoAparelho(trocado), null);
    assert.equal(aparelho.idDoAparelho(`v1.${"x".repeat(22)}.${"y".repeat(22)}`), null);
    assert.equal(aparelho.idDoAparelho("qualquer coisa"), null);
    assert.equal(aparelho.idDoAparelho(doA), id);

    const outro = await entrar(a.email, trocado);
    assert.notEqual(outro, trocado, "cookie adulterado é trocado por um novo");
    assert.equal(emailsPara(a.email).length, 1, "e conta como aparelho novo");

    await entrar(b.email, doA);
    assert.equal(emailsPara(b.email).length, 1, "o aparelho do A é novo para o B");
    await entrar(a.email, doA);
    assert.equal(emailsPara(a.email).length, 1, "e continua conhecido para o A");
  });

  test("sem chave para assinar (produção sem SOBEDESCE_KEY): o login segue, sem cookie e sem aviso", async () => {
    const v = await criar();
    const chave = process.env.SOBEDESCE_KEY;
    const ambiente = process.env.NODE_ENV;
    const aviso = console.warn;
    console.warn = () => {};
    delete process.env.SOBEDESCE_KEY;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      const r = await contas.entrarComSenha({ email: v.email, senha: SENHA, ip: "10.8.8.8", depois });
      assert.ok(r.ok);
      const valor = await aparelho.conferirAparelho({ usuarioId: r.usuario.id, cookie: undefined, via: "senha", entrada: { userAgent: IPHONE, lugar: NATAL }, avisar: true, depois });
      assert.equal(valor, null);
      assert.equal(await aparelho.aprenderAparelho(r.usuario.id, undefined), null);
    } finally {
      process.env.SOBEDESCE_KEY = chave;
      (process.env as Record<string, string | undefined>).NODE_ENV = ambiente;
      console.warn = aviso;
    }
    await esperar();
    assert.equal(emailsPara(v.email).length, 0);
  });

  test("/api/eu: o navegador já logado ganha o cookie e a conta aprende o aparelho, sem aviso; Bearer não mexe", async () => {
    const v = await criar();
    const res = await eu.GET(pedido("/api/eu", { cookies: { sd_sessao: v.token } }));
    assert.equal(res.status, 200);
    const cookie = cookiesDe(res).get("sd_aparelho");
    assert.ok(cookie);
    const linha = res.headers.getSetCookie().find((c) => c.startsWith("sd_aparelho="))!;
    assert.match(linha, /Max-Age=34560000/, "400 dias");
    assert.match(linha, /HttpOnly; SameSite=Lax/);
    const deNovo = await eu.GET(pedido("/api/eu", { cookies: { sd_sessao: v.token, sd_aparelho: cookie } }));
    assert.equal(deNovo.headers.getSetCookie().length, 0, "cookie válido: nada a gravar");
    await entrar(v.email, cookie);
    assert.equal(emailsPara(v.email).length, 0, "aparelho aprendido não avisa");

    const { criarSessao } = await import("../src/lib/auth/sessao");
    const computador = await criarSessao(v.id, "dispositivo", { nome: "Mac", plataforma: "mac" });
    const pc = await eu.GET(pedido("/api/eu", { bearer: computador.token }));
    assert.equal(pc.status, 200);
    assert.equal(pc.headers.getSetCookie().length, 0, "o computador não ganha cookie de aparelho");
  });

  test("apagar a conta leva os aparelhos junto", async () => {
    const v = await criar();
    await aparelho.conferirAparelho({ usuarioId: v.id, cookie: undefined, via: "senha", entrada: { userAgent: IPHONE, lugar: NATAL }, avisar: false, depois });
    const { apagarConta } = await import("../src/lib/auth/apagar");
    assert.ok((await apagarConta({ usuarioId: v.id, senha: SENHA, palavra: "APAGAR", depois })).ok);
    await esperar();
    const { db, schema } = amb.banco;
    assert.equal((await db.select().from(schema.aparelhos).where(drizzle.eq(schema.aparelhos.usuarioId, v.id))).length, 0);
  });
});

/** /api/google/conectar?modo=entrar → Google falso → callback com o `depois` daqui. */
async function entrarComGoogle(conta: ContaFalsa, cookies: Record<string, string | undefined> = {}) {
  amb.google.proximo.conta = conta;
  amb.google.proximo.negar = false;
  amb.google.proximo.escopo = null;
  const ida = await conectar.GET(pedido("/api/google/conectar?modo=entrar"));
  const oauth = cookiesDe(ida).get("sd_google");
  const google = await fetch(ida.headers.get("location")!, { redirect: "manual" });
  const volta = google.headers.get("location")!.replace(SITE, "");
  const base = pedido(volta, { cookies: { sd_google: oauth, ...cookies } });
  const headers = new Headers(base.headers);
  headers.set("user-agent", WINDOWS_CHROME);
  const res = await rotas.callback(new Request(base.url, { headers }), depois);
  await esperar();
  return res;
}

describe("entrada nova pelo Google", () => {
  test("conta nova pelo Google não avisa; entrar pelo Google num navegador novo avisa, e no conhecido não", async () => {
    const conta = { sub: "g-301", email: "google.aviso@exemplo.com", name: "Edu Cardoso" };
    const criou = await entrarComGoogle(conta);
    assert.equal(criou.status, 303);
    const cookie = cookiesDe(criou).get("sd_aparelho");
    assert.ok(cookie, "o callback grava o cookie de aparelho");
    assert.equal(emailsPara(conta.email).length, 0, "quem acabou de criar a conta não recebe aviso");

    await entrarComGoogle(conta, { sd_aparelho: cookie });
    assert.equal(emailsPara(conta.email).length, 0, "navegador conhecido");

    await entrarComGoogle(conta);
    const [e] = emailsPara(conta.email);
    assert.ok(e);
    assert.match(e.text, /Oi, Edu\./);
    assert.match(e.text, /Navegador: Chrome no Windows/);
    assert.match(e.text, /Como: Com o Google de entrar/);
    assert.match(e.text, /Onde, mais ou menos: Não deu para saber/, "fora da Vercel o lugar não vale");
    conferirRegras(e);
  });
});

describe("senha", () => {
  test("trocada em Sua conta: aviso com quando e o caminho Esqueci a senha", async () => {
    const v = await criar();
    const login = await contas.entrarComSenha({ email: v.email, senha: SENHA, ip: "10.7.7.1" });
    assert.ok(login.ok);
    const errada = await contas.trocarSenha({ usuarioId: v.id, sessaoId: "x", senhaAtual: "nao e", senhaNova: "outra senha comprida", ip: "10.7.7.1", depois });
    assert.ok(!errada.ok);
    await esperar();
    assert.equal(emailsPara(v.email).length, 0, "senha atual errada não manda nada");
    const { autenticar } = await import("../src/lib/auth/sessao");
    const s = await autenticar({ cookie: login.token });
    const r = await contas.trocarSenha({ usuarioId: v.id, sessaoId: s!.sessao.id, senhaAtual: SENHA, senhaNova: "outra senha comprida", ip: "10.7.7.1", depois });
    assert.ok(r.ok);
    await esperar();
    const [e] = emailsPara(v.email);
    assert.equal(e.subject, "A senha da sua conta mudou");
    assert.match(e.text, /foi trocada em \d+ de \S+ de \d{4}.*, na tela Sua conta/);
    assert.match(e.text, /saíram da conta/);
    assert.match(e.html, /href="http:\/\/localhost:3000\/esqueci-a-senha"[^>]*>Não fui eu</);
    assert.ok(!e.text.includes("outra senha comprida"), "a senha nunca vai no e-mail");
    conferirRegras(e);
  });

  test("refeita pelo link e criada pela primeira vez (conta só-Google): avisos diferentes", async () => {
    const v = await criar();
    await redefinir.pedirRedefinicao({ email: v.email, ip: "10.7.7.2", depois });
    await esperar();
    const token = /\/nova-senha\?token=([A-Za-z0-9_-]{43})/.exec(emailsPara(v.email).at(-1)!.text)![1];
    const r = await redefinir.redefinirSenha({ token, senha: "senha refeita comprida", depois });
    assert.ok(r.ok);
    await esperar();
    const e = emailsPara(v.email).at(-1)!;
    assert.equal(e.subject, "A senha da sua conta mudou");
    assert.match(e.text, /foi refeita em .*, pelo link de Esqueci a senha/);
    conferirRegras(e);

    const g = await criar();
    const { db, schema } = amb.banco;
    await db.update(schema.usuarios).set({ senhaHash: "google" }).where(drizzle.eq(schema.usuarios.id, g.id));
    await redefinir.pedirPrimeiraSenha({ usuarioId: g.id, ip: "10.7.7.3", depois });
    await esperar();
    const t2 = /\/nova-senha\?token=([A-Za-z0-9_-]{43})/.exec(emailsPara(g.email).at(-1)!.text)![1];
    assert.ok((await redefinir.redefinirSenha({ token: t2, senha: "primeira senha comprida", depois })).ok);
    await esperar();
    const c = emailsPara(g.email).at(-1)!;
    assert.equal(c.subject, "Sua conta agora tem senha");
    assert.match(c.text, /ganhou uma senha/);
    conferirRegras(c);
  });
});

/** Vincula uma conta Google (no Google falso) direto pela biblioteca. */
async function vincular(usuarioId: string, conta: ContaFalsa) {
  const oauth = await import("../src/lib/google/oauth");
  amb.google.proximo.conta = conta;
  amb.google.proximo.negar = false;
  amb.google.proximo.escopo = null;
  const { verificador, desafio } = oauth.pkce();
  const ida = await fetch(oauth.urlDeConsentimento({ state: "s", desafio }), { redirect: "manual" });
  const code = new URL(ida.headers.get("location")!).searchParams.get("code")!;
  const tokens = await oauth.trocarCodigo(code, verificador);
  const quem = await oauth.perfil(tokens.acesso);
  const r = await googleContas.vincularConta(usuarioId, quem, { ...tokens, refresh: tokens.refresh! });
  assert.ok(r.ok);
  return r.conta;
}

describe("Google de entrar", () => {
  test("trocado, escolhido de novo (sem aviso), desligado e removido junto com o Drive", async () => {
    const v = await criar();
    const ana = await vincular(v.id, CONTA_ANA);
    const beto = await vincular(v.id, CONTA_BETO);
    const trocar = (contaId: string | null) => googleContas.trocarGoogleDeEntrar({ usuarioId: v.id, contaId, senhaAtual: SENHA, depois });

    assert.ok((await trocar(ana.id)).ok);
    await esperar();
    let e = emailsPara(v.email).at(-1)!;
    assert.equal(e.subject, "O Google de entrar mudou");
    assert.match(e.text, /é o Google ana@exemplo\.com que abre a sua conta/);
    assert.match(e.text, /E-mail e senha continuam valendo/);
    assert.match(e.html, /conta\?aviso=nao-fui-eu/);
    conferirRegras(e);

    assert.ok((await trocar(ana.id)).ok);
    await esperar();
    assert.equal(emailsPara(v.email).length, 1, "o mesmo de novo: nada mudou, nada a avisar");

    assert.ok((await trocar(beto.id)).ok);
    await esperar();
    e = emailsPara(v.email).at(-1)!;
    assert.match(e.text, /é o Google beto@exemplo\.com/);
    assert.match(e.text, /ana@exemplo\.com continua conectado como Drive, mas não entra mais/);

    const senhaErrada = await googleContas.trocarGoogleDeEntrar({ usuarioId: v.id, contaId: null, senhaAtual: "nao e", depois });
    assert.ok(!senhaErrada.ok);
    await esperar();
    assert.equal(emailsPara(v.email).length, 2, "senha errada não muda nada e não avisa");

    assert.ok((await trocar(null)).ok);
    await esperar();
    e = emailsPara(v.email).at(-1)!;
    assert.equal(e.subject, "Nenhum Google entra mais na sua conta");
    assert.match(e.text, /o Google beto@exemplo\.com não abre mais a sua conta/);
    conferirRegras(e);

    // Remover o Drive que é o de entrar (a conta tem senha): avisa. Remover um Drive comum: não.
    assert.ok((await trocar(ana.id)).ok);
    await esperar();
    const antes = emailsPara(v.email).length;
    assert.deepEqual(await googleContas.removerConta(v.id, beto.id, depois), { ok: true });
    await esperar();
    assert.equal(emailsPara(v.email).length, antes, "Drive comum sai sem aviso");
    assert.deepEqual(await googleContas.removerConta(v.id, ana.id, depois), { ok: true });
    await esperar();
    e = emailsPara(v.email).at(-1)!;
    assert.equal(emailsPara(v.email).length, antes + 1);
    assert.equal(e.subject, "Nenhum Google entra mais na sua conta");
    assert.match(e.text, /o Google ana@exemplo\.com não abre mais/);
  });
});

describe("computador conectado", () => {
  test("leva o nome, o sistema, quando e o lugar aproximado do pedido", async () => {
    const v = await criar();
    const r = await avisos.avisarComputadorConectado(v.id, { nome: "iMac da Ilha", plataforma: "mac", quando: new Date("2026-10-17T13:00:00Z"), onde: "Natal, Brasil" });
    assert.deepEqual(r, { ok: true, via: "resend" });
    const e = emailsPara(v.email).at(-1)!;
    assert.match(e.text, /iMac da Ilha \(Mac\) entrou na sua conta SOBEDESCE em 17 de outubro de 2026.*10:00/);
    assert.match(e.text, /O pedido veio de perto de Natal, Brasil/);
    conferirRegras(e);
    assert.equal(await avisos.avisarComputadorConectado("nao-existe", { nome: "x", plataforma: null }), null, "conta que sumiu: nada");
  });
});

describe("muitas senhas erradas", () => {
  test("bater no limite da conta manda um aviso; mais erros no mesmo dia, nenhum; e-mail sem conta, nenhum", async () => {
    const v = await criar();
    const { REGRAS } = await import("../src/lib/auth/limite");
    for (let i = 0; i < REGRAS.loginConta.max - 1; i++) {
      const r = await contas.entrarComSenha({ email: v.email, senha: `errada ${i}`, ip: `172.16.${i}.1`, depois });
      assert.ok(!r.ok && r.erro === "credenciais");
    }
    await esperar();
    assert.equal(emailsPara(v.email).length, 0, "abaixo do limite: nada");
    const ultima = await contas.entrarComSenha({ email: v.email, senha: "errada de novo", ip: "172.17.0.1", depois });
    assert.ok(!ultima.ok);
    await esperar();
    assert.equal(emailsPara(v.email).length, 1, "bateu no limite: um aviso");
    const e = emailsPara(v.email)[0];
    assert.equal(e.subject, "Muitas senhas erradas na sua conta");
    assert.match(e.text, /O que já fizemos: Pausamos a entrada com senha nesta conta. Ela volta sozinha em até uma hora/);
    assert.match(e.text, /Se não foi: Essas tentativas não abriram a conta/);
    assert.match(e.text, /no máximo uma vez por dia/);
    assert.ok(!e.text.includes("172.1"), "nenhum IP das tentativas");
    conferirRegras(e);

    for (let i = 0; i < 3; i++) {
      const r = await contas.entrarComSenha({ email: v.email, senha: SENHA, ip: `172.18.${i}.1`, depois });
      assert.ok(!r.ok && r.erro === "devagar", "a conta segue pausada");
    }
    await esperar();
    assert.equal(emailsPara(v.email).length, 1, "mesmo dia: nenhum outro");

    for (let i = 0; i < REGRAS.loginConta.max; i++) await contas.entrarComSenha({ email: "ninguem.aqui@exemplo.com", senha: "x", ip: `172.19.${i}.1`, depois });
    await esperar();
    assert.equal(emailsPara("ninguem.aqui@exemplo.com").length, 0, "sem conta, sem e-mail");
  });
});

describe("o e-mail nunca derruba o fluxo", () => {
  test("Resend fora do ar: entrar, trocar a senha e trocar o Google seguem; o aviso só falha", async () => {
    const v = await criar();
    const ana = await vincular(v.id, { ...CONTA_ANA, sub: "ana-2", email: "ana2@exemplo.com" });
    amb.resend.falhar(true);
    const aviso = console.warn;
    console.warn = () => {};
    try {
      const antes = amb.resend.recebidos.length;
      const cookie = await entrar(v.email, undefined);
      assert.ok(cookie, "o login seguiu com cookie de aparelho");
      const r = await contas.trocarSenha({ usuarioId: v.id, sessaoId: "x", senhaAtual: SENHA, senhaNova: "outra senha comprida", ip: "10.6.6.1", depois });
      assert.ok(r.ok);
      const g = await googleContas.trocarGoogleDeEntrar({ usuarioId: v.id, contaId: ana.id, senhaAtual: "outra senha comprida", depois });
      assert.ok(g.ok);
      await esperar();
      assert.equal(amb.resend.recebidos.length, antes, "nada saiu");
    } finally {
      amb.resend.falhar(false);
      console.warn = aviso;
    }
  });

  test("banco fora no meio do aviso: o aviso devolve null e não lança", async () => {
    const aviso = console.warn;
    const ditos: string[] = [];
    console.warn = (...a: unknown[]) => void ditos.push(a.join(" "));
    try {
      const r = await avisos.avisarEntradaNova("' or 1=1 --", { quando: new Date(), navegador: null, onde: null, via: "senha" });
      assert.equal(r, null);
      const { db } = amb.banco;
      const original = db.query.usuarios.findFirst;
      db.query.usuarios.findFirst = (() => Promise.reject(new Error("banco fora: victor@exemplo.com"))) as typeof original;
      try {
        assert.equal(await avisos.avisarSenhaMudou("qualquer", "trocada"), null);
      } finally {
        db.query.usuarios.findFirst = original;
      }
      assert.ok(ditos.some((d) => /aviso "senha mudou" não saiu/.test(d)));
      assert.ok(!ditos.join("\n").includes("victor@exemplo.com"), "o log não repete dado da pessoa");
    } finally {
      console.warn = aviso;
    }
  });

  test("sem RESEND_API_KEY em produção: não manda e o login segue", async () => {
    const v = await criar();
    const chave = process.env.RESEND_API_KEY;
    const aviso = console.warn;
    console.warn = () => {};
    delete process.env.RESEND_API_KEY;
    process.env.VERCEL = "1";
    try {
      const antes = amb.resend.recebidos.length;
      const cookie = await entrar(v.email, undefined);
      assert.ok(cookie);
      const r = await avisos.avisarEntradaNova(v.id, { quando: new Date(), navegador: "Safari no iPhone", onde: null, via: "senha" });
      assert.deepEqual(r, { ok: false, motivo: "sem_config" });
      assert.equal(amb.resend.recebidos.length, antes);
    } finally {
      process.env.RESEND_API_KEY = chave;
      delete process.env.VERCEL;
      console.warn = aviso;
    }
  });
});

describe("navegador resumido", () => {
  test("nome do navegador e do sistema, sem versão", () => {
    const casos: [string | null, string | null][] = [
      [IPHONE, "Safari no iPhone"],
      [WINDOWS_CHROME, "Chrome no Windows"],
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15", "Safari no Mac"],
      ["Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36", "Samsung Internet no Android"],
      ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36", "Chrome no Android"],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0", "Edge no Windows"],
      ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox no Linux"],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1", "Chrome no iPhone"],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0", "Instagram no iPhone"],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", "um navegador no iPhone"],
      ["curl/8.5.0", null],
      [null, null],
    ];
    for (const [ua, esperado] of casos) assert.equal(navegador.resumirNavegador(ua), esperado, String(ua));
  });
});
