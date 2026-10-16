"use client";

import { useActionState } from "react";
import { Aviso } from "@/components/conta/aviso";
import { Enviar } from "@/components/conta/enviar";
import { Field, Input } from "@/components/ui/field";
import { SENHA_MINIMA } from "@/lib/auth/senha-regras";
import { acaoCriarConta, type EstadoForm } from "../acoes";

export function FormCriarConta({ volta }: { volta: string }) {
  const [estado, acao] = useActionState<EstadoForm, FormData>(acaoCriarConta, null);
  const erroDo = (campo: string) => (estado?.campo === campo ? estado.erro : null);
  return (
    <form action={acao} className="grid gap-5">
      <input type="hidden" name="volta" value={volta} />
      {estado?.erro && !estado.campo ? (
        <Aviso tom="erro">
          <p>{estado.erro}</p>
        </Aviso>
      ) : null}
      <Field label="Nome" htmlFor="nome" error={erroDo("nome")}>
        <Input id="nome" name="nome" autoComplete="name" required maxLength={80} defaultValue={estado?.valores?.nome} aria-invalid={Boolean(erroDo("nome"))} />
      </Field>
      <Field label="E-mail" htmlFor="email" error={erroDo("email")}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          defaultValue={estado?.valores?.email}
          aria-invalid={Boolean(erroDo("email"))}
        />
      </Field>
      <Field label="Senha" htmlFor="senha" hint={`Pelo menos ${SENHA_MINIMA} caracteres. Uma frase vale.`} error={erroDo("senha")}>
        <Input id="senha" name="senha" type="password" autoComplete="new-password" required minLength={SENHA_MINIMA} aria-invalid={Boolean(erroDo("senha"))} />
      </Field>
      <Enviar variant="secondary" size="lg" className="mt-2 w-full" ocupado="Criando…">
        Criar conta
      </Enviar>
    </form>
  );
}
