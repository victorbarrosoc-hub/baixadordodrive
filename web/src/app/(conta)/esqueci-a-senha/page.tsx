import type { Metadata } from "next";
import Link from "next/link";
import { Aviso } from "@/components/conta/aviso";
import { Moldura } from "@/components/conta/moldura";
import { buttonClasses } from "@/components/ui/button";
import { MENSAGEM_INDISPONIVEL } from "@/lib/auth/redefinir";
import { emailDisponivel } from "@/lib/email/enviar";
import { FormEsqueci } from "./form";

export const metadata: Metadata = { title: "Esqueci a senha" };

export default function EsqueciASenha() {
  const disponivel = emailDisponivel();
  return (
    <Moldura
      estreita
      titulo="Esqueci a senha"
      subtitulo="Mandamos um link para você criar uma senha nova."
      acao={
        <Link href="/entrar" className={buttonClasses({ variant: "ghost", size: "sm" })}>
          Entrar
        </Link>
      }
    >
      {disponivel ? (
        <FormEsqueci />
      ) : (
        <Aviso>
          <p>{MENSAGEM_INDISPONIVEL}</p>
        </Aviso>
      )}
      <p className="mt-12 text-center text-[15px] text-ink-2">
        Lembrou?{" "}
        <Link href="/entrar" className="font-medium text-ink underline-offset-4 hover:underline">
          Entrar
        </Link>
      </p>
    </Moldura>
  );
}
