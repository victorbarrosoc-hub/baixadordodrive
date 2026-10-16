import { defineConfig } from "drizzle-kit";

// Só gera as migrações (npm run db:generate); quem aplica é scripts/db-migrate.mts.
export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  casing: "snake_case",
});
