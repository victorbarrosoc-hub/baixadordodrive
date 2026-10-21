/**
 * "Safari no iPhone", "Chrome no Windows": o navegador e o sistema de um user-agent, resumidos para um aviso.
 * Só o nome dos dois, nunca a versão nem o texto inteiro (que identifica mais do que o aviso precisa).
 * O iPad com iPadOS recente diz que é um Mac: aparece como Mac.
 */

const SISTEMAS: [RegExp, string][] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/iPod/, "iPod"],
  [/Android/, "Android"],
  [/CrOS/, "Chromebook"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "Mac"],
  [/Linux/, "Linux"],
];

const NAVEGADORES: [RegExp, string][] = [
  [/EdgA?\/|EdgiOS\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Instagram/, "Instagram"],
  [/FBAN|FBAV/, "Facebook"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Version\/[\d.]+.*Safari\//, "Safari"],
];

/** O sistema do aparelho pelo User-Agent ("iPhone", "Android", "Mac"), ou null. */
export function sistemaDoAparelho(ua: string | null | undefined): string | null {
  const t = (ua ?? "").slice(0, 512);
  return SISTEMAS.find(([re]) => re.test(t))?.[1] ?? null;
}

export function resumirNavegador(ua: string | null | undefined): string | null {
  const t = (ua ?? "").slice(0, 512);
  if (!t) return null;
  const sistema = SISTEMAS.find(([re]) => re.test(t))?.[1] ?? null;
  const navegador = NAVEGADORES.find(([re]) => re.test(t))?.[1] ?? null;
  if (navegador && sistema) return `${navegador} no ${sistema}`;
  if (navegador) return navegador;
  if (sistema) return `um navegador no ${sistema}`;
  return null;
}
