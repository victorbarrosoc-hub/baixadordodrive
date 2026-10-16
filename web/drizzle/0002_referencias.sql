CREATE TABLE "atalhos" (
	"id" text PRIMARY KEY NOT NULL,
	"usuario_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"ultimo_uso_em" timestamp with time zone,
	"revogado_em" timestamp with time zone,
	CONSTRAINT "atalhos_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "colecoes" (
	"id" text PRIMARY KEY NOT NULL,
	"usuario_id" text NOT NULL,
	"conta_google_id" text NOT NULL,
	"drive_folder_id" text NOT NULL,
	"nome" text NOT NULL,
	"nome_chave" text NOT NULL,
	"publica_token" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "colecoes_publicaToken_unique" UNIQUE("publica_token")
);
--> statement-breakpoint
CREATE TABLE "referencias_fila" (
	"id" text PRIMARY KEY NOT NULL,
	"usuario_id" text NOT NULL,
	"colecao_id" text NOT NULL,
	"url" text NOT NULL,
	"nota" text,
	"status" text DEFAULT 'pendente' NOT NULL,
	"erro" text,
	"drive_file_id" text,
	"dispositivo_id" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contas_google" ADD COLUMN "referencias_pasta_id" text;--> statement-breakpoint
ALTER TABLE "usuarios" ADD COLUMN "plano" text DEFAULT 'gratis' NOT NULL;--> statement-breakpoint
ALTER TABLE "atalhos" ADD CONSTRAINT "atalhos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colecoes" ADD CONSTRAINT "colecoes_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colecoes" ADD CONSTRAINT "colecoes_conta_google_id_contas_google_id_fk" FOREIGN KEY ("conta_google_id") REFERENCES "public"."contas_google"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referencias_fila" ADD CONSTRAINT "referencias_fila_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referencias_fila" ADD CONSTRAINT "referencias_fila_colecao_id_colecoes_id_fk" FOREIGN KEY ("colecao_id") REFERENCES "public"."colecoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "atalhos_usuario_idx" ON "atalhos" USING btree ("usuario_id");--> statement-breakpoint
CREATE INDEX "colecoes_usuario_idx" ON "colecoes" USING btree ("usuario_id");--> statement-breakpoint
CREATE UNIQUE INDEX "colecoes_usuario_nome_idx" ON "colecoes" USING btree ("usuario_id","nome_chave");--> statement-breakpoint
CREATE INDEX "referencias_fila_usuario_status_idx" ON "referencias_fila" USING btree ("usuario_id","status");--> statement-breakpoint
CREATE INDEX "referencias_fila_colecao_idx" ON "referencias_fila" USING btree ("colecao_id");