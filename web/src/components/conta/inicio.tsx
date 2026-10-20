import Link from "next/link";
import { ArrowRight, ArrowUpRight, Bookmark, Calculator, Cloud, Laptop, MonitorDown } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Computador } from "@/lib/acompanhar/formato";
import { DicaInstalar } from "./dica-instalar";

const ANDANDO = new Set(["enviando", "baixando", "pausado"]);

type Props = {
  drivesOk: number;
  drivesProblema: number;
  computadores: number;
  andamento: Computador[];
  referencias: boolean;
};

/** Um bloco do Início: ícone, número ou nome grande, uma linha embaixo; o bloco todo é o link. */
function Bloco({
  href,
  icone,
  tom,
  rotulo,
  valor,
  linha,
  i,
  externo = false,
}: {
  href: string;
  icone: React.ReactNode;
  tom: "up" | "down" | "ok" | "warn" | "neutro";
  rotulo: string;
  valor: React.ReactNode;
  linha: React.ReactNode;
  i: number;
  externo?: boolean;
}) {
  const conteudo = (
    <>
      <span
        className={cn(
          "grid size-9 place-items-center rounded-xl sm:size-10",
          tom === "up" && "bg-up/12 text-up-text",
          tom === "down" && "bg-down/12 text-down-text",
          tom === "ok" && "bg-ok/14 text-ok-text",
          tom === "warn" && "bg-warn/15 text-warn-text",
          tom === "neutro" && "bg-surface-2 text-ink ring-1 ring-line",
        )}
      >
        {icone}
      </span>
      <span className="mt-4 text-[13px] font-medium text-ink-3 sm:mt-5">{rotulo}</span>
      <span className="font-display text-[21px] leading-tight font-semibold tracking-[-0.02em] tabular-nums sm:text-[26px]">{valor}</span>
      <span className="text-[13px] leading-snug text-pretty text-ink-2 sm:text-[14px]">{linha}</span>
      <ArrowUpRight
        className="absolute top-4 right-4 size-4 sm:top-5 sm:right-5 text-ink-3 transition-transform duration-300 ease-out group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
        aria-hidden="true"
      />
    </>
  );
  const classes =
    "group relative flex animate-rise flex-col gap-0.5 rounded-2xl bg-surface p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)] ring-1 ring-line transition-[transform,box-shadow] duration-300 ease-out hover:-translate-y-0.5 hover:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.18)] sm:p-6";
  const estilo = { animationDelay: `${120 + i * 70}ms` };
  return externo ? (
    <a href={href} className={classes} style={estilo}>
      {conteudo}
    </a>
  ) : (
    <Link href={href} className={classes} style={estilo}>
      {conteudo}
    </Link>
  );
}

/**
 * Início da conta: o botão grande de enviar e poucos blocos (Drives, computadores, Referências ou Calculadora), cada
 * um levando para onde se resolve. O resto da conta (dados, senha, apagar) fica abaixo, em "Ajustes da conta".
 */
