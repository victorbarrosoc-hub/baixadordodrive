"use client";

import { useSyncExternalStore } from "react";
import { Comando } from "@/components/comando";
import { TelaAcao, TelaFolha, TelaNovo, TelaPost, TelaUsar } from "./telas";

const FORMATO = /^sda_[A-Za-z0-9_-]{43}$/;

function lerChave(): string {
  const m = /(?:^|[#&])chave=([^&]+)/.exec(window.location.hash);
  const v = m ? decodeURIComponent(m[1]) : "";
  return FORMATO.test(v) ? v : "";
}

function assinar(fn: () => void) {
  window.addEventListener("hashchange", fn);
  return () => window.removeEventListener("hashchange", fn);
}

/** Um passo no padrão do kit (components/kit): cartão com o número em gradiente, entrando em cascata. */
function Passo({ n, titulo, children }: { n: number; titulo: string; children?: React.ReactNode }) {
  return (
    <li className="k-entra grid grid-cols-[30px_1fr] gap-x-3.5 gap-y-2 rounded-[20px] bg-surface p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] ring-1 ring-line sm:p-6" style={{ "--i": n } as React.CSSProperties}>
      <span className="k-grad grid size-[30px] place-items-center rounded-[10px] text-[13px] font-bold text-white tabular-nums shadow-[0_6px_16px_-6px_color-mix(in_srgb,var(--color-down)_70%,transparent)]">{n}</span>
      <div className="grid min-w-0 gap-2.5 pt-0.5">
        <p className="text-[17px] leading-snug font-semibold tracking-[-0.01em] text-ink">{titulo}</p>
        {children ? <div className="grid gap-2.5 text-[15px] leading-relaxed text-pretty text-ink-2">{children}</div> : null}
      </div>
    </li>
  );
}

/** Os passos, com a chave (do fragmento da URL) e o endereço prontos para copiar. */
export function Instrucoes({ endpoint }: { endpoint: string }) {
  const chave = useSyncExternalStore(assinar, lerChave, () => "");
  const cabecalho = `Atalho ${chave || "<sua chave>"}`;
  return (
    <div className="grid gap-10">
      {chave ? (
        <div className="relative isolate grid gap-2.5 overflow-hidden rounded-[20px] bg-[radial-gradient(120%_90%_at_100%_0%,rgba(255,255,255,0.18),transparent_55%),linear-gradient(135deg,var(--color-down),var(--color-up))] p-5 text-white shadow-[0_16px_34px_-18px_var(--color-up)] sm:p-6">
          <p className="text-[12px] font-semibold tracking-[0.1em] uppercase opacity-85">Sua chave do Atalho</p>
          <Comando comando={chave} rotulo="Chave do Atalho" />
          <p className="text-[13px] leading-relaxed opacity-90">
            Ela só põe links na sua fila: não abre a conta nem lê nada. Não compartilhe. Gerou outra no app? Esta para de valer.
          </p>
        </div>
      ) : (
        <div className="rounded-[20px] bg-surface p-5 text-[15px] leading-relaxed text-ink-2 ring-1 ring-line sm:p-6">
          Primeiro gere a sua chave no app SOBEDESCE: aba <b className="font-semibold text-ink">Referências</b>, cartão{" "}
          <b className="font-semibold text-ink">Salvar direto do Instagram</b>. O botão traz você de volta para cá com a chave pronta.{" "}
          <a href="/app/#referencias" className="font-medium text-down-text underline-offset-2 hover:underline">
            Abrir o app
          </a>
        </div>
      )}

      <p className="-mb-4 text-[13px] leading-relaxed text-ink-3">
        As telas abaixo são desenhos do app Atalhos para guiar cada passo. Dependendo da versão do iOS, um nome ou outro pode mudar um pouco.
      </p>
      <ol className="grid gap-4">
        <Passo n={1} titulo="Abra o app Atalhos e toque em +">
          <p>Dê o nome “Salvar na SOBEDESCE”.</p>
          <TelaNovo />
        </Passo>
        <Passo n={2} titulo="Ligue a Folha de Compartilhamento">
          <p>
            Toque no ícone <b className="text-ink">ⓘ</b> e ative <b className="text-ink">Mostrar na Folha de Compartilhamento</b>. No primeiro bloco, deixe
            “Receber <b className="text-ink">URLs</b> e <b className="text-ink">Texto</b> da Folha de Compartilhamento”.
          </p>
          <TelaFolha />
        </Passo>
        <Passo n={3} titulo="Adicione a ação “Obter Conteúdo de URL”">
          <p>No lugar da URL, cole este endereço:</p>
          <Comando comando={endpoint} rotulo="Endereço do Atalho" />
          <TelaAcao endpoint={endpoint} />
        </Passo>
        <Passo n={4} titulo="Toque em “Mostrar Mais” e preencha">
          <ul className="grid list-disc gap-1.5 pl-5 marker:text-ink-3">
            <li>
              Método: <b className="text-ink">POST</b>
            </li>
            <li>
              Cabeçalhos: adicione <b className="text-ink">Authorization</b> com o valor abaixo
            </li>
          </ul>
          <Comando comando={cabecalho} rotulo="Valor do cabeçalho Authorization" />
          <ul className="grid list-disc gap-1.5 pl-5 marker:text-ink-3">
            <li>
              Corpo da Solicitação: <b className="text-ink">JSON</b>
            </li>
            <li>
              Campo de texto <b className="text-ink">url</b> com a variável <b className="text-ink">Entrada do Atalho</b>
            </li>
            <li>
              Campo de texto <b className="text-ink">colecao</b> com o nome de uma coleção (sem ele, vai para a mais recente)
            </li>
          </ul>
          <p className="text-[14px] text-ink-3">Quer escolher a coleção na hora? No campo colecao, use a variável de uma ação “Pedir Entrada” antes.</p>
          <TelaPost cabecalho={chave ? `Atalho ${chave.slice(0, 10)}…` : "Atalho <sua chave>"} />
        </Passo>
        <Passo n={5} titulo="Opcional: um aviso de que deu certo">
          <p>
            Adicione “Obter Valor do Dicionário” com a chave <b className="text-ink">mensagem</b> e depois “Mostrar Notificação”. Aparece “Salvo em Clipes. O
            computador baixa.”
          </p>
        </Passo>
        <Passo n={6} titulo="Use">
          <p>
            No Instagram, no YouTube ou no TikTok, toque em <b className="text-ink">Compartilhar</b> e escolha <b className="text-ink">Salvar na SOBEDESCE</b>{" "}
            (às vezes ele fica em “Mais” ou em “Compartilhar em…”). O link entra na fila; o app do computador, aberto, baixa e guarda na pasta da coleção.
          </p>
          <p>
            Não apareceu na lista? Role até o fim da Folha de Compartilhamento, toque em <b className="text-ink">Editar Ações</b> e ligue{" "}
            <b className="text-ink">Salvar na SOBEDESCE</b>.
          </p>
          <TelaUsar />
        </Passo>
      </ol>

      <p className="border-t border-line pt-6 text-[14px] leading-relaxed text-ink-3">
        Salve só para referência dos seus projetos. Respeite os direitos de quem criou. Para desligar o Atalho, gere outra chave ou toque em Desligar no
        app.
      </p>
    </div>
  );
}
