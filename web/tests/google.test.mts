/**
 * Google contra o Google falso: vincular (e conta Google de outro usuário), recusar, entrar com Google
 * (só pelo Google de entrar: revisão A3), primeira senha só pelo e-mail (A5), e-mail confirmado gravado (A2),
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
  test("Drive conectado a uma conta não abre a conta: nada de sessão e nada muda no banco (A3)", async () => {
    const { db, schema } = amb.banco;
    const antes = (await db.select().from(schema.contasGoogle))[0];
    assert.equal(antes.loginPermitido, false, "conectar um Drive não liga o login");
    const r = await fluxo({ modo: "entrar", conta: CONTA_ANA, volta: "/app" });
    assert.equal(r.destino, "/entrar?erro=google_nao_e_login&volta=%2Fapp");
    assert.equal(cookiesDe(r.res!).get("sd_sessao"), undefined);
    const depois = (await db.select().from(schema.contasGoogle))[0];
    assert.equal(depois.refreshTokenEnc, antes.refreshTokenEnc, "os tokens guardados não mudam");
    assert.equal(depois.atualizadoEm.getTime(), antes.atualizadoEm.getTime());
    assert.equal((await db.select().from(schema.usuarios)).length, 2, "também não cria outra conta");
  });

  test("escolher o Google de entrar pede a senha atual; aí ele entra e cai na conta do dono", async () => {
    const anaId = (await contasDe(victor.token))[0].id;
    const semSenha = await contasGoogle.trocarGoogleDeEntrar({ usuarioId: victor.id, contaId: anaId, senhaAtual: "" });
    assert.ok(!semSenha.ok && semSenha.erro === "credenciais");
    const errada = await contasGoogle.trocarGoogleDeEntrar({ usuarioId: victor.id, contaId: anaId, senhaAtual: "nao e a senha" });
    assert.ok(!errada.ok && errada.campo === "senhaAtual");
    const deOutro = await contasGoogle.trocarGoogleDeEntrar({ usuarioId: edu.id, contaId: anaId, senhaAtual: "senha do edu!!" });
    assert.ok(!deOutro.ok && deOutro.erro === "nao_encontrada", "Drive de outra pessoa não vira login");
    const certa = await contasGoogle.trocarGoogleDeEntrar({ usuarioId: victor.id, contaId: anaId, senhaAtual: "senha do victor" });
    assert.ok(certa.ok && certa.conta?.email === "ana@exemplo.com");
    assert.equal(await contasGoogle.googleDeEntrar(victor.id), anaId);

    const r = await fluxo({ modo: "entrar", conta: CONTA_ANA, volta: "/app" });
    assert.equal(r.destino, "/app");
    const nova = cookiesDe(r.res!).get("sd_sessao");
    assert.ok(nova);
    assert.match(r.res!.headers.getSetCookie().find((c) => c.startsWith("sd_sessao="))!, /HttpOnly; SameSite=Lax/);
    const res = await eu.GET(pedido("/api/eu", { cookies: { sd_sessao: nova } }));
    assert.equal((await res.json()).usuario.id, victor.id);
  });

  test("um segundo Drive conectado não vira porta de entrada; trocar o de entrar desliga o anterior", async () => {
    const beto = { ...CONTA_BETO, sub: "223", email: "beto.cliente@exemplo.com" };
    assert.equal((await fluxo({ modo: "vincular", conta: beto, sessao: victor.token })).destino, "/conta?google=ok");
    const [ana, cliente] = await contasDe(victor.token);
    assert.equal(await contasGoogle.googleDeEntrar(victor.id), ana.id, "o de entrar continua o mesmo");
    assert.equal((await fluxo({ modo: "entrar", conta: beto })).destino, "/entrar?erro=google_nao_e_login");

    const trocou = await contasGoogle.trocarGoogleDeEntrar({ usuarioId: victor.id, contaId: cliente.id, senhaAtual: "senha do victor" });
    assert.ok(trocou.ok);
    assert.equal((await fluxo({ modo: "entrar", conta: CONTA_ANA })).destino, "/entrar?erro=google_nao_e_login", "a Ana deixou de entrar");
    assert.equal((await fluxo({ modo: "entrar", conta: beto, volta: "/app" })).destino, "/app");

    // Nenhum: só e-mail e senha. Depois volta para a Ana e o Drive do cliente sai.
    const nenhum = await contasGoogle.trocarGoogleDeEntrar({ usuarioId: victor.id, contaId: null, senhaAtual: "senha do victor" });
    assert.ok(nenhum.ok && nenhum.conta === null);
    assert.equal(await contasGoogle.googleDeEntrar(victor.id), null);
    assert.equal((await fluxo({ modo: "entrar", conta: beto })).destino, "/entrar?erro=google_nao_e_login");
    assert.ok((await contasGoogle.trocarGoogleDeEntrar({ usuarioId: victor.id, contaId: ana.id, senhaAtual: "senha do victor" })).ok);
    assert.deepEqual(await contasGoogle.removerConta(victor.id, cliente.id), { ok: true });
  });

  test("conta Google nova: cria a conta com o Drive já conectado e é ele que entra", async () => {
    const r = await fluxo({ modo: "entrar", conta: { sub: "999", email: "Novo@Exemplo.com", name: "Novo Usuário" } });
    assert.equal(r.destino, "/conta?google=ok");
    const sessao = cookiesDe(r.res!).get("sd_sessao");
    assert.ok(sessao);
    const corpo = await (await eu.GET(pedido("/api/eu", { cookies: { sd_sessao: sessao } }))).json();
    assert.equal(corpo.usuario.email, "novo@exemplo.com");
    assert.equal(corpo.usuario.nome, "Novo Usuário");
    assert.deepEqual(corpo.contas.map((c: { email: string }) => c.email), ["novo@exemplo.com"]);
    assert.equal(await contasGoogle.googleDeEntrar(corpo.usuario.id), corpo.contas[0].id, "quem criou a conta é o Google de entrar");
    // Entrar de novo pelo Google cai na mesma conta (não cria outra).
    const deNovo = await fluxo({ modo: "entrar", conta: { sub: "999", email: "novo@exemplo.com", name: "Novo Usuário" } });
    assert.equal(deNovo.destino, "/conta");
    const corpo2 = await (await eu.GET(pedido("/api/eu", { cookies: { sd_sessao: cookiesDe(deNovo.res!).get("sd_sessao")! } }))).json();
    assert.equal(corpo2.usuario.id, corpo.usuario.id);
    // Sem senha: nenhuma senha entra nessa conta até a pessoa criar uma.
    const tentativa = await contas.entrarComSenha({ email: "novo@exemplo.com", senha: "google", ip: "9.9.9.9" });
    assert.equal(tentativa.ok, false);
  });

  test("conta só-Google: a primeira senha não sai só com a sessão; sai pelo link no e-mail (A5)", async () => {
    const { db, schema } = amb.banco;
    const { eq } = drizzle;
    const [u] = await db.select().from(schema.usuarios).where(eq(schema.usuarios.email, "novo@exemplo.com"));
    const s = await (await import("../src/lib/auth/sessao")).criarSessao(u.id, "web");
    const atual = await (await import("../src/lib/auth/sessao")).autenticar({ cookie: s.token });
    assert.ok(atual);

    // Uma sessão (roubada ou não) não cria a senha direto.
    assert.equal(await contas.contaComSenha(u.id), false);
    const direto = await contas.trocarSenha({ usuarioId: u.id, sessaoId: atual.sessao.id, senhaAtual: "", senhaNova: "uma senha nova longa", ip: "9.9.9.9" });
    assert.ok(!direto.ok && direto.erro === "sem_senha");
    assert.equal(await contas.contaComSenha(u.id), false);
    // Nem troca o Google de entrar (seria pôr o próprio Google como porta).
    const troca = await contasGoogle.trocarGoogleDeEntrar({ usuarioId: u.id, contaId: null, senhaAtual: "" });
    assert.ok(!troca.ok && troca.erro === "sem_senha");
    // Nem remove o único Google de entrar (ficaria sem jeito de entrar).
    const [drive] = await contasDe(s.token);
    assert.deepEqual(await contasGoogle.removerConta(u.id, drive.id), { ok: false, erro: "google_de_entrar" });

    // O link vai para o e-mail da conta (o que o Google confirmou).
    const redefinir = await import("../src/lib/auth/redefinir");
    let tarefa: Promise<unknown> = Promise.resolve();
    const pedidoLink = await redefinir.pedirPrimeiraSenha({ usuarioId: u.id, ip: "9.9.9.9", depois: (t) => void (tarefa = t()) });
    await tarefa;
    assert.ok(pedidoLink.ok);
    assert.match(pedidoLink.mensagem, /novo@exemplo\.com/);
    const e = amb.resend.recebidos.at(-1)!;
    assert.deepEqual(e.to, ["novo@exemplo.com"]);
    assert.match(e.subject, /senha/i);
    const token = /\/nova-senha\?token=([A-Za-z0-9_-]{43})/.exec(e.text)![1];
    const criada = await redefinir.redefinirSenha({ token, senha: "uma senha nova longa" });
    assert.ok(criada.ok);
    assert.equal(await contas.contaComSenha(u.id), true);
    assert.ok((await contas.entrarComSenha({ email: "novo@exemplo.com", senha: "uma senha nova longa", ip: "9.9.9.9" })).ok);
    // E o Google dela continua entrando.
    assert.equal((await fluxo({ modo: "entrar", conta: { sub: "999", email: "novo@exemplo.com", name: "Novo Usuário" }, volta: "/app" })).destino, "/app");
    // Quem já tem senha não pede o link de "primeira senha".
    const deNovo = await redefinir.pedirPrimeiraSenha({ usuarioId: u.id, ip: "9.9.9.9", depois: () => {} });
    assert.ok(!deNovo.ok && deNovo.erro === "tem_senha");
  });

  test("conta Google nova com e-mail que já tem conta com senha: não toma a conta", async () => {
    const r = await fluxo({ modo: "entrar", conta: { sub: "998", email: "victor@exemplo.com", name: "Outro" } });
    assert.equal(r.destino, "/entrar?erro=google_email_em_uso");
    assert.equal(cookiesDe(r.res!).get("sd_sessao"), undefined);
  });

  test("conta Google nova sem permitir o Drive: não cria conta", async () => {
    const r = await fluxo({ modo: "entrar", conta: { sub: "997", email: "semdrive@exemplo.com", name: "Sem Drive" }, escopo: "openid email profile" });
    assert.equal(r.destino, "/entrar?erro=google_sem_drive");
    assert.equal(cookiesDe(r.res!).get("sd_sessao"), undefined);
  });

  test("recusar ao entrar volta para /entrar com a volta guardada", async () => {
    const r = await fluxo({ modo: "entrar", conta: CONTA_ANA, negar: true, volta: "/dispositivo?codigo=BCDF-GHJK" });
    assert.equal(r.destino, "/entrar?erro=google_recusado&volta=%2Fdispositivo%3Fcodigo%3DBCDF-GHJK");
  });

  test("e-mail confirmado pelo Google fica gravado a cada conexão (admin depende dele, A2)", async () => {
    const { db, schema } = amb.banco;
    const { eq } = drizzle;
    const naoConfirmado = { sub: "555", email: "sem.confirmar@exemplo.com", name: "Sem Confirmar", verificado: false };
    assert.equal((await fluxo({ modo: "vincular", conta: naoConfirmado, sessao: edu.token })).destino, "/conta?google=ok");
    const linha = async () => (await db.select().from(schema.contasGoogle).where(eq(schema.contasGoogle.googleSub, "555")))[0];
    assert.equal((await linha()).emailVerificado, false);
    assert.equal((await fluxo({ modo: "vincular", conta: { ...naoConfirmado, verificado: true }, sessao: edu.token })).destino, "/conta?google=ok");
    assert.equal((await linha()).emailVerificado, true, "reconectar depois de confirmar atualiza");
    assert.deepEqual(await contasGoogle.removerConta(edu.id, (await linha()).id), { ok: true });
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
    assert.deepEqual(await contasGoogle.removerConta(edu.id, anaId), { ok: false, erro: "nao_encontrada" }, "só o dono remove");
    // A Ana é o Google de entrar do Victor, mas ele tem senha: pode remover (fica só com e-mail e senha).
    assert.equal(await contasGoogle.googleDeEntrar(victor.id), anaId);
    assert.deepEqual(await contasGoogle.removerConta(victor.id, anaId), { ok: true });
    assert.equal(await contasGoogle.googleDeEntrar(victor.id), null);
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
