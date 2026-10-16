import { callback } from "@/lib/google/rotas";

/** Volta do Google → 303 para `volta` com ?google=ok ou ?erro=<codigo>. */
export function GET(req: Request) {
  return callback(req);
}
