# SOBEDESCE Celular (`/app/`)

App (PWA) para subir arquivos do iPhone/Android **direto para o Google Drive** e, na aba **Drive**, ver e baixar o
que já está lá (miniaturas, prévia com player e download). Mora no site com contas
(`web/`, Next.js) como arquivos estáticos em `web/public/app/`, servidos em **`/app/`**. Sem build: Preact + htm.
Os bytes vão do aparelho para `www.googleapis.com`; o site só diz quem está logado e entrega o token do Drive.

```
web/public/app/
  index.html, app.css, app.js       casca do app (caminhos relativos: servem em /app/ e em /m/ do Wi-Fi)
  lib/        config (endpoints, modo de teste, endereços da conta, ajustes) · auth (conta SOBEDESCE e token)
              drive (metadados) · uploader (motor de envio retomável) · idb (sessões no IndexedDB)
              lan (envio pelo Wi-Fi via computador) · wakelock · state · format · platform
              browse (listar, buscar, ordenar, tipos, proxy de câmera) · stream (ponte do token com o SW, miniaturas)
  components/ telas da conta (entrar, conectar Drive, escolher Drive, reconectar), principal e sheets
              (pasta de destino, ajustes, Drive, arquivo) · tabs (Enviar · Drive) · browser (aba Drive)
              thumb (miniatura e glifo) · preview (prévia em tela cheia) · player (vídeo e áudio)
  vendor/preact-htm.js   cópia de node_modules/htm/preact/standalone.module.js (Preact + htm num arquivo só)
  icons/      PNGs gerados a partir de build/icon.svg + favicon.svg
  sw.js       service worker com escopo /app/: casca com rede primeiro (nunca toca em /api) e /app/stream/<id>
              (prévia e download do Drive com o token; ver "Aba Drive")
  manifest.webmanifest   id, start_url e scope = /app/
web/public/sw.js         aposenta o service worker antigo (escopo "/") de quem instalou a versão 1
```

`web/next.config.ts` cuida do resto: `/app` → `/app/` (redirect), `/app/` → `/app/index.html` (rewrite) e os
cabeçalhos só de `/app/*` (CSP sem o Google Identity Services: `connect-src 'self' https://www.googleapis.com
https://*.googleusercontent.com`, `img-src 'self' data: blob: https://*.googleusercontent.com`, `media-src 'self'`,
`no-cache` na casca e no `sw.js`, ícones com cache longo). O redirecionamento automático de barra do Next fica
desligado (`skipTrailingSlashRedirect`) e é refeito, igual ao padrão, para todo o resto do site.

## Conta e token (contrato em [CONTAS.md](CONTAS.md))

- Ao abrir: `GET /api/eu` (cookie `sd_sessao`, mesma origem).
  - 401 → “Entre na sua conta SOBEDESCE”, com **Entrar** (`/entrar?volta=/app/`) e **Criar conta**
    (`/criar-conta?volta=/app/`).
  - Sem Drive → “Conecte um Google Drive na sua conta” (link para `/conta`, botão “Já conectei”).
  - Mais de um Drive → “Para qual Drive?”. A escolha fica no aparelho (`localStorage` `sobedesce.drive`) e troca em
    Ajustes → Google Drive. Com envios na fila, trocar pausa e recarrega (a fila é de um Drive só; as sessões
    ficam guardadas para quando voltar a esse Drive).
  - Drive em `reconectar` → “Reconecte o Google Drive” (link para `/conta`, “Usar outro Drive”, “Já reconectei”).
- Token: `POST /api/drive/token { conta }` → `{ accessToken, expiraEm, email }`, só em memória. Renova sozinho
  ~5 min antes de vencer e quando o Google devolve 401 (`renovar: true`). Sem popup e sem toque.
- 409 `reconectar` no meio do uso → os envios que precisam de token pausam e a tela principal mostra
  “Reconecte o Google Drive”. Ao voltar para a tela (foco, visibilidade e a cada 20 s), o app confere a conta;
  reconectado, continua sozinho o que pausou por isso.
- 401 no token → sessão do site acabou: volta para a tela de entrar. Sem rede ou 5xx → tenta de novo com recuo
  (pílula “Sem resposta da conta. Tentando de novo”).

