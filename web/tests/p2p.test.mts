/**
 * Celular ↔ computador pelo Wi-Fi (docs/CELULAR-WIFI.md): a sinalização no site. Espera longa (marca online e entrega
 * os sinais uma vez só), quem vê quem (só a mesma conta, só o outro tipo, "mesma rede"), regras dos sinais (oferta só
 * para quem está online; resposta só sobre uma oferta entre os dois; validade de 2 min; limite por minuto).
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { after, before, describe, test } from "node:test";
import { pedido, prepararAmbiente } from "./ambiente.mjs";

let amb: Awaited<ReturnType<typeof prepararAmbiente>>;
let contas: typeof import("../src/lib/auth/contas");
let sessao: typeof import("../src/lib/auth/sessao");
let banco: typeof import("../src/lib/db");
let rEspera: typeof import("../src/app/api/p2p/espera/route");
let rAparelhos: typeof import("../src/app/api/p2p/aparelhos/route");
let rSinal: typeof import("../src/app/api/p2p/sinal/route");
let COOKIE: string;

before(async () => {
  amb = await prepararAmbiente();
  contas = await import("../src/lib/auth/contas");
  sessao = await import("../src/lib/auth/sessao");
  banco = await import("../src/lib/db");
  rEspera = await import("../src/app/api/p2p/espera/route");
  rAparelhos = await import("../src/app/api/p2p/aparelhos/route");
  rSinal = await import("../src/app/api/p2p/sinal/route");
  COOKIE = sessao.COOKIE_SESSAO;
});

after(async () => {
  await amb?.fechar();
});

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const SDP = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n";

type Pessoa = { id: string; celular: string; celularId: string; mac: string; macId: string };
let n = 0;
async function pessoa(nome: string): Promise<Pessoa> {
  const r = await contas.criarConta({ nome, email: `p2p${++n}@exemplo.com`, senha: "uma senha comprida", ip: `10.7.${n}.1` });
  assert.ok(r.ok);
  const mac = await sessao.criarSessao(r.usuario.id, "dispositivo", { nome: `MacBook de ${nome.split(" ")[0]}`, plataforma: "mac" });
  const web = await banco.db.query.sessoes.findFirst({ where: eq(banco.schema.sessoes.usuarioId, r.usuario.id) });
  return { id: r.usuario.id, celular: r.token, celularId: web!.id, mac: mac.token, macId: mac.id };
}

const corpo = async (res: Response) => ({ status: res.status, ...(await res.json()) });

/** Pedido como o celular faz: cookie do site, User-Agent do iPhone, IP público. */
function doCelular(p: Pessoa, caminho: string, o: { corpo?: unknown; ip?: string } = {}) {
  const req = pedido(caminho, { cookies: { [COOKIE]: p.celular }, corpo: o.corpo, ip: o.ip ?? "200.1.1.1" });
  req.headers.set("user-agent", IPHONE);
  return req;
}
const doMac = (p: Pessoa, caminho: string, o: { corpo?: unknown; ip?: string } = {}) => pedido(caminho, { bearer: p.mac, corpo: o.corpo, ip: o.ip ?? "200.1.1.1" });

const curta = (req: Request) => rEspera.GET(req);

