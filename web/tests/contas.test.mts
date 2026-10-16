/**
 * Contas com e-mail e senha: criar, entrar, sair, senha errada e limite, troca de senha,
 * `volta` só interno e CSRF por Origin nas rotas com cookie.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { pedido, prepararAmbiente, SITE } from "./ambiente.mjs";

let amb: Awaited<ReturnType<typeof prepararAmbiente>>;
let contas: typeof import("../src/lib/auth/contas");
let sessao: typeof import("../src/lib/auth/sessao");
let volta: typeof import("../src/lib/auth/volta");
let senha: typeof import("../src/lib/auth/senha");
let eu: typeof import("../src/app/api/eu/route");
let token: typeof import("../src/app/api/drive/token/route");
let http: typeof import("../src/lib/http");

before(async () => {
  amb = await prepararAmbiente();
  contas = await import("../src/lib/auth/contas");
  sessao = await import("../src/lib/auth/sessao");
  volta = await import("../src/lib/auth/volta");
  senha = await import("../src/lib/auth/senha");
  eu = await import("../src/app/api/eu/route");
  token = await import("../src/app/api/drive/token/route");
  http = await import("../src/lib/http");
});

after(async () => {
  await amb?.fechar();
});

const SENHA = "uma senha comprida";

describe("senha", () => {
  test("scrypt com sal: formato, confere e recusa", async () => {
    const h = await senha.hashSenha(SENHA);
    assert.match(h, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]{86}$/);
    assert.notEqual(h, await senha.hashSenha(SENHA), "sal diferente a cada hash");
    assert.equal(await senha.conferirSenha(SENHA, h), true);
    assert.equal(await senha.conferirSenha("outra senha qualquer", h), false);
    assert.equal(await senha.conferirSenha(SENHA, "bcrypt$lixo"), false);
  });
});

describe("criar conta, entrar e sair", () => {
  test("cria a conta, a sessão vale em /api/eu e o banco guarda só o hash", async () => {
    const r = await contas.criarConta({ nome: "  Victor  ", email: " Victor@Exemplo.com ", senha: SENHA, ip: "1.1.1.1" });
    assert.ok(r.ok);
    assert.equal(r.usuario.email, "victor@exemplo.com");
    assert.equal(r.usuario.nome, "Victor");
    assert.match(r.token, /^[A-Za-z0-9_-]{43}$/);

    const res = await eu.GET(pedido("/api/eu", { cookies: { sd_sessao: r.token } }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const corpo = await res.json();
    assert.deepEqual(corpo, { usuario: { id: r.usuario.id, email: "victor@exemplo.com", nome: "Victor" }, contas: [], recursos: { referencias: true } });

    const { db, schema } = amb.banco;
    const linhas = await db.select().from(schema.sessoes);
    assert.equal(linhas.length, 1);
    assert.notEqual(linhas[0].tokenHash, r.token);
    assert.match(linhas[0].tokenHash, /^[0-9a-f]{64}$/);
    const [u] = await db.select().from(schema.usuarios);
    assert.ok(!JSON.stringify(u).includes(SENHA));
  });

  test("validações da criação: nome, e-mail, senha curta e e-mail repetido", async () => {
    const curta = await contas.criarConta({ nome: "A", email: "a@exemplo.com", senha: "123456789", ip: "1.1.1.2" });
    assert.ok(!curta.ok);
    assert.equal(curta.campo, "senha");
    const semNome = await contas.criarConta({ nome: " ", email: "a@exemplo.com", senha: SENHA, ip: "1.1.1.2" });
    assert.ok(!semNome.ok && semNome.campo === "nome");
    const email = await contas.criarConta({ nome: "A", email: "sem-arroba", senha: SENHA, ip: "1.1.1.2" });
    assert.ok(!email.ok && email.campo === "email");
    const repetido = await contas.criarConta({ nome: "Outro", email: "VICTOR@exemplo.com", senha: SENHA, ip: "1.1.1.2" });
    assert.ok(!repetido.ok);
    assert.equal(repetido.erro, "email_em_uso");
  });

  test("entrar com a senha certa cria outra sessão; sair revoga só ela", async () => {
    const r = await contas.entrarComSenha({ email: "victor@exemplo.com", senha: SENHA, ip: "2.2.2.2" });
    assert.ok(r.ok);
    assert.equal((await eu.GET(pedido("/api/eu", { cookies: { sd_sessao: r.token } }))).status, 200);
    await sessao.revogarPorToken(r.token);
    const depois = await eu.GET(pedido("/api/eu", { cookies: { sd_sessao: r.token } }));
    assert.equal(depois.status, 401);
    assert.deepEqual(await depois.json(), { erro: "sem_sessao", mensagem: "Entre na sua conta para continuar." });
  });

  test("senha errada e e-mail desconhecido dão a mesma mensagem", async () => {
    const errada = await contas.entrarComSenha({ email: "victor@exemplo.com", senha: "senha errada demais", ip: "3.3.3.3" });
    const ninguem = await contas.entrarComSenha({ email: "ninguem@exemplo.com", senha: "senha errada demais", ip: "3.3.3.3" });
    assert.ok(!errada.ok && !ninguem.ok);
    assert.equal(errada.erro, "credenciais");
    assert.equal(errada.mensagem, ninguem.mensagem);
    assert.equal(errada.erro, ninguem.erro);
    assert.equal(errada.campo, ninguem.campo);
  });

  test("limite: depois de 8 erros, nem a senha certa entra por um tempo (e outro IP entra)", async () => {
    for (let i = 0; i < 8; i++) {
      const r = await contas.entrarComSenha({ email: "victor@exemplo.com", senha: `errada-${i}-xxxxxx`, ip: "4.4.4.4" });
      assert.ok(!r.ok && r.erro === "credenciais");
    }
    const bloqueado = await contas.entrarComSenha({ email: "victor@exemplo.com", senha: SENHA, ip: "4.4.4.4" });
    assert.ok(!bloqueado.ok);
    assert.equal(bloqueado.erro, "devagar");
    const outroIp = await contas.entrarComSenha({ email: "victor@exemplo.com", senha: SENHA, ip: "5.5.5.5" });
    assert.ok(outroIp.ok);
  });

  test("trocar a senha encerra as outras sessões e mantém a atual", async () => {
    const a = await contas.entrarComSenha({ email: "victor@exemplo.com", senha: SENHA, ip: "6.6.6.6" });
    const b = await contas.entrarComSenha({ email: "victor@exemplo.com", senha: SENHA, ip: "6.6.6.6" });
    assert.ok(a.ok && b.ok);
    const atual = await sessao.autenticar({ cookie: a.token });
    assert.ok(atual);
    const errada = await contas.trocarSenha({ usuarioId: a.usuario.id, sessaoId: atual.sessao.id, senhaAtual: "nao e esta senha", senhaNova: "nova senha comprida", ip: "6.6.6.6" });
    assert.ok(!errada.ok && errada.campo === "senhaAtual");
    const certa = await contas.trocarSenha({ usuarioId: a.usuario.id, sessaoId: atual.sessao.id, senhaAtual: SENHA, senhaNova: "nova senha comprida", ip: "6.6.6.6" });
    assert.ok(certa.ok);
    assert.ok(await sessao.autenticar({ cookie: a.token }), "a sessão atual continua");
    assert.equal(await sessao.autenticar({ cookie: b.token }), null, "a outra caiu");
    const velha = await contas.entrarComSenha({ email: "victor@exemplo.com", senha: SENHA, ip: "6.6.6.7" });
    assert.ok(!velha.ok);
    const nova = await contas.entrarComSenha({ email: "victor@exemplo.com", senha: "nova senha comprida", ip: "6.6.6.7" });
    assert.ok(nova.ok);
  });

  test("sessão vencida ou token com formato estranho não vale", async () => {
    const r = await contas.entrarComSenha({ email: "victor@exemplo.com", senha: "nova senha comprida", ip: "7.7.7.7" });
    assert.ok(r.ok);
    const { db, schema } = amb.banco;
    const { eq } = await import("drizzle-orm");
    const { hashToken } = await import("../src/lib/auth/tokens");
    await db.update(schema.sessoes).set({ expiraEm: new Date(Date.now() - 1000) }).where(eq(schema.sessoes.tokenHash, hashToken(r.token)));
    assert.equal(await sessao.autenticar({ cookie: r.token }), null);
    assert.equal(await sessao.autenticar({ cookie: "x'; drop table usuarios; --" }), null);
    assert.equal(await sessao.autenticar({ authorization: `Bearer ${r.token}` }), null, "token do site não vale como Bearer");
  });
});

describe("volta só aceita caminho interno", () => {
  test("externos e truques caem no padrão", () => {
    for (const ruim of [
      "https://evil.com",
      "//evil.com",
      "/\\evil.com",
      "\\\\evil.com",
      "javascript:alert(1)",
      "http:/evil.com",
      " //evil.com",
      "/\n//evil.com",
      "/\t/evil.com",
      "/entrar",
      "/sair",
      "",
      null,
      undefined,
      42,
    ]) {
      assert.equal(volta.voltaSegura(ruim), "/conta", String(ruim));
    }
    assert.equal(volta.voltaSegura("/app"), "/app");
    assert.equal(volta.voltaSegura("/dispositivo?codigo=BCDF-GHJK"), "/dispositivo?codigo=BCDF-GHJK");
  });
});

describe("CSRF por Origin nas rotas com cookie", () => {
  test("POST /api/drive/token com cookie: sem Origin ou de outro site é 403; do próprio site passa", async () => {
    const r = await contas.entrarComSenha({ email: "victor@exemplo.com", senha: "nova senha comprida", ip: "8.8.8.8" });
    assert.ok(r.ok);
    const semOrigin = await token.POST(pedido("/api/drive/token", { corpo: { conta: "x" }, cookies: { sd_sessao: r.token }, origin: null }));
    assert.equal(semOrigin.status, 403);
    assert.equal((await semOrigin.json()).erro, "origem");
    const outra = await token.POST(pedido("/api/drive/token", { corpo: { conta: "x" }, cookies: { sd_sessao: r.token }, origin: "https://evil.com" }));
    assert.equal(outra.status, 403);
    const nula = await token.POST(pedido("/api/drive/token", { corpo: { conta: "x" }, cookies: { sd_sessao: r.token }, origin: "null" }));
    assert.equal(nula.status, 403);
    const certa = await token.POST(pedido("/api/drive/token", { corpo: { conta: "x" }, cookies: { sd_sessao: r.token }, origin: SITE }));
    assert.equal(certa.status, 404);
    assert.equal((await certa.json()).erro, "nao_encontrada");
  });

  test("origemConfere aceita a origem do pedido (X-Forwarded-Host) e a oficial", () => {
    const h = new Headers({ host: "interno:3000", "x-forwarded-host": "sobedesce.vercel.app", "x-forwarded-proto": "https", origin: "https://sobedesce.vercel.app" });
    assert.equal(http.origemConfere(h, undefined, "https://sobedesce.vercel.app"), true);
    h.set("origin", "https://sobedesce.vercel.app.evil.com");
    assert.equal(http.origemConfere(h, undefined, "https://sobedesce.vercel.app"), false);
  });

  test("sem sessão: 401 no formato do contrato", async () => {
    const res = await token.POST(pedido("/api/drive/token", { corpo: { conta: "x" } }));
    assert.equal(res.status, 401);
    assert.equal((await res.json()).erro, "sem_sessao");
  });
});