## Rodar localmente

```bash
cd web && npx next dev -p 3102         # http://127.0.0.1:3102/app/
```

Com o servidor de contas de pé (`npm run dev`), entre em `/entrar` e conecte um Drive em `/conta`.

### Modo de teste (Drive falso)

Só em `127.0.0.1`/`localhost` (em qualquer outro host o parâmetro é ignorado):

```
http://127.0.0.1:3102/app/?dev_api=http://127.0.0.1:<porta-do-mock>
```

`dev_api` aponta a API do Drive para `<dev_api>/drive/v3` e `<dev_api>/upload/drive/v3` (http em loopback; a CSP
de desenvolvimento libera `http://127.0.0.1:*`). A conta e o token continuam vindo de `/api/eu` e
`/api/drive/token`: num teste com Playwright, simule com `page.route` e devolva tokens do Drive falso
(`mock.issueTokens().accessToken`; `mock.expireAccessTokens()` força o caminho do 401 → `renovar: true`). Nesse
modo o app expõe `window.__sobedesce` (estado e fila, sem token) e registra o service worker (é ele que faz a prévia e o download da aba Drive).

```js
import { startMockDrive } from './test/mock-drive.js'
const mock = await startMockDrive({ cors: true })
mock.addFolder('Projetos')
```

## Aba Drive (ver e baixar)

Embaixo, duas abas: **Enviar** (violeta, a tela de sempre) e **Drive** (azul). A aba Drive só existe com conta
(no modo Wi-Fi não aparece: lá o celular não tem token do Google).

- **Navegar:** Meu Drive, Compartilhados comigo (“Comigo”) e Drives compartilhados (“Drives”); trilha, voltar,
  grade com miniaturas ou lista (lembra no aparelho), busca por nome no lugar inteiro (o `name contains` do Drive
  casa o começo das palavras), puxar para atualizar e mais páginas ao rolar (60 por vez). Listas já abertas ficam em
  memória; com mais de 2 min, atualizam por trás.
- **Ordem e filtro (2.8.0):** uma fileira de chips logo abaixo da busca (rola de lado). O primeiro mostra a ordem
  atual (“Nome A→Z”, “Mais recentes”, “Maiores”, “Tipo A→Z”) e abre o menu: Nome, Modificado, Tamanho e Tipo
  (tocar de novo inverte; pastas sempre primeiro; fica salvo no aparelho, `sobedesce.browse`). O Drive não ordena por
  tipo: “Tipo” pede por nome, carrega a pasta toda (páginas de 200, “Carregando a pasta toda…”) e agrupa pela extensão
  no aparelho. Depois, Tudo · Vídeos · Fotos · Áudio · Pastas · Outros: o `q` do Drive filtra pelo `mimeType`
  (`filterQuery`), mas BRAW, R3D, ARRI e MXF chegam como `application/octet-stream`/`application/mxf`, então esses
  passam no `q` e a extensão decide no aparelho (`categoryOf`). Quando o filtro daqui esconde quase tudo, a tela segue
  carregando páginas (“Procurando…”) até ter o que mostrar ou a pasta acabar. Com filtro, a linha do tamanho vira
  “12 vídeos · 380 GB” (com “até aqui” e “Somar tudo” se a pasta ainda não carregou inteira). Se o Drive recusar o
  `q` do filtro (400), o app tira ele e filtra só no aparelho. O filtro volta para Tudo ao trocar de pasta.
- **Voltar de pasta (2.8.0):** cada pasta aberta é uma entrada do histórico (`history.pushState` com
  `{ sd: 'drive', scope, path, base }`), e a prévia aberta também: o gesto nativo do Safari e o botão voltar do
  Android voltam a pasta (ou fecham a prévia) em vez de sair do app; o `popstate` leva à pasta da entrada. A seta, a
  trilha e o gesto usam `history.go` quando a corrente de entradas está inteira (senão empilham uma nova).
