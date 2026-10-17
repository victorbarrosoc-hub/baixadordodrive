"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Aviso } from "@/components/conta/aviso";
import { Enviar } from "@/components/conta/enviar";
import { Field, Input } from "@/components/ui/field";
import { SENHA_MINIMA } from "@/lib/auth/senha-regras";
import { acaoNovaSenha, type EstadoForm } from "../acoes";

export function FormNovaSenha({ token }: { token: string }) {
  const [estado, acao] = useActionState<EstadoForm, FormData>(acaoNovaSenha, null);
  return (
    <form action={acao} className="grid gap-5">
      <input type="hidden" name="token" value={token} />
      {estado?.erro && estado.campo !== "senha" ? (
        <Aviso tom="erro">
          <p>{estado.erro}</p>
          <p>
            <Link href="/esqueci-a-senha" className="toque font-medium text-ink underline underline-offset-4">
              Pedir outro link
            </Link>
          </p>
        </Aviso>
      ) : null}
      <Field label="Senha nova" htmlFor="senha" hint={`Pelo menos ${SENHA_MINIMA} caracteres. Uma frase vale.`} error={estado?.campo === "senha" ? estado.erro : null}>
        <Input id="senha" name="senha" type="password" autoComplete="new-password" required minLength={SENHA_MINIMA} autoFocus />
      </Field>
      <Enviar size="lg" className="mt-2 w-full" ocupado="Salvando…">
        Salvar e entrar
      </Enviar>
    </form>
  );
}
