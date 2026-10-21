import type { Metadata } from "next";
import { Aviso } from "@/components/conta/aviso";
import { BotaoGoogle } from "@/components/conta/google";
import { mensagemDeErro } from "@/components/conta/mensagens";
import { Moldura, Secao } from "@/components/conta/moldura";
import { Card } from "@/components/ui/card";
import { exigirUsuario } from "@/lib/auth/atual";
import { listarDispositivos } from "@/lib/auth/sessao";
import { NoComputador } from "@/components/conta/no-computador";
import { InicioConta } from "@/components/conta/inicio";
import { MenuConta } from "@/components/conta/menu";
import { contaComSenha } from "@/lib/auth/contas";
import { linksLigados } from "@/lib/auth/encerrar";
import { ehAdmin } from "@/lib/admin";
import { podeUsar } from "@/lib/recursos";
import { listarComputadores } from "@/lib/acompanhar/status";
import { macsParaAtualizar } from "@/lib/atualizar-mac";
import { DOWNLOAD_MAC } from "@/lib/site";
import { googleDeEntrar, listarContas } from "@/lib/google/contas";
import { NOME_PLATAFORMA, tempoRelativo } from "@/lib/tempo";
import { Computadores } from "./computadores";
import { Drives } from "./drives";
import { FormGoogleDeEntrar, FormNome, FormPrimeiraSenha, FormSenha } from "./forms";
import { ApagarConta } from "./apagar";
import { BotaoSair } from "./sair";

