/**
 * Trocar ou redefinir a senha encerra tudo (revisão de segurança, A4): sessões de outros aparelhos e dos
 * computadores, código de computador ainda não levado, chave do Atalho e inscrições de push. Os links pra IA (/r/…)
 * só saem quando a pessoa pede. Uma conta não mexe na outra.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { prepararAmbiente } from "./ambiente.mjs";

let amb: Awaited<ReturnType<typeof prepararAmbiente>>;
let contas: typeof import("../src/lib/auth/contas");
let sessao: typeof import("../src/lib/auth/sessao");
let redefinir: typeof import("../src/lib/auth/redefinir");
let encerrar: typeof import("../src/lib/auth/encerrar");
let atalho: typeof import("../src/lib/referencias/atalho");
let push: typeof import("../src/lib/acompanhar/push");
let dispositivo: typeof import("../src/lib/dispositivo");
let tokens: typeof import("../src/lib/auth/tokens");

before(async () => {
  amb = await prepararAmbiente();
  contas = await import("../src/lib/auth/contas");
  sessao = await import("../src/lib/auth/sessao");
  redefinir = await import("../src/lib/auth/redefinir");
  encerrar = await import("../src/lib/auth/encerrar");
  atalho = await import("../src/lib/referencias/atalho");
  push = await import("../src/lib/acompanhar/push");
  dispositivo = await import("../src/lib/dispositivo");
  tokens = await import("../src/lib/auth/tokens");
});

after(async () => {
  await amb?.fechar();
});

const SENHA = "uma senha comprida";
const CHAVES = { p256dh: "B".repeat(87), auth: "a".repeat(22) };
let n = 0;

/** Uma conta com tudo ligado: duas sessões do site, um computador (com andamento), um código liberado e não levado,
 *  a chave do Atalho, dois celulares com aviso e uma coleção com link pra IA. */
async function contaCheia() {
  const { db, schema } = amb.banco;
  const email = `cheia${++n}@exemplo.com`;
  const criada = await contas.criarConta({ nome: "Cheia", email, senha: SENHA, ip: `10.0.${n}.1` });
  assert.ok(criada.ok);
  const id = criada.usuario.id;
  const outra = await contas.entrarComSenha({ email, senha: SENHA, ip: `10.0.${n}.2` });
  assert.ok(outra.ok);
  const computador = await sessao.criarSessao(id, "dispositivo", { nome: "Mac", plataforma: "mac" });
  await db.insert(schema.dispositivoStatus).values({ sessaoId: computador.id, usuarioId: id, snapshot: {} as never });
  const pedido = await dispositivo.iniciar({ nome: "Mac do atacante", plataforma: "mac" });
  assert.ok(await dispositivo.aprovar(pedido.codigo, id));
  const chave = await atalho.gerarAtalho(id);
  await push.inscrever(id, `https://web.push.apple.com/conta${n}-a`, CHAVES);
  await push.inscrever(id, `https://fcm.googleapis.com/fcm/send/conta${n}-b`, CHAVES);
  const contaGoogleId = tokens.novoId();
  await db.insert(schema.contasGoogle).values({ id: contaGoogleId, usuarioId: id, googleSub: `sub-${n}`, email: `drive${n}@exemplo.com`, refreshTokenEnc: "x" });
  const publica = `link${n}`.padEnd(43, "x");
  await db.insert(schema.colecoes).values({ id: tokens.novoId(), usuarioId: id, contaGoogleId, driveFolderId: "pasta", nome: "Refs", nomeChave: "refs", publicaToken: publica });
  return { id, email, atual: criada, outra, computador, pedido, chave, publica };
}

async function estado(c: Awaited<ReturnType<typeof contaCheia>>) {
  const { db, schema } = amb.banco;
  const { eq } = await import("drizzle-orm");
  const [col] = await db.select().from(schema.colecoes).where(eq(schema.colecoes.usuarioId, c.id));
  return {
    atual: Boolean(await sessao.autenticar({ cookie: c.atual.token })),
    outra: Boolean(await sessao.autenticar({ cookie: c.outra.token })),
    computador: Boolean(await sessao.autenticar({ authorization: `Bearer ${c.computador.token}` })),
    andamento: (await db.select().from(schema.dispositivoStatus).where(eq(schema.dispositivoStatus.usuarioId, c.id))).length,
    pedido: (await dispositivo.aguardar(c.pedido.segredo)).estado,
    atalho: Boolean(await atalho.donoDoAtalho(`Atalho ${c.chave.token}`)),
    avisos: (await db.select().from(schema.pushInscricoes).where(eq(schema.pushInscricoes.usuarioId, c.id))).length,
    link: col.publicaToken,
  };
}

