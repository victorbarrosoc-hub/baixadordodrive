/**
 * Referências (docs/REFERENCIAS.md): recurso liberado (beta aberto e planos), coleções com as pastas no Drive,
 * fila do computador (pegar sem corrida), chave do Atalho do iPhone (só põe na fila), link pra IA (HTML, JSON e
 * Markdown, 404 depois de desligar, sem e-mail do dono) e a conferência de Origin.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { CONTA_ANA, CONTA_BETO, pedido, prepararAmbiente, SITE, type Pedido } from "./ambiente.mjs";

let amb: Awaited<ReturnType<typeof prepararAmbiente>>;
let contas: typeof import("../src/lib/auth/contas");
let sessao: typeof import("../src/lib/auth/sessao");
let cripto: typeof import("../src/lib/google/cripto");
let texto: typeof import("../src/lib/referencias/texto");
let publica: typeof import("../src/lib/referencias/publica");
let recursos: typeof import("../src/lib/recursos");
let eu: typeof import("../src/app/api/eu/route");
let rColecoes: typeof import("../src/app/api/referencias/colecoes/route");
let rColecao: typeof import("../src/app/api/referencias/colecoes/[id]/route");
let rFila: typeof import("../src/app/api/referencias/fila/route");
let rItem: typeof import("../src/app/api/referencias/fila/[id]/route");
let rPegar: typeof import("../src/app/api/referencias/fila/[id]/pegar/route");
let rAtalho: typeof import("../src/app/api/referencias/atalho/route");
let rAtalhoToken: typeof import("../src/app/api/referencias/atalho/token/route");
let rPublica: typeof import("../src/app/r/[token]/route");

type Pessoa = { id: string; email: string; cookie: string; mac: string; pc: string };
let victor: Pessoa;
let ana: Pessoa;
let contaGoogleVictor: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as any;
const comCookie = (p: Pessoa, extra: Pedido = {}): Pedido => ({ cookies: { sd_sessao: p.cookie }, ...extra });
const corpo = async (res: Response) => (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function novaPessoa(nome: string, email: string, ip: string): Promise<Pessoa> {
  const r = await contas.criarConta({ nome, email, senha: "uma senha comprida", ip });
  assert.ok(r.ok);
  const mac = await sessao.criarSessao(r.usuario.id, "dispositivo", { nome: `Mac de ${nome}`, plataforma: "mac" });
  const pc = await sessao.criarSessao(r.usuario.id, "dispositivo", { nome: `PC de ${nome}`, plataforma: "windows" });
  return { id: r.usuario.id, email, cookie: r.token, mac: mac.token, pc: pc.token };
}

/** Liga uma conta Google do Google falso à pessoa (sem o consentimento: só precisamos do Drive). */
async function ligarDrive(p: Pessoa, conta: typeof CONTA_ANA, id: string) {
  const { db, schema } = amb.banco;
  const refresh = amb.google.emitirRefresh(conta);
  await db.insert(schema.contasGoogle).values({
    id,
    usuarioId: p.id,
    googleSub: conta.sub,
    email: conta.email,
    nome: conta.name,
    refreshTokenEnc: cripto.selar(refresh, `contas_google.refresh:${id}`),
    escopos: "https://www.googleapis.com/auth/drive",
  });
}

async function criarColecao(p: Pessoa, nome: string, extra: Record<string, unknown> = {}) {
  return rColecoes.POST(pedido("/api/referencias/colecoes", comCookie(p, { corpo: { nome, ...extra } })));
}

before(async () => {
  amb = await prepararAmbiente();
  contas = await import("../src/lib/auth/contas");
  sessao = await import("../src/lib/auth/sessao");
  cripto = await import("../src/lib/google/cripto");
  texto = await import("../src/lib/referencias/texto");
  publica = await import("../src/lib/referencias/publica");
  recursos = await import("../src/lib/recursos");
  eu = await import("../src/app/api/eu/route");
  rColecoes = await import("../src/app/api/referencias/colecoes/route");
  rColecao = await import("../src/app/api/referencias/colecoes/[id]/route");
  rFila = await import("../src/app/api/referencias/fila/route");
  rItem = await import("../src/app/api/referencias/fila/[id]/route");
  rPegar = await import("../src/app/api/referencias/fila/[id]/pegar/route");
  rAtalho = await import("../src/app/api/referencias/atalho/route");
  rAtalhoToken = await import("../src/app/api/referencias/atalho/token/route");
  rPublica = await import("../src/app/r/[token]/route");
  victor = await novaPessoa("Victor Barroso", "victor@exemplo.com", "10.0.0.1");
  ana = await novaPessoa("Ana Montadora", "ana.conta@exemplo.com", "10.0.0.2");
});

after(async () => {
  delete process.env.SOBEDESCE_BETA_ABERTO;
  delete process.env.SOBEDESCE_ADMINS;
  await amb?.fechar();
});

