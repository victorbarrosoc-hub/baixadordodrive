"use client";

import { useSyncExternalStore } from "react";
import { Share } from "lucide-react";

/** Safari de verdade no iPhone/iPad, fora da Tela de Início (Chrome e afins do iOS não têm o mesmo caminho). */
function noSafariDoIphone(): boolean {
  const ua = navigator.userAgent;
  const ios = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const safari = /Safari\//.test(ua) && !/(CriOS|FxiOS|EdgiOS|OPiOS|GSA|DuckDuckGo)\//.test(ua);
  const instalado = (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;
  return ios && safari && !instalado;
}

const nada = () => () => {};

/** "Use como app": só no Safari do iPhone, enquanto o SOBEDESCE ainda não está na Tela de Início. */
export function DicaInstalar() {
  const mostrar = useSyncExternalStore(nada, noSafariDoIphone, () => false);
  if (!mostrar) return null;
  return (
    <p className="flex items-start gap-2.5 rounded-xl bg-up/8 p-3 text-[13px] leading-relaxed text-ink-2">
      <Share className="mt-0.5 size-4 shrink-0 text-up-text" aria-hidden="true" />
      <span>
        <b className="font-semibold text-ink">Use como app.</b> Toque em <b className="font-semibold text-ink">Compartilhar</b> e depois em{" "}
        <b className="font-semibold text-ink">Adicionar à Tela de Início</b>. Ele abre em tela cheia e guarda o próprio login.
      </span>
    </p>
  );
}