describe("trocar a senha encerra tudo", () => {
  test("outras sessões, computador, código liberado, Atalho e avisos; a sessão atual e o link pra IA ficam", async () => {
    const c = await contaCheia();
    const vizinha = await contaCheia();
    const atual = await sessao.autenticar({ cookie: c.atual.token });
    assert.ok(atual);

    const r = await contas.trocarSenha({ usuarioId: c.id, sessaoId: atual.sessao.id, senhaAtual: SENHA, senhaNova: "outra senha comprida", ip: "10.9.9.1" });
    assert.ok(r.ok);
    assert.deepEqual(r.encerrado, { sessoes: 1, computadores: 1, atalhos: 1, avisos: 2, links: 0 });
    assert.deepEqual(await estado(c), { atual: true, outra: false, computador: false, andamento: 0, pedido: "expirado", atalho: false, avisos: 0, link: c.publica });
    assert.equal(
      encerrar.frase(r.encerrado, "Senha trocada"),
      "Senha trocada: os outros aparelhos e os computadores saíram da conta, a chave do Atalho foi desligada e os avisos no celular voltam quando você abrir o app logado.",
    );

    // A outra conta continua inteira.
    const v = await estado(vizinha);
    assert.deepEqual({ ...v, pedido: undefined }, { atual: true, outra: true, computador: true, andamento: 1, pedido: undefined, atalho: true, avisos: 2, link: vizinha.publica });
  });

  test("com a opção, desliga também os links pra IA", async () => {
    const c = await contaCheia();
    assert.equal(await encerrar.linksLigados(c.id), 1);
    const atual = await sessao.autenticar({ cookie: c.atual.token });
    assert.ok(atual);
    const r = await contas.trocarSenha({ usuarioId: c.id, sessaoId: atual.sessao.id, senhaAtual: SENHA, senhaNova: "outra senha comprida", ip: "10.9.9.2", links: true });
    assert.ok(r.ok);
    assert.equal(r.encerrado.links, 1);
    assert.equal((await estado(c)).link, null);
    assert.equal(await encerrar.linksLigados(c.id), 0);
  });

  test("senha atual errada não encerra nada", async () => {
    const c = await contaCheia();
    const atual = await sessao.autenticar({ cookie: c.atual.token });
    assert.ok(atual);
    const r = await contas.trocarSenha({ usuarioId: c.id, sessaoId: atual.sessao.id, senhaAtual: "não é esta", senhaNova: "outra senha comprida", ip: "10.9.9.3" });
    assert.ok(!r.ok);
    const e = await estado(c);
    assert.deepEqual({ ...e, pedido: undefined }, { atual: true, outra: true, computador: true, andamento: 1, pedido: undefined, atalho: true, avisos: 2, link: c.publica });
  });
});

describe("redefinir a senha pelo link encerra tudo", () => {
  test("todas as sessões (inclusive a de quem pediu), computador, código, Atalho e avisos", async () => {
    const c = await contaCheia();
    const { db, schema } = amb.banco;
    const token = tokens.novoToken();
    await db.insert(schema.redefinicoesSenha).values({ id: tokens.novoId(), usuarioId: c.id, tokenHash: tokens.hashToken(token), expiraEm: new Date(Date.now() + 60_000) });

    const r = await redefinir.redefinirSenha({ token, senha: "senha nova comprida" });
    assert.ok(r.ok);
    assert.deepEqual(r.encerrado, { sessoes: 2, computadores: 1, atalhos: 1, avisos: 2, links: 0 });
    assert.deepEqual(await estado(c), { atual: false, outra: false, computador: false, andamento: 0, pedido: "expirado", atalho: false, avisos: 0, link: c.publica });
    assert.ok(await sessao.autenticar({ cookie: r.token }), "a sessão nova vale");
  });

  test("com links: true, desliga os links pra IA", async () => {
    const c = await contaCheia();
    const { db, schema } = amb.banco;
    const token = tokens.novoToken();
    await db.insert(schema.redefinicoesSenha).values({ id: tokens.novoId(), usuarioId: c.id, tokenHash: tokens.hashToken(token), expiraEm: new Date(Date.now() + 60_000) });
    const r = await redefinir.redefinirSenha({ token, senha: "senha nova comprida", links: true });
    assert.ok(r.ok);
    assert.equal(r.encerrado.links, 1);
    assert.equal((await estado(c)).link, null);
  });
});