describe("texto", () => {
  test("plataforma pelo link", () => {
    assert.equal(texto.plataformaDe("https://www.instagram.com/reel/abc/"), "Instagram");
    assert.equal(texto.plataformaDe("https://youtu.be/xyz"), "YouTube");
    assert.equal(texto.plataformaDe("https://m.youtube.com/watch?v=1"), "YouTube");
    assert.equal(texto.plataformaDe("https://vm.tiktok.com/ZM1/"), "TikTok");
    assert.equal(texto.plataformaDe("https://vimeo.com/1"), "Vimeo");
    assert.equal(texto.plataformaDe("https://br.pinterest.com/pin/1"), "Pinterest");
    assert.equal(texto.plataformaDe("https://pin.it/abc"), "Pinterest");
    assert.equal(texto.plataformaDe("https://twitter.com/a/status/1"), "X");
    assert.equal(texto.plataformaDe("https://x.com/a/status/1"), "X");
    assert.equal(texto.plataformaDe("https://fb.watch/abc"), "Facebook");
    assert.equal(texto.plataformaDe("https://www.behance.net/gallery/1"), "behance.net");
    assert.equal(texto.nomeDaPlataforma("instagram"), "Instagram");
    assert.equal(texto.nomeDaPlataforma("twitter"), "X");
  });

  test("link limpo: https, sem rastreio, achado no meio do texto", () => {
    assert.equal(texto.limparUrl("Olha isso https://www.instagram.com/reel/C1/?igsh=abc&utm_source=ig_web."), "https://www.instagram.com/reel/C1/");
    assert.equal(texto.limparUrl("https://www.youtube.com/watch?v=abc&si=xyz#t=10"), "https://www.youtube.com/watch?v=abc");
    assert.equal(texto.limparUrl("http://vimeo.com/1"), "https://vimeo.com/1");
    assert.equal(texto.limparUrl("ftp://exemplo.com/a"), null);
    assert.equal(texto.limparUrl("javascript:alert(1)"), null);
    assert.equal(texto.limparUrl("https://localhost/a"), null);
    assert.equal(texto.limparUrl(`https://exemplo.com/${"a".repeat(2100)}`), null);
    assert.equal(texto.limparUrl(42), null);
  });

  test("nome da coleção", () => {
    assert.deepEqual(texto.validarNome("  Clipes   2026 "), { ok: true, nome: "Clipes 2026" });
    assert.equal(texto.validarNome("").ok, false);
    assert.equal(texto.validarNome("a/b").ok, false);
    assert.equal(texto.validarNome("x".repeat(81)).ok, false);
    assert.equal(texto.validarNome("x".repeat(80)).ok, true);
    assert.equal(texto.chaveNome("Clipés"), texto.chaveNome("clipes"));
  });

  test("descrição do computador, lida com cuidado", () => {
    const d = texto.lerDescricao(
      "https://www.instagram.com/reel/C1/\nTítulo: Plano-sequência no metrô\nAutor: @fulano\nPlataforma: Instagram\nSalvo em: 2026-10-16T14:03:00Z\n\nLegenda linha 1\nTitulo: não é cabeçalho aqui",
    );
    assert.deepEqual(d, {
      url: "https://www.instagram.com/reel/C1/",
      titulo: "Plano-sequência no metrô",
      autor: "@fulano",
      plataforma: "Instagram",
      salvoEm: "2026-10-16T14:03:00Z",
      legenda: "Legenda linha 1\nTitulo: não é cabeçalho aqui",
    });
    assert.deepEqual(texto.lerDescricao("só uma nota solta"), { url: null, titulo: null, autor: null, plataforma: null, salvoEm: null, legenda: "só uma nota solta" });
    assert.deepEqual(texto.lerDescricao(null).legenda, "");
    assert.equal(texto.lerDescricao("https://a.com/x\r\nAutor: B\r\n\r\nC").autor, "B");
  });
});

describe("recurso liberado", () => {
  test("beta aberto (padrão): toda conta usa, e /api/eu diz isso", async () => {
    assert.equal(recursos.betaAberto({}), true);
    assert.equal(recursos.betaAberto({ SOBEDESCE_BETA_ABERTO: "0" }), false);
    assert.equal(recursos.betaAberto({ SOBEDESCE_BETA_ABERTO: "false" }), false);
    assert.equal(recursos.betaAberto({ SOBEDESCE_BETA_ABERTO: "1" }), true);
    const r = await rColecoes.GET(pedido("/api/referencias/colecoes", comCookie(ana)));
    assert.equal(r.status, 200);
    assert.deepEqual((await corpo(await eu.GET(pedido("/api/eu", comCookie(ana))))).recursos, { referencias: true });
  });

  test("beta fechado: 403 { ok: false, motivo: 'plano' } até ter o plano Produtora ou ser admin", async () => {
    process.env.SOBEDESCE_BETA_ABERTO = "0";
    process.env.SOBEDESCE_ADMINS = "chefe@exemplo.com";
    try {
      const r = await rColecoes.GET(pedido("/api/referencias/colecoes", comCookie(ana)));
      assert.equal(r.status, 403);
      const c = await corpo(r);
      assert.equal(c.ok, false);
      assert.equal(c.motivo, "plano");
      assert.equal((await rFila.GET(pedido("/api/referencias/fila", { bearer: ana.mac }))).status, 403);
      assert.deepEqual((await corpo(await eu.GET(pedido("/api/eu", comCookie(ana))))).recursos, { referencias: false });

      assert.equal(await recursos.trocarPlano(ana.id, "pro"), true);
      assert.equal((await rColecoes.GET(pedido("/api/referencias/colecoes", comCookie(ana)))).status, 403, "Pro não tem Referências");
      await recursos.trocarPlano(ana.id, "produtora");
      assert.equal((await rColecoes.GET(pedido("/api/referencias/colecoes", comCookie(ana)))).status, 200);
      await recursos.trocarPlano(ana.id, "gratis");

      // Admin é pelo e-mail de um Drive conectado; o e-mail da conta (não confirmado) não vale.
      process.env.SOBEDESCE_ADMINS = "ana.conta@exemplo.com";
      assert.equal((await rColecoes.GET(pedido("/api/referencias/colecoes", comCookie(ana)))).status, 403, "e-mail da conta não faz admin");
      await amb.banco.db.insert(amb.banco.schema.contasGoogle).values({ id: "ga-admin", usuarioId: ana.id, googleSub: "ana-admin", email: "Ana.Drive@exemplo.com", refreshTokenEnc: "x" });
      process.env.SOBEDESCE_ADMINS = "ana.drive@exemplo.com";
      assert.equal((await rColecoes.GET(pedido("/api/referencias/colecoes", comCookie(ana)))).status, 403, "Drive com e-mail não confirmado não faz admin");
      const { eq } = await import("drizzle-orm");
      await amb.banco.db.update(amb.banco.schema.contasGoogle).set({ emailVerificado: true }).where(eq(amb.banco.schema.contasGoogle.id, "ga-admin"));
      assert.equal((await rColecoes.GET(pedido("/api/referencias/colecoes", comCookie(ana)))).status, 200, "admin usa");
    } finally {
      delete process.env.SOBEDESCE_BETA_ABERTO;
      delete process.env.SOBEDESCE_ADMINS;
      const { eq } = await import("drizzle-orm");
      await amb.banco.db.delete(amb.banco.schema.contasGoogle).where(eq(amb.banco.schema.contasGoogle.id, "ga-admin"));
    }
  });

  test("sem sessão: 401", async () => {
    const r = await rColecoes.GET(pedido("/api/referencias/colecoes"));
    assert.equal(r.status, 401);
    assert.equal((await corpo(r)).ok, false);
  });
});

