import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Check, Info, Laptop, Mail, Send } from "lucide-react";
import { Aviso } from "@/components/conta/aviso";
import { MenuConta } from "@/components/conta/menu";
import { Moldura } from "@/components/conta/moldura";
import { BotaoGrande, Destaque, Item, Pagina, Passo, Vazio } from "@/components/kit/kit";
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

      <Pagina
        lado={
          <>
            <Destaque
              titulo="Macs travados"
              numero={contas.length}
              unidade={contas.length === 1 ? "conta" : "contas"}
              linha={faltam.length ? `${faltam.length} ainda sem o e-mail` : contas.length ? "Todas já receberam o e-mail" : "Ninguém antes do build " + CORRECAO_ATUALIZAR_MAC}
            />
            {faltam.length ? (
              <form action={acaoAvisarMacs} className="grid gap-3">
                <BotaoGrande dica="Cada conta recebe uma vez só.">
                  <Send aria-hidden />
                  Mandar para {faltam.length === 1 ? "1 conta" : `${faltam.length} contas`}
                </BotaoGrande>
              </form>
            ) : null}
          </>
        }
      >
        <Passo icone={<Info />} tom="warn" i={1} titulo="O que aconteceu">
          <p className="text-[15px] leading-relaxed text-pretty text-ink-2">
            Até o build {CORRECAO_ATUALIZAR_MAC - 1}, o Atualizar do Mac travava quando sobrava uma troca anterior em Aplicativos. Quem está nessas versões só sai
            baixando o instalador uma vez. Essas contas também veem um aviso no alto de Sua conta.
          </p>
        </Passo>

        <Passo
          icone={<Laptop />}
          tom="down"
          i={2}
          id="contas"
          titulo={`${contas.length} ${contas.length === 1 ? "conta" : "contas"}`}
          frase={faltam.length ? `${faltam.length} ainda sem o e-mail.` : "Todas já receberam o e-mail."}
        >
          {contas.length ? (
            <ul className="grid gap-2">
              {contas.map((c) => (
                <li key={c.id}>
                  <Item
                    href={`/admin/pessoa/${encodeURIComponent(c.id)}`}
                    icone={<Laptop />}
                    tom={c.avisada ? "ok" : "warn"}
                    titulo={c.nome}
                    sub={c.macs.join(", ")}
                    fim={<span className="text-[13px] text-ink-3">{c.avisada ? "e-mail enviado" : "sem e-mail"}</span>}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <Vazio icone={<Check />} titulo="Nenhum Mac travado">
              Nenhum Mac antes do build {CORRECAO_ATUALIZAR_MAC}.
            </Vazio>
          )}
        </Passo>

        <Passo icone={<Mail />} tom="up" i={3} id="email" titulo="O e-mail" frase={`Assunto: ${previa.assunto}`}>
          <div className="overflow-hidden rounded-2xl ring-1 ring-line">
            <iframe title="Prévia do e-mail" srcDoc={previa.html} sandbox="" className="block h-[720px] w-full bg-white" />
          </div>
        </Passo>
      </Pagina>
    </Moldura>
  );
}
