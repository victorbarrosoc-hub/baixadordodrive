# Celular ↔ computador ↔ celular pelo Wi-Fi

Celulares (app em `/app/`, com a conta) e o app do computador trocam arquivos direto pela rede de casa ou do
escritório, como o AirDrop: sem QR code, sem passar pela internet e sem subir pro Drive. Em qualquer combinação
(iPhone, Android, Mac, Windows), nos dois sentidos.

- **Da mesma conta:** o celular vê os computadores e os outros celulares da conta; o computador vê os celulares.
- **Outras pessoas por perto:** quem liga "Aceitar de outras pessoas por perto" aparece para as contas na mesma rede
  (mesmo IP público), com o primeiro nome. Quem recebe **sempre** toca em Aceitar, até no computador.
- Computador com computador continua sendo o "Entre computadores" (docs/LAN.md).

- **Celular → computador:** o arquivo fica só no computador, na pasta "SOBEDESCE do celular" (Ajustes, padrão em
  Downloads). Da mesma conta, o computador aceita sozinho; de outra pessoa, pergunta.
- **Computador → celular:** o celular precisa estar com o app aberto. Aparece "MacBook de Victor quer mandar 3
  arquivos" com Aceitar; depois, cada arquivo tem Salvar (Fotos ou Arquivos, pela folha de compartilhar do sistema).
- Fora da mesma rede não funciona (é a escolha: rápido e direto). A tela diz "Confira se os dois estão no mesmo Wi-Fi".

O modo antigo "Receber do celular (mesmo Wi-Fi)" com QR code (`src/mobile/receiver.js`, docs/CELULAR.md) continua:
serve para quem não tem conta no celular e sobe pro Drive.

## Como funciona

A página do app no celular é HTTPS e não pode falar com `http://192.168.x.x` (conteúdo misto). Por isso a conexão é
**WebRTC** (canal de dados), que funciona entre uma página HTTPS e um aparelho da rede local:

1. **Sinalização pelo site** (`/api/p2p/*`): cada aparelho fica numa espera longa (`GET /api/p2p/espera`, até 25 s)
   enquanto está aberto; isso também marca que ele está online e em qual rede (HMAC do IP público, como em
   `lib/lan/presenca.ts`). Quem vai mandar cria a **oferta** (SDP inteira, sem trickle) e manda pelo site; o outro
   responde com a **resposta**. O site só repassa: sinais valem 2 minutos e só entre aparelhos da mesma conta.
2. **Conexão direta:** o computador anuncia o IP local de verdade (o app desliga a ofuscação mDNS do Chromium:
   `--disable-features=WebRtcHideLocalIpsWithMdns`). O Safari anuncia um nome `.local`, mas manda as checagens de
   conexão para o IP do computador, e o computador aprende o endereço do celular por elas (candidato
   peer-reflexivo). Entre dois celulares (os dois só com nome `.local`), ajuda o STUN público da Cloudflare
   (`stun:stun.cloudflare.com:3478`): só para cada um descobrir o próprio endereço; os arquivos não passam por ele.
   Sem TURN: nada é retransmitido pela internet. Rede de visitantes com isolamento entre aparelhos não deixa conectar.
3. **Protocolo do canal** (`web/public/app/lib/p2p-canal.js`, cópia idêntica em `public/celular/p2p-canal.js`): quem
   cria a oferta é sempre quem manda. Lista → pode/não → arquivo a arquivo em pedaços de 64 KiB → guardado → acabou.
   Controle de fluxo por confirmações (no máximo 16 MiB adiantados). O canal é cifrado (DTLS) pelo próprio WebRTC.

**Mac (macOS 15 em diante): permissão de Rede Local.** Sem ela, o app não fala com nenhum aparelho da rede: o celular
acha o computador pelo site, o computador responde, mas a conexão direta nunca abre. O app declara
`NSLocalNetworkUsageDescription` (electron-builder.yml), e o motor confere a permissão (`src/celular/rede-local.js`):
uma conexão TCP ao roteador (portas 53 e 80); "No route to host" (EHOSTUNREACH) = bloqueada. A primeira tentativa, ao
abrir o app, também faz o macOS mostrar o pedido. Bloqueada: a oferta do celular é recusada na hora com o caminho para
ligar, "Mandar para o celular" avisa o mesmo, e Dispositivos mostra o aviso com **Abrir Ajustes** (Privacidade e
Segurança → Rede Local) e **Conferir de novo**. No celular, quando não conecta, a folha mostra a dica do Mac (se o outro
lado não respondeu nenhuma checagem) e uma linha técnica: os caminhos de cada lado e as checagens que foram e voltaram.

