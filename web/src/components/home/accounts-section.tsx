import Link from "next/link";
import { Laptop, Plus, Smartphone } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { ROTAS } from "@/lib/site";
import { Reveal } from "./motion";
import { Container, SectionHeading } from "./section";

const DRIVES = [
  { name: "Drive da produtora", tint: "from-up to-up-soft" },
  { name: "Drive pessoal", tint: "from-down to-down-soft" },
  { name: "Drive do cliente", tint: "from-ok to-[#7be495]" },
];

/** Linha tracejada que anda, ligando a conta aos aparelhos. */
function Wire({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`block h-14 w-[2px] bg-[linear-gradient(to_bottom,var(--color-line-strong)_50%,transparent_50%)] bg-[length:2px_12px] [animation:sd-dash-y_1.2s_linear_infinite] ${className ?? ""}`}
    />
  );
}

function AccountCard() {
  return (
    <div className="relative mx-auto w-full max-w-[420px] rounded-[28px] bg-surface p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_30px_70px_-35px_rgba(20,20,60,0.35)] ring-1 ring-line sm:p-6">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-ink-3">Sua conta SOBEDESCE</span>
        <span className="inline-flex h-6 items-center rounded-full bg-ok/12 px-2.5 text-[11px] font-medium text-ok-text">3 Drives</span>
      </div>
      <ul className="mt-4 grid gap-2.5">
        {DRIVES.map((d) => (
          <li key={d.name} className="flex items-center gap-3 rounded-2xl bg-surface-2 px-3.5 py-3">
            <span className={`size-8 shrink-0 rounded-full bg-gradient-to-br ${d.tint}`} aria-hidden="true" />
            <span className="grid min-w-0">
              <span className="truncate text-[14px] font-medium text-ink">{d.name}</span>
              <span className="truncate text-[12px] text-ink-3">Conectado</span>
            </span>
            <span className="ml-auto size-2 shrink-0 rounded-full bg-ok" aria-hidden="true" />
          </li>
        ))}
        <li className="flex items-center gap-3 rounded-2xl px-3.5 py-2.5 text-[14px] text-ink-2 ring-1 ring-line ring-inset">
          <span className="grid size-8 place-items-center rounded-full bg-surface-2">
            <Plus className="size-4" aria-hidden="true" />
          </span>
          Conectar Google Drive
        </li>
      </ul>
    </div>
  );
}

function Device({ icon: Icon, label, text }: { icon: typeof Laptop; label: string; text: string }) {
  return (
    <div className="grid justify-items-center gap-2 text-center">
      <span className="grid size-14 place-items-center rounded-2xl bg-surface ring-1 ring-line">
        <Icon className="size-6 text-ink" aria-hidden="true" />
      </span>
      <span className="text-[15px] font-semibold text-ink">{label}</span>
      <span className="max-w-[16ch] text-[13px] leading-snug text-ink-2">{text}</span>
    </div>
  );
}

export function AccountsSection() {
  return (
    <section aria-labelledby="contas-titulo" className="py-24 sm:py-36">
      <Container>
        <SectionHeading id="contas-titulo" eyebrow="Contas" tone="down" title="Uma conta. Quantos Drives você precisar.">
          <p>
            Crie a sua conta SOBEDESCE e conecte um ou mais Google Drives: o seu, o da produtora, o do cliente. O computador e o celular usam os mesmos Drives, sem conectar tudo de novo em cada aparelho.
          </p>
        </SectionHeading>

        <Reveal className="mt-14 sm:mt-20" delay={0.05}>
          <AccountCard />
          <div className="mx-auto grid max-w-[420px] grid-cols-2">
            <div className="grid justify-items-center">
              <Wire />
              <Device icon={Laptop} label="Computador" text="Mac ou Windows, entra com um código" />
            </div>
            <div className="grid justify-items-center">
              <Wire className="[animation-delay:-0.6s]" />
              <Device icon={Smartphone} label="Celular" text="iPhone ou Android, pelo navegador" />
            </div>
          </div>
        </Reveal>

        <Reveal className="mt-14 flex flex-wrap justify-center gap-3" delay={0.1}>
          <Link href={ROTAS.criarConta} className={buttonClasses({ variant: "primary", size: "lg" })}>
            Criar conta
          </Link>
          <Link href={ROTAS.entrar} className={buttonClasses({ variant: "secondary", size: "lg" })}>
            Entrar
          </Link>
        </Reveal>
      </Container>
    </section>
  );
}
