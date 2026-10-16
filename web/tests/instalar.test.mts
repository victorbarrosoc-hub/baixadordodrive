/**
 * Instaladores de uma linha (public/instalar.sh e public/instalar.ps1): sintaxe do sh, o que cada um confere
 * (SHA-256 do /baixar/versao), cabeçalhos de texto UTF-8 e os comandos mostrados no site.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { describe, test } from "node:test";
import nextConfig from "../next.config";
import { INSTALAR_MAC, INSTALAR_WINDOWS, SITE_OFICIAL } from "../src/lib/site";

const sh = fs.readFileSync(new URL("../public/instalar.sh", import.meta.url), "utf8");
const ps1 = fs.readFileSync(new URL("../public/instalar.ps1", import.meta.url), "utf8");

describe("instalar.sh (Mac)", () => {
  test("sintaxe válida em sh e bash", () => {
    for (const shell of ["sh", "bash"]) {
      const r = spawnSync(shell, ["-n", "public/instalar.sh"], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
      assert.equal(r.status, 0, `${shell} -n: ${r.stderr}`);
    }
  });

  test("só roda inteiro: a função main é chamada na última linha", () => {
    const linhas = sh.trimEnd().split("\n");
    assert.equal(linhas.at(-1), 'main "$@"');
    assert.match(sh, /^main\(\) \{\n {2}set -eu$/m);
  });

  test("confere o SHA-256 do versao.json antes de instalar e tira a quarentena", () => {
    assert.match(sh, /\$SITE\/baixar\/versao/);
    assert.match(sh, /"sha256Mac"/);
    assert.match(sh, /\$SITE\/baixar\/mac/);
    assert.match(sh, /shasum -a 256/);
    assert.ok(sh.indexOf('[ "$GOT" != "$SHA" ]') < sh.indexOf("hdiutil attach"), "confere antes de abrir o .dmg");
    assert.match(sh, /xattr -cr "\$DEST"/);
    assert.match(sh, /trap limpar EXIT/);
  });
});

describe("instalar.ps1 (Windows)", () => {
  test("um bloco só, sem exit (com | iex fecharia a janela do PowerShell)", () => {
    assert.match(ps1, /^& \{$/m);
    assert.equal(ps1.trimEnd().at(-1), "}");
    assert.doesNotMatch(ps1, /^\s*exit\b/im);
  });

  test("confere o SHA-256 do versao.json e instala em silêncio", () => {
    assert.match(ps1, /\$site\/baixar\/versao/);
    assert.match(ps1, /sha256Windows/);
    assert.match(ps1, /\$site\/baixar\/windows/);
    assert.match(ps1, /Get-FileHash -LiteralPath \$setup -Algorithm SHA256/);
    assert.ok(ps1.indexOf("$got -ne $sha") < ps1.indexOf("Start-Process -FilePath $setup"), "confere antes de rodar o instalador");
    assert.match(ps1, /'\/S', '--force-run'/);
    assert.match(ps1, /Unblock-File/);
  });
});

describe("site", () => {
  test("os dois scripts saem como texto UTF-8, com cache curto", async () => {
    const regras = await nextConfig.headers!();
    for (const source of ["/instalar.sh", "/instalar.ps1"]) {
      const r = regras.find((x) => x.source === source);
      assert.ok(r, source);
      assert.equal(r.headers.find((h) => h.key === "Content-Type")?.value, "text/plain; charset=utf-8");
      assert.match(r.headers.find((h) => h.key === "Cache-Control")?.value ?? "", /max-age=300/);
    }
  });

  test("os comandos mostrados apontam para o site oficial", () => {
    assert.equal(INSTALAR_MAC, `curl -fsSL ${SITE_OFICIAL}/instalar.sh | bash`);
    assert.equal(INSTALAR_WINDOWS, `irm ${SITE_OFICIAL}/instalar.ps1 | iex`);
    assert.match(sh, new RegExp(`SOBEDESCE_SITE:-${SITE_OFICIAL.replace(/[./]/g, "\\$&")}`));
    assert.ok(ps1.includes(`'${SITE_OFICIAL}'`));
  });
});
