CREATE TABLE "codigos_dispositivo" (
	"id" text PRIMARY KEY NOT NULL,
	"codigo" text NOT NULL,
	"segredo_hash" text NOT NULL,
	"nome" text NOT NULL,
	"plataforma" text,
	"usuario_id" text,
	"aprovado_em" timestamp with time zone,
	"usado_em" timestamp with time zone,
	"consultado_em" timestamp with time zone,
	"expira_em" timestamp with time zone NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "codigos_dispositivo_codigo_unique" UNIQUE("codigo"),
	CONSTRAINT "codigos_dispositivo_segredoHash_unique" UNIQUE("segredo_hash")
);
--> statement-breakpoint
CREATE TABLE "contas_google" (
	"id" text PRIMARY KEY NOT NULL,
	"usuario_id" text NOT NULL,
	"google_sub" text NOT NULL,
	"email" text NOT NULL,
	"nome" text,
	"foto_url" text,
	"refresh_token_enc" text NOT NULL,
	"access_token_enc" text,
	"access_expira_em" timestamp with time zone,
	"escopos" text DEFAULT '' NOT NULL,
	"estado" text DEFAULT 'ok' NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contas_google_googleSub_unique" UNIQUE("google_sub")
);
--> statement-breakpoint
CREATE TABLE "sessoes" (
	"id" text PRIMARY KEY NOT NULL,
	"usuario_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"tipo" text NOT NULL,
	"nome" text,
	"plataforma" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"ultimo_uso_em" timestamp with time zone DEFAULT now() NOT NULL,
	"expira_em" timestamp with time zone NOT NULL,
	"revogada_em" timestamp with time zone,
	CONSTRAINT "sessoes_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "tentativas" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tentativas_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"chave" text NOT NULL,
	"quando" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usuarios" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"nome" text NOT NULL,
	"senha_hash" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"ultimo_login_em" timestamp with time zone,
	CONSTRAINT "usuarios_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "codigos_dispositivo" ADD CONSTRAINT "codigos_dispositivo_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contas_google" ADD CONSTRAINT "contas_google_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessoes" ADD CONSTRAINT "sessoes_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contas_google_usuario_idx" ON "contas_google" USING btree ("usuario_id");--> statement-breakpoint
CREATE INDEX "sessoes_usuario_idx" ON "sessoes" USING btree ("usuario_id");--> statement-breakpoint
CREATE INDEX "tentativas_chave_quando_idx" ON "tentativas" USING btree ("chave","quando");