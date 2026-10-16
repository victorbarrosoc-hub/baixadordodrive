"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Enviar } from "@/components/conta/enviar";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { acaoApagarConta, type EstadoForm } from "../acoes";

const PALAVRA = "APAGAR";

/**
 * Zona de perigo: abre um diálogo que pede a senha atual e a palavra APAGAR.
 * O botão só libera com a palavra; o servidor confere as duas.
 */
export function ApagarConta({ email, temSenha }: { email: string; temSenha: boolean }) {
  const dialogo = useRef<HTMLDialogElement>(null);
  const [aberto, setAberto] = useState(false);
  const [palavra, setPalavra] = useState("");
  const [estado, acao] = useActionState<EstadoForm, FormData>(acaoApagarConta, null);
  const confere = palavra.trim() === PALAVRA;

  useEffect(() => {
    const d = dialogo.current;
    if (!d) return;
    if (aberto && !d.open) d.showModal();
    if (!aberto && d.open) d.close();
  }, [aberto]);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-[15px] text-ink-2">Não dá para desfazer.</p>
        <Button variant="secondary" className="text-err-text" onClick={() => setAberto(true)}>
          Apagar minha conta
        </Button>
      </div>

      <dialog
        ref={dialogo}
        aria-labelledby="apagar-titulo"
        onClose={() => {
          setAberto(false);
          setPalavra("");
        }}
        className="m-auto w-[min(440px,calc(100vw-32px))] rounded-[24px] bg-surface p-0 text-ink shadow-[0_24px_80px_rgba(0,0,0,0.18)] ring-1 ring-line backdrop:bg-black/40 backdrop:backdrop-blur-[2px]"
      >
        <form action={acao} className="grid gap-5 px-6 pt-7 pb-6 sm:px-7">
          <div className="grid gap-2">
            <h2 id="apagar-titulo" className="text-[22px] font-semibold tracking-[-0.015em]">
              Apagar a conta?
            </h2>
            <p className="text-[15px] leading-relaxed text-pretty text-ink-2">
              A conta {email} some agora, com os Drives conectados e os computadores. Os arquivos no Google Drive continuam lá.
            </p>
          </div>

          {estado?.erro && !estado.campo ? (
            <p role="alert" className="text-[14px] text-err-text">
              {estado.erro}
            </p>
          ) : null}

          {temSenha ? (
            <Field label="Senha atual" htmlFor="apagar-senha" error={estado?.campo === "senha" ? estado.erro : null}>
              <Input id="apagar-senha" name="senha" type="password" autoComplete="current-password" required aria-invalid={estado?.campo === "senha"} />
            </Field>
          ) : null}
          <Field label={`Para confirmar, digite ${PALAVRA}`} htmlFor="apagar-palavra" error={estado?.campo === "palavra" ? estado.erro : null}>
            <Input
              id="apagar-palavra"
              name="palavra"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={palavra}
              onChange={(e) => setPalavra(e.target.value)}
              placeholder={PALAVRA}
              className="font-mono tracking-[0.12em]"
            />
          </Field>

          <div className="mt-1 grid gap-2 sm:flex sm:flex-row-reverse">
            <Enviar variant="danger" className="sm:flex-1" disabled={!confere} ocupado="Apagando…">
              Apagar conta
            </Enviar>
            <Button variant="secondary" className="sm:flex-1" onClick={() => setAberto(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
