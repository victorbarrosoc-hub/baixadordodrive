import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// Desenhos das telas do app Atalhos (iOS 18/26, em português), um por passo do /atalho. São ilustrações, não prints:
// o tema é sempre o escuro do iPhone, e o que o usuário precisa tocar vem com o anel azul e a etiqueta "Toque aqui".

const AZUL = "#0a84ff";

/** A moldura do iPhone, com a barra de status e o indicador de início. */
function Celular({ children, legenda }: { children: ReactNode; legenda?: string }) {
  return (
    <figure className="grid justify-items-center gap-3">
      <div className="w-[264px] rounded-[40px] bg-[#1a1a1c] p-[7px] shadow-[0_24px_60px_-28px_rgba(0,0,0,0.55)] ring-1 ring-black/40">
        <div className="relative flex min-h-[470px] flex-col overflow-hidden rounded-[33px] bg-black text-[#f5f5f7] [font-feature-settings:'tnum']">
          <div className="flex h-9 shrink-0 items-center justify-between px-6 text-[12px] font-semibold">
            <span>9:41</span>
            <span className="h-[18px] w-[70px] rounded-full bg-[#1a1a1c]" aria-hidden="true" />
            <span className="flex items-center gap-1" aria-hidden="true">
              <span className="h-2 w-3 rounded-[2px] bg-white/90" />
              <span className="h-2.5 w-5 rounded-[3px] ring-1 ring-white/60" />
            </span>
          </div>
          <div className="flex flex-1 flex-col">{children}</div>
          <span className="mx-auto mb-2 h-1 w-24 shrink-0 rounded-full bg-white/80" aria-hidden="true" />
        </div>
      </div>
      {legenda ? <figcaption className="max-w-[264px] text-center text-[13px] leading-snug text-ink-3">{legenda}</figcaption> : null}
    </figure>
  );
}

/** O que tocar: anel azul em volta e a etiqueta em cima. */
function Toque({ children, rotulo = "Toque aqui", className }: { children: ReactNode; rotulo?: string; className?: string }) {
  return (
    <span className={cn("relative block rounded-[12px] ring-2 ring-[#0a84ff] ring-offset-2 ring-offset-black", className)}>
      {children}
      <span className="absolute -top-2.5 right-2 z-10 rounded-full px-2 py-[1px] text-[10px] font-semibold whitespace-nowrap text-white" style={{ background: AZUL }}>
        {rotulo}
      </span>
    </span>
  );
}

/** Variável azul do Atalhos (ex.: Entrada do Atalho). */
function Variavel({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-[6px] px-1.5 py-[1px] text-[12px] font-medium text-white" style={{ background: AZUL }}>
      <span className="size-2.5 rounded-[3px] bg-white/80" aria-hidden="true" />
      {children}
    </span>
  );
}

