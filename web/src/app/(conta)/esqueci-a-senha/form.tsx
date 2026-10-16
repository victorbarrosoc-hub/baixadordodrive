"use client";

import { MailCheck } from "lucide-react";
import { useActionState } from "react";
import { Aviso } from "@/components/conta/aviso";
import { Enviar } from "@/components/conta/enviar";
import { Field, Input } from "@/components/ui/field";
import { acaoEsqueciSenha, type EstadoForm } from "../acoes";

export function FormEsqueci() {
  const [estado, acao] = useActionState<EstadoForm, FormData>(acaoEsqueciSenha, null);
  if (estado?.ok) {
    return (
      <div className="grid justify-items-center gap-4 text-center" role="status">
        <MailCheck aria-hidden className="size-11 text-ink" strokeWidth={1.4} />
        <p className="text-[16px] leading-relaxed text-pretty text-ink-2">{estado.ok}</p>
        <p className="text-[14px] text-ink-3">O link vale por 1 hora.</p>
      </div>
    );
  }
  return (
    <form action={acao} className="grid gap-5">
      {estado?.erro && estado.campo !== "email" ? (
        <Aviso tom="erro">
          <p>{estado.erro}</p>
        </Aviso>
      ) : null}
      <Field label="E-mail da conta" htmlFor="email" error={estado?.campo === "email" ? estado.erro : null}>
        <Input id="email" name="email" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} required defaultValue={estado?.valores?.email} />
      </Field>
      <Enviar size="lg" className="mt-2 w-full" ocupado="Enviando…">
        Mandar link
      </Enviar>
    </form>
  );
}
