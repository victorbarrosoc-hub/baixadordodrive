"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { calcular, comoOComputadorMostra, duracao, tamanho } from "@/lib/midia/conta.js";
import { MODOS } from "@/lib/midia/modos.js";

type Modo = { id: string; camera: string; modo: string; mbps: number; fonte: string; fonteNome: string; nota?: string };
type Cam = { id: string; modo: string; mbps: string; horas: string };

const modos = MODOS as Modo[];
const CARTOES = [64, 128, 256, 512, 1000];
const num = (n: number, casas = 1) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: casas }).format(n);
const lerNum = (s: string) => {
  const n = Number(String(s ?? "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
};
let seq = 0;
const novaCamera = (): Cam => ({ id: `c${++seq}`, modo: modos[0]?.id || "manual", mbps: "", horas: "8" });
const campo =
  "h-11 w-full rounded-xl bg-surface px-3.5 text-[15px] text-ink ring-1 ring-line-strong outline-none transition-shadow placeholder:text-ink-3 focus:ring-2 focus:ring-down";

function Escolha<T extends string>({ valor, opcoes, onChange, rotulo }: { valor: T; opcoes: { v: T; t: string }[]; onChange: (v: T) => void; rotulo: string }) {
  return (
    <div role="radiogroup" aria-label={rotulo} className="flex flex-wrap gap-1.5">
      {opcoes.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={o.v === valor}
          onClick={() => onChange(o.v)}
          className={cn(
            "h-9 rounded-full px-3.5 text-[14px] font-medium ring-1 transition-colors",
            o.v === valor ? "bg-primary text-primary-fg ring-primary" : "bg-surface text-ink-2 ring-line-strong hover:text-ink",
          )}
        >
          {o.t}
        </button>
      ))}
    </div>
  );
}

function Rotulo({ children }: { children: React.ReactNode }) {
  return <span className="text-[13px] font-medium text-ink-2">{children}</span>;
}

