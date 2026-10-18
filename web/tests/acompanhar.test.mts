/**
 * Acompanhar pelo celular (docs/CONTAS.md §9): o computador manda o andamento (só a sessão de dispositivo, formato e
 * tamanho conferidos), o celular lê (só os da própria conta, ligado/sem notícia), o retrato some com a sessão e
 * depois de 7 dias, e o aviso por Web Push sai uma vez por fim de lote (inscrição morta é apagada).
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { pedido, prepararAmbiente, type Pedido } from "./ambiente.mjs";

let amb: Awaited<ReturnType<typeof prepararAmbiente>>;
let contas: typeof import("../src/lib/auth/contas");
let sessao: typeof import("../src/lib/auth/sessao");
let push: typeof import("../src/lib/acompanhar/push");
let formato: typeof import("../src/lib/acompanhar/formato");
let rStatus: typeof import("../src/app/api/dispositivos/status/route");
let rTransf: typeof import("../src/app/api/transferencias/route");
let rInscricao: typeof import("../src/app/api/push/inscricao/route");

type Pessoa = { id: string; cookie: string; mac: string; macId: string; pc: string; pcId: string };
let victor: Pessoa;
let ana: Pessoa;

type Envio = { endpoint: string; aviso: { titulo: string; corpo: string; url: string; tag: string } };
let envios: Envio[] = [];
let respostaPush: (endpoint: string) => number = () => 201;

const corpo = async (res: Response) => (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const comCookie = (p: Pessoa, extra: Pedido = {}): Pedido => ({ cookies: { sd_sessao: p.cookie }, ...extra });

async function novaPessoa(nome: string, email: string, ip: string): Promise<Pessoa> {
  const r = await contas.criarConta({ nome, email, senha: "uma senha comprida", ip });
  assert.ok(r.ok);
  const mac = await sessao.criarSessao(r.usuario.id, "dispositivo", { nome: `MacBook de ${nome}`, plataforma: "mac" });
  const pc = await sessao.criarSessao(r.usuario.id, "dispositivo", { nome: `PC de ${nome}`, plataforma: "windows" });
  return { id: r.usuario.id, cookie: r.token, mac: mac.token, macId: mac.id, pc: pc.token, pcId: pc.id };
}

function retrato(extra: Record<string, unknown> = {}, geral: Record<string, unknown> = {}) {
  return {
    v: 1,
    estado: "enviando",
    rodada: "r1",
    geral: {
      feitoBytes: 5e9,
      totalBytes: 8e9,
      feitos: 5,
      total: 8,
      erros: 0,
      velocidade: 120e6,
      eta: 25,
      sobe: { arquivos: 8, velocidade: 120e6 },
      desce: { arquivos: 0, velocidade: 0 },
      ...geral,
    },
    itens: [{ id: "t1", nome: "A001_C003.braw", direcao: "sobe", feito: 1e9, total: 2e9, velocidade: 60e6, estado: "enviando", destino: "Cenas" }],
    terminados: [{ nome: "A001_C001.braw", direcao: "sobe", total: 1e9, terminouEm: Date.now() - 60_000, ok: true }],
    ...extra,
  };
}

const enviar = (token: string, dados: unknown) => rStatus.POST(pedido("/api/dispositivos/status", { bearer: token, corpo: dados }));
const ler = async (p: Pedido) => corpo(await rTransf.GET(pedido("/api/transferencias", p)));

const ENDPOINT_APPLE = "https://web.push.apple.com/QGuQyavXutnMH0nC";
const ENDPOINT_FCM = "https://fcm.googleapis.com/fcm/send/abc:def";
const CHAVES = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };

before(async () => {
  amb = await prepararAmbiente();
  contas = await import("../src/lib/auth/contas");
  sessao = await import("../src/lib/auth/sessao");
  push = await import("../src/lib/acompanhar/push");
  formato = await import("../src/lib/acompanhar/formato");
  rStatus = await import("../src/app/api/dispositivos/status/route");
  rTransf = await import("../src/app/api/transferencias/route");
  rInscricao = await import("../src/app/api/push/inscricao/route");
  victor = await novaPessoa("Victor", "victor@exemplo.com", "10.0.1.1");
  ana = await novaPessoa("Ana", "ana@exemplo.com", "10.0.1.2");
  push.definirEnviador(async (inscricao, payload) => {
    envios.push({ endpoint: inscricao.endpoint, aviso: JSON.parse(payload) });
    return { status: respostaPush(inscricao.endpoint) };
  });
});

beforeEach(() => {
  envios = [];
  respostaPush = () => 201;
});

after(async () => {
  push?.definirEnviador(null);
  await amb?.fechar();
});

describe("POST /api/dispositivos/status", () => {
  test("só a sessão do computador manda", async () => {
    assert.equal((await rStatus.POST(pedido("/api/dispositivos/status", { corpo: retrato() }))).status, 401);
    const cookie = await rStatus.POST(pedido("/api/dispositivos/status", comCookie(victor, { corpo: retrato() })));
    assert.equal(cookie.status, 403);
    assert.equal((await corpo(cookie)).erro, "so_computador");
    assert.equal((await rStatus.POST(pedido("/api/dispositivos/status", { bearer: "sdd_" + "x".repeat(43), corpo: retrato() }))).status, 401);
    const r = await enviar(victor.mac, retrato());
    assert.equal(r.status, 200);
    assert.equal((await corpo(r)).ok, true);
  });

  test("formato conferido", async () => {
    assert.equal((await enviar(victor.mac, { ...retrato(), estado: "voando" })).status, 400);
    assert.equal((await enviar(victor.mac, { ...retrato(), v: 2 })).status, 400);
    assert.equal((await enviar(victor.mac, retrato({ itens: [{ id: "t", nome: "x".repeat(301), direcao: "sobe", feito: 0, total: 1, velocidade: 0, estado: "na_fila" }] }))).status, 400);
    assert.equal((await enviar(victor.mac, retrato({ itens: [{ id: "t", nome: "a", direcao: "lado", feito: 0, total: 1, velocidade: 0, estado: "na_fila" }] }))).status, 400);
    assert.equal((await enviar(victor.mac, retrato({}, { feitoBytes: -1 }))).status, 400);
    const muitos = Array.from({ length: formato.MAX_ITENS + 1 }, (_, i) => ({ id: `t${i}`, nome: "a", direcao: "sobe", feito: 0, total: 1, velocidade: 0, estado: "na_fila" }));
    assert.equal((await enviar(victor.mac, retrato({ itens: muitos }))).status, 400);
    assert.equal((await enviar(victor.mac, "não é json")).status, 400);
    // Campo desconhecido não vai para o banco.
    assert.equal((await enviar(victor.mac, retrato({ segredo: "x" }))).status, 200);
    const lido = await ler(comCookie(victor));
    assert.equal(lido.computadores[0].snapshot.segredo, undefined);
  });

  test("lotes (pedidos) vão e voltam; lote com direção estranha é recusado", async () => {
    const lote = {
      id: "b2", titulo: 'Pasta "ZRO"', direcao: "desce", destino: "SSD", arquivos: 8, bytes: 18.2e9, feitoBytes: 6e9,
      andando: 3, esperando: 0, naFila: 5, pausados: 0, concluidos: 0, cancelados: 0, erros: 0, conferidos: 0, divergentes: 0,
      velocidade: 19e6, eta: 900, criadoEm: Date.now() - 60_000, terminouEm: null,
    };
    const r = await enviar(victor.mac, retrato({ lotes: [lote], itens: [{ id: "t1", nome: "a.mp4", direcao: "desce", feito: 1, total: 2, velocidade: 1, estado: "baixando", lote: "b2" }] }));
    assert.equal(r.status, 200);
    const lido = await ler(comCookie(victor));
    const snap = lido.computadores.find((c: { snapshot: { lotes?: unknown[] } }) => c.snapshot.lotes)?.snapshot;
    assert.deepEqual(snap.lotes, [lote]);
    assert.equal(snap.itens[0].lote, "b2");
    assert.equal((await enviar(victor.mac, retrato({ lotes: [{ ...lote, direcao: "lado" }] }))).status, 400);
    // App de computador antigo (sem lotes) continua valendo.
    assert.equal((await enviar(victor.mac, retrato())).status, 200);
  });

  test("tamanho máximo (64 KB)", async () => {
    const grande = JSON.stringify(retrato({ lixo: "x".repeat(70 * 1024) }));
    const r = await enviar(victor.mac, grande);
    assert.equal(r.status, 413);
    assert.equal((await corpo(r)).erro, "grande_demais");
  });
});

describe("GET /api/transferencias", () => {
  test("cada conta vê só os próprios computadores; cookie ou Bearer", async () => {
    await enviar(victor.mac, retrato());
    await enviar(ana.pc, retrato({ estado: "baixando" }));
    const v = await ler(comCookie(victor));
    assert.equal(v.ok, true);
    assert.equal(v.computadores.length, 1);
    const c = v.computadores[0];
    assert.equal(c.id, victor.macId);
    assert.equal(c.nome, "MacBook de Victor");
    assert.equal(c.plataforma, "mac");
    assert.equal(c.online, true);
    assert.equal(c.snapshot.itens[0].nome, "A001_C003.braw");
    assert.equal(typeof v.agora, "number");
    assert.equal(typeof v.push.chavePublica, "string");
    const a = await ler(comCookie(ana));
    assert.deepEqual(
      a.computadores.map((x: { id: string }) => x.id),
      [ana.pcId],
    );
    // O próprio computador (Bearer) também lê.
    const pelo = await ler({ bearer: victor.pc });
    assert.equal(pelo.computadores[0].id, victor.macId);
    assert.equal((await rTransf.GET(pedido("/api/transferencias"))).status, 401);
  });

  test("ligado até 2 min; sem notícia há mais de 7 dias some", async () => {
    const { db, schema } = amb.banco;
    const { eq } = await import("drizzle-orm");
    await enviar(victor.mac, retrato());
    await enviar(victor.pc, retrato({ estado: "parado" }));
    await db.update(schema.dispositivoStatus).set({ atualizadoEm: new Date(Date.now() - 3 * 60_000) }).where(eq(schema.dispositivoStatus.sessaoId, victor.pcId));
    let v = await ler(comCookie(victor));
    assert.deepEqual(
      v.computadores.map((x: { id: string; online: boolean }) => [x.id, x.online]),
      [
        [victor.macId, true],
        [victor.pcId, false],
      ],
    );
    // Fechou o app: deixa de contar como ligado na hora.
    await enviar(victor.mac, retrato({ fechado: true, estado: "pausado" }));
    v = await ler(comCookie(victor));
    assert.equal(v.computadores.find((x: { id: string }) => x.id === victor.macId).online, false);
    await db.update(schema.dispositivoStatus).set({ atualizadoEm: new Date(Date.now() - 8 * 24 * 3600_000) }).where(eq(schema.dispositivoStatus.sessaoId, victor.pcId));
    v = await ler(comCookie(victor));
    assert.deepEqual(
      v.computadores.map((x: { id: string }) => x.id),
      [victor.macId],
    );
    const linhas = await db.select().from(schema.dispositivoStatus).where(eq(schema.dispositivoStatus.sessaoId, victor.pcId));
    assert.equal(linhas.length, 0);
  });

  test("computador desconectado: o andamento some junto (e o token dele para de valer)", async () => {
    const extra = await sessao.criarSessao(victor.id, "dispositivo", { nome: "iMac do estúdio", plataforma: "mac" });
    assert.equal((await enviar(extra.token, retrato())).status, 200);
    assert.ok((await ler(comCookie(victor))).computadores.some((x: { id: string }) => x.id === extra.id));
    assert.equal(await sessao.revogarDispositivo(victor.id, extra.id), true);
    assert.ok(!(await ler(comCookie(victor))).computadores.some((x: { id: string }) => x.id === extra.id));
    const { db, schema } = amb.banco;
    const { eq } = await import("drizzle-orm");
    assert.equal((await db.select().from(schema.dispositivoStatus).where(eq(schema.dispositivoStatus.sessaoId, extra.id))).length, 0);
    assert.equal((await enviar(extra.token, retrato())).status, 401);
  });

  test("DELETE: ajuste desligado no computador", async () => {
    await enviar(victor.pc, retrato());
    assert.ok((await ler(comCookie(victor))).computadores.some((x: { id: string }) => x.id === victor.pcId));
    assert.equal((await rStatus.DELETE(pedido("/api/dispositivos/status", comCookie(victor, { method: "DELETE" })))).status, 403);
    assert.equal((await rStatus.DELETE(pedido("/api/dispositivos/status", { method: "DELETE", bearer: victor.pc }))).status, 204);
    assert.ok(!(await ler(comCookie(victor))).computadores.some((x: { id: string }) => x.id === victor.pcId));
  });
});

describe("Web Push", () => {
  test("inscrição: só serviços de push conhecidos, com Origin do site", async () => {
    const ins = (p: Pessoa, dados: unknown, extra: Pedido = {}) => rInscricao.POST(pedido("/api/push/inscricao", comCookie(p, { corpo: dados, ...extra })));
    assert.equal((await ins(victor, { endpoint: "http://127.0.0.1:9/x", keys: CHAVES })).status, 400);
    assert.equal((await ins(victor, { endpoint: "https://intranet.exemplo.com/push", keys: CHAVES })).status, 400);
    assert.equal((await ins(victor, { endpoint: ENDPOINT_APPLE, keys: { p256dh: "curta", auth: "x" } })).status, 400);
    assert.equal((await ins(victor, { endpoint: ENDPOINT_APPLE, keys: CHAVES }, { origin: "https://outro.site" })).status, 403);
    assert.equal((await ins(victor, { endpoint: ENDPOINT_APPLE, keys: CHAVES })).status, 201);
    assert.equal((await ins(victor, { endpoint: ENDPOINT_FCM, keys: CHAVES })).status, 201);
    // De novo: não duplica.
    assert.equal((await ins(victor, { endpoint: ENDPOINT_APPLE, keys: CHAVES })).status, 201);
    const { db, schema } = amb.banco;
    const { eq } = await import("drizzle-orm");
    assert.equal((await db.select().from(schema.pushInscricoes).where(eq(schema.pushInscricoes.usuarioId, victor.id))).length, 2);
  });

  test("um aviso por fim de lote; nada enquanto anda", async () => {
    await enviar(victor.mac, retrato({ rodada: "r10" }));
    assert.equal(envios.length, 0);
    const fim = retrato({ rodada: "r10", estado: "concluido", itens: [] }, { feitos: 8, feitoBytes: 412e9, totalBytes: 412e9, velocidade: 0, eta: null });
    const r = await corpo(await enviar(victor.mac, fim));
    assert.equal(r.avisados, 2);
    assert.equal(envios.length, 2);
    assert.deepEqual(
      envios.map((e) => e.endpoint).sort(),
      [ENDPOINT_APPLE, ENDPOINT_FCM].sort(),
    );
    assert.equal(envios[0].aviso.titulo, "Pronto");
    assert.equal(envios[0].aviso.corpo, "8 arquivos enviados do MacBook de Victor · 412 GB");
    assert.equal(envios[0].aviso.url, "/app/#computador");
    // O mesmo retrato de novo (batimento, outro pedido): sem aviso.
    await enviar(victor.mac, fim);
    await Promise.all([enviar(victor.mac, fim), enviar(victor.mac, fim)]);
    assert.equal(envios.length, 2);
    // Rodada nova que termina: outro aviso.
    envios = [];
    await enviar(victor.mac, retrato({ rodada: "r11" }));
    await enviar(victor.mac, { ...fim, rodada: "r11" });
    assert.equal(envios.length, 2);
  });

  test("parou com erro: aviso próprio, também uma vez", async () => {
    const erro = retrato({ rodada: "r20", estado: "erro", itens: [] }, { feitos: 6, erros: 2, total: 8, velocidade: 0 });
    await enviar(victor.mac, erro);
    assert.equal(envios.length, 2);
    assert.equal(envios[0].aviso.titulo, "Parou com erro");
    assert.equal(envios[0].aviso.corpo, "2 arquivos não passaram no MacBook de Victor. 6 de 8 prontos.");
    await enviar(victor.mac, erro);
    assert.equal(envios.length, 2);
  });

  test("baixados e transferidos", () => {
    const base = retrato({ estado: "concluido" }, { feitos: 1, feitoBytes: 1.5e9, sobe: { arquivos: 0, velocidade: 0 }, desce: { arquivos: 1, velocidade: 0 } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(formato.textoDoAviso(base as any, "PC")?.corpo, "1 arquivo baixado no PC · 1,5 GB");
    const misto = retrato({ estado: "concluido" }, { feitos: 3, feitoBytes: 3e6, sobe: { arquivos: 1, velocidade: 0 }, desce: { arquivos: 2, velocidade: 0 } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(formato.textoDoAviso(misto as any, "PC")?.corpo, "3 arquivos transferidos no PC · 3 MB");
  });

  test("inscrição que não existe mais (410/404) é apagada; falha passageira fica", async () => {
    respostaPush = (e) => (e === ENDPOINT_FCM ? 410 : 500);
    await enviar(victor.mac, retrato({ rodada: "r30", estado: "concluido" }, { feitos: 8 }));
    assert.equal(envios.length, 2);
    const { db, schema } = amb.banco;
    const { eq } = await import("drizzle-orm");
    const restantes = await db.select().from(schema.pushInscricoes).where(eq(schema.pushInscricoes.usuarioId, victor.id));
    assert.deepEqual(
      restantes.map((r) => [r.endpoint, r.falhas]),
      [[ENDPOINT_APPLE, 1]],
    );
  });

  test("desinscrever", async () => {
    const del = (p: Pessoa, endpoint: string) => rInscricao.DELETE(pedido("/api/push/inscricao", comCookie(p, { method: "DELETE", corpo: { endpoint } })));
    assert.equal((await corpo(await del(ana, ENDPOINT_APPLE))).apagou, false);
    assert.equal((await corpo(await del(victor, ENDPOINT_APPLE))).apagou, true);
    await enviar(victor.mac, retrato({ rodada: "r40", estado: "concluido" }, { feitos: 8 }));
    assert.equal(envios.length, 0);
  });
});