**Mac: Firewall.** Com o Firewall do macOS ligado, o app precisa estar em "Permitir conexões de entrada" (Ajustes do
Sistema → Rede → Firewall → Opções), senão as checagens que o celular manda para o IP do Mac são recusadas. O motor lê o
estado pelo `socketfilterfw` (`src/celular/firewall.js`, sem senha) e Dispositivos mostra o aviso com **Abrir Ajustes**.
Quando a ligação direta com um celular não abre, a janela oculta conta ao motor (`POST /api/celular/falha`, com o que
cada lado anunciou) e Dispositivos mostra "O celular tentou e não conectou" por 30 min.

No computador, o WebRTC roda numa **janela oculta** do Electron (`desktop/main.js` → `public/celular/p2p.html`), que
existe enquanto o app está aberto (no Mac, mesmo com a janela principal fechada). Ela conversa com o motor pela API
local; o motor faz a espera longa no site, grava os arquivos e mostra o andamento na interface.

## Site (`web/`)

Tabelas (`drizzle/0011_p2p.sql`):

- `p2p_aparelhos`: `sessao_id` (PK, sessões), `usuario_id`, `tipo` (`celular` | `computador`), `nome`, `rede`,
  `aceita_outros`, `visto_em`. Online = visto há menos de 70 s.
- `p2p_sinais`: `id`, `usuario_id` (quem manda), `para_usuario` (quem recebe), `de_sessao`, `para_sessao`, `tipo` (`oferta` | `resposta` | `recusa` |
  `cancela`), `oferta` (id da oferta, nos outros tipos), `sdp`, `resumo` (`{ arquivos, bytes, nomes[≤5] }`),
  `motivo`, `criado_em`, `entregue_em`. Mais velhos que 2 min não são entregues e somem.

Rotas (cookie do site no celular; Bearer `sdd_` no computador):

| Rota | O quê |
| --- | --- |
| `GET /api/p2p/espera?nome=&outros=1` | Marca online (tipo pela sessão: dispositivo = computador; `outros=1` = aceita pessoas por perto). Devolve `{ agora, sinais }` assim que houver sinal para esta sessão (e marca entregue), ou `[]` depois de 25 s. `curto=1`: não espera. |
| `GET /api/p2p/aparelhos` | `{ aparelhos: [{ id, nome, tipo, mesmaRede, conta: 'minha' \| 'outra', dono? }] }`: os da conta (acima) e as pessoas por perto que aceitam, online. |
| `POST /api/p2p/sinal` | `{ para, tipo: 'oferta', sdp, resumo }` ou `{ para, tipo: 'resposta' \| 'recusa' \| 'cancela', oferta, sdp?, motivo? }` → `{ id }`. Oferta só para aparelho online que este vê (da conta, ou por perto na mesma rede e aceitando); os outros só sobre uma oferta entre os dois. SDP até 20 mil caracteres. Até 20 ofertas por minuto por sessão. |

Sinal entregue: `{ id, tipo, de: { id, nome, tipo, conta, dono? }, oferta?, sdp?, resumo?, motivo?, criadoEm }`.

## Celular (`web/public/app/`)

- `lib/p2p.js`: a espera longa (só com a conta, tela à vista), a lista de computadores, mandar e receber.
- **Aba Aparelhos** (`components/aparelhos.js`, no meio da barra de baixo e em destaque; `/app/#aparelhos` abre direto):
  "Seus aparelhos" (computadores e celulares da conta, abertos agora; sem nenhum, diz como fazer aparecer), "Por perto"
  (outras pessoas que aceitam), a chave "Aceitar de outras pessoas por perto" e "Como funciona". Toque num aparelho →
  escolher arquivos → folha com o andamento (arquivo, %, velocidade) e Cancelar. A aba ganha um ponto quando alguém
  pede para mandar (laranja) ou quando algo está passando. No Início fica só o que está passando agora.
- **Recebendo:** folha "MacBook de Victor quer mandar 3 arquivos · 1,2 GB" com Aceitar/Recusar. Os bytes vão para o
  armazenamento do app (OPFS, sem encher a memória); no fim, cada arquivo tem **Salvar** (`navigator.share` com o
  arquivo: Salvar em Fotos/Arquivos) e "Salvar todos". Sem OPFS: na memória, até 1 GB.
- O app avisa para manter a tela aberta enquanto passa (o iPhone pausa a página em segundo plano).

## Computador

- Ajustes: `celularReceber` (padrão ligado), `celularPasta` (padrão `<Downloads>/SOBEDESCE do celular`) e
  `celularOutros` ("Aceitar de outras pessoas por perto", padrão desligado; manda `outros=1` na espera longa).
