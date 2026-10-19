CREATE TABLE "pedidos_proxy" (
	"id" text PRIMARY KEY NOT NULL,
	"usuario_id" text NOT NULL,
	"conta_google_id" text NOT NULL,
	"file_id" text NOT NULL,
	"nome" text NOT NULL,
	"tamanho" bigint,
	"status" text DEFAULT 'pendente' NOT NULL,
	"erro" text,
	"resultado" text,
	"proxy_file_id" text,
	"dispositivo_id" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pedidos_proxy" ADD CONSTRAINT "pedidos_proxy_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pedidos_proxy" ADD CONSTRAINT "pedidos_proxy_conta_google_id_contas_google_id_fk" FOREIGN KEY ("conta_google_id") REFERENCES "public"."contas_google"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pedidos_proxy_usuario_status_idx" ON "pedidos_proxy" USING btree ("usuario_id","status");--> statement-breakpoint
CREATE INDEX "pedidos_proxy_arquivo_idx" ON "pedidos_proxy" USING btree ("usuario_id","file_id");