// npm run dev: sobe o Postgres local (PGlite em data/pglite) como servidor e o Next em seguida.
// O Next em desenvolvimento usa mais de um processo, e o PGlite só abre em um: por isso o servidor.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const PORT = Number(process.env.SOBEDESCE_LOCAL_DB_PORT ?? 54339);
mkdirSync("./data/pglite", { recursive: true });
const pg = await PGlite.create("./data/pglite");
const server = new PGLiteSocketServer({ db: pg, port: PORT, host: "127.0.0.1", maxConnections: 20 });
await server.start();
console.log(`Banco local: postgres://127.0.0.1:${PORT} (data/pglite)`);

const next = spawn("npx", ["next", "dev", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, SOBEDESCE_LOCAL_DB_URL: `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres` },
});
const stop = async () => {
  next.kill("SIGTERM");
  await server.stop().catch(() => {});
  await pg.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
next.on("exit", stop);