- **Voltar arrastando (2.8.1):** em tela de toque, arrastar para a direita de **qualquer ponto** da tela volta uma pasta
  (`useSwipeBack`), como no iOS 26. A faixa de 24 px depois de `env(safe-area-inset-left)` fica para o gesto do
  sistema (Safari, app da Tela de Início no iOS 26, Android): na 2.8.0 o nosso começava lá e rodava junto com o do
  iPhone, e apareciam duas telas por trás. Se o sistema voltar no meio do nosso (`popstate`), o nosso desiste sem voltar
  outra vez. A tela acompanha o dedo e a pasta de cima aparece por trás (cabeçalho, trilha, busca e chips iguais aos
  de verdade, parallax de 30% e escurecimento). Soltou depois de 35% da largura ou a mais de 0,5 px/ms: termina com
  `--spring` e volta; senão, desliza de volta. Só trava depois de andar 12 px para a direita e mais para o lado do que
  para baixo (1,4×); para a esquerda ou na vertical é rolagem. Não começa em campo de texto nem em faixa já rolada de
  lado (chips, trilha). Com “reduzir movimento”, nada se mexe no arrasto: ao soltar além do limite, só volta. Na raiz,
  na busca e com a prévia aberta, nada.
- **Arquivos do Mac** (`._*`, `.DS_Store`): ocultos por padrão, com a linha “38 arquivos do Mac ocultos · Mostrar ·
  Limpar”. Limpar abre uma folha de confirmação que lista a pasta toda e só move para a lixeira do Drive
  (`files.update` com `trashed: true`, `supportsAllDrives`; recuperável por 30 dias) os que começam com `._` **e** têm
  menos de 4 MB. Mostra o progresso, para ao fechar a folha e explica a recusa (sem permissão: num Drive
  compartilhado, só quem gerencia o conteúdo manda para a lixeira). Nada é apagado de vez.
- **Tamanho das pastas** (`lib/tamanho.js`, `folderSize` em `lib/browse.js`): o Drive não guarda, então o app soma
  a árvore direto no Google (4 listagens de cada vez, `files(id,mimeType,size)`, 1000 por página, sem lixeira, atalhos
  não seguidos, Docs do Google contam 0). Abrir uma pasta começa sozinho e mostra “Calculando… 1.234 arquivos · 412 GB”
  no topo; pronto, “412,3 GB · 1.234 arquivos em 56 pastas” com Recalcular. Mais de 20 mil itens ou 30 s: “…+” e
  Parar. Na lista, “Calcular” ao lado de cada subpasta (sob pedido; vira “Pasta · 174 GB”). Uma conta por pasta,
  guardada enquanto a página está aberta; sair da pasta ou da aba esquece as que ainda andavam.
- **Miniaturas:** `thumbnailLink` com o sufixo trocado pelo tamanho certo (`=sNNN`, em pixels de tela), só quando
  o item chega perto da tela (IntersectionObserver), no máximo 6 ao mesmo tempo, cache em memória. Ordem:
  `<img>` direto sem Referer → se falhar, `fetch` com `Authorization` → `blob:` (e passa a usar esse caminho) →
  ícone do tipo com a extensão (BRAW, MXF…). **Falta confirmar com o Google de verdade** se o `thumbnailLink`
  abre sem sessão do Google no Safari e se aceita o token por CORS; o app funciona nos dois casos (no pior, ícones).
- **Prévia** (tela cheia, arrasta para baixo fecha, para o lado passa de arquivo, Esc/setas no teclado):
  vídeo e áudio no player próprio (play/pause, barra arrastável com o trecho carregado, tempo, mudo, 1x/1,5x/2x,
  tela cheia — no iPhone é a do próprio `<video>`), foto grande (miniatura `=s` no tamanho da tela; sem ela, a foto
  em si até 60 MB) com pinça e toque duplo, e os dados (tamanho, duração, resolução, câmera, data). Formato que o
  navegador não toca (MXF, BRAW, R3D, ARRI, ProRes que falhar…): miniatura grande + “Este formato não toca no
  navegador”. Se o `<video>` falha, o app pergunta ao SW o motivo (formato, reconectar, sessão, sem acesso, rede).
