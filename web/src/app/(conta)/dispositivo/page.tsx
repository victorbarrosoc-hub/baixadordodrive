import type { Metadata } from "next";
import { Laptop } from "lucide-react";
import { Moldura } from "@/components/conta/moldura";
import { exigirUsuario, ipAtual } from "@/lib/auth/atual";
import { buscarPedido, lugarLegivel, mesmaRede, normalizarCodigo } from "@/lib/dispositivo";
import { NOME_PLATAFORMA, tempoRelativo } from "@/lib/tempo";
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
      <Moldura estreita icone={<Laptop />} titulo="Conectar um computador" subtitulo="Digite o código que aparece no app SOBEDESCE do computador.">
        <DigitarCodigo invalido={Boolean(bruto)} />
      </Moldura>
    );
  }

  const pedido = await buscarPedido(codigo);
  if (!pedido) {
    return (
      <Moldura estreita icone={<Laptop />} titulo="Código vencido" subtitulo="Este código não vale mais. No computador, comece de novo para gerar outro.">
        <PedidoVencido />
      </Moldura>
    );
  }

  const agora = new Date();
  const hora = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Fortaleza" }).format(pedido.criadoEm);
  const ip = await ipAtual();
  return (
    <Moldura estreita icone={<Laptop />} titulo="Liberar computador" subtitulo="Ele entra na sua conta e usa os seus Drives.">
      <Liberar
        pedidoEm={`${tempoRelativo(pedido.criadoEm, agora)}, às ${hora} (horário de Brasília)`}
        lugar={lugarLegivel(pedido.lugar)}
        ip={pedido.lugar.ip}
        mesmaRede={mesmaRede(pedido.lugar.ip, ip)}
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
