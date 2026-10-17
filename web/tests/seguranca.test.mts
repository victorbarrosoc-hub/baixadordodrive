/**
 * Rodada 2 de segurança no site: migração do "Google de entrar" (A3) e do e-mail confirmado (A2) em contas que já
 * existem, limite de login por conta de qualquer IP (A10), links de senha apagados de verdade (A15) e HSTS em todo
 * o site (A12). O resto do A3 e o A5 estão em google.test.mts; o A6, em dispositivo.test.mts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, test } from "node:test";
import nextConfig from "../next.config";
import { prepararAmbiente } from "./ambiente.mjs";

let amb: Awaited<ReturnType<typeof prepararAmbiente>>;
let contas: typeof import("../src/lib/auth/contas");
let redefinir: typeof import("../src/lib/auth/redefinir");
let drizzle: typeof import("drizzle-orm");

before(async () => {
  amb = await prepararAmbiente();
  contas = await import("../src/lib/auth/contas");
  redefinir = await import("../src/lib/auth/redefinir");
  drizzle = await import("drizzle-orm");
});

after(async () => {
  await amb?.fechar();
});

const DIA = 86_400_000;

describe("migração 0004: quem já existe continua entrando", () => {
  /** Os dois UPDATE da migração (o "antes" é o banco com tudo desligado, como fica logo depois do ALTER TABLE). */
  function updatesDaMigracao(): string[] {
    const arquivo = fs.readdirSync(new URL("../drizzle/", import.meta.url)).find((f) => f.startsWith("0004_"));
    assert.ok(arquivo);
    const sqlTexto = fs.readFileSync(new URL(`../drizzle/${arquivo}`, import.meta.url), "utf8");
    const updates = sqlTexto.split("--> statement-breakpoint").filter((s) => /^\s*UPDATE/m.test(s));
    assert.equal(updates.length, 2);
    return updates;
  }

  test("um Google de entrar por conta: o de mesmo e-mail da conta, senão o mais antigo; e-mail confirmado só no que criou a conta", async () => {
    const { db, schema } = amb.banco;
    const { sql, eq } = drizzle;
    const agora = Date.now();
    const scrypt = "scrypt$16384$8$1$x$y";
    await db.insert(schema.usuarios).values([
      // Criada pelo "Continuar com Google" e depois com um Drive de cliente.
      { id: "m-google", email: "ana@gmail.com", nome: "Ana", senhaHash: "google" },
      // Criada com senha; o Drive do cliente foi conectado antes do próprio.
      { id: "m-senha", email: "beto@produtora.com", nome: "Beto", senhaHash: scrypt },
      // Criada com senha; nenhum Drive com o e-mail da conta.
      { id: "m-outro", email: "caio@produtora.com", nome: "Caio", senhaHash: scrypt },
      // Criada com senha, sem Drive.
      { id: "m-vazia", email: "dani@produtora.com", nome: "Dani", senhaHash: scrypt },
      // Criada pelo Google, que depois trocou de e-mail lá no Google.
      { id: "m-trocou", email: "eva@gmail.com", nome: "Eva", senhaHash: "google" },
    ]);
    const g = (id: string, usuarioId: string, email: string, diasAtras: number) => ({
      id,
      usuarioId,
      googleSub: `sub-${id}`,
      email,
      refreshTokenEnc: "x",
      criadoEm: new Date(agora - diasAtras * DIA),
    });
    await db.insert(schema.contasGoogle).values([
      g("g-ana", "m-google", "ana@gmail.com", 30),
      g("g-ana-cliente", "m-google", "entregas@cliente.com", 10),
      g("g-beto-cliente", "m-senha", "drive@cliente.com", 20),
      g("g-beto", "m-senha", "Beto@Produtora.com", 5),
      g("g-caio-1", "m-outro", "caio.pessoal@gmail.com", 9),
      g("g-caio-2", "m-outro", "arquivo@cliente.com", 3),
      g("g-eva", "m-trocou", "eva.nova@gmail.com", 40),
      g("g-eva-cliente", "m-trocou", "eva@cliente.com", 2),
    ]);

    for (const u of updatesDaMigracao()) await db.execute(sql.raw(u));

    const linhas = await db.select().from(schema.contasGoogle);
    const login = linhas.filter((l) => l.loginPermitido).map((l) => l.id).sort();
    assert.deepEqual(login, ["g-ana", "g-beto", "g-caio-1", "g-eva"]);
    const confirmados = linhas.filter((l) => l.emailVerificado).map((l) => l.id);
    assert.deepEqual(confirmados, ["g-ana"], "só o Google que criou a conta e ainda tem o e-mail dela");

    // O índice único não deixa dois Googles de entrar na mesma conta.
    await assert.rejects(db.update(schema.contasGoogle).set({ loginPermitido: true }).where(eq(schema.contasGoogle.id, "g-ana-cliente")));
    // Rodar de novo não muda nada (a migração roda uma vez, mas não custa conferir que não duplica).
    await db.update(schema.contasGoogle).set({ loginPermitido: false, emailVerificado: false });
    for (const u of updatesDaMigracao()) await db.execute(sql.raw(u));
    assert.deepEqual(
      (await db.select().from(schema.contasGoogle)).filter((l) => l.loginPermitido).map((l) => l.id).sort(),
      ["g-ana", "g-beto", "g-caio-1", "g-eva"],
    );
    await db.delete(schema.usuarios).where(drizzle.inArray(schema.usuarios.id, ["m-google", "m-senha", "m-outro", "m-vazia", "m-trocou"]));
  });
});

