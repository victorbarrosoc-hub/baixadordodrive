"use client";

import { useActionState } from "react";
import { Enviar } from "@/components/conta/enviar";
import { Field, Input } from "@/components/ui/field";
import { SENHA_MINIMA } from "@/lib/auth/senha-regras";
import { acaoTrocarNome, acaoTrocarSenha, type EstadoForm } from "../acoes";

function Retorno({ estado }: { estado: EstadoForm }) {
  if (estado?.ok) return <p role="status" className="text-[14px] text-ok-text">{estado.ok}</p>;
  if (estado?.erro && !estado.campo) return <p role="alert" className="text-[14px] text-err-text">{estado.erro}</p>;
  return null;
}

export function FormNome({ nome }: { nome: string }) {
  const [estado, acao] = useActionState<EstadoForm, FormData>(acaoTrocarNome, null);
  return (
    <form action={acao} className="grid gap-3">
      <Field label="Nome" htmlFor="nome" error={estado?.campo === "nome" ? estado.erro : null}>
        <div className="flex gap-2">
          <Input id="nome" name="nome" autoComplete="name" required maxLength={80} defaultValue={nome} className="min-w-0 flex-1" />
          <Enviar variant="secondary" className="h-12" ocupado="Salvando…">
            Salvar
          </Enviar>
        </div>
      </Field>
      <Retorno estado={estado} />
    </form>
  );
}

export function FormSenha({ temSenha }: { temSenha: boolean }) {
  const [estado, acao] = useActionState<EstadoForm, FormData>(acaoTrocarSenha, null);
  const erroDo = (campo: string) => (estado?.campo === campo ? estado.erro : null);
  return (
    <form action={acao} className="grid gap-5" key={estado?.ok ?? "senha"}>
      {temSenha ? (
        <Field label="Senha atual" htmlFor="senhaAtual" error={erroDo("senhaAtual")}>
          <Input id="senhaAtual" name="senhaAtual" type="password" autoComplete="current-password" required aria-invalid={Boolean(erroDo("senhaAtual"))} />
        </Field>
      ) : null}
      <Field label={temSenha ? "Senha nova" : "Senha"} htmlFor="senhaNova" hint={`Pelo menos ${SENHA_MINIMA} caracteres.`} error={erroDo("senhaNova")}>
        <Input id="senhaNova" name="senhaNova" type="password" autoComplete="new-password" required minLength={SENHA_MINIMA} aria-invalid={Boolean(erroDo("senhaNova"))} />
      </Field>
      <div className="flex flex-wrap items-center gap-4">
        <Enviar variant="secondary" ocupado="Salvando…">
          {temSenha ? "Trocar senha" : "Criar senha"}
        </Enviar>
        <Retorno estado={estado} />
      </div>
    </form>
  );
}
