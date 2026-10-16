import type { Metadata } from "next";
import { Moldura } from "@/components/conta/moldura";
import { exigirUsuario } from "@/lib/auth/atual";
import { buscarPedido, normalizarCodigo } from "@/lib/dispositivo";
import { NOME_PLATAFORMA } from "@/lib/tempo";
import { DigitarCodigo, Liberar, PedidoVencido } from "./liberar";

export const metadata: Metadata = { title: "Conectar computador" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function Dispositivo({ searchParams }: Props) {
  const q = await searchParams;
  const bruto = typeof q.codigo === "string" ? q.codigo : "";
  const codigo = normalizarCodigo(bruto);
  const { usuario } = await exigirUsuario(codigo ? `/dispositivo?codigo=${codigo}` : "/dispositivo");

  if (!codigo) {
    return (
      <Moldura estreita titulo="Conectar um computador" subtitulo="Digite o código que aparece no app SOBEDESCE do computador.">
        <DigitarCodigo invalido={Boolean(bruto)} />
      </Moldura>
    );
  }

  const pedido = await buscarPedido(codigo);
  if (!pedido) {
    return (
      <Moldura estreita titulo="Código vencido" subtitulo="Este código não vale mais. No computador, comece de novo para gerar outro.">
        <PedidoVencido />
      </Moldura>
    );
  }

  return (
    <Moldura estreita titulo="Liberar computador" subtitulo="Ele entra na sua conta e usa os seus Drives.">
      <Liberar
        codigo={pedido.codigo}
        nome={pedido.nome}
        plataforma={pedido.plataforma ? NOME_PLATAFORMA[pedido.plataforma] : null}
        mac={pedido.plataforma === "mac"}
        email={usuario.email}
        jaLiberado={pedido.aprovado}
      />
    </Moldura>
  );
}
