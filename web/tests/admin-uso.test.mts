/**
 * Uso da plataforma para o admin (docs/CONTAS.md §10): o dia de uso é marcado pela sessão (site, celular, computador)
 * com o build do app, o computador manda os números do dia (só o maior valor de cada dia fica), o painel soma tudo,
 * filtra e exporta CSV, e o aviso de muitos erros sai uma vez por pessoa e dia.
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { after, before, describe, test } from "node:test";
import { pedido, prepararAmbiente } from "./ambiente.mjs";

let amb: Awaited<ReturnType<typeof prepararAmbiente>>;
let contas: typeof import("../src/lib/auth/contas");
let sessao: typeof import("../src/lib/auth/sessao");
let requisicao: typeof import("../src/lib/auth/requisicao");
let admin: typeof import("../src/lib/admin");
let rUso: typeof import("../src/app/api/dispositivos/uso/route");
let banco: typeof import("../src/lib/db");

type Pessoa = { id: string; cookie: string; mac: string; macId: string };
let victor: Pessoa;
let ana: Pessoa;

async function novaPessoa(nome: string, email: string, ip: string): Promise<Pessoa> {
  const pendentes: Promise<unknown>[] = [];
  const r = await contas.criarConta({ nome, email, senha: "uma senha comprida", ip, depois: (t) => void pendentes.push(t()) });
  await Promise.all(pendentes);
  assert.ok(r.ok);
  const mac = await sessao.criarSessao(r.usuario.id, "dispositivo", { nome: `MacBook de ${nome}`, plataforma: "mac" });
  return { id: r.usuario.id, cookie: r.token, mac: mac.token, macId: mac.id };
}

/** Faz a próxima autenticação da sessão regravar (como se a última tivesse sido há 20 minutos). */
async function envelhecer(sessaoId: string) {
  await banco.db.update(banco.schema.sessoes).set({ ultimoUsoEm: new Date(Date.now() - 20 * 60_000) }).where(eq(banco.schema.sessoes.id, sessaoId));
}

const dia = (n = 0) => admin.ultimosDias(1, new Date(Date.now() - n * 86_400_000))[0];
const numeros = (extra: Record<string, number> = {}) => ({ enviadosBytes: 0, baixadosBytes: 0, enviados: 0, baixados: 0, erros: 0, maiorArquivo: 0, msAtivo: 0, ...extra });
const mandarUso = (token: string, dias: unknown[]) => rUso.POST(pedido("/api/dispositivos/uso", { bearer: token, corpo: { dias } }));

before(async () => {
  amb = await prepararAmbiente();
  contas = await import("../src/lib/auth/contas");
  sessao = await import("../src/lib/auth/sessao");
  requisicao = await import("../src/lib/auth/requisicao");
  admin = await import("../src/lib/admin");
  rUso = await import("../src/app/api/dispositivos/uso/route");
  banco = await import("../src/lib/db");
  victor = await novaPessoa("Victor", "victor-uso@exemplo.com", "10.9.0.1");
  ana = await novaPessoa("Ana", "ana-uso@exemplo.com", "10.9.0.2");
});

after(async () => {
  await amb?.fechar();
});

describe("atividade do dia", () => {
  test("computador marca o dia e grava o build; celular e site também, cada um no seu lugar", async () => {
    await envelhecer(victor.macId);
    const req = pedido("/api/eu", { bearer: victor.mac });
    req.headers.set("x-sobedesce-build", "162");
    assert.ok(await requisicao.usuarioDaRequisicao(req));
    const [s] = await banco.db.select().from(banco.schema.sessoes).where(eq(banco.schema.sessoes.id, victor.macId));
    assert.equal(s.appBuild, 162);

    // Sessão do site (cookie) envelhecida: a do celular manda o cabeçalho do /app.
    const linhasWeb = await banco.db.select().from(banco.schema.sessoes).where(eq(banco.schema.sessoes.tipo, "web"));
    for (const l of linhasWeb) await envelhecer(l.id);
    const cel = pedido("/api/eu", { cookies: { sd_sessao: victor.cookie } });
    cel.headers.set("x-sobedesce-app", "celular");
    assert.ok(await requisicao.usuarioDaRequisicao(cel));

    const [a] = await banco.db.select().from(banco.schema.atividadeDiaria).where(eq(banco.schema.atividadeDiaria.usuarioId, victor.id));
    assert.equal(a.dia, dia());
    assert.equal(a.computador, true);
    assert.equal(a.celular, true);
    assert.equal(a.site, false);
    assert.equal(a.ultimaOrigem, "celular");
  });

  test("sem passar 10 minutos não grava de novo (uma escrita por pedido seria demais)", async () => {
    const antes = await banco.db.select().from(banco.schema.atividadeDiaria).where(eq(banco.schema.atividadeDiaria.usuarioId, victor.id));
    assert.ok(await requisicao.usuarioDaRequisicao(pedido("/api/eu", { cookies: { sd_sessao: victor.cookie } })));
    const depois = await banco.db.select().from(banco.schema.atividadeDiaria).where(eq(banco.schema.atividadeDiaria.usuarioId, victor.id));
    assert.deepEqual(depois, antes);
  });
});

