/** Aplica as migrações pendentes. Uso: npm run db:migrate */
const { runMigrations, closeDatabase } = await import("../src/lib/db/client");
await runMigrations();
await closeDatabase();
console.log("Migrações aplicadas.");