- **Proxy de câmera:** bruto que não toca procura, ao abrir a prévia, um `.mp4`/`.mov`/`.m4v` com o mesmo nome-base
  na mesma pasta ou numa subpasta irmã `Proxy`/`Proxies` (uma consulta das subpastas por pasta, em cache, e uma
  `files.list` por nome). Achou: toca o proxy no mesmo player, com o selo “Proxy” e “Prévia em baixa resolução. O
  Baixar traz o original.” O **Baixar** continua sendo o original. Na grade, bruto sem miniatura usa a do proxy
  quando ele já é conhecido (mesma pasta na tela ou prévia aberta antes).
- **Prévia leve:** vídeo com mais de 30 MB (qualquer codec) procura o mesmo proxy **antes** de tocar (a cópia H.264
  720p que o app de computador grava em `Proxy/<nome>.mp4`, `appProperties.sobedesce = 'previa'`, ou o da câmera) e
  toca ele por padrão, com **Proxy | Original** no canto do player (troca no mesmo ponto). `FILE_FIELDS` pede
  `appProperties`.
- **Toca ao abrir (2.8.4):** vídeo e áudio começam sozinhos ao abrir a prévia (`autoPlay`, `preload="auto"`, então
  já vai carregando). Se o navegador barrar o som automático, toca sem som e o botão de som fica na barra. Não há mais
  aviso de “vídeo pesado demais” nem “Tentar mesmo assim”: o 4K de câmera toca o original direto e, se a rede não der
  conta, o player só espera carregar.
- **Carregando com a marca (2.8.6):** enquanto o vídeo quer tocar e ainda não tem dados (ou parou para carregar), o
  player mostra as duas barras do ícone como medidor (`BufferMark`): a violeta enche de baixo para cima e a azul de
  cima para baixo, na proporção dos próximos 4 s já carregados, com um brilho correndo dentro delas. Embaixo, a
  porcentagem e “começa em ~N s” (pela velocidade com que o trecho carregado cresce, média móvel a cada 300 ms);
  antes dos primeiros bytes, “conectando…”. Pausado (autoplay barrado), some e o play volta.
- **Player do Drive (2.8.5):** o Drive toca rápido porque usa a cópia leve que ele mesmo gera (a API só entrega o
  original). Vídeo **pesado** (taxa acima de 40 Mbit/s no celular, 200 no computador) **sem proxy** e aberto para
  “qualquer pessoa com o link” (`permissionIds` com `anyoneWithLink`, conferido junto com a busca do proxy): a prévia
  mostra o player do próprio Drive num iframe sem sandbox (`drive.google.com/file/d/<id>/preview`, CSP `frame-src
  https://*.google.com https://*.googleusercontent.com`: com a conta Google no aparelho ele passa por
  accounts.google.com, e bloquear o desvio deixava o quadro branco no iPhone; a moldura tem pelo menos 300 px de
  altura, a mínima do player no celular, senão a barra e os controles saem cortados), com “Reprodução em baixa resolução.” e o botão “Tocar o original” embaixo. Fechado:
  toca o original (o iframe pediria login do Google, que o iPhone não leva para dentro do app); liberar o link pela
  prévia troca para o player do Drive na hora (evento `sd-link-aberto`). Com proxy, continua o nosso player com Proxy | Original.
- **Tela cheia (2.8.8):** espremido na prévia, o player do Drive não dava para usar (no iPhone os toques caíam na
  engrenagem e nos controles dele, mesmo com 300 px). Agora a prévia mostra a miniatura com o play do app e, tocou, o
  player abre em **tela cheia** (`.gfull`, um nó direto no `body`, fora do transform da prévia), com um X para fechar
  (Esc também). “Reprodução em baixa resolução.” e “Tocar o original” continuam embaixo da miniatura.
- **Tela bloqueada (2.8.9):** quem toca põe na tela bloqueada e na Central de Controle o **nome do take** (sem a
  extensão), a **pasta** (ou a coleção de Referências) e a **miniatura** (`lib/now-playing.js`, Media Session API).
  A miniatura vira um JPEG `data:` de até 512 px; os botões de lá (play, pausa, ±10 s, arrastar) comandam o nosso
  player. Na tela cheia do Drive o nome e a miniatura também são enviados, mas quem manda nos botões é o player dele.
