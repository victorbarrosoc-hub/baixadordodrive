import type { Metadata } from "next";
import Link from "next/link";
import { LegalList, LegalPage, LegalSection } from "@/components/site/legal";
import { CONTATO_EMAIL, ROTAS } from "@/lib/site";

export const metadata: Metadata = {
  title: "Termos de Uso",
  description: "As regras de uso da SOBEDESCE: conta, conteúdo, Google Drive, versão de teste e responsabilidades.",
  alternates: { canonical: "/termos" },
};

function Email() {
  return <a href={`mailto:${CONTATO_EMAIL}`}>{CONTATO_EMAIL}</a>;
}

export default function TermosPage() {
  return (
    <LegalPage
      title="Termos de Uso"
      intro={
        <p>
          Estes termos valem para quem usa a SOBEDESCE: o site, a versão de celular e o app de computador. Ao criar uma conta ou usar o app, você concorda
          com eles e com a <Link href={ROTAS.privacidade} className="font-medium text-down-text underline-offset-2 hover:underline">Política de Privacidade</Link>.
        </p>
      }
    >
      <LegalSection title="O que é a SOBEDESCE">
        <p>
          Uma ferramenta para baixar e enviar arquivos grandes do Google Drive, com várias conexões em paralelo, pausa e retomada, comparação de pastas e
          conferência de cada arquivo. As transferências acontecem entre o seu aparelho e o Google.
        </p>
      </LegalSection>

      <LegalSection title="Versão de teste">
        <p>
          O app de computador está em versão de teste e ainda não tem assinatura da Apple nem da Microsoft. Ele pode ter falhas. Por isso, uma regra de
          ouro: <strong>não apague o original</strong> (o cartão, o disco, a pasta) antes de conferir que a cópia chegou inteira ao destino.
        </p>
        <p>
          A SOBEDESCE ainda não passou pela verificação do Google. Por isso, ao conectar o Drive, o Google mostra um aviso antes de liberar o acesso.
        </p>
      </LegalSection>

      <LegalSection title="A sua conta">
        <LegalList>
          <li>Use dados verdadeiros e uma senha que você não usa em outro lugar.</li>
          <li>Você responde pelo que é feito com a sua conta e com os aparelhos que você conecta a ela.</li>
          <li>
            Se achar que alguém entrou na sua conta, troque a senha, desconecte os aparelhos que não reconhece e escreva para <Email />.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="O seu conteúdo">
        <p>
          Os arquivos são seus. A SOBEDESCE não fica com nenhum direito sobre eles e não acessa o conteúdo. Você precisa ter o direito de copiar e
          transferir o que manda, e não pode usar a SOBEDESCE para nada ilegal ou para violar direitos de outras pessoas.
        </p>
      </LegalSection>

      <LegalSection title="Referências">
        <p>
          As Referências guardam no seu Drive vídeos e fotos de outras pessoas para você estudar e se inspirar. Salve só para referência dos seus projetos e
          respeite os direitos de quem criou: não publique de novo, não venda e não use como se fosse seu sem autorização. Baixar de cada plataforma também
          segue as regras dela.
        </p>
        <p>
          O link pra IA de uma coleção abre para qualquer pessoa que tiver o endereço. Ligue só quando quiser compartilhar, e desligue ou troque quando
          quiser que ele pare de abrir.
        </p>
      </LegalSection>

      <LegalSection title="O Google Drive">
        <p>
          O uso do Drive continua seguindo os termos e os limites do Google, como o limite de 750 GB de envio por dia em cada conta. Quando o Google recusa
          por limite, a SOBEDESCE espera e tenta de novo. A SOBEDESCE não é afiliada ao Google.
        </p>
      </LegalSection>

      <LegalSection title="Disponibilidade e mudanças">
        <p>
          Trabalhamos para o serviço funcionar sempre, mas não garantimos que ele nunca vá parar. Podemos mudar, melhorar ou encerrar recursos. Quando uma
          mudança afetar o seu uso, avisamos antes, sempre que possível.
        </p>
      </LegalSection>

      <LegalSection title="Responsabilidade">
        <p>
          A SOBEDESCE é oferecida como está. Na medida permitida pela lei, não respondemos por perdas causadas por falhas da internet, do Google, do disco
          ou do aparelho, nem por arquivos apagados antes de conferidos. Nada aqui tira direitos que a lei brasileira garante a você.
        </p>
      </LegalSection>

      <LegalSection title="Encerramento">
        <p>
          Você pode parar de usar e apagar a conta quando quiser, na hora, pelo botão Apagar minha conta em Sua conta (veja{" "}
          <Link href={`${ROTAS.privacidade}#desconectar`}>como desconectar e apagar</Link>). Podemos suspender uma conta que viole estes termos.
        </p>
      </LegalSection>

      <LegalSection title="Lei aplicável">
        <p>Estes termos seguem as leis do Brasil.</p>
      </LegalSection>

      <LegalSection title="Contato">
        <p>
          Dúvidas sobre estes termos: <Email />.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