- `src/celular/wifi.js` (motor): a espera longa no site enquanto há conta (com recuo de 2 s a 60 s se falhar; para se
  a sessão cair), a lista de celulares (`/api/p2p/aparelhos` a cada 20 s, só os do tipo celular), as transferências e
  a gravação: `.parcial` em `.sobedesce-recebendo` dentro da pasta, escrito na ordem (offset errado = 409, maior que o
  anunciado = 413), fsync no fim e o nome final sem colisão ("IMG_0001 (2).HEIC"). Cancelar ou falhar apaga o
  pela metade. Recusa pelo site, sem incomodar ninguém: `celularReceber` desligado, falta de espaço, oferta de outra
  pessoa com `celularOutros` desligado, ou a janela oculta fora do ar.
- **Mesma conta** (`de.conta === 'minha'`): a oferta vai direto para a janela oculta, que responde sozinha.
  **Outra pessoa** (`'outra'`): vira um pedido na tela ("Ana quer mandar 3 arquivos · 1,3 GB"), com aviso e
  notificação do sistema; só depois de **Aceitar** a janela oculta responde. **Recusar** manda `recusa`; sem resposta
  em 110 s, cai sozinho (também com `recusa`; o celular desiste em ~115 s). No máximo 3 pedidos esperando ao mesmo tempo.
- `src/server/celular.js`, rotas locais:
  - `GET /api/celular` (estado: ajustes, `pronto`, celulares online com `conta`/`dono`, pedidos, transferências) e
    `POST /api/celular/aparelhos` (pede a lista ao site agora); `/api/state` também leva `celular`
  - `POST /api/celular/responder` `{ id, aceitar }` (pedido de outra pessoa)
  - `POST /api/celular/sinal` (a janela oculta manda oferta/resposta pelo site; `tid` liga a oferta à transferência)
  - `POST /api/celular/enviar` `{ para, caminhos }` (interface; pastas abertas, sem lixo de sistema, até 2000
    arquivos) → a janela oculta recebe `celular-enviar` pelo SSE e cria a oferta
  - `GET /api/celular/arquivo/:tid/:i` com `Range` (a janela oculta lê o que manda, em blocos de 4 MiB)
  - `POST /api/celular/receber` `{ tid, de, arquivos }` → `{ aceito, motivo? }`; `PUT /api/celular/receber/:tid/:i?offset=`
    (corpo `application/octet-stream`; `src/server/app.js` deixa passar só esta rota sem JSON, e a Origin continua
    conferida); `POST /api/celular/receber/:tid/:i/fim`
  - `POST /api/celular/estado/:tid` (andamento e fim, nos dois sentidos), `POST /api/celular/cancelar/:tid` e
    `POST /api/celular/limpar`
  - `POST /api/celular/janela` (a janela oculta avisa a cada 20 s que está de pé; sem ela há 45 s, a oferta do
    celular é recusada na hora com "Feche e abra o SOBEDESCE no computador" em vez de o celular esperar à toa)
- SSE: `celular` (estado para a interface), `celular-pedido` (aviso de pedido de outra pessoa), e para a janela
  oculta: `celular-oferta`, `celular-enviar`, `celular-sinal`, `celular-cancelar`.
- Janela oculta (`desktop/main.js` → `public/celular/p2p.html` + `p2p.js`): `BrowserWindow` sem mostrar, sem
  `backgroundThrottling`, navegação bloqueada, volta sozinha se o processo dela cair, fecha ao sair. Com ela de pé, o
  app conta uma janela a mais: no Windows, fechar a janela principal fecha o app pelo `closed` dela.
  `RTCPeerConnection` com STUN (`stun:stun.cloudflare.com:3478`) só para achar caminhos; os dados não passam por ele.
  Grava o que chega em PUTs de ~4 MiB e conta o andamento ao motor no máximo a cada 300 ms.
- Interface: em **Dispositivos** (a tela antiga Computadores), a seção "Celular": o ajuste e a pasta, "Aceitar de
  outras pessoas por perto", os pedidos com Aceitar/Recusar, os celulares online ("Seus celulares" e "Por perto": "Ana ·
  iPhone de Ana"), **Mandar para o celular** (seletor de arquivos e pastas do sistema), o que está passando
  (%, velocidade, Cancelar) e "Mostrar no Finder" no que chegou. No Início, o que passa com o celular aparece em
  "Em andamento".

## Testar

- `test/celular-wifi.test.js`: protocolo do canal (par de canais falsos) e a cópia idêntica.
- `test/celular-wifi-motor.test.js`: o motor com um site falso (gravação, colisão, offset, recusas, pedidos de outra
  pessoa, espera longa com `outros=1`, mandar abrindo pastas) e as rotas locais por HTTP (trava do octet-stream, Range).
- `web/tests/p2p.test.mts`: espera longa, presença, quem vê quem, regras dos sinais, validade e limite.
- Falta testar com aparelhos de verdade: iPhone (Safari e app na Tela de Início) e Android com Mac e Windows, numa
  rede de casa e numa rede com isolamento entre aparelhos (precisa dar a mensagem certa).
