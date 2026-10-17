import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Laptop, Search } from "lucide-react";
import { Avatar } from "@/components/conta/avatar";
import { MenuConta } from "@/components/conta/menu";
import { Moldura } from "@/components/conta/moldura";
import { Card } from "@/components/ui/card";
import { ehAdmin, filtrarPessoas, listarPessoas, type PessoaAdmin } from "@/lib/admin";
import { betaAberto, NOME_PLANO, PLANOS } from "@/lib/recursos";
import { acaoTrocarPlano } from "../acoes";
import { exigirUsuario } from "@/lib/auth/atual";
import { tempoRelativo } from "@/lib/tempo";

export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const dataCurta = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Fortaleza" });

function Numero({ valor, rotulo, detalhe }: { valor: number; rotulo: string; detalhe?: string }) {
  return (
    <div className="grid content-start gap-0.5 bg-surface px-5 py-4">
      <p className="font-display text-[30px] leading-none font-semibold tracking-[-0.02em] tabular-nums">{valor}</p>
      <p className="text-[13px] text-ink-2">{rotulo}</p>
      {detalhe ? <p className="text-[12px] text-warn-text">{detalhe}</p> : null}
    </div>
  );
}

/** Plano da conta (para quando o beta fechar). Um formulário simples: funciona sem JavaScript. */
function Plano({ p }: { p: PessoaAdmin }) {
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
      <button type="submit" className="toque h-11 rounded-full px-3 sm:h-8 text-[13px] font-medium text-ink-2 ring-1 ring-line hover:bg-surface-2 hover:text-ink">
        Salvar
      </button>
    </form>
  );
}

function Pessoa({ p, agora }: { p: PessoaAdmin; agora: Date }) {
  const foto = p.drives.find((d) => d.fotoUrl)?.fotoUrl ?? null;
  const uso = p.ultimoUsoEm ? `ativo ${tempoRelativo(p.ultimoUsoEm, agora)}` : "nunca entrou";
  return (
    <li className="px-5 py-4 sm:px-6">
      <div className="flex items-start gap-4">
        <Avatar src={foto} nome={p.nome} />
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <p className="truncate text-[16px] font-medium">{p.nome}</p>
            <p className="shrink-0 text-[13px] text-ink-3">{uso}</p>
          </div>
          <p className="truncate text-[14px] text-ink-2" title={p.email}>
            {p.email}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[12px] font-medium text-ink-2 ring-1 ring-line">Plano {NOME_PLANO[p.plano]}</span>
            <Plano p={p} />
          </div>
          <p className="text-[13px] text-ink-3">
            Conta criada em {dataCurta.format(p.criadoEm)} · {p.comSenha ? "e-mail e senha" : "entrou com o Google"}
            {p.computadores ? (
              <span className="inline-flex items-center gap-1">
                {" · "}
                <Laptop className="size-3.5" aria-hidden="true" />
                {p.computadores} {p.computadores === 1 ? "computador" : "computadores"}
              </span>
            ) : null}
          </p>
          {p.drives.length ? (
            <ul className="mt-1.5 grid gap-1">
              {p.drives.map((d) => (
                <li key={d.email} className="flex items-center gap-2 text-[13px]">
                  <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${d.estado === "ok" ? "bg-ok" : "bg-warn"}`} />
                  <span className="truncate text-ink-2" title={d.email}>
                    {d.email}
                  </span>
                  <span className={d.estado === "ok" ? "shrink-0 text-ink-3" : "shrink-0 font-medium text-warn-text"}>
                    {d.estado === "ok" ? `Drive desde ${dataCurta.format(d.criadoEm)}` : "precisa reconectar"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[13px] text-ink-3">Sem Google Drive conectado</p>
          )}
        </div>
      </div>
    </li>
  );
}

export default async function Admin({ searchParams }: Props) {
  const { usuario } = await exigirUsuario("/admin");
  // Quem não é admin vê a mesma página de "não encontrado" de qualquer endereço que não existe.
  if (!(await ehAdmin(usuario))) notFound();
  const q = await searchParams;
  const busca = typeof q.q === "string" ? q.q.slice(0, 100) : "";
  const agora = new Date();
  const { pessoas, resumo } = await listarPessoas(agora);
  const lista = filtrarPessoas(pessoas, busca);

  return (
    <Moldura titulo="Quem está na plataforma" subtitulo="Contas SOBEDESCE, os Drives conectados e o último acesso." acao={<MenuConta admin />}>
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
        <span className="text-[13px] text-ink-3">O plano de cada conta fica guardado para quando o beta fechar (SOBEDESCE_BETA_ABERTO=0).</span>
      </p>

      <Card className="mb-10 grid grid-cols-2 gap-px overflow-hidden bg-line sm:grid-cols-4">
        <Numero valor={resumo.contas} rotulo="contas" />
        <Numero valor={resumo.drivesOk} rotulo="Drives conectados" detalhe={resumo.drivesReconectar ? `${resumo.drivesReconectar} para reconectar` : undefined} />
        <Numero valor={resumo.ativos7d} rotulo="ativas em 7 dias" />
        <Numero valor={resumo.novas7d} rotulo="novas em 7 dias" />
      </Card>

      <form method="get" role="search" className="mb-4 flex items-center gap-2">
        <label className="relative flex-1">
          <span className="sr-only">Buscar por nome ou e-mail</span>
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-3" aria-hidden="true" />
          <input
            type="search"
            name="q"
            defaultValue={busca}
            placeholder="Buscar por nome ou e-mail"
            className="h-11 w-full rounded-full bg-surface-2 pr-4 pl-10 text-[15px] ring-1 ring-line outline-none placeholder:text-ink-3 focus:ring-2 focus:ring-up"
          />
        </label>
      </form>
      <p className="mb-3 px-1 text-[13px] text-ink-3">
        {busca ? `${lista.length} de ${pessoas.length} contas para “${busca}”` : `${pessoas.length} contas, das mais novas para as mais antigas`}
        {resumo.computadores ? ` · ${resumo.computadores} computadores conectados` : ""}
      </p>

      <Card className="overflow-hidden">
        {lista.length ? (
          <ul className="divide-y divide-line">
            {lista.map((p) => (
              <Pessoa key={p.id} p={p} agora={agora} />
            ))}
          </ul>
        ) : (
          <p className="px-6 py-10 text-center text-[15px] text-ink-2">{busca ? "Ninguém com esse nome ou e-mail." : "Ainda não tem ninguém aqui."}</p>
        )}
      </Card>
    </Moldura>
  );
}
