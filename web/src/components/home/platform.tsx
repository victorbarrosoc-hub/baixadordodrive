"use client";

import { useEffect, useRef } from "react";

/**
 * Marca o sistema do visitante no elemento pai (data-plat = mac | windows | ios | android | outro),
 * para o CSS destacar o botão de download certo. O script inline roda antes da primeira pintura
 * (sem piscar e sem mudar o layout); o efeito cobre a navegação pelo próprio site.
 * O pai precisa de suppressHydrationWarning, porque o atributo muda antes da hidratação.
 */

const DETECT = `var n=navigator,u=n.userAgent||"",pl=(n.userAgentData&&n.userAgentData.platform)||n.platform||"",p="outro";
if(/iPhone|iPad|iPod/.test(u)||(/Mac/.test(pl)&&n.maxTouchPoints>1))p="ios";
else if(/Android/i.test(u))p="android";
else if(/Mac/i.test(pl)||/Mac OS X/.test(u))p="mac";
else if(/Win/i.test(pl)||/Windows/.test(u))p="windows";`;

const INLINE = `(function(){try{var el=document.currentScript&&document.currentScript.parentElement;if(!el)return;${DETECT}el.setAttribute("data-plat",p)}catch(e){}})()`;

function detect(): string {
  const n = navigator as Navigator & { userAgentData?: { platform?: string } };
  const u = n.userAgent || "";
  const pl = n.userAgentData?.platform || n.platform || "";
  if (/iPhone|iPad|iPod/.test(u) || (/Mac/.test(pl) && n.maxTouchPoints > 1)) return "ios";
  if (/Android/i.test(u)) return "android";
  if (/Mac/i.test(pl) || /Mac OS X/.test(u)) return "mac";
  if (/Win/i.test(pl) || /Windows/.test(u)) return "windows";
  return "outro";
}

export function PlatformScript() {
  const ref = useRef<HTMLScriptElement>(null);
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (el && el.getAttribute("data-plat") === "outro") {
      const p = detect();
      if (p !== "outro") el.setAttribute("data-plat", p);
    }
  }, []);
  return (
    <script
      ref={ref}
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: INLINE }}
    />
  );
}
