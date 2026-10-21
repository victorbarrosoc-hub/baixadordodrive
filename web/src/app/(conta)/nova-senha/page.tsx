import type { Metadata } from "next";
import { LockKeyhole } from "lucide-react";
import { Moldura } from "@/components/conta/moldura";
import { ButtonLink } from "@/components/ui/button";
import { linkValido } from "@/lib/auth/redefinir";
import { FormNovaSenha } from "./form";

// O token está no endereço: nada de Referer para fora.
export const metadata: Metadata = { title: "Senha nova", referrer: "no-referrer", robots: { index: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function NovaSenha({ searchParams }: Props) {
  const q = await searchParams;
  const token = typeof q.token === "string" ? q.token : "";
  if (!(await linkValido(token))) {
    return (
      <Moldura estreita icone={<LockKeyhole />} titulo="Link vencido" subtitulo="Este link venceu ou já foi usado. Peça outro, ele chega em instantes.">
        <ButtonLink href="/esqueci-a-senha" size="lg" className="w-full">
          Pedir outro link
        </ButtonLink>
      </Moldura>
    );
  }
  return (
    <Moldura estreita icone={<LockKeyhole />} titulo="Senha nova" subtitulo="Depois de salvar, os outros aparelhos saem da conta e você entra com a senha nova.">
      <FormNovaSenha token={token} />
    </Moldura>
  );
}
