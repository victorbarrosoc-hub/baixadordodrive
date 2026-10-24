/**
 * Formatos de "Baixar como…" (docs/REFERENCIAS.md §7). Quem converte é o app do computador
 * (src/referencias/formatos.js, com o ffmpeg dele); o site só guarda o pedido e confere os nomes.
 */
import type { FormatoReferencia } from "@/lib/db/schema";

export const FORMATOS: FormatoReferencia[] = ["mp4", "mp4-1080", "mp4-720", "mp3-320", "wav", "m4a", "jpg"];

export const ehFormato = (v: unknown): v is FormatoReferencia => typeof v === "string" && (FORMATOS as string[]).includes(v);

/**
 * "Também salvar como" vindo do celular: lista de formatos conhecidos, sem repetir (o "original" é ignorado: ele
 * sempre vai). `undefined`/`null` = nenhum. Devolve null se a entrada não serve.
 */
export function lerFormatos(v: unknown): FormatoReferencia[] | null {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > 8) return null;
  const out: FormatoReferencia[] = [];
  for (const f of v) {
    if (f === "original") continue;
    if (!ehFormato(f)) return null;
    if (!out.includes(f)) out.push(f);
  }
  return out;
}
