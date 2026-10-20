/**
 * "Entre computadores" (docs/LAN.md): o computador avisa onde está na rede (só sessão de dispositivo, só endereço
 * local, chave selada no banco), os outros da MESMA conta leem endereço e chave; o próprio, outra conta, o site e uma
 * sessão revogada ficam de fora; sem notícia por 3 min ele some.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { pedido, prepararAmbiente } from "./ambiente.mjs";

let amb: Awaited<ReturnType<typeof prepararAmbiente>>;
let contas: typeof import("../src/lib/auth/contas");
let sessao: typeof import("../src/lib/auth/sessao");
let presenca: typeof import("../src/lib/lan/presenca");
let rPresenca: typeof import("../src/app/api/lan/presenca/route");
let rComp: typeof import("../src/app/api/lan/computadores/route");
let rPerto: typeof import("../src/app/api/lan/proximos/route");

const corpo = async (res: Response) => (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const CHAVE = "a".repeat(43);

async function pessoa(nome: string, email: string) {
  const r = await contas.criarConta({ nome, email, senha: "uma senha comprida", ip: "10.0.0.9" });
  assert.ok(r.ok);
  const mac = await sessao.criarSessao(r.usuario.id, "dispositivo", { nome: `MacBook de ${nome}`, plataforma: "mac" });
  const pc = await sessao.criarSessao(r.usuario.id, "dispositivo", { nome: `PC de ${nome}`, plataforma: "windows" });
  return { id: r.usuario.id, cookie: r.token, mac: mac.token, macId: mac.id, pc: pc.token, pcId: pc.id };
}

describe("entre computadores (presença na rede)", () => {
  before(async () => {
    amb = await prepararAmbiente();
    contas = await import("../src/lib/auth/contas");
    sessao = await import("../src/lib/auth/sessao");
    presenca = await import("../src/lib/lan/presenca");
    rPresenca = await import("../src/app/api/lan/presenca/route");
    rComp = await import("../src/app/api/lan/computadores/route");
    rPerto = await import("../src/app/api/lan/proximos/route");
  });
  after(() => amb.fechar());

  test("endereço da rede local: privados sim, públicos não", () => {
    for (const ip of ["192.168.0.12", "10.1.2.3", "172.20.0.5", "169.254.10.1", "fe80::1c2b:3aff:fe4d:1", "fd12:3456::1"]) assert.ok(presenca.enderecoLocal(ip), ip);
    for (const ip of ["8.8.8.8", "172.32.0.1", "200.1.2.3", "256.1.1.1", "2001:4860::8888", "localhost", "127.0.0.1"]) assert.ok(!presenca.enderecoLocal(ip), ip);
  });

  test("o Mac avisa, o PC da mesma conta vê endereço e chave; o próprio Mac, outra conta e o site não", async () => {
    const victor = await pessoa("Victor", "victor@exemplo.com");
    const edu = await pessoa("Edu", "edu@exemplo.com");

    const ok = await rPresenca.POST(pedido("/api/lan/presenca", { bearer: victor.mac, corpo: { v: 1, enderecos: ["192.168.0.12", "10.0.0.4"], porta: 4320, chave: CHAVE } }));
    assert.equal(ok.status, 200);

    const doPc = await corpo(await rComp.GET(pedido("/api/lan/computadores", { bearer: victor.pc })));
    assert.equal(doPc.computadores.length, 1);
    assert.deepEqual(
      { ...doPc.computadores[0], vistoEm: undefined },
      { id: victor.macId, nome: "MacBook de Victor", plataforma: "mac", enderecos: ["192.168.0.12", "10.0.0.4"], porta: 4320, chave: CHAVE, vistoEm: undefined },
    );
    assert.equal((await corpo(await rComp.GET(pedido("/api/lan/computadores", { bearer: victor.mac })))).computadores.length, 0, "não lista a si mesmo");
    assert.equal((await corpo(await rComp.GET(pedido("/api/lan/computadores", { bearer: edu.pc })))).computadores.length, 0, "outra conta não vê");
    assert.equal((await rComp.GET(pedido("/api/lan/computadores", { cookies: { sd_sessao: victor.cookie } }))).status, 403, "o site não recebe a chave");
    assert.equal((await rComp.GET(pedido("/api/lan/computadores"))).status, 401);

    // A chave fica selada no banco.
    const [linha] = await amb.banco.db.select().from((await import("../src/lib/db")).schema.lanPresenca);
    assert.ok(!linha.chaveEnc.includes(CHAVE));

    // Desligou a recepção: some.
    assert.equal((await rPresenca.DELETE(pedido("/api/lan/presenca", { method: "DELETE", bearer: victor.mac }))).status, 204);
    assert.equal((await corpo(await rComp.GET(pedido("/api/lan/computadores", { bearer: victor.pc })))).computadores.length, 0);
  });

  test("formato conferido; só sessão de dispositivo avisa; sessão revogada some; sem notícia por 3 min some", async () => {
    const ana = await pessoa("Ana", "ana@exemplo.com");
    const ruins = [
      { v: 1, enderecos: ["8.8.8.8"], porta: 4320, chave: CHAVE },
      { v: 1, enderecos: ["192.168.0.2"], porta: 80, chave: CHAVE },
      { v: 1, enderecos: ["192.168.0.2"], porta: 4320, chave: "curta" },
      { v: 1, enderecos: [], porta: 4320, chave: CHAVE },
      { v: 2, enderecos: ["192.168.0.2"], porta: 4320, chave: CHAVE },
      { v: 1, enderecos: ["192.168.0.2"], porta: 4320, chave: CHAVE, extra: 1 },
    ];
    for (const c of ruins) assert.equal((await rPresenca.POST(pedido("/api/lan/presenca", { bearer: ana.mac, corpo: c }))).status, 400, JSON.stringify(c));
    assert.equal((await rPresenca.POST(pedido("/api/lan/presenca", { cookies: { sd_sessao: ana.cookie }, corpo: { v: 1, enderecos: ["192.168.0.2"], porta: 4320, chave: CHAVE } }))).status, 403);

    await rPresenca.POST(pedido("/api/lan/presenca", { bearer: ana.mac, corpo: { v: 1, enderecos: ["192.168.0.2"], porta: 4320, chave: CHAVE } }));
    assert.equal((await corpo(await rComp.GET(pedido("/api/lan/computadores", { bearer: ana.pc })))).computadores.length, 1);

    // Sem notícia por mais de 3 min.
    const { schema, db } = await import("../src/lib/db");
    const { eq } = await import("drizzle-orm");
    await db.update(schema.lanPresenca).set({ atualizadoEm: new Date(Date.now() - 4 * 60_000) }).where(eq(schema.lanPresenca.sessaoId, ana.macId));
    assert.equal((await corpo(await rComp.GET(pedido("/api/lan/computadores", { bearer: ana.pc })))).computadores.length, 0);

    // Avisou de novo e a sessão foi revogada (saiu da conta no Mac): some.
    await rPresenca.POST(pedido("/api/lan/presenca", { bearer: ana.mac, corpo: { v: 1, enderecos: ["192.168.0.2"], porta: 4320, chave: CHAVE } }));
    await db.update(schema.sessoes).set({ revogadaEm: new Date() }).where(eq(schema.sessoes.id, ana.macId));
    assert.equal((await corpo(await rComp.GET(pedido("/api/lan/computadores", { bearer: ana.pc })))).computadores.length, 0);
  });

  test("por perto: outra conta na MESMA rede vê nome, dono e chave pública (não a chave de recepção); outra rede e quem não aceita, não", async () => {
    const editor = await pessoa("Marcos Silva", "marcos@exemplo.com");
    const victor = await pessoa("Victor", "victor2@exemplo.com");
    const PUB = "b".repeat(43);
    const avisar = (bearer: string, ip: string, extra: Record<string, unknown>) =>
      rPresenca.POST(pedido("/api/lan/presenca", { bearer, ip, corpo: { v: 1, enderecos: ["192.168.1.20"], porta: 4320, chave: CHAVE, ...extra } }));
    // O PC do editor aceita outras contas; o Mac dele não.
    assert.equal((await avisar(editor.pc, "200.10.20.30", { chavePublica: PUB, outros: true })).status, 200);
    assert.equal((await avisar(editor.mac, "200.10.20.30", { chavePublica: PUB })).status, 200);

    const mesmaRede = await corpo(await rPerto.GET(pedido("/api/lan/proximos", { bearer: victor.mac, ip: "200.10.20.30" })));
    assert.equal(mesmaRede.computadores.length, 1);
    const c = mesmaRede.computadores[0];
    assert.deepEqual([c.id, c.nome, c.dono, c.chavePublica, c.porta], [editor.pcId, "PC de Marcos Silva", "Marcos", PUB, 4320]);
    assert.equal(c.chave, undefined, "a chave de recepção não vai para outra conta");
    assert.equal((await corpo(await rPerto.GET(pedido("/api/lan/proximos", { bearer: victor.mac, ip: "177.1.2.3" })))).computadores.length, 0, "outra rede");
    assert.equal((await corpo(await rPerto.GET(pedido("/api/lan/proximos", { bearer: editor.mac, ip: "200.10.20.30" })))).computadores.length, 0, "a própria conta fica na outra lista");
    assert.equal((await rPerto.GET(pedido("/api/lan/proximos", { cookies: { sd_sessao: victor.cookie }, ip: "200.10.20.30" }))).status, 403);
    // IPv6: o mesmo /64 é a mesma rede.
    await avisar(editor.pc, "2804:14c:5b8a:1000:aaaa:bbbb:cccc:1", { chavePublica: PUB, outros: true });
    assert.equal((await corpo(await rPerto.GET(pedido("/api/lan/proximos", { bearer: victor.mac, ip: "2804:14c:5b8a:1000::99" })))).computadores.length, 1);
    assert.equal((await corpo(await rPerto.GET(pedido("/api/lan/proximos", { bearer: victor.mac, ip: "2804:14c:5b8a:2000::99" })))).computadores.length, 0);
    // O IP não fica no banco.
    const { schema, db } = await import("../src/lib/db");
    const linhas = await db.select().from(schema.lanPresenca);
    assert.ok(linhas.every((l) => !String(l.rede ?? "").includes("2804") && !String(l.rede ?? "").includes("200.10")));
    // Desligou "outras contas": some.
    await avisar(editor.pc, "200.10.20.30", { chavePublica: PUB, outros: false });
    assert.equal((await corpo(await rPerto.GET(pedido("/api/lan/proximos", { bearer: victor.mac, ip: "200.10.20.30" })))).computadores.length, 0);
  });
});
