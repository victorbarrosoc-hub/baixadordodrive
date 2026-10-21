import type { Metadata } from "next";
import { UserPlus } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BotaoGoogle } from "@/components/conta/google";
import { Moldura } from "@/components/conta/moldura";
import { buttonClasses } from "@/components/ui/button";
import { usuarioAtual } from "@/lib/auth/atual";
import { voltaSegura } from "@/lib/auth/volta";
import { FormCriarConta } from "./form";

export const metadata: Metadata = { title: "Criar conta" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function CriarConta({ searchParams }: Props) {
  const q = await searchParams;
  const volta = voltaSegura(q.volta);
  const atual = await usuarioAtual();
  if (atual?.via === "cookie") redirect(volta);
  const entrar = volta === "/conta" ? "/entrar" : `/entrar?volta=${encodeURIComponent(volta)}`;

  return (
    <Moldura
      estreita
      icone={<UserPlus />}
      titulo="Criar conta"
      subtitulo="Entre com o Google e o seu Drive já fica conectado."
      acao={
        <Link href={entrar} className={buttonClasses({ variant: "ghost", size: "sm" })}>
          Entrar
        </Link>
      }
    >
      <BotaoGoogle modo="entrar" volta={volta} variant="primary" className="w-full">
        Continuar com Google
      </BotaoGoogle>
      <p className="mt-3 text-center text-[13px] leading-relaxed text-pretty text-ink-3">Cria a conta e conecta o Drive num passo só.</p>

      <div className="my-8 flex items-center gap-4 text-[13px] text-ink-3" aria-hidden>
        <span className="h-px flex-1 bg-line" />
        ou com e-mail
        <span className="h-px flex-1 bg-line" />
      </div>

      <FormCriarConta volta={volta} />
      <p className="mt-4 text-center text-[13px] leading-relaxed text-pretty text-ink-3">Com e-mail, você conecta o Drive depois, em Sua conta.</p>
      <p className="mt-12 text-center text-[15px] text-ink-2">
        Já tem conta?{" "}
        <Link href={entrar} className="toque font-medium text-ink underline-offset-4 hover:underline">
          Entrar
        </Link>
      </p>
    </Moldura>
  );
}
