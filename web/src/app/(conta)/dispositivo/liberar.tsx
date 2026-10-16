"use client";

import { CircleCheck, Laptop, Monitor } from "lucide-react";
import Link from "next/link";
import { useActionState } from "react";
import { Aviso } from "@/components/conta/aviso";
import { Enviar } from "@/components/conta/enviar";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { acaoLiberarComputador, acaoRecusarComputador, type EstadoForm } from "../acoes";

export function DigitarCodigo({ invalido }: { invalido: boolean }) {
  return (
    <form method="get" action="/dispositivo" className="grid gap-5">
      <Field label="Código" htmlFor="codigo" error={invalido ? "Confira o código: são 8 letras, como BCDF-GHJK." : null}>
        <Input
          id="codigo"
          name="codigo"
          required
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="BCDF-GHJK"
          maxLength={12}
          className="text-center font-mono text-[20px] tracking-[0.2em] uppercase"
        />
      </Field>
      <button type="submit" className={buttonClasses({ size: "lg", className: "w-full" })}>
        Continuar
      </button>
    </form>
  );
}

export function PedidoVencido() {
  return (
    <div className="grid gap-3">
      <ButtonLink href="/conta" size="lg" className="w-full">
        Ir para a conta
      </ButtonLink>
      <ButtonLink href="/dispositivo" variant="ghost" size="lg" className="w-full">
        Digitar outro código
      </ButtonLink>
    </div>
  );
}

export function Liberar({
  codigo,
  nome,
  plataforma,
  mac,
  email,
  jaLiberado,
}: {
  codigo: string;
  nome: string;
  plataforma: string | null;
  mac: boolean;
  email: string;
  jaLiberado: boolean;
}) {
  const [liberar, acaoLiberar] = useActionState<EstadoForm, FormData>(acaoLiberarComputador, null);
  const [recusar, acaoRecusar] = useActionState<EstadoForm, FormData>(acaoRecusarComputador, null);
  const Icone = mac ? Laptop : Monitor;

  if (jaLiberado || liberar?.ok === "liberado") {
    return (
      <div className="grid justify-items-center gap-5 text-center">
        <CircleCheck aria-hidden className="size-12 text-ok" strokeWidth={1.5} />
        <div className="grid gap-2">
          <p className="text-[20px] font-semibold tracking-tight">Pronto</p>
          <p className="text-[16px] leading-relaxed text-pretty text-ink-2">{nome} já está entrando na sua conta. Pode voltar para o computador.</p>
        </div>
        <Link href="/conta" className={buttonClasses({ variant: "secondary", className: "mt-4" })}>
          Ver minha conta
        </Link>
      </div>
    );
  }

  if (recusar?.ok === "recusado") {
    return (
      <div className="grid gap-6 text-center">
        <p className="text-[16px] leading-relaxed text-pretty text-ink-2">Pedido recusado. Esse computador não entrou na sua conta.</p>
        <ButtonLink href="/conta" variant="secondary" size="lg" className="w-full">
          Ir para a conta
        </ButtonLink>
      </div>
    );
  }

  return (
    <div className="grid gap-8">
      <Card className="grid justify-items-center gap-5 px-6 pt-8 pb-7 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-surface-2 text-ink ring-1 ring-line">
          <Icone aria-hidden className="size-6" strokeWidth={1.6} />
        </span>
        <div className="grid gap-1">
          <p className="text-[19px] font-semibold tracking-tight text-balance break-words">{nome}</p>
          {plataforma ? <p className="text-[15px] text-ink-2">{plataforma}</p> : null}
        </div>
        <div className="w-full rounded-2xl bg-surface-2 px-4 py-4">
          <p className="text-[12px] font-medium tracking-[0.08em] text-ink-3 uppercase">Código</p>
          <p className="mt-1 font-mono text-[28px] font-semibold tracking-[0.18em] sm:text-[30px]">{codigo}</p>
        </div>
        <p className="text-[14px] leading-relaxed text-pretty text-ink-2">Confira se é o mesmo código do computador. Só libere se foi você quem pediu.</p>
      </Card>

      {liberar?.erro ? (
        <Aviso tom="erro">
          <p>{liberar.erro}</p>
        </Aviso>
      ) : null}

      <div className="grid gap-3">
        <form action={acaoLiberar}>
          <input type="hidden" name="codigo" value={codigo} />
          <Enviar size="lg" className="w-full" ocupado="Liberando…">
            Liberar este computador
          </Enviar>
        </form>
        <form action={acaoRecusar}>
          <input type="hidden" name="codigo" value={codigo} />
          <Enviar variant="ghost" size="lg" className="w-full text-ink-2">
            Não fui eu
          </Enviar>
        </form>
      </div>

      <p className="text-center text-[13px] text-ink-3">
        Conta: <span className="text-ink-2">{email}</span>
      </p>
    </div>
  );
}
