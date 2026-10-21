import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Activity,
  Bell,
  Download,
  Filter,
  Gauge,
  Laptop,
  Search,
  Smartphone,
  Users,
} from "lucide-react";
import { Avatar } from "@/components/conta/avatar";
import { MenuConta } from "@/components/conta/menu";
import { Moldura } from "@/components/conta/moldura";
import { Passo } from "@/components/kit/kit";
import {
  Funil,
  Grafico30,
  Numero,
  Selo,
  Tira,
  UltimoUso,
  bytesLegivel,
  nArquivos,
  totalBytes,
  velocidadeLegivel,
} from "@/components/admin/partes";
import {
  aplicarFiltro,
  desatualizado,
  ehAdmin,
  ehFiltro,
  ehOrdem,
  filtrarPessoas,
  FILTROS,
  ORDENS,
  painelAdmin,
  velocidadeMedia,
  buildPublicado,
  type Filtro,
  type Ordem,
  type PessoaUso,
} from "@/lib/admin";
import { betaAberto, ehPlano, NOME_PLANO, PLANOS } from "@/lib/recursos";
import { acaoTrocarPlano } from "../acoes";
import { contasComMacTravado } from "@/lib/atualizar-mac";
import { exigirUsuario } from "@/lib/auth/atual";
import { cn } from "@/lib/cn";
import type { Plano as TipoPlano } from "@/lib/db/schema";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const dataCurta = new Intl.DateTimeFormat("pt-BR", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "America/Fortaleza",
});

