/** Dois endereços do site: sobedesce.com (principal) e sobedesce.vercel.app (antigo, continua valendo). */
import assert from "node:assert/strict";
import { test } from "node:test";

test("origens, retorno do Google e CSRF nos dois endereços", async () => {
  delete process.env.NEXT_PUBLIC_SITE_URL;
  const site = await import("../src/lib/site");
  const config = await import("../src/lib/google/config");
  const http = await import("../src/lib/http");
  assert.equal(site.siteUrl(), "https://sobedesce.com");
  assert.deepEqual(site.origensDoSite(), ["https://sobedesce.com", "https://sobedesce.vercel.app"]);
  assert.equal(config.redirectUri("https://sobedesce.vercel.app"), "https://sobedesce.vercel.app/api/google/callback");
  assert.equal(config.redirectUri("https://sobedesce.com"), "https://sobedesce.com/api/google/callback");
  // Prévia ou endereço estranho: volta para o principal.
  assert.equal(config.redirectUri("https://sobedesce-git-x.vercel.app"), "https://sobedesce.com/api/google/callback");
  assert.equal(config.redirectUri(), "https://sobedesce.com/api/google/callback");
  const h = new Headers({ host: "interno", origin: "https://sobedesce.vercel.app" });
  assert.equal(http.origemConfere(h, undefined, site.origensDoSite()), true);
  h.set("origin", "https://sobedesce.com");
  assert.equal(http.origemConfere(h, undefined, site.origensDoSite()), true);
  h.set("origin", "https://sobedesce.com.evil.com");
  assert.equal(http.origemConfere(h, undefined, site.origensDoSite()), false);
});
