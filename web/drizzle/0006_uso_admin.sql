CREATE TABLE "atividade_diaria" (
	"usuario_id" text NOT NULL,
	"dia" date NOT NULL,
	"site" boolean DEFAULT false NOT NULL,
	"celular" boolean DEFAULT false NOT NULL,
	"computador" boolean DEFAULT false NOT NULL,
	"ultima_em" timestamp with time zone DEFAULT now() NOT NULL,
	"ultima_origem" text,
	CONSTRAINT "atividade_diaria_usuario_id_dia_pk" PRIMARY KEY("usuario_id","dia")
);
--> statement-breakpoint
CREATE TABLE "avisos_admin" (
	"chave" text PRIMARY KEY NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uso_diario" (
	"sessao_id" text NOT NULL,
	"usuario_id" text NOT NULL,
	"dia" date NOT NULL,
	"enviados_bytes" bigint DEFAULT 0 NOT NULL,
	"baixados_bytes" bigint DEFAULT 0 NOT NULL,
	"enviados" integer DEFAULT 0 NOT NULL,
	"baixados" integer DEFAULT 0 NOT NULL,
	"erros" integer DEFAULT 0 NOT NULL,
	"maior_arquivo" bigint DEFAULT 0 NOT NULL,
	"ms_ativo" bigint DEFAULT 0 NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uso_diario_sessao_id_dia_pk" PRIMARY KEY("sessao_id","dia")
);
--> statement-breakpoint
ALTER TABLE "sessoes" ADD COLUMN "app_build" integer;--> statement-breakpoint
ALTER TABLE "atividade_diaria" ADD CONSTRAINT "atividade_diaria_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uso_diario" ADD CONSTRAINT "uso_diario_sessao_id_sessoes_id_fk" FOREIGN KEY ("sessao_id") REFERENCES "public"."sessoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uso_diario" ADD CONSTRAINT "uso_diario_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "atividade_diaria_dia_idx" ON "atividade_diaria" USING btree ("dia");--> statement-breakpoint
CREATE INDEX "uso_diario_usuario_dia_idx" ON "uso_diario" USING btree ("usuario_id","dia");