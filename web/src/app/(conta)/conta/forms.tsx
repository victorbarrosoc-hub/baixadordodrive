"use client";

import { useActionState } from "react";
import { Enviar } from "@/components/conta/enviar";
import { Field, Input } from "@/components/ui/field";
import { SENHA_MINIMA } from "@/lib/auth/senha-regras";
import type { Conta } from "@/lib/google/contas";
import { acaoPedirPrimeiraSenha, acaoTrocarGoogleDeEntrar, acaoTrocarNome, acaoTrocarSenha, type EstadoForm } from "../acoes";

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

/**
 * Conta criada pelo Google, ainda sem senha (revisão A5): a primeira senha não sai só com a sessão aberta.
 * Mandamos um link para o e-mail da conta (o mesmo do "Esqueci a senha").
 */
export function FormPrimeiraSenha({ email }: { email: string }) {
  const [estado, acao] = useActionState<EstadoForm>(acaoPedirPrimeiraSenha, null);
  return (
    <form action={acao} className="grid gap-4">
      <p className="text-[15px] leading-relaxed text-pretty text-ink-2">
        Mandamos um link para <span className="font-medium text-ink [overflow-wrap:anywhere]">{email}</span>. Nele você cria a senha. É para ninguém
        com a sua sessão aberta criar uma senha no seu lugar.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <Enviar variant="secondary" ocupado="Mandando…">
          Mandar link para criar senha
        </Enviar>
        <Retorno estado={estado} />
      </div>
    </form>
  );
}

/** `links`: quantos links pra IA (/r/…) estão ligados; com algum, a troca oferece desligar todos juntos. */
export function FormSenha({ links = 0 }: { links?: number }) {
  const [estado, acao] = useActionState<EstadoForm, FormData>(acaoTrocarSenha, null);
  const erroDo = (campo: string) => (estado?.campo === campo ? estado.erro : null);
  return (
    <form action={acao} className="grid gap-5" key={estado?.ok ?? "senha"}>
      <Field label="Senha atual" htmlFor="senhaAtual" error={erroDo("senhaAtual")}>
        <Input id="senhaAtual" name="senhaAtual" type="password" autoComplete="current-password" required aria-invalid={Boolean(erroDo("senhaAtual"))} />
      </Field>
      <Field label="Senha nova" htmlFor="senhaNova" hint={`Pelo menos ${SENHA_MINIMA} caracteres.`} error={erroDo("senhaNova")}>
        <Input id="senhaNova" name="senhaNova" type="password" autoComplete="new-password" required minLength={SENHA_MINIMA} aria-invalid={Boolean(erroDo("senhaNova"))} />
      </Field>
      {links ? (
        <label className="flex items-start gap-3 text-[14px] leading-snug text-ink-2">
          <input type="checkbox" name="links" value="1" className="mt-0.5 size-5 shrink-0 accent-ink" />
          <span>
            Desligar também {links === 1 ? "o link pra IA" : `os ${links} links pra IA`}
            <span className="block text-[13px] text-ink-3">Quem tem o endereço deixa de abrir a coleção. Dá para ligar de novo depois, com endereço novo.</span>
          </span>
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <Enviar variant="secondary" ocupado="Salvando…">
          Trocar senha
        </Enviar>
        <Retorno estado={estado} />
      </div>
    </form>
  );
}

/**
 * Qual Google entra na conta (revisão A3). Só um; os outros Drives servem para enviar e baixar.
 * Trocar pede a senha atual. Sem senha (conta criada pelo Google), primeiro cria a senha.
 */
export function FormGoogleDeEntrar({ contas, entrar, temSenha }: { contas: Conta[]; entrar: string | null; temSenha: boolean }) {
  const [estado, acao] = useActionState<EstadoForm, FormData>(acaoTrocarGoogleDeEntrar, null);
  const atual = contas.find((c) => c.id === entrar) ?? null;
  const erroDo = (campo: string) => (estado?.campo === campo ? estado.erro : null);
  return (
    <div className="grid gap-5">
      <p className="text-[15px] leading-relaxed text-pretty text-ink-2">
        {atual ? (
          <>
            Entra com <span className="font-medium text-ink [overflow-wrap:anywhere]">{atual.email}</span>.
          </>
        ) : (
          "Nenhum Google entra nesta conta. Você entra com o e-mail e a senha."
        )}
      </p>
      {!temSenha ? (
        <p className="text-[14px] leading-relaxed text-pretty text-ink-3">Para trocar, crie uma senha antes (logo abaixo, em Senha).</p>
      ) : contas.length ? (
        <form action={acao} className="grid gap-5" key={estado?.ok ?? "entrar"}>
          <Field label="Google de entrar" htmlFor="conta" error={erroDo("conta")}>
            <select
              id="conta"
              name="conta"
              defaultValue={entrar ?? ""}
              className="h-12 w-full rounded-2xl bg-surface px-4 text-[16px] text-ink ring-1 ring-line-strong outline-none focus:ring-2 focus:ring-down"
            >
              {contas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.email}
                </option>
              ))}
              <option value="">Nenhum (só e-mail e senha)</option>
            </select>
          </Field>
          <Field label="Senha atual" htmlFor="senhaAtualGoogle" error={erroDo("senhaAtual")}>
            <Input id="senhaAtualGoogle" name="senhaAtual" type="password" autoComplete="current-password" required aria-invalid={Boolean(erroDo("senhaAtual"))} />
          </Field>
          <div className="flex flex-wrap items-center gap-4">
            <Enviar variant="secondary" ocupado="Salvando…">
              Salvar
            </Enviar>
            <Retorno estado={estado} />
          </div>
        </form>
      ) : null}
    </div>
  );
}
