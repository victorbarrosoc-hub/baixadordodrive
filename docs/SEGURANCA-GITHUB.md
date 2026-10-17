# Segurança do lado do GitHub (o que o Victor faz)

O app de desktop se atualiza sozinho a partir do Release `versao-de-teste`, e o site mostra o `versao.json`
que está lá. Quem consegue mexer no repositório ou no CI consegue, em tese, trocar o instalador de todo mundo
(revisão de segurança, achado A8). O workflow (`.github/workflows/desktop.yml`) já foi fechado:

- **Só leitura por padrão** (`permissions: contents: read`). Escrita só nos três jobs que publicam no Release:
  `app` (sobe os instaladores, só na `main`), `versao` (sobe o `versao.json`, só na `main`) e `release` (tags `v*`).
- **Actions fixadas pelo SHA do commit**, com a tag ao lado (`# v4.4.0`). Uma tag movida por quem invadir o
  repositório da action não muda o que roda aqui. Para atualizar: `git ls-remote --tags https://github.com/<dono>/<action>`,
  copie o SHA da tag nova e troque o SHA e o comentário juntos.
- **Token fora do `.git/config`** (`persist-credentials: false`): o `npm ci` e os scripts do build não acham o token ali.
- Continua igual: só a `main` publica no Release; branches `claude/**` só geram instalador com `[build]` no commit,
  como artefato.

Falta a parte que só o dono da conta faz, no site do GitHub. Leva uns 10 minutos.

## 1. Ligar a verificação em duas etapas (2FA), de preferência com chave de acesso

1. github.com → foto no canto → **Settings** → **Password and authentication**.
2. Em **Two-factor authentication**, **Enable**. Use um app autenticador (1Password, Google Authenticator).
3. Em **Passkeys**, **Add a passkey** (Touch ID do Mac ou do iPhone). É o que mais protege contra phishing.
4. Guarde os **recovery codes** num lugar fora do computador (cofre de senhas ou papel).
5. Faça o mesmo na **Vercel** (Account Settings → Authentication) e no **Google** da conta que administra o projeto.

## 2. Proteger a `main`

1. No repositório → **Settings** → **Rules** → **Rulesets** → **New ruleset** → **New branch ruleset**.
2. Nome: `main protegida`. **Enforcement status**: Active.
3. **Target branches** → **Add target** → **Include default branch**.
4. Marque:
   - **Restrict deletions**;
   - **Block force pushes**;
   - **Require a pull request before merging** (pode deixar 0 aprovações: o que importa é ninguém, nem um token
     vazado, empurrar direto para a `main`);
   - **Require status checks to pass** → adicione **Testes do motor** (o workflow roda nos pushes da `main` e das
     branches `claude/**`; um PR de branch com outro nome ficaria esperando esse teste).
5. **Bypass list**: deixe vazia. Se precisar de uma saída de emergência, ponha só você ("Repository admin")
   com **Allow for pull requests only**.
6. **Create**.

Os agentes do Claude já trabalham em branches `claude/...` e abrem PR, então nada muda para eles.

## 3. Restringir quem roda workflows

1. **Settings** → **Actions** → **General**.
2. **Actions permissions**: **Allow <seu usuário>, and select non-<seu usuário>, actions and reusable workflows**,
   marque **Allow actions created by GitHub** e, em **Allow specified actions**, escreva:
   `softprops/action-gh-release@*`
3. **Fork pull request workflows** (se o repositório for público): **Require approval for all external contributors**.
4. **Workflow permissions**: **Read repository contents and packages permissions** (o padrão do token fica só
   leitura; o workflow pede escrita só onde precisa). Desmarque **Allow GitHub Actions to create and approve pull
   requests**.
5. **Save** em cada bloco.
6. **Settings** → **Collaborators**: confira que só quem precisa tem acesso de escrita.

## Por que a assinatura do `versao.json` ficou de fora

A proposta (A8, esforço M) é assinar o `versao.json` com uma chave Ed25519 (minisign) guardada **fora** do
GitHub e da Vercel, e pôr a chave pública dentro do app e dos scripts `instalar.sh`/`instalar.ps1`. Ficou para
depois porque:

- **Mexe em três lugares de outros agentes ao mesmo tempo**: o Atualizar do app de desktop (`src/updater.js`),
  os instaladores de uma linha (`web/public/`) e o CI. Esta rodada só mexeu no site e no workflow.
- **A assinatura não pode ser feita pelo CI.** Se a chave privada ficar num segredo do GitHub, quem invade o
  GitHub assina também, e a proteção some. O jeito certo é o Victor assinar no próprio Mac a cada versão
  (um comando), o que muda a rotina de publicar e precisa ser combinado.
- **Precisa de uma transição**: os apps já instalados não conhecem a chave. Primeiro sai uma versão que traz a
  chave pública e aceita `versao.json` sem assinatura; só depois a assinatura vira obrigatória.

Enquanto isso, o que esta rodada fechou (permissões, SHAs, token fora do disco) e os três passos acima tiram os
caminhos mais baratos: dependência de build com token de escrita, action de terceiro trocada por tag e push
direto na `main` com uma senha vazada.
