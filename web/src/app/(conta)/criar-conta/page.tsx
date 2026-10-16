import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
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
      titulo="Criar conta"
      subtitulo="Uma conta para os seus Drives, no celular e no computador."
      acao={
        <Link href={entrar} className={buttonClasses({ variant: "ghost", size: "sm" })}>
          Entrar
        </Link>
      }
    >
      <FormCriarConta volta={volta} />
      <p className="mt-6 text-center text-[13px] leading-relaxed text-pretty text-ink-3">Depois de criar, você conecta o Google Drive dentro da conta.</p>
      <p className="mt-12 text-center text-[15px] text-ink-2">
        Já tem conta?{" "}
        <Link href={entrar} className="font-medium text-ink underline-offset-4 hover:underline">
          Entrar
        </Link>
      </p>
    </Moldura>
  );
}
