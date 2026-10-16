import Link from "next/link";
import { ArrowRight, Check, Globe, QrCode, Share, Wifi } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { ROTAS } from "@/lib/site";
import { Reveal } from "./motion";
import { Container, SectionHeading } from "./section";

const FILES = [
  { name: "IMG_4821.MOV", size: "2,1 GB", dur: "7s", delay: "-1s", rest: "100%" },
  { name: "IMG_4822.MOV", size: "4,8 GB", dur: "9s", delay: "-4s", rest: "72%" },
  { name: "IMG_4825.MOV", size: "1,3 GB", dur: "6s", delay: "-3.5s", rest: "45%" },
  { name: "IMG_4830.MOV", size: "6,2 GB", dur: "11s", delay: "-2s", rest: "18%" },
];

const DONE = ["IMG_4809.MOV", "IMG_4812.MOV", "IMG_4815.MOV"];

/** Um iPhone desenhado em CSS com a tela de envio (ilustração, não é print). */
function PhoneMock() {
  return (
    <div className="relative mx-auto w-[260px] sm:w-[290px]" aria-hidden="true">
      <div className="absolute -inset-10 -z-10 rounded-full bg-[radial-gradient(closest-side,rgba(124,92,255,0.22),transparent)]" />
      <div className="rounded-[48px] bg-[#0c0c0e] p-[10px] shadow-[0_30px_60px_-24px_rgba(40,20,120,0.4),inset_0_0_0_1.5px_rgba(255,255,255,0.08)]">
        <div className="relative aspect-[9/19.2] overflow-hidden rounded-[39px] bg-surface">
          <div className="absolute top-2.5 left-1/2 h-[26px] w-[92px] -translate-x-1/2 rounded-full bg-[#0c0c0e]" />
          <div className="flex h-full flex-col px-4 pt-12 pb-5">
            <div className="flex items-center justify-between">
              <span className="text-[17px] font-semibold tracking-tight text-ink">Enviar</span>
              <span className="size-7 rounded-full bg-gradient-to-br from-up to-down" />
            </div>
            <div className="mt-4 rounded-2xl bg-surface-2 px-3.5 py-3">
              <span className="block text-[10px] font-medium tracking-wide text-ink-3 uppercase">Para</span>
              <span className="mt-0.5 block truncate text-[13px] font-medium text-ink">Drive da produtora › Brutos</span>
            </div>
            <ul className="mt-4 grid gap-3.5">
              {FILES.map((f) => (
                <li key={f.name} className="grid gap-1.5">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-mono text-[11px] text-ink">{f.name}</span>
                    <span className="shrink-0 text-[10px] text-ink-3">{f.size}</span>
                  </span>
                  <span className="block h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <span
                      className="block h-full rounded-full bg-gradient-to-r from-up-text to-up-soft"
                      style={
                        {
                          width: f.rest,
                          animation: `sd-fill ${f.dur} cubic-bezier(0.4,0.1,0.3,1) ${f.delay} infinite`,
                          "--from": "4%",
                        } as React.CSSProperties
                      }
                    />
                  </span>
                </li>
              ))}
            </ul>
            <span className="mt-6 text-[10px] font-medium tracking-wide text-ink-3 uppercase">Enviados</span>
            <ul className="mt-2.5 grid gap-2.5">
              {DONE.map((name) => (
                <li key={name} className="flex items-center gap-2">
                  <span className="grid size-4 place-items-center rounded-full bg-ok/15 text-ok-text">
                    <Check className="size-2.5" strokeWidth={3} />
                  </span>
                  <span className="truncate font-mono text-[11px] text-ink-2">{name}</span>
                  <span className="ml-auto text-[10px] text-ok-text">Conferido</span>
                </li>
              ))}
            </ul>
            <div className="mt-auto grid pt-4">
              <span className="flex h-11 items-center justify-center rounded-full bg-primary text-[14px] font-medium text-primary-fg">Escolher arquivos</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PhoneSection() {
  return (
    <section id="celular" aria-labelledby="celular-titulo" className="scroll-mt-14 overflow-hidden bg-surface-2 py-24 sm:py-36">
      <Container>
        <SectionHeading id="celular-titulo" eyebrow="Celular" tone="up" title="Do celular para o Drive, sem cabo.">
          <p>Vídeo gravado no iPhone ou no Android chega ao Drive de dois jeitos. Os dois continuam de onde pararam se a conexão cair.</p>
        </SectionHeading>

        <div className="mt-16 grid items-center gap-14 sm:mt-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-20">
          <Reveal y={40}>
            <PhoneMock />
          </Reveal>
          <div className="grid gap-4 sm:gap-5">
            <Reveal className="rounded-[28px] bg-surface p-6 ring-1 ring-line sm:p-8">
              <div className="flex items-center gap-3">
                <span className="grid size-10 place-items-center rounded-full bg-up/12 text-up-text">
                  <Globe className="size-5" aria-hidden="true" />
                </span>
                <h3 className="text-[19px] font-semibold tracking-tight text-ink">Pelo navegador</h3>
              </div>
              <p className="mt-4 text-[15px] leading-relaxed text-ink-2">
                Abra o SOBEDESCE no celular, entre na sua conta e envie. Os arquivos vão do aparelho direto para o Google, sem passar pelo computador. Não precisa instalar nada.
              </p>
              <Link href={ROTAS.celular} className={buttonClasses({ variant: "up", size: "md", className: "mt-6" })}>
                Usar no celular
                <ArrowRight aria-hidden="true" />
              </Link>
            </Reveal>
            <Reveal className="rounded-[28px] bg-surface p-6 ring-1 ring-line sm:p-8" delay={0.08}>
              <div className="flex items-center gap-3">
                <span className="grid size-10 place-items-center rounded-full bg-down/10 text-down-text">
                  <Wifi className="size-5" aria-hidden="true" />
                </span>
                <h3 className="text-[19px] font-semibold tracking-tight text-ink">Pelo Wi-Fi, com o computador</h3>
              </div>
              <p className="mt-4 text-[15px] leading-relaxed text-ink-2">
                O celular manda para o computador pela rede de casa ou do escritório, e o computador sobe para o Drive. Sem login do Google no celular.
              </p>
              <ul className="mt-5 grid gap-3 text-[14px] text-ink-2">
                <li className="flex gap-3">
                  <QrCode className="mt-0.5 size-4 shrink-0 text-ink" aria-hidden="true" />
                  Aponte a câmera para o QR code que aparece no app do computador.
                </li>
                <li className="flex gap-3">
                  <Share className="mt-0.5 size-4 shrink-0 text-ink" aria-hidden="true" />
                  Com o Atalho do iPhone, envie pelo botão Compartilhar de qualquer app.
                </li>
              </ul>
            </Reveal>
          </div>
        </div>
      </Container>
    </section>
  );
}
