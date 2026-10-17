/**
 * Fluxo de dispositivo completo: iniciar → (pendente, ritmo) → aprovar → aguardar devolve o token
 * uma vez → Bearer vale em /api/eu → sair revoga. Mais: código vencido, cancelado e segredo inventado.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { pedido, prepararAmbiente, SITE } from "./ambiente.mjs";

let amb: Awaited<ReturnType<typeof prepararAmbiente>>;
let dispositivo: typeof import("../src/lib/dispositivo");
let iniciar: typeof import("../src/app/api/dispositivo/iniciar/route");
let aguardar: typeof import("../src/app/api/dispositivo/aguardar/route");
let sair: typeof import("../src/app/api/dispositivo/sair/route");
let eu: typeof import("../src/app/api/eu/route");
let sessao: typeof import("../src/lib/auth/sessao");
let drizzle: typeof import("drizzle-orm");
let usuario: { id: string; token: string };

before(async () => {
  amb = await prepararAmbiente();
  dispositivo = await import("../src/lib/dispositivo");
  iniciar = await import("../src/app/api/dispositivo/iniciar/route");
  aguardar = await import("../src/app/api/dispositivo/aguardar/route");
  sair = await import("../src/app/api/dispositivo/sair/route");
  eu = await import("../src/app/api/eu/route");
  sessao = await import("../src/lib/auth/sessao");
  drizzle = await import("drizzle-orm");
  const { criarConta } = await import("../src/lib/auth/contas");
  const r = await criarConta({ nome: "Victor", email: "victor@exemplo.com", senha: "senha do victor", ip: "1.2.3.4" });
  assert.ok(r.ok);
  usuario = { id: r.usuario.id, token: r.token };
});

after(async () => {
  await amb?.fechar();
});

/** Zera a marca de ritmo (no teste não esperamos os 3 s do intervalo). */
async function liberarRitmo() {
  const { db, schema } = amb.banco;
  await db.update(schema.codigosDispositivo).set({ consultadoEm: null });
}

async function consultar(segredo: unknown) {
  return aguardar.POST(pedido("/api/dispositivo/aguardar", { corpo: { segredo }, origin: null }));
}

