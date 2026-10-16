/**
 * /baixar/versao e /baixar/[plataforma] com um GitHub falso: versão publicada (sem e com GITHUB_TOKEN),
 * cache de 5 min, versao.json ausente ou estragado e GitHub fora do ar → 503 { ok: false }.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

type Arquivo = { nome: string; conteudo: string };

let servidor: http.Server;
let base = "";
let arquivos: Arquivo[] = [];
let releaseStatus = 200;
const pedidos: { url: string; auth: string | undefined }[] = [];
let versao: typeof import("../src/app/baixar/versao/route");
let plataforma: typeof import("../src/app/baixar/[plataforma]/route");
let release: typeof import("../src/lib/release");

const VERSAO = { build: 57, commit: "abc1234", data: "2026-10-16T12:00:00Z" };

before(async () => {
  servidor = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    pedidos.push({ url: url.pathname, auth: req.headers.authorization });
    if (url.pathname === "/repos/victorbarrosoc-hub/baixadordodrive/releases/tags/versao-de-teste") {
      res.writeHead(releaseStatus, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          assets: arquivos.map((a, i) => ({
            id: i + 1,
            name: a.nome,
            url: `${base}/api-asset/${i + 1}`,
            browser_download_url: `${base}/download/${a.nome}`,
          })),
        }),
      );
    }
    // Com token: o arquivo pela API responde 302 para um endereço "assinado".
    const api = url.pathname.match(/^\/api-asset\/(\d+)$/);
    if (api) {
      if (req.headers.authorization !== "Bearer ghp_teste") {
        res.writeHead(404);
        return res.end();
      }
      const a = arquivos[Number(api[1]) - 1];
      res.writeHead(302, { location: `${base}/assinado/${a.nome}?sig=1` });
      return res.end();
    }
    const dl = url.pathname.match(/^\/(?:download|assinado)\/(.+)$/);
    if (dl) {
      const a = arquivos.find((x) => x.nome === decodeURIComponent(dl[1]));
      if (!a) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(a.conteudo);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  delete process.env.VERCEL;
  delete process.env.GITHUB_TOKEN;
  process.env.SOBEDESCE_GITHUB_API = base;
  versao = await import("../src/app/baixar/versao/route");
  plataforma = await import("../src/app/baixar/[plataforma]/route");
  release = await import("../src/lib/release");
});

after(async () => {
  servidor.closeAllConnections();
  await new Promise((r) => servidor.close(r));
});

beforeEach(() => {
  release.esquecerCache();
  delete process.env.GITHUB_TOKEN;
  releaseStatus = 200;
  pedidos.length = 0;
  arquivos = [
    { nome: "SOBEDESCE-0.1.0-mac-universal.dmg", conteudo: "dmg" },
    { nome: "SOBEDESCE-0.1.0-windows-setup.exe", conteudo: "exe" },
    { nome: "versao.json", conteudo: JSON.stringify(VERSAO) },
  ];
});

async function pedirVersao() {
  const res = await versao.GET();
  return { res, corpo: (await res.json()) as Record<string, unknown> };
}

describe("/baixar/versao", () => {
  test("devolve o build publicado, com os links de download e cache curto", async () => {
    const { res, corpo } = await pedirVersao();
    assert.equal(res.status, 200);
    assert.deepEqual(corpo, {
      ok: true,
      build: 57,
      commit: "abc1234",
      data: "2026-10-16T12:00:00.000Z",
      mac: "/baixar/mac",
      windows: "/baixar/windows",
    });
    assert.match(res.headers.get("cache-control") ?? "", /s-maxage=300/);
  });

  test("guarda por 5 min: o segundo pedido não vai ao GitHub", async () => {
    await pedirVersao();
    const n = pedidos.length;
    arquivos[2].conteudo = JSON.stringify({ ...VERSAO, build: 58 });
    const { corpo } = await pedirVersao();
    assert.equal(pedidos.length, n);
    assert.equal(corpo.build, 57);
  });

  test("com GITHUB_TOKEN: pega o endereço assinado e baixa sem mandar o token para lá", async () => {
    process.env.GITHUB_TOKEN = "ghp_teste";
    const { res, corpo } = await pedirVersao();
    assert.equal(res.status, 200);
    assert.equal(corpo.build, 57);
    const assinado = pedidos.find((p) => p.url.startsWith("/assinado/"));
    assert.ok(assinado, "baixou pelo endereço assinado");
    assert.equal(assinado.auth, undefined);
  });

  test("sem versao.json (instaladores ainda subindo) → 503 { ok: false }", async () => {
    arquivos = arquivos.filter((a) => a.nome !== "versao.json");
    const { res, corpo } = await pedirVersao();
    assert.equal(res.status, 503);
    assert.deepEqual(corpo, { ok: false });
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  for (const [nome, conteudo] of [
    ["JSON quebrado", "{ build: "],
    ["build zero", JSON.stringify({ ...VERSAO, build: 0 })],
    ["build em texto", JSON.stringify({ ...VERSAO, build: "57" })],
    ["sem commit", JSON.stringify({ build: 57, data: VERSAO.data })],
    ["data inválida", JSON.stringify({ ...VERSAO, data: "ontem" })],
  ] as const) {
    test(`versao.json estragado (${nome}) → 503`, async () => {
      arquivos[2].conteudo = conteudo;
      const { res, corpo } = await pedirVersao();
      assert.equal(res.status, 503);
      assert.equal(corpo.ok, false);
    });
  }

  test("GitHub fora do ar → 503; volta a funcionar no pedido seguinte", async () => {
    releaseStatus = 502;
    assert.equal((await pedirVersao()).res.status, 503);
    releaseStatus = 200;
    assert.equal((await pedirVersao()).res.status, 200);
  });
});

describe("/baixar/[plataforma]", () => {
  const pedir = (p: string) =>
    plataforma.GET(new Request(`http://localhost:3000/baixar/${p}`) as never, { params: Promise.resolve({ plataforma: p }) });

  test("mac e windows redirecionam para o instalador certo", async () => {
    const mac = await pedir("mac");
    assert.equal(mac.status, 307);
    assert.equal(mac.headers.get("location"), `${base}/download/SOBEDESCE-0.1.0-mac-universal.dmg`);
    const win = await pedir("windows");
    assert.equal(win.headers.get("location"), `${base}/download/SOBEDESCE-0.1.0-windows-setup.exe`);
  });

  test("plataforma desconhecida volta para a seção de download; sem instalador, avisa", async () => {
    const outra = await pedir("linux");
    assert.equal(outra.headers.get("location"), "http://localhost:3000/#baixar");
    arquivos = arquivos.filter((a) => !a.nome.endsWith(".dmg"));
    const semMac = await pedir("mac");
    assert.equal(semMac.headers.get("location"), "http://localhost:3000/?baixar=indisponivel#baixar");
  });
});