export function Calculadora() {
  const [cams, setCams] = useState<Cam[]>(() => [novaCamera()]);
  const [cartao, setCartao] = useState("128");
  const [cartaoOutro, setCartaoOutro] = useState("");
  const [margem, setMargem] = useState("0.2");
  const [copias, setCopias] = useState("2");
  const [leitor, setLeitor] = useState("");
  const [hd, setHd] = useState("");
  const [verConta, setVerConta] = useState(false);
  const cartaoGB = cartao === "outro" ? lerNum(cartaoOutro) : Number(cartao);
  const entrada = cams.map((c) => {
    const m = modos.find((x) => x.id === c.modo);
    return { nome: m ? `${m.camera} · ${m.modo}` : "Câmera (bitrate digitado)", mbps: m ? m.mbps : lerNum(c.mbps), horas: lerNum(c.horas) };
  });
  const chave = JSON.stringify(entrada);
  const r = useMemo(
    () =>
      cartaoGB
        ? calcular({ cameras: entrada, cartaoGB, margem: Number(margem), copias: Number(copias), leitorMBs: lerNum(leitor), hdMBs: lerNum(hd) })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chave, cartaoGB, margem, copias, leitor, hd],
  );
  const mostra = cartaoGB ? comoOComputadorMostra(cartaoGB) : null;
  const cameras = [...new Set(modos.map((m) => m.camera))];
  const muda = (i: number, c: Cam) => setCams(cams.map((x, j) => (j === i ? c : x)));

  return (
    <div className="mt-12 grid items-start gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <section className="grid gap-6 rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-line sm:p-7">
        <h2 className="text-[19px] font-semibold tracking-tight text-ink">O que vai gravar</h2>
        {cams.map((c, i) => {
          const m = modos.find((x) => x.id === c.modo);
          return (
            <div key={c.id} className="grid gap-3 border-b border-line pb-5 sm:grid-cols-[minmax(0,1fr)_110px_auto] sm:items-start">
              <label className="grid gap-1.5">
                <Rotulo>Câmera e modo</Rotulo>
                <select className={campo} value={c.modo} onChange={(e) => muda(i, { ...c, modo: e.currentTarget.value })}>
                  {cameras.map((cam) => (
                    <optgroup key={cam} label={cam}>
                      {modos
                        .filter((x) => x.camera === cam)
                        .map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.camera} · {x.modo} · {num(x.mbps)} Mb/s
                          </option>
                        ))}
                    </optgroup>
                  ))}
                  <option value="manual">Outra: digitar o bitrate</option>
                </select>
                {m ? (
                  <span className="text-[12.5px] text-ink-3">
                    Fonte:{" "}
                    <a href={m.fonte} target="_blank" rel="noopener noreferrer" className="text-down-text hover:underline">
                      {m.fonteNome}
                    </a>
                    {m.nota ? ` · ${m.nota}` : ""}
                  </span>
                ) : (
                  <input className={campo} inputMode="decimal" placeholder="Bitrate em Mb/s (ex.: 100)" value={c.mbps} onChange={(e) => muda(i, { ...c, mbps: e.currentTarget.value })} />
                )}
              </label>
              <label className="grid gap-1.5">
                <Rotulo>Horas</Rotulo>
                <input className={campo} inputMode="decimal" value={c.horas} onChange={(e) => muda(i, { ...c, horas: e.currentTarget.value })} />
              </label>
              {cams.length > 1 ? (
                <button type="button" onClick={() => setCams(cams.filter((_, j) => j !== i))} className="h-11 self-end rounded-xl px-3 text-[14px] text-ink-2 ring-1 ring-line-strong hover:text-ink sm:mt-[22px] sm:self-start">
                  Tirar
                </button>
              ) : null}
            </div>
          );
        })}
        <button type="button" onClick={() => setCams([...cams, novaCamera()])} className={buttonClasses({ variant: "ghost", size: "sm", className: "justify-self-start ring-1 ring-line-strong" })}>
          Somar outra câmera
        </button>

        <h2 className="pt-2 text-[19px] font-semibold tracking-tight text-ink">Cartões e backup</h2>
        <div className="grid gap-2">
          <Rotulo>Cartão</Rotulo>
          <Escolha
            rotulo="Capacidade do cartão"
            valor={cartao}
            onChange={setCartao}
            opcoes={[...CARTOES.map((g) => ({ v: String(g), t: g >= 1000 ? `${g / 1000} TB` : `${g} GB` })), { v: "outro", t: "Outro" }]}
          />
          {cartao === "outro" ? <input className={cn(campo, "max-w-[240px]")} inputMode="decimal" placeholder="GB impressos no cartão" value={cartaoOutro} onChange={(e) => setCartaoOutro(e.currentTarget.value)} /> : null}
          {mostra ? (
            <p className="text-[12.5px] text-pretty text-ink-3">
              O de {num(cartaoGB!)} GB aparece com cerca de {num(mostra.windows)} GB no Windows e {num(mostra.mac)} GB no Mac (um pouco menos depois de formatar). A conta usa os GB do
              fabricante.
            </p>
          ) : null}
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="grid gap-2">
            <Rotulo>Margem nos cartões</Rotulo>
            <Escolha rotulo="Margem" valor={margem} onChange={setMargem} opcoes={["0.1", "0.2", "0.3"].map((v) => ({ v, t: `${Number(v) * 100}%` }))} />
          </div>
          <div className="grid gap-2">
            <Rotulo>Cópias de backup</Rotulo>
            <Escolha rotulo="Cópias" valor={copias} onChange={setCopias} opcoes={["1", "2", "3"].map((v) => ({ v, t: v === "1" ? "1 HD" : `${v} HDs` }))} />
          </div>
          <label className="grid gap-1.5">
            <Rotulo>Leitor de cartão (MB/s, se souber)</Rotulo>
            <input className={campo} inputMode="decimal" placeholder="ex.: 280" value={leitor} onChange={(e) => setLeitor(e.currentTarget.value)} />
          </label>
          <label className="grid gap-1.5">
            <Rotulo>HD mais lento (MB/s, se souber)</Rotulo>
            <input className={campo} inputMode="decimal" placeholder="ex.: 150" value={hd} onChange={(e) => setHd(e.currentTarget.value)} />
          </label>
        </div>
      </section>

      <section aria-live="polite" className="grid gap-5 rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-line sm:p-7 lg:sticky lg:top-20">
        <h2 className="text-[19px] font-semibold tracking-tight text-ink">Leve</h2>
        {r?.linhas.length ? (
          <>
            <div className="grid grid-cols-2 gap-2.5">
              {[
                [String(r.totalCartoes), `${r.totalCartoes === 1 ? "cartão" : "cartões"} de ${tamanho(cartaoGB!)}`],
                [tamanho(r.totalGB), "de gravação"],
                [`${r.copias} × ${tamanho(r.totalGB)}`, r.copias === 1 ? "HD de backup" : "HDs de backup (um por cópia)"],
                [
                  r.tempoTotalS != null ? duracao(r.tempoTotalS) : "—",
                  r.tempoTotalS != null ? (r.tempoConferenciaS != null ? "copiar e conferir (estimativa)" : "copiar, sem conferir (estimativa)") : "de cópia: diga a velocidade do leitor e do HD",
                ],
              ].map(([b, s]) => (
                <div key={s} className="grid gap-0.5 rounded-xl bg-surface-2 p-3.5">
                  <b className="text-[24px] leading-tight font-semibold tracking-tight text-ink tabular-nums">{b}</b>
                  <span className="text-[12.5px] text-ink-2">{s}</span>
                </div>
              ))}
            </div>
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="text-left text-[12px] text-ink-3">
                  <th className="pb-2 font-medium">Câmera</th>
                  <th className="pb-2 text-right font-medium">Por hora</th>
                  <th className="pb-2 text-right font-medium">Cabe no cartão</th>
                  <th className="pb-2 text-right font-medium">Cartões</th>
                </tr>
              </thead>
              <tbody>
                {r.linhas.map((l, i) => (
                  <tr key={i} className="border-t border-line align-top">
                    <td className="py-2.5 pr-2 text-ink">
                      {l.nome}
                      <small className="block text-[12px] text-ink-3">
                        {num(l.mbps ?? 0)} Mb/s · {num(l.horas ?? 0)} h
                      </small>
                    </td>
                    <td className="py-2.5 text-right whitespace-nowrap text-ink tabular-nums">{tamanho(l.gbh)}</td>
                    <td className="py-2.5 text-right whitespace-nowrap text-ink tabular-nums">{duracao(l.horasPorCartao * 3600)}</td>
                    <td className="py-2.5 text-right text-ink tabular-nums">{l.cartoes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" onClick={() => setVerConta(!verConta)} aria-expanded={verConta} className="justify-self-start text-[14px] font-medium text-down-text hover:underline">
              {verConta ? "Esconder a conta" : "Ver a conta, linha por linha"}
            </button>
            {verConta ? (
              <div className="grid gap-3 text-[13.5px] text-ink-2 tabular-nums">
                {r.linhas.map((l, i) => (
                  <div key={i}>
                    <p className="font-semibold text-ink">{l.nome}</p>
                    <ul className="mt-1 grid list-disc gap-1 pl-5">
                      {l.conta.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                  </div>
                ))}
                <div>
                  <p className="font-semibold text-ink">Trabalho</p>
                  <ul className="mt-1 grid list-disc gap-1 pl-5">
                    {r.conta.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </div>
                <p className="text-[12.5px] text-ink-3">GB por hora = bitrate em Mb/s × 3.600 ÷ 8 ÷ 1.000.</p>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-[15px] text-ink-3">Escolha a câmera e as horas para ver a conta.</p>
        )}
        <div className="mt-2 border-t border-line pt-5 text-[14px] text-pretty text-ink-2">
          No fim da diária, o app SOBEDESCE copia os cartões para os HDs e o Drive e confere cada arquivo.{" "}
          <Link href="/#baixar" className="font-medium text-down-text hover:underline">
            Baixar o app
          </Link>
        </div>
      </section>
    </div>
  );
}
