# SOBEDESCE

**Baixa e sobe arquivos gigantes no Google Drive na velocidade que a sua internet aguenta.** Feito para quem trabalha com audiovisual: brutos de câmera, masters em ProRes, pastas de projeto com centenas de gigas.

- **Baixa uma pasta inteira** do Drive (inclusive de drives compartilhados), com várias conexões por arquivo.
- **Sobe pastas do computador** mantendo a estrutura de subpastas.
- **Pausa e continua de onde parou**, mesmo depois de fechar o app, reiniciar o Mac ou a internet cair.
- **Confere cada arquivo** (MD5) para garantir que chegou idêntico ao original.
- **Compara uma pasta do computador com uma pasta do Drive** e mostra, pasta por pasta, o que já subiu e o que falta.
- **Recebe arquivos do celular** pelo Wi-Fi (o iPhone manda para o Mac, e o Mac sobe para o Drive).

Os arquivos vão direto entre a sua máquina e o Google: **nenhum byte passa por servidor no meio**. Com a **conta SOBEDESCE**, o site ([sobedesce.vercel.app](https://sobedesce.vercel.app)) só guarda o acesso aos seus Drives; quem preferir pode conectar um Drive só no computador, com a própria chave do Google.

---

## Por que é mais rápido que o navegador

- **Download em pedaços paralelos.** Cada arquivo baixado vem por 8 conexões ao mesmo tempo (ajustável até 32). Uma conexão sozinha com o Google raramente passa de 30–60 MB/s; várias juntas enchem um link de 1 Gbps ou mais. Quando uma conexão termina o seu pedaço, ela pega metade do maior pedaço que falta, então todas trabalham até o último byte.
- **Conexões lentas são refeitas.** Às vezes o Google segura uma conexão; o SOBEDESCE percebe e reabre.
- **Vários arquivos ao mesmo tempo no upload.** O Google recebe cada arquivo em sequência, a uns **40–100 MB/s por arquivo**. Subir 4 arquivos juntos (o padrão) enche 1 Gbps.
- **Nada recomeça do zero.** O progresso vai para o disco a cada 2 segundos. Se cair, continua do último ponto confirmado.

---

## Instalar no Mac

1. **Baixe o instalador (.dmg)**:
   - **Releases:** na página do projeto no GitHub, abra **Releases** e baixe o `SOBEDESCE-…-mac-universal.dmg` da versão mais recente.
   - **Versão de teste:** no GitHub, abra **Releases** → **SOBEDESCE · versão de teste** → baixe `SOBEDESCE-…-mac-universal.dmg`.
2. **Abra o .dmg e arraste o SOBEDESCE para a pasta Aplicativos.**
3. **Primeira abertura.** O app ainda não tem assinatura da Apple, então o macOS bloqueia na primeira vez:
   - Tente abrir o SOBEDESCE normalmente e feche o aviso.
   - Vá em **Ajustes do Sistema → Privacidade e Segurança**, role até o fim e clique em **"Abrir Mesmo Assim"**. Confirme com a senha do Mac.
   - Das próximas vezes ele abre direto.
4. **Se aparecer "SOBEDESCE está danificado e não pode ser aberto"**: não está. É o macOS desconfiando de app baixado da internet sem assinatura. Abra o **Terminal** e rode:

   ```bash
   xattr -cr /Applications/SOBEDESCE.app
   ```

   Depois abra de novo.

O mesmo `.dmg` funciona em Macs com Apple Silicon (M1, M2, M3, M4…) e com Intel.

## Instalar no Windows

1. **Baixe o instalador (.exe)**: em **Releases** → **SOBEDESCE · versão de teste** (ou uma versão numerada) → `SOBEDESCE-…-windows-setup.exe`.
2. **Abra o instalador.** Ele instala só para o seu usuário, sem pedir senha de administrador, e cria atalho na Área de Trabalho e no Menu Iniciar.
3. **Se o Windows mostrar "O Windows protegeu o computador" (SmartScreen):** clique em **Mais informações** → **Executar assim mesmo**. Aparece porque o app não tem certificado pago da Microsoft.
4. **Firewall:** se for receber arquivos do celular, na primeira vez o Windows pergunta se o SOBEDESCE pode usar a rede. Marque **Redes privadas** e permita.

---

## Entrar com a conta SOBEDESCE (o jeito simples)

1. Crie sua conta em [sobedesce.vercel.app](https://sobedesce.vercel.app) e, em **Conta**, clique em **Conectar Google Drive** (dá para conectar vários).
2. Abra o SOBEDESCE no computador e clique em **Entrar com a conta SOBEDESCE**. Aparece um código (tipo `ABCD-EFGH`) e o navegador abre na página de liberar o computador.
3. Confira se o código é o mesmo e libere. Pronto: os Drives da conta aparecem no app.

- O computador guarda só um token do aparelho (no arquivo `cloud.json` da pasta de dados, acessível só pelo seu usuário). O acesso ao Google fica no site e o app pede um token de cada vez.
- Se um Drive pedir **Reconectar** (o Google vence o acesso a cada 7 dias enquanto o app do Google está em modo Teste), reconecte em [sobedesce.vercel.app/conta](https://sobedesce.vercel.app/conta). O que estava na fila com ele fica pausado e continua sozinho quando a lista se atualiza (ao voltar para o app, a cada 5 minutos ou em **Ajustes → Conta SOBEDESCE → Atualizar**).
- **Sair da conta** (Ajustes) desconecta este computador. Desconectar o computador pelo site também tira os Drives daqui.

## Conectar um Drive só neste computador (opcional, uma vez só)

Quem prefere não usar a conta pode conectar um Drive direto, com uma **chave sua**. Nos Primeiros passos, clique em **Conectar um Drive só neste computador** (ou em Ajustes → Drives só neste computador). A chave é criada no Google Cloud (é gratuito). Assim a cota e o acesso ficam só com você. Leva uns dez minutos:

1. **Crie um projeto** no Google Cloud.
2. **Ative a Google Drive API.**
3. **Configure a tela de consentimento** (Google Auth Platform → Branding) e escolha o público **Externo** (ou **Interno**, se o seu e-mail for de um Google Workspace da empresa).
4. **Publique o app** (Público-alvo → Publicar app). Sem isso, o Google desconecta a sua conta a cada 7 dias.
5. **Libere o escopo do Drive** (Acesso a dados).
6. **Crie um cliente do tipo "App para computador"** e **baixe o JSON na hora**: o Google só mostra o segredo uma vez.
7. Abra o SOBEDESCE, **arraste o JSON** para a tela de Primeiros passos e clique em **Conectar com o Google**.

Na hora de conectar aparece **"O Google não verificou este app"**. É esperado: o app é seu, com a sua chave. Clique em **Avançado** → **Acessar SOBEDESCE (não seguro)**.

**Passo a passo completo, com os nomes dos menus em português e em inglês:** [docs/SETUP-GOOGLE.md](docs/SETUP-GOOGLE.md).

---

## Usar

### Baixar do Drive

- Abra **Drive** na barra lateral. Navegue pelo **Meu Drive** ou pelos **drives compartilhados** (as pílulas no topo). Dá para **buscar** pelo nome.
- **Marque arquivos ou pastas inteiras** e clique em **Baixar**. Em **Para**, escolha a pasta de destino (o padrão fica em Ajustes).
- Pastas vêm com todas as subpastas. Documentos, Planilhas e Apresentações do Google são exportados como `.docx`, `.xlsx` e `.pptx`.
- Enquanto baixa, o arquivo fica com a extensão `.sobedesce-part` ao lado do destino. Ele só ganha o nome final depois de conferido.

### Subir para o Drive

- No **Drive**, abra a pasta de destino e clique em **Enviar para esta pasta**. Ou, em **Transferências**, clique em **Enviar** e escolha a pasta do Drive depois.
- No app de desktop dá para **arrastar** arquivos e pastas do Finder/Explorer direto para a janela.
- Se o arquivo já existe no Drive com o mesmo conteúdo, ele é pulado ("Já estava no Drive"). Dá para mudar isso em **Ajustes → Arquivos**.

### Pausar, continuar, cancelar

- Em **Transferências**, passe o mouse sobre uma linha para ver os botões: **Pausar**, **Retomar**, **Cancelar**, **Passar na frente** (para itens na fila) e **Tentar de novo**.
- Cada lote (uma pasta, um envio) tem botões para **pausar ou cancelar tudo de uma vez**.
- **Fechou o app no meio?** Ao abrir de novo, ele continua sozinho de onde parou (dá para desligar em Ajustes → **Retomar ao abrir**).
- Cancelar um download apaga o pedaço já baixado daquele arquivo. Pausar não apaga nada.

### Comparar pastas

Para saber o que já subiu de um projeto:

1. Abra **Comparar**.
2. Em **No computador**, escolha a pasta do projeto. Em **No Drive**, a pasta correspondente.
3. Escolha o modo:
   - **Rápido:** compara nome e tamanho. Segundos, mesmo em pastas enormes.
   - **Completo:** confere o conteúdo (MD5) de cada arquivo. Lê tudo do disco na primeira vez; depois fica guardado.
4. Veja o resultado pasta por pasta: **Já no Drive**, **Falta subir**, **Diferentes** e **Só no Drive**.
5. **Subir o que falta** manda só o que não está lá. **Baixar o que só está no Drive** traz o que falta no computador (clique numa pasta da árvore para baixar só dela).

### Do celular para o Drive

**Pelo Wi-Fi (o celular manda para o computador, o computador sobe):**

1. No SOBEDESCE do computador, vá em **Ajustes → Celular** e ligue **Receber do celular**.
2. Aponte a câmera do iPhone para o **QR code**. Abre no Safari, já conectado ao computador, sem login do Google no celular.
3. Escolha os arquivos (pelo app **Arquivos** o vídeo vem original; pela Fototeca o iOS pode converter).
4. Eles chegam em `~/SOBEDESCE Recebidos` e entram na fila de envio para o Drive. Se o Wi-Fi cair, continua de onde parou.
5. Opcional: em Ajustes → Celular há o passo a passo de um **Atalho do iPhone** para mandar arquivos pelo botão Compartilhar de qualquer app.

O celular e o computador precisam estar **na mesma rede Wi-Fi**. Na primeira vez, o macOS pergunta se o SOBEDESCE pode aceitar conexões de entrada: clique em **Permitir**.

**Pela internet (sem o computador, direto do celular para o Google):** abra **https://sobedesce.vercel.app/app/** no celular e entre com a sua conta SOBEDESCE. O app usa os Google Drives conectados à conta (em **/conta**), sem login do Google no celular. Em **Ajustes → Celular → Em qualquer lugar** há um QR que abre esse endereço. Detalhes em [docs/CELULAR.md](docs/CELULAR.md).

---

## Dicas de velocidade

- **Cabo de rede em vez de Wi-Fi.** O Wi-Fi costuma ser o gargalo muito antes da internet.
- **Disco rápido no destino.** Um SSD (interno ou externo em USB-C/Thunderbolt) grava 500 MB/s ou mais. HD externo e pendrive ficam em 100–200 MB/s e seguram o download.
- **Formato do disco externo:** use **APFS** ou **exFAT**. Em FAT32 não cabem arquivos acima de 4 GB.
- **Arquivos ao mesmo tempo** (Ajustes → Velocidade):
  - **Download:** o padrão (3 arquivos × 8 conexões) enche 1 Gbps. Em 10 Gbps, suba para 6–8 arquivos e 12–16 conexões.
  - **Upload:** cada arquivo sobe a uns 40–100 MB/s no Google. 4 arquivos enchem 1 Gbps; em 10 Gbps, use 12–16.
- **Limite do Google: 750 GB de upload por dia, por conta.** Passou disso, o Google recusa por até 24 horas. O SOBEDESCE espera e retoma sozinho; a tela mostra quanto você já subiu nas últimas 24 h.
- **Muitos arquivos pequenos** (sequências EXR/DPX, fotos) sobem mais devagar que um arquivo grande do mesmo tamanho total: cada arquivo tem um custo fixo de alguns décimos de segundo no Google. Aumentar os uploads simultâneos ajuda.
- **Limite de banda** (Ajustes → Limite de banda) serve para não ocupar a internet do escritório inteiro.

---

## Solução de problemas

- **Um Drive da conta aparece com "Reconectar"**: o acesso do Google venceu (modo Teste: a cada 7 dias). Reconecte em [sobedesce.vercel.app/conta](https://sobedesce.vercel.app/conta); a fila continua sozinha.
- **"Sua sessão na conta SOBEDESCE terminou"**: este computador foi desconectado pelo site. Entre de novo em Ajustes → Conta SOBEDESCE.
- **"O Google não verificou este app"** ao conectar: esperado. **Avançado → Acessar SOBEDESCE (não seguro)**.
- **"Erro 403: access_denied"**: o app está em modo Teste e o seu e-mail não está na lista. Adicione em **Público-alvo → Usuários de teste**, ou publique o app.
- **A conta desconecta toda semana** ("O acesso a esta conta expirou"): o app está em modo Teste. Vá em **Público-alvo → Publicar app** e conecte de novo em Ajustes → Drives só neste computador.
- **"O Google apagou ou desativou seu cliente OAuth"**: clientes sem uso por 6 meses são apagados. Restaure em Google Auth Platform → Clientes (lixeira) ou crie outro e troque em **Ajustes → Chave do Google → Trocar chave**.
- **"Sem conexão" / "retoma às 14:32"**: a internet ou o Google caiu. Não precisa fazer nada: o SOBEDESCE tenta de novo sozinho (1, 2, 5, 10, 15 minutos). Para tentar agora, clique em **Tentar agora** na linha.
- **"Aguardando cota"**: limite de 750 GB/dia de upload, ou um arquivo baixado demais por outras pessoas (o Google bloqueia por algumas horas). Retoma sozinho.
- **"Disco cheio"** ou **"A pasta de destino sumiu"**: libere espaço ou reconecte o disco externo e clique em **Retomar**. Nada do que já baixou se perde.
- **"O conteúdo não bate com o original (MD5)"**: o arquivo chegou diferente. Clique em **Tentar de novo**. Se repetir, confira o cabo e o disco.
- **"O dono deste arquivo bloqueou downloads"**: o dono desativou o download no Drive. Só ele pode liberar.
- **O celular não acha o computador**: os dois precisam estar no mesmo Wi-Fi; redes de visitante e algumas redes corporativas isolam os aparelhos. Confira se o firewall liberou o SOBEDESCE.
- **O Mac dormiu?** Enquanto houver transferência, o SOBEDESCE impede o Mac de dormir (a tela pode apagar). Fechar a tampa do notebook sem monitor externo ainda faz ele dormir; ao acordar, tudo continua.
- **Onde ver o log**: no app de desktop, menu **Ajuda → Abrir pasta de logs** (arquivo `motor.log`).

---

## Onde ficam os seus dados

Tudo fica numa pasta do seu usuário: **`~/.sobedesce`** no Mac (pasta oculta; no Finder, ⇧⌘. mostra ocultos) e **`C:\Users\<você>\.sobedesce`** no Windows.

- `credentials.json`: a chave do seu cliente Google.
- `accounts.json`: o acesso aos Drives conectados só neste computador. **Só o seu usuário consegue ler** (permissão 600).
- `cloud.json`: o token deste computador na conta SOBEDESCE e a última lista de Drives dela (permissão 600; some ao sair da conta).
- `queue.json`: a fila de transferências e o ponto onde cada uma parou.
- `settings.json`, `hash-cache.json` (MD5 já calculados), `compares/` (últimas comparações), `usage.json` (uso das últimas 24 h).

**Privacidade:**

- Os arquivos **nunca passam por servidor nosso**: vão direto do computador para o Google. O app não coleta nada nem manda estatística.
- Com a conta SOBEDESCE, o site guarda (cifrado) o acesso aos Drives que você vinculou e entrega ao app um token de acesso por vez. Drives conectados só neste computador ficam só aqui.
- O acesso ao Drive usa o escopo `drive` (necessário para listar, baixar e subir em qualquer pasta).
- A interface roda em `http://127.0.0.1:4317`, visível só para este computador. A recepção do celular (quando ligada) abre uma porta na rede local, protegida por um código secreto que está no QR. Gerar um código novo derruba o antigo na hora.
- **Para remover tudo:** em Ajustes → Conta SOBEDESCE, **Sair da conta**; em Drives só neste computador, **Remover** (isso também revoga o acesso no Google) e apague a pasta `.sobedesce`. Para revogar por fora: [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

---

## Para desenvolvedores

Requer **Node.js 22** (mínimo 20.18).

```bash
npm install          # dependências (inclui Electron e electron-builder)
npm start            # motor + interface em http://127.0.0.1:4317 (abre o navegador)
npm run demo         # o app ligado a um Google Drive falso, com arquivos de exemplo (sem chave, sem internet)
npm test             # todos os testes (node:test; os lentos têm "slow" no nome)
npm run test:fast    # pula os lentos
npm run desktop      # app de desktop (Electron) a partir do código
```

- **Gerar os instaladores:** o GitHub Actions (`.github/workflows/desktop.yml`) gera o `.dmg` num Mac e o `.exe` num Windows na nuvem. Roda sozinho em pushes na `main`; em outras branches, só quando a mensagem do commit tem **`[build]`**. Os instaladores vão para o Release **SOBEDESCE · versão de teste** (Releases não gastam a cota de artefatos do Actions). Uma tag **`v*`** (ex.: `git tag v0.2.0 && git push --tags`) também publica um **Release** com os instaladores.
- Localmente: `npm run dist:mac` (precisa de um Mac) e `npm run dist:win`.
- Arquitetura, contratos e decisões: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Notas verificadas da API do Google: [docs/GOOGLE-NOTES.md](docs/GOOGLE-NOTES.md). App do celular: [docs/CELULAR.md](docs/CELULAR.md). Contas SOBEDESCE: [docs/CONTAS.md](docs/CONTAS.md).
- Variáveis úteis: `SOBEDESCE_HOME` (pasta de dados), `SOBEDESCE_PORT` (porta da interface), `SOBEDESCE_NO_OPEN=1` (não abre o navegador), `SOBEDESCE_DEBUG=1` (log detalhado do motor).
