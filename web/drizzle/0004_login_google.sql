ALTER TABLE "codigos_dispositivo" ADD COLUMN "pedido_ip" text;--> statement-breakpoint
ALTER TABLE "codigos_dispositivo" ADD COLUMN "pedido_cidade" text;--> statement-breakpoint
ALTER TABLE "codigos_dispositivo" ADD COLUMN "pedido_pais" text;--> statement-breakpoint
ALTER TABLE "contas_google" ADD COLUMN "login_permitido" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contas_google" ADD COLUMN "email_verificado" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Revisão A3: "Entrar com Google" passa a valer só pelo Google marcado para entrar (login_permitido).
-- Ninguém perde o login: cada conta com Drive fica com exatamente um Google de entrar. O banco não guardava qual
-- Google criou a conta; quem criou tem o mesmo e-mail da conta (o "Continuar com Google" grava o e-mail do Google
-- como e-mail da conta) e é o mais antigo dela. Então: primeiro o de mesmo e-mail da conta, senão o mais antigo.
UPDATE "contas_google" AS cg SET "login_permitido" = true
WHERE cg."id" IN (
	SELECT DISTINCT ON (c."usuario_id") c."id"
	FROM "contas_google" c JOIN "usuarios" u ON u."id" = c."usuario_id"
	ORDER BY c."usuario_id", (lower(c."email") = u."email") DESC, c."criado_em" ASC, c."id" ASC
);--> statement-breakpoint
-- Restinho do A2: o e-mail confirmado pelo Google só é conhecido de agora em diante (ao conectar ou entrar).
-- Já confirmado: o Google que criou a conta (o "Continuar com Google" sempre exigiu email_verified) e que ainda
-- tem o e-mail da conta.
UPDATE "contas_google" AS cg SET "email_verificado" = true
FROM "usuarios" u
WHERE u."id" = cg."usuario_id" AND u."senha_hash" = 'google' AND lower(cg."email") = u."email";--> statement-breakpoint
CREATE UNIQUE INDEX "contas_google_login_idx" ON "contas_google" USING btree ("usuario_id") WHERE "contas_google"."login_permitido";