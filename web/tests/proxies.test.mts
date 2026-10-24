/**
 * Pedidos de proxy (docs/CONTAS.md §11): o celular pede (só contas Google da pessoa, sem repetir o que já espera),
 * o computador pega sem corrida, conta como foi e o dono só devolve para a fila.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { CONTA_ANA, pedido, prepararAmbiente, type Pedido } from "./ambiente.mjs";

let amb: Awaited<ReturnType<typeof prepararAmbiente>>;
let contas: typeof import("../src/lib/auth/contas");
let sessao: typeof import("../src/lib/auth/sessao");
let rLista: typeof import("../src/app/api/proxies/pedidos/route");
let rPedido: typeof import("../src/app/api/proxies/pedidos/[id]/route");
let rPegar: typeof import("../src/app/api/proxies/pedidos/[id]/pegar/route");

type Pessoa = { id: string; cookie: string; mac: string; pc: string };
let victor: Pessoa;
let ana: Pessoa;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as any;
const comCookie = (p: Pessoa, extra: Pedido = {}): Pedido => ({ cookies: { sd_sessao: p.cookie }, ...extra });
const corpo = async (res: Response) => (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function novaPessoa(nome: string, email: string, ip: string): Promise<Pessoa> {
  const r = await contas.criarConta({ nome, email, senha: "uma senha comprida", ip });
  assert.ok(r.ok);
  const mac = await sessao.criarSessao(r.usuario.id, "dispositivo", { nome: `Mac de ${nome}`, plataforma: "mac" });
  const pc = await sessao.criarSessao(r.usuario.id, "dispositivo", { nome: `PC de ${nome}`, plataforma: "windows" });
  return { id: r.usuario.id, cookie: r.token, mac: mac.token, pc: pc.token };
}

async function ligarConta(p: Pessoa, id: string, sub: string) {
  const { db, schema } = amb.banco;
  await db.insert(schema.contasGoogle).values({
    id,
    usuarioId: p.id,
    googleSub: sub,
    email: `${sub}@exemplo.com`,
    nome: CONTA_ANA.name,
    refreshTokenEnc: "x",
    escopos: "https://www.googleapis.com/auth/drive",
  });
}

const pedir = (p: Pessoa, b: Record<string, unknown>, extra: Pedido = {}) =>
  rLista.POST(pedido("/api/proxies/pedidos", comCookie(p, { corpo: b, ...extra })));
const pegar = (bearer: string, id: string) => rPegar.POST(pedido(`/api/proxies/pedidos/${id}/pegar`, { bearer, method: "POST" }), ctx({ id }));
const mudar = (id: string, b: Record<string, unknown>, quem: { bearer?: string; cookie?: Pessoa }) =>
  rPedido.PATCH(
    pedido(`/api/proxies/pedidos/${id}`, quem.bearer ? { bearer: quem.bearer, method: "PATCH", corpo: b } : comCookie(quem.cookie!, { method: "PATCH", corpo: b })),
    ctx({ id }),
  );

before(async () => {
  amb = await prepararAmbiente();
  contas = await import("../src/lib/auth/contas");
  sessao = await import("../src/lib/auth/sessao");
  rLista = await import("../src/app/api/proxies/pedidos/route");
  rPedido = await import("../src/app/api/proxies/pedidos/[id]/route");
  rPegar = await import("../src/app/api/proxies/pedidos/[id]/pegar/route");
  victor = await novaPessoa("Victor Barroso", "victor.proxy@exemplo.com", "10.0.1.1");
  ana = await novaPessoa("Ana Montadora", "ana.proxy@exemplo.com", "10.0.1.2");
  await ligarConta(victor, "cg_victor", "sub-victor-proxy");
  await ligarConta(ana, "cg_ana", "sub-ana-proxy");
});

after(async () => {
  await amb?.fechar();
});

describe("pedir", () => {
  test("sem sessão, entrada ruim e conta de outra pessoa", async () => {
    assert.equal((await rLista.POST(pedido("/api/proxies/pedidos", { corpo: { contaGoogleId: "cg_victor", itens: [{ fileId: "a" }] } }))).status, 401);
    assert.equal((await pedir(victor, { contaGoogleId: "cg_victor", itens: [] })).status, 400);
    assert.equal((await pedir(victor, { contaGoogleId: "cg_victor", itens: [{ fileId: "../x" }] })).status, 400);
    const muitos = Array.from({ length: 201 }, (_, i) => ({ fileId: `f${i}` }));
    assert.equal((await pedir(victor, { contaGoogleId: "cg_victor", itens: muitos })).status, 400);
    assert.equal((await pedir(victor, { contaGoogleId: "cg_ana", itens: [{ fileId: "a" }] })).status, 404);
  });

  test("guarda, não repete o que já espera e lista por arquivo", async () => {
    const r = await pedir(victor, { contaGoogleId: "cg_victor", itens: [{ fileId: "take1", nome: "A001.braw", tamanho: 1234 }, { fileId: "take2", nome: "A002.mp4" }, { fileId: "take1" }] });
    assert.equal(r.status, 201);
    const b = await corpo(r);
    assert.equal(b.novos, 2);
    assert.deepEqual(b.pedidos.map((p: { fileId: string }) => p.fileId), ["take1", "take2"]);
    assert.equal(b.pedidos[0].status, "pendente");
    assert.equal(b.pedidos[0].tamanho, 1234);

    const repetido = await pedir(victor, { contaGoogleId: "cg_victor", itens: [{ fileId: "take1" }, { fileId: "take3", nome: "A003.mov" }] });
    assert.equal(repetido.status, 201);
    const rb = await corpo(repetido);
    assert.equal(rb.novos, 1);
    assert.equal(rb.pedidos[0].id, b.pedidos[0].id, "o mesmo pedido volta");

    const so = await corpo(await rLista.GET(pedido("/api/proxies/pedidos?fileIds=take1,take3", comCookie(victor))));
    assert.equal(so.pedidos.length, 2);
    const pend = await corpo(await rLista.GET(pedido("/api/proxies/pedidos?status=pendente", { bearer: victor.mac })));
    assert.equal(pend.pedidos.length, 3);
    assert.equal((await rLista.GET(pedido("/api/proxies/pedidos?status=xyz", { bearer: victor.mac }))).status, 400);
    assert.equal((await corpo(await rLista.GET(pedido("/api/proxies/pedidos", comCookie(ana))))).pedidos.length, 0, "cada um vê os seus");
  });
});

describe("computador", () => {
  test("pegar sem corrida, sinal de vida, pronto e erro", async () => {
    const lista = await corpo(await rLista.GET(pedido("/api/proxies/pedidos?status=pendente&fileIds=take2", { bearer: victor.mac })));
    const id = lista.pedidos[0].id as string;
    assert.equal((await rPegar.POST(pedido(`/api/proxies/pedidos/${id}/pegar`, comCookie(victor, { method: "POST" })), ctx({ id }))).status, 403, "o celular não pega");
    const corrida = await Promise.all([pegar(victor.mac, id), pegar(victor.pc, id)]);
    assert.deepEqual(corrida.map((r) => r.status).sort(), [200, 409]);
    const vencedor = corrida[0].status === 200 ? victor.mac : victor.pc;
    const perdedor = vencedor === victor.mac ? victor.pc : victor.mac;
    assert.equal((await pegar(vencedor, id)).status, 200, "pedir de novo é seguro");
    assert.equal((await pegar(ana.mac, id)).status, 404, "de outra conta");

    assert.equal((await mudar(id, { status: "gerando" }, { bearer: vencedor })).status, 200);
    assert.equal((await mudar(id, { status: "pronto" }, { bearer: perdedor })).status, 409);
    assert.equal((await mudar(id, { status: "pronto" }, { cookie: victor })).status, 403);
    assert.equal((await mudar(id, { status: "pronto", proxyFileId: "../x" }, { bearer: vencedor })).status, 400);
    const pronto = await mudar(id, { status: "pronto", proxyFileId: "proxy2", resultado: "Proxy e quadros prontos" }, { bearer: vencedor });
    assert.equal(pronto.status, 200);
    const pb = (await corpo(pronto)).pedido;
    assert.equal(pb.status, "pronto");
    assert.equal(pb.proxyFileId, "proxy2");
    assert.equal((await mudar(id, { status: "pendente" }, { cookie: victor })).status, 409, "pronto não volta");

    // Pronto não segura um pedido novo do mesmo arquivo.
    const outra = await corpo(await pedir(victor, { contaGoogleId: "cg_victor", itens: [{ fileId: "take2" }] }));
    assert.equal(outra.novos, 1);
  });

  test("erro, tentar de novo pelo celular e preso por 30 min", async () => {
    const lista = await corpo(await rLista.GET(pedido("/api/proxies/pedidos?status=pendente&fileIds=take3", { bearer: victor.mac })));
    const id = lista.pedidos[0].id as string;
    assert.equal((await pegar(victor.mac, id)).status, 200);
    const erro = await corpo(await mudar(id, { status: "erro", erro: "Sem o Blackmagic RAW" }, { bearer: victor.mac }));
    assert.equal(erro.pedido.erro, "Sem o Blackmagic RAW");
    const deNovo = await corpo(await mudar(id, { status: "pendente" }, { cookie: victor }));
    assert.equal(deNovo.pedido.status, "pendente");
    assert.equal(deNovo.pedido.erro, null);
    assert.equal(deNovo.pedido.dispositivoId, null);

    assert.equal((await pegar(victor.mac, id)).status, 200);
    assert.equal((await pegar(victor.pc, id)).status, 409);
    const { db, schema } = amb.banco;
    const { eq } = await import("drizzle-orm");
    await db.update(schema.pedidosProxy).set({ atualizadoEm: new Date(Date.now() - 31 * 60_000) }).where(eq(schema.pedidosProxy.id, id));
    assert.equal((await pegar(victor.pc, id)).status, 200);

    assert.equal((await rPedido.DELETE(pedido(`/api/proxies/pedidos/${id}`, comCookie(ana, { method: "DELETE" })), ctx({ id }))).status, 404);
    assert.equal((await rPedido.DELETE(pedido(`/api/proxies/pedidos/${id}`, comCookie(victor, { method: "DELETE" })), ctx({ id }))).status, 200);
    assert.equal((await rPedido.DELETE(pedido(`/api/proxies/pedidos/${id}`, comCookie(victor, { method: "DELETE" })), ctx({ id }))).status, 404);
  });
});

describe("frames", () => {
  const AJ = { frames: { quantidade: 24, formato: "jpg" }, takes: { quantidade: 6, duracao: 3, formato: "9:16", codec: "h264", audio: true } };

  test("pede com ajustes válidos; sem ajustes ou fora do limite, recusa", async () => {
    assert.equal((await pedir(victor, { contaGoogleId: "cg_victor", tipo: "frames", itens: [{ fileId: "filme1" }] })).status, 400, "frames sem ajustes");
    assert.equal((await pedir(victor, { contaGoogleId: "cg_victor", tipo: "frames", ajustes: { frames: { quantidade: 999, formato: "jpg" } }, itens: [{ fileId: "filme1" }] })).status, 400);
    assert.equal((await pedir(victor, { contaGoogleId: "cg_victor", tipo: "frames", ajustes: { ...AJ, takes: { ...AJ.takes, codec: "dnx" } }, itens: [{ fileId: "filme1" }] })).status, 400);
    assert.equal((await pedir(victor, { contaGoogleId: "cg_victor", tipo: "gif", itens: [{ fileId: "filme1" }] })).status, 400);
    const muitos = Array.from({ length: 21 }, (_, i) => ({ fileId: `fm${i}` }));
    assert.equal((await pedir(victor, { contaGoogleId: "cg_victor", tipo: "frames", ajustes: AJ, itens: muitos })).status, 400);
    const r = await pedir(victor, { contaGoogleId: "cg_victor", tipo: "frames", ajustes: { ...AJ, extra: "fora" }, itens: [{ fileId: "filme1", nome: "Filme Final.mov" }] });
    assert.equal(r.status, 201);
    const p = (await corpo(r)).pedidos[0];
    assert.equal(p.tipo, "frames");
    assert.deepEqual(p.ajustes, AJ, "só os ajustes conhecidos ficam");
  });

  test("proxy e frames do mesmo arquivo convivem; o app antigo (sem tipo) só vê proxy", async () => {
    const pr = await corpo(await pedir(victor, { contaGoogleId: "cg_victor", itens: [{ fileId: "filme1" }] }));
    assert.equal(pr.novos, 1, "o proxy do mesmo vídeo é outro pedido");
    assert.equal(pr.pedidos[0].tipo, "proxy");
    const repetido = await corpo(await pedir(victor, { contaGoogleId: "cg_victor", tipo: "frames", ajustes: AJ, itens: [{ fileId: "filme1" }] }));
    assert.equal(repetido.novos, 0, "o mesmo pedido de frames esperando não repete");

    const antigo = await corpo(await rLista.GET(pedido("/api/proxies/pedidos?status=pendente&fileIds=filme1", { bearer: victor.mac })));
    assert.deepEqual(antigo.pedidos.map((x: { tipo: string }) => x.tipo), ["proxy"]);
    const doFrames = await corpo(await rLista.GET(pedido("/api/proxies/pedidos?status=pendente&tipo=frames", { bearer: victor.mac })));
    assert.deepEqual(doFrames.pedidos.map((x: { fileId: string }) => x.fileId), ["filme1"]);
    const todos = await corpo(await rLista.GET(pedido("/api/proxies/pedidos?fileIds=filme1&tipo=todos", comCookie(victor))));
    assert.equal(todos.pedidos.length, 2);
    assert.equal((await rLista.GET(pedido("/api/proxies/pedidos?tipo=gif", comCookie(victor)))).status, 400);

    // Pegar e terminar como no proxy; a mensagem do pronto fala de frames.
    const id = doFrames.pedidos[0].id as string;
    assert.equal((await pegar(victor.pc, id)).status, 200);
    const pronto = await corpo(await mudar(id, { status: "pronto", proxyFileId: "pastaFrames", resultado: "24 frames e 6 takes" }, { bearer: victor.pc }));
    assert.equal(pronto.pedido.resultado, "24 frames e 6 takes");
    const de = await mudar(id, { status: "pendente" }, { cookie: victor });
    assert.equal(de.status, 409);
    assert.match((await corpo(de)).mensagem, /frames já foram feitos/);
  });
});

describe("formato (\"Baixar como…\" das Referências)", () => {
  test("pede um formato conhecido; sem ajustes, formato desconhecido ou o original, recusa", async () => {
    const base = { contaGoogleId: "cg_victor", tipo: "formato", itens: [{ fileId: "reel1", nome: "Reel (Instagram).mp4" }] };
    assert.equal((await pedir(victor, base)).status, 400, "sem ajustes");
    assert.equal((await pedir(victor, { ...base, ajustes: { formato: "flac" } })).status, 400);
    assert.equal((await pedir(victor, { ...base, ajustes: { formato: "original" } })).status, 400, "o original já está no Drive");
    assert.equal((await pedir(victor, { ...base, ajustes: { formato: "mp3-320" }, itens: Array.from({ length: 21 }, (_, i) => ({ fileId: `r${i}` })) })).status, 400);
    const r = await pedir(victor, { ...base, ajustes: { formato: "mp3-320", extra: "fora" } });
    assert.equal(r.status, 201);
    const p = (await corpo(r)).pedidos[0];
    assert.equal(p.tipo, "formato");
    assert.deepEqual(p.ajustes, { formato: "mp3-320" }, "só o formato fica");
  });

  test("o mesmo formato esperando não repete; outro formato do mesmo arquivo é outro pedido; o computador conclui", async () => {
    const base = { contaGoogleId: "cg_victor", tipo: "formato", itens: [{ fileId: "reel1" }] };
    const igual = await corpo(await pedir(victor, { ...base, ajustes: { formato: "mp3-320" } }));
    assert.equal(igual.novos, 0);
    const wav = await corpo(await pedir(victor, { ...base, ajustes: { formato: "wav" } }));
    assert.equal(wav.novos, 1);
    assert.deepEqual(wav.pedidos[0].ajustes, { formato: "wav" });
    // O app antigo (sem tipo) e o consumidor de frames não veem os de formato.
    const antigo = await corpo(await rLista.GET(pedido("/api/proxies/pedidos?status=pendente&fileIds=reel1", { bearer: victor.mac })));
    assert.equal(antigo.pedidos.length, 0);
    const doFormato = await corpo(await rLista.GET(pedido("/api/proxies/pedidos?status=pendente&tipo=formato", { bearer: victor.mac })));
    assert.deepEqual(doFormato.pedidos.map((x: { ajustes: { formato: string } }) => x.ajustes.formato).sort(), ["mp3-320", "wav"]);
    const id = wav.pedidos[0].id as string;
    assert.equal((await pegar(victor.mac, id)).status, 200);
    const erro = await corpo(await mudar(id, { status: "erro" }, { bearer: victor.mac }));
    assert.equal(erro.pedido.erro, "Não deu para converter.");
    assert.equal((await mudar(id, { status: "pendente" }, { cookie: victor })).status, 200, "tentar de novo pelo celular");
    assert.equal((await pegar(victor.mac, id)).status, 200);
    const pronto = await corpo(await mudar(id, { status: "pronto", resultado: "WAV salvo ao lado do original", proxyFileId: "wav123" }, { bearer: victor.mac }));
    assert.equal(pronto.pedido.proxyFileId, "wav123");
    const de = await mudar(id, { status: "pendente" }, { cookie: victor });
    assert.equal(de.status, 409);
    assert.match((await corpo(de)).mensagem, /já foi convertido/);
  });
});