describe("coleções", () => {
  test("sem Drive conectado: 409 sem_drive", async () => {
    const r = await criarColecao(victor, "Clipes");
    assert.equal(r.status, 409);
    assert.equal((await corpo(r)).erro, "sem_drive");
  });

  test("criar: acha/cria a pasta raiz marcada e a subpasta no Drive", async () => {
    contaGoogleVictor = "gv1";
    await ligarDrive(victor, CONTA_ANA, contaGoogleVictor);
    const r = await criarColecao(victor, "  Clipes ");
    assert.equal(r.status, 201);
    const { colecao } = await corpo(r);
    assert.equal(colecao.nome, "Clipes");
    assert.equal(colecao.contaGoogleId, contaGoogleVictor);
    assert.equal(colecao.link, null);
    const drive = [...amb.google.driveDe(CONTA_ANA.sub).values()];
    const raiz = drive.find((f) => f.appProperties?.sobedesce === "referencias")!;
    assert.equal(raiz.name, "SOBEDESCE Referências");
    assert.deepEqual(raiz.parents, ["root"]);
    assert.equal(raiz.mimeType, "application/vnd.google-apps.folder");
    const pasta = drive.find((f) => f.id === colecao.driveFolderId)!;
    assert.equal(pasta.name, "Clipes");
    assert.deepEqual(pasta.parents, [raiz.id]);
    assert.equal(pasta.appProperties?.sobedesce, "colecao");

    const r2 = await criarColecao(victor, "Fotografia");
    assert.equal(r2.status, 201);
    const raizes = [...amb.google.driveDe(CONTA_ANA.sub).values()].filter((f) => f.appProperties?.sobedesce === "referencias");
    assert.equal(raizes.length, 1, "a raiz é a mesma");

    const lista = await corpo(await rColecoes.GET(pedido("/api/referencias/colecoes", { bearer: victor.mac })));
    assert.equal(lista.ok, true);
    assert.deepEqual(lista.raiz, { contaGoogleId: contaGoogleVictor, driveFolderId: raiz.id });
    assert.deepEqual(
      lista.colecoes.map((c: { nome: string }) => c.nome),
      ["Fotografia", "Clipes"],
    );
  });

  test("nome repetido (sem acento/maiúscula), inválido e Drive de outra pessoa", async () => {
    const dup = await criarColecao(victor, "clipés");
    assert.equal(dup.status, 409);
    assert.equal((await corpo(dup)).erro, "duplicada");
    assert.equal((await criarColecao(victor, "a/b")).status, 400);
    assert.equal((await criarColecao(victor, "")).status, 400);
    assert.equal((await criarColecao(victor, "x".repeat(81))).status, 400);
    assert.equal((await criarColecao(victor, "Outra", { contaGoogleId: "nao-existe" })).status, 404);
  });

  test("Origin: cookie sem Origin ou de outro site é recusado; o Bearer do computador não precisa", async () => {
    const semOrigem = await rColecoes.POST(pedido("/api/referencias/colecoes", comCookie(victor, { corpo: { nome: "X" }, origin: null })));
    assert.equal(semOrigem.status, 403);
    assert.equal((await corpo(semOrigem)).erro, "origem");
    const outro = await rColecoes.POST(pedido("/api/referencias/colecoes", comCookie(victor, { corpo: { nome: "X" }, origin: "https://malicioso.exemplo" })));
    assert.equal(outro.status, 403);
    const doMac = await rColecoes.POST(pedido("/api/referencias/colecoes", { bearer: victor.mac, corpo: { nome: "Do computador" }, origin: null }));
    assert.equal(doMac.status, 201);
    const id = (await corpo(doMac)).colecao.id;
    for (const [rota, metodo] of [
      [rColecao.PATCH, "PATCH"],
      [rColecao.DELETE, "DELETE"],
    ] as const) {
      const r = await rota(pedido(`/api/referencias/colecoes/${id}`, comCookie(victor, { method: metodo, corpo: { nome: "Y" }, origin: "https://malicioso.exemplo" })), ctx({ id }));
      assert.equal(r.status, 403, metodo);
    }
    assert.equal((await rColecao.DELETE(pedido(`/api/referencias/colecoes/${id}`, { bearer: victor.mac, method: "DELETE" }), ctx({ id }))).status, 200);
  });

  test("renomear muda a pasta; outra pessoa não vê nem mexe", async () => {
    const { colecoes } = await corpo(await rColecoes.GET(pedido("/api/referencias/colecoes", comCookie(victor))));
    const clipes = colecoes.find((c: { nome: string }) => c.nome === "Clipes");
    const r = await rColecao.PATCH(pedido(`/api/referencias/colecoes/${clipes.id}`, comCookie(victor, { method: "PATCH", corpo: { nome: "Clipes 2026" } })), ctx({ id: clipes.id }));
    assert.equal(r.status, 200);
    assert.equal((await corpo(r)).colecao.nome, "Clipes 2026");
    assert.equal(amb.google.driveDe(CONTA_ANA.sub).get(clipes.driveFolderId)!.name, "Clipes 2026");
    const dup = await rColecao.PATCH(pedido(`/api/referencias/colecoes/${clipes.id}`, comCookie(victor, { method: "PATCH", corpo: { nome: "fotografia" } })), ctx({ id: clipes.id }));
    assert.equal(dup.status, 409);
    const daAna = await rColecao.PATCH(pedido(`/api/referencias/colecoes/${clipes.id}`, comCookie(ana, { method: "PATCH", corpo: { nome: "Roubada" } })), ctx({ id: clipes.id }));
    assert.equal(daAna.status, 404);
    assert.deepEqual((await corpo(await rColecoes.GET(pedido("/api/referencias/colecoes", comCookie(ana))))).colecoes, []);
  });

  test("apagar: só da plataforma, ou também na lixeira do Drive", async () => {
    const a = (await corpo(await criarColecao(victor, "Temporária A"))).colecao;
    const b = (await corpo(await criarColecao(victor, "Temporária B"))).colecao;
    assert.equal((await rColecao.DELETE(pedido(`/api/referencias/colecoes/${a.id}`, comCookie(victor, { method: "DELETE" })), ctx({ id: a.id }))).status, 200);
    assert.equal(amb.google.driveDe(CONTA_ANA.sub).get(a.driveFolderId)!.trashed, false, "a pasta fica no Drive");
    const rb = await rColecao.DELETE(pedido(`/api/referencias/colecoes/${b.id}?apagarNoDrive=1`, comCookie(victor, { method: "DELETE" })), ctx({ id: b.id }));
    assert.equal(rb.status, 200);
    assert.equal(amb.google.driveDe(CONTA_ANA.sub).get(b.driveFolderId)!.trashed, true, "a pasta foi para a lixeira");
    assert.equal((await rColecao.DELETE(pedido(`/api/referencias/colecoes/${b.id}`, comCookie(victor, { method: "DELETE" })), ctx({ id: b.id }))).status, 404);
  });

  test("raiz na lixeira: a próxima coleção cria outra; mesmo nome numa pasta que já existe é aproveitada", async () => {
    const drive = amb.google.driveDe(CONTA_ANA.sub);
    const raiz = [...drive.values()].find((f) => f.appProperties?.sobedesce === "referencias" && !f.trashed)!;
    const solta = amb.google.adicionarArquivo(CONTA_ANA.sub, { name: "Já existia", mimeType: "application/vnd.google-apps.folder", parents: [raiz.id] });
    const aproveitada = (await corpo(await criarColecao(victor, "Já existia"))).colecao;
    assert.equal(aproveitada.driveFolderId, solta.id);
    raiz.trashed = true;
    const nova = (await corpo(await criarColecao(victor, "Depois da lixeira"))).colecao;
    const raizNova = drive.get(drive.get(nova.driveFolderId)!.parents[0])!;
    assert.notEqual(raizNova.id, raiz.id);
    assert.equal(raizNova.appProperties?.sobedesce, "referencias");
    raiz.trashed = false;
  });

  test("token do Google vencido: renova sozinho e segue", async () => {
    amb.google.vencerAcessos();
    const { db, schema } = amb.banco;
    const { eq } = await import("drizzle-orm");
    await db.update(schema.contasGoogle).set({ accessExpiraEm: new Date(Date.now() + 3600_000) }).where(eq(schema.contasGoogle.id, contaGoogleVictor));
    const r = await criarColecao(victor, "Depois do 401");
    assert.equal(r.status, 201);
  });
});