/** Plano da conta (para quando o beta fechar). Um formulário simples: funciona sem JavaScript. */
function Plano({ p }: { p: PessoaUso }) {
  return (
    <form action={acaoTrocarPlano} className="flex items-center gap-1.5">
      <input type="hidden" name="usuarioId" value={p.id} />
      <label className="sr-only" htmlFor={`plano-${p.id}`}>
        Plano de {p.nome}
      </label>
      <select
        id={`plano-${p.id}`}
        name="plano"
        defaultValue={p.plano}
        className="h-11 rounded-full bg-surface-2 pr-2 pl-3 sm:h-8 text-[13px] font-medium ring-1 ring-line outline-none focus:ring-2 focus:ring-up"
      >
        {PLANOS.map((pl) => (
          <option key={pl} value={pl}>
            {NOME_PLANO[pl]}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="toque h-11 rounded-full px-3 sm:h-8 text-[13px] font-medium text-ink-2 ring-1 ring-line hover:bg-surface-2 hover:text-ink"
      >
        Salvar
      </button>
    </form>
  );
}

function Pessoa({
  p,
  agora,
  buildAtual,
}: {
  p: PessoaUso;
  agora: Date;
  buildAtual: number | null;
}) {
  const foto = p.drives.find((d) => d.fotoUrl)?.fotoUrl ?? null;
  const reconectar = p.drives.filter((d) => d.estado !== "ok").length;
  const velhos = p.listaComputadores.filter((c) =>
    desatualizado(c, buildAtual),
  ).length;
  const volume = totalBytes(p.uso30);
  return (
    <li className="px-5 py-4 sm:px-6 xl:border-b xl:border-line xl:odd:border-r">
      <div className="flex items-start gap-4">
        <Avatar src={foto} nome={p.nome} />
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <Link
              href={`/admin/pessoa/${encodeURIComponent(p.id)}`}
              className="truncate text-[16px] font-medium hover:underline"
            >
              {p.nome}
            </Link>
            <p className="shrink-0 text-[13px] text-ink-3">
              <UltimoUso p={p} agora={agora} />
            </p>
          </div>
          <p className="truncate text-[14px] text-ink-2" title={p.email}>
            {p.email}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-ink-3">
            <Tira dias={p.tira30} />
            <span>{p.diasAtivos30} dias ativos no mês</span>
            {volume ? (
              <span>
                {bytesLegivel(volume)} em{" "}
                {nArquivos(p.uso30.enviados + p.uso30.baixados)}
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {p.drives.length ? (
              <Selo tom={reconectar ? "alerta" : "neutro"}>
                {reconectar
                  ? `${reconectar} Drive para reconectar`
                  : `${p.drives.length} Drive${p.drives.length > 1 ? "s" : ""}`}
              </Selo>
            ) : (
              <Selo tom="alerta">Sem Drive</Selo>
            )}
            {p.listaComputadores.length ? (
              <Selo tom={velhos ? "alerta" : "neutro"}>
                <Laptop className="size-3" aria-hidden="true" />
                {p.listaComputadores.length}
                {velhos
                  ? ` · ${velhos} desatualizado${velhos > 1 ? "s" : ""}`
                  : ""}
              </Selo>
            ) : null}
            {p.usou.celular ? (
              <Selo>
                <Smartphone className="size-3" aria-hidden="true" />
                celular
              </Selo>
            ) : null}
            {p.avisosCelular ? (
              <Selo>
                <Bell className="size-3" aria-hidden="true" />
                avisos
              </Selo>
            ) : null}
            {p.uso30.erros ? (
              <Selo tom="alerta">{p.uso30.erros} erros no mês</Selo>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <p className="text-[13px] text-ink-3">
              Desde {dataCurta.format(p.criadoEm)} ·{" "}
              {p.comSenha ? "e-mail e senha" : "Google"}
            </p>
            <Plano p={p} />
          </div>
        </div>
      </div>
    </li>
  );
}

function linkCom(
  base: Record<string, string>,
  muda: Record<string, string | null>,
) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...base, ...muda })) if (v) q.set(k, v);
  const t = q.toString();
  return t ? `/admin?${t}` : "/admin";
}

function Chip({
  href,
  ativo,
  children,
}: {
  href: string;
  ativo: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={ativo ? "true" : undefined}
      className={cn(
        "toque inline-flex h-[30px] items-center rounded-full px-3.5 text-[13px] font-semibold whitespace-nowrap transition-[background-color,color,transform] duration-150",
        ativo
          ? "scale-[1.04] bg-down text-white"
          : "bg-ink/[0.06] text-ink-2 hover:text-ink",
      )}
    >
      {children}
    </Link>
  );
}

export default async function Admin({ searchParams }: Props) {
  const { usuario } = await exigirUsuario("/admin");
  // Quem não é admin vê a mesma página de "não encontrado" de qualquer endereço que não existe.
  if (!(await ehAdmin(usuario))) notFound();
  const q = await searchParams;
  const um = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : "");
  const busca = um("q").slice(0, 100);
  const filtro: Filtro = ehFiltro(um("f")) ? (um("f") as Filtro) : "todos";
  const ordem: Ordem = ehOrdem(um("o")) ? (um("o") as Ordem) : "novas";
  const plano: TipoPlano | null = ehPlano(um("plano"))
    ? (um("plano") as TipoPlano)
    : null;
  const agora = new Date();
  const buildAtual = await buildPublicado();
  const [{ pessoas, resumo }, macsTravados] = await Promise.all([
    painelAdmin(agora, buildAtual),
    contasComMacTravado(),
  ]);
  const macsSemAviso = macsTravados.filter((c) => !c.avisada).length;
  const lista = aplicarFiltro(
    filtrarPessoas(pessoas, busca),
    { filtro, plano, ordem, buildAtual },
    agora,
  );
  const estado: Record<string, string> = {
    q: busca,
    f: filtro === "todos" ? "" : filtro,
    o: ordem === "novas" ? "" : ordem,
    plano: plano ?? "",
  };
  const csv = `/admin/csv?${new URLSearchParams(Object.entries(estado).filter(([, v]) => v)).toString()}`;
  const u7 = resumo.uso7;

  return (
    <Moldura
      larga
      titulo="Quem está na plataforma"
      subtitulo="Contas, uso por dia, aparelhos e o que precisa de atenção. Só números: nada do que as pessoas transferem."
      acao={<MenuConta admin />}
    >
      <p className="mb-4 flex flex-wrap items-center gap-2 px-1 text-[14px] text-ink-2">
        {betaAberto() ? (
          <span className="inline-flex items-center gap-2 rounded-full bg-ok/12 px-3 py-1 font-medium text-ok-text ring-1 ring-ok/30">
            <span aria-hidden className="size-1.5 rounded-full bg-ok" />
            Beta aberto: todos usam tudo
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 rounded-full bg-warn/12 px-3 py-1 font-medium text-warn-text ring-1 ring-warn/30">
            <span aria-hidden className="size-1.5 rounded-full bg-warn" />
            Beta fechado: vale o plano de cada conta
          </span>
        )}
        <span className="text-[13px] text-ink-3">
          O plano de cada conta fica guardado para quando o beta fechar
          (SOBEDESCE_BETA_ABERTO=0).
        </span>
      </p>

      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-8">
        <Numero i={1} valor={resumo.onlineAgora} rotulo="online agora" />
        <Numero i={2} valor={resumo.ativosHoje} rotulo="ativas hoje" />
        <Numero
          i={3}
          valor={resumo.ativos7d}
          rotulo="ativas em 7 dias"
          detalhe={`${resumo.ativos30d} em 30 dias`}
        />
        <Numero
          i={4}
          valor={resumo.contas}
          rotulo="contas"
          detalhe={
            resumo.novas7d ? `${resumo.novas7d} novas em 7 dias` : undefined
          }
        />
        <Numero i={5} valor={resumo.parados} rotulo="paradas há 14+ dias" />
        <Numero
          i={6}
          valor={resumo.drivesOk}
          rotulo="Drives conectados"
          detalhe={
            resumo.drivesReconectar
              ? `${resumo.drivesReconectar} para reconectar`
              : undefined
          }
          alerta={!!resumo.drivesReconectar}
        />
        <Numero
          i={7}
          valor={resumo.computadores}
          rotulo="computadores"
          detalhe={
            resumo.buildAtual
              ? resumo.desatualizados
                ? `${resumo.desatualizados} sem o build ${resumo.buildAtual}`
                : `todos no build ${resumo.buildAtual}`
              : undefined
          }
          alerta={!!resumo.desatualizados}
        />
        <Numero
          i={8}
          valor={resumo.avisosCelular}
          rotulo="com avisos no celular"
        />
      </div>

      {macsTravados.length ? (
        <Link
          href="/admin/aviso-mac"
          className="toque mb-4 flex items-center justify-between gap-4 rounded-2xl bg-warn/12 px-5 py-4 text-[15px] ring-1 ring-warn/30 hover:bg-warn/18"
        >
          <span className="grid gap-0.5">
            <span className="font-medium">
              {macsTravados.length === 1
                ? "1 conta tem Mac"
                : `${macsTravados.length} contas têm Mac`}{" "}
              com o Atualizar travado (antes do build 300)
            </span>
            <span className="text-[13px] text-ink-2">
              {macsSemAviso
                ? `${macsSemAviso} ainda sem o e-mail. Ver o e-mail e mandar.`
                : "Todas já receberam o e-mail."}
            </span>
          </span>
          <Bell className="size-5 shrink-0 text-warn-text" aria-hidden />
        </Link>
      ) : null}

      {/* Desktop largo: gráfico e uso na esquerda, funil na direita. No celular, um embaixo do outro. */}
      <div className="mb-10 grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:items-start">
        <div className="grid min-w-0 gap-4">
          <Passo
            icone={<Activity />}
            tom="up"
            i={2}
            titulo="Pessoas ativas por dia"
            frase="Os últimos 30 dias. Passe o mouse numa barra para ver o volume."
          >
            <Grafico30 serie={resumo.serie} />
          </Passo>

          <Passo
            icone={<Gauge />}
            tom="down"
            i={3}
            titulo="Uso pelo computador"
          >
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              <Numero
                valor={bytesLegivel(u7.enviadosBytes)}
                rotulo="subiram em 7 dias"
                detalhe={nArquivos(u7.enviados)}
              />
              <Numero
                valor={bytesLegivel(u7.baixadosBytes)}
                rotulo="desceram em 7 dias"
                detalhe={nArquivos(u7.baixados)}
              />
              <Numero
                valor={u7.erros}
                rotulo="erros em 7 dias"
                alerta={u7.erros > 0}
                detalhe={u7.erros ? "transferências que falharam" : undefined}
              />
              <Numero
                valor={velocidadeLegivel(velocidadeMedia(u7))}
                rotulo="velocidade média"
                detalhe={
                  u7.maiorArquivo
                    ? `maior arquivo: ${bytesLegivel(u7.maiorArquivo)}`
                    : undefined
                }
              />
              <Numero
                valor={bytesLegivel(totalBytes(resumo.usoTotal))}
                rotulo="transferido no total"
                detalhe={nArquivos(
                  resumo.usoTotal.enviados + resumo.usoTotal.baixados,
                )}
              />
              <Numero
                valor={resumo.colecoes}
                rotulo="coleções de referências"
                detalhe={`${resumo.referencias} links salvos`}
              />
            </div>
            <p className="text-[12px] text-ink-3">
              Volume, erros e velocidade contam a partir desta versão do app de
              computador.
            </p>
          </Passo>
        </div>

        <div className="grid gap-4">
          <Passo
            icone={<Filter />}
            tom="ok"
            i={3}
            titulo="Do cadastro ao uso"
            frase="Quantas contas chegaram em cada passo."
          >
            <Funil
              etapas={[
                { rotulo: "Criou a conta", n: resumo.funil.contas },
                { rotulo: "Conectou um Drive", n: resumo.funil.comDrive },
                {
                  rotulo: "Conectou um computador",
                  n: resumo.funil.comComputador,
                },
                {
                  rotulo: "Transferiu pelo computador",
                  n: resumo.funil.transferiu,
                },
              ]}
            />
          </Passo>
        </div>
      </div>

      <form method="get" role="search" className="mb-3 flex items-center gap-2">
        {estado.f ? <input type="hidden" name="f" value={estado.f} /> : null}
        {estado.o ? <input type="hidden" name="o" value={estado.o} /> : null}
        {estado.plano ? (
          <input type="hidden" name="plano" value={estado.plano} />
        ) : null}
        <label className="relative flex-1">
          <span className="sr-only">Buscar por nome ou e-mail</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3"
            aria-hidden="true"
          />
          <input
            type="search"
            name="q"
            defaultValue={busca}
            placeholder="Buscar por nome ou e-mail"
            className="h-11 w-full rounded-full bg-surface-2 pr-4 pl-10 text-[15px] ring-1 ring-line outline-none placeholder:text-ink-3 focus:ring-2 focus:ring-up"
          />
        </label>
        <a
          href={csv}
          className="toque inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full px-4 text-[14px] font-medium text-ink-2 ring-1 ring-line hover:bg-surface-2 hover:text-ink"
          download
        >
          <Download className="size-4" aria-hidden="true" />
          CSV
        </a>
      </form>
      <nav
        aria-label="Filtros"
        className="-mx-5 mb-2 flex gap-1.5 overflow-x-auto px-5 pb-1 sm:mx-0 sm:flex-wrap sm:px-0"
      >
        {(Object.keys(FILTROS) as Filtro[]).map((f) => (
          <Chip
            key={f}
            href={linkCom(estado, { f: f === "todos" ? null : f })}
            ativo={filtro === f}
          >
            {FILTROS[f]}
          </Chip>
        ))}
      </nav>
      <nav
        aria-label="Plano e ordem"
        className="-mx-5 mb-4 flex gap-1.5 overflow-x-auto px-5 pb-1 sm:mx-0 sm:flex-wrap sm:px-0"
      >
        <Chip href={linkCom(estado, { plano: null })} ativo={!plano}>
          Todos os planos
        </Chip>
        {PLANOS.map((pl) => (
          <Chip
            key={pl}
            href={linkCom(estado, { plano: pl })}
            ativo={plano === pl}
          >
            {NOME_PLANO[pl]}
          </Chip>
        ))}
        <span aria-hidden className="mx-1 w-px shrink-0 bg-line" />
        {(Object.keys(ORDENS) as Ordem[]).map((o) => (
          <Chip
            key={o}
            href={linkCom(estado, { o: o === "novas" ? null : o })}
            ativo={ordem === o}
          >
            {ORDENS[o]}
          </Chip>
        ))}
      </nav>
      <p className="mb-3 px-1 text-[13px] text-ink-3">
        {lista.length} de {pessoas.length} contas
        {busca ? ` para “${busca}”` : ""}
      </p>

      <Passo
        icone={<Users />}
        tom="down"
        i={4}
        titulo="Contas"
        sub={`${lista.length} de ${pessoas.length}`}
        className="overflow-hidden"
      >
        <div className="overflow-hidden rounded-2xl ring-1 ring-line ring-inset">
          {lista.length ? (
            <ul className="divide-y divide-line xl:grid xl:grid-cols-2 xl:divide-y-0">
              {lista.map((p) => (
                <Pessoa
                  key={p.id}
                  p={p}
                  agora={agora}
                  buildAtual={buildAtual}
                />
              ))}
            </ul>
          ) : (
            <p className="px-6 py-10 text-center text-[15px] text-ink-2">
              {busca || filtro !== "todos" || plano
                ? "Ninguém com esse filtro."
                : "Ainda não tem ninguém aqui."}
            </p>
          )}
        </div>
      </Passo>
    </Moldura>
  );
}
