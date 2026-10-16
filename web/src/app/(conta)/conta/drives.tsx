"use client";

import { Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { Avatar } from "@/components/conta/avatar";
import { BotaoGoogle } from "@/components/conta/google";
import { Button } from "@/components/ui/button";
import type { Conta } from "@/lib/google/contas";
import { acaoRemoverDrive } from "../acoes";

function Estado({ estado }: { estado: Conta["estado"] }) {
  const ok = estado === "ok";
  return (
    <span className={`inline-flex items-center gap-1.5 text-[13px] ${ok ? "text-ink-2" : "font-medium text-warn-text"}`}>
      <span aria-hidden className={`size-1.5 rounded-full ${ok ? "bg-ok" : "bg-warn"}`} />
      {ok ? "Conectado" : "Precisa reconectar"}
    </span>
  );
}

function Linha({ conta }: { conta: Conta }) {
  const [confirmando, setConfirmando] = useState(false);
  const [pendente, iniciar] = useTransition();
  const nome = conta.nome || conta.email;

  return (
    <li className="px-5 py-4 sm:px-6">
      <div className="flex items-center gap-4">
        <Avatar src={conta.fotoUrl} nome={nome} />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="truncate text-[16px] font-medium">{nome}</p>
          {conta.nome ? (
            <p className="truncate text-[14px] text-ink-2" title={conta.email}>
              {conta.email}
            </p>
          ) : null}
          <Estado estado={conta.estado} />
        </div>
        {!confirmando ? (
          <div className="flex shrink-0 items-center gap-1">
            {conta.estado === "reconectar" ? (
              <span className="hidden sm:block">
                <BotaoGoogle modo="vincular" variant="primary" size="sm">
                  Reconectar
                </BotaoGoogle>
              </span>
            ) : null}
            <span className="sm:hidden">
              <Button variant="ghost" size="sm" className="-mr-2 size-9 px-0 text-ink-2" aria-label={`Remover ${conta.email}`} onClick={() => setConfirmando(true)}>
                <Trash2 aria-hidden />
              </Button>
            </span>
            <span className="hidden sm:block">
              <Button variant="ghost" size="sm" className="-mr-2 px-3" onClick={() => setConfirmando(true)}>
                Remover
              </Button>
            </span>
          </div>
        ) : null}
      </div>
      {conta.estado === "reconectar" && !confirmando ? (
        <div className="mt-4 sm:hidden">
          <BotaoGoogle modo="vincular" variant="primary" size="md" className="w-full">
            Reconectar
          </BotaoGoogle>
        </div>
      ) : null}
      {confirmando ? (
        <div className="mt-4 grid gap-3 rounded-2xl bg-surface-2 px-4 py-4 sm:flex sm:items-center sm:justify-between">
          <p className="text-[14px] leading-relaxed text-pretty text-ink-2">Remover {conta.email}? Os arquivos continuam no Drive.</p>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" className="flex-1 sm:flex-none" onClick={() => setConfirmando(false)} disabled={pendente}>
              Cancelar
            </Button>
            <Button variant="danger" size="sm" className="flex-1 sm:flex-none" disabled={pendente} onClick={() => iniciar(async () => void (await acaoRemoverDrive(conta.id)))}>
              {pendente ? "Removendo…" : "Remover"}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function Drives({ contas }: { contas: Conta[] }) {
  if (contas.length === 0) {
    return <p className="px-5 pt-6 pb-5 text-[15px] text-ink-2 sm:px-6">Nenhum Drive conectado ainda.</p>;
  }
  return (
    <ul className="divide-y divide-line">
      {contas.map((c) => (
        <Linha key={c.id} conta={c} />
      ))}
    </ul>
  );
}
