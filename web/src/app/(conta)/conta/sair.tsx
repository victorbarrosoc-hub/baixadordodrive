import { Enviar } from "@/components/conta/enviar";
import { acaoSair } from "../acoes";

export function BotaoSair() {
  return (
    <form action={acaoSair}>
      <Enviar variant="secondary" ocupado="Saindo…">
        Sair da conta
      </Enviar>
    </form>
  );
}