export const metadata: Metadata = { title: "Sua conta" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function Conta({ searchParams }: Props) {
  const { usuario } = await exigirUsuario("/conta");
  const q = await searchParams;
  const [contas, dispositivos, temSenha, admin, referencias, computadores, links, entrar, macs] = await Promise.all([
    listarContas(usuario.id),
    listarDispositivos(usuario.id),
    contaComSenha(usuario.id),
    ehAdmin(usuario),
    podeUsar(usuario, "referencias"),
    listarComputadores(usuario.id),
    linksLigados(usuario.id),
    googleDeEntrar(usuario.id),
    macsParaAtualizar(usuario.id),
  ]);
  const erro = typeof q.erro === "string" ? q.erro : undefined;
  const conectou = q.google === "ok";
  const primeiroNome = usuario.nome.split(" ")[0];
  const drivesOk = contas.filter((c) => c.estado === "ok").length;

  return (
    <Moldura larga titulo={`Olá, ${primeiroNome}`} acao={<MenuConta admin={admin} sair={false} />}>
      {q.aviso === "nao-fui-eu" ? (
        // "Não fui eu" dos e-mails de aviso: o passo a passo para tirar da conta quem não devia estar nela.
        <Aviso tom="erro" className="mb-10">
          <p>
            <strong className="font-semibold">Não foi você? Faça agora, nesta ordem:</strong>
          </p>
          <ol className="grid list-decimal gap-1 pl-5">
            <li>
              {temSenha ? (
                <>
                  <a href="#senha" className="font-medium underline underline-offset-2">
                    Troque a senha
                  </a>
                  . Isso encerra tudo: os outros aparelhos e os computadores saem da conta, e a chave do Atalho e os avisos no celular são desligados.
                </>
              ) : (
                <>
                  <a href="#senha" className="font-medium underline underline-offset-2">
                    Crie uma senha
                  </a>{" "}
                  pelo link que vai para o seu e-mail. Ao salvar, os outros aparelhos e os computadores saem da conta.
                </>
              )}
            </li>
            <li>
              Confira o{" "}
              <a href="#entrar-google" className="font-medium underline underline-offset-2">
                Google de entrar
              </a>{" "}
              e os{" "}
              <a href="#computadores" className="font-medium underline underline-offset-2">
                computadores
              </a>
              .
            </li>
          </ol>
          <p>Se a mesma senha serve em outro site, troque lá também.</p>
        </Aviso>
      ) : conectou ? (
        <Aviso tom="ok" className="mb-10">
          <p>Google Drive conectado.</p>
        </Aviso>
      ) : q.senha === "nova" ? (
        <Aviso tom="ok" className="mb-10">
          <p>Senha nova salva. Os outros aparelhos e os computadores saíram da conta, e a chave do Atalho foi desligada.</p>
          {links ? <p>{links === 1 ? "O link pra IA continua ligado" : `Os ${links} links pra IA continuam ligados`}: se não foi você que ligou, desligue na coleção.</p> : null}
        </Aviso>
      ) : mensagemDeErro(erro) ? (
        <Aviso tom={erro === "google_recusado" ? "info" : "erro"} className="mb-10">
          <p>{mensagemDeErro(erro)}</p>
        </Aviso>
      ) : null}

      {macs.length ? (
        // Até o build 299 o Atualizar do Mac podia travar (lib/atualizar-mac.ts): só o instalador resolve, uma vez.
        <Aviso tom="info" className="mb-6">
          <p>
            <strong className="font-semibold">{macs.length === 1 ? `Atualize o app no ${macs[0]} à mão, uma vez só.` : "Atualize o app nos seus Macs à mão, uma vez só."}</strong> O botão
            Atualizar pode dar erro nessa versão. Baixe, abra o arquivo e arraste o SOBEDESCE para Aplicativos, escolhendo Substituir. Depois, as próximas
            versões chegam sozinhas.
          </p>
          <p>
            <a href={DOWNLOAD_MAC} className="font-medium underline underline-offset-2">
              Baixar para Mac
            </a>
          </p>
        </Aviso>
      ) : null}

      <InicioConta
        drivesOk={drivesOk}
        drivesProblema={contas.length - drivesOk}
        computadores={dispositivos.length}
        andamento={computadores}
        referencias={referencias && drivesOk > 0}
      />

      <h2 className="mb-8 border-t border-line pt-10 font-display text-[26px] font-semibold tracking-[-0.02em] sm:text-[30px]">Ajustes da conta</h2>

      {/* Desktop largo: Drives e computadores na esquerda, dados e senha na direita. No celular, uma coluna como antes. */}
      <div className="mt-12 first:mt-0 xl:grid xl:grid-cols-2 xl:items-start xl:gap-x-[clamp(40px,4vw,96px)]">
        <div>
          <Secao titulo="Google Drive" id="drives" descricao="As contas do Google que a SOBEDESCE usa para enviar e baixar.">
            <Card className="overflow-hidden">
              <Drives contas={contas} entrar={entrar} />
              <div className={contas.length ? "border-t border-line px-5 py-4 sm:px-6" : "px-5 pb-6 sm:px-6"}>
                <BotaoGoogle modo="vincular" variant={contas.length ? "secondary" : "primary"} size="md" className="w-full sm:w-auto">
                  {contas.length ? "Conectar outro Google Drive" : "Conectar Google Drive"}
                </BotaoGoogle>
              </div>
            </Card>
            <p className="mt-3 px-1 text-[13px] leading-relaxed text-pretty text-ink-3">
              Na primeira vez, o Google avisa que ainda não verificou a SOBEDESCE. Toque em Avançado e depois em Acessar SOBEDESCE para continuar.
            </p>
          </Secao>

          {contas.length || entrar ? (
            <Secao
              titulo="Entrar com Google"
              id="entrar-google"
              descricao="Só um Google abre a sua conta. Os outros Drives conectados servem para enviar e baixar, não para entrar."
            >
              <Card className="px-5 py-6 sm:px-6">
                <FormGoogleDeEntrar contas={contas} entrar={entrar} temSenha={temSenha} />
              </Card>
            </Secao>
          ) : null}

          <Secao titulo="Computadores" id="computadores" descricao="O app SOBEDESCE do computador entra na sua conta e usa os mesmos Drives.">
            {dispositivos.length ? null : (
              <Card id="instalar" className="mb-4 scroll-mt-24 overflow-hidden">
                <NoComputador />
              </Card>
            )}
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
        </div>
        <div className="mt-12 xl:mt-0">
          <Secao titulo="Dados da conta" id="dados">
            <Card className="grid gap-6 px-5 py-6 sm:px-6">
              <FormNome nome={usuario.nome} />
              <div className="grid gap-1.5">
                <span className="text-[13px] font-medium text-ink-2">E-mail</span>
                <p className="text-[16px] [overflow-wrap:anywhere]">{usuario.email}</p>
              </div>
            </Card>
          </Secao>

          <Secao titulo="Senha" id="senha" descricao={
              temSenha
                ? "Ao trocar, os outros aparelhos e os computadores saem da conta, e a chave do Atalho e os avisos no celular são desligados."
                : "Você entra com o Google. Se quiser, crie uma senha para entrar também com o e-mail."
            }>
            <Card className="px-5 py-6 sm:px-6">
              {temSenha ? <FormSenha links={links} /> : <FormPrimeiraSenha email={usuario.email} />}
            </Card>
          </Secao>

          <div className="mt-14 flex justify-center">
            <BotaoSair />
          </div>

          <Secao titulo="Apagar a conta" id="apagar" descricao="Some tudo da SOBEDESCE na hora: a conta, os Drives conectados e os computadores. Os arquivos no Google Drive continuam lá.">
            <Card className="px-5 py-5 ring-err/25 sm:px-6">
              <ApagarConta email={usuario.email} temSenha={temSenha} />
            </Card>
          </Secao>
        </div>
      </div>
    </Moldura>
  );
}
