ALTER TABLE "pedidos_proxy" ADD COLUMN "tipo" text DEFAULT 'proxy' NOT NULL;--> statement-breakpoint
ALTER TABLE "pedidos_proxy" ADD COLUMN "ajustes" jsonb;