- **Pedidos do computador (2.8.13):** a folha "No computador" mostra os **pedidos** (lotes) como a tela Transferências
  do app de computador: título ("Pasta "ZRO""), arquivos e tamanho, barra, "3 baixando · 5 na fila" / "1 concluído · 8
  cancelados", conferência ("1 de 1 conferido (MD5)"), velocidade e quanto falta, ou "há 59 min" quando terminou. Filtros
  Tudo · Em andamento · Na fila · Concluídas · Com problema; tocar abre os arquivos daquele pedido. Vem de `lotes` no
  retrato (docs/CONTAS.md §9); app de computador antigo (sem `lotes`) continua com as listas "Agora" e "Já passou".
- **Copiar de um link (2.8.11):** botão de link no topo da aba Drive (`components/copiar.js`, `lib/copiar.js`). Cola o
  link de uma pasta ou arquivo do Drive de outra pessoa (compartilhado com a conta ou liberado para quem tem o link,
  com `resourcekey` quando o link traz), “Ver o que tem” mostra nome, dono, arquivos, subpastas e tamanho, e o destino
  sai da pasta aberta (Meu Drive ou Drive compartilhado) ou do seletor de pastas (`FolderSheet` com `onChoose`, botão
  “Copiar para”). A cópia é do Google (`files.copy`, 3 por vez): nada passa pelo celular. Pasta do link vira uma pasta
  com o mesmo nome no destino, subpastas recriadas. Ficam de fora os arquivos com cópia bloqueada pelo dono
  (`capabilities.canCopy`) e os atalhos; Drive cheio ou limite diário param a cópia com o motivo. Numa pasta em
  “Comigo”, o mesmo botão copia aquela pasta. Link do Drive compartilhado do app do Drive (Android) abre direto aqui.
  O estado fica em `copia`: a folha fecha e reabre no meio, e o botão mostra “12/32” enquanto copia. Tela ligada
  durante a cópia; se o app sair da tela, pausa.
- **Baixar** (no topo, azul), **Abrir no Drive** e **Compartilhar** (Web Share, com o link do Drive). Acima de 1 GB
  avisa antes: no celular a tela precisa ficar aberta, e no computador o app SOBEDESCE baixa muito mais rápido.
  Documentos do Google não têm bytes: só “Abrir”.

### Streaming pelo service worker (`/app/stream/<id>?s=<tamanho>&t=<tipo>&n=<nome>&k=<chave>[&download=1]`)

`<video>`, `<audio>`, `<img>` e links não mandam `Authorization`. A página aponta para `/app/stream/<id>` e o
`sw.js` busca `files/<id>?alt=media&supportsAllDrives=true` com `Authorization: Bearer` e o mesmo `Range`,
devolvendo o corpo em streaming (206 com `Content-Range`, `Accept-Ranges: bytes`, `Cache-Control: no-store`; nada
vai para o cache). O Safari só toca vídeo se o servidor responder Range com 206. Se o Google não deixar ler o
`Content-Range` (CORS), o SW refaz pelo pedido + tamanho (`s`). Com `download=1`, `Content-Disposition: attachment`
com o nome em UTF-8 (RFC 6266); o Baixar é uma navegação para esse endereço (sem o atributo `download`: no Chromium
o download com `download` + resposta do SW era cancelado).

**Segurança (achado A1 da revisão, 2.5.1):** o arquivo é de quem subiu, não nosso, então o SW nunca deixa ele virar
página do site:
- **Só mídia ou fetch da página.** Navegação (link aberto numa aba, iframe) recebe 403, a não ser o Baixar
  (`download=1`, `destination: document`). Fora da navegação, só `destination` `video`, `audio`, `image`, `track`
  ou vazio (`fetch()`).
- **Tipo:** fora do Baixar, só `video/*`, `audio/*` e `image/*` sem SVG passam (inline). O resto (HTML, SVG,
  XHTML...) e todo Baixar saem como `application/octet-stream` + `attachment`.
