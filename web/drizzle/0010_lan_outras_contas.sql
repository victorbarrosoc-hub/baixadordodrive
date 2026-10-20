ALTER TABLE "lan_presenca" ADD COLUMN "chave_publica" text;--> statement-breakpoint
ALTER TABLE "lan_presenca" ADD COLUMN "aceita_outros" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lan_presenca" ADD COLUMN "rede" text;--> statement-breakpoint
CREATE INDEX "lan_presenca_rede_idx" ON "lan_presenca" USING btree ("rede");