CREATE TABLE "p2p_aparelhos" (
	"sessao_id" text PRIMARY KEY NOT NULL,
	"usuario_id" text NOT NULL,
	"tipo" text NOT NULL,
	"nome" text NOT NULL,
	"rede" text,
	"aceita_outros" boolean DEFAULT false NOT NULL,
	"visto_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "p2p_sinais" (
	"id" text PRIMARY KEY NOT NULL,
	"usuario_id" text NOT NULL,
	"para_usuario" text NOT NULL,
	"de_sessao" text NOT NULL,
	"para_sessao" text NOT NULL,
	"tipo" text NOT NULL,
	"oferta" text,
	"sdp" text,
	"resumo" jsonb,
	"motivo" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"entregue_em" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "p2p_aparelhos" ADD CONSTRAINT "p2p_aparelhos_sessao_id_sessoes_id_fk" FOREIGN KEY ("sessao_id") REFERENCES "public"."sessoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "p2p_aparelhos" ADD CONSTRAINT "p2p_aparelhos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "p2p_sinais" ADD CONSTRAINT "p2p_sinais_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "p2p_sinais" ADD CONSTRAINT "p2p_sinais_para_usuario_usuarios_id_fk" FOREIGN KEY ("para_usuario") REFERENCES "public"."usuarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "p2p_sinais" ADD CONSTRAINT "p2p_sinais_de_sessao_sessoes_id_fk" FOREIGN KEY ("de_sessao") REFERENCES "public"."sessoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "p2p_sinais" ADD CONSTRAINT "p2p_sinais_para_sessao_sessoes_id_fk" FOREIGN KEY ("para_sessao") REFERENCES "public"."sessoes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "p2p_aparelhos_usuario_idx" ON "p2p_aparelhos" USING btree ("usuario_id","visto_em");--> statement-breakpoint
CREATE INDEX "p2p_aparelhos_rede_idx" ON "p2p_aparelhos" USING btree ("rede","visto_em");--> statement-breakpoint
CREATE INDEX "p2p_sinais_para_idx" ON "p2p_sinais" USING btree ("para_sessao","entregue_em");--> statement-breakpoint
CREATE INDEX "p2p_sinais_criado_idx" ON "p2p_sinais" USING btree ("criado_em");