- **Cabeçalhos em toda resposta do stream** (inclusive erro): `Content-Security-Policy: sandbox; default-src 'none'`,
  `Cross-Origin-Resource-Policy: same-origin`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`.
- **Chave da aba (`k`):** `lib/stream.js` sorteia 128 bits por abertura do app e põe em todo endereço. O SW manda a
  chave no pedido de token (`sd-token`), a página só responde com o token se a chave for a dela e devolve a chave na
  resposta; o SW ignora resposta sem a chave certa (aba da versão antiga) e guarda o token por chave. Pedido com
  `clientId` pergunta só àquela aba; sem `clientId` (navegação do Baixar, player do Safari) pergunta às abas do app.
  Link de fora não tem a chave e não usa o token de ninguém. Aba aberta da 2.5.0 depois do SW novo: a prévia falha
  até reabrir o app.

O token **não fica guardado**: o SW pede à página (`postMessage` com `MessageChannel`, tipo `sd-token`; quem
responde é `lib/stream.js` com o `getToken()` de sempre) e guarda só na memória dele, que some quando o navegador
o põe para dormir. 401 do Google → pede de novo mandando o token velho (`stale`), a página invalida e renova. A
página só pode apontar o SW para `https://www.googleapis.com/drive/v3` (ou, em 127.0.0.1, para um Drive falso em
loopback). Sem SW no controle (primeira abertura muito rápida, navegador sem SW) a prévia pede para reabrir o app.
O SW agora também é registrado no modo de teste (`?dev_api=`), porque é ele que faz o streaming.

**Falta testar num iPhone de verdade:** Safari tocando pelo SW (Range/206), download salvando em Arquivos (no app
da Tela de Início também) e quanto tempo o iOS deixa o SW vivo num download grande.

### Teste automatizado da aba Drive

Fora do repositório, com Playwright: `next dev`, `/api/eu` e `/api/drive/token` por `page.route`, o Drive falso
(`test/mock-drive.js`, `cors: true`) atrás de um “Google” de teste que acrescenta `thumbnailLink` (algumas só com
token), metadados de vídeo/foto e Compartilhados comigo. Vídeos de verdade gerados com ffmpeg; o Chromium do
Playwright não tem H.264, então o MP4 do teste é VP9/Opus (no iPhone, H.264/HEVC tocam normalmente).

## Aba Referências

Para quem tem `recursos.referencias` em `/api/eu`, uma terceira aba (contrato em [REFERENCIAS.md](REFERENCIAS.md) §7):
coleções do site (`/api/referencias/*`, cookie), arquivos de cada pasta lidos do Drive com o token de sempre
(`lib/referencias.js`), prévia e player da aba Drive (`Preview` aceita `extra` para a origem, o autor e a legenda),
“Salvar link” para a fila do computador e o `share_target` do Android (`/app/?compartilhar=1`). `/app/#referencias`
abre direto nela.

## No computador (acompanhar o que ficou passando no computador)

Contrato em [CONTAS.md](CONTAS.md) §9. `lib/computador.js` lê `GET /api/transferencias` depois de entrar na conta: a
cada 5 s com a tela à vista quando algum computador está enviando/baixando ou a folha está aberta, a cada 30 s parado,
nada com a página escondida (volta ao aparecer). A idade da notícia usa o relógio do servidor (`agora`).

- **Cartão** no topo da tela Enviar (`components/computador.js`, `ComputerCard`) quando algum computador tem algo
  andando/pausado ou terminou nas últimas 24 h: "MacBook de Victor · ● · 62% · 5 de 8 arquivos · faltam ~14 min" com a
  barra fina (violeta subindo, azul baixando, verde pronto, vermelho erro); "+1" se houver outro.
- **Folha "No computador"** (`ComputerSheet`, sheet `computador`): por computador, ligado/sem notícia, o total (%,
  arquivos, bytes, velocidade, quanto falta), "Agora" (cada arquivo com seta ↑/↓, destino, barra e velocidade) e "Já
  passou" (ok/erro, tamanho, há quanto tempo). Sem notícia há mais de 2 min com algo pela metade: "Sem notícia há
  12 min — o computador pode estar desligado ou sem internet." (ou "o SOBEDESCE foi fechado", se ele avisou).
  `/app/#computador` abre direto (link de Sua conta e toque no aviso).
