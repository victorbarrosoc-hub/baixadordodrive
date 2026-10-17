"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";

/** Copia pelo navegador; sem a API (http, navegador antigo), seleciona e copia do jeito antigo. */
async function copiarTexto(texto: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = texto;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Uma linha de comando em fonte mono, com botão de copiar. Quebra a linha se não couber: o comando fica todo à vista. */
export function Comando({ comando, rotulo, className }: { comando: string; rotulo: string; className?: string }) {
  const [estado, setEstado] = useState<"" | "copiado" | "falhou">("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copiar = async () => {
    const ok = await copiarTexto(comando);
    setEstado(ok ? "copiado" : "falhou");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setEstado(""), 1800);
  };

  return (
    <div className={cn("flex min-w-0 items-center gap-1 rounded-xl bg-surface-2 py-1 pr-1 pl-3.5 ring-1 ring-line", className)}>
      <code
        aria-label={rotulo}
        className="min-w-0 flex-1 py-1.5 font-mono text-[12.5px] leading-5 text-ink select-all [overflow-wrap:anywhere]"
      >
        {comando}
      </code>
      <button
        type="button"
        onClick={copiar}
        className="toque inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-ink/5 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-down"
      >
        {estado === "copiado" ? <Check className="size-4 text-ok-text" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
        <span>{estado === "copiado" ? "Copiado" : "Copiar"}</span>
        <span className="sr-only">{rotulo}</span>
      </button>
      <span role="status" className="sr-only">
        {estado === "copiado" ? "Comando copiado." : estado === "falhou" ? "Não deu para copiar. Selecione o comando e copie à mão." : ""}
      </span>
    </div>
  );
}
