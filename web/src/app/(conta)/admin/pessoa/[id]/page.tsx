import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarDays, Cloud, Globe, History, Laptop, Smartphone } from "lucide-react";
import { Avatar } from "@/components/conta/avatar";
import { MenuConta } from "@/components/conta/menu";
import { Moldura } from "@/components/conta/moldura";
import { Passo } from "@/components/kit/kit";
import { Numero, Selo, Tira, UltimoUso, bytesLegivel, dataHora, nArquivos, totalBytes, velocidadeLegivel } from "@/components/admin/partes";
import { buildPublicado, desatualizado, ehAdmin, linhaDoTempo, painelAdmin, velocidadeMedia } from "@/lib/admin";
import { exigirUsuario } from "@/lib/auth/atual";
import { NOME_PLANO } from "@/lib/recursos";
import { NOME_PLATAFORMA, tempoRelativo } from "@/lib/tempo";
import { acaoAdminDesconectar } from "../../../acoes";

export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };

const diaLongo = (dia: string) => {
  const t = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${dia}T12:00:00Z`));
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export default async function PessoaAdmin({ params }: { params: Promise<{ id: string }> }) {
  const { usuario, sessao } = await exigirUsuario("/admin");
  if (!(await ehAdmin(usuario))) notFound();
  const { id } = await params;
  const agora = new Date();
  const buildAtual = await buildPublicado();
  const { pessoas } = await painelAdmin(agora, buildAtual);
  const p = pessoas.find((x) => x.id === id);
  if (!p) notFound();
  const { dias, sessoes, eventos } = await linhaDoTempo(p.id, p, agora);
  const foto = p.drives.find((d) => d.fotoUrl)?.fotoUrl ?? null;
  const u = p.uso30;

  return (
    <Moldura
      larga
      titulo={p.nome}
      subtitulo={
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{p.email}</span>
          <span className="text-[15px] text-ink-3">
            <UltimoUso p={p} agora={agora} />
          </span>
        </span>
      }
      acao={<MenuConta admin />}
    >
      <Link href="/admin" className="-mt-6 mb-6 inline-flex items-center gap-1.5 px-1 text-[14px] text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Todas as contas
      </Link>

      <div className="mb-6 flex items-center gap-4 px-1">
        <Avatar src={foto} nome={p.nome} />
        <div className="flex flex-wrap items-center gap-1.5">
          <Selo>Plano {NOME_PLANO[p.plano]}</Selo>
          <Selo>{p.comSenha ? "E-mail e senha" : "Entrou com o Google"}</Selo>
          {p.usou.celular ? <Selo>Usa o celular</Selo> : null}
          {p.avisosCelular ? <Selo>Avisos no celular ligados</Selo> : null}
          <Tira dias={p.tira30} className="ml-1" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-8">
        <Numero valor={p.diasAtivos30} rotulo="dias ativos no mês" />
        <Numero valor={bytesLegivel(totalBytes(u))} rotulo="transferido no mês" detalhe={nArquivos(u.enviados + u.baixados)} />
        <Numero valor={u.erros} rotulo="erros no mês" alerta={u.erros > 0} />
        <Numero valor={velocidadeLegivel(velocidadeMedia(u))} rotulo="velocidade média" detalhe={u.maiorArquivo ? `maior: ${bytesLegivel(u.maiorArquivo)}` : undefined} />
        <Numero valor={bytesLegivel(u.enviadosBytes)} rotulo="subiu no mês" />
        <Numero valor={bytesLegivel(u.baixadosBytes)} rotulo="desceu no mês" />
        <Numero valor={bytesLegivel(totalBytes(p.usoTotal))} rotulo="no total" />
        <Numero valor={p.colecoes} rotulo="coleções" detalhe={`${p.referencias} links${p.referenciasComErro ? `, ${p.referenciasComErro} com erro` : ""}`} />
      </div>

      {/* Desktop largo: Drives e aparelhos lado a lado; embaixo, o dia a dia e a linha do tempo. */}
      <div className="mt-4 grid items-start gap-4 xl:grid-cols-2">
        <Passo icone={<Cloud />} tom="down" i={2} titulo="Drives" id="drives">
          <div className="overflow-hidden rounded-2xl bg-surface-2 ring-1 ring-line ring-inset">
            {p.drives.length ? (
              <ul className="divide-y divide-line">
                {p.drives.map((d) => (
                  <li key={d.email} className="flex items-center justify-between gap-3 px-5 py-3.5 text-[14px]">
                    <span className="truncate">{d.email}</span>
                    {d.estado === "ok" ? <Selo tom="ok">conectado</Selo> : <Selo tom="alerta">precisa reconectar</Selo>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-4 text-[14px] text-ink-2">Sem Google Drive conectado.</p>
            )}
          </div>
        </Passo>

        <Passo icone={<Laptop />} tom="ok" i={3} titulo="Aparelhos conectados" frase="Desconectar faz o aparelho sair da conta; a pessoa entra de novo quando quiser." id="aparelhos">
          <div className="overflow-hidden rounded-2xl bg-surface-2 ring-1 ring-line ring-inset">
            {sessoes.length ? (
              <ul className="divide-y divide-line">
                {sessoes.map((s) => {
                  const Icone = s.tipo === "dispositivo" ? Laptop : Globe;
                  const velho = s.tipo === "dispositivo" && desatualizado(s, buildAtual);
                  const titulo = s.tipo === "dispositivo" ? `${s.nome ?? "Computador"}${s.plataforma ? ` (${NOME_PLATAFORMA[s.plataforma]})` : ""}` : "Navegador ou celular";
                  return (
                    <li key={s.id} className="flex items-center gap-3 px-5 py-3.5">
                      <Icone className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
                      <div className="grid min-w-0 flex-1 gap-0.5">
                        <p className="truncate text-[14px] font-medium">{titulo}</p>
                        <p className="text-[13px] text-ink-3">
                          usado {tempoRelativo(s.ultimoUsoEm, agora)} · desde {dataHora.format(s.criadoEm)}
                          {s.tipo === "dispositivo" ? (
                            <span className={velho ? "font-medium text-warn-text" : undefined}>
                              {" · "}
                              {s.appBuild == null ? "app antigo" : s.appBuild === 0 ? "build de teste" : `build ${s.appBuild}`}
                              {velho && buildAtual ? ` (atual: ${buildAtual})` : ""}
                            </span>
                          ) : null}
                        </p>
                      </div>
                      {s.id === sessao.id ? (
                        <span className="text-[13px] text-ink-3">este</span>
                      ) : (
                        <form action={acaoAdminDesconectar}>
                          <input type="hidden" name="usuarioId" value={p.id} />
                          <input type="hidden" name="sessaoId" value={s.id} />
                          <button type="submit" className="toque h-11 rounded-full px-3 text-[13px] font-medium text-warn-text ring-1 ring-line hover:bg-surface-2 sm:h-8">
                            Desconectar
                          </button>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-5 py-4 text-[14px] text-ink-2">Nenhum aparelho conectado agora.</p>
            )}
          </div>
        </Passo>
      </div>
      <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Passo icone={<CalendarDays />} tom="up" i={4} titulo="Dia a dia" frase="Últimos 60 dias com uso. Só números: nada do que foi transferido." id="dias">
          <div className="overflow-hidden rounded-2xl bg-surface-2 ring-1 ring-line ring-inset">
            {dias.length ? (
              <ul className="divide-y divide-line">
                {dias.map((d) => {
                  const n = d.uso.enviados + d.uso.baixados;
                  return (
                    <li key={d.dia} className="grid gap-0.5 px-5 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[14px] font-medium">{diaLongo(d.dia)}</p>
                        <span className="inline-flex items-center gap-1.5 text-ink-3">
                          {d.site ? <Globe className="size-3.5" aria-label="site" /> : null}
                          {d.celular ? <Smartphone className="size-3.5" aria-label="celular" /> : null}
                          {d.computador ? <Laptop className="size-3.5" aria-label="computador" /> : null}
                        </span>
                      </div>
                      <p className="text-[13px] text-ink-3">
                        {n ? `${bytesLegivel(d.uso.enviadosBytes)} subiram, ${bytesLegivel(d.uso.baixadosBytes)} desceram · ${nArquivos(n)}` : "Sem transferências pelo computador"}
                        {d.uso.erros ? <span className="font-medium text-warn-text"> · {d.uso.erros} erros</span> : null}
                        {d.ultimaEm ? ` · último uso às ${new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Fortaleza" }).format(d.ultimaEm)}` : ""}
                      </p>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-5 py-4 text-[14px] text-ink-2">Nenhum dia de uso registrado ainda (o registro começou nesta versão).</p>
            )}
          </div>
        </Passo>

        <Passo icone={<History />} tom="neutro" i={5} titulo="Linha do tempo" id="linha">
          <div className="overflow-hidden rounded-2xl bg-surface-2 ring-1 ring-line ring-inset">
            <ol className="divide-y divide-line">
              {eventos.map((e, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3 px-5 py-3 text-[14px]">
                  <span>{e.texto}</span>
                  <span className="shrink-0 text-[13px] text-ink-3">{dataHora.format(e.quando)}</span>
                </li>
              ))}
            </ol>
          </div>
        </Passo>
      </div>
    </Moldura>
  );
}
