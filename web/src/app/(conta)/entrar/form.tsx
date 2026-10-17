"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Aviso } from "@/components/conta/aviso";
import { Enviar } from "@/components/conta/enviar";
import { Field, Input } from "@/components/ui/field";
import { acaoEntrar, type EstadoForm } from "../acoes";

export function FormEntrar({ volta }: { volta: string }) {
  const [estado, acao] = useActionState<EstadoForm, FormData>(acaoEntrar, null);
  return (
    <form action={acao} className="grid gap-5">
      <input type="hidden" name="volta" value={volta} />
      {estado?.erro ? (
        <Aviso tom="erro">
          <p>{estado.erro}</p>
        </Aviso>
      ) : null}
      <Field label="E-mail" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} required defaultValue={estado?.valores?.email} />
      </Field>
      <Field label="Senha" htmlFor="senha">
        <Input id="senha" name="senha" type="password" autoComplete="current-password" required />
      </Field>
      <Link href="/esqueci-a-senha" className="toque -mt-2 justify-self-end rounded-full text-[14px] text-ink-2 underline-offset-4 hover:text-ink hover:underline">
        Esqueci a senha
      </Link>
      <Enviar variant="secondary" size="lg" className="mt-2 w-full" ocupado="Entrando…">
        Entrar
      </Enviar>
    </form>
  );
}
