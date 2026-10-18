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
            entrou e o último uso. Assim você vê e desconecta cada um. Enquanto o pedido de um computador espera a sua liberação, guardamos o endereço IP
            e a cidade e o país aproximados de onde ele veio, para mostrar na tela de liberar. Isso some junto com o pedido, em até um dia.
          </li>
          <li>
            <strong>Sessão:</strong> um cookie essencial mantém você conectado no site. No banco fica só um hash dele. Não usamos cookies de publicidade nem
            ferramentas de rastreamento.
          </li>
          <li>
            <strong>Aparelhos que já entraram:</strong> um cookie essencial (<code className="font-mono text-[14px]">sd_aparelho</code>) guarda um número
            aleatório que identifica o navegador, sem nome, e-mail ou lugar. No banco fica só um hash desse número, ligado à sua conta, para avisar por
            e-mail quando ela abre num aparelho novo. Some depois de 400 dias sem uso ou quando você apaga a conta.
          </li>
          <li>
            <strong>Segurança:</strong> para impedir abuso, registramos por pouco tempo as tentativas de entrar, de criar conta e de pedir senha nova
            (e-mail e endereço IP, com data e hora). Esses registros são apagados depois.
          </li>
          <li>
            <strong>Referências:</strong> o nome de cada coleção e a pasta dela no seu Drive, os links que você manda para o computador baixar (com a nota,
            se escrever uma) e, se usar o Atalho do iPhone, só o hash da chave dele. Os vídeos ficam no seu Drive, não com a gente.
          </li>
          <li>
            <strong>Acompanhar pelo celular:</strong> se o ajuste “Acompanhar pelo celular” estiver ligado no app de computador (vem ligado), ele manda à
            sua conta o andamento das transferências daquele computador: os nomes dos arquivos que estão passando e dos últimos que passaram, o tamanho, o
            progresso, a velocidade e o nome da pasta de destino. Guardamos só o último retrato de cada computador, para você ver no celular. Ele é apagado
            quando o computador fica 7 dias sem mandar notícia, quando você desliga o ajuste, desconecta o computador ou apaga a conta.
          </li>
          <li>
            <strong>Avisos no celular:</strong> se você ligar “Avisar no celular quando terminar”, guardamos a inscrição de notificações do seu aparelho (um
            endereço do serviço de notificações da Apple, do Google, da Mozilla ou da Microsoft e as chaves que cifram a mensagem). Mandamos por ele só o
            aviso de fim de transferência, com o nome do computador, a quantidade de arquivos e o tamanho. Desligar o aviso ou apagar a conta apaga a
            inscrição.
          </li>
          <li>
            <strong>Uso do serviço:</strong> para saber como a SOBEDESCE está sendo usada e achar problemas, guardamos os dias em que você usou e por onde
            (site, app do celular ou app de computador), a hora do último uso e o número da versão do app de computador. O app de computador manda também,
            por dia, só números: quanto subiu e desceu, quantos arquivos, quantos deram erro, o tamanho do maior e o tempo transferindo. Nunca nomes de
            arquivos ou pastas. Isso fica 400 dias e sai junto com a conta.
          </li>
          <li>
            <strong>Senha nova:</strong> quando você usa “Esqueci a senha” ou cria a primeira senha, guardamos só o hash do link enviado. Ele vale por uma
            hora e é apagado depois de usado ou vencido.
          </li>
        </LegalList>
        <p>
          <strong>O que não guardamos:</strong> o conteúdo dos seus arquivos e a sua fila de transferências. A fila do app de computador fica no próprio
          computador (na pasta <code className="font-mono text-[14px]">.sobedesce</code>), e a do celular fica no próprio aparelho. Os nomes dos arquivos
          só chegam até nós no retrato do “Acompanhar pelo celular”, descrito acima, e por no máximo 7 dias.
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
          <li>conferir a impressão digital (MD5) de cada arquivo transferido;</li>
          <li>
            nas Referências, criar, renomear e pôr na lixeira as pastas das suas coleções e, quando você liga o link pra IA de uma coleção, ler o nome e a
            descrição dos arquivos dessa pasta para montar a página do link.
          </li>
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
          serviço para nós: a Vercel (hospedagem do site), a Neon (banco de dados) e a Resend (envio dos e-mails da conta: o link de senha nova, a
          confirmação de conta apagada e os avisos de segurança descritos abaixo; ela recebe o seu e-mail, o seu nome e o texto da mensagem). Os avisos no celular passam pelo serviço de notificações do seu navegador (Apple, Google, Mozilla ou Microsoft), cifrados de ponta a ponta. E, claro, no Google,
          quando você conecta o Drive.
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
            <strong>Apagar a conta:</strong> em Sua conta, no fim da página, toque em Apagar minha conta e confirme com a sua senha. Na hora, tiramos o
            acesso de cada Drive no Google, desconectamos os computadores e apagamos a conta, as contas Google conectadas, os tokens e as sessões. Mandamos
            uma confirmação por e-mail. Os arquivos no seu Google Drive continuam lá.
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
        <p>Mandamos um aviso por e-mail quando:</p>
        <LegalList>
          <li>
            a conta abre num aparelho ou navegador que ela ainda não tinha usado, com a senha ou com o Google. O aviso diz quando, o navegador e o
            sistema, e a cidade e o país aproximados, que vêm da rede de quem entrou (o endereço IP não vai no e-mail);
          </li>
          <li>a senha é trocada, refeita pelo link de Esqueci a senha ou criada pela primeira vez;</li>
          <li>o Google que abre a conta é trocado ou removido;</li>
          <li>um computador é liberado na conta;</li>
          <li>alguém erra a senha da conta muitas vezes e a entrada com senha fica pausada (no máximo um aviso por dia).</li>
        </LegalList>
        <p>Esses avisos são parte da segurança da conta e não levam senha, código nem link de acesso.</p>
      </LegalSection>

      <LegalSection title="Por quanto tempo">
        <p>
          Guardamos os dados da conta enquanto ela existir. O andamento das transferências de um computador fica no máximo 7 dias depois da última
          notícia dele. Os registros de uso por dia ficam 400 dias. Quando você remove um Drive, os tokens dele são apagados. Quando você apaga a conta, apagamos
          tudo o que está ligado a ela na mesma hora. Cópias de segurança automáticas dos provedores podem levar alguns dias para sair do ciclo.
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
