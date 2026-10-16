import { Counter, Reveal } from "./motion";
import { Container } from "./section";

/** Números conferidos nos ajustes do app (src/config.js). */
const STATS = [
  { value: 8, suffix: "", label: "conexões por arquivo" },
  { value: 32, suffix: "", label: "conexões no máximo" },
  { value: 4, suffix: "", label: "envios ao mesmo tempo" },
  { value: 3, suffix: "", label: "plataformas: Mac, Windows e celular" },
];

/** Faixa de números-chave logo abaixo do topo. */
export function StatsStrip() {
  return (
    <section aria-label="Números" className="border-y border-line bg-surface">
      <Container>
        <dl className="grid grid-cols-2 divide-line md:grid-cols-4 md:divide-x">
          {STATS.map((s, i) => (
            <Reveal key={s.label} delay={i * 0.06} y={12} className="grid gap-1.5 px-2 py-7 text-center sm:py-10">
              <dt className="order-2 text-[13px] text-ink-2 sm:text-[14px]">{s.label}</dt>
              <dd className="order-1 font-display text-[40px] leading-none font-semibold tracking-[-0.04em] text-ink sm:text-[56px]">
                <Counter to={s.value} />
                {s.suffix}
              </dd>
            </Reveal>
          ))}
        </dl>
      </Container>
    </section>
  );
}
