CREATE TABLE "dispositivo_status" (
	"sessao_id" text PRIMARY KEY NOT NULL,
	"usuario_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"avisado" text,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_inscricoes" (
	"id" text PRIMARY KEY NOT NULL,
	"usuario_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"keys" jsonb NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"ultimo_envio_em" timestamp with time zone,
	"falhas" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "push_inscricoes_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
ALTER TABLE "dispositivo_status" ADD CONSTRAINT "dispositivo_status_sessao_id_sessoes_id_fk" FOREIGN KEY ("sessao_id") REFERENCES "public"."sessoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispositivo_status" ADD CONSTRAINT "dispositivo_status_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_inscricoes" ADD CONSTRAINT "push_inscricoes_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispositivo_status_usuario_idx" ON "dispositivo_status" USING btree ("usuario_id");--> statement-breakpoint
CREATE INDEX "dispositivo_status_atualizado_idx" ON "dispositivo_status" USING btree ("atualizado_em");--> statement-breakpoint
CREATE INDEX "push_inscricoes_usuario_idx" ON "push_inscricoes" USING btree ("usuario_id");