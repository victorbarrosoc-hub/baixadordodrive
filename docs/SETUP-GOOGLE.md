# Configurar o Google para o SOBEDESCE

Passo a passo para criar a **sua chave de acesso** ao Google Drive. É feito uma vez só e leva uns dez minutos.

**Por que precisa disso?** O SOBEDESCE não tem servidor: ele fala com o Google direto do seu computador. Para o Google aceitar, cada pessoa usa um "projeto" próprio no Google Cloud, com uma chave que só ela tem. Isso é **gratuito** e deixa a cota de uso só para você.

Os menus abaixo estão como aparecem no **Google Cloud Console em 2026**, em português e, entre parênteses, em inglês. Se o seu console estiver em inglês, siga os nomes entre parênteses.

> **Dica:** use a mesma conta Google que você vai conectar no SOBEDESCE. Se for usar o Drive de uma empresa (Google Workspace), entre com a conta da empresa.

---

## 1. Criar o projeto

1. Abra **[console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate)**.
2. **Nome do projeto** (Project name): `SOBEDESCE` (qualquer nome serve).
3. **Organização / Local** (Organization / Location): deixe como está.
4. Clique em **Criar** (Create) e espere a notificação de que o projeto foi criado.
5. Confira, no seletor de projetos no topo da página, se o projeto **SOBEDESCE** está selecionado. Todos os passos seguintes valem para o projeto selecionado ali.

O Google pode pedir para aceitar os Termos de Serviço do Cloud na primeira vez. Não é preciso cadastrar cartão de crédito.

## 2. Ativar a Google Drive API