describe("fila", () => {
  let colecaoId: string;
  before(async () => {
    const { colecoes } = await corpo(await rColecoes.GET(pedido("/api/referencias/colecoes", comCookie(victor))));
    colecaoId = colecoes.find((c: { nome: string }) => c.nome === "Clipes 2026").id;
  });
  const enfileirar = (p: Pessoa, b: Record<string, unknown>, extra: Pedido = {}) => rFila.POST(pedido("/api/referencias/fila", comCookie(p, { corpo: b, ...extra })));

  test("guardar: link válido, coleção da pessoa, mesmo link devolve o que já existe", async () => {
    assert.equal((await enfileirar(victor, { url: "ftp://a.com/x", colecaoId })).status, 400);
    assert.equal((await enfileirar(victor, { url: "https://www.instagram.com/reel/C1/", colecaoId: "nao-existe" })).status, 404);
    assert.equal((await enfileirar(ana, { url: "https://www.instagram.com/reel/C1/", colecaoId })).status, 404, "coleção de outra pessoa");
    const r = await enfileirar(victor, { url: "Olha https://www.instagram.com/reel/C1/?igsh=xx", colecaoId, nota: "luz de janela" });
    assert.equal(r.status, 201);
    const { item, novo } = await corpo(r);
    assert.equal(novo, true);
    assert.equal(item.url, "https://www.instagram.com/reel/C1/");
    assert.equal(item.plataforma, "Instagram");
    assert.equal(item.status, "pendente");
    assert.equal(item.nota, "luz de janela");
    assert.deepEqual(Object.keys(item.colecao).sort(), ["contaGoogleId", "driveFolderId", "id", "nome"]);
    const de2 = await enfileirar(victor, { url: "https://www.instagram.com/reel/C1/?utm_source=x", colecaoId });
    assert.equal(de2.status, 200);
    assert.equal((await corpo(de2)).item.id, item.id);
    assert.equal((await enfileirar(victor, { url: "https://youtu.be/abc", colecaoId }, { origin: "https://malicioso.exemplo" })).status, 403);
  });

  test("\"Também salvar como\": formatos conhecidos ficam no item; desconhecido recusa; repetir soma os formatos", async () => {
    assert.equal((await enfileirar(victor, { url: "https://www.instagram.com/reel/F1/", colecaoId, formatos: ["mp3"] })).status, 400);
    assert.equal((await enfileirar(victor, { url: "https://www.instagram.com/reel/F1/", colecaoId, formatos: "mp3-320" })).status, 400);
    const r = await enfileirar(victor, { url: "https://www.instagram.com/reel/F1/", colecaoId, formatos: ["mp3-320", "original", "mp3-320"] });
    assert.equal(r.status, 201);
    const { item } = await corpo(r);
    assert.deepEqual(item.formatos, ["mp3-320"], "sem repetir e sem o original (ele sempre vai)");
    const de2 = await corpo(await enfileirar(victor, { url: "https://www.instagram.com/reel/F1/", colecaoId, formatos: ["wav"] }));
    assert.equal(de2.item.id, item.id);
    assert.deepEqual(de2.item.formatos, ["mp3-320", "wav"]);
    const semFormato = await corpo(await enfileirar(victor, { url: "https://www.instagram.com/reel/F2/", colecaoId }));
    assert.deepEqual(semFormato.item.formatos, []);
    // O computador recebe os formatos junto do item.
    const lista = await corpo(await rFila.GET(pedido("/api/referencias/fila?status=pendente", { bearer: victor.mac })));
    assert.deepEqual(lista.itens.find((i: { id: string }) => i.id === item.id).formatos, ["mp3-320", "wav"]);
    for (const x of [item.id, semFormato.item.id]) await rItem.DELETE(pedido(`/api/referencias/fila/${x}`, comCookie(victor, { method: "DELETE" })), ctx({ id: x }));
  });

  test("o computador lista e pega; dois ao mesmo tempo, só um leva", async () => {
    const lista = await corpo(await rFila.GET(pedido("/api/referencias/fila?status=pendente", { bearer: victor.mac })));
    assert.equal(lista.itens.length, 1);
    const id = lista.itens[0].id;
    assert.equal(lista.itens[0].colecao.nome, "Clipes 2026");
    assert.equal((await rFila.GET(pedido("/api/referencias/fila?status=xyz", { bearer: victor.mac }))).status, 400);

    const peloSite = await rPegar.POST(pedido(`/api/referencias/fila/${id}/pegar`, comCookie(victor, { method: "POST" })), ctx({ id }));
    assert.equal(peloSite.status, 403, "só o computador pega");

    const [a, b] = await Promise.all([
      rPegar.POST(pedido(`/api/referencias/fila/${id}/pegar`, { bearer: victor.mac, method: "POST" }), ctx({ id })),
      rPegar.POST(pedido(`/api/referencias/fila/${id}/pegar`, { bearer: victor.pc, method: "POST" }), ctx({ id })),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const vencedor = a.status === 200 ? victor.mac : victor.pc;
    const perdedor = a.status === 200 ? victor.pc : victor.mac;
    assert.equal((await rPegar.POST(pedido(`/api/referencias/fila/${id}/pegar`, { bearer: vencedor, method: "POST" }), ctx({ id }))).status, 200, "pedir de novo é seguro");
    assert.equal((await rPegar.POST(pedido(`/api/referencias/fila/${id}/pegar`, { bearer: ana.mac, method: "POST" }), ctx({ id }))).status, 404, "de outra conta");
    assert.equal((await corpo(await rFila.GET(pedido("/api/referencias/fila?status=pendente", { bearer: victor.mac })))).itens.length, 0);

    const mudar = (bearer: string | null, b: Record<string, unknown>) =>
      rItem.PATCH(pedido(`/api/referencias/fila/${id}`, bearer ? { bearer, method: "PATCH", corpo: b } : comCookie(victor, { method: "PATCH", corpo: b })), ctx({ id }));
    assert.equal((await mudar(perdedor, { status: "pronto", driveFileId: "abc" })).status, 409, "outro computador não termina");
    assert.equal((await mudar(perdedor, { status: "pendente" })).status, 409, "nem solta");
    assert.equal((await mudar(null, { status: "pronto", driveFileId: "abc" })).status, 403, "o site não marca pronto");
    assert.equal((await mudar(vencedor, { status: "pronto" })).status, 400, "pronto precisa do arquivo");
    assert.equal((await mudar(vencedor, { status: "baixando" })).status, 200, "sinal de vida");
    const pronto = await mudar(vencedor, { status: "pronto", driveFileId: "arq-123" });
    assert.equal(pronto.status, 200);
    assert.equal((await corpo(pronto)).item.driveFileId, "arq-123");
    assert.equal((await mudar(null, { status: "pendente" })).status, 409, "pronto não volta");
  });

  test("erro, tentar de novo pelo celular, cancelar e item largado", async () => {
    const { item } = await corpo(await enfileirar(victor, { url: "https://www.tiktok.com/@a/video/1", colecaoId }));
    const id = item.id;
    await rPegar.POST(pedido(`/api/referencias/fila/${id}/pegar`, { bearer: victor.mac, method: "POST" }), ctx({ id }));
    const erro = await rItem.PATCH(pedido(`/api/referencias/fila/${id}`, { bearer: victor.mac, method: "PATCH", corpo: { status: "erro", erro: "Vídeo privado" } }), ctx({ id }));
    assert.equal((await corpo(erro)).item.erro, "Vídeo privado");
    const deNovo = await rItem.PATCH(pedido(`/api/referencias/fila/${id}`, comCookie(victor, { method: "PATCH", corpo: { status: "pendente" } })), ctx({ id }));
    assert.equal(deNovo.status, 200);
    const voltou = (await corpo(deNovo)).item;
    assert.equal(voltou.status, "pendente");
    assert.equal(voltou.erro, null);
    assert.equal(voltou.dispositivoId, null);

    // Pego e largado (computador desligou): depois de 30 min, outro computador pega.
    await rPegar.POST(pedido(`/api/referencias/fila/${id}/pegar`, { bearer: victor.mac, method: "POST" }), ctx({ id }));
    assert.equal((await rPegar.POST(pedido(`/api/referencias/fila/${id}/pegar`, { bearer: victor.pc, method: "POST" }), ctx({ id }))).status, 409);
    const { db, schema } = amb.banco;
    const { eq } = await import("drizzle-orm");
    await db.update(schema.referenciasFila).set({ atualizadoEm: new Date(Date.now() - 31 * 60_000) }).where(eq(schema.referenciasFila.id, id));
    assert.equal((await rPegar.POST(pedido(`/api/referencias/fila/${id}/pegar`, { bearer: victor.pc, method: "POST" }), ctx({ id }))).status, 200);

    assert.equal((await rItem.DELETE(pedido(`/api/referencias/fila/${id}`, comCookie(ana, { method: "DELETE" })), ctx({ id }))).status, 404);
    assert.equal((await rItem.DELETE(pedido(`/api/referencias/fila/${id}`, comCookie(victor, { method: "DELETE" })), ctx({ id }))).status, 200);
    assert.equal((await rItem.DELETE(pedido(`/api/referencias/fila/${id}`, comCookie(victor, { method: "DELETE" })), ctx({ id }))).status, 404);
  });

  test("filtro por coleção e contagem na lista de coleções", async () => {
    await enfileirar(victor, { url: "https://vimeo.com/42", colecaoId });
    const da = await corpo(await rFila.GET(pedido(`/api/referencias/fila?colecao=${colecaoId}`, comCookie(victor))));
    assert.ok(da.itens.every((i: { colecao: { id: string } }) => i.colecao.id === colecaoId));
    const todos = await corpo(await rFila.GET(pedido("/api/referencias/fila?status=todos", comCookie(victor))));
    assert.ok(todos.itens.some((i: { status: string }) => i.status === "pronto"));
    const { colecoes } = await corpo(await rColecoes.GET(pedido("/api/referencias/colecoes", comCookie(victor))));
    assert.equal(colecoes.find((c: { id: string }) => c.id === colecaoId).naFila, 1);
  });
});

describe("Atalho do iPhone", () => {
  let chave: string;
  const atalho = (auth: string | null, b: unknown, extra: { tipo?: string; ip?: string } = {}) => {
    const headers = new Headers({ host: "localhost:3000", "x-real-ip": extra.ip ?? "10.1.1.1" });
    if (auth) headers.set("authorization", auth);
    headers.set("content-type", extra.tipo ?? "application/json");
    const body = typeof b === "string" ? b : JSON.stringify(b);
    return rAtalho.POST(new Request(new URL("/api/referencias/atalho", SITE), { method: "POST", headers, body }));
  };

  test("a chave nasce só pelo site (cookie), aparece uma vez e não serve para mais nada", async () => {
    assert.equal((await rAtalhoToken.POST(pedido("/api/referencias/atalho/token", { bearer: victor.mac, method: "POST" }))).status, 403);
    assert.equal((await rAtalhoToken.POST(pedido("/api/referencias/atalho/token", comCookie(victor, { method: "POST", origin: "https://malicioso.exemplo" })))).status, 403);
    const r = await rAtalhoToken.POST(pedido("/api/referencias/atalho/token", comCookie(victor, { method: "POST" })));
    assert.equal(r.status, 201);
    const c = await corpo(r);
    chave = c.token;
    assert.match(chave, /^sda_[A-Za-z0-9_-]{43}$/);
    assert.equal(c.endpoint, `${SITE}/api/referencias/atalho`);
    assert.equal(c.instalar, `${SITE}/atalho#chave=${chave}`);
    const estado = await corpo(await rAtalhoToken.GET(pedido("/api/referencias/atalho/token", comCookie(victor))));
    assert.equal(estado.ativo, true);
    assert.equal(JSON.stringify(estado).includes(chave), false, "o valor não sai de novo");

    // Só põe na fila: não vale como Bearer em nenhuma rota.
    assert.equal((await rColecoes.GET(pedido("/api/referencias/colecoes", { bearer: chave }))).status, 401);
    assert.equal((await eu.GET(pedido("/api/eu", { bearer: chave }))).status, 401);
    const comAtalho = new Request(new URL("/api/referencias/colecoes", SITE), { headers: { authorization: `Atalho ${chave}`, host: "localhost:3000" } });
    assert.equal((await rColecoes.GET(comAtalho)).status, 401);
  });

  test("guarda o link na coleção pelo nome (JSON, formulário ou texto) e ajuda quando o nome não existe", async () => {
    const r = await atalho(`Atalho ${chave}`, { url: "https://www.instagram.com/reel/ATALHO1/?igsh=1", colecao: "clipes 2026" });
    assert.equal(r.status, 201);
    const c = await corpo(r);
    assert.equal(c.colecao, "Clipes 2026");
    assert.match(c.mensagem, /Salvo em Clipes 2026/);
    const de2 = await atalho(`Atalho ${chave}`, { url: "https://www.instagram.com/reel/ATALHO1/", colecao: "Clipes 2026" });
    assert.equal(de2.status, 200);

    const form = await atalho(`Atalho ${chave}`, new URLSearchParams({ url: "https://youtu.be/FORM", colecao: "Fotografia" }).toString(), { tipo: "application/x-www-form-urlencoded" });
    assert.equal(form.status, 201);
    const solto = await atalho(`Atalho ${chave}`, "https://vimeo.com/TEXTO", { tipo: "text/plain" });
    assert.equal(solto.status, 201, "sem coleção: a mais recente");

    const naoExiste = await atalho(`Atalho ${chave}`, { url: "https://youtu.be/x", colecao: "Nada" });
    assert.equal(naoExiste.status, 404);
    assert.match((await corpo(naoExiste)).mensagem, /Clipes 2026/);
    assert.equal((await atalho(`Atalho ${chave}`, { url: "não é link", colecao: "Clipes 2026" })).status, 400);

    const fila = await corpo(await rFila.GET(pedido("/api/referencias/fila?status=pendente", { bearer: victor.mac })));
    assert.ok(fila.itens.some((i: { url: string }) => i.url === "https://www.instagram.com/reel/ATALHO1/"));
  });

  test("chave trocada, desligada, errada ou num Bearer: 401; muitas erradas: 429", async () => {
    assert.equal((await atalho(`Bearer ${victor.mac}`, { url: "https://youtu.be/x" })).status, 401);
    assert.equal((await atalho(null, { url: "https://youtu.be/x" })).status, 401);
    const nova = (await corpo(await rAtalhoToken.POST(pedido("/api/referencias/atalho/token", comCookie(victor, { method: "POST" }))))).token;
    assert.equal((await atalho(`Atalho ${chave}`, { url: "https://youtu.be/velha" })).status, 401, "a velha parou");
    assert.equal((await atalho(`Atalho ${nova}`, { url: "https://youtu.be/nova" })).status, 201);
    assert.equal((await rAtalhoToken.DELETE(pedido("/api/referencias/atalho/token", comCookie(victor, { method: "DELETE" })))).status, 200);
    assert.equal((await atalho(`Atalho ${nova}`, { url: "https://youtu.be/nova2" })).status, 401);
    let ultimo = 0;
    for (let i = 0; i < 22; i++) ultimo = (await atalho(`Atalho sda_${"x".repeat(43)}`, { url: "https://youtu.be/x" }, { ip: "10.9.9.9" })).status;
    assert.equal(ultimo, 429);
  });
});

describe("link pra IA", () => {
  let colecao: { id: string; driveFolderId: string; link: string | null };
  let token: string;
  const abrir = (t: string) => rPublica.GET(pedido(`/r/${t}`), ctx({ token: t }));

  before(async () => {
    const { colecoes } = await corpo(await rColecoes.GET(pedido("/api/referencias/colecoes", comCookie(victor))));
    colecao = colecoes.find((c: { nome: string }) => c.nome === "Clipes 2026");
    const sub = CONTA_ANA.sub;
    amb.google.adicionarArquivo(sub, {
      name: "Plano-sequencia.mp4",
      mimeType: "video/mp4",
      parents: [colecao.driveFolderId],
      appProperties: { sobedesce: "referencia", fonte: "https://www.instagram.com/reel/C1/", plataforma: "instagram", autor: "@fulano", titulo: "Plano" },
      description:
        "https://www.instagram.com/reel/C1/\nTítulo: Plano-sequência no metrô <script>alert(1)</script>\nAutor: @fulano\nPlataforma: Instagram\nSalvo em: 2026-10-16T14:03:00Z\n\nLuz de janela.\nCâmera na mão.",
      permissionIds: ["anyoneWithLink", "0123"],
      videoMediaMetadata: { durationMillis: "83000" },
      webViewLink: "https://drive.google.com/file/d/plano/view",
    });
    amb.google.adicionarArquivo(sub, {
      name: "Corte seco.mp4",
      mimeType: "video/mp4",
      parents: [colecao.driveFolderId],
      appProperties: { sobedesce: "referencia", fonte: "https://youtu.be/seco", plataforma: "youtube", titulo: "Corte seco" },
    });
    amb.google.adicionarArquivo(sub, { name: "solto.txt", mimeType: "text/plain", parents: [colecao.driveFolderId] });
    amb.google.adicionarArquivo(sub, { name: "apagado.mp4", mimeType: "video/mp4", parents: [colecao.driveFolderId], trashed: true, appProperties: { sobedesce: "referencia" } });
  });

  test("desligado por padrão: 404; ligar devolve o endereço", async () => {
    assert.equal(colecao.link, null);
    assert.equal((await abrir("x".repeat(43))).status, 404);
    const r = await rColecao.PATCH(pedido(`/api/referencias/colecoes/${colecao.id}`, comCookie(victor, { method: "PATCH", corpo: { link: "ligar" } })), ctx({ id: colecao.id }));
    const link = (await corpo(r)).colecao.link as string;
    assert.match(link, new RegExp(`^${SITE}/r/[A-Za-z0-9_-]{43}$`));
    token = link.split("/r/")[1];
    const deNovo = await rColecao.PATCH(pedido(`/api/referencias/colecoes/${colecao.id}`, comCookie(victor, { method: "PATCH", corpo: { link: "ligar" } })), ctx({ id: colecao.id }));
    assert.equal((await corpo(deNovo)).colecao.link, link, "ligar de novo mantém o endereço");
    assert.equal((await rColecao.PATCH(pedido(`/api/referencias/colecoes/${colecao.id}`, comCookie(victor, { method: "PATCH", corpo: { link: "abrir" } })), ctx({ id: colecao.id }))).status, 400);
  });

  test("HTML: noindex, alternate em Markdown, itens escapados, sem e-mail do dono", async () => {
    const r = await abrir(token);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type")!, /text\/html/);
    assert.match(r.headers.get("x-robots-tag")!, /noindex/);
    assert.match(r.headers.get("cache-control")!, /no-store/);
    const html = await r.text();
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.ok(html.includes(`<link rel="alternate" type="text/markdown" href="${SITE}/r/${token}.md">`));
    assert.ok(html.includes("Plano-sequência no metrô &lt;script&gt;"));
    assert.ok(!html.includes("<script>alert"));
    assert.ok(html.includes("Corte seco"));
    assert.ok(!html.includes("solto.txt") && !html.includes("apagado"));
    assert.ok(html.includes("Referências salvas por Victor na SOBEDESCE."));
    for (const segredo of [victor.email, CONTA_ANA.email, "Barroso"]) assert.ok(!html.includes(segredo), segredo);
  });

  test("JSON e Markdown com o que a IA precisa", async () => {
    const j = await corpo(await abrir(`${token}.json`));
    assert.equal(j.ok, true);
    assert.equal(j.colecao, "Clipes 2026");
    assert.equal(j.total, 2);
    assert.equal(j.nota, "Referências salvas por Victor na SOBEDESCE.");
    const [seco, plano] = j.itens;
    assert.equal(seco.titulo, "Corte seco", "mais recente primeiro");
    assert.equal(seco.plataforma, "YouTube");
    assert.equal(seco.url, "https://youtu.be/seco");
    assert.equal(seco.drive, null, "não compartilhado: sem link do Drive");
    assert.equal(plano.titulo, "Plano-sequência no metrô <script>alert(1)</script>");
    assert.equal(plano.autor, "@fulano");
    assert.equal(plano.plataforma, "Instagram");
    assert.equal(plano.legenda, "Luz de janela.\nCâmera na mão.");
    assert.equal(plano.duracaoSegundos, 83);
    assert.equal(plano.drive, "https://drive.google.com/file/d/plano/view");
    const textoJson = JSON.stringify(j);
    for (const segredo of [victor.email, CONTA_ANA.email]) assert.ok(!textoJson.includes(segredo));

    const r = await abrir(`${token}.md`);
    assert.match(r.headers.get("content-type")!, /text\/markdown/);
    assert.match(r.headers.get("x-robots-tag")!, /noindex/);
    const md = await r.text();
    const linhas = md.split("\n");
    assert.equal(linhas[0], "# Clipes 2026");
    assert.equal(linhas[2], "Referências salvas por Victor na SOBEDESCE.");
    assert.match(linhas[3], /^2 itens · atualizado em \d{2}\/\d{2}\/\d{4}/);
    assert.ok(md.includes("- Link original: https://www.instagram.com/reel/C1/"));
    assert.ok(md.includes("- Duração: 1:23"));
    assert.ok(md.includes("- Vídeo no Google Drive: https://drive.google.com/file/d/plano/view"));
    assert.ok(md.includes("> Luz de janela.\n> Câmera na mão."));
    assert.ok(!md.includes(victor.email));
  });

  test("cache de 5 minutos por link; trocar e desligar derrubam o endereço na hora", async () => {
    const antes = amb.google.contadoresDrive.list;
    assert.equal((await abrir(token)).status, 200);
    assert.equal((await abrir(`${token}.md`)).status, 200);
    assert.equal(amb.google.contadoresDrive.list, antes, "veio do cache");

    const trocar = await rColecao.PATCH(pedido(`/api/referencias/colecoes/${colecao.id}`, comCookie(victor, { method: "PATCH", corpo: { link: "trocar" } })), ctx({ id: colecao.id }));
    const novo = ((await corpo(trocar)).colecao.link as string).split("/r/")[1];
    assert.notEqual(novo, token);
    for (const sufixo of ["", ".json", ".md"]) assert.equal((await abrir(token + sufixo)).status, 404, `velho${sufixo}`);
    assert.equal((await abrir(novo)).status, 200);

    await rColecao.PATCH(pedido(`/api/referencias/colecoes/${colecao.id}`, comCookie(victor, { method: "PATCH", corpo: { link: "desligar" } })), ctx({ id: colecao.id }));
    for (const sufixo of ["", ".json", ".md"]) {
      const r = await abrir(novo + sufixo);
      assert.equal(r.status, 404, `desligado${sufixo}`);
      assert.match(r.headers.get("x-robots-tag")!, /noindex/);
    }
    publica.limparCache();
  });

  test("Drive fora do ar: 503 com aviso, sem derrubar o site", async () => {
    const r = await rColecao.PATCH(pedido(`/api/referencias/colecoes/${colecao.id}`, comCookie(victor, { method: "PATCH", corpo: { link: "ligar" } })), ctx({ id: colecao.id }));
    const t = ((await corpo(r)).colecao.link as string).split("/r/")[1];
    amb.google.revogarTodos();
    const { db, schema } = amb.banco;
    const { eq } = await import("drizzle-orm");
    await db.update(schema.contasGoogle).set({ accessTokenEnc: null, accessExpiraEm: null }).where(eq(schema.contasGoogle.id, contaGoogleVictor));
    const falhou = await abrir(`${t}.json`);
    assert.equal(falhou.status, 503);
    assert.equal((await corpo(falhou)).ok, false);
  });
});

describe("conta apagada", () => {
  test("coleções, fila e chaves somem junto (cascade)", async () => {
    const beto = await novaPessoa("Beto Cor", "beto.conta@exemplo.com", "10.0.0.3");
    await ligarDrive(beto, CONTA_BETO, "gb1");
    const c = (await corpo(await criarColecao(beto, "Cor"))).colecao;
    await rFila.POST(pedido("/api/referencias/fila", comCookie(beto, { corpo: { url: "https://vimeo.com/1", colecaoId: c.id } })));
    await rAtalhoToken.POST(pedido("/api/referencias/atalho/token", comCookie(beto, { method: "POST" })));
    const { db, schema } = amb.banco;
    const { eq } = await import("drizzle-orm");
    await db.delete(schema.usuarios).where(eq(schema.usuarios.id, beto.id));
    assert.equal((await db.select().from(schema.colecoes).where(eq(schema.colecoes.usuarioId, beto.id))).length, 0);
    assert.equal((await db.select().from(schema.referenciasFila).where(eq(schema.referenciasFila.usuarioId, beto.id))).length, 0);
    assert.equal((await db.select().from(schema.atalhos).where(eq(schema.atalhos.usuarioId, beto.id))).length, 0);
  });
});
