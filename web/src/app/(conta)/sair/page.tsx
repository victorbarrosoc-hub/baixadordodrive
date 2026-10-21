import type { Metadata } from "next";
import { LogOut } from "lucide-react";
import { redirect } from "next/navigation";
import { Moldura } from "@/components/conta/moldura";
import { Enviar } from "@/components/conta/enviar";
import { ButtonLink } from "@/components/ui/button";
import { usuarioAtual } from "@/lib/auth/atual";
import { acaoSair } from "../acoes";

export const metadata: Metadata = { title: "Sair" };

/** Sair pede um toque (POST): um link qualquer não derruba a sessão de ninguém. */
export default async function Sair() {
  const atual = await usuarioAtual();
  if (!atual || atual.via !== "cookie") redirect("/entrar");
  return (
    <Moldura estreita icone={<LogOut />} titulo="Sair da conta?" subtitulo={`Você está como ${atual.usuario.email}.`}>
      <div className="grid gap-3">
        <form action={acaoSair}>
          <Enviar size="lg" className="w-full" ocupado="Saindo…">
            Sair
          </Enviar>
        </form>
        <ButtonLink href="/conta" variant="ghost" size="lg" className="w-full">
          Voltar
        </ButtonLink>
      </div>
    </Moldura>
  );
}