- **Avisar no celular quando terminar:** chave na folha. Pede a permissão, inscreve pelo `pushManager` do service
  worker com a chave pública que vem em `/api/transferencias` e manda a inscrição para `POST /api/push/inscricao`
  (desligar: `DELETE` + `unsubscribe`). Com permissão dada, a inscrição é reenviada a cada abertura. No iPhone, fora da
  Tela de Início, a chave fica desligada com a dica de instalar (o Safari só deixa pedir notificação no app instalado,
  iOS 16.4+). O `sw.js` mostra o aviso (`push`) e, no toque (`notificationclick`), foca o app aberto e pede a folha
  (`postMessage { type: 'sd-computador' }`) ou abre `/app/#computador`.

**Falta testar num iPhone/Android de verdade:** a permissão e o aviso chegando com o app fechado (iPhone com o app na
Tela de Início), o toque abrindo a folha, e se o iOS mantém a inscrição depois de dias sem abrir o app.

## Mandar para… (celular ↔ computador e celular ↔ celular, direto no Wi-Fi)

Contrato e protocolo em [CELULAR-WIFI.md](CELULAR-WIFI.md). No app: `lib/p2p.js` (espera longa em `/api/p2p/espera`,
lista em `/api/p2p/aparelhos`, sinais em `/api/p2p/sinal`, WebRTC), `lib/p2p-canal.js` (protocolo, igual ao do
computador), `lib/p2p-util.js` (contas puras, `test/celular-wifi-app.test.js`), `lib/p2p-gravar.js` (worker que grava
no OPFS com `createSyncAccessHandle`) e `components/p2p.js` (bloco "Mandar para…" no Início, folhas `p2pEnvio` e
`p2pReceber`, chave "Aceitar de outras pessoas por perto", também em Ajustes; guardada em `sobedesce.p2p.outros`).
Receber sempre pede Aceitar. O que chega fica no OPFS (sem OPFS: na memória, até 1 GB) até Salvar (`navigator.share`
com o arquivo, ou download) e some ao Fechar; sobras de uma recepção interrompida saem ao abrir o app. A espera longa
nunca é cortada no meio (um sinal entregue a um pedido cortado se perderia): a chave nova vale na próxima, em até 25 s.

## Modo Wi-Fi (via computador)

O SOBEDESCE do computador serve esta mesma casca (lida de `web/public/app/`) em `http://<ip>:4319/m/?t=<código>`
(Ajustes → Celular, `src/mobile/receiver.js`). Lá o `index.html` ganha um `lan-config.js` antes do app, que define
`window.__SOBEDESCE_LAN__`; com ele (`LAN` em `lib/config.js`) não há conta nem Google no celular: pastas vêm de
`/m/api/folders`, o arquivo vai em pedaços (`PUT /m/api/uploads/:id` + `Upload-Offset`, transporte em `lib/lan.js`)
e retoma pelo ponto que o computador confirma. Sem service worker e sem manifesto nesse modo. Por isso a casca usa
caminhos relativos. O `electron-builder.yml` empacota essas pastas.

## Atualizar o Preact/htm

```bash
npm install                      # na raiz do repositório
cp node_modules/htm/preact/standalone.module.js web/public/app/vendor/preact-htm.js
```

O arquivo é versionado de propósito: o app não tem build. A cópia atual é a do htm 3.1.1.

## Ícones

`icons/icon-192.png` e `icons/icon-512.png` são o `build/icon.svg` como está (ladrilho arredondado, fundo
transparente). `icons/apple-touch-icon.png` (180 px) e `icons/icon-maskable-512.png` usam o mesmo desenho
“sangrado” (fundo até a borda; iOS e Android aplicam a máscara). Foram renderizados com Playwright/Chromium a
partir do SVG; se o ícone mudar, renderize de novo nos mesmos tamanhos.

## Decisões do motor de envio

