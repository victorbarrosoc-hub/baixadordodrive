CREATE TABLE "lan_presenca" (
	"sessao_id" text PRIMARY KEY NOT NULL,
	"usuario_id" text NOT NULL,
	"enderecos" jsonb NOT NULL,
	"porta" integer NOT NULL,
	"chave_enc" text NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lan_presenca" ADD CONSTRAINT "lan_presenca_sessao_id_sessoes_id_fk" FOREIGN KEY ("sessao_id") REFERENCES "public"."sessoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lan_presenca" ADD CONSTRAINT "lan_presenca_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lan_presenca_usuario_idx" ON "lan_presenca" USING btree ("usuario_id");