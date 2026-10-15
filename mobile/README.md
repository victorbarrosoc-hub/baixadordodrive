# SOBEDESCE Celular

Site estático (PWA) para subir arquivos do iPhone/Android **direto para o Google Drive** do usuário. Os bytes vão
do aparelho para `www.googleapis.com`; a Vercel só serve estes arquivos estáticos. Sem build: Preact + htm.

```
mobile/
  index.html, app.css, app.js       casca do app
  lib/        config (endpoints, modo de teste, ID do cliente, ajustes) · auth (Google Identity Services)
              drive (metadados) · uploader (motor de envio retomável) · idb (sessões no IndexedDB)
              wakelock · state · format · platform
  components/ telas (Configurar, Entrar, principal) e sheets (pasta de destino, ajustes, arquivo)
  vendor/preact-htm.js   cópia de node_modules/htm/preact/standalone.module.js (Preact + htm num arquivo só)
  icons/      PNGs gerados a partir de build/icon.svg + favicon.svg
  sw.js       service worker (rede primeiro; nunca intercepta o Google)
  manifest.webmanifest, vercel.json (headers), dev-server.mjs (só desenvolvimento)
```

## Rodar localmente

```bash
node mobile/dev-server.mjs            # http://127.0.0.1:4320
```

O servidor aplica os mesmos headers do `vercel.json` (inclusive a CSP). Para entrar com uma conta Google de
verdade, o cliente OAuth precisa ter `http://127.0.0.1:4320` (ou `http://localhost:4320`) em
“Origens JavaScript autorizadas”.

### Modo de teste (sem Google)

Só em `127.0.0.1`/`localhost` — em qualquer outro host estes parâmetros são ignorados:

```
http://127.0.0.1:4320/?dev_api=http://127.0.0.1:<porta-do-mock>&dev_token=<token>
```

- `dev_api` aponta a API para `<dev_api>/drive/v3` e `<dev_api>/upload/drive/v3` (precisa ser http em loopback).
- `dev_token` substitui o login do Google. Quando o token toma 401, o app chama
  `window.__sobedesceDevRefresh({ interactive })` (o teste expõe com `page.exposeFunction`); devolver `null`
  sem `interactive` simula o iPhone bloqueando a renovação e faz aparecer a pílula “Toque para continuar conectado”.
- Use o Drive falso dos testes com CORS ligado:

```js
import { startMockDrive } from './test/mock-drive.js'
const mock = await startMockDrive({ cors: true })
mock.addFolder('Projetos')
const { accessToken } = mock.issueTokens()
console.log(`http://127.0.0.1:4320/?dev_api=${encodeURIComponent(mock.url)}&dev_token=${accessToken}`)
```

## Publicar na Vercel

| Ajuste do projeto   | Valor                                   |
| ------------------- | --------------------------------------- |
| Root Directory      | `mobile`                                |
| Framework Preset    | **Other**                               |
| Build Command       | vazio (sem build)                       |
| Install Command     | vazio                                   |
| Output Directory    | padrão (`.` — a própria pasta `mobile`) |
| Variáveis de ambiente | nenhuma                               |

O `vercel.json` define CSP, `Referrer-Policy`, `Permissions-Policy`, `X-Content-Type-Options`,
`Cross-Origin-Opener-Policy: same-origin-allow-popups` (necessário para o popup do Google), `no-cache` em
`/`, `/index.html` e `/sw.js`, revalidação em js/css e cache de 1 ano em `/icons/*`. O `.vercelignore` deixa
`README.md` e `dev-server.mjs` fora do deploy.

Depois do primeiro deploy, no Console do Google (mesmo projeto do app do computador):
**Google Auth Platform → Clientes → Criar cliente → Aplicativo da Web → Origens JavaScript autorizadas:**
o domínio de produção (ex.: `https://sobedesce.vercel.app`, sem barra no fim). URLs de *preview* da Vercel mudam
a cada deploy; cada uma precisaria ser adicionada — use o domínio de produção. O usuário precisa estar em
Público-alvo → Usuários de teste (ou o app publicado), como no app do computador.

### Pré-configurar pelo QR code

`https://<site>/?client_id=<ID>.apps.googleusercontent.com` grava o ID no aparelho e tira o parâmetro da barra
de endereço. O app do computador pode mostrar isso como QR code.

## Atualizar o Preact/htm

```bash
npm install                      # na raiz do repositório
cp node_modules/htm/preact/standalone.module.js mobile/vendor/preact-htm.js
```

O arquivo é versionado de propósito: a Vercel publica só a pasta `mobile/`, sem `node_modules`.
Depois de trocar, rode o teste ponta a ponta (abaixo) — a cópia atual é a do htm 3.1.1.

## Ícones

`icons/icon-192.png` e `icons/icon-512.png` são o `build/icon.svg` como está (ladrilho arredondado, fundo
transparente). `icons/apple-touch-icon.png` (180 px) e `icons/icon-maskable-512.png` usam o mesmo desenho
“sangrado” (fundo até a borda; iOS e Android aplicam a máscara). Foram renderizados com Playwright/Chromium a
partir do SVG; se o ícone mudar, renderize de novo nos mesmos tamanhos.

## Decisões do motor de envio

- **Sessão retomável por arquivo**, pedaços de 8 MiB (ajustável: 4/8/16/32 MiB, sempre múltiplos de 256 KiB),
  2 arquivos ao mesmo tempo (1–4). `Blob.slice` é preguiçoso: a memória fica baixa mesmo com arquivos de GBs.
- **PUTs na sessão vão sem `Authorization`.** A URI da sessão é a credencial (documentação do Drive). Assim um
  token que vence no meio de um arquivo grande não para o envio; só conferir o destino e abrir sessões novas
  esperam o token. Se o Google responder 401 num PUT, aquela sessão passa a mandar o token.
- **Range ilegível (CORS):** o Google expõe `Range` nas respostas 308 e o app o lê. Se o navegador não conseguir
  ler, o app trata como “desconhecido”, faz uma consulta de status (`Content-Range: bytes */TOTAL`) e, se ainda
  assim não houver Range legível, assume o fim do pedaço — só quando aquele PUT terminou com 308. Se a suposição
  falhar (o Google responde 400), recomeça o arquivo numa sessão nova: mais lento, nunca corrompe. Detalhes no
  topo de `lib/uploader.js`. O teste ponta a ponta cobre esse caminho escondendo o header.
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
  (18.4) — por isso o aviso “Mantenha esta tela aberta”.
- **Fototeca:** escolher pela Fototeca pode converter o vídeo (ex.: HEVC → H.264) e cada escolha gera um arquivo
  com data nova; aí a retomada depois de recarregar não reconhece o arquivo e o envio recomeça do zero. Pelo app
  **Arquivos** o original vem intacto e a retomada funciona. Arquivos do iCloud que não estão no aparelho são
  baixados pelo iOS antes de o app recebê-los.
- **App instalado tem memória própria:** o app da Tela de Início não vê o `localStorage` do Safari. Quem
  configurar no Safari (inclusive pelo QR code) e depois instalar precisa colar o ID do cliente de novo no app
  instalado. A dica de instalação na tela Configurar sugere instalar antes.
- **Login:** o modelo de token do Google vale ~1 hora e fica só na aba (`sessionStorage`). Renovar sem um toque
  costuma ser bloqueado pelo Safari; aí aparece a pílula “Toque para continuar conectado”. Fechar a aba pede um
  novo toque em “Entrar com Google”.
- **Popup em app instalado:** em algumas versões do iOS o popup do Google dentro de um app da Tela de Início se
  comporta mal. Se o login não voltar, entre pelo Safari.
- `beforeunload` (aviso ao sair com envios em andamento) não é confiável no iOS.