1. Abra **[console.cloud.google.com/apis/library/drive.googleapis.com](https://console.cloud.google.com/apis/library/drive.googleapis.com)**.
2. Clique em **Ativar** (Enable).

Se esquecer este passo, o SOBEDESCE avisa: "A Google Drive API não está ativada no seu projeto do Google Cloud".

## 3. Configurar a tela de consentimento

É a tela que aparece quando você conecta a conta ("SOBEDESCE quer acessar sua Conta do Google").

1. Abra **[console.cloud.google.com/auth/branding](https://console.cloud.google.com/auth/branding)** (menu **Google Auth Platform → Branding**).
2. Se for a primeira vez, aparece **"A Google Auth Platform ainda não foi configurada"** (Google Auth Platform not configured yet). Clique em **Começar** (Get started).
3. **Informações do app** (App Information):
   - **Nome do app** (App name): `SOBEDESCE`
   - **E-mail para suporte do usuário** (User support email): o seu.
   - **Próxima** (Next).
4. **Público-alvo** (Audience):
   - **Externo** (External): para contas Gmail pessoais. É o caso mais comum.
   - **Interno** (Internal): só aparece se a sua conta for de um **Google Workspace** (e-mail da empresa). Só pessoas da empresa conseguem conectar, mas **não há o aviso "app não verificado"** e **o acesso não expira a cada 7 dias**. Se puder escolher, prefira esta.
   - **Próxima** (Next).
5. **Informações de contato** (Contact Information): o seu e-mail. **Próxima** (Next).
6. **Concluir** (Finish): marque que concorda com a Política de Dados do Usuário dos Serviços de API do Google, clique em **Continuar** (Continue) e depois em **Criar** (Create).

## 4. Publicar o app (só para "Externo")

Um app novo nasce em **modo Teste** (Testing). Nesse modo, o Google **desconecta a sua conta a cada 7 dias**. Publicar resolve. Não é preciso pedir verificação ao Google para uso próprio.

1. Abra **[console.cloud.google.com/auth/audience](https://console.cloud.google.com/auth/audience)** (**Google Auth Platform → Público-alvo** / Audience).
2. Em **Usuários de teste** (Test users), clique em **Adicionar usuários** (Add users), coloque o seu e-mail e salve. Isso garante o acesso enquanto o app ainda está em Teste.
3. Em **Status de publicação** (Publishing status), clique em **Publicar app** (Publish app) e confirme.
4. O status passa para **Em produção** (In production).

Se o Google pedir **página inicial, política de privacidade e domínio autorizado** antes de publicar (isso começou a aparecer em 2026), você tem duas saídas:

- **Preencher no Branding** (Google Auth Platform → Branding) com páginas suas, se tiver um site, e tentar de novo.
- **Ficar em modo Teste** e reconectar a conta uma vez por semana (Ajustes → Contas → Conectar de novo). Funciona, só é chato.

Quem escolheu **Interno** no passo 3 pula este passo inteiro.

## 5. Liberar o acesso ao Drive (escopo)

1. Abra **[console.cloud.google.com/auth/scopes](https://console.cloud.google.com/auth/scopes)** (**Google Auth Platform → Acesso a dados** / Data Access).
2. Clique em **Adicionar ou remover escopos** (Add or remove scopes).
3. Na lista, marque **`.../auth/drive`** ("Ver, editar, criar e excluir todos os seus arquivos do Google Drive"). Se não aparecer, cole `https://www.googleapis.com/auth/drive` em **Adicionar escopos manualmente** (Manually add scopes) e clique em **Adicionar à tabela** (Add to table).
4. Clique em **Atualizar** (Update) e depois em **Salvar** (Save).

Esse escopo aparece como "restrito". Para uso próprio isso não muda nada: só faz o Google mostrar o aviso de app não verificado na hora de conectar.

**Por que o acesso completo ao Drive?** Para baixar pastas que você não criou pelo SOBEDESCE, subir em qualquer pasta e comparar o que já está lá. O acesso fica só no seu computador.

## 6. Criar o cliente do computador e baixar o JSON

1. Abra **[console.cloud.google.com/auth/clients](https://console.cloud.google.com/auth/clients)** (**Google Auth Platform → Clientes** / Clients).
2. Clique em **Criar cliente** (Create client).
3. **Tipo de aplicativo** (Application type): **App para computador** (Desktop app).
4. **Nome** (Name): `SOBEDESCE Mac` (qualquer nome).
5. Clique em **Criar** (Create).
6. Na janela que abre, clique em **Fazer o download do JSON** (Download JSON). **Faça isso na hora:** depois que a janela fecha, o Google não mostra mais o segredo do cliente. Se perder, crie outro cliente.

O arquivo baixado se chama algo como `client_secret_1234…apps.googleusercontent.com.json` e vai para a pasta Downloads.

## 7. Colocar a chave no SOBEDESCE e conectar

1. Abra o SOBEDESCE. Na tela **Primeiros passos**, clique em **Já baixei o JSON**.
2. **Arraste o arquivo JSON** para a área indicada (ou clique nela e escolha o arquivo). Também dá para abrir o JSON, copiar todo o conteúdo e colar com ⌘V.
3. Clique em **Conectar com o Google**. O navegador abre a página do Google.
4. Escolha a conta.
5. Aparece **"O Google não verificou este app"** (Google hasn't verified this app). É esperado: o app é seu, com a sua chave.
   - Clique em **Avançado** (Advanced).
   - Clique em **Acessar SOBEDESCE (não seguro)** (Go to SOBEDESCE (unsafe)).
6. Na tela de permissões, **deixe marcado o acesso ao Google Drive** e clique em **Continuar** (Continue).
7. Aparece "Conta conectada". Volte para o SOBEDESCE: a conta já aparece no canto inferior esquerdo.

Para conectar outras contas, vá em **Ajustes → Contas → Adicionar conta**. A mesma chave serve para todas (no modo Teste, cada conta precisa estar em Usuários de teste).

---

## Para o celular pela internet: conta SOBEDESCE

O app do celular (`https://sobedesce.vercel.app/app/`) não faz mais login no Google: ele entra na conta SOBEDESCE e
pede ao site o token do Drive conectado à conta. Quem fala com o Google é o servidor do site, com o cliente
"Aplicativo da Web" oficial (redirect `https://sobedesce.vercel.app/api/google/callback`, variáveis em
[CONTAS.md](CONTAS.md#2-variáveis-de-ambiente-web)). No celular não há ID do cliente para colar. Para receber do
celular pelo Wi-Fi, nada disso é necessário.

---

## Problemas comuns

**"Erro 403: access_denied"** ao conectar
O app está em **modo Teste** e o e-mail que você escolheu não está na lista. Adicione em **Público-alvo → Usuários de teste** (Audience → Test users), ou publique o app (passo 4). Também acontece se você clicar em "Cancelar" na tela do Google.

**"O acesso a esta conta expirou. Conecte a conta de novo."** depois de uns dias (`invalid_grant`)
Quase sempre é o **modo Teste**: o Google corta o acesso **7 dias** depois de conectar. Publique o app (passo 4) e conecte de novo em **Ajustes → Contas**. Outras causas: você trocou a senha do Google, revogou o acesso em [myaccount.google.com/permissions](https://myaccount.google.com/permissions), ou ficou 6 meses sem usar.

**"O Google apagou ou desativou seu cliente OAuth"** (`deleted_client`)
O Google apaga clientes que ficam **6 meses sem uso**. Em **Google Auth Platform → Clientes**, veja se dá para restaurar (clientes apagados ficam um tempo recuperáveis). Se não der, crie outro cliente (passo 6) e troque em **Ajustes → Chave do Google → Trocar chave**.

**"Marque a permissão do Google Drive"**
Na tela de permissões do Google, a caixa do Google Drive ficou desmarcada. Conecte de novo e deixe marcada.

**"Sua chave não é do tipo App para computador"** (`unauthorized_client`)
O JSON é de um cliente "Aplicativo da Web". Para o computador, crie um cliente **App para computador** (passo 6).

**"O administrador do Google Workspace bloqueou este app"** (`admin_policy_enforced`)
A empresa restringe apps de terceiros. O administrador pode liberar o ID do cliente em **Admin → Segurança → Controles de API** (Security → API controls).

**"Limite diário da API do Google atingido"**
Raro em uso pessoal. Espere: o SOBEDESCE tenta de novo sozinho.
