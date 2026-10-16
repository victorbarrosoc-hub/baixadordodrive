import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Aviso } from "@/components/conta/aviso";
import { BotaoGoogle } from "@/components/conta/google";
import { mensagemDeErro } from "@/components/conta/mensagens";
import { Moldura } from "@/components/conta/moldura";
import { buttonClasses } from "@/components/ui/button";
import { usuarioAtual } from "@/lib/auth/atual";
import { voltaSegura } from "@/lib/auth/volta";
import { FormEntrar } from "./form";

export const metadata: Metadata = { title: "Entrar" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function Entrar({ searchParams }: Props) {
  const q = await searchParams;
  const volta = voltaSegura(q.volta);
  const atual = await usuarioAtual();
  if (atual?.via === "cookie") redirect(volta);

  const erro = typeof q.erro === "string" ? q.erro : undefined;
  const comVolta = (caminho: string) => (volta === "/conta" ? caminho : `${caminho}?volta=${encodeURIComponent(volta)}`);

  return (
    <Moldura
      estreita
      titulo="Entrar"
      subtitulo="Use o e-mail e a senha da sua conta SOBEDESCE."
      acao={
        <Link href={comVolta("/criar-conta")} className={buttonClasses({ variant: "ghost", size: "sm" })}>
          Criar conta
        </Link>
      }
    >
      {erro === "google_sem_conta" ? (
        <Aviso className="mb-8">
          <p className="font-medium">Esta conta do Google ainda não está ligada a uma conta SOBEDESCE.</p>
          <p className="text-ink-2">
            Primeiro, crie sua conta com e-mail e senha. Depois, dentro dela, conecte o Google Drive. A partir daí, o botão Entrar com Google funciona.
          </p>
          <p>
            <Link href={comVolta("/criar-conta")} className="font-medium text-ink underline underline-offset-4">
              Criar conta
            </Link>
          </p>
        </Aviso>
      ) : mensagemDeErro(erro) ? (
        <Aviso tom={erro === "google_recusado" ? "info" : "erro"} className="mb-8">
          <p>{mensagemDeErro(erro)}</p>
        </Aviso>
      ) : null}

      <FormEntrar volta={volta} />

      <div className="my-7 flex items-center gap-4 text-[13px] text-ink-3" aria-hidden>
        <span className="h-px flex-1 bg-line" />
        ou
        <span className="h-px flex-1 bg-line" />
      </div>

      <BotaoGoogle modo="entrar" volta={volta} className="w-full">
        Entrar com Google
      </BotaoGoogle>
      <p className="mt-3 text-center text-[13px] leading-relaxed text-pretty text-ink-3">Funciona depois que você conecta o Google Drive na sua conta.</p>

      <p className="mt-12 text-center text-[15px] text-ink-2">
        Ainda não tem conta?{" "}
        <Link href={comVolta("/criar-conta")} className="font-medium text-ink underline-offset-4 hover:underline">
          Criar conta
        </Link>
      </p>
    </Moldura>
  );
}
