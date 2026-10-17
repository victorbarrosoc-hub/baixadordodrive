/** Tela de admin: quem é admin (só pelo e-mail de um Drive conectado e confirmado pelo Google), lista, resumo e busca. */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { after, before, describe, test } from "node:test";
import { prepararAmbiente } from "./ambiente.mjs";

let amb: Awaited<ReturnType<typeof prepararAmbiente>>;
let admin: typeof import("../src/lib/admin");
let db: typeof import("../src/lib/db");

before(async () => {
  amb = await prepararAmbiente();
  admin = await import("../src/lib/admin");
  db = await import("../src/lib/db");
  const { schema } = db;
  const dia = 86_400_000;
  const agora = Date.now();
  await db.db.insert(schema.usuarios).values([
    { id: "u-victor", email: "victor@exemplo.com", nome: "Victor Barroso", senhaHash: "google", criadoEm: new Date(agora - 30 * dia), ultimoLoginEm: new Date(agora - dia) },
    { id: "u-ana", email: "ana@exemplo.com", nome: "Ána Montadora", senhaHash: "scrypt$16384$8$1$x$y", criadoEm: new Date(agora - 2 * dia), ultimoLoginEm: null },
    { id: "u-beto", email: "beto@exemplo.com", nome: "Beto Cor", senhaHash: "scrypt$16384$8$1$x$y", criadoEm: new Date(agora - 60 * dia), ultimoLoginEm: new Date(agora - 40 * dia) },
  ]);
  await db.db.insert(schema.contasGoogle).values([
    { id: "g1", usuarioId: "u-victor", googleSub: "s1", email: "Contato@Dissesim.com.br", refreshTokenEnc: "x", estado: "ok", emailVerificado: true },
    { id: "g2", usuarioId: "u-ana", googleSub: "s2", email: "ana.drive@exemplo.com", refreshTokenEnc: "x", estado: "reconectar", emailVerificado: true },
  ]);
  await db.db.insert(schema.sessoes).values([
    { id: "s1", usuarioId: "u-ana", tokenHash: "h1", tipo: "dispositivo", nome: "Mac", plataforma: "mac", ultimoUsoEm: new Date(agora - 3600_000), expiraEm: new Date(agora + 30 * dia) },
    { id: "s2", usuarioId: "u-beto", tokenHash: "h2", tipo: "dispositivo", nome: "PC", plataforma: "windows", ultimoUsoEm: new Date(agora), expiraEm: new Date(agora + dia), revogadaEm: new Date(agora) },
  ]);
});

after(async () => {
  await amb?.fechar();
});

describe("admin", () => {
  test("lista de admins: padrão e SOBEDESCE_ADMINS", () => {
    assert.deepEqual(admin.emailsAdmin({}), ["contato@dissesim.com.br"]);
    assert.deepEqual(admin.emailsAdmin({ SOBEDESCE_ADMINS: " A@x.com, b@y.com ," }), ["a@x.com", "b@y.com"]);
  });

  test("é admin pelo e-mail do Drive conectado (sem diferenciar maiúsculas)", async () => {
    assert.equal(await admin.ehAdmin({ id: "u-victor", email: "victor@exemplo.com" }), true);
    assert.equal(await admin.ehAdmin({ id: "u-ana", email: "ana@exemplo.com" }), false);
    assert.equal(await admin.ehAdmin({ id: "u-ana", email: "ana@exemplo.com" }, ["ana.drive@exemplo.com"]), true);
    assert.equal(await admin.ehAdmin({ id: "u-ana", email: "ana@exemplo.com" }, []), false);
  });

  test("o e-mail da conta não vale: criar conta não confirma o e-mail (e o padrão é público)", async () => {
    // Alguém cria uma conta com o e-mail padrão de admin, sem Drive conectado: não é admin.
    await db.db.insert(db.schema.usuarios).values({ id: "u-intruso", email: "contato@dissesim.com.br", nome: "Intruso", senhaHash: "scrypt$16384$8$1$x$y" });
    try {
      assert.equal(await admin.ehAdmin({ id: "u-intruso", email: "contato@dissesim.com.br" }), false);
      assert.equal(await admin.ehAdmin({ id: "u-ana", email: "ana@exemplo.com" }, ["ana@exemplo.com"]), false, "e-mail da conta na lista não basta");
      // Conectar um Drive de outro e-mail também não dá admin.
      await db.db.insert(db.schema.contasGoogle).values({ id: "g-intruso", usuarioId: "u-intruso", googleSub: "s-intruso", email: "intruso@gmail.com", refreshTokenEnc: "x" });
      assert.equal(await admin.ehAdmin({ id: "u-intruso", email: "contato@dissesim.com.br" }), false);
    } finally {
      await db.db.delete(db.schema.usuarios).where(eq(db.schema.usuarios.id, "u-intruso"));
    }
  });

  test("Drive com o e-mail da lista mas não confirmado pelo Google não é admin (A2)", async () => {
    // Dá para criar uma conta Google com o e-mail de outra pessoa sem confirmar: o userinfo diz email_verified false.
    await db.db.insert(db.schema.usuarios).values({ id: "u-falso", email: "falso@exemplo.com", nome: "Falso", senhaHash: "scrypt$16384$8$1$x$y" });
    try {
      await db.db.insert(db.schema.contasGoogle).values({ id: "g-falso", usuarioId: "u-falso", googleSub: "s-falso", email: "contato@dissesim.com.br", refreshTokenEnc: "x" });
      assert.equal(await admin.ehAdmin({ id: "u-falso" }), false);
      await db.db.update(db.schema.contasGoogle).set({ emailVerificado: true }).where(eq(db.schema.contasGoogle.id, "g-falso"));
      assert.equal(await admin.ehAdmin({ id: "u-falso" }), true, "confirmado, vale");
    } finally {
      await db.db.delete(db.schema.usuarios).where(eq(db.schema.usuarios.id, "u-falso"));
    }
  });

  test("lista, resumo e computadores (sessão revogada não conta)", async () => {
    const { pessoas, resumo } = await admin.listarPessoas();
    assert.deepEqual(
      pessoas.map((p) => p.id),
      ["u-ana", "u-victor", "u-beto"],
    );
    const ana = pessoas[0];
    assert.equal(ana.computadores, 1);
    assert.equal(ana.comSenha, true);
    assert.equal(ana.drives[0].estado, "reconectar");
    assert.ok(ana.ultimoUsoEm, "último uso vem da sessão do computador");
    assert.equal(pessoas[1].comSenha, false, "conta do Google não tem senha");
    assert.equal(pessoas[2].computadores, 0);
    assert.deepEqual(resumo, { contas: 3, drivesOk: 1, drivesReconectar: 1, ativos7d: 2, novas7d: 1, computadores: 1 });
  });

  test("busca por nome sem acento e por e-mail do Drive", async () => {
    const { pessoas } = await admin.listarPessoas();
    assert.deepEqual(admin.filtrarPessoas(pessoas, "ana mont").map((p) => p.id), ["u-ana"]);
    assert.deepEqual(admin.filtrarPessoas(pessoas, "dissesim").map((p) => p.id), ["u-victor"]);
    assert.equal(admin.filtrarPessoas(pessoas, "  ").length, 3);
  });
});