describe("p2p", () => {
  let victor: Pessoa;
  let ana: Pessoa;

  before(async () => {
    victor = await pessoa("Victor Barroso");
    ana = await pessoa("Ana Montadora");
  });

  test("sem conta: 401; quem não abriu o app não aparece", async () => {
    assert.equal((await rEspera.GET(pedido("/api/p2p/espera?curto=1"))).status, 401);
    const r = await corpo(await rAparelhos.GET(doCelular(victor, "/api/p2p/aparelhos")));
    assert.deepEqual(r.aparelhos, []);
  });

  test("a espera marca online: o celular vê o computador (e só da própria conta), com mesma rede pelo IP", async () => {
    await curta(doMac(victor, "/api/p2p/espera?curto=1", { ip: "200.1.1.1" }));
    await curta(doMac(ana, "/api/p2p/espera?curto=1", { ip: "200.1.1.1" }));
    await curta(doCelular(victor, "/api/p2p/espera?curto=1"));

    const doCel = await corpo(await rAparelhos.GET(doCelular(victor, "/api/p2p/aparelhos")));
    assert.deepEqual(doCel.aparelhos, [{ id: victor.macId, nome: "MacBook de Victor", tipo: "computador", mesmaRede: true }]);

    const doPc = await corpo(await rAparelhos.GET(doMac(victor, "/api/p2p/aparelhos")));
    assert.deepEqual(doPc.aparelhos, [{ id: victor.celularId, nome: "iPhone de Victor", tipo: "celular", mesmaRede: true }]);

    const outraRede = await corpo(await rAparelhos.GET(doCelular(victor, "/api/p2p/aparelhos", { ip: "177.9.9.9" })));
    assert.equal(outraRede.aparelhos[0].mesmaRede, false, "outra rede ainda aparece, só sem o selo");
  });

  test("oferta → resposta: cada um recebe uma vez, com quem mandou e o resumo", async () => {
    const of = await corpo(
      await rSinal.POST(doCelular(victor, "/api/p2p/sinal", { corpo: { tipo: "oferta", para: victor.macId, sdp: SDP, resumo: { arquivos: 2, bytes: 1234, nomes: ["IMG_1.HEIC", "IMG_2.MOV"] } } })),
    );
    assert.equal(of.status, 201);

    const noMac = await corpo(await curta(doMac(victor, "/api/p2p/espera?curto=1")));
    assert.equal(noMac.sinais.length, 1);
    const s = noMac.sinais[0];
    assert.equal(s.id, of.id);
    assert.equal(s.tipo, "oferta");
    assert.deepEqual(s.de, { id: victor.celularId, nome: "iPhone de Victor", tipo: "celular" });
    assert.deepEqual(s.resumo, { arquivos: 2, bytes: 1234, nomes: ["IMG_1.HEIC", "IMG_2.MOV"] });
    assert.equal(s.sdp, SDP);
    assert.deepEqual((await corpo(await curta(doMac(victor, "/api/p2p/espera?curto=1")))).sinais, [], "entregue uma vez só");

    const resp = await corpo(await rSinal.POST(doMac(victor, "/api/p2p/sinal", { corpo: { tipo: "resposta", para: victor.celularId, oferta: of.id, sdp: SDP } })));
    assert.equal(resp.status, 201);
    const noCel = await corpo(await curta(doCelular(victor, "/api/p2p/espera?curto=1")));
    assert.equal(noCel.sinais[0].tipo, "resposta");
    assert.equal(noCel.sinais[0].oferta, of.id);
  });

  test("a espera longa devolve assim que chega um sinal", async () => {
    const inicio = Date.now();
    const esperando = rEspera.GET(doMac(victor, "/api/p2p/espera"));
    await new Promise((ok) => setTimeout(ok, 300));
    const of = await corpo(await rSinal.POST(doCelular(victor, "/api/p2p/sinal", { corpo: { tipo: "oferta", para: victor.macId, sdp: SDP, resumo: { arquivos: 1, bytes: 1, nomes: [] } } })));
    const r = await corpo(await esperando);
    assert.equal(r.sinais[0]?.id, of.id);
    assert.ok(Date.now() - inicio < 5000, "não esperou os 25 s");
  });

  test("regras: outra conta, aparelho offline, resposta de quem não recebeu, oferta vencida e SDP inválido", async () => {
    const sinal = (req: Request) => rSinal.POST(req).then(corpo);
    // Para o computador de outra conta: como se não existisse.
    assert.equal((await sinal(doCelular(victor, "/api/p2p/sinal", { corpo: { tipo: "oferta", para: ana.macId, sdp: SDP, resumo: { arquivos: 1, bytes: 1, nomes: [] } } }))).status, 404);
    // Offline (sem espera há mais de 70 s).
    await banco.db.update(banco.schema.p2pAparelhos).set({ vistoEm: new Date(Date.now() - 5 * 60_000) }).where(eq(banco.schema.p2pAparelhos.sessaoId, victor.macId));
    assert.equal((await sinal(doCelular(victor, "/api/p2p/sinal", { corpo: { tipo: "oferta", para: victor.macId, sdp: SDP, resumo: { arquivos: 1, bytes: 1, nomes: [] } } }))).status, 404);
    await curta(doMac(victor, "/api/p2p/espera?curto=1"));

    const of = await sinal(doCelular(victor, "/api/p2p/sinal", { corpo: { tipo: "oferta", para: victor.macId, sdp: SDP, resumo: { arquivos: 1, bytes: 1, nomes: [] } } }));
    // Quem mandou a oferta não responde a ela mesma; mas pode cancelar.
    assert.equal((await sinal(doCelular(victor, "/api/p2p/sinal", { corpo: { tipo: "resposta", para: victor.macId, oferta: of.id, sdp: SDP } }))).status, 400);
    assert.equal((await sinal(doCelular(victor, "/api/p2p/sinal", { corpo: { tipo: "cancela", para: victor.macId, oferta: of.id } }))).status, 201);
    // Outra conta não responde à oferta (mesmo sabendo o id).
    assert.equal((await sinal(doMac(ana, "/api/p2p/sinal", { corpo: { tipo: "recusa", para: victor.celularId, oferta: of.id } }))).status, 404);
    // Oferta vencida.
    await banco.db.update(banco.schema.p2pSinais).set({ criadoEm: new Date(Date.now() - 3 * 60_000) }).where(eq(banco.schema.p2pSinais.id, of.id));
    assert.equal((await sinal(doMac(victor, "/api/p2p/sinal", { corpo: { tipo: "resposta", para: victor.celularId, oferta: of.id, sdp: SDP } }))).status, 404);
    // SDP que não é SDP, campo a mais.
    assert.equal((await sinal(doCelular(victor, "/api/p2p/sinal", { corpo: { tipo: "oferta", para: victor.macId, sdp: "oi", resumo: { arquivos: 1, bytes: 1, nomes: [] } } }))).status, 400);
    assert.equal((await sinal(doCelular(victor, "/api/p2p/sinal", { corpo: { tipo: "oferta", para: victor.macId, sdp: SDP, resumo: { arquivos: 1, bytes: 1, nomes: [] }, extra: 1 } }))).status, 400);
    // Cookie sem a origem do site: recusado.
    const deFora = pedido("/api/p2p/sinal", { cookies: { [COOKIE]: victor.celular }, corpo: { tipo: "oferta", para: victor.macId, sdp: SDP, resumo: { arquivos: 1, bytes: 1, nomes: [] } }, origin: "https://outro.site" });
    assert.equal((await rSinal.POST(deFora)).status, 403);
  });

  test("sinal vencido não é entregue; limite de ofertas por minuto", async () => {
    await curta(doMac(ana, "/api/p2p/espera?curto=1"));
    await curta(doCelular(ana, "/api/p2p/espera?curto=1"));
    const of = await corpo(await rSinal.POST(doCelular(ana, "/api/p2p/sinal", { corpo: { tipo: "oferta", para: ana.macId, sdp: SDP, resumo: { arquivos: 1, bytes: 1, nomes: [] } } })));
    await banco.db.update(banco.schema.p2pSinais).set({ criadoEm: new Date(Date.now() - 3 * 60_000) }).where(eq(banco.schema.p2pSinais.id, of.id));
    assert.deepEqual((await corpo(await curta(doMac(ana, "/api/p2p/espera?curto=1")))).sinais, []);

    let ultimo = 0;
    for (let i = 0; i < 21; i++) {
      ultimo = (await rSinal.POST(doCelular(ana, "/api/p2p/sinal", { corpo: { tipo: "oferta", para: ana.macId, sdp: SDP, resumo: { arquivos: 1, bytes: 1, nomes: [] } } }))).status;
    }
    assert.equal(ultimo, 429);
  });

  test("computador desconectado some da lista do celular", async () => {
    await curta(doMac(victor, "/api/p2p/espera?curto=1"));
    await sessao.revogarSessaoDe(victor.id, victor.macId);
    const r = await corpo(await rAparelhos.GET(doCelular(victor, "/api/p2p/aparelhos")));
    assert.deepEqual(r.aparelhos, []);
  });
});