describe("limite de login por conta (A10)", () => {
  test("30 senhas erradas de 30 IPs diferentes travam a conta por um tempo; e-mail sem conta trava igual", async () => {
    const SENHA = "senha certa comprida";
    const r = await contas.criarConta({ nome: "Alvo", email: "alvo@exemplo.com", senha: SENHA, ip: "50.0.0.1" });
    assert.ok(r.ok);
    for (const email of ["alvo@exemplo.com", "ninguem.aqui@exemplo.com"]) {
      for (let i = 0; i < 30; i++) {
        const e = await contas.entrarComSenha({ email, senha: `errada-${i}-xxxxxx`, ip: `60.0.${i}.1` });
        assert.ok(!e.ok && e.erro === "credenciais", `tentativa ${i + 1} ainda conta como senha errada`);
      }
      const travada = await contas.entrarComSenha({ email, senha: SENHA, ip: "70.0.0.1" });
      assert.ok(!travada.ok);
      assert.equal(travada.erro, "devagar", `${email}: nem a senha certa, de um IP novo`);
      assert.equal(travada.mensagem, "Muitas tentativas seguidas. Espere alguns minutos e tente de novo.");
    }
    // Outra conta continua entrando normalmente desses IPs.
    const outra = await contas.criarConta({ nome: "Outra", email: "outra@exemplo.com", senha: SENHA, ip: "50.0.0.2" });
    assert.ok(outra.ok);
    assert.ok((await contas.entrarComSenha({ email: "outra@exemplo.com", senha: SENHA, ip: "60.0.1.1" })).ok);
    // Passada a janela de uma hora, a conta volta a entrar.
    const { db, schema } = amb.banco;
    await db
      .update(schema.tentativas)
      .set({ quando: new Date(Date.now() - 61 * 60_000) })
      .where(drizzle.eq(schema.tentativas.chave, "login-conta:alvo@exemplo.com"));
    assert.ok((await contas.entrarComSenha({ email: "alvo@exemplo.com", senha: SENHA, ip: "70.0.0.2" })).ok);
  });
});

describe("links de senha saem do banco (A15)", () => {
  let tarefas: Promise<unknown>[] = [];
  const depois = (t: () => Promise<unknown>) => void tarefas.push(t());
  const esperar = async () => {
    await Promise.all(tarefas);
    tarefas = [];
  };
  const linhas = async () => amb.banco.db.select().from(amb.banco.schema.redefinicoesSenha);

  test("usado: some na hora; vencido: some no próximo pedido ou ao abrir um link", async () => {
    await contas.criarConta({ nome: "Link", email: "link@exemplo.com", senha: "senha antiga comprida", ip: "80.0.0.1" });
    await redefinir.pedirRedefinicao({ email: "link@exemplo.com", ip: "80.0.0.2", depois });
    await esperar();
    const token = /\/nova-senha\?token=([A-Za-z0-9_-]{43})/.exec(amb.resend.recebidos.at(-1)!.text)![1];
    assert.equal((await linhas()).length, 1);
    assert.ok((await redefinir.redefinirSenha({ token, senha: "senha nova comprida" })).ok);
    assert.equal((await linhas()).length, 0, "usado: apagado, não só marcado");

    // Vencido sem uso: o próximo pedido (de qualquer pessoa) apaga.
    await redefinir.pedirRedefinicao({ email: "link@exemplo.com", ip: "80.0.0.3", depois });
    await esperar();
    const { db, schema } = amb.banco;
    await db.update(schema.redefinicoesSenha).set({ expiraEm: new Date(Date.now() - 1000) });
    assert.equal((await linhas()).length, 1);
    await redefinir.pedirRedefinicao({ email: "ninguem.mesmo@exemplo.com", ip: "80.0.0.4", depois });
    await esperar();
    assert.equal((await linhas()).length, 0, "vencido: apagado");

    // Abrir um link vencido também limpa.
    await redefinir.pedirRedefinicao({ email: "link@exemplo.com", ip: "80.0.0.5", depois });
    await esperar();
    const vencido = /\/nova-senha\?token=([A-Za-z0-9_-]{43})/.exec(amb.resend.recebidos.at(-1)!.text)![1];
    await db.update(schema.redefinicoesSenha).set({ expiraEm: new Date(Date.now() - 1000) });
    assert.equal(await redefinir.linkValido(vencido), false);
    assert.equal((await linhas()).length, 0);
  });

  test("apagarLinksVencidos não toca no link que ainda vale", async () => {
    await contas.criarConta({ nome: "Vale", email: "vale@exemplo.com", senha: "senha antiga comprida", ip: "80.0.0.7" });
    const r = await redefinir.pedirRedefinicao({ email: "vale@exemplo.com", ip: "80.0.0.6", depois });
    assert.ok(r.ok);
    await esperar();
    assert.equal(await redefinir.apagarLinksVencidos(), 0);
    assert.equal((await linhas()).length, 1);
  });
});

describe("cabeçalhos e endereços (A12 e site)", () => {
  test("HSTS em todo o site, não só em /app/", async () => {
    const regras = await nextConfig.headers!();
    const todas = regras.find((r) => r.source === "/:path*");
    assert.ok(todas);
    const hsts = todas.headers.find((h) => h.key === "Strict-Transport-Security");
    assert.equal(hsts?.value, "max-age=63072000; includeSubDomains");
  });

  test("/instalar leva para a seção de baixar da home (o id existe)", async () => {
    const r = (await nextConfig.redirects!()).find((x) => x.source === "/instalar");
    assert.ok(r);
    assert.equal(r.destination, "/#baixar");
    const secao = fs.readFileSync(new URL("../src/components/home/platforms-section.tsx", import.meta.url), "utf8");
    assert.match(secao, /<section id="baixar"/);
  });
});
