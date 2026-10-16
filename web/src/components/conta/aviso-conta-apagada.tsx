"use client";

import { CircleCheck } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Na página inicial, depois de apagar a conta (/?conta=apagada): um recado discreto no topo,
 * que some sozinho. Lê o endereço no navegador para a página continuar estática.
 */
export function AvisoContaApagada() {
  const [visivel, setVisivel] = useState(false);
  useEffect(() => {
    const u = new URL(window.location.href);
    if (u.searchParams.get("conta") !== "apagada") return;
    u.searchParams.delete("conta");
    window.history.replaceState(null, "", u.pathname + u.search + u.hash);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- só no navegador, uma vez
    setVisivel(true);
    const t = setTimeout(() => setVisivel(false), 6000);
    return () => clearTimeout(t);
  }, []);
  if (!visivel) return null;
  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+80px)] z-[100] flex justify-center px-4">
      <p className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-primary px-5 py-3 text-[15px] font-medium text-primary-fg shadow-[0_12px_40px_rgba(0,0,0,0.18)]">
        <CircleCheck aria-hidden className="size-[18px]" />
        Conta apagada.
      </p>
    </div>
  );
}
