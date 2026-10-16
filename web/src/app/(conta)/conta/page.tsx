import type { Metadata } from "next";
import { Aviso } from "@/components/conta/aviso";
import { BotaoGoogle } from "@/components/conta/google";
import { mensagemDeErro } from "@/components/conta/mensagens";
import { Moldura, Secao } from "@/components/conta/moldura";
import { Card } from "@/components/ui/card";
import { exigirUsuario } from "@/lib/auth/atual";
import { listarDispositivos } from "@/lib/auth/sessao";
import { listarContas } from "@/lib/google/contas";
import { NOME_PLATAFORMA, tempoRelativo } from "@/lib/tempo";
import { Computadores } from "./computadores";
import { Drives } from "./drives";
import { FormNome, FormSenha } from "./forms";
import { ApagarConta } from "./apagar";
import { BotaoSair } from "./sair";

export const metadata: Metadata = { title: "Sua conta" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function Conta({ searchParams }: Props) {
  const { usuario } = await exigirUsuario("/conta");
  const q = await searchParams;
  const [contas, dispositivos] = await Promise.all([listarContas(usuario.id), listarDispositivos(usuario.id)]);
  const erro = typeof q.erro === "string" ? q.erro : undefined;
  const conectou = q.google === "ok";
  const primeiroNome = usuario.nome.split(" ")[0];

  return (
    <Moldura titulo={`Olá, ${primeiroNome}`} subtitulo="Seus Drives e computadores ficam aqui.">
      {conectou ? (
        <Aviso tom="ok" className="mb-10">
          <p>Google Drive conectado.</p>
        </Aviso>
      ) : q.senha === "nova" ? (
        <Aviso tom="ok" className="mb-10">
          <p>Senha nova salva. Os outros aparelhos saíram da conta.</p>
        </Aviso>
      ) : mensagemDeErro(erro) ? (
        <Aviso tom={erro === "google_recusado" ? "info" : "erro"} className="mb-10">
          <p>{mensagemDeErro(erro)}</p>
        </Aviso>
      ) : null}

      <Secao titulo="Google Drive" id="drives" descricao="As contas do Google que a SOBEDESCE usa para enviar e baixar.">
        <Card className="overflow-hidden">
          <Drives contas={contas} />
          <div className={contas.length ? "border-t border-line px-5 py-4 sm:px-6" : "px-5 pb-6 sm:px-6"}>
            <BotaoGoogle modo="vincular" variant={contas.length ? "secondary" : "primary"} size="md" className="w-full sm:w-auto">
              {contas.length ? "Conectar outro Google Drive" : "Conectar Google Drive"}
            </BotaoGoogle>
          </div>
        </Card>
        <p className="mt-3 px-1 text-[13px] leading-relaxed text-pretty text-ink-3">
          A SOBEDESCE está em teste no Google. Por enquanto, só e-mails liberados pelo Victor conseguem conectar o Drive, e o Google pede para reconectar a cada 7 dias.
        </p>
      </Secao>

      <Secao titulo="Computadores" id="computadores" descricao="O app SOBEDESCE do computador entra na sua conta e usa os mesmos Drives.">
        <Card className="overflow-hidden">
          <Computadores
            itens={dispositivos.map((d) => ({
              id: d.id,
              nome: d.nome ?? "Computador",
              detalhe: [d.plataforma ? NOME_PLATAFORMA[d.plataforma] : null, `usado ${tempoRelativo(d.ultimoUsoEm)}`].filter(Boolean).join(" · "),
              plataforma: d.plataforma,
            }))}
          />
        </Card>
      </Secao>

      <Secao titulo="Dados da conta" id="dados">
        <Card className="grid gap-6 px-5 py-6 sm:px-6">
          <FormNome nome={usuario.nome} />
          <div className="grid gap-1.5">
            <span className="text-[13px] font-medium text-ink-2">E-mail</span>
            <p className="text-[16px] [overflow-wrap:anywhere]">{usuario.email}</p>
          </div>
        </Card>
      </Secao>

      <Secao titulo="Senha" id="senha" descricao="Ao trocar, os outros aparelhos saem da conta.">
        <Card className="px-5 py-6 sm:px-6">
          <FormSenha />
        </Card>
      </Secao>

      <div className="mt-14 flex justify-center">
        <BotaoSair />
      </div>

      <Secao titulo="Apagar a conta" id="apagar" descricao="Some tudo da SOBEDESCE na hora: a conta, os Drives conectados e os computadores. Os arquivos no Google Drive continuam lá.">
        <Card className="px-5 py-5 ring-err/25 sm:px-6">
          <ApagarConta email={usuario.email} />
        </Card>
      </Secao>
    </Moldura>
  );
}