/** Um bloco de ação do editor do Atalhos. */
function Acao({ cor, children, className }: { cor: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start gap-2.5 rounded-[12px] bg-[#1c1c1e] px-3 py-2.5 text-[13px] leading-snug", className)}>
      <span className="mt-[1px] size-5 shrink-0 rounded-[6px]" style={{ background: cor }} aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const Azul = ({ children }: { children: ReactNode }) => <span style={{ color: AZUL }}>{children}</span>;

/** Topo do editor: Concluído, nome do atalho e os botões. */
function Editor({ nome = "Salvar na SOBEDESCE", destacarNome = false, children }: { nome?: string; destacarNome?: boolean; children: ReactNode }) {
  const titulo = <span className="block truncate px-1 text-center text-[14px] font-semibold">{nome} ⌄</span>;
  return (
    <>
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-4 pt-1 pb-3 text-[14px]">
        <Azul>Concluído</Azul>
        <span className="min-w-0">{destacarNome ? <Toque rotulo="Toque no nome">{titulo}</Toque> : titulo}</span>
        <span className="flex gap-2.5 text-[15px]" aria-hidden="true">
          <Azul>ⓘ</Azul>
          <Azul>▶︎</Azul>
        </span>
      </div>
      <div className="grid flex-1 content-start gap-2.5 px-3">{children}</div>
    </>
  );
}

function BuscarAcoes({ texto = "Buscar Ações" }: { texto?: string }) {
  return (
    <div className="mx-3 mb-3 flex items-center gap-2 rounded-[12px] bg-[#1c1c1e] px-3 py-2.5 text-[13px] text-white/50">
      <span aria-hidden="true">⌕</span>
      {texto}
    </div>
  );
}

const Receber = () => (
  <Acao cor="#8e8e93">
    Receber <Azul>URLs e Texto</Azul> da <Azul>Folha de Compartilhamento</Azul>
    <span className="mt-1 block text-[11.5px] text-white/50">Se não houver entrada: Continuar</span>
  </Acao>
);

// ───── as telas, na ordem dos passos ─────

/** Passo 1: aba Atalhos, botão + e o nome. */
export function TelaNovo() {
  return (
    <div className="grid justify-items-center gap-6 sm:grid-cols-2">
      <Celular legenda="Na aba Atalhos, toque no + lá em cima.">
        <div className="flex items-center justify-between px-4 pb-2 text-[15px]">
          <Azul>Seleção</Azul>
          <Toque className="-mr-1 px-2" rotulo="Toque no +">
            <span className="text-[22px] leading-none" style={{ color: AZUL }}>
              +
            </span>
          </Toque>
        </div>
        <p className="px-4 pb-3 text-[26px] font-bold tracking-tight">Todos os Atalhos</p>
        <div className="grid grid-cols-2 gap-2.5 px-4">
          {["#ff9f0a", "#30d158", "#bf5af2", "#64d2ff"].map((c, i) => (
            <span key={c} className="h-[84px] rounded-[16px] p-2.5 text-[11px] font-semibold" style={{ background: c }}>
              {["Música", "Rota de casa", "Foto rápida", "Lembrete"][i]}
            </span>
          ))}
        </div>
        <div className="mt-auto flex justify-around border-t border-white/10 pt-2 pb-1 text-[10px] text-white/50">
          <span style={{ color: AZUL }}>Atalhos</span>
          <span>Automação</span>
          <span>Galeria</span>
        </div>
      </Celular>
      <Celular legenda="Toque no nome lá em cima, escolha Renomear e escreva Salvar na SOBEDESCE.">
        <Editor destacarNome>
          <p className="py-6 text-center text-[13px] text-white/50">Atalho vazio</p>
        </Editor>
        <BuscarAcoes />
      </Celular>
    </div>
  );
}

/** Passo 2: Detalhes → Mostrar na Folha de Compartilhamento, e o bloco Receber. */
export function TelaFolha() {
  return (
    <div className="grid justify-items-center gap-6 sm:grid-cols-2">
      <Celular legenda="Toque no ⓘ e ligue Mostrar na Folha de Compartilhamento. Depois, OK.">
        <div className="flex items-center justify-between px-4 pb-3 text-[14px]">
          <span className="w-10" />
          <span className="font-semibold">Detalhes</span>
          <Azul>OK</Azul>
        </div>
        <div className="mx-3 rounded-[12px] bg-[#1c1c1e] text-[13px]">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-3">
            Fixar na Barra de Menus <Chave />
          </div>
          <Toque rotulo="Ligue" className="rounded-[10px]">
            <div className="flex items-center justify-between px-3 py-3">
              Mostrar na Folha de Compartilhamento <Chave on />
            </div>
          </Toque>
          <div className="flex items-center justify-between border-t border-white/10 px-3 py-3">
            Mostrar no Apple Watch <Chave />
          </div>
        </div>
      </Celular>
      <Celular legenda="Apareceu o bloco Receber. Toque no tipo de entrada e deixe só URLs e Texto.">
        <Editor>
          <Toque rotulo="Só URLs e Texto">
            <Receber />
          </Toque>
        </Editor>
        <BuscarAcoes />
      </Celular>
    </div>
  );
}

function Chave({ on = false }: { on?: boolean }) {
  return (
    <span className={cn("relative h-[22px] w-[38px] shrink-0 rounded-full", on ? "bg-[#30d158]" : "bg-white/20")} aria-hidden="true">
      <span className={cn("absolute top-[2px] size-[18px] rounded-full bg-white", on ? "right-[2px]" : "left-[2px]")} />
    </span>
  );
}

/** Passo 3: buscar a ação e colar o endereço. */
export function TelaAcao({ endpoint }: { endpoint: string }) {
  return (
    <div className="grid justify-items-center">
      <Celular legenda="Busque Obter Conteúdo de URL, toque na ação e, no lugar do link azul, cole o endereço.">
        <Editor>
          <Receber />
          <Toque rotulo="Cole o endereço aqui">
            <Acao cor="#30d158">
              Obter conteúdo de <span className="break-all" style={{ color: AZUL }}>{endpoint}</span>
              <span className="mt-1 block text-[11.5px]" style={{ color: AZUL }}>
                Mostrar Mais ›
              </span>
            </Acao>
          </Toque>
        </Editor>
        <BuscarAcoes texto="Obter Conteúdo de URL" />
      </Celular>
    </div>
  );
}

/** Passo 4: Mostrar Mais → POST, cabeçalho e corpo JSON. */
export function TelaPost({ cabecalho, colecao = "Nome da coleção" }: { cabecalho: string; colecao?: string }) {
  const linha = "flex items-center justify-between gap-2 border-t border-white/10 px-3 py-2.5";
  return (
    <div className="grid justify-items-center gap-6 sm:grid-cols-2">
      <Celular legenda="Em Mostrar Mais: Método POST e um cabeçalho Authorization com a sua chave.">
        <Editor>
          <div className="rounded-[12px] bg-[#1c1c1e] text-[13px]">
            <div className="flex gap-2.5 px-3 py-2.5">
              <span className="mt-[1px] size-5 shrink-0 rounded-[6px] bg-[#30d158]" aria-hidden="true" />
              <span>
                Obter conteúdo de <Azul>sobedesce.com/…</Azul>
              </span>
            </div>
            <Toque rotulo="POST" className="rounded-[10px]">
              <div className={linha}>
                Método <Azul>POST ›</Azul>
              </div>
            </Toque>
            <div className={linha}>
              <span>Cabeçalhos</span>
              <span className="text-white/50">1 item</span>
            </div>
            <Toque rotulo="Sua chave" className="rounded-[10px]">
              <div className="grid grid-cols-[auto_1fr] gap-2 border-t border-white/10 px-3 py-2.5 text-[12px]">
                <span className="text-white/60">Authorization</span>
                <span className="truncate text-right">{cabecalho}</span>
              </div>
            </Toque>
            <div className={cn(linha, "text-[12px]")} style={{ color: AZUL }}>
              + Adicionar novo cabeçalho
            </div>
          </div>
        </Editor>
      </Celular>
      <Celular legenda="Corpo JSON com dois campos de Texto: url (a variável Entrada do Atalho) e colecao.">
        <Editor>
          <div className="rounded-[12px] bg-[#1c1c1e] text-[13px]">
            <div className="flex items-center justify-between px-3 py-2.5">
              Corpo da Solicitação <Azul>JSON ›</Azul>
            </div>
            <Toque rotulo="Variável" className="rounded-[10px]">
              <div className="grid grid-cols-[auto_1fr] items-center gap-2 border-t border-white/10 px-3 py-2.5 text-[12px]">
                <span>
                  <span className="text-white/50">Texto</span> url
                </span>
                <span className="text-right">
                  <Variavel>Entrada do Atalho</Variavel>
                </span>
              </div>
            </Toque>
            <div className="grid grid-cols-[auto_1fr] items-center gap-2 border-t border-white/10 px-3 py-2.5 text-[12px]">
              <span>
                <span className="text-white/50">Texto</span> colecao
              </span>
              <span className="text-right">{colecao}</span>
            </div>
            <div className={cn(linha, "text-[12px]")} style={{ color: AZUL }}>
              + Adicionar novo campo
            </div>
          </div>
          <p className="px-1 text-[11.5px] leading-snug text-white/50">
            Para pôr a variável: toque no campo do valor e escolha Entrada do Atalho na barra acima do teclado.
          </p>
        </Editor>
      </Celular>
    </div>
  );
}

/** Passo 6: a Folha de Compartilhamento do Instagram, com o atalho na lista. */
export function TelaUsar() {
  const item = "flex items-center gap-3 border-b border-white/10 px-3 py-2.5 text-[13px]";
  return (
    <div className="grid justify-items-center">
      <Celular legenda="No Instagram: Compartilhar e role até a lista. Não achou? Editar Ações e ligue o atalho.">
        <div className="mx-3 mb-2 flex items-center gap-3 rounded-[14px] bg-[#1c1c1e] p-2.5">
          <span className="size-10 rounded-[10px] bg-white" aria-hidden="true" />
          <span className="text-[13px] leading-tight">
            <b className="font-semibold">Reel de alguém</b>
            <span className="block text-white/50">instagram.com</span>
          </span>
        </div>
        <div className="flex justify-around px-3 py-2 text-[10px] text-white/80">
          {["Copiar", "Nota Rápida", "Abrir no Safari"].map((t) => (
            <span key={t} className="grid justify-items-center gap-1">
              <span className="size-10 rounded-full bg-[#2c2c2e]" aria-hidden="true" />
              {t}
            </span>
          ))}
        </div>
        <div className="mx-3 mt-1 rounded-[14px] bg-[#2c2c2e]">
          <Toque rotulo="Toque aqui" className="rounded-[10px]">
            <div className={cn(item, "font-semibold")}>
              <span className="size-5 rounded-[6px] bg-[#30d158]" aria-hidden="true" />
              Salvar na SOBEDESCE
            </div>
          </Toque>
          <div className={item}>
            <span className="size-5 rounded-full bg-white/30" aria-hidden="true" />
            Pesquisar no Google
          </div>
          <div className={cn(item, "border-b-0")}>
            <span className="size-5 rounded-full bg-white/30" aria-hidden="true" />
            Adicionar à Lista de Leitura
          </div>
        </div>
        <span className="mx-auto mt-3 rounded-full bg-[#2c2c2e] px-4 py-1.5 text-[12px]">Editar Ações</span>
      </Celular>
    </div>
  );
}
