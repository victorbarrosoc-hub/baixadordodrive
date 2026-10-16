/**
 * Google contra o Google falso: vincular (e conta Google de outro usuário), recusar, entrar com Google,
 * token reaproveitado vs renovado (uma renovação por vez), invalid_grant → reconectar/409,
 * reconectar, remover (revoga) e `volta` externo recusado.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { CONTA_ANA, CONTA_BETO, cookiesDe, pedido, prepararAmbiente, SITE } from "./ambiente.mjs";
import type { ContaFalsa } from "./google-falso.mjs";

let amb: Awaited<ReturnType<typeof prepararAmbiente>>;
let contas: typeof import("../src/lib/auth/contas");
let conectar: typeof import("../src/app/api/google/conectar/route");
let callback: typeof import("../src/app/api/google/callback/route");
let eu: typeof import("../src/app/api/eu/route");
let driveContas: typeof import("../src/app/api/drive/contas/route");
let token: typeof import("../src/app/api/drive/token/route");
let contasGoogle: typeof import("../src/lib/google/contas");
let drizzle: typeof import("drizzle-orm");

let victor: { id: string; token: string };
let edu: { id: string; token: string };

before(async () => {
  amb = await prepararAmbiente();
  contas = await import("../src/lib/auth/contas");
  conectar = await import("../src/app/api/google/conectar/route");
  callback = await import("../src/app/api/google/callback/route");
  eu = await import("../src/app/api/eu/route");
  driveContas = await import("../src/app/api/drive/contas/route");
  token = await import("../src/app/api/drive/token/route");
  contasGoogle = await import("../src/lib/google/contas");
  drizzle = await import("drizzle-orm");
  const v = await contas.criarConta({ nome: "Victor", email: "victor@exemplo.com", senha: "senha do victor", ip: "9.9.9.1" });
  const e = await contas.criarConta({ nome: "Edu", email: "edu@exemplo.com", senha: "senha do edu!!", ip: "9.9.9.2" });
  assert.ok(v.ok && e.ok);
  victor = { id: v.usuario.id, token: v.token };
  edu = { id: e.usuario.id, token: e.token };
});

after(async () => {
  await amb?.fechar();
});

/**
 * O caminho inteiro no navegador: /api/google/conectar → Google falso (consentimento) → /api/google/callback.
 * Devolve a resposta do callback e o destino final (caminho + busca).
 */
async function fluxo(o: { modo: "vincular" | "entrar"; conta: ContaFalsa | null; sessao?: string; volta?: string; negar?: boolean; escopo?: string }) {
  amb.google.proximo.conta = o.conta;
  amb.google.proximo.negar = Boolean(o.negar);
  amb.google.proximo.escopo = o.escopo ?? null;
  const q = new URLSearchParams({ modo: o.modo });
  if (o.volta !== undefined) q.set("volta", o.volta);
  const ida = await conectar.GET(pedido(`/api/google/conectar?${q}`, { cookies: { sd_sessao: o.sessao } }));
  const destinoIda = ida.headers.get("location") ?? "";
  if (ida.status !== 302 || !destinoIda.startsWith(amb.google.url)) return { ida, destino: destinoIda, res: null as Response | null };
  const u = new URL(destinoIda);
  assert.equal(u.searchParams.get("scope"), "openid email profile https://www.googleapis.com/auth/drive");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("redirect_uri"), `${SITE}/api/google/callback`);
  const cookieOAuth = cookiesDe(ida).get("sd_google");
  assert.ok(cookieOAuth);
  assert.match(ida.headers.getSetCookie()[0], /HttpOnly/);
  assert.match(ida.headers.getSetCookie()[0], /Path=\/api\/google/);
  assert.ok(!ida.headers.getSetCookie()[0].includes(u.searchParams.get("state")!), "state não vai aberto no cookie");

  const google = await fetch(destinoIda, { redirect: "manual" });
  assert.equal(google.status, 302);
  const volta = google.headers.get("location")!;
  const res = await callback.GET(pedido(volta.replace(SITE, ""), { cookies: { sd_google: cookieOAuth, sd_sessao: o.sessao } }));
  assert.equal(res.status, 303);
  assert.equal(cookiesDe(res).get("sd_google"), "", "o cookie do OAuth é apagado na volta");
  const destino = new URL(res.headers.get("location")!, SITE);
  return { ida, res, destino: destino.pathname + destino.search };
}