describe("fluxo de dispositivo", () => {
  let codigo: string;
  let segredo: string;
  let token: string;

  test("iniciar devolve código legível, segredo, url, intervalo e validade", async () => {
    const res = await iniciar.POST(pedido("/api/dispositivo/iniciar", { corpo: { nome: "MacBook Pro de Victor", plataforma: "mac" }, origin: null, ip: "10.0.0.1" }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const r = await res.json();
    assert.match(r.codigo, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    assert.match(r.segredo, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(r.url, `${SITE}/dispositivo?codigo=${r.codigo}`);
    assert.equal(r.intervalo, 3);
    assert.ok(r.expiraEm > Date.now() + 9 * 60_000 && r.expiraEm <= Date.now() + 10 * 60_000);
    codigo = r.codigo;
    segredo = r.segredo;
    const { db, schema } = amb.banco;
    const [linha] = await db.select().from(schema.codigosDispositivo);
    assert.notEqual(linha.segredoHash, segredo, "só o hash do segredo no banco");
  });

  test("antes de liberar: 202 pendente; consulta rápida demais: 429", async () => {
    const r1 = await consultar(segredo);
    assert.equal(r1.status, 202);
    assert.deepEqual(await r1.json(), { estado: "pendente" });
    const r2 = await consultar(segredo);
    assert.equal(r2.status, 429);
    assert.equal((await r2.json()).erro, "devagar");
  });

  test("a tela de liberar acha o pedido pelo código (aceita minúsculas e sem hífen)", async () => {
    const normal = dispositivo.normalizarCodigo(codigo.toLowerCase().replace("-", " "));
    assert.equal(normal, codigo);
    const p = await dispositivo.buscarPedido(codigo);
    assert.ok(p);
    assert.equal(p.nome, "MacBook Pro de Victor");
    assert.equal(p.plataforma, "mac");
    assert.equal(p.aprovado, false);
  });

  test("a tela de liberar mostra quando e de onde veio o pedido (A6)", async () => {
    const p = await dispositivo.buscarPedido(codigo);
    assert.ok(p);
    assert.ok(Date.now() - p.criadoEm.getTime() < 60_000, "quando: agora há pouco");
    assert.deepEqual(p.lugar, { ip: "10.0.0.1", cidade: null, pais: null }, "fora da Vercel, só o IP");
    assert.equal(dispositivo.mesmaRede(p.lugar.ip, "10.0.0.1"), true);
    assert.equal(dispositivo.mesmaRede(p.lugar.ip, "10.0.0.2"), false);
    assert.equal(dispositivo.mesmaRede(null, null), false, "sem IP não diz que é a mesma rede");
  });

  test("liberar e buscar: o token sai uma vez só", async () => {
    assert.equal(await dispositivo.aprovar(codigo, usuario.id), true);
    assert.equal(await dispositivo.aprovar(codigo, usuario.id), false, "não aprova duas vezes");
    await liberarRitmo();
    const r = await consultar(segredo);
    assert.equal(r.status, 200);
    const corpo = await r.json();
    assert.equal(corpo.estado, "pronto");
    assert.match(corpo.token, /^sdd_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(corpo.usuario, { id: usuario.id, email: "victor@exemplo.com", nome: "Victor" });
    token = corpo.token;
    await liberarRitmo();
    const deNovo = await consultar(segredo);
    assert.equal(deNovo.status, 410);
    assert.equal((await deNovo.json()).erro, "expirado");
    assert.equal(await dispositivo.buscarPedido(codigo), null, "o código usado some da tela");
    const { db, schema } = amb.banco;
    const [linha] = await db.select().from(schema.codigosDispositivo).where(drizzle.eq(schema.codigosDispositivo.codigo, codigo));
    assert.deepEqual([linha.pedidoIp, linha.pedidoCidade, linha.pedidoPais], [null, null, null], "de onde veio sai junto com o uso");
  });

  test("o Bearer vale em /api/eu (sem cookie) e aparece nos computadores da conta", async () => {
    const res = await eu.GET(pedido("/api/eu", { bearer: token }));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).usuario.id, usuario.id);
    const lista = await sessao.listarDispositivos(usuario.id);
    assert.equal(lista.length, 1);
    assert.equal(lista[0].nome, "MacBook Pro de Victor");
    assert.equal(lista[0].plataforma, "mac");
    // Com Authorization, o cookie é ignorado: Bearer ruim + cookie bom = 401.
    const misto = await eu.GET(pedido("/api/eu", { bearer: "sdd_" + "x".repeat(43), cookies: { sd_sessao: usuario.token } }));
    assert.equal(misto.status, 401);
  });

  test("sair revoga a sessão do computador", async () => {
    const semBearer = await sair.POST(pedido("/api/dispositivo/sair", { corpo: {}, cookies: { sd_sessao: usuario.token } }));
    assert.equal(semBearer.status, 401, "sair do computador não aceita cookie");
    const res = await sair.POST(pedido("/api/dispositivo/sair", { method: "POST", bearer: token, origin: null }));
    assert.equal(res.status, 204);
    assert.equal((await eu.GET(pedido("/api/eu", { bearer: token }))).status, 401);
    assert.equal((await sessao.listarDispositivos(usuario.id)).length, 0);
  });

  test("desconectar pela conta também derruba o computador", async () => {
    const s = await sessao.criarSessao(usuario.id, "dispositivo", { nome: "PC do estúdio", plataforma: "windows" });
    const [d] = await sessao.listarDispositivos(usuario.id);
    assert.equal(await sessao.revogarDispositivo("outro-usuario", d.id), false);
    assert.equal(await sessao.revogarDispositivo(usuario.id, d.id), true);
    assert.equal((await eu.GET(pedido("/api/eu", { bearer: s.token }))).status, 401);
  });
});

describe("pedidos que não servem", () => {
  test("segredo inventado ou ausente: 410", async () => {
    assert.equal((await consultar("x".repeat(43))).status, 410);
    assert.equal((await consultar(undefined)).status, 410);
    assert.equal((await aguardar.POST(pedido("/api/dispositivo/aguardar", { corpo: "lixo", origin: null }))).status, 410);
  });

  test("código vencido: some da tela, não aprova e o computador recebe 410", async () => {
    const r = await (await iniciar.POST(pedido("/api/dispositivo/iniciar", { corpo: { nome: "Velho", plataforma: "linux" }, origin: null }))).json();
    const { db, schema } = amb.banco;
    await db
      .update(schema.codigosDispositivo)
      .set({ expiraEm: new Date(Date.now() - 1000) })
      .where(drizzle.eq(schema.codigosDispositivo.codigo, r.codigo));
    assert.equal(await dispositivo.buscarPedido(r.codigo), null);
    assert.equal(await dispositivo.aprovar(r.codigo, usuario.id), false);
    assert.equal((await consultar(r.segredo)).status, 410);
  });

  test("cancelar (não fui eu) vence o código na hora", async () => {
    const r = await (await iniciar.POST(pedido("/api/dispositivo/iniciar", { corpo: { nome: "Estranho", plataforma: "solaris" }, origin: null }))).json();
    const p = await dispositivo.buscarPedido(r.codigo);
    assert.equal(p?.plataforma, null, "plataforma desconhecida vira null");
    await dispositivo.cancelar(r.codigo);
    assert.equal(await dispositivo.buscarPedido(r.codigo), null);
    await liberarRitmo();
    assert.equal((await consultar(r.segredo)).status, 410);
  });

  test("na Vercel: cidade e país pelos cabeçalhos dela, com nome do país em português", async () => {
    const { lugarDe } = await import("../src/lib/http");
    const h = new Headers({ "x-real-ip": "177.10.20.30", "x-vercel-ip-city": "S%C3%A3o%20Paulo", "x-vercel-ip-country": "BR" });
    assert.deepEqual(lugarDe(h, { VERCEL: "1" }), { ip: "177.10.20.30", cidade: "São Paulo", pais: "BR" });
    assert.deepEqual(lugarDe(h, {}), { ip: "177.10.20.30", cidade: null, pais: null }, "fora da Vercel o cabeçalho pode ser de quem pediu");
    const lixo = new Headers({ "x-vercel-ip-city": "%E0%A4%A", "x-vercel-ip-country": "<script>" });
    assert.deepEqual(lugarDe(lixo, { VERCEL: "1" }), { ip: null, cidade: "%E0%A4%A", pais: null });
    assert.equal(dispositivo.lugarLegivel({ cidade: "Natal", pais: "BR" }), "Natal, Brasil");
    assert.equal(dispositivo.lugarLegivel({ cidade: null, pais: "PT" }), "Portugal");
    assert.equal(dispositivo.lugarLegivel({ cidade: null, pais: null }), null);

    const prev = process.env.VERCEL;
    process.env.VERCEL = "1";
    try {
      const res = await iniciar.POST(
        new Request(`${SITE}/api/dispositivo/iniciar`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-real-ip": "200.1.2.3", "x-vercel-ip-city": "Natal", "x-vercel-ip-country": "BR" },
          body: JSON.stringify({ nome: "MacBook Pro de Victor", plataforma: "mac" }),
        }),
      );
      const r = await res.json();
      const p = await dispositivo.buscarPedido(r.codigo);
      assert.deepEqual(p?.lugar, { ip: "200.1.2.3", cidade: "Natal", pais: "BR" });
      await dispositivo.cancelar(r.codigo);
      const { db, schema } = amb.banco;
      const [linha] = await db.select().from(schema.codigosDispositivo).where(drizzle.eq(schema.codigosDispositivo.codigo, r.codigo));
      assert.equal(linha.pedidoIp, null, "não fui eu: o IP sai na hora");
    } finally {
      if (prev === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = prev;
    }
  });

  test("nome do computador é limpo e tem limite", () => {
    assert.equal(dispositivo.nomeDoComputador("  Mac\u0000  de\nVictor "), "Mac de Victor");
    assert.equal(dispositivo.nomeDoComputador("x".repeat(500)).length, 80);
    assert.equal(dispositivo.nomeDoComputador(null), "Computador");
    assert.equal(dispositivo.normalizarCodigo("AAAA-AAAA"), null, "vogal não existe no alfabeto");
  });

  test("limite de pedidos de código por IP", async () => {
    let ultimo = 200;
    for (let i = 0; i < 31; i++) {
      const res = await iniciar.POST(pedido("/api/dispositivo/iniciar", { corpo: { nome: "Spam" }, origin: null, ip: "66.66.66.66" }));
      ultimo = res.status;
    }
    assert.equal(ultimo, 429);
  });
});
