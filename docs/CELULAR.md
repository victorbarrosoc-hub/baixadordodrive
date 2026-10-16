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
  grade com miniaturas ou lista (lembra no aparelho), ordem por nome/data/tamanho (tocar de novo inverte; pastas
  sempre primeiro), busca por nome no lugar inteiro (o `name contains` do Drive casa o começo das palavras),
  puxar para atualizar e mais páginas ao rolar (60 por vez). Listas já abertas ficam em memória; com mais de 2 min,
  atualizam por trás.
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
  1080p que o app de computador grava em `Proxy/<nome>.mp4`, `appProperties.sobedesce = 'previa'`, ou o da câmera) e
  toca ele por padrão, com **Prévia leve | Original** no canto do player (troca no mesmo ponto). O aviso de vídeo
  pesado só aparece quando não há cópia. `FILE_FIELDS` pede `appProperties`.
- **Baixar** (no topo, azul), **Abrir no Drive** e **Compartilhar** (Web Share, com o link do Drive). Acima de 1 GB
  avisa antes: no celular a tela precisa ficar aberta, e no computador o app SOBEDESCE baixa muito mais rápido.
  Documentos do Google não têm bytes: só “Abrir”.

### Streaming pelo service worker (`/app/stream/<id>?s=<tamanho>&t=<tipo>&n=<nome>[&download=1]`)

`<video>`, `<audio>`, `<img>` e links não mandam `Authorization`. A página aponta para `/app/stream/<id>` e o
`sw.js` busca `files/<id>?alt=media&supportsAllDrives=true` com `Authorization: Bearer` e o mesmo `Range`,
devolvendo o corpo em streaming (206 com `Content-Range`, `Accept-Ranges: bytes`, `Cache-Control: no-store`; nada
vai para o cache). O Safari só toca vídeo se o servidor responder Range com 206. Se o Google não deixar ler o
`Content-Range` (CORS), o SW refaz pelo pedido + tamanho (`s`). Com `download=1`, `Content-Disposition: attachment`
com o nome em UTF-8 (RFC 6266); o Baixar é uma navegação para esse endereço (sem o atributo `download`: no Chromium
o download com `download` + resposta do SW era cancelado).

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
