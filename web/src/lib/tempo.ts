/** "há 5 minutos", "ontem", "há 3 dias" (pt-BR). */
export function tempoRelativo(data: Date, agora = new Date()): string {
  const s = Math.round((data.getTime() - agora.getTime()) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return "há pouco";
  const f = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
  if (abs < 3600) return f.format(Math.round(s / 60), "minute");
  if (abs < 86400) return f.format(Math.round(s / 3600), "hour");
  if (abs < 30 * 86400) return f.format(Math.round(s / 86400), "day");
  if (abs < 365 * 86400) return f.format(Math.round(s / (30 * 86400)), "month");
  return f.format(Math.round(s / (365 * 86400)), "year");
}

export const NOME_PLATAFORMA = { mac: "Mac", windows: "Windows", linux: "Linux" } as const;
