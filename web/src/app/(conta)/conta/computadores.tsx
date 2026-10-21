"use client";

import { Laptop, Monitor, X } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { Plataforma } from "@/lib/db/schema";
import { acaoDesconectarComputador } from "../acoes";

type Item = { id: string; nome: string; detalhe: string; plataforma: Plataforma | null };

function Linha({ item }: { item: Item }) {
  const [confirmando, setConfirmando] = useState(false);
  const [pendente, iniciar] = useTransition();
  const Icone = item.plataforma === "mac" ? Laptop : Monitor;
  return (
    <li className="rounded-2xl bg-surface-2 px-4 py-3.5 ring-1 ring-line ring-inset">
      <div className="flex items-center gap-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-ok/14 text-ok-text">
          <Icone aria-hidden className="size-[18px]" />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="text-[16px] font-medium [overflow-wrap:anywhere]">{item.nome}</p>
          <p className="text-[14px] text-ink-2">{item.detalhe}</p>
        </div>
        {!confirmando ? (
          <div className="shrink-0">
            <span className="sm:hidden">
              <Button variant="ghost" size="sm" className="-mr-2 size-9 px-0 text-ink-2" aria-label={`Desconectar ${item.nome}`} onClick={() => setConfirmando(true)}>
                <X aria-hidden />
              </Button>
            </span>
            <span className="hidden sm:block">
              <Button variant="ghost" size="sm" className="-mr-2 px-3" onClick={() => setConfirmando(true)}>
                Desconectar
              </Button>
            </span>
          </div>
        ) : null}
      </div>
      {confirmando ? (
        <div className="mt-3 grid gap-3 rounded-xl bg-surface px-4 py-3.5 ring-1 ring-line sm:flex sm:items-center sm:justify-between">
          <p className="text-[14px] leading-relaxed text-pretty text-ink-2">Desconectar este computador? Ele vai pedir para entrar de novo.</p>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" className="flex-1 sm:flex-none" onClick={() => setConfirmando(false)} disabled={pendente}>
              Cancelar
            </Button>
            <Button variant="danger" size="sm" className="flex-1 sm:flex-none" disabled={pendente} onClick={() => iniciar(async () => void (await acaoDesconectarComputador(item.id)))}>
              {pendente ? "Desconectando…" : "Desconectar"}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function Computadores({ itens }: { itens: Item[] }) {
  if (itens.length === 0) {
    return (
      <p className="rounded-2xl bg-surface-2 px-4 py-4 text-[15px] leading-relaxed text-pretty text-ink-2 ring-1 ring-line ring-inset">
        Nenhum computador conectado. No app SOBEDESCE do computador, toque em Entrar e libere aqui.
      </p>
    );
  }
  return (
    <ul className="grid gap-2">
      {itens.map((i) => (
        <Linha key={i.id} item={i} />
      ))}
    </ul>
  );
}
