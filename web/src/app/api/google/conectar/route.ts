import { conectar } from "@/lib/google/rotas";

/** ?modo=vincular|entrar&volta=/conta → 302 para o Google (state + PKCE em cookie de 10 min). */
export function GET(req: Request) {
  return conectar(req);
}
