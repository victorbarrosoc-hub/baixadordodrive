/**
 * Macs com o Atualizar travado (lib/atualizar-mac.ts): quem entra na lista (Mac ativo antes do build 300, ou sem
 * build gravado), quem fica fora (Windows, Mac corrigido, desenvolvimento, desconectado) e o e-mail: sai uma vez por
 * conta, e quem não recebeu por falha do Resend entra no próximo envio.
 */
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { after, before, test } from "node:test";
import { prepararAmbiente } from "./ambiente.mjs";

let amb: Awaited<ReturnType<typeof prepararAmbiente>>;
let contas: typeof import("../src/lib/auth/contas");
let sessao: typeof import("../src/lib/auth/sessao");
let mac: typeof import("../src/lib/atualizar-mac");
let banco: typeof import("../src/lib/db");

before(async () => {
  amb = await prepararAmbiente();
  contas = await import("../src/lib/auth/contas");
  sessao = await import("../src/lib/auth/sessao");
  mac = await import("../src/lib/atualizar-mac");
  banco = await import("../src/lib/db");
});

after(async () => {
  await amb?.fechar();
});

let n = 0;
async function pessoa(nome: string) {
  const pendentes: Promise<unknown>[] = [];
  const r = await contas.criarConta({ nome, email: `mac${++n}@exemplo.com`, senha: "uma senha comprida", ip: `10.9.${n}.1`, depois: (t) => void pendentes.push(t()) });
  await Promise.all(pendentes);
  assert.ok(r.ok);
  return r.usuario;
}

async function computador(usuarioId: string, nome: string, plataforma: "mac" | "windows", appBuild: number | null) {
  const s = await sessao.criarSessao(usuarioId, "dispositivo", { nome, plataforma });
  await banco.db.update(banco.schema.sessoes).set({ appBuild }).where(eq(banco.schema.sessoes.id, s.id));
  return s;
}

test("lista quem tem Mac antes do build 300 e manda o e-mail uma vez por conta", async () => {
  const ana = await pessoa("Ana Montadora");
  await computador(ana.id, "MacBook Pro de Ana", "mac", 262);
  await computador(ana.id, "iMac da ilha", "mac", null);
  const beto = await pessoa("Beto Cor");
  await computador(beto.id, "Mac Studio", "mac", 300);
  await computador(beto.id, "PC da ilha", "windows", 120);
  const caio = await pessoa("Caio Som");
  await computador(caio.id, "Mac de desenvolvimento", "mac", 0);
  const dora = await pessoa("Dora Roteiro");
  const saiu = await computador(dora.id, "MacBook Air", "mac", 250);
  await sessao.revogarSessaoDe(dora.id, saiu.id);

  assert.deepEqual((await mac.macsParaAtualizar(ana.id)).sort(), ["MacBook Pro de Ana", "iMac da ilha"]);
  for (const u of [beto, caio, dora]) assert.deepEqual(await mac.macsParaAtualizar(u.id), [], u.nome);

  const lista = await mac.contasComMacTravado();
  assert.deepEqual(lista.map((c) => c.nome), ["Ana Montadora"]);
  assert.equal(lista[0].avisada, false);

  // O Resend falha: nada fica marcado e a conta entra no próximo clique.
  amb.resend.falhar(true);
  assert.deepEqual(await mac.avisarMacsTravados(), { enviados: 0, falharam: 1 });
  amb.resend.falhar(false);
  assert.equal((await mac.contasComMacTravado())[0].avisada, false);

  const antes = amb.resend.recebidos.length;
  assert.deepEqual(await mac.avisarMacsTravados(), { enviados: 1, falharam: 0 });
  const [email] = amb.resend.recebidos.slice(antes);
  assert.equal(email.to[0], ana.email);
  assert.match(email.subject, /Atualize o SOBEDESCE no Mac/);
  assert.match(email.text, /ENOTEMPTY/);
  assert.match(email.text, /MacBook Pro de Ana/);
  assert.match(email.text, /\/baixar\/mac/);
  assert.doesNotMatch(email.text, /!/);

  // Segundo clique: ninguém recebe de novo.
  assert.deepEqual(await mac.avisarMacsTravados(), { enviados: 0, falharam: 0 });
  assert.equal(amb.resend.recebidos.length, antes + 1);
  assert.equal((await mac.contasComMacTravado())[0].avisada, true);
});