export function InicioConta({ drivesOk, drivesProblema, computadores, andamento, referencias }: Props) {
  const andando = andamento.filter((c) => ANDANDO.has(c.snapshot.estado));
  const primeiro = andando[0];
  const pct = primeiro?.snapshot.geral.totalBytes ? Math.floor((primeiro.snapshot.geral.feitoBytes / primeiro.snapshot.geral.totalBytes) * 100) : 0;
  const temDrive = drivesOk > 0;

  return (
    <section aria-label="Início" className="mb-14 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4 xl:mb-20">
      <Link
        href={temDrive ? "/app/" : "#drives"}
        className="group relative isolate flex min-h-[220px] animate-rise flex-col justify-end overflow-hidden rounded-3xl bg-[linear-gradient(135deg,var(--color-up-soft),var(--color-up)_45%,var(--color-down))] p-6 text-white shadow-[0_18px_48px_-18px_var(--color-up)] transition-transform duration-300 ease-out hover:-translate-y-0.5 sm:p-8 col-span-2 lg:row-span-2 lg:min-h-[340px]"
      >
        {/* Barras subindo e descendo: o símbolo da marca, em movimento lento. */}
        <span aria-hidden="true" className="pointer-events-none absolute -top-6 right-10 hidden h-[70%] items-end gap-3 opacity-35 sm:flex">
          <span className="block h-full w-5 origin-bottom animate-[sd-ini-barra_3.2s_ease-in-out_infinite] rounded-full bg-white" />
          <span className="block h-[70%] w-5 origin-bottom animate-[sd-ini-barra_3.2s_ease-in-out_-1.6s_infinite] rounded-full bg-white" />
        </span>
        <span className="text-[14px] font-medium text-white/80">{temDrive ? "Do celular ou deste navegador" : "Primeiro passo"}</span>
        <span className="mt-1 font-display text-[32px] leading-[1.05] font-semibold tracking-[-0.03em] sm:text-[40px]">
          {temDrive ? "Enviar arquivos" : "Conectar o Google Drive"}
        </span>
        <span className="mt-2 max-w-[34ch] text-[15px] leading-relaxed text-white/85">
          {temDrive ? "Direto para o seu Drive, em qualquer tamanho. Se a conexão cair, continua de onde parou." : "É para lá que os arquivos vão. Leva um minuto."}
        </span>
        <span className="mt-6 inline-flex w-fit items-center gap-2 rounded-full bg-white px-5 py-2.5 text-[15px] font-semibold text-[#1d1d1f] transition-transform duration-300 group-hover:translate-x-0.5">
          {temDrive ? "Começar" : "Conectar"}
          <ArrowRight className="size-4" aria-hidden="true" />
        </span>
      </Link>

      <Bloco
        i={0}
        href="#drives"
        icone={<Cloud className="size-5" aria-hidden="true" />}
        tom={drivesProblema ? "warn" : "down"}
        rotulo="Google Drive"
        valor={drivesOk + drivesProblema}
        linha={drivesProblema ? `${drivesProblema === 1 ? "Um precisa" : `${drivesProblema} precisam`} reconectar` : drivesOk === 1 ? "conectado" : drivesOk ? "conectados" : "nenhum conectado"}
      />
      <Bloco
        i={1}
        href={andando.length ? "/app/#computador" : "#computadores"}
        icone={<Laptop className="size-5" aria-hidden="true" />}
        tom={andando.length ? "up" : computadores ? "ok" : "neutro"}
        rotulo="Computadores"
        valor={andando.length ? `${pct}%` : computadores}
        linha={
          primeiro
            ? `${primeiro.nome}${primeiro.snapshot.estado === "pausado" ? " · pausado" : ""}`
            : computadores
              ? "Nada passando agora"
              : "Instale o app para os arquivos gigantes"
        }
      />
      {referencias ? (
        <Bloco
          i={2}
          href="/app/#referencias"
          externo
          icone={<Bookmark className="size-5" aria-hidden="true" />}
          tom="warn"
          rotulo="Referências"
          valor="Coleções"
          linha="Instagram, YouTube e TikTok no seu Drive"
        />
      ) : (
        <Bloco
          i={2}
          href="/calculadora"
          icone={<Calculator className="size-5" aria-hidden="true" />}
          tom="neutro"
          rotulo="Calculadora"
          valor="Mídia"
          linha="Quanto cabe no cartão e no SSD"
        />
      )}
      <Bloco
        i={3}
        href={computadores ? "#computadores" : "#instalar"}
        icone={<MonitorDown className="size-5" aria-hidden="true" />}
        tom="neutro"
        rotulo="App do computador"
        valor={computadores ? "Instalado" : "Mac e Windows"}
        linha={computadores ? "Ver os computadores da conta" : "Baixar e entrar com a conta"}
      />
      {temDrive ? (
        <div className="col-span-2 empty:hidden lg:col-span-4">
          <DicaInstalar />
        </div>
      ) : null}
    </section>
  );
}