async function contasDe(sessao: string) {
  const res = await driveContas.GET(pedido("/api/drive/contas", { cookies: { sd_sessao: sessao } }));
  assert.equal(res.status, 200);
  return (await res.json()).contas as { id: string; email: string; nome: string; fotoUrl: string | null; estado: string }[];
}

async function pedirToken(sessao: string, conta: string, renovar?: boolean) {
  return token.POST(pedido("/api/drive/token", { corpo: { conta, renovar }, cookies: { sd_sessao: sessao } }));
}

describe("vincular", () => {
  test("sem sessão: conectar manda entrar e volta para cá depois", async () => {
    const r = await fluxo({ modo: "vincular", conta: CONTA_ANA });
    assert.equal(r.ida.status, 303);
    assert.equal(r.destino.replace(SITE, ""), "/entrar?volta=%2Fconta");
  });

  test("Victor conecta a conta da Ana: aparece em /api/eu, sem token nenhum na resposta", async () => {
    const r = await fluxo({ modo: "vincular", conta: CONTA_ANA, sessao: victor.token });
    assert.equal(r.destino, "/conta?google=ok");
    const res = await eu.GET(pedido("/api/eu", { cookies: { sd_sessao: victor.token } }));
    const texto = await res.text();
    assert.ok(!/refresh|ya29|1\/\//i.test(texto), "nada de token na resposta");
    const corpo = JSON.parse(texto);
    assert.equal(corpo.contas.length, 1);
    assert.deepEqual(Object.keys(corpo.contas[0]).sort(), ["email", "estado", "fotoUrl", "id", "nome"]);
    assert.equal(corpo.contas[0].email, "ana@exemplo.com");
    assert.equal(corpo.contas[0].estado, "ok");

    const { db, schema } = amb.banco;
    const [linha] = await db.select().from(schema.contasGoogle);
    assert.match(linha.refreshTokenEnc, /^v1\./, "refresh cifrado");
    assert.ok(!linha.refreshTokenEnc.includes("1//"));
    assert.match(linha.accessTokenEnc ?? "", /^v1\./);
  });

  test("a conta Google da Ana não entra em outra conta SOBEDESCE", async () => {
    const r = await fluxo({ modo: "vincular", conta: CONTA_ANA, sessao: edu.token });
    assert.equal(r.destino, "/conta?erro=google_outra_conta");
    assert.equal((await contasDe(edu.token)).length, 0);
    assert.equal((await contasDe(victor.token)).length, 1, "a do Victor continua");
    assert.ok(amb.google.refreshVivos() >= 1, "nada foi revogado");
  });

  test("recusar no Google volta com mensagem calma e não grava nada", async () => {
    const r = await fluxo({ modo: "vincular", conta: CONTA_BETO, sessao: edu.token, negar: true });
    assert.equal(r.destino, "/conta?erro=google_recusado");
    assert.equal((await contasDe(edu.token)).length, 0);
  });

  test("sem marcar o Drive no consentimento: avisa e não grava", async () => {
    const r = await fluxo({ modo: "vincular", conta: CONTA_BETO, sessao: edu.token, escopo: "openid email profile" });
    assert.equal(r.destino, "/conta?erro=google_sem_drive");
    assert.equal((await contasDe(edu.token)).length, 0);
  });

  test("volta externo é ignorado (fica /conta)", async () => {
    const r = await fluxo({ modo: "vincular", conta: CONTA_BETO, sessao: edu.token, volta: "https://evil.com/roubar" });
    assert.equal(r.destino, "/conta?google=ok");
    assert.equal((await contasDe(edu.token))[0].email, "beto@exemplo.com");
  });

  test("callback com state trocado ou sem cookie não grava", async () => {
    amb.google.proximo.conta = CONTA_BETO;
    const ida = await conectar.GET(pedido("/api/google/conectar?modo=vincular", { cookies: { sd_sessao: edu.token } }));
    const cookieOAuth = cookiesDe(ida).get("sd_google")!;
    const google = await fetch(ida.headers.get("location")!, { redirect: "manual" });
    const volta = new URL(google.headers.get("location")!);
    volta.searchParams.set("state", "outro-state");
    const trocado = await callback.GET(pedido(volta.pathname + volta.search, { cookies: { sd_google: cookieOAuth, sd_sessao: edu.token } }));
    assert.equal(new URL(trocado.headers.get("location")!).pathname + new URL(trocado.headers.get("location")!).search, "/conta?erro=google_expirou");
    const semCookie = await callback.GET(pedido(volta.pathname + volta.search, { cookies: { sd_sessao: edu.token } }));
    assert.match(semCookie.headers.get("location")!, /\/conta\?erro=google_expirou$/);
  });
});

describe("entrar com Google", () => {
  test("conta Google vinculada: cria a sessão do dono e vai para volta", async () => {
    const r = await fluxo({ modo: "entrar", conta: CONTA_ANA, volta: "/app" });
    assert.equal(r.destino, "/app");
    const nova = cookiesDe(r.res!).get("sd_sessao");
    assert.ok(nova);
    assert.match(r.res!.headers.getSetCookie().find((c) => c.startsWith("sd_sessao="))!, /HttpOnly; SameSite=Lax/);
    const res = await eu.GET(pedido("/api/eu", { cookies: { sd_sessao: nova } }));
    assert.equal((await res.json()).usuario.id, victor.id);
  });

  test("conta Google não vinculada: volta para /entrar explicando", async () => {
    const r = await fluxo({ modo: "entrar", conta: { sub: "999", email: "novo@exemplo.com", name: "Novo" } });
    assert.equal(r.destino, "/entrar?erro=google_sem_conta");
    assert.equal(cookiesDe(r.res!).get("sd_sessao"), undefined);
  });

  test("recusar ao entrar volta para /entrar com a volta guardada", async () => {
    const r = await fluxo({ modo: "entrar", conta: CONTA_ANA, negar: true, volta: "/dispositivo?codigo=BCDF-GHJK" });
    assert.equal(r.destino, "/entrar?erro=google_recusado&volta=%2Fdispositivo%3Fcodigo%3DBCDF-GHJK");
  });
});

describe("token do Drive", () => {
  let anaId: string;

  test("reaproveita o token guardado enquanto faltar mais de 5 minutos", async () => {
    anaId = (await contasDe(victor.token))[0].id;
    const antes = amb.google.contadores.renovacoes;
    const r1 = await pedirToken(victor.token, anaId);
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get("cache-control"), "no-store");
    const t1 = await r1.json();
    assert.deepEqual(Object.keys(t1).sort(), ["accessToken", "email", "expiraEm"]);
    assert.equal(t1.email, "ana@exemplo.com");
    assert.ok(t1.expiraEm > Date.now() + 50 * 60_000);
    assert.ok(amb.google.acessoValido(t1.accessToken));
    const t2 = await (await pedirToken(victor.token, anaId)).json();
    assert.equal(t2.accessToken, t1.accessToken);
    assert.equal(amb.google.contadores.renovacoes, antes, "nenhuma renovação");
  });

  test("perto de vencer renova; renovar=true força; pedidos juntos renovam uma vez só", async () => {
    const { db, schema } = amb.banco;
    const { eq } = drizzle;
    await db.update(schema.contasGoogle).set({ accessExpiraEm: new Date(Date.now() + 4 * 60_000) }).where(eq(schema.contasGoogle.id, anaId));
    const antes = amb.google.contadores.renovacoes;
    const velho = (await db.select().from(schema.contasGoogle).where(eq(schema.contasGoogle.id, anaId)))[0].accessTokenEnc;
    const r = await (await pedirToken(victor.token, anaId)).json();
    assert.equal(amb.google.contadores.renovacoes, antes + 1);
    assert.ok(amb.google.acessoValido(r.accessToken));
    const novo = (await db.select().from(schema.contasGoogle).where(eq(schema.contasGoogle.id, anaId)))[0].accessTokenEnc;
    assert.notEqual(novo, velho);

    const forcado = await (await pedirToken(victor.token, anaId, true)).json();
    assert.notEqual(forcado.accessToken, r.accessToken);
    assert.equal(amb.google.contadores.renovacoes, antes + 2);

    const juntos = await Promise.all([1, 2, 3, 4].map(() => pedirToken(victor.token, anaId, true)));
    const tokens = await Promise.all(juntos.map((x) => x.json()));
    assert.ok(juntos.every((x) => x.status === 200));
    assert.equal(new Set(tokens.map((t) => t.accessToken)).size, 1, "todos recebem o mesmo token novo");
    assert.equal(amb.google.contadores.renovacoes, antes + 3, "uma renovação para os quatro");
  });

  test("conta de outra pessoa ou inexistente: 404; corpo ruim: 400", async () => {
    const outra = await pedirToken(edu.token, anaId);
    assert.equal(outra.status, 404);
    assert.equal((await outra.json()).erro, "nao_encontrada");
    const ruim = await token.POST(pedido("/api/drive/token", { corpo: "{nada", cookies: { sd_sessao: victor.token } }));
    assert.equal(ruim.status, 400);
    assert.equal((await ruim.json()).erro, "entrada");
  });

  test("invalid_grant: conta vira reconectar e o token responde 409 (sem chamar o Google de novo)", async () => {
    amb.google.revogarTodos();
    const r = await pedirToken(victor.token, anaId, true);
    assert.equal(r.status, 409);
    const corpo = await r.json();
    assert.equal(corpo.erro, "reconectar");
    assert.ok(corpo.mensagem.length > 10);
    assert.equal((await contasDe(victor.token))[0].estado, "reconectar");
    const renovacoes = amb.google.contadores.renovacoes;
    assert.equal((await pedirToken(victor.token, anaId)).status, 409);
    assert.equal(amb.google.contadores.renovacoes, renovacoes);
  });

  test("reconectar (vincular de novo) volta a conta para ok e o token volta a sair", async () => {
    const r = await fluxo({ modo: "vincular", conta: CONTA_ANA, sessao: victor.token });
    assert.equal(r.destino, "/conta?google=ok");
    const lista = await contasDe(victor.token);
    assert.equal(lista.length, 1, "não duplica");
    assert.equal(lista[0].id, anaId, "mesmo id");
    assert.equal(lista[0].estado, "ok");
    assert.equal((await pedirToken(victor.token, anaId)).status, 200);
  });

  test("Bearer de dispositivo também pega token (sem Origin)", async () => {
    const { criarSessao } = await import("../src/lib/auth/sessao");
    const s = await criarSessao(victor.id, "dispositivo", { nome: "Mac de teste", plataforma: "mac" });
    const r = await token.POST(pedido("/api/drive/token", { corpo: { conta: anaId }, bearer: s.token, origin: null }));
    assert.equal(r.status, 200);
  });

  test("remover: revoga no Google e apaga a linha", async () => {
    const antes = amb.google.contadores.revogacoes;
    assert.equal(await contasGoogle.removerConta(edu.id, anaId), false, "só o dono remove");
    assert.equal(await contasGoogle.removerConta(victor.id, anaId), true);
    assert.equal(amb.google.contadores.revogacoes, antes + 1);
    assert.equal((await contasDe(victor.token)).length, 0);
    assert.equal((await pedirToken(victor.token, anaId)).status, 404);
  });

  test("Google fora do ar ao renovar: 502", async () => {
    const r = await fluxo({ modo: "vincular", conta: CONTA_ANA, sessao: victor.token });
    assert.equal(r.destino, "/conta?google=ok");
    const id = (await contasDe(victor.token))[0].id;
    const base = process.env.SOBEDESCE_GOOGLE_BASE;
    process.env.SOBEDESCE_GOOGLE_BASE = "http://127.0.0.1:9";
    try {
      const res = await pedirToken(victor.token, id, true);
      assert.equal(res.status, 502);
      assert.equal((await res.json()).erro, "google");
    } finally {
      process.env.SOBEDESCE_GOOGLE_BASE = base;
    }
    assert.equal((await contasDe(victor.token))[0].estado, "ok", "falha de rede não pede reconexão");
  });
});
