import type { Metadata } from "next";
import { LegalList, LegalPage, LegalSection } from "@/components/site/legal";
import { CONTATO_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Política de Privacidade",
  description: "Que dados a SOBEDESCE guarda, para que usa o acesso ao Google Drive e como desconectar ou apagar a sua conta.",
  alternates: { canonical: "/privacidade" },
};

const USER_DATA_POLICY = "https://developers.google.com/terms/api-services-user-data-policy";

function Email() {
  return <a href={`mailto:${CONTATO_EMAIL}`}>{CONTATO_EMAIL}</a>;
}

export default function PrivacidadePage() {
  return (
    <LegalPage
      title="Política de Privacidade"
      intro={
        <p>
          A SOBEDESCE transfere arquivos grandes entre o seu computador ou celular e o Google Drive. Esta página explica que dados guardamos, para que usamos
          o acesso ao seu Drive e como você desconecta tudo quando quiser. Vale para o site, para a versão de celular e para o app de computador quando ele
          entra na sua conta.
        </p>
      }
    >
      <LegalSection title="O resumo">
        <LegalList>
          <li>Os seus arquivos vão do seu aparelho direto para o Google. O conteúdo não passa pelos servidores da SOBEDESCE.</li>
          <li>Usamos o acesso ao Drive só para as transferências e comparações que você pede.</li>
          <li>Não vendemos, não alugamos e não compartilhamos os seus dados.</li>
          <li>Você desconecta um Drive ou apaga a conta quando quiser.</li>
        </LegalList>
      </LegalSection>

      <LegalSection title="Que dados guardamos">
        <LegalList>
          <li>
            <strong>Conta:</strong> nome, e-mail e senha. A senha fica guardada só como hash (scrypt, com sal). Ninguém consegue ler a sua senha a partir
            dele, nem nós.
          </li>
          <li>
            <strong>Contas Google conectadas:</strong> o identificador da conta Google, e-mail, nome e foto do perfil, as permissões que você concedeu e os
            tokens de acesso do Google. Os tokens ficam cifrados (AES-256-GCM) no nosso banco de dados.
          </li>
          <li>
            <strong>Aparelhos conectados:</strong> o nome de cada computador que entrou na sua conta (por exemplo, “MacBook Pro de Ana”), o sistema, quando
            entrou e o último uso. Assim você vê e desconecta cada um.
          </li>
          <li>
            <strong>Sessão:</strong> um cookie essencial mantém você conectado no site. No banco fica só um hash dele. Não usamos cookies de publicidade nem
            ferramentas de rastreamento.
          </li>
          <li>
            <strong>Segurança:</strong> para impedir abuso, registramos por pouco tempo as tentativas de entrar e de criar conta (e-mail e endereço IP, com
            data e hora). Esses registros são apagados depois.
          </li>
        </LegalList>
        <p>
          <strong>O que não guardamos:</strong> o conteúdo dos seus arquivos, os nomes deles e a sua fila de transferências. A fila do app de computador
          fica no próprio computador (na pasta <code className="font-mono text-[14px]">.sobedesce</code>), e a do celular fica no próprio aparelho.
        </p>
        <p>
          Os provedores que hospedam o serviço podem registrar dados técnicos de acesso, como endereço IP e horário, em registros de segurança e
          funcionamento.
        </p>
      </LegalSection>

      <LegalSection title="Para que usamos o acesso ao Google Drive">
        <p>
          Quando você conecta um Google Drive, o Google pede a sua permissão para a SOBEDESCE “ver, editar, criar e excluir todos os seus arquivos do Google
          Drive” (escopo <code className="font-mono text-[14px]">https://www.googleapis.com/auth/drive</code>). Pedimos esse acesso porque as transferências
          precisam funcionar em qualquer pasta que você escolher, inclusive em drives compartilhados.
        </p>
        <p>Usamos o acesso só para fazer o que você pede:</p>
        <LegalList>
          <li>listar as pastas e os arquivos que você abre para escolher o que baixar ou para onde enviar;</li>
          <li>baixar os arquivos e pastas que você marca;</li>
          <li>enviar os arquivos que você escolhe e criar as pastas de destino;</li>
          <li>comparar uma pasta do computador com uma pasta do Drive, quando você pede;</li>
          <li>conferir a impressão digital (MD5) de cada arquivo transferido.</li>
        </LegalList>
        <p>
          Também usamos a identificação da conta Google (e-mail, nome e foto) para mostrar qual Drive está conectado e, se você quiser, para entrar com o
          Google.
        </p>
        <p>
          O servidor da SOBEDESCE guarda o token de renovação do Google cifrado e entrega aos seus aparelhos conectados um token de acesso de curta duração.
          Com ele, o aparelho fala direto com o Google.
        </p>
        <p>
          Nenhuma pessoa da SOBEDESCE lê os dados do seu Drive. Não usamos dados do Google para publicidade nem para treinar modelos de inteligência
          artificial.
        </p>
      </LegalSection>

      <LegalSection title="Os seus arquivos não passam pelos nossos servidores">
        <p>
          No computador e no celular, os bytes dos arquivos vão do aparelho direto para os servidores do Google, e voltam do Google direto para o aparelho.
          Os servidores da SOBEDESCE cuidam só da conta, do login e do acesso aos seus Drives.
        </p>
        <p>
          Na recepção pelo Wi-Fi, o celular manda os arquivos para o seu computador, na sua rede local, e o computador sobe para o Drive. Também aqui nada
          passa por nós.
        </p>
      </LegalSection>

      <LegalSection title="Uso Limitado dos dados do Google">
        <p>
          O uso e a transferência de informações recebidas das APIs do Google seguem a{" "}
          <a href={USER_DATA_POLICY} target="_blank" rel="noopener noreferrer">
            Política de Dados do Usuário dos Serviços de API do Google
          </a>
          , incluindo os requisitos de Uso Limitado.
        </p>
      </LegalSection>

      <LegalSection title="Com quem compartilhamos">
        <p>
          Com ninguém, para nenhum fim comercial. Não vendemos, não alugamos e não compartilhamos os seus dados. Eles ficam em provedores que operam o
          serviço para nós: a Vercel (hospedagem do site) e a Neon (banco de dados). E, claro, no Google, quando você conecta o Drive.
        </p>
        <p>Só entregaríamos dados se uma lei ou ordem judicial obrigasse.</p>
      </LegalSection>

      <LegalSection id="desconectar" title="Como desconectar e apagar">
        <LegalList>
          <li>
            <strong>Desconectar um Drive:</strong> em Sua conta, clique em Remover Drive. Apagamos os tokens daquela conta Google.
          </li>
          <li>
            <strong>Tirar o acesso pelo Google:</strong> em{" "}
            <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">
              myaccount.google.com/permissions
            </a>
            , escolha SOBEDESCE e remova o acesso. A SOBEDESCE deixa de conseguir usar aquele Drive na hora.
          </li>
          <li>
            <strong>Desconectar um computador:</strong> em Sua conta, na lista de computadores conectados.
          </li>
          <li>
            <strong>Apagar a conta:</strong> escreva para <Email /> a partir do e-mail da conta. Apagamos a conta, as contas Google conectadas, os tokens e
            as sessões em até 15 dias e confirmamos por e-mail.
          </li>
          <li>
            <strong>No computador:</strong> os dados do app ficam na pasta <code className="font-mono text-[14px]">.sobedesce</code> da sua pasta de
            usuário. Apagar essa pasta remove tudo do computador.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="Segurança">
        <p>
          Todo o tráfego usa HTTPS. Senhas ficam só como hash, os tokens do Google ficam cifrados e o cookie de sessão não pode ser lido por scripts da
          página. Sessões do site vencem depois de 30 dias sem uso, e as dos computadores, depois de 180 dias sem uso.
        </p>
      </LegalSection>

      <LegalSection title="Por quanto tempo">
        <p>
          Guardamos os dados da conta enquanto ela existir. Quando você remove um Drive, os tokens dele são apagados. Quando você apaga a conta, apagamos
          tudo o que está ligado a ela.
        </p>
      </LegalSection>

      <LegalSection title="Os seus direitos">
        <p>
          Pela Lei Geral de Proteção de Dados (Lei 13.709/2018), você pode pedir a confirmação de que tratamos os seus dados, o acesso a eles, a correção, a
          portabilidade, a eliminação e informações sobre com quem compartilhamos, além de revogar o consentimento. Peça por <Email />.
        </p>
      </LegalSection>

      <LegalSection title="Mudanças nesta política">
        <p>
          Se esta política mudar, a versão nova aparece aqui com a data de atualização no alto da página. Mudanças importantes também são avisadas por
          e-mail.
        </p>
      </LegalSection>

      <LegalSection title="Contato">
        <p>
          Dúvidas sobre privacidade: <Email />.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
