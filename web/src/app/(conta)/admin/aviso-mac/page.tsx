import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Aviso } from "@/components/conta/aviso";
import { MenuConta } from "@/components/conta/menu";
import { Moldura, Secao } from "@/components/conta/moldura";
import { Card } from "@/components/ui/card";
import { ehAdmin } from "@/lib/admin";
import { CORRECAO_ATUALIZAR_MAC, contasComMacTravado } from "@/lib/atualizar-mac";
import { exigirUsuario } from "@/lib/auth/atual";
import { emailAtualizarMac } from "@/lib/email/modelos";
import { acaoAvisarMacs } from "../../acoes";

export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Quem tem Mac com o Atualizar travado, a prévia do e-mail e o botão de mandar (lib/atualizar-mac.ts). */
export default async function AvisoMac({ searchParams }: Props) {
  const { usuario } = await exigirUsuario("/admin/aviso-mac");
  if (!(await ehAdmin(usuario))) notFound();
  const q = await searchParams;
  const contas = await contasComMacTravado();
  const faltam = contas.filter((c) => !c.avisada);
  const exemplo = contas[0] ?? { email: usuario.email, nome: usuario.nome, macs: ["MacBook Pro"] };
  const previa = emailAtualizarMac(exemplo.email, exemplo.nome, exemplo.macs);
  const enviados = Number(q.enviados ?? NaN);
  const falharam = Number(q.falharam ?? 0);

  return (
    <Moldura larga titulo="Macs com o Atualizar travado" acao={<MenuConta admin sair={false} />}>
      <Link href="/admin" className="toque mb-6 inline-flex items-center gap-1.5 text-[15px] text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden />
        Admin
      </Link>

      {Number.isFinite(enviados) ? (
        <Aviso tom={falharam ? "erro" : "ok"} className="mb-8">
          <p>
            {enviados === 1 ? "1 e-mail saiu." : `${enviados} e-mails saíram.`}
            {falharam ? ` ${falharam} não saíram (Resend): eles entram no próximo clique.` : ""}
          </p>
        </Aviso>
      ) : null}

      <p className="mb-8 max-w-[70ch] text-[15px] leading-relaxed text-ink-2">
        Até o build {CORRECAO_ATUALIZAR_MAC - 1}, o Atualizar do Mac travava quando sobrava uma troca anterior em Aplicativos. Quem está nessas versões só
        sai baixando o instalador uma vez. Essas contas também veem um aviso no alto de Sua conta. Cada conta recebe o e-mail uma vez só.
      </p>

      <div className="xl:grid xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] xl:items-start xl:gap-x-8">
        <Secao titulo={`${contas.length} ${contas.length === 1 ? "conta" : "contas"}`} id="contas" descricao={faltam.length ? `${faltam.length} ainda sem o e-mail.` : "Todas já receberam o e-mail."}>
          <Card className="mb-4 overflow-hidden">
            {contas.length ? (
              <ul className="divide-y divide-line">
                {contas.map((c) => (
                  <li key={c.id} className="flex items-baseline justify-between gap-3 px-5 py-3 text-[15px]">
                    <span className="min-w-0">
                      <Link href={`/admin/pessoa/${encodeURIComponent(c.id)}`} className="font-medium hover:underline">
                        {c.nome}
                      </Link>
                      <span className="block truncate text-[13px] text-ink-3">{c.macs.join(", ")}</span>
                    </span>
                    <span className="shrink-0 text-[13px] text-ink-3">{c.avisada ? "e-mail enviado" : "sem e-mail"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-4 text-[15px] text-ink-2">Nenhum Mac antes do build {CORRECAO_ATUALIZAR_MAC}.</p>
            )}
          </Card>
          {faltam.length ? (
            <form action={acaoAvisarMacs}>
              <button type="submit" className="toque h-11 rounded-full bg-primary px-5 text-[15px] font-semibold text-primary-fg hover:opacity-90">
                Mandar para {faltam.length === 1 ? "1 conta" : `${faltam.length} contas`}
              </button>
            </form>
          ) : null}
        </Secao>

        <div className="mt-12 xl:mt-0">
          <Secao titulo="O e-mail" id="email" descricao={`Assunto: ${previa.assunto}`}>
            <Card className="overflow-hidden">
              <iframe title="Prévia do e-mail" srcDoc={previa.html} sandbox="" className="block h-[720px] w-full bg-white" />
            </Card>
          </Secao>
        </div>
      </div>
    </Moldura>
  );
}