- **Sessão retomável por arquivo**, pedaços de 8 MiB e 2 arquivos ao mesmo tempo. Em Ajustes há uma escolha só,
  **Sua rede**: “Rede do celular” (padrão: 2 arquivos, 8 MiB) ou “Wi-Fi rápido” (4 arquivos, 16 MiB). Por baixo
  ficam gravados os mesmos `concurrency`/`chunkMiB` de antes (`sobedesce.settings`); valores antigos com 3 ou mais
  arquivos juntos aparecem como Wi-Fi rápido. Pedaços sempre múltiplos de 256 KiB. `Blob.slice` é preguiçoso: a memória fica baixa mesmo com arquivos de GBs.
- **Rede ruim no set (automático, 2.7.0):** sem `navigator.connection` no Safari do iPhone, o app decide pelo que
  acontece (`NetWatch` em `lib/uploader.js`). Duas quedas de rede em 5 min (vários arquivos caindo juntos, dentro de
  15 s, contam como uma) ligam o modo: 1 arquivo por vez (fica andando o que falta menos; os outros voltam para a
  fila e continuam de onde pararam), pedaço de no máximo 4 MiB (teto por cima do Automático e também de um tamanho
  fixo de Ajustes, porque é proteção) e os menores primeiro. 10 min sem queda desligam. O medidor mostra “Rede
  instável: subindo um por vez”.
- **PUTs na sessão vão sem `Authorization`.** A URI da sessão é a credencial (documentação do Drive). Assim um
  token que vence no meio de um arquivo grande não para o envio; só conferir o destino e abrir sessões novas
  esperam o token. Se o Google responder 401 num PUT, aquela sessão passa a mandar o token.
- **Range ilegível (CORS):** o Google expõe `Range` nas respostas 308 e o app o lê. Se o navegador não conseguir
  ler, o app trata como “desconhecido”, faz uma consulta de status (`Content-Range: bytes */TOTAL`) e, se ainda
  assim não houver Range legível, assume o fim do pedaço — só quando aquele PUT terminou com 308. Se a suposição
  falhar (o Google responde 400), recomeça o arquivo numa sessão nova: mais lento, nunca corrompe. Detalhes no
  topo de `lib/uploader.js`.
- **Retomada depois de recarregar:** a sessão (URI + data) fica no IndexedDB, por nome + tamanho + data de
  modificação + pasta, por até 6 dias. O item aparece como “Pausado — escolha o arquivo de novo”; ao reescolher,
  o app pergunta ao Google quanto já chegou e continua dali.
- **Duplicados:** antes de abrir a sessão, procura na pasta um arquivo com o mesmo nome e tamanho → “Já estava no
  Drive” (com “Enviar mesmo assim”, que sobe outra cópia).
- A URI da sessão nunca vai para o console nem para a tela.

## Limitações conhecidas no iPhone

- **Segundo plano:** o iOS suspende a página e corta a rede quando o Safari sai da tela ou o aparelho bloqueia.
  O envio pausa e, ao voltar, o app consulta o Google e continua de onde parou. A trava de tela acesa (Wake Lock)
  funciona no Safari 16.4+; em apps da Tela de Início ela só passou a valer em versões mais novas do iOS
  (18.4), por isso o aviso “Mantenha esta tela aberta”.
- **Fototeca:** escolher pela Fototeca pode converter o vídeo (ex.: HEVC → H.264) e cada escolha gera um arquivo
  com data nova; aí a retomada depois de recarregar não reconhece o arquivo e o envio recomeça do zero. Pelo app
  **Arquivos** o original vem intacto e a retomada funciona. Arquivos do iCloud que não estão no aparelho são
  baixados pelo iOS antes de o app recebê-los.
- **App instalado tem memória própria:** o app da Tela de Início não vê os cookies nem o `localStorage` do Safari.
  Quem entrar no Safari e depois instalar precisa entrar de novo no app instalado (a dica de instalação na tela de
  entrar sugere instalar antes). Falta confirmar num iPhone que `/entrar` e `/conta`, fora do escopo `/app/`,
  devolvem o login para dentro do app instalado.
- **Quem instalou a versão 1** (na raiz do site) tem um atalho que abre `/`. O `web/public/sw.js` desliga o
  service worker antigo; o atalho em si precisa ser refeito a partir de `/app/`.
- `beforeunload` (aviso ao sair com envios em andamento) não é confiável no iOS.