describe("uso do computador", () => {
  test("grava o dia; mandar de novo guarda o maior valor (não soma duas vezes)", async () => {
    const r1 = await mandarUso(victor.mac, [{ dia: dia(), ...numeros({ enviadosBytes: 5e9, enviados: 10, maiorArquivo: 2e9, msAtivo: 60_000 }) }]);
    assert.equal(r1.status, 200);
    const r2 = await mandarUso(victor.mac, [
      { dia: dia(1), ...numeros({ baixadosBytes: 1e9, baixados: 3 }) },
      { dia: dia(), ...numeros({ enviadosBytes: 6e9, enviados: 12, maiorArquivo: 1e9, msAtivo: 90_000 }) },
    ]);
    assert.equal(r2.status, 200);
    const linhas = await banco.db.select().from(banco.schema.usoDiario).where(eq(banco.schema.usoDiario.sessaoId, victor.macId));
    const hoje = linhas.find((l) => l.dia === dia())!;
    assert.equal(hoje.enviadosBytes, 6e9);
    assert.equal(hoje.enviados, 12);
    assert.equal(hoje.maiorArquivo, 2e9, "o maior arquivo do dia não diminui");
    assert.equal(hoje.msAtivo, 90_000);
    assert.equal(linhas.length, 2);
  });

  test("só o computador manda; formato, campos e dias fora do lugar são recusados", async () => {
    const site = await rUso.POST(pedido("/api/dispositivos/uso", { cookies: { sd_sessao: victor.cookie }, corpo: { dias: [] } }));
    assert.equal(site.status, 403);
    assert.equal((await mandarUso("sdd_invalido", [])).status, 401);
    assert.equal((await mandarUso(victor.mac, [{ dia: "ontem", ...numeros() }])).status, 400);
    assert.equal((await mandarUso(victor.mac, [{ dia: dia(), ...numeros({ erros: -1 }) }])).status, 400);
    // Nome de arquivo não tem onde entrar: campo desconhecido é descartado.
    assert.equal((await mandarUso(victor.mac, [{ dia: dia(), ...numeros(), nome: "segredo.mov" } as unknown])).status, 200);
    // Dia muito velho ou no futuro: ignorado, sem erro.
    const r = await mandarUso(victor.mac, [{ dia: "2001-01-01", ...numeros({ enviados: 99 }) }]);
    assert.deepEqual(await r.json(), { ok: true, dias: 0 });
  });

  test("muitos erros no dia: os admins recebem um aviso, uma vez só", async () => {
    const antes = amb.resend.recebidos.length;
    const { conferirErrosDoDia, ERROS_PARA_AVISAR } = await import("../src/lib/email/admin");
    await mandarUso(ana.mac, [{ dia: dia(), ...numeros({ erros: ERROS_PARA_AVISAR - 1, baixados: 4 }) }]);
    await conferirErrosDoDia(ana.id, dia());
    assert.equal(amb.resend.recebidos.length, antes, "abaixo do limite: nada");
    await mandarUso(ana.mac, [{ dia: dia(), ...numeros({ erros: ERROS_PARA_AVISAR + 2, baixados: 4 }) }]);
    await conferirErrosDoDia(ana.id, dia());
    await conferirErrosDoDia(ana.id, dia());
    // A rota também confere, depois da resposta: espera esse envio terminar.
    for (let i = 0; i < 40 && amb.resend.recebidos.length === antes; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(amb.resend.recebidos.length, antes + 1);
    const e = amb.resend.recebidos.at(-1)!;
    assert.deepEqual(e.to, ["contato@dissesim.com.br"]);
    assert.match(e.text, new RegExp(`${ERROS_PARA_AVISAR + 2} transferências com erro`));
    assert.match(e.text, /\/admin\/pessoa\//);
  });
});

describe("painel", () => {
  test("soma uso, dias ativos, funil, desatualizados e filtros", async () => {
    const agora = new Date();
    const { pessoas, resumo } = await admin.painelAdmin(agora, 170);
    const v = pessoas.find((p) => p.id === victor.id)!;
    const a = pessoas.find((p) => p.id === ana.id)!;
    assert.equal(v.uso30.enviadosBytes, 6e9);
    assert.equal(v.uso30.baixadosBytes, 1e9);
    assert.equal(v.usoTotal.enviados + v.usoTotal.baixados, 15);
    assert.equal(v.diasAtivos30, 1);
    assert.equal(v.tira30.at(-1), true);
    assert.equal(v.usou.celular, true);
    assert.equal(v.ultimaOrigem, "celular");
    assert.equal(v.online, true);
    assert.equal(v.listaComputadores[0].appBuild, 162);
    assert.ok(admin.desatualizado(v.listaComputadores[0], 170));
    assert.ok(admin.desatualizado({ appBuild: null }, 170), "app sem build conhecido é anterior ao aviso");
    assert.ok(!admin.desatualizado({ appBuild: 0 }, 170), "build de teste não conta");
    assert.ok(!admin.desatualizado({ appBuild: 162 }, null), "sem saber o publicado, ninguém está atrasado");
    assert.equal(resumo.desatualizados, 2);
    assert.equal(resumo.funil.contas, 2);
    assert.equal(resumo.funil.comComputador, 2);
    assert.equal(resumo.funil.transferiu, 2);
    assert.equal(resumo.funil.comDrive, 0);
    assert.equal(resumo.ativosHoje, 1);
    assert.equal(resumo.serie.length, 30);
    assert.equal(resumo.serie.at(-1)!.pessoas, 1);
    assert.equal(resumo.uso7.erros, a.uso30.erros);
    assert.ok(admin.velocidadeMedia(v.uso30) > 0);

    assert.deepEqual(admin.aplicarFiltro(pessoas, { filtro: "erros" }, agora).map((p) => p.id), [ana.id]);
    assert.deepEqual(admin.aplicarFiltro(pessoas, { filtro: "sem-drive" }, agora).length, 2);
    assert.deepEqual(admin.aplicarFiltro(pessoas, { filtro: "desatualizado", buildAtual: 170 }, agora).length, 2);
    assert.deepEqual(admin.aplicarFiltro(pessoas, { filtro: "desatualizado", buildAtual: 162 }, agora).map((p) => p.id), [ana.id]);
    assert.deepEqual(admin.aplicarFiltro(pessoas, { ordem: "volume" }, agora)[0].id, victor.id);
    assert.deepEqual(admin.aplicarFiltro(pessoas, { plano: "pro" }, agora), []);
  });

  test("linha do tempo da pessoa: dias com uso, aparelhos e marcos", async () => {
    const { pessoas } = await admin.painelAdmin(new Date(), null);
    const v = pessoas.find((p) => p.id === victor.id)!;
    const t = await admin.linhaDoTempo(victor.id, v);
    assert.equal(t.dias[0].dia, dia());
    assert.equal(t.dias[0].uso.enviados, 12);
    assert.equal(t.dias[1].dia, dia(1));
    assert.ok(t.sessoes.some((s) => s.id === victor.macId));
    const textos = t.eventos.map((e) => e.texto);
    assert.ok(textos.includes("Criou a conta com e-mail e senha"));
    assert.ok(textos.includes("Conectou o computador MacBook de Victor"));
  });

  test("CSV: uma linha por conta e nada que vire fórmula na planilha", async () => {
    const { pessoas } = await admin.painelAdmin(new Date(), 170);
    const csv = admin.paraCsv([{ ...pessoas[0], nome: "=HYPERLINK(\"x\")" }], 170);
    const [cab, linha] = csv.trim().split("\n");
    assert.match(cab, /^nome,email,plano,/);
    assert.ok(linha.startsWith(`"'=HYPERLINK(""x"")"`), linha);
  });

  test("admin desconecta um aparelho da pessoa", async () => {
    assert.equal(await sessao.revogarSessaoDe(ana.id, victor.macId), false, "sessão de outra pessoa: nada");
    assert.equal(await sessao.revogarSessaoDe(ana.id, ana.macId), true);
    assert.equal(await requisicao.usuarioDaRequisicao(pedido("/api/eu", { bearer: ana.mac })), null);
  });
